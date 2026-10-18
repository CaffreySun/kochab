//! 设备变更监听。
//!
//! adb server 的 `host:track-devices` 是推送式的：设备一插上拔下，
//! 服务端立刻推一条记录。用它替代前端轮询，设备状态变化才是即时的。
//!
//! 追踪需要**独占**一条 adb 连接（推送是持续的），因此这里单独 `connect()` 一个客户端，
//! 不能复用命令层那条被互斥锁保护的连接。

use std::time::Duration;

use adb_client::AdbClient;
use android_core::{device, DeviceInfo};
use tauri::{AppHandle, Emitter};
use tracing::{debug, info, warn};

use crate::state::state;

/// 事件名，必须与 `@kochab/ipc-contract` 的 `EVENTS.deviceChanged` 一致。
const EVENT_DEVICE_CHANGED: &str = "device://changed";
const EVENT_ADB_SERVER_LOST: &str = "adb://server-lost";

/// 断开后重连的等待时间。
const RETRY_DELAY: Duration = Duration::from_secs(3);

/// 启动设备监听任务。
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let client = match AdbClient::connect() {
            Ok(client) => client,
            Err(e) => {
                let _ = app.emit(EVENT_ADB_SERVER_LOST, e.to_string());
                return;
            }
        };

        loop {
            info!("设备监听已启动");
            if let Err(e) = watch(app.clone(), client.clone()).await {
                warn!("设备监听中断：{e}");
                let _ = app.emit(EVENT_ADB_SERVER_LOST, e.to_string());
            }

            tokio::time::sleep(RETRY_DELAY).await;
        }
    });
}

async fn watch(app: AppHandle, client: AdbClient) -> Result<(), adb_client::AdbError> {
    let mut tracker = client.track_devices().await?;

    // 启动时先推一次完整列表，保证前端无需自己轮询
    publish_current(&app).await;

    while let Some(change) = tracker.next().await? {
        match change.serial.as_str() {
            // 空 serial 表示「所有设备都消失了」
            "" => {
                state(&app).devices.write().clear();
                let _ = app.emit(EVENT_DEVICE_CHANGED, Vec::<DeviceInfo>::new());
            }
            _ => {
                debug!(serial = %change.serial, state = %change.state, "设备变化");
                refresh_one(&app, &change.serial).await;
            }
        }
    }

    Err(adb_client::AdbError::ServerRejected {
        message: "设备推送流已结束".into(),
    })
}

async fn publish_current(app: &AppHandle) {
    let st = state(app);
    match st.adb.devices().await {
        Ok(entries) => {
            let infos: Vec<DeviceInfo> = entries
                .iter()
                .map(|entry| {
                    st.cached(&entry.serial).unwrap_or_else(|| DeviceInfo {
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
                    })
                })
                .collect();
            let _ = app.emit(EVENT_DEVICE_CHANGED, infos);
        }
        Err(e) => warn!("读取设备列表失败：{e}"),
    }
}

/// 设备变化后只刷新受影响的那一台，避免全量重查。
async fn refresh_one(app: &AppHandle, serial: &str) {
    let st = state(app);

    let entries = match st.adb.devices().await {
        Ok(entries) => entries,
        Err(e) => {
            warn!("刷新设备 {serial} 失败：{e}");
            publish_current(app).await;
            return;
        }
    };

    let Some(entry) = entries.into_iter().find(|e| e.serial == serial) else {
        st.forget(serial);
        publish_current(app).await;
        return;
    };

    match device::collect(&st.adb, serial, entry.state).await {
        Ok(info) => st.cache(info),
        Err(e) => debug!("采集 {serial} 属性失败：{e}"),
    }

    publish_current(app).await;
}
