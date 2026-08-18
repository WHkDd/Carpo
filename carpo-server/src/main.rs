mod app_state;
mod error;
mod routes;
mod secrets_store;

use std::{
    env,
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    sync::Arc,
};

use axum::Router;
use carpo_core::state::AppState as CoreState;
use tower_http::{services::ServeDir, trace::TraceLayer};

use crate::{app_state::ServerState, secrets_store::SecretsStore};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "carpo_server=info,tower_http=info".into()),
        )
        .init();

    let data_dir = env::var_os("CARPO_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("data"));
    let static_dir = env::var_os("CARPO_STATIC_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("dist"));
    let port = env::var("CARPO_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(8787);
    // Loopback by default; exposing the service is an explicit decision.
    //
    // None of the API surface is authenticated: `PUT /api/settings/secrets`
    // takes a provider key from anyone who can reach the port, and every job
    // route spends those keys. `MAX_ACTIVE_JOBS` and the proofread size caps
    // bound the damage of a misconfigured client, but they are not a substitute
    // for authentication against a deliberate one. The Docker image sets
    // `CARPO_BIND=0.0.0.0` because a container's own network namespace is the
    // boundary there — publish its port only to a network you trust.
    let bind = env::var("CARPO_BIND").unwrap_or_else(|_| "127.0.0.1".into());

    // The upload registry (`ServerState::files`) is in-memory only, so a
    // restart orphans whatever is still under `uploads/` — no id survives to
    // reference it, and nothing ever cleans it up. Long-running self-hosted
    // deployments would otherwise leak disk indefinitely. Uploads are
    // inherently session-scoped anyway (an OCR job tied to one is gone the
    // moment the process restarts), so start every run from an empty dir.
    reset_uploads_dir(&data_dir)?;

    let secrets = Arc::new(SecretsStore::open(data_dir.join("secrets.json"))?);
    let core = Arc::new(CoreState::new(data_dir.clone(), secrets.clone())?);
    let state = ServerState::new(core, data_dir, secrets);

    let app = Router::new()
        .merge(routes::router())
        .fallback_service(ServeDir::new(static_dir))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let ip: IpAddr = bind
        .parse()
        .map_err(|_| anyhow::anyhow!("CARPO_BIND is not an IP address: {bind}"))?;
    let addr = SocketAddr::new(ip, port);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    if !ip.is_loopback() {
        tracing::warn!(
            "carpo-server is listening on {ip}, which is reachable from other hosts. \
             The API has no authentication: anyone who can reach this port can read \
             and write settings and spend the stored provider keys."
        );
    }
    tracing::info!("carpo-server listening on http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}

fn reset_uploads_dir(data_dir: &Path) -> anyhow::Result<()> {
    let uploads = data_dir.join("uploads");
    if uploads.exists() {
        std::fs::remove_dir_all(&uploads)?;
    }
    std::fs::create_dir_all(&uploads)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        http::{header, Method, Request, StatusCode},
        response::Response,
    };
    use serde_json::{json, Value};
    use tempfile::TempDir;
    use tower::ServiceExt;

    const SAMPLE_PDF: &[u8] = include_bytes!("../../src-tauri/tests/fixtures/sample.pdf");

    #[tokio::test]
    async fn server_routes_smoke() {
        let Some((app, data_dir)) = test_app() else {
            eprintln!("skipping server_routes_smoke: pdfium library is not available");
            return;
        };

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/healthz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response_text(response).await, "ok");

        let settings = request_json(
            app.clone(),
            Method::GET,
            "/api/settings",
            None,
            StatusCode::OK,
        )
        .await;
        assert_eq!(settings["provider"], "openai");

        let mut updated_settings = settings;
        updated_settings["openai_model"] = json!("gpt-4o-mini");
        let saved = request_json(
            app.clone(),
            Method::PUT,
            "/api/settings",
            Some(updated_settings),
            StatusCode::OK,
        )
        .await;
        assert_eq!(saved["openai_model"], "gpt-4o-mini");

        let secret_status = request_json(
            app.clone(),
            Method::PUT,
            "/api/settings/secrets",
            Some(json!({ "key": "openai_key", "value": "sk-test" })),
            StatusCode::OK,
        )
        .await;
        assert_eq!(secret_status["openai_key"], true);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(data_dir.path().join("secrets.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }

        let secret_status = request_json(
            app.clone(),
            Method::DELETE,
            "/api/settings/secrets/openai_key",
            None,
            StatusCode::OK,
        )
        .await;
        assert_eq!(secret_status["openai_key"], false);

        let upload = upload_sample_pdf(app.clone()).await;
        assert_eq!(upload["name"], "sample.pdf");
        assert_eq!(upload["ext"], "pdf");
        assert_eq!(upload["kind"], "pdf");
        let file_id = upload["fileId"].as_str().unwrap();

        let info = request_json(
            app.clone(),
            Method::GET,
            &format!("/api/files/{file_id}/pdf-info"),
            None,
            StatusCode::OK,
        )
        .await;
        assert_eq!(info["page_count"], 2);

        let page1 = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/files/{file_id}/pages/1?dpi=72"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(page1.status(), StatusCode::OK);
        let bytes1 = to_bytes(page1.into_body(), usize::MAX).await.unwrap();
        assert!(bytes1.len() > 11);
        let width = u32::from_le_bytes(bytes1[0..4].try_into().unwrap());
        let height = u32::from_le_bytes(bytes1[4..8].try_into().unwrap());
        assert!(width > 0);
        assert!(height > 0);
        assert_eq!(&bytes1[8..11], b"\xff\xd8\xff");

        let page2 = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/files/{file_id}/pages/2?dpi=72"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(page2.status(), StatusCode::OK);
        let bytes2 = to_bytes(page2.into_body(), usize::MAX).await.unwrap();
        assert!(bytes2.len() > 11);
        assert_eq!(&bytes2[8..11], b"\xff\xd8\xff");

        let deleted = request_json(
            app.clone(),
            Method::DELETE,
            &format!("/api/files/{file_id}"),
            None,
            StatusCode::OK,
        )
        .await;
        assert_eq!(deleted, json!(true));

        let missing = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/files/{file_id}/pdf-info"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn upload_accepts_pdf_over_default_body_limit() {
        let Some((app, _data_dir)) = test_app() else {
            eprintln!("skipping upload_accepts_pdf_over_default_body_limit: pdfium library is not available");
            return;
        };

        let large_pdf = vec![0_u8; 3 * 1024 * 1024];
        let upload = upload_pdf_bytes(app, "large.pdf", &large_pdf).await;
        assert_eq!(upload["name"], "large.pdf");
        assert_eq!(upload["ext"], "pdf");
        assert_eq!(upload["kind"], "pdf");
    }

    /// Two guarantees for `/api/ocr/models`, in one test because the second
    /// phase depends on the allowlist being *unset* and the allowlist lives in
    /// the process environment — as separate `#[tokio::test]`s they run in
    /// parallel, and a recycled ephemeral port lets one phase's allowlist
    /// entry silently exempt the other's mock server.
    ///
    /// **Phase 1** — the stored provider key is only ever spent on the endpoint
    /// this server has on disk. Both mock endpoints are allowlisted here, so
    /// the URL screen in `ocr::base_url` is deliberately neutralised and the
    /// only thing under test is that a caller-supplied `settings` cannot
    /// redirect a server-supplied secret.
    ///
    /// **Phase 2** — with no allowlist, a caller that brings its own key still
    /// may not steer the request at the deployment's own network.
    #[tokio::test]
    async fn models_endpoint_guards_the_stored_key_and_the_private_network() {
        use wiremock::matchers::{header, method as wm_method, path as wm_path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let Some((app, _data_dir)) = test_app() else {
            eprintln!(
                "skipping models_endpoint_guards_the_stored_key_and_the_private_network: pdfium library is not available"
            );
            return;
        };

        let configured = MockServer::start().await;
        let attacker = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/models"))
            .and(header("Authorization", "Bearer sk-server-side"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": [{ "id": "configured-model" }]
            })))
            .mount(&configured)
            .await;
        // Anything at all reaching this one is the bug.
        Mock::given(wm_method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "data": [] })))
            .mount(&attacker)
            .await;
        std::env::set_var(
            carpo_core::ocr::base_url::ALLOWLIST_ENV,
            format!(
                "{},{}",
                authority(&configured.uri()),
                authority(&attacker.uri())
            ),
        );

        let mut settings = request_json(
            app.clone(),
            Method::GET,
            "/api/settings",
            None,
            StatusCode::OK,
        )
        .await;
        settings["provider"] = json!("openai_compatible");
        settings["openai_compatible_base_url"] = json!(configured.uri());
        request_json(
            app.clone(),
            Method::PUT,
            "/api/settings",
            Some(settings.clone()),
            StatusCode::OK,
        )
        .await;
        request_json(
            app.clone(),
            Method::PUT,
            "/api/settings/secrets",
            Some(json!({ "key": "openai_compatible_key", "value": "sk-server-side" })),
            StatusCode::OK,
        )
        .await;

        let mut hijacked = settings;
        hijacked["openai_compatible_base_url"] = json!(attacker.uri());
        let models = request_json(
            app.clone(),
            Method::POST,
            "/api/ocr/models",
            Some(json!({ "settings": hijacked.clone() })),
            StatusCode::OK,
        )
        .await;

        assert_eq!(models, json!(["configured-model"]));
        assert!(
            attacker
                .received_requests()
                .await
                .unwrap_or_default()
                .is_empty(),
            "the caller-supplied base URL received a request carrying the server's key"
        );

        // Phase 2. Both mock servers are still bound, so their ports cannot be
        // recycled underneath the cleared allowlist.
        std::env::remove_var(carpo_core::ocr::base_url::ALLOWLIST_ENV);
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/ocr/models")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::to_vec(
                            &json!({ "settings": hijacked, "secret": "sk-caller-owned" }),
                        )
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(
            attacker
                .received_requests()
                .await
                .unwrap_or_default()
                .is_empty(),
            "a loopback base URL was contacted despite the network-facing policy"
        );
    }

    fn authority(uri: &str) -> String {
        uri.trim_start_matches("http://")
            .trim_start_matches("https://")
            .trim_end_matches('/')
            .to_string()
    }

    /// Two orderings at the proofread route, in one test because both need the
    /// registry filled: a full registry answers **429** (temporary), and an
    /// over-limit request answers **400** (never acceptable) *even while full* —
    /// `validate` runs before `try_register` on purpose.
    ///
    /// The registry is filled by registering directly rather than by starting
    /// real jobs: this asserts the admission gate, and no assertion here should
    /// depend on a provider being reachable.
    #[tokio::test]
    async fn proofread_route_refuses_when_the_job_registry_is_full() {
        use carpo_core::jobs::{JobKind, MAX_ACTIVE_JOBS};

        let Some((app, state, _data_dir)) = test_app_with_state() else {
            eprintln!(
                "skipping proofread_route_refuses_when_the_job_registry_is_full: pdfium library is not available"
            );
            return;
        };

        let mut settings = request_json(
            app.clone(),
            Method::GET,
            "/api/settings",
            None,
            StatusCode::OK,
        )
        .await;
        settings["provider"] = json!("openai");
        settings["openai_model"] = json!("gpt-4o");
        request_json(
            app.clone(),
            Method::PUT,
            "/api/settings",
            Some(settings),
            StatusCode::OK,
        )
        .await;
        let upload = upload_sample_pdf(app.clone()).await;
        let file_id = upload["fileId"].as_str().unwrap().to_string();

        let _held: Vec<_> = (0..MAX_ACTIVE_JOBS)
            .map(|_| state.core.jobs.try_register(JobKind::Proofread).unwrap())
            .collect();

        let body = json!({
            "file_id": file_id,
            "units": [{ "key": "page:1", "text": "本埠新聞" }],
        });
        let response = post_json(app.clone(), "/api/ocr/proofread", &body).await;
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);

        let too_many_units: Vec<Value> = (0..=carpo_core::jobs::proofread::MAX_PROOFREAD_UNITS)
            .map(|i| json!({ "key": format!("page:{i}"), "text": "本埠新聞" }))
            .collect();
        let response = post_json(
            app,
            "/api/ocr/proofread",
            &json!({ "file_id": file_id, "units": too_many_units }),
        )
        .await;
        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "an over-limit request must be refused on its own merits, not queued"
        );
    }

    /// A proofread body carrying a page image must reach `validate`, not die
    /// at the transport layer. Every proofread now attaches the scan of the
    /// original, so axum's 2MB default body limit would reject the *normal*
    /// request — and as a 413 with no explanation of which limit was hit.
    ///
    /// The image here is deliberately invalid (`data:` prefix, which the
    /// backend refuses because the mime type is its to choose), so the
    /// assertion is that the request got far enough to be judged on its
    /// contents: a 400 proves the body was read, where 413 would prove it was
    /// not. Sending a *valid* image would start a real job against a provider.
    #[tokio::test]
    async fn proofread_route_accepts_a_body_larger_than_the_default_limit() {
        let Some((app, _data_dir)) = test_app() else {
            eprintln!(
                "skipping proofread_route_accepts_a_body_larger_than_the_default_limit: pdfium library is not available"
            );
            return;
        };

        let mut settings = request_json(
            app.clone(),
            Method::GET,
            "/api/settings",
            None,
            StatusCode::OK,
        )
        .await;
        settings["provider"] = json!("openai");
        settings["openai_model"] = json!("gpt-4o");
        request_json(
            app.clone(),
            Method::PUT,
            "/api/settings",
            Some(settings),
            StatusCode::OK,
        )
        .await;
        let upload = upload_sample_pdf(app.clone()).await;
        let file_id = upload["fileId"].as_str().unwrap().to_string();

        // 3MB of payload: over axum's 2MB default, under the per-image cap.
        let image = format!(
            "data:image/jpeg;base64,{}",
            "QUJD".repeat(3 * 1024 * 1024 / 4)
        );
        let body = json!({
            "file_id": file_id,
            "units": [{ "key": "page:1", "text": "本埠新聞", "images": [image] }],
        });
        let response = post_json(app, "/api/ocr/proofread", &body).await;
        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "a multi-megabyte proofread body must reach validate, not be cut off as a 413"
        );
    }

    async fn post_json(app: Router, uri: &str, body: &Value) -> Response {
        app.oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(uri)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(serde_json::to_vec(body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap()
    }

    fn test_app() -> Option<(Router, TempDir)> {
        test_app_with_state().map(|(app, _state, dir)| (app, dir))
    }

    fn test_app_with_state() -> Option<(Router, ServerState, TempDir)> {
        let explicit_pdfium = std::env::var_os("CARPO_PDFIUM_LIBRARY_PATH").is_some();
        if !explicit_pdfium {
            let path = local_pdfium_path()?;
            std::env::set_var("CARPO_PDFIUM_LIBRARY_PATH", path);
        }

        let data_dir = tempfile::tempdir().unwrap();
        let secrets = Arc::new(SecretsStore::open(data_dir.path().join("secrets.json")).unwrap());
        let core = match CoreState::new(data_dir.path().to_path_buf(), secrets.clone()) {
            Ok(core) => Arc::new(core),
            Err(err) if !explicit_pdfium => {
                eprintln!("skipping server_routes_smoke: {err}");
                return None;
            }
            Err(err) => panic!("server_routes_smoke setup failed: {err}"),
        };
        let state = ServerState::new(core, data_dir.path().to_path_buf(), secrets);
        let app = routes::router().with_state(state.clone());
        Some((app, state, data_dir))
    }

    fn local_pdfium_path() -> Option<PathBuf> {
        let arch = match (env::consts::OS, env::consts::ARCH) {
            ("macos", "aarch64") => "macos-arm64",
            ("windows", "x86_64") => "windows-x64",
            ("linux", "x86_64") => "linux-x64",
            ("linux", "aarch64") => "linux-arm64",
            _ => return None,
        };
        let filename = if cfg!(target_os = "windows") {
            "pdfium.dll"
        } else if cfg!(target_os = "linux") {
            "libpdfium.so"
        } else {
            "libpdfium.dylib"
        };
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../src-tauri/pdfium")
            .join(arch)
            .join(filename);
        path.exists().then_some(path)
    }

    async fn request_json(
        app: Router,
        method: Method,
        uri: &str,
        body: Option<Value>,
        expected_status: StatusCode,
    ) -> Value {
        let mut builder = Request::builder().method(method).uri(uri);
        let body = if let Some(body) = body {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            Body::from(serde_json::to_vec(&body).unwrap())
        } else {
            Body::empty()
        };
        let response = app.oneshot(builder.body(body).unwrap()).await.unwrap();
        assert_json_status(response, expected_status).await
    }

    async fn upload_sample_pdf(app: Router) -> Value {
        upload_pdf_bytes(app, "sample.pdf", SAMPLE_PDF).await
    }

    async fn upload_pdf_bytes(app: Router, filename: &str, bytes: &[u8]) -> Value {
        const BOUNDARY: &str = "carpo-test-boundary";
        let mut body = Vec::new();
        body.extend_from_slice(
            format!(
                "--{BOUNDARY}\r\n\
                 Content-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n\
                 Content-Type: application/pdf\r\n\r\n"
            )
            .as_bytes(),
        );
        body.extend_from_slice(bytes);
        body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/files")
                    .header(
                        header::CONTENT_TYPE,
                        format!("multipart/form-data; boundary={BOUNDARY}"),
                    )
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_json_status(response, StatusCode::OK).await
    }

    async fn assert_json_status(response: Response, expected_status: StatusCode) -> Value {
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(
            status,
            expected_status,
            "response body: {}",
            String::from_utf8_lossy(&bytes)
        );
        serde_json::from_slice(&bytes).unwrap()
    }

    async fn response_text(response: Response) -> String {
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }
}
