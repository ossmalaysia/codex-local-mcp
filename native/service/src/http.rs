use crate::{
    auth::{self, Auth},
    jobs::Jobs,
    process,
    protocol::Protocol,
};
use axum::{
    Router,
    body::Body,
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

#[derive(Clone)]
struct HttpState {
    auth: Arc<Auth>,
    jobs: Arc<Jobs>,
    checked: Arc<tokio::sync::Mutex<Option<Instant>>>,
    inflight: Arc<tokio::sync::Semaphore>,
}

pub fn router(auth: Arc<Auth>, jobs: Arc<Jobs>) -> Router {
    let state = HttpState {
        auth: auth.clone(),
        jobs: jobs.clone(),
        checked: Arc::new(tokio::sync::Mutex::new(None)),
        inflight: Arc::new(tokio::sync::Semaphore::new(64)),
    };
    let factory_jobs = jobs.clone();
    let mut transport = StreamableHttpServerConfig::default();
    transport.legacy_session_mode = false;
    transport.json_response = true;
    transport.cancellation_token = jobs.cancel.clone();
    transport.allowed_hosts = vec![
        url::Url::parse(&auth.origin)
            .unwrap()
            .host_str()
            .unwrap()
            .into(),
        "localhost".into(),
        "127.0.0.1".into(),
        "[::1]".into(),
    ];
    let service = StreamableHttpService::new(
        move || {
            Ok(Protocol {
                jobs: factory_jobs.clone(),
            })
        },
        Arc::new(LocalSessionManager::default()),
        transport,
    );
    let protected = Router::new()
        .route_service("/mcp", service)
        .layer(middleware::from_fn_with_state(state.clone(), authenticate));
    Router::new()
        .route(
            "/.well-known/oauth-authorization-server",
            get(auth::metadata),
        )
        .route(
            "/.well-known/oauth-authorization-server/mcp",
            get(auth::metadata),
        )
        .route(
            "/.well-known/oauth-protected-resource",
            get(auth::resource_metadata),
        )
        .route(
            "/.well-known/oauth-protected-resource/mcp",
            get(auth::resource_metadata),
        )
        .route("/register", post(auth::register))
        .route("/authorize", get(auth::authorize))
        .route("/login", post(auth::login))
        .route("/token", post(auth::token))
        .route("/revoke", post(auth::revoke))
        .with_state(auth)
        .merge(protected)
        .layer(DefaultBodyLimit::max(1_100_000))
        .layer(middleware::from_fn_with_state(state, boundary))
}

async fn authenticate(State(state): State<HttpState>, request: Request, next: Next) -> Response {
    let token = request
        .headers()
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "));
    if !token.is_some_and(|t| t.len() <= 256 && state.auth.valid_access(t)) {
        let mut response = (StatusCode::UNAUTHORIZED, "Authentication required").into_response();
        response.headers_mut().insert("www-authenticate", HeaderValue::from_str(&format!("Bearer resource_metadata=\"{}/.well-known/oauth-protected-resource/mcp\", scope=\"{}\"", state.auth.origin, auth::SCOPE)).unwrap());
        return response;
    }
    if request.method() != axum::http::Method::POST {
        return (StatusCode::METHOD_NOT_ALLOWED, [("allow", "POST")]).into_response();
    }
    let mut checked = state.checked.lock().await;
    if checked.is_none_or(|t| t.elapsed() >= Duration::from_secs(30)) {
        if process::login(&state.jobs.config).await.is_err() {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                "Codex login is unavailable. Sign in to Codex in the app",
            )
                .into_response();
        }
        *checked = Some(Instant::now());
    }
    drop(checked);
    next.run(request).await
}

async fn boundary(State(state): State<HttpState>, request: Request, next: Next) -> Response {
    let Ok(_permit) = state.inflight.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let host = request
        .headers()
        .get("host")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    let public = url::Url::parse(&state.auth.origin).unwrap();
    let parsed = url::Url::parse(&format!("http://{host}"));
    let trusted = parsed.as_ref().ok().is_some_and(|u| {
        u.username().is_empty()
            && u.password().is_none()
            && u.path() == "/"
            && [
                public.host_str().unwrap(),
                "localhost",
                "127.0.0.1",
                "[::1]",
            ]
            .contains(&u.host_str().unwrap_or(""))
    });
    let origin_ok = request
        .headers()
        .get("origin")
        .is_none_or(|o| o == state.auth.origin.as_str());
    let mut response = if !trusted {
        (StatusCode::MISDIRECTED_REQUEST, "Untrusted host").into_response()
    } else if !origin_ok {
        (StatusCode::FORBIDDEN, "Untrusted origin").into_response()
    } else if request.uri().path().len() > 4096
        || request.uri().query().is_some_and(|q| q.len() > 8192)
    {
        StatusCode::URI_TOO_LONG.into_response()
    } else if request
        .headers()
        .get("content-length")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.parse::<usize>().ok())
        .is_some_and(|n| n > 1_100_000)
    {
        StatusCode::PAYLOAD_TOO_LARGE.into_response()
    } else {
        let (parts, body) = request.into_parts();
        match tokio::time::timeout(
            Duration::from_secs(10),
            axum::body::to_bytes(body, 1_100_000),
        )
        .await
        {
            Ok(Ok(bytes)) => {
                next.run(Request::from_parts(parts, Body::from(bytes)))
                    .await
            }
            Ok(Err(_)) => StatusCode::PAYLOAD_TOO_LARGE.into_response(),
            Err(_) => StatusCode::REQUEST_TIMEOUT.into_response(),
        }
    };
    let headers = response.headers_mut();
    headers.insert("cache-control", HeaderValue::from_static("no-store"));
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    if !headers.contains_key("referrer-policy") {
        headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    }
    if !headers.contains_key("content-security-policy") {
        headers.insert(
            "content-security-policy",
            HeaderValue::from_static(
                "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
            ),
        );
    }
    response
}
