//! 文件管理命令。

use std::path::PathBuf;

use android_core::{file, FileEntry};
use tauri::AppHandle;

use crate::error::{CommandError, CommandResult};
use crate::state::state;

#[tauri::command]
pub async fn file_list(
    app: AppHandle,
    serial: String,
    path: String,
) -> CommandResult<Vec<FileEntry>> {
    let st = state(&app);
    file::list(&st.adb, &serial, &path)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn file_stat(
    app: AppHandle,
    serial: String,
    path: String,
) -> CommandResult<Option<FileEntry>> {
    let st = state(&app);
    file::stat(&st.adb, &serial, &path)
        .await
        .map_err(Into::into)
}

/// 把设备文件下载到本地目录，返回实际路径与字节数。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferResult {
    pub path: String,
    pub bytes: u64,
}

#[tauri::command]
pub async fn file_pull(
    app: AppHandle,
    serial: String,
    remote_path: String,
    local_path: String,
) -> CommandResult<TransferResult> {
    let requested = PathBuf::from(&local_path);

    // 前端可能传目录：按远端文件名拼出完整目标路径
    let target = if requested.is_dir() {
        let name = remote_path.rsplit('/').next().unwrap_or("download.bin");
        requested.join(name)
    } else {
        requested
    };

    let st = state(&app);
    let bytes = file::pull(&st.adb, &serial, &remote_path, &target).await?;

    Ok(TransferResult {
        path: target.display().to_string(),
        bytes,
    })
}

/// 递归下载整个目录到指定的本地父目录。
///
/// 与 `file_pull` 不同，这里由后端决定最终目录名（并对 Windows 非法字符做替换），
/// 前端只需要给出「下载到哪个父目录」。
#[tauri::command]
pub async fn file_pull_dir(
    app: AppHandle,
    serial: String,
    remote_path: String,
    dest_dir: String,
) -> CommandResult<TransferResult> {
    let dest = PathBuf::from(&dest_dir);
    if !dest.is_dir() {
        return Err(CommandError::not_found(format!(
            "本地目录不存在：{dest_dir}"
        )));
    }

    let st = state(&app);
    let (path, bytes) = file::pull_dir(&st.adb, &serial, &remote_path, &dest).await?;

    Ok(TransferResult {
        path: path.display().to_string(),
        bytes,
    })
}

/// 把本地文件上传到设备路径。
#[tauri::command]
pub async fn file_push(
    app: AppHandle,
    serial: String,
    local_path: String,
    remote_path: String,
) -> CommandResult<TransferResult> {
    let source = PathBuf::from(&local_path);
    if !source.is_file() {
        return Err(CommandError::not_found(format!(
            "找不到本地文件：{local_path}"
        )));
    }

    let st = state(&app);
    let bytes = file::push(&st.adb, &serial, &source, &remote_path).await?;

    Ok(TransferResult {
        path: android_core::file::normalize_device_path(&remote_path)?,
        bytes,
    })
}

#[tauri::command]
pub async fn file_delete(app: AppHandle, serial: String, path: String) -> CommandResult<()> {
    let st = state(&app);

    // 目录必须显式递归删除，普通删除只处理文件，避免误删整棵目录树
    let is_dir = file::stat(&st.adb, &serial, &path)
        .await?
        .is_some_and(|e| e.is_directory);
    if is_dir {
        file::delete_recursive(&st.adb, &serial, &path)
            .await
            .map_err(Into::into)
    } else {
        file::delete(&st.adb, &serial, &path)
            .await
            .map_err(Into::into)
    }
}

#[tauri::command]
pub async fn file_create_dir(app: AppHandle, serial: String, path: String) -> CommandResult<()> {
    let st = state(&app);
    file::create_dir(&st.adb, &serial, &path)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn file_rename(
    app: AppHandle,
    serial: String,
    from: String,
    to: String,
) -> CommandResult<()> {
    let st = state(&app);
    file::rename(&st.adb, &serial, &from, &to)
        .await
        .map_err(Into::into)
}
