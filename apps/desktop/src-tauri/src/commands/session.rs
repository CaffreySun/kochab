//! 投屏会话命令。
//!
//! 会话是**有状态**的：视频流、控制通道、统计都活在 Tauri 进程里，
//! 前端只拿 `sessionId` 与事件流。因此这里的命令都是一层薄封装：
//! 校验 → 调 `scrcpy-session` → 广播事件。
//!
//! # 视频为什么走事件而不是命令
//!
//! 视频是**推送**的（设备主动发），命令是请求-响应模型，天然不匹配。
//! 每个编码帧经 `session://video` 事件广播一次，payload 用 base64：
//! Tauri 事件负载走 JSON，`Vec<u8>` 会被序列化成数字数组（约 4 倍膨胀），
//! base64 只有 1.33 倍，且前端一次 `atob` 就能拿回字节。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use base64::Engine as _;
use scrcpy_session::SessionOptions;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, WebviewWindow};

use crate::error::{CommandError, CommandResult};
use crate::state::{state, SessionHandle};

/// 事件名，与 `@ac/ipc-contract` 的 `EVENTS` 一字不差。
const EVENTS_META: &str = "session://meta";
const EVENTS_VIDEO: &str = "session://video";
const EVENTS_STATS: &str = "session://stats";
const EVENTS_CLOSED: &str = "session://closed";

/// 会话代次计数器，保证每次启动拿到互不相同的 scid。
static SESSION_GENERATION: AtomicU64 = AtomicU64::new(1);

/// 统计事件的发送间隔。
const STATS_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

/// 视频帧事件负载。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoFramePayload {
    pub session_id: u32,
    /// 单调递增序号，前端据此发现丢帧
    pub sequence: u64,
    /// 展示时间戳（微秒）；config 包为 0
    pub pts_us: u64,
    pub key_frame: bool,
    /// 编码器初始化数据（SPS/PPS）
    pub config: bool,
    /// base64 编码的原始编码数据（Annex-B）
    pub data: String,
}

/// 统计事件负载。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatsPayload {
    pub session_id: u32,
    pub frames: u64,
    pub key_frames: u64,
    pub bytes: u64,
    pub dropped: u64,
    /// 最近一个统计窗口内的帧率
    pub fps: f64,
}

/// 会话结束事件负载。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionClosedPayload {
    pub session_id: u32,
    /// `true` = 用户主动停止；`false` = 视频流意外中断
    pub requested: bool,
    pub reason: Option<String>,
}

/// 启动会话的可选参数。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionStartOptions {
    /// 短边像素上限；0 表示不限制
    pub max_size: Option<u32>,
    pub max_fps: Option<u32>,
    /// Mbps
    pub bit_rate: Option<u32>,
    pub control: Option<bool>,
    pub show_touches: Option<bool>,
    pub stay_awake: Option<bool>,
    /// 占用优先级，越大越优先；同值允许互相接管
    pub priority: Option<u8>,
}

impl SessionStartOptions {
    fn into_session_options(self) -> SessionOptions {
        let mut options = SessionOptions::default();
        if let Some(value) = self.max_size {
            options.max_size = value;
        }
        if let Some(value) = self.max_fps {
            options.max_fps = value;
        }
        if let Some(value) = self.bit_rate {
            options.bit_rate = value;
        }
        if let Some(value) = self.control {
            options.control = value;
        }
        if let Some(value) = self.show_touches {
            options.show_touches = value;
        }
        if let Some(value) = self.stay_awake {
            options.stay_awake = value;
        }
        options
    }
}

/// 触摸动作，取值与 `@ac/ipc-contract` 一致。
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TouchActionPayload {
    Down,
    Move,
    Up,
}

impl From<TouchActionPayload> for scrcpy_protocol::TouchAction {
    fn from(value: TouchActionPayload) -> Self {
        match value {
            TouchActionPayload::Down => Self::Down,
            TouchActionPayload::Move => Self::Move,
            TouchActionPayload::Up => Self::Up,
        }
    }
}

/// 开始投屏。
///
/// 同一台设备同时只允许一条会话；重复调用直接返回已有会话，
/// 这样前端在页面来回切换时不必自己处理竞态。
#[tauri::command]
pub async fn session_start(
    app: AppHandle,
    window: WebviewWindow,
    serial: String,
    session_id: String,
    options: Option<SessionStartOptions>,
) -> CommandResult<scrcpy_session::SessionInfo> {
    let st = state(&app);

    // 优先级先算出来：接管判据要用。
    let priority = options.as_ref().and_then(|o| o.priority).unwrap_or(0);

    // 同一台设备同时只能有一条 scrcpy 会话（设备端 abstract socket 是独占的）。
    //
    // 同一个 sessionId 重复调用必须幂等（React 严格模式下 effect 会跑两次）；
    // 但换一个 sessionId 说明换了消费方（例如从设备列表缩略图切到独立投屏窗口），
    // 这时必须接管而不是复用：
    //
    // 复用会把**旧会话的参数**（分辨率/帧率仍是缩略图那一档）返回给新消费方，
    // 而且 SPS/PPS 只在会话建立时下发一次，后来者永远收不到 config 包，
    // 解码器配置不出来 -> 画面全黑。所以显式让旧会话退位。
    if let Some(existing) = st.session_of(&serial) {
        if existing.owner() == session_id {
            tracing::debug!(serial = %serial, session_id = %session_id, "同一会话重复启动，复用");
            return Ok(existing.info.clone());
        }
        // 优先级低于当前占用者时**不接管**，否则缩略图与投屏窗口会来回抢占。
        if priority < existing.priority() {
            return Err(CommandError::new(
                "device_busy",
                format!(
                    "设备 {serial} 正被占用（{}），请先关闭那个窗口",
                    existing.owner()
                ),
            ));
        }
        tracing::info!(
            serial = %serial,
            old_session_id = existing.info.session_id,
            new_session_id = %session_id,
            "接管该设备上的已有会话"
        );
        st.take_session(existing.info.session_id);
        existing.mark_stopped();
    }

    if session_id.trim().is_empty() {
        return Err(CommandError::invalid_argument("sessionId 不能为空"));
    }

    let device = st
        .cached(&serial)
        .ok_or_else(|| CommandError::not_found(format!("设备 {serial} 不在连接列表中")))?;
    if !device.state.is_ready() {
        return Err(CommandError::new(
            "device_not_ready",
            format!(
                "设备 {serial} 当前状态为 {state}，无法投屏",
                state = device.state
            ),
        ));
    }

    let server_jar = android_core::toolchain::resolve_scrcpy_server_with(&st.resource_dirs(), None)
        .ok_or_else(|| {
            CommandError::new(
                "toolchain_missing",
                "找不到 scrcpy-server，请先运行 pnpm bootstrap 或检查安装",
            )
        })?;

    let factory = scrcpy_session::SessionFactory::new(st.adb.clone(), server_jar);
    let session_options = options.unwrap_or_default().into_session_options();

    // 每次启动都换一个新的 scid。
    //
    // scid 同时决定设备端的 abstract socket 名与 jar 文件名，而**收尾是异步的**：
    // `session_stop` 之后旧会话仍在删 jar、撤隧道。若重启沿用同一个 scid，
    // 旧会话的清理就会把新会话的设备端文件与隧道一并拆掉。
    // 换 scid 之后每次会话只碰自己的资源，重启无需等待旧会话收尾。
    let generation = SESSION_GENERATION.fetch_add(1, Ordering::Relaxed);
    let unique_id = format!("{session_id}#{generation}");

    let mut session = match factory.start(&unique_id, &serial, &session_options).await {
        Ok(session) => session,
        Err(e) => {
            // 失败必须留痕：否则前端只有一个「预览失败」，排查时完全瞎
            tracing::warn!(
                serial = %serial,
                unique_id = %unique_id,
                args = %args_preview(&session_options),
                error = %e,
                "投屏会话建立失败"
            );
            return Err(CommandError::from(e));
        }
    };

    let info = session.info().clone();
    let control = session.control_sender();

    // 顺序有讲究：视频端必须在包进 `Arc` 之前取出（`take_video` 需要 `&mut`），
    // 而控制句柄要先克隆好，否则会出现「视频在跑但控制不可用」的窗口期。
    let video = session.take_video()?;
    let session = Arc::new(session);

    let handle = Arc::new(SessionHandle::new(
        session_id.clone(),
        priority,
        window.label().to_string(),
        info.clone(),
        control,
        Arc::clone(&session),
    ));
    st.insert_session(Arc::clone(&handle));

    app.emit(EVENTS_META, &info)
        .map_err(|e| CommandError::new("emit_failed", format!("广播会话元信息失败：{e}")))?;

    spawn_broadcast(app.clone(), Arc::clone(&handle), video);

    tracing::info!(serial = %serial, session_id = info.session_id, "投屏会话已启动");
    Ok(info)
}

/// 停止会话。幂等：会话不存在时直接成功。
#[tauri::command]
pub async fn session_stop(app: AppHandle, session_id: u32) -> CommandResult<()> {
    let st = state(&app);
    let Some(handle) = st.take_session(session_id) else {
        return Ok(());
    };
    // 只发信号：收尾（删 jar、撤隧道）与 `session://closed` 广播统一由
    // 广播任务负责，避免两条路径重复清理或抢同一个 socket。
    handle.mark_stopped();
    Ok(())
}

/// 列出活跃会话。
#[tauri::command]
pub async fn session_list(app: AppHandle) -> CommandResult<Vec<scrcpy_session::SessionInfo>> {
    Ok(state(&app).session_infos())
}

/// 当前会话统计。
#[tauri::command]
pub async fn session_stats(app: AppHandle, session_id: u32) -> CommandResult<SessionStatsPayload> {
    let handle = session(&app, session_id)?;
    Ok(snapshot(session_id, &handle, 0.0))
}

/// 触摸事件。坐标是**设备像素**，显示坐标到设备坐标的换算在渲染进程完成
/// （`@ac/scrcpy-web` 的 `clientPointToDevice`）。
#[tauri::command]
pub async fn session_touch(
    app: AppHandle,
    session_id: u32,
    action: TouchActionPayload,
    x: i32,
    y: i32,
) -> CommandResult<()> {
    let handle = session(&app, session_id)?;
    let screen = (handle.info.width as u16, handle.info.height as u16);
    handle
        .control
        .touch(action.into(), x, y, screen)
        .await
        .map_err(Into::into)
}

/// 按键事件。
#[tauri::command]
pub async fn session_key(
    app: AppHandle,
    session_id: u32,
    keycode: i32,
    pressed: bool,
) -> CommandResult<()> {
    let handle = session(&app, session_id)?;
    let action = if pressed {
        scrcpy_protocol::KeyAction::Down
    } else {
        scrcpy_protocol::KeyAction::Up
    };
    handle
        .control
        .key(keycode, action)
        .await
        .map_err(Into::into)
}

/// 注入文本。
#[tauri::command]
pub async fn session_text(app: AppHandle, session_id: u32, text: String) -> CommandResult<()> {
    if text.is_empty() {
        return Ok(());
    }
    let handle = session(&app, session_id)?;
    handle.control.text(&text).await.map_err(Into::into)
}

/// 滚轮 / 惯性滑动。
#[tauri::command]
pub async fn session_scroll(
    app: AppHandle,
    session_id: u32,
    x: i32,
    y: i32,
    h_scroll: f32,
    v_scroll: f32,
) -> CommandResult<()> {
    let handle = session(&app, session_id)?;
    let screen = (handle.info.width as u16, handle.info.height as u16);
    handle
        .control
        .scroll(x, y, h_scroll, v_scroll, screen)
        .await
        .map_err(Into::into)
}

/// 把会话参数渲染成一行，便于日志里直接看到「用了什么参数失败」。
fn args_preview(options: &SessionOptions) -> String {
    format!(
        "max_size={} max_fps={} bit_rate={} control={}",
        options.max_size, options.max_fps, options.bit_rate, options.control
    )
}

/// 取会话句柄。
fn session(app: &AppHandle, session_id: u32) -> CommandResult<Arc<SessionHandle>> {
    state(app)
        .session(session_id)
        .ok_or_else(|| CommandError::not_found(format!("会话 {session_id} 不存在或已结束")))
}

fn snapshot(session_id: u32, handle: &SessionHandle, fps: f64) -> SessionStatsPayload {
    SessionStatsPayload {
        session_id,
        frames: handle.counters.frames.load(Ordering::Relaxed),
        key_frames: handle.counters.key_frames.load(Ordering::Relaxed),
        bytes: handle.counters.bytes.load(Ordering::Relaxed),
        dropped: handle.counters.dropped.load(Ordering::Relaxed),
        fps,
    }
}

/// 视频广播任务。
///
/// 独占视频读取端，逐包转 base64 广播；周期性广播统计；视频流结束时收尾，
/// 并广播 `session://closed` 让前端有确定的收尾时机。
fn spawn_broadcast(app: AppHandle, handle: Arc<SessionHandle>, video: tokio::net::TcpStream) {
    tokio::spawn(async move {
        let session_id = handle.info.session_id;
        let mut video = video;
        let mut stop = handle.stop_signal();
        let mut sequence = 0u64;
        let mut failure: Option<String> = None;
        let mut last_tick = std::time::Instant::now();
        let mut last_tick_frames = 0u64;

        loop {
            // `select` 让「停止」能立刻打断阻塞中的读，而不是等下一帧到来
            let packet = tokio::select! {
                biased;
                _ = stop.changed() => break,
                result = scrcpy_session::read_video_packet(&mut video) => result,
            };

            match packet {
                Ok(packet) => {
                    sequence += 1;
                    handle.counters.frames.fetch_add(1, Ordering::Relaxed);

                    let payload = match packet {
                        scrcpy_protocol::VideoPacket::Config { data } => {
                            handle
                                .counters
                                .bytes
                                .fetch_add(data.len() as u64, Ordering::Relaxed);
                            VideoFramePayload {
                                session_id,
                                sequence,
                                pts_us: 0,
                                key_frame: false,
                                config: true,
                                data: base64::engine::general_purpose::STANDARD.encode(&data),
                            }
                        }
                        scrcpy_protocol::VideoPacket::Frame {
                            pts_us,
                            is_key_frame,
                            data,
                        } => {
                            handle
                                .counters
                                .bytes
                                .fetch_add(data.len() as u64, Ordering::Relaxed);
                            if is_key_frame {
                                handle.counters.key_frames.fetch_add(1, Ordering::Relaxed);
                            }
                            VideoFramePayload {
                                session_id,
                                sequence,
                                pts_us,
                                key_frame: is_key_frame,
                                config: false,
                                data: base64::engine::general_purpose::STANDARD.encode(&data),
                            }
                        }
                    };

                    if let Err(e) = app.emit(EVENTS_VIDEO, &payload) {
                        failure = Some(format!("广播视频帧失败：{e}"));
                        break;
                    }

                    if last_tick.elapsed() >= STATS_INTERVAL {
                        let frames = handle.counters.frames.load(Ordering::Relaxed);
                        let fps = frames.saturating_sub(last_tick_frames) as f64
                            / last_tick.elapsed().as_secs_f64();
                        last_tick = std::time::Instant::now();
                        last_tick_frames = frames;
                        let stats = snapshot(session_id, &handle, fps);
                        if let Err(e) = app.emit(EVENTS_STATS, &stats) {
                            tracing::debug!(error = %e, "广播统计事件失败");
                        }
                    }
                }
                Err(e) => {
                    failure = Some(e.to_string());
                    break;
                }
            }
        }

        let requested = handle.is_stopped();
        // 收尾：删设备端 jar、撤反向隧道。`stop` 幂等，用户点停止时也走到这里。
        handle.session.stop().await;
        state(&app).remove_session(session_id);

        let closed = SessionClosedPayload {
            session_id,
            requested,
            reason: failure,
        };
        if let Err(e) = app.emit(EVENTS_CLOSED, &closed) {
            tracing::warn!(error = %e, "广播会话结束事件失败");
        }
        tracing::info!(session_id, requested, "投屏会话已结束");
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 触摸动作映射到协议枚举() {
        assert_eq!(
            scrcpy_protocol::TouchAction::from(TouchActionPayload::Down),
            scrcpy_protocol::TouchAction::Down
        );
        assert_eq!(
            scrcpy_protocol::TouchAction::from(TouchActionPayload::Move),
            scrcpy_protocol::TouchAction::Move
        );
        assert_eq!(
            scrcpy_protocol::TouchAction::from(TouchActionPayload::Up),
            scrcpy_protocol::TouchAction::Up
        );
    }

    #[test]
    fn 缺省启动参数保留默认值() {
        let options = SessionStartOptions::default().into_session_options();
        let defaults = SessionOptions::default();

        assert_eq!(options.max_size, defaults.max_size);
        assert_eq!(options.max_fps, defaults.max_fps);
        assert_eq!(options.bit_rate, defaults.bit_rate);
        assert_eq!(options.control, defaults.control);
        assert_eq!(options.show_touches, defaults.show_touches);
        assert_eq!(options.stay_awake, defaults.stay_awake);
    }

    #[test]
    fn 只覆盖显式给出的启动参数() {
        let options = SessionStartOptions {
            max_size: Some(720),
            max_fps: Some(15),
            bit_rate: Some(2),
            control: Some(false),
            show_touches: Some(false),
            stay_awake: Some(false),
            priority: Some(10),
        }
        .into_session_options();

        assert_eq!(options.max_size, 720);
        assert_eq!(options.max_fps, 15);
        assert_eq!(options.bit_rate, 2);
        assert!(!options.control);
        assert!(!options.show_touches);
        assert!(!options.stay_awake);
    }

    /// 事件负载的字段名是前端契约：改一个字母前端就静默拿到 undefined。
    #[test]
    fn 视频帧负载字段名与前端契约一致() {
        let payload = VideoFramePayload {
            session_id: 7,
            sequence: 42,
            pts_us: 1_000,
            key_frame: true,
            config: false,
            data: "AAAA".into(),
        };
        let json = serde_json::to_value(&payload).expect("序列化失败");

        let mut keys: Vec<&str> = json
            .as_object()
            .expect("应为对象")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "config",
                "data",
                "keyFrame",
                "ptsUs",
                "sequence",
                "sessionId"
            ]
        );
        assert_eq!(json["sessionId"], 7);
        assert_eq!(json["keyFrame"], true);
    }

    #[test]
    fn 统计负载字段名与前端契约一致() {
        let payload = SessionStatsPayload {
            session_id: 7,
            frames: 10,
            key_frames: 1,
            bytes: 2048,
            dropped: 0,
            fps: 29.97,
        };
        let json = serde_json::to_value(&payload).expect("序列化失败");

        let mut keys: Vec<&str> = json
            .as_object()
            .expect("应为对象")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "bytes",
                "dropped",
                "fps",
                "frames",
                "keyFrames",
                "sessionId"
            ]
        );
    }

    #[test]
    fn 会话结束负载字段名与前端契约一致() {
        let payload = SessionClosedPayload {
            session_id: 7,
            requested: false,
            reason: Some("设备已断开".into()),
        };
        let json = serde_json::to_value(&payload).expect("序列化失败");

        let mut keys: Vec<&str> = json
            .as_object()
            .expect("应为对象")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, ["reason", "requested", "sessionId"]);
    }

    #[test]
    fn 事件名与前端注册表一致() {
        let contract = include_str!("../../../../../packages/ipc-contract/src/events.ts");
        for name in [EVENTS_META, EVENTS_VIDEO, EVENTS_STATS, EVENTS_CLOSED] {
            assert!(
                contract.contains(name),
                "事件 {name} 未登记在 @ac/ipc-contract"
            );
        }
    }
}
