mod app_state;
mod error;
mod routes;
mod secrets_store;

use std::{
    env,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
};

use axum::Router;
use tower_http::{services::ServeDir, trace::TraceLayer};
use xcvt_core::state::AppState as CoreState;

use crate::{app_state::ServerState, secrets_store::SecretsStore};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "xcvt_server=info,tower_http=info".into()),
        )
        .init();

    let data_dir = env::var_os("XCVT_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("data"));
    let static_dir = env::var_os("XCVT_STATIC_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("dist"));
    let port = env::var("XCVT_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(8787);

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

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("xcvt-server listening on http://{addr}");
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

    fn test_app() -> Option<(Router, TempDir)> {
        let explicit_pdfium = std::env::var_os("XCVT_PDFIUM_LIBRARY_PATH").is_some();
        if !explicit_pdfium {
            let path = local_pdfium_path()?;
            std::env::set_var("XCVT_PDFIUM_LIBRARY_PATH", path);
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
        let app = routes::router().with_state(state);
        Some((app, data_dir))
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
        const BOUNDARY: &str = "xcvt-test-boundary";
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
