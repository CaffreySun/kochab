//! 截屏与录屏命令。

use tauri::{AppHandle, Emitter};

use android_core::media::{self, Recording, SavedFile};

use crate::commands::{download_dir, ensure_ready};
use crate::error::{CommandError, CommandResult};
use crate::state::state;

/// 录屏状态事件名，与 `@ac/ipc-contract` 的 EVENTS 一字不差。
const EVENTS_RECORDING: &str = "recording://changed";

/// 当前录屏状态；跨窗口、跨入口都以它为准。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatus {
    pub active: bool,
    /// Unix 毫秒；未录制时为 null
    pub started_at: Option<u64>,
    /// 设备端 screenrecord 的时限（秒）
    pub max_seconds: u32,
}

/// 状态变化广播负载。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingChanged {
    pub serial: String,
    pub active: bool,
    pub started_at: Option<u64>,
    pub max_seconds: u32,
}

fn status_of(recording: Option<&Recording>) -> RecordingStatus {
    match recording {
        Some(rec) => RecordingStatus {
            active: true,
            started_at: Some(rec.started_at),
            max_seconds: media::RECORD_MAX_SECONDS,
        },
        None => RecordingStatus {
            active: false,
            started_at: None,
            max_seconds: media::RECORD_MAX_SECONDS,
        },
    }
}

fn emit_status(app: &AppHandle, serial: &str, status: &RecordingStatus) {
    // 广播失败只影响其它窗口的即时刷新；状态查询仍能拿到真实值
    let _ = app.emit(
        EVENTS_RECORDING,
        RecordingChanged {
            serial: serial.to_owned(),
            active: status.active,
            started_at: status.started_at,
            max_seconds: status.max_seconds,
        },
    );
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
pub async fn device_record_start(app: AppHandle, serial: String) -> CommandResult<RecordingStatus> {
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

    let status = status_of(Some(&recording));
    st.recordings.lock().insert(serial.clone(), recording);
    emit_status(&app, &serial, &status);
    Ok(status)
}

/// 查询当前录屏状态。只读内存，不访问设备，设备断开时也能回答。
#[tauri::command]
pub async fn device_record_status(
    app: AppHandle,
    serial: String,
) -> CommandResult<RecordingStatus> {
    let st = state(&app);
    let recordings = st.recordings.lock();
    Ok(status_of(recordings.get(&serial)))
}

/// 停止录屏并保存到系统「下载」目录。
///
/// 幂等：没有进行中的录屏时返回 `None`，而不是报错——多个窗口可能同时到达
/// 180 秒时限并各自调用停止，只有一个真正拉到文件，其余静默结束。
#[tauri::command]
pub async fn device_record_stop(
    app: AppHandle,
    serial: String,
    suggested_name: Option<String>,
) -> CommandResult<Option<SavedFile>> {
    let st = state(&app);
    let Some(recording) = st.recordings.lock().remove(&serial) else {
        let status = status_of(None);
        emit_status(&app, &serial, &status);
        return Ok(None);
    };

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
        Ok(saved) => {
            let status = status_of(None);
            emit_status(&app, &serial, &status);
            Ok(Some(saved))
        }
        Err(err) => {
            // 拉取失败时把句柄放回去：设备恢复后还能重试，而不是只能等时限
            let status = status_of(Some(&recording));
            st.recordings.lock().insert(serial.clone(), recording);
            emit_status(&app, &serial, &status);
            Err(err.into())
        }
    }
}

/// 放弃录屏：清掉状态并尽力删除设备端临时文件，不拉取结果。
#[tauri::command]
pub async fn device_record_cancel(app: AppHandle, serial: String) -> CommandResult<()> {
    let st = state(&app);
    let recording = st.recordings.lock().remove(&serial);
    if let Some(recording) = recording {
        media::cancel_recording(&st.adb, &serial, &recording).await;
    }
    emit_status(&app, &serial, &status_of(None));
    Ok(())
}
