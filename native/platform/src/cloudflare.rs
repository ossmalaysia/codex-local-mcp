use crate::{runtime, secure, settings::Settings};
use anyhow::{Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::io::BufReader;

#[derive(Clone, Serialize, Deserialize)]
pub struct Credentials {
    #[serde(rename = "accountID")]
    account: String,
    #[serde(rename = "zoneID")]
    zone: String,
    #[serde(rename = "apiToken")]
    token: String,
    #[serde(default)]
    endpoint: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Owned {
    id: String,
    account: String,
    name: String,
    hostname: String,
    port: u16,
    token: String,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Stored {
    credentials: Option<Credentials>,
    #[serde(default)]
    owned: Vec<Owned>,
}
fn identifier(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit())
}
fn host(s: &str) -> bool {
    s.len() <= 253 && s.split('.').count() >= 2 && s.split('.').all(label)
}
fn label(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 63
        && !s.starts_with('-')
        && !s.ends_with('-')
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn load() -> Result<Stored> {
    let path = secure::root()?.join("cloudflare.json");
    secure::no_links(&path)?;
    if !path.exists() {
        return Ok(Stored::default());
    }
    ensure!(
        path.metadata()?.len() <= 2 * 1024 * 1024,
        "Cloudflare settings exceed the size limit"
    );
    Ok(serde_json::from_slice(&secure::unprotect(
        &std::fs::read_to_string(path)?,
    )?)?)
}
fn save(state: &Stored) -> Result<()> {
    secure::atomic(
        &secure::root()?.join("cloudflare.json"),
        secure::protect(&serde_json::to_vec(state)?)?.as_bytes(),
    )
}
async fn request(
    auth: &Credentials,
    path: &str,
    method: reqwest::Method,
    body: Option<Value>,
) -> Result<Value> {
    ensure!(
        identifier(&auth.account) && identifier(&auth.zone) && path.starts_with('/'),
        "Cloudflare account is invalid"
    );
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()?;
    let mut req = client
        .request(
            method,
            format!("https://api.cloudflare.com/client/v4{path}"),
        )
        .bearer_auth(&auth.token);
    if let Some(body) = body {
        req = req.json(&body);
    }
    let mut response = req
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("Cloudflare could not be reached"))?;
    ensure!(
        response.status().is_success(),
        "Cloudflare refused this operation. Sign in again or check account permissions"
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            bytes.len() + chunk.len() <= 2 * 1024 * 1024,
            "Cloudflare response exceeded its size limit"
        );
        bytes.extend_from_slice(&chunk);
    }
    let envelope: Value = serde_json::from_slice(&bytes)?;
    ensure!(
        envelope["success"] == true,
        "Cloudflare did not confirm the operation"
    );
    Ok(envelope["result"].clone())
}
pub async fn status() -> Result<Value> {
    let state = load()?;
    let Some(auth) = state.credentials else {
        return Ok(json!({"signedIn":false,"domains":[]}));
    };
    let selected = request(
        &auth,
        &format!("/zones/{}", auth.zone),
        reqwest::Method::GET,
        None,
    )
    .await?;
    ensure!(
        selected["account"]["id"] == auth.account,
        "Cloudflare zone belongs to another account"
    );
    let mut domains = vec![json!({"id":selected["id"],"name":selected["name"]})];
    for page in 1..=100 {
        let response = request(
            &auth,
            &format!(
                "/zones?account.id={}&status=active&per_page=50&page={page}",
                auth.account
            ),
            reqwest::Method::GET,
            None,
        )
        .await;
        let Ok(Value::Array(zones)) = response else {
            break;
        };
        for zone in &zones {
            if zone["account"]["id"] == auth.account
                && !domains.iter().any(|d| d["id"] == zone["id"])
            {
                domains.push(json!({"id":zone["id"],"name":zone["name"]}));
            }
        }
        if zones.len() < 50 {
            break;
        }
    }
    Ok(json!({"signedIn":true,"domains":domains}))
}
pub fn decode_certificate(pem: &str) -> Result<Credentials> {
    const BEGIN: &str = "-----BEGIN ARGO TUNNEL TOKEN-----";
    const END: &str = "-----END ARGO TUNNEL TOKEN-----";
    ensure!(
        pem.len() <= 65536 && pem.matches(BEGIN).count() == 1,
        "Cloudflare returned an invalid sign-in certificate"
    );
    let body = pem
        .split_once(BEGIN)
        .and_then(|(_, s)| s.split_once(END))
        .map(|(s, _)| s)
        .ok_or_else(|| anyhow::anyhow!("Missing Cloudflare account token"))?;
    let bytes = zeroize::Zeroizing::new(
        STANDARD.decode(
            body.chars()
                .filter(|c| !c.is_whitespace())
                .collect::<String>(),
        )?,
    );
    let auth: Credentials = serde_json::from_slice(&bytes)?;
    ensure!(
        identifier(&auth.account)
            && identifier(&auth.zone)
            && (10..=8192).contains(&auth.token.len())
            && auth.endpoint.is_empty(),
        "Invalid Cloudflare sign-in certificate"
    );
    Ok(auth)
}
async fn login_urls(
    stream: Box<dyn tokio::io::AsyncRead + Send + Unpin>,
    send: tokio::sync::mpsc::Sender<String>,
) {
    let mut reader = BufReader::new(stream);
    let mut total = 0;
    loop {
        let mut bytes = Vec::new();
        let n = runtime::bounded_line(&mut reader, &mut bytes, 16384)
            .await
            .unwrap_or(0);
        total += n;
        if n == 0 || total > 262144 {
            break;
        }
        for item in String::from_utf8_lossy(&bytes).split_whitespace() {
            let item = item.trim_matches(['|', '"', '\'']);
            if let Ok(url) = url::Url::parse(item)
                && url.scheme() == "https"
                && url.host_str() == Some("dash.cloudflare.com")
                && url.port_or_known_default() == Some(443)
                && url.path() == "/argotunnel"
                && url.username().is_empty()
                && url.fragment().is_none()
            {
                let _ = send.send(url.to_string()).await;
            }
        }
    }
}
async fn login_process(install: &Path, home: &Path) -> Result<()> {
    let mut cmd = runtime::command(&install.join("runtime/cloudflared.exe"));
    cmd.env("HOME", home)
        .env("USERPROFILE", home)
        .current_dir(home);
    let mut child = cmd
        .args(["tunnel", "--config=", "--no-autoupdate", "login"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let (send, mut receive) = tokio::sync::mpsc::channel(4);
    let readers = [
        tokio::spawn(login_urls(
            Box::new(child.stdout.take().unwrap()),
            send.clone(),
        )),
        tokio::spawn(login_urls(Box::new(child.stderr.take().unwrap()), send)),
    ];
    let mut opened = false;
    let work = async {
        loop {
            tokio::select! {
                status=child.wait()=>{ensure!(status?.success(),"Cloudflare sign-in did not finish");return Ok::<_,anyhow::Error>(());},
                Some(url)=receive.recv()=>{if !opened {runtime::open_url(&url,&["dash.cloudflare.com"])?;opened=true;}}
            }
        }
    };
    let result = tokio::time::timeout(Duration::from_secs(480), work).await;
    let _ = child.kill().await;
    for reader in readers {
        reader.abort();
    }
    result?
}
pub async fn login(install: &Path) -> Result<Value> {
    let root = secure::root()?;
    let home = root.join(format!("cloudflare-login-{}", uuid::Uuid::new_v4()));
    secure::no_links(&home)?;
    tokio::fs::create_dir(&home).await?;
    let certificate = home.join(".cloudflared/cert.pem");
    let result = async {
        login_process(install, &home).await?;
        secure::no_links(&certificate)?;
        ensure!(
            tokio::fs::metadata(&certificate).await?.len() <= 65536,
            "Cloudflare certificate exceeds its size limit"
        );
        let pem = zeroize::Zeroizing::new(tokio::fs::read_to_string(&certificate).await?);
        let credentials = decode_certificate(&pem)?;
        tokio::fs::remove_file(&certificate).await?;
        let mut state = load()?;
        state.credentials = Some(credentials);
        save(&state)?;
        status().await
    }
    .await;
    // Remove only known files and empty, application-owned directories.
    if secure::no_links(&home).is_ok() && home.parent() == Some(root.as_path()) {
        let _ = tokio::fs::remove_file(&certificate).await;
        let _ = tokio::fs::remove_dir(home.join(".cloudflared")).await;
        let _ = tokio::fs::remove_dir(&home).await;
    }
    result
}
async fn verify(auth: &Credentials, owned: &Owned) -> Result<()> {
    let tunnel = request(
        auth,
        &format!("/accounts/{}/cfd_tunnel/{}", auth.account, owned.id),
        reqwest::Method::GET,
        None,
    )
    .await?;
    ensure!(
        tunnel["id"] == owned.id
            && tunnel["name"] == owned.name
            && tunnel["config_src"] == "cloudflare"
            && tunnel["deleted_at"].is_null(),
        "The saved Cloudflare tunnel has changed"
    );
    Ok(())
}
async fn configure(auth: &Credentials, owned: &Owned, port: u16) -> Result<()> {
    request(auth,&format!("/accounts/{}/cfd_tunnel/{}/configurations",auth.account,owned.id),reqwest::Method::PUT,Some(json!({"config":{"ingress":[{"hostname":owned.hostname,"service":format!("http://127.0.0.1:{port}")},{"service":"http_status:404"}]}}))).await?;
    Ok(())
}
pub async fn create(zone: &str, prefix: &str, settings: &mut Settings) -> Result<Value> {
    ensure!(
        identifier(zone) && label(prefix),
        "Choose a valid domain and address name"
    );
    let mut state = load()?;
    let auth = state
        .credentials
        .clone()
        .ok_or_else(|| anyhow::anyhow!("Sign in to Cloudflare first"))?;
    let domain = request(&auth, &format!("/zones/{zone}"), reqwest::Method::GET, None).await?;
    ensure!(
        domain["account"]["id"] == auth.account
            && domain["id"] == zone
            && domain["status"] == "active",
        "Domain belongs to another account"
    );
    let hostname = format!("{prefix}.{}", domain["name"].as_str().unwrap_or(""));
    ensure!(host(&hostname), "Invalid Cloudflare hostname");
    let records = request(
        &auth,
        &format!("/zones/{zone}/dns_records?name={hostname}&per_page=100"),
        reqwest::Method::GET,
        None,
    )
    .await?;
    let records = records
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Invalid DNS response"))?;
    ensure!(records.len() < 100, "This address has too many DNS records");
    let index = state
        .owned
        .iter()
        .position(|o| o.account == auth.account && o.hostname == hostname);
    for record in records {
        let matching = index.is_some_and(|i| {
            record["type"] == "CNAME"
                && record["name"] == hostname
                && record["content"] == format!("{}.cfargotunnel.com", state.owned[i].id)
                && record["proxied"] == true
        });
        ensure!(
            matching,
            "This address is already in use. Choose another address"
        );
    }
    let index = if let Some(index) = index {
        verify(&auth, &state.owned[index]).await?;
        index
    } else {
        let name = format!("codex-local-{}", uuid::Uuid::new_v4().simple());
        let created = request(
            &auth,
            &format!("/accounts/{}/cfd_tunnel", auth.account),
            reqwest::Method::POST,
            Some(json!({"name":name,"config_src":"cloudflare"})),
        )
        .await?;
        let id = created["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Invalid tunnel identifier"))?;
        uuid::Uuid::parse_str(id)?;
        ensure!(
            created["name"] == name && created["config_src"] == "cloudflare",
            "Cloudflare returned an unexpected tunnel"
        );
        state.owned.push(Owned {
            id: id.into(),
            account: auth.account.clone(),
            name,
            hostname: hostname.clone(),
            port: 0,
            token: String::new(),
        });
        save(&state)?;
        state.owned.len() - 1
    };
    let mut owned = state.owned[index].clone();
    let token = request(
        &auth,
        &format!("/accounts/{}/cfd_tunnel/{}/token", auth.account, owned.id),
        reqwest::Method::GET,
        None,
    )
    .await?;
    let token = token
        .as_str()
        .filter(|s| (10..=16384).contains(&s.len()))
        .ok_or_else(|| anyhow::anyhow!("Invalid Cloudflare tunnel token"))?;
    if records.is_empty() {
        let record=request(&auth,&format!("/zones/{zone}/dns_records"),reqwest::Method::POST,Some(json!({"type":"CNAME","name":hostname,"content":format!("{}.cfargotunnel.com",owned.id),"proxied":true,"ttl":1}))).await?;
        ensure!(
            record["type"] == "CNAME"
                && record["name"] == hostname
                && record["content"] == format!("{}.cfargotunnel.com", owned.id)
                && record["proxied"] == true,
            "Cloudflare returned an unexpected DNS record"
        );
    }
    configure(&auth, &owned, settings.port).await?;
    owned.port = settings.port;
    owned.token = secure::protect(token.as_bytes())?;
    state.owned[index] = owned.clone();
    save(&state)?;
    settings.tunnel = "named".into();
    settings.public_url = format!("https://{hostname}");
    settings.tunnel_token = owned.token;
    settings.save()?;
    Ok(settings.view())
}
pub async fn reconcile(settings: &Settings) -> Result<()> {
    if settings.tunnel != "named" {
        return Ok(());
    }
    let mut state = load()?;
    let token = secure::unprotect(&settings.tunnel_token)?;
    let index = state.owned.iter().position(|o| {
        format!("https://{}", o.hostname) == settings.public_url
            && secure::unprotect(&o.token).is_ok_and(|b| b.as_slice() == token.as_slice())
    });
    let Some(index) = index else {
        return Ok(());
    };
    if state.owned[index].port == settings.port {
        return Ok(());
    }
    let auth = state
        .credentials
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("Sign in to Cloudflare to update the listener port"))?;
    verify(auth, &state.owned[index]).await?;
    configure(auth, &state.owned[index], settings.port).await?;
    state.owned[index].port = settings.port;
    save(&state)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_untrusted_hostnames() {
        for h in ["-a", "a.", "a/b", "a:b", "UPPER"] {
            assert!(!label(h));
        }
        assert!(host("codex.example.com"));
    }
    #[test]
    fn discards_private_keys_from_login_certificate() {
        let raw = json!({"accountID":"a".repeat(32),"zoneID":"b".repeat(32),"apiToken":"test-token-long-enough","privateKey":"discard"});
        let pem = format!(
            "-----BEGIN ARGO TUNNEL TOKEN-----\n{}\n-----END ARGO TUNNEL TOKEN-----",
            STANDARD.encode(raw.to_string())
        );
        let auth = decode_certificate(&pem).unwrap();
        assert!(
            serde_json::to_string(&auth)
                .unwrap()
                .find("discard")
                .is_none()
        );
    }
}
