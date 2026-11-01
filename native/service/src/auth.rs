use anyhow::{Result, ensure};
use axum::{
    Form, Json,
    extract::{Query, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use tokio::sync::Semaphore;
use url::Url;
use zeroize::Zeroize;

pub const SCOPE: &str = "codex:access";
fn random() -> String {
    let mut bytes = [0; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
fn fingerprint(s: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(s.as_bytes()))
}
pub fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

struct Entry<T> {
    value: T,
    expires: Instant,
}
struct Store<T>(HashMap<String, Entry<T>>);
impl<T> Default for Store<T> {
    fn default() -> Self {
        Self(HashMap::new())
    }
}
impl<T: Clone> Store<T> {
    fn get(&self, id: &str) -> Option<T> {
        self.0
            .get(id)
            .filter(|e| e.expires > Instant::now())
            .map(|e| e.value.clone())
    }
    fn put(&mut self, id: String, value: T, ttl: Duration) -> Result<()> {
        self.0.retain(|_, e| e.expires > Instant::now());
        ensure!(self.0.len() < 4000, "Authorization storage is full");
        self.0.insert(
            id,
            Entry {
                value,
                expires: Instant::now() + ttl,
            },
        );
        Ok(())
    }
    fn take(&mut self, id: &str) -> Option<T> {
        self.0
            .remove(id)
            .filter(|e| e.expires > Instant::now())
            .map(|e| e.value)
    }
}
#[derive(Clone)]
struct Client {
    name: String,
    redirects: Vec<String>,
}
#[derive(Clone)]
struct Grant {
    client: String,
    redirect: String,
    challenge: String,
    state: Option<String>,
}
#[derive(Clone)]
struct Pending {
    grant: Grant,
    browser: String,
    name: String,
}
struct Family {
    client: String,
    expires: Instant,
    revoked: bool,
}
#[derive(Clone)]
struct Token {
    family: Arc<Mutex<Family>>,
    used: bool,
}
#[derive(Default)]
struct Stores {
    clients: Store<Client>,
    pending: Store<Pending>,
    codes: Store<Grant>,
    access: Store<Token>,
    refresh: Store<Token>,
}
pub struct Auth {
    pub origin: String,
    pub resource: String,
    secure: bool,
    username: String,
    salt: [u8; 32],
    password: [u8; 64],
    stores: Mutex<Stores>,
    hashes: Arc<Semaphore>,
    rates: Mutex<HashMap<&'static str, (Instant, usize)>>,
}

impl Auth {
    pub fn new(public: Url, username: String, mut password: String) -> Result<Arc<Self>> {
        ensure!(
            public.path() == "/"
                && public.query().is_none()
                && public.fragment().is_none()
                && public.username().is_empty()
                && public.password().is_none(),
            "Public URL must be an origin"
        );
        let local = ["localhost", "127.0.0.1", "[::1]"].contains(&public.host_str().unwrap_or(""));
        ensure!(
            public.scheme() == "https" || public.scheme() == "http" && local,
            "Public URL requires HTTPS or loopback HTTP"
        );
        ensure!(
            !username.is_empty()
                && username.len() <= 256
                && password.chars().count() >= 24
                && password.len() <= 1024,
            "MCP login requires a username and a password of 24 characters to 1024 bytes"
        );
        let mut salt = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut salt);
        let mut hash = [0u8; 64];
        scrypt::scrypt(
            password.as_bytes(),
            &salt,
            &scrypt::Params::new(14, 8, 1, 64)?,
            &mut hash,
        )?;
        password.zeroize();
        Ok(Arc::new(Self {
            origin: public.origin().ascii_serialization(),
            resource: public.join("mcp")?.into(),
            secure: public.scheme() == "https",
            username,
            salt,
            password: hash,
            stores: Mutex::new(Stores::default()),
            hashes: Arc::new(Semaphore::new(2)),
            rates: Mutex::new(HashMap::new()),
        }))
    }
    fn rate(&self, key: &'static str, max: usize) -> bool {
        let mut rates = self.rates.lock().unwrap();
        let entry = rates.entry(key).or_insert((Instant::now(), 0));
        if entry.0.elapsed() >= Duration::from_secs(900) {
            *entry = (Instant::now(), 0);
        }
        entry.1 += 1;
        entry.1 <= max
    }
    pub fn valid_access(&self, token: &str) -> bool {
        self.stores
            .lock()
            .unwrap()
            .access
            .get(&fingerprint(token))
            .is_some_and(|t| {
                let f = t.family.lock().unwrap();
                !f.revoked && f.expires > Instant::now()
            })
    }
    fn resource_valid(&self, p: &HashMap<String, String>) -> bool {
        p.get("resource").is_none_or(|r| r == &self.resource)
    }
    fn cookie(&self, id: &str, value: &str, clear: bool) -> String {
        format!(
            "codex_oauth_{id}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}{}",
            if clear { 0 } else { 600 },
            if self.secure { "; Secure" } else { "" }
        )
    }
}

fn failure(status: StatusCode, code: &str, description: &str) -> Response {
    (
        status,
        Json(json!({"error":code,"error_description":description})),
    )
        .into_response()
}
fn invalid(code: &str, description: &str) -> Response {
    failure(StatusCode::BAD_REQUEST, code, description)
}
fn limited() -> Response {
    failure(
        StatusCode::TOO_MANY_REQUESTS,
        "temporarily_unavailable",
        "Too many requests. Try again later",
    )
}

pub async fn metadata(State(auth): State<Arc<Auth>>) -> Json<Value> {
    Json(
        json!({"issuer":auth.origin,"authorization_endpoint":format!("{}/authorize",auth.origin),"token_endpoint":format!("{}/token",auth.origin),"registration_endpoint":format!("{}/register",auth.origin),"revocation_endpoint":format!("{}/revoke",auth.origin),"scopes_supported":[SCOPE],"response_types_supported":["code"],"grant_types_supported":["authorization_code","refresh_token"],"token_endpoint_auth_methods_supported":["none"],"code_challenge_methods_supported":["S256"]}),
    )
}
pub async fn resource_metadata(State(auth): State<Arc<Auth>>) -> Json<Value> {
    Json(
        json!({"resource":auth.resource,"authorization_servers":[auth.origin],"scopes_supported":[SCOPE],"resource_name":"Codex local MCP"}),
    )
}

pub async fn register(State(auth): State<Arc<Auth>>, Json(body): Json<Value>) -> Response {
    if !auth.rate("register", 100) {
        return limited();
    }
    let Some(redirects) = body["redirect_uris"]
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 10)
    else {
        return invalid("invalid_client_metadata", "Provide 1 to 10 redirect URIs");
    };
    let mut uris = Vec::new();
    for redirect in redirects {
        let Some(s) = redirect.as_str().filter(|s| s.len() <= 2048) else {
            return invalid("invalid_redirect_uri", "Invalid redirect URI");
        };
        let Ok(url) = Url::parse(s) else {
            return invalid("invalid_redirect_uri", "Invalid redirect URI");
        };
        let local = ["localhost", "127.0.0.1", "[::1]"].contains(&url.host_str().unwrap_or(""));
        if url.fragment().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || !(url.scheme() == "https" || url.scheme() == "http" && local)
        {
            return invalid(
                "invalid_redirect_uri",
                "Use HTTPS or loopback HTTP without credentials or fragments",
            );
        }
        uris.push(s.to_owned());
    }
    if body
        .get("token_endpoint_auth_method")
        .is_some_and(|m| m != "none")
    {
        return invalid(
            "invalid_client_metadata",
            "Only public clients are supported",
        );
    }
    for (key, supported) in [
        ("response_types", &["code"][..]),
        ("grant_types", &["authorization_code", "refresh_token"][..]),
    ] {
        if let Some(v) = body.get(key)
            && !v.as_array().is_some_and(|a| {
                !a.is_empty()
                    && a.iter()
                        .all(|x| x.as_str().is_some_and(|s| supported.contains(&s)))
            })
        {
            return invalid("invalid_client_metadata", "Unsupported OAuth flow");
        }
    }
    let name = body["client_name"].as_str().unwrap_or("MCP client");
    if name.len() > 256 {
        return invalid("invalid_client_metadata", "Client name is too long");
    }
    let id = random();
    let client = Client {
        name: name.into(),
        redirects: uris.clone(),
    };
    if auth
        .stores
        .lock()
        .unwrap()
        .clients
        .put(id.clone(), client, Duration::from_secs(30 * 86400))
        .is_err()
    {
        return limited();
    }
    (StatusCode::CREATED, Json(json!({"client_id":id,"client_name":name,"redirect_uris":uris,"token_endpoint_auth_method":"none","grant_types":["authorization_code","refresh_token"],"response_types":["code"]}))).into_response()
}

pub async fn authorize(
    State(auth): State<Arc<Auth>>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if !auth.rate("authorize", 100) {
        return limited();
    }
    let id = params.get("client_id").cloned().unwrap_or_default();
    let Some(client) = auth.stores.lock().unwrap().clients.get(&id) else {
        return invalid("invalid_client", "Unknown client. Connect again");
    };
    let redirect = params.get("redirect_uri").cloned().or_else(|| {
        if client.redirects.len() == 1 {
            Some(client.redirects[0].clone())
        } else {
            None
        }
    });
    let Some(redirect) = redirect.filter(|s| client.redirects.contains(s)) else {
        return invalid("invalid_request", "Redirect URI does not match");
    };
    let challenge = params.get("code_challenge").cloned().unwrap_or_default();
    if params.get("response_type").map(String::as_str) != Some("code")
        || params.get("code_challenge_method").map(String::as_str) != Some("S256")
        || challenge.len() != 43
        || !challenge
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        || !auth.resource_valid(&params)
    {
        return invalid(
            "invalid_request",
            "Authorization requires S256 PKCE and the correct resource",
        );
    }
    if params
        .get("scope")
        .is_some_and(|s| s.split_whitespace().any(|scope| scope != SCOPE))
    {
        return invalid("invalid_scope", "Invalid scope");
    }
    let request = random();
    let browser = random();
    let pending = Pending {
        grant: Grant {
            client: id,
            redirect,
            challenge,
            state: params.get("state").cloned(),
        },
        browser: browser.clone(),
        name: client.name,
    };
    if auth
        .stores
        .lock()
        .unwrap()
        .pending
        .put(request.clone(), pending.clone(), Duration::from_secs(600))
        .is_err()
    {
        return limited();
    }
    let mut response = page(StatusCode::OK, Some((&request, &pending)), None);
    response.headers_mut().insert(
        "set-cookie",
        HeaderValue::from_str(&auth.cookie(&request, &browser, false)).unwrap(),
    );
    response
}

pub async fn login(
    State(auth): State<Arc<Auth>>,
    headers: HeaderMap,
    Form(params): Form<HashMap<String, String>>,
) -> Response {
    if !auth.rate("login", 10) {
        return limited();
    }
    let request = params.get("request_id").cloned().unwrap_or_default();
    let pending = auth.stores.lock().unwrap().pending.get(&request);
    let Some(pending) = pending else {
        return page(StatusCode::BAD_REQUEST, None, None);
    };
    let name = format!("codex_oauth_{request}=");
    let cookie = headers
        .get("cookie")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(';').find_map(|c| c.trim().strip_prefix(&name)));
    if cookie != Some(&pending.browser)
        || headers
            .get("origin")
            .is_some_and(|v| v != auth.origin.as_str())
    {
        return page(StatusCode::BAD_REQUEST, None, None);
    }
    let wrong = || {
        page(
            StatusCode::UNAUTHORIZED,
            Some((&request, &pending)),
            Some(
                "The MCP username or password did not match. Check the saved login in the app and try again.",
            ),
        )
    };
    let password = params.get("password").cloned().unwrap_or_default();
    if password.len() > 1024 {
        return wrong();
    }
    let Ok(permit) = auth.hashes.clone().try_acquire_owned() else {
        return limited();
    };
    let salt = auth.salt;
    let computed = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let mut out = [0u8; 64];
        scrypt::scrypt(
            password.as_bytes(),
            &salt,
            &scrypt::Params::new(14, 8, 1, 64).unwrap(),
            &mut out,
        )
        .map(|_| out)
    })
    .await;
    let Ok(Ok(hash)) = computed else {
        return failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "server_error",
            "Login could not be checked",
        );
    };
    if !bool::from(hash.ct_eq(&auth.password)) || params.get("username") != Some(&auth.username) {
        return wrong();
    }
    let mut stores = auth.stores.lock().unwrap();
    if stores.pending.take(&request).is_none() {
        return page(StatusCode::BAD_REQUEST, None, None);
    }
    let code = random();
    if stores
        .codes
        .put(
            fingerprint(&code),
            pending.grant.clone(),
            Duration::from_secs(60),
        )
        .is_err()
    {
        return limited();
    }
    let mut callback = Url::parse(&pending.grant.redirect).unwrap();
    callback.query_pairs_mut().append_pair("code", &code);
    if let Some(state) = &pending.grant.state {
        callback.query_pairs_mut().append_pair("state", state);
    }
    let mut response = StatusCode::SEE_OTHER.into_response();
    response.headers_mut().insert(
        "location",
        HeaderValue::from_str(callback.as_str()).unwrap(),
    );
    response.headers_mut().insert(
        "set-cookie",
        HeaderValue::from_str(&auth.cookie(&request, "", true)).unwrap(),
    );
    response
}

fn issue(stores: &mut Stores, family: Arc<Mutex<Family>>) -> Result<Value> {
    let access = random();
    let refresh = random();
    let ttl = family
        .lock()
        .unwrap()
        .expires
        .saturating_duration_since(Instant::now());
    stores.access.put(
        fingerprint(&access),
        Token {
            family: family.clone(),
            used: false,
        },
        Duration::from_secs(900),
    )?;
    stores.refresh.put(
        fingerprint(&refresh),
        Token {
            family,
            used: false,
        },
        ttl,
    )?;
    Ok(
        json!({"access_token":access,"refresh_token":refresh,"token_type":"Bearer","expires_in":900,"scope":SCOPE}),
    )
}

pub async fn token(
    State(auth): State<Arc<Auth>>,
    Form(params): Form<HashMap<String, String>>,
) -> Response {
    if !auth.rate("token", 300) {
        return limited();
    }
    if !auth.resource_valid(&params) {
        return invalid("invalid_target", "Invalid resource");
    }
    let client = params.get("client_id").cloned().unwrap_or_default();
    let mut stores = auth.stores.lock().unwrap();
    if stores.clients.get(&client).is_none() {
        return invalid("invalid_client", "Unknown client");
    }
    let result = match params.get("grant_type").map(String::as_str) {
        Some("authorization_code") => {
            let key = fingerprint(params.get("code").map(String::as_str).unwrap_or(""));
            let Some(grant) = stores.codes.get(&key) else {
                return invalid("invalid_grant", "Invalid authorization code");
            };
            let verifier = params.get("code_verifier").cloned().unwrap_or_default();
            let challenge = fingerprint(&verifier);
            if grant.client != client
                || params.get("redirect_uri") != Some(&grant.redirect)
                || !(43..=128).contains(&verifier.len())
                || !verifier
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
                || !bool::from(challenge.as_bytes().ct_eq(grant.challenge.as_bytes()))
            {
                return invalid("invalid_grant", "PKCE or redirect URI does not match");
            }
            stores.codes.take(&key);
            issue(
                &mut stores,
                Arc::new(Mutex::new(Family {
                    client,
                    expires: Instant::now() + Duration::from_secs(86400),
                    revoked: false,
                })),
            )
        }
        Some("refresh_token") => {
            if params
                .get("scope")
                .is_some_and(|s| s.split_whitespace().any(|v| v != SCOPE))
            {
                return invalid("invalid_scope", "Invalid scope");
            }
            let key = fingerprint(
                params
                    .get("refresh_token")
                    .map(String::as_str)
                    .unwrap_or(""),
            );
            let Some(token) = stores.refresh.get(&key) else {
                return invalid("invalid_grant", "Invalid refresh token");
            };
            {
                let mut family = token.family.lock().unwrap();
                if family.client != client || family.revoked || family.expires <= Instant::now() {
                    return invalid("invalid_grant", "Invalid refresh token");
                }
                if token.used {
                    family.revoked = true;
                    return invalid(
                        "invalid_grant",
                        "Refresh token reuse detected. Sign in again",
                    );
                }
            }
            stores.refresh.0.get_mut(&key).unwrap().value.used = true;
            issue(&mut stores, token.family)
        }
        _ => return invalid("unsupported_grant_type", "Unsupported grant type"),
    };
    match result {
        Ok(value) => Json(value).into_response(),
        Err(_) => limited(),
    }
}

pub async fn revoke(
    State(auth): State<Arc<Auth>>,
    Form(params): Form<HashMap<String, String>>,
) -> Response {
    if !auth.rate("revoke", 300) {
        return limited();
    }
    let stores = auth.stores.lock().unwrap();
    let key = fingerprint(params.get("token").map(String::as_str).unwrap_or(""));
    if let Some(token) = stores.access.get(&key).or_else(|| stores.refresh.get(&key)) {
        let mut family = token.family.lock().unwrap();
        if params.get("client_id") == Some(&family.client) {
            family.revoked = true;
        }
    }
    StatusCode::OK.into_response()
}

fn page(status: StatusCode, pending: Option<(&str, &Pending)>, notice: Option<&str>) -> Response {
    let nonce = random();
    let callback_origin = pending
        .map(|(_, p)| {
            Url::parse(&p.grant.redirect)
                .unwrap()
                .origin()
                .ascii_serialization()
        })
        .unwrap_or_default();
    let content = if let Some((request, p)) = pending {
        format!(
            r#"<p class="eyebrow">Authorize a connection</p><h1>Connect {client}</h1><p class="intro">Give this client access to Codex on your PC.</p><div class="permissions"><strong>This connection allows access to your workspace</strong><p>The client can run Codex tasks and read or edit files inside the configured workspace.</p></div>{notice}<form method="post" action="/login"><input type="hidden" name="request_id" value="{request}"><label for="username">MCP username</label><input id="username" name="username" autocomplete="username" required autocapitalize="none" spellcheck="false"><label for="password">MCP password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024"><button type="submit">Sign in and connect</button></form><p class="help">Use the MCP login saved in Codex Local MCP → Accounts. This is separate from your OpenAI login.</p><details><summary>Connection details</summary><p>Client: {client}<br>Return address: {callback}</p></details>"#,
            client = escape(&p.name),
            request = escape(request),
            callback = escape(&p.grant.redirect),
            notice = notice
                .map(|n| format!("<p class=\"notice\" role=\"alert\">{}</p>", escape(n)))
                .unwrap_or_default()
        )
    } else {
        "<p class=\"eyebrow\">Connection needs attention</p><h1>Open a new sign-in page</h1><p class=\"notice\">This sign-in request is invalid or has expired.</p><p class=\"intro\">Return to Claude and connect this connector again to open a fresh sign-in page.</p>".into()
    };
    let mut response = (status, Html(format!(r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect Codex MCP</title><style nonce="{nonce}">{css}</style></head><body><main><div class="brand"><span class="logo" aria-hidden="true">‹›</span>Codex Local MCP</div><section class="card" aria-label="Connect your workspace">{content}</section><p class="footer">Keep Codex Local MCP running on your PC.</p></main></body></html>"#, css=include_str!("login.css")))).into_response();
    response
        .headers_mut()
        .insert("referrer-policy", HeaderValue::from_static("same-origin"));
    response.headers_mut().insert("content-security-policy", HeaderValue::from_str(&format!("default-src 'none'; style-src 'nonce-{nonce}'; form-action 'self' {callback_origin}; frame-ancestors 'none'; base-uri 'none'")).unwrap());
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refresh_family_revocation_reaches_all_access_tokens() {
        let auth = Auth::new(
            Url::parse("http://127.0.0.1:3000").unwrap(),
            "admin".into(),
            "test-only-password-long-enough".into(),
        )
        .unwrap();
        let family = Arc::new(Mutex::new(Family {
            client: "a".into(),
            expires: Instant::now() + Duration::from_secs(100),
            revoked: false,
        }));
        let tokens = issue(&mut auth.stores.lock().unwrap(), family.clone()).unwrap();
        let access = tokens["access_token"].as_str().unwrap();
        assert!(auth.valid_access(access));
        family.lock().unwrap().revoked = true;
        assert!(!auth.valid_access(access));
    }
    #[test]
    fn store_expiration_and_single_use() {
        let mut s = Store::default();
        s.put("a".into(), 1, Duration::ZERO).unwrap();
        assert_eq!(s.get("a"), None);
        s.put("b".into(), 2, Duration::from_secs(60)).unwrap();
        assert_eq!(s.take("b"), Some(2));
        assert_eq!(s.take("b"), None);
    }
    #[test]
    fn html_values_are_escaped() {
        assert_eq!(escape("<script>&\"'"), "&lt;script&gt;&amp;&quot;&#39;");
    }
}
