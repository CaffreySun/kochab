//! 设备相关命令。

use android_core::{device, DeviceInfo};
use futures_util::stream::{self, StreamExt};
use tauri::AppHandle;

use crate::error::{CommandError, CommandResult};
use crate::state::state;

/// 同时采集属性时的最大并发，避免把设备 shell 队列打满。
const PROBE_CONCURRENCY: usize = 4;

/// 列出全部设备并补齐详细信息。
///
/// 未就绪的设备只返回基础信息（序列号 + 状态），不做任何设备端调用。
#[tauri::command]
pub async fn device_list(app: AppHandle) -> CommandResult<Vec<DeviceInfo>> {
    let st = state(&app);

    let entries = st.adb.devices().await?;
    let client = st.adb.clone();

    let results: Vec<DeviceInfo> = stream::iter(entries.into_iter().map(|entry| {
        let client = client.clone();
        async move {
            match device::collect(&client, &entry.serial, entry.state).await {
                Ok(info) => info,
                Err(e) => {
                    // 属性采集失败不应让设备从列表里消失，退回基础信息即可
                    tracing::debug!(serial = %entry.serial, "采集属性失败：{e}");
                    DeviceInfo {
                        serial: entry.serial.clone(),
                        state: device::map_state(entry.state),
                        is_emulator: device::detect_transport(&entry.serial)
                            == android_core::DeviceTransport::Emulator,
                        model: None,
                        manufacturer: None,
                        brand: None,
                        device: None,
                        android_version: None,
                        sdk_int: None,
                        screen_resolution: None,
                        transport: device::detect_transport(&entry.serial),
                    }
                }
            }
        }
    }))
    .buffer_unordered(PROBE_CONCURRENCY)
    .collect()
    .await;

    for info in &results {
        st.cache(info.clone());
    }

    Ok(results)
}

/// 单台设备的详细信息。
#[tauri::command]
pub async fn device_info(app: AppHandle, serial: String) -> CommandResult<DeviceInfo> {
    let st = state(&app);

    let entries = st.adb.devices().await?;
    let entry = entries
        .into_iter()
        .find(|e| e.serial == serial)
        .ok_or_else(|| CommandError::not_found(format!("设备 {serial} 不在连接列表中")))?;

    let info = device::collect(&st.adb, &serial, entry.state).await?;
    st.cache(info.clone());
    Ok(info)
}

/// 连接无线设备（`host:connect`）。
#[tauri::command]
pub async fn device_connect_wireless(app: AppHandle, address: String) -> CommandResult<String> {
    let st = state(&app);
    let message = st.adb.connect_device(&address).await?;

    if message.to_lowercase().contains("unable to connect") {
        return Err(CommandError::unavailable(format!(
            "连接 {address} 失败：{message}"
        )));
    }
    Ok(message)
}

/// 断开无线设备。
#[tauri::command]
pub async fn device_disconnect(app: AppHandle, serial: String) -> CommandResult<String> {
    let st = state(&app);
    Ok(st.adb.disconnect_device(&serial).await?)
}

/// 设备概览：电量 / 存储 / 内存 / 网络 / 系统。
///
/// 只对已就绪设备有意义；未就绪时直接拒绝，不做无谓的设备端调用。
#[tauri::command]
pub async fn device_overview(
    app: AppHandle,
    serial: String,
) -> CommandResult<android_core::DeviceOverview> {
    let st = state(&app);

    let entries = st.adb.devices().await?;
    let entry = entries
        .into_iter()
        .find(|e| e.serial == serial)
        .ok_or_else(|| CommandError::not_found(format!("设备 {serial} 不在连接列表中")))?;
    if !entry.state.is_ready() {
        return Err(CommandError::new(
            "device_not_ready",
            format!("设备 {serial} 当前状态为 {}，无法读取概览", entry.state),
        ));
    }

    Ok(android_core::overview::collect(&st.adb, &serial).await?)
}
