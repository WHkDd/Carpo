use std::path::Path;

use axum::{
    extract::{Multipart, Path as AxumPath, State},
    Json,
};
use serde::Serialize;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;
use carpo_core::{error::AppError, jobs::grouped::FileKind};

use crate::{
    app_state::{FileRecord, ServerState},
    error::ServerResult,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadedFile {
    pub file_id: String,
    pub name: String,
    pub ext: String,
    pub kind: FileKind,
}

pub async fn upload_file(
    State(state): State<ServerState>,
    mut multipart: Multipart,
) -> ServerResult<Json<UploadedFile>> {
    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::Config(format!("multipart: {e}")))?
    {
        let Some(raw_name) = field.file_name().map(ToOwned::to_owned) else {
            continue;
        };
        let name = sanitize_filename(&raw_name);
        let ext = Path::new(&name)
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let kind = match ext.as_str() {
            "pdf" => FileKind::Pdf,
            "png" | "jpg" | "jpeg" | "tif" | "tiff" | "bmp" => FileKind::Image,
            _ => return Err(AppError::Image(format!("unsupported format: {ext}")).into()),
        };
        let id = Uuid::new_v4();
        let dir = state.data_dir.join("uploads").join(id.to_string());
        tokio::fs::create_dir_all(&dir).await?;
        let path = dir.join(&name);
        // Stream chunk-by-chunk instead of `field.bytes()`, which buffers the
        // entire upload (up to `MAX_UPLOAD_BYTES` = 256 MB) in memory before
        // writing anything to disk. A newspaper PDF batch upload at that size
        // would otherwise double as a way to pressure the server's RAM.
        let mut file = tokio::fs::File::create(&path).await?;
        while let Some(chunk) = field
            .chunk()
            .await
            .map_err(|e| AppError::Config(format!("multipart chunk: {e}")))?
        {
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        state.insert_file(
            id,
            FileRecord {
                dir,
                path,
                name: name.clone(),
                ext: ext.clone(),
                kind,
            },
        );
        return Ok(Json(UploadedFile {
            file_id: id.to_string(),
            name,
            ext,
            kind,
        }));
    }

    Err(AppError::Config("missing file field".into()).into())
}

pub async fn delete_file(
    State(state): State<ServerState>,
    AxumPath(file_id): AxumPath<Uuid>,
) -> ServerResult<Json<bool>> {
    if let Some(record) = state.remove_file(file_id) {
        let _ = tokio::fs::remove_dir_all(record.dir).await;
        Ok(Json(true))
    } else {
        Ok(Json(false))
    }
}

fn sanitize_filename(name: &str) -> String {
    let cleaned = name
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '\0' => '_',
            _ => ch,
        })
        .collect::<String>();
    if cleaned.trim().is_empty() {
        "upload".to_string()
    } else {
        cleaned
    }
}
