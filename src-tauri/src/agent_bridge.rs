//! Process-local, opt-in agent API. The WebView owns all document state.
use axum::{
    body::{to_bytes, Body},
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json, Router,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

const REQUEST_EVENT: &str = "carpo://agent/request";
const REPLY_TIMEOUT: Duration = Duration::from_secs(120);
type Reply = Result<Value, String>;
type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Reply>>>>;

#[derive(Default)]
pub struct AgentBridge {
    running: Mutex<Option<Running>>,
}
struct Running {
    task: tauri::async_runtime::JoinHandle<()>,
    active: Arc<AtomicBool>,
    pending: Pending,
    discovery: PathBuf,
}
impl Drop for Running {
    fn drop(&mut self) {
        self.active.store(false, Ordering::SeqCst);
        self.pending.lock().unwrap().clear();
        self.task.abort();
        let _ = std::fs::remove_file(&self.discovery);
    }
}
#[derive(Clone)]
struct HttpState {
    app: AppHandle,
    token: String,
    port: u16,
    pending: Pending,
    active: Arc<AtomicBool>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FrontendRequest {
    id: String,
    method: String,
    path: String,
    body: Value,
}

fn write_discovery(path: &Path, port: u16, token: &str) -> Result<(), String> {
    // Remove stale files first: create_new never follows a stale symlink.
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    let data = json!({"port":port,"token":token,"pid":std::process::id(),"version":env!("CARGO_PKG_VERSION")});
    file.write_all(data.to_string().as_bytes())
        .map_err(|e| e.to_string())
}

impl AgentBridge {
    pub fn stop(&self) {
        self.running.lock().unwrap().take();
    }
    pub fn set_enabled(&self, app: &AppHandle, enabled: bool) -> Result<(), String> {
        let mut running = self.running.lock().unwrap();
        if !enabled {
            running.take();
            return Ok(());
        }
        if running.is_some() {
            return Ok(());
        }
        let discovery = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("agent-bridge.json");
        std::fs::create_dir_all(discovery.parent().unwrap()).map_err(|e| e.to_string())?;
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .map_err(|e| e.to_string())?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let pending = Pending::default();
        let active = Arc::new(AtomicBool::new(true));
        let state = HttpState {
            app: app.clone(),
            token: token.clone(),
            port,
            pending: pending.clone(),
            active: active.clone(),
        };
        write_discovery(&discovery, port, &token)?;
        let task = serve(listener, Router::new().fallback(handle).with_state(state));
        *running = Some(Running {
            task,
            active,
            pending,
            discovery,
        });
        Ok(())
    }
}

fn serve(listener: std::net::TcpListener, router: Router) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let result = async {
            let listener = tokio::net::TcpListener::from_std(listener)?;
            axum::serve(listener, router).await
        }
        .await;
        if let Err(e) = result {
            log::error!("agent bridge: {e}");
        }
    })
}

fn authorize(headers: &HeaderMap, token: &str, port: u16) -> Result<(), StatusCode> {
    if headers.contains_key("origin") {
        return Err(StatusCode::FORBIDDEN);
    }
    let hosts = [format!("127.0.0.1:{port}"), format!("localhost:{port}")];
    if !headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| hosts.iter().any(|h| h == v))
    {
        return Err(StatusCode::FORBIDDEN);
    }
    if headers.get("authorization").and_then(|v| v.to_str().ok())
        != Some(format!("Bearer {token}").as_str())
    {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(())
}
fn error(code: StatusCode, message: impl ToString) -> Response {
    (code, Json(json!({"error":message.to_string()}))).into_response()
}

// Drop removes requests even if the HTTP client disconnects or a task is cancelled.
struct PendingReply {
    id: String,
    pending: Pending,
}
impl Drop for PendingReply {
    fn drop(&mut self) {
        self.pending.lock().unwrap().remove(&self.id);
    }
}
async fn wait_reply(rx: oneshot::Receiver<Reply>, duration: Duration) -> Reply {
    tokio::time::timeout(duration, rx)
        .await
        .map_err(|_| "frontend reply timed out".to_string())?
        .map_err(|_| "bridge stopped".to_string())?
}
async fn handle(State(state): State<HttpState>, request: Request<Body>) -> Response {
    if !state.active.load(Ordering::SeqCst) {
        return error(StatusCode::SERVICE_UNAVAILABLE, "bridge disabled");
    }
    if let Err(code) = authorize(request.headers(), &state.token, state.port) {
        return error(code, "unauthorized local request");
    }
    let method = request.method().to_string();
    let path = request.uri().path().to_string();
    if method == "GET" {
        let document = match path.as_str() {
            "/v1/guide" => Some(include_str!("agent_guide.md")),
            "/v1/skill" => Some(include_str!("../../skills/carpo/SKILL.md")),
            _ => None,
        };
        if let Some(document) = document {
            return ([("content-type", "text/markdown; charset=utf-8")], document).into_response();
        }
    }
    let mut body = match to_bytes(request.into_body(), 2 * 1024 * 1024).await {
        Ok(b) if b.is_empty() => json!({}),
        Ok(b) => match serde_json::from_slice::<Value>(&b) {
            Ok(v) => v,
            Err(e) => return error(StatusCode::BAD_REQUEST, e),
        },
        Err(e) => return error(StatusCode::PAYLOAD_TOO_LARGE, e),
    };
    if method == "POST" && path == "/v1/files/import" {
        let paths = match import_paths(&body) {
            Ok(p) => p,
            Err(e) => return error(StatusCode::BAD_REQUEST, e),
        };
        crate::desktop::queue_open_paths(&state.app, paths.clone(), false);
        body = json!({"paths":paths});
    }
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    state.pending.lock().unwrap().insert(id.clone(), tx);
    let _pending = PendingReply {
        id: id.clone(),
        pending: state.pending.clone(),
    };
    if let Err(e) = state.app.emit_to(
        "main",
        REQUEST_EVENT,
        FrontendRequest {
            id,
            method,
            path: path.clone(),
            body,
        },
    ) {
        return error(StatusCode::SERVICE_UNAVAILABLE, e);
    }
    match wait_reply(rx, REPLY_TIMEOUT).await {
        Ok(mut data) => {
            if path == "/v1/status" {
                data["version"] = json!(env!("CARGO_PKG_VERSION"));
            }
            Json(data).into_response()
        }
        Err(e) => error(
            if e.contains("timed out") {
                StatusCode::GATEWAY_TIMEOUT
            } else {
                StatusCode::BAD_REQUEST
            },
            e,
        ),
    }
}

fn import_paths(body: &Value) -> Result<Vec<String>, String> {
    let paths = if let Some(paths) = body.get("paths") {
        if body.get("dir").is_some() {
            return Err("use paths or dir, not both".into());
        }
        serde_json::from_value::<Vec<String>>(paths.clone()).map_err(|e| e.to_string())?
    } else if let Some(dir) = body.get("dir").and_then(Value::as_str) {
        let dir = Path::new(dir);
        if !dir.is_absolute() || !dir.is_dir() {
            return Err("dir must be an absolute directory".into());
        }
        let mut paths = Vec::new();
        collect_dir(
            dir,
            body.get("recursive")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            &mut paths,
        )?;
        paths.sort();
        paths
    } else {
        return Err("expected paths or dir".into());
    };
    if paths.iter().any(|p| !Path::new(p).is_absolute()) {
        return Err("paths must be absolute".into());
    }
    let valid = crate::desktop::collect_open_paths(paths.clone(), Path::new("/"));
    if body.get("paths").is_some()
        && valid.len() != paths.iter().collect::<std::collections::HashSet<_>>().len()
    {
        return Err("paths contain missing or unsupported files".into());
    }
    if valid.is_empty() {
        return Err("no supported files found".into());
    }
    Ok(valid)
}
fn collect_dir(dir: &Path, recursive: bool, paths: &mut Vec<String>) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_dir() && recursive {
            collect_dir(&entry.path(), true, paths)?;
        } else if kind.is_file() {
            paths.push(entry.path().to_string_lossy().into_owned());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn agent_bridge_reply(
    state: tauri::State<'_, AgentBridge>,
    id: String,
    ok: bool,
    data: Option<Value>,
    error: Option<String>,
) {
    if let Some(running) = state.running.lock().unwrap().as_ref() {
        if let Some(tx) = running.pending.lock().unwrap().remove(&id) {
            let _ = tx.send(if ok {
                Ok(data.unwrap_or(Value::Null))
            } else {
                Err(error.unwrap_or_else(|| "frontend error".into()))
            });
        }
    }
}

#[derive(serde::Deserialize)]
pub struct UnitImagePlan {
    key: String,
    page: u32,
    crop: Option<ImageCrop>,
}
#[derive(Clone, serde::Deserialize)]
struct ImageCrop {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}
#[derive(Serialize)]
pub struct UnitImage {
    key: String,
    page: u32,
    path: String,
}

#[tauri::command]
pub async fn agent_bridge_unit_images(
    app: AppHandle,
    path: String,
    kind: String,
    plans: Vec<UnitImagePlan>,
    state: tauri::State<'_, Arc<carpo_core::state::AppState>>,
) -> Result<Vec<UnitImage>, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("agent-bridge-images");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Group only plans, not bitmaps. A page and all its article crops finish
    // before the next page is rendered, bounding bitmap memory to one page's work.
    let mut pages = BTreeMap::<u32, Vec<(usize, UnitImagePlan)>>::new();
    for (index, plan) in plans.into_iter().enumerate() {
        pages.entry(plan.page).or_default().push((index, plan));
    }
    let mut results = Vec::new();
    for (page, plans) in pages {
        let (bitmap, width, height) = if kind == "pdf" {
            let rendered = state
                .pdf
                .render_png(PathBuf::from(&path), page, 150)
                .await
                .map_err(|e| e.to_string())?;
            let bitmap = image::load_from_memory(&rendered.bytes).map_err(|e| e.to_string())?;
            (bitmap, rendered.width, rendered.height)
        } else {
            let source_path = path.clone();
            let bitmap = tokio::task::spawn_blocking(move || {
                carpo_core::image::load_from_disk(Path::new(&source_path))
            })
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
            let width = bitmap.width();
            let height = bitmap.height();
            (bitmap, width, height)
        };
        for (index, plan) in plans {
            let cropped = if let Some(crop) = plan.crop {
                if [crop.x, crop.y, crop.width, crop.height]
                    .iter()
                    .any(|v| !v.is_finite())
                    || crop.width <= 0.0
                    || crop.height <= 0.0
                {
                    return Err("invalid image crop".into());
                }
                let sx = bitmap.width() as f64 / width as f64;
                let sy = bitmap.height() as f64 / height as f64;
                let x = (crop.x * sx).max(0.0).floor() as u32;
                let y = (crop.y * sy).max(0.0).floor() as u32;
                let right = ((crop.x + crop.width) * sx).ceil().max(0.0) as u32;
                let bottom = ((crop.y + crop.height) * sy).ceil().max(0.0) as u32;
                let w = right.min(bitmap.width()).saturating_sub(x);
                let h = bottom.min(bitmap.height()).saturating_sub(y);
                if w == 0 || h == 0 {
                    return Err("crop lies outside source image".into());
                }
                bitmap.crop_imm(x, y, w, h)
            } else {
                bitmap.clone()
            };
            let target = dir.join(format!("{}.png", uuid::Uuid::new_v4()));
            let write_target = target.clone();
            tokio::task::spawn_blocking(move || -> Result<(), String> {
                let bytes = carpo_core::image::encode_rgba_png(
                    cropped.width(),
                    cropped.height(),
                    cropped.to_rgba8().as_raw(),
                )
                .map_err(|e| e.to_string())?;
                let mut options = OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                options
                    .open(write_target)
                    .and_then(|mut file| file.write_all(&bytes))
                    .map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| e.to_string())??;
            results.push((
                index,
                UnitImage {
                    key: plan.key,
                    page: plan.page,
                    path: target.to_string_lossy().into_owned(),
                },
            ));
        }
    }
    results.sort_by_key(|(index, _)| *index);
    Ok(results.into_iter().map(|(_, image)| image).collect())
}

// Agent targets are explicit filesystem authority; they did not pass through a
// native file picker, so plugin-fs's dialog scope must not be used here.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutput {
    target: String,
    stem: Option<String>,
    format: String,
    data: Option<Vec<u8>>,
    document: Option<carpo_core::ocr::paddle_json::LayoutDocument>,
}
fn output_file(
    target: &Path,
    stem: Option<&str>,
    extension: &str,
) -> Result<(PathBuf, std::fs::File), String> {
    if !target.is_absolute() {
        return Err("target must be absolute".into());
    }
    if let Some(stem) = stem {
        if stem.is_empty() || stem == "." || stem == ".." || stem.contains(['/', '\\']) {
            return Err("invalid output filename".into());
        }
        if !target.is_dir() {
            return Err("target must be an existing directory for separate/by_tag".into());
        }
        for n in 1..10000 {
            let name = if n == 1 {
                format!("{stem}.{extension}")
            } else {
                format!("{stem} ({n}).{extension}")
            };
            let path = target.join(name);
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => return Ok((path, file)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e.to_string()),
            }
        }
        Err("too many output filename collisions".into())
    } else {
        if !target.parent().is_some_and(Path::is_dir) || target.is_dir() {
            return Err(
                "target must be a file with an existing parent directory for merged".into(),
            );
        }
        // Merged exports intentionally replace the explicitly requested file.
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(target)
            .map_err(|e| e.to_string())?;
        Ok((target.to_path_buf(), file))
    }
}
fn export_output(output: ExportOutput, cache: &Path) -> Result<Value, String> {
    if !["md", "docx", "layout-pdf"].contains(&output.format.as_str()) {
        return Err("unsupported export format".into());
    }
    let extension = if output.format == "layout-pdf" {
        "pdf"
    } else {
        &output.format
    };
    // Validate/render before opening the requested destination. A missing font
    // must never truncate an existing merged document.
    let (data, mut result) = if output.format == "layout-pdf" {
        let document = output
            .document
            .ok_or("layout-pdf requires recognized layout pages")?;
        std::fs::create_dir_all(cache).map_err(|e| e.to_string())?;
        let scratch = cache.join(format!("{}.pdf", uuid::Uuid::new_v4()));
        let rendered = crate::layout_pdf::export_layout_pdf_to_path(
            crate::layout_pdf::LayoutPdfExportRequest {
                document,
                target_path: scratch.to_string_lossy().into_owned(),
                options: Default::default(),
            },
        )
        .map_err(|e| e.to_string());
        let bytes = rendered
            .as_ref()
            .map_err(Clone::clone)
            .and_then(|_| std::fs::read(&scratch).map_err(|e| e.to_string()));
        let _ = std::fs::remove_file(scratch);
        (bytes?, json!(rendered?))
    } else {
        (output.data.ok_or("missing export data")?, json!({}))
    };
    let (path, mut file) =
        output_file(Path::new(&output.target), output.stem.as_deref(), extension)?;
    file.write_all(&data).map_err(|e| e.to_string())?;
    result["targetPath"] = json!(path);
    Ok(result)
}
#[tauri::command]
pub async fn agent_bridge_write_export(
    app: AppHandle,
    output: ExportOutput,
) -> Result<Value, String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("agent-bridge-exports");
    tokio::task::spawn_blocking(move || export_output(output, &cache))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authentication() {
        let mut h = HeaderMap::new();
        h.insert("host", "127.0.0.1:42".parse().unwrap());
        assert_eq!(authorize(&h, "secret", 42), Err(StatusCode::UNAUTHORIZED));
        h.insert("authorization", "Bearer secret".parse().unwrap());
        assert!(authorize(&h, "secret", 42).is_ok());
        assert_eq!(authorize(&h, "wrong", 42), Err(StatusCode::UNAUTHORIZED));
        h.insert("host", "localhost:42".parse().unwrap());
        assert!(authorize(&h, "secret", 42).is_ok());
        for bad in [
            "evil.test:42",
            "127.0.0.1:43",
            "localhost",
            "127.0.0.1:42.evil.test",
        ] {
            h.insert("host", bad.parse().unwrap());
            assert_eq!(authorize(&h, "secret", 42), Err(StatusCode::FORBIDDEN));
        }
        h.insert("host", "localhost:42".parse().unwrap());
        h.insert("origin", "null".parse().unwrap());
        assert_eq!(authorize(&h, "secret", 42), Err(StatusCode::FORBIDDEN));
    }
    #[tokio::test]
    async fn discovery_permissions_and_shutdown() {
        let bridge = AgentBridge::default();
        assert!(bridge.running.lock().unwrap().is_none());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent-bridge.json");
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr = listener.local_addr().unwrap();
        write_discovery(&path, 42, "first").unwrap();
        write_discovery(&path, addr.port(), "second").unwrap();
        let data: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(data["token"], "second");
        assert_eq!(data["port"], addr.port());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let active = Arc::new(AtomicBool::new(true));
        // Same body as `serve`, with a completion signal. Dropping this future
        // closes its listener, so the signal fires exactly when shutdown takes
        // effect; probing the port instead races with port reuse.
        let (ended, ended_rx) = oneshot::channel();
        let router = Router::new().fallback(|| async { "ok" });
        let task = tauri::async_runtime::spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            let _ = axum::serve(listener, router).await;
            let _ = ended.send(());
        });
        *bridge.running.lock().unwrap() = Some(Running {
            task,
            active: active.clone(),
            pending: Pending::default(),
            discovery: path.clone(),
        });
        assert!(tokio::net::TcpStream::connect(addr).await.is_ok());
        bridge.stop();
        assert!(!path.exists());
        assert!(!active.load(Ordering::SeqCst));
        assert!(
            tokio::time::timeout(Duration::from_secs(5), ended_rx)
                .await
                .is_ok(),
            "serve task kept running after stop"
        );
        bridge.stop();
    }
    #[test]
    fn explicit_exports_and_collision_names() {
        let dir = tempfile::tempdir().unwrap();
        let make = |stem: Option<&str>, target: &Path| ExportOutput {
            target: target.to_string_lossy().into_owned(),
            stem: stem.map(str::to_string),
            format: "md".into(),
            data: Some("校对文本".as_bytes().to_vec()),
            document: None,
        };
        let a = export_output(make(Some("scan"), dir.path()), dir.path()).unwrap();
        let b = export_output(make(Some("scan"), dir.path()), dir.path()).unwrap();
        assert!(a["targetPath"].as_str().unwrap().ends_with("scan.md"));
        assert!(b["targetPath"].as_str().unwrap().ends_with("scan (2).md"));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("scan.md")).unwrap(),
            "校对文本"
        );
        assert!(export_output(make(Some("../escape"), dir.path()), dir.path()).is_err());
        assert!(export_output(make(None, Path::new("relative.md")), dir.path()).is_err());
        let target = dir.path().join("merged.md");
        std::fs::write(&target, "old").unwrap();
        export_output(make(None, &target), dir.path()).unwrap();
        assert_eq!(std::fs::read_to_string(target).unwrap(), "校对文本");
    }
    #[tokio::test]
    async fn replies_timeout_and_cleanup() {
        let pending = Pending::default();
        let (tx, rx) = oneshot::channel();
        pending.lock().unwrap().insert("x".into(), tx);
        let guard = PendingReply {
            id: "x".into(),
            pending: pending.clone(),
        };
        assert!(wait_reply(rx, Duration::from_millis(1))
            .await
            .unwrap_err()
            .contains("timed out"));
        drop(guard);
        assert!(pending.lock().unwrap().is_empty());
    }
}
