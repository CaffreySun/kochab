//! 截屏与录屏命令。

use tauri::AppHandle;

use android_core::media::{self, Recording, SavedFile};

use crate::commands::{download_dir, ensure_ready};
use crate::error::{CommandError, CommandResult};
use crate::state::state;

/// 录屏启动结果。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordStarted {
    /// 设备端 `screenrecord --time-limit` 的上限（秒）
    pub max_seconds: u32,
}

/// 截屏并保存到系统「下载」目录。
#[tauri::command]
pub async fn device_screenshot(
    app: AppHandle,
    serial: String,
    suggested_name: Option<String>,
) -> CommandResult<SavedFile> {
    ensure_ready(&app, &serial).await?;
    let dir = download_dir(&app)?;
    let st = state(&app);
    media::screenshot(&st.adb, &serial, &dir, suggested_name.as_deref())
        .await
        .map_err(Into::into)
}

/// 开始录屏。同一台设备已有录屏时拒绝，避免设备上留下无人认领的进程。
#[tauri::command]
pub async fn device_record_start(app: AppHandle, serial: String) -> CommandResult<RecordStarted> {
    ensure_ready(&app, &serial).await?;
    let st = state(&app);

    {
        let recordings = st.recordings.lock();
        if recordings.contains_key(&serial) {
            return Err(CommandError::new(
                "already_recording",
                format!("设备 {serial} 已经在录屏，请先停止当前录屏"),
            ));
        }
    }

    let recording: Recording = media::start_recording(&st.adb, &serial)
        .await
        .map_err(CommandError::from)?;

    st.recordings.lock().insert(serial, recording);
    Ok(RecordStarted {
        max_seconds: media::RECORD_MAX_SECONDS,
    })
}

/// 停止录屏并保存到系统「下载」目录。
#[tauri::command]
pub async fn device_record_stop(
    app: AppHandle,
    serial: String,
    suggested_name: Option<String>,
) -> CommandResult<SavedFile> {
    let st = state(&app);
    let recording = st.recordings.lock().remove(&serial).ok_or_else(|| {
        CommandError::new("not_recording", format!("设备 {serial} 没有正在进行的录屏"))
    })?;

    let dir = download_dir(&app)?;
    match media::stop_recording(
        &st.adb,
        &serial,
        &recording,
        &dir,
        suggested_name.as_deref(),
    )
    .await
    {
        Ok(saved) => Ok(saved),
        Err(err) => {
            // 拉取失败时把句柄放回去：用户还可以重试，而不是只能等 180 秒时限
            st.recordings.lock().insert(serial, recording);
            Err(err.into())
        }
    }
}
