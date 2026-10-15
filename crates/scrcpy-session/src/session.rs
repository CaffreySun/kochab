//! 投屏会话编排。
//!
//! 把「一台已连接设备」变成「一条可交互的投屏会话」：
//! 推送 server → 端口转发 → 拉起设备端进程 → 读视频流 / 写控制消息。
//!
//! 协议细节全部在 [`scrcpy_protocol`]，本 crate 只负责**编排与生命周期**。
//!
//! # 为什么客户端「不握手」
//!
//! scrcpy 4.1 的握手是**单向**的：服务端 accept 后立刻下发
//! dummy byte + 64 字节设备名，客户端一个字节都不用发。
//! 控制通道则连这两样都没有，accept 完就开始读控制消息。
//! 详见 [`scrcpy_protocol::stream`]。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use adb_client::AdbClient;
use scrcpy_protocol::stream::{
    ParseError, DEVICE_NAME_FIELD_LENGTH, PACKET_HEADER_LENGTH, SESSION_META_LENGTH,
};
use scrcpy_protocol::{
    Codec, KeyAction, KeyEvent, ScrollEvent, TouchAction, TouchEvent, VideoPacket,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::error::{Result, SessionError};

/// 设备端 server jar 的落地路径。
///
/// `/data/local/tmp` 在 Android 8 之后对普通应用不可写，但 `adb shell`
/// 以 shell 用户运行，因此这个路径可用（scrcpy 官方也是这么做的）。
///
/// 路径里带 scid：会话收尾时会 `rm` 掉自己那份 jar，共用同一个文件名
/// 会让并发/连续会话互相删掉对方正在用的 jar（表现为莫名的
/// `ClassNotFoundException`）。
pub fn remote_server_path(scid: u32) -> String {
    format!("/data/local/tmp/scrcpy-server-{scid:08x}.jar")
}

/// `Streamer.writeVideoHeader()` 写出的 codec id 长度。
const CODEC_ID_LENGTH: usize = 4;

/// 等待设备端 server 开始监听的超时。
const SERVER_STARTUP_TIMEOUT: Duration = Duration::from_secs(10);

/// 等待服务端握手/流元信息的超时。
///
/// 服务端 accept 之后若在建编码器或虚拟显示时卡住（部分 ROM 会），
/// 客户端必须能自己超时退出，而不是无限等待。
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(8);

/// 连接视频 socket 时的重试间隔。
const CONNECT_RETRY_INTERVAL: Duration = Duration::from_millis(60);

/// 视频包队列深度。太小会阻塞读 socket，太大会让交互变得迟钝。
const VIDEO_QUEUE_DEPTH: usize = 8;

/// 建立 scrcpy 会话所需的参数。
#[derive(Debug, Clone)]
pub struct SessionOptions {
    /// max_size：短边像素上限，0 表示不限（不下发该参数）。
    pub max_size: u32,
    /// `max_fps`，0 表示不限。
    pub max_fps: u32,
    /// `bit_rate`，单位 Mbps（下发前换算成服务端要的 bit/s）。
    pub bit_rate: u32,
    /// `video=true`，关掉就只剩音频/控制，本项目不支持。
    pub video: bool,
    /// `audio=false`，本项目第一版不做音频。
    pub audio: bool,
    /// `control=true`，关掉就是只读投屏。
    pub control: bool,
    /// `show_touches`
    pub show_touches: bool,
    /// `stay_awake`
    pub stay_awake: bool,
    /// `power_off_on_close`
    pub power_off_on_close: bool,
    /// `video_codec`
    pub codec: Codec,
}

impl Default for SessionOptions {
    fn default() -> Self {
        Self {
            max_size: 1080,
            max_fps: 30,
            bit_rate: 8,
            video: true,
            audio: false,
            control: true,
            show_touches: true,
            stay_awake: true,
            power_off_on_close: false,
            codec: Codec::H264,
        }
    }
}

impl SessionOptions {
    /// 生成 `app_process` 的 `args[1..]`。
    ///
    /// 服务端约定：`args[0]` 是本协议版本号，其余**全部**是 `key=value`
    /// （见 `Options.parse`）。没有任何布尔选项默认开启——服务端里
    /// `audio` / `control` / `video` 的默认值都是 `false`，
    /// 所以必须显式写出。
    ///
    /// `scid` 与 `tunnel_forward` 由 [`SessionFactory`] 填，不来自用户选项。
    pub fn server_args(&self, scid: u32) -> Vec<String> {
        let mut args = vec![
            format!("scid={scid:08x}"),
            // false = 服务端主动 connect 到设备侧的 localabstract socket；
            // 本机必须先用 adb reverse 把该 socket 接回自己的监听端口。
            // 反过来（true = 服务端 listen）在 adb 1.0.41 上会卡在第二次 accept。
            "tunnel_forward=false".to_owned(),
            format!("video={}", self.video),
            format!("audio={}", self.audio),
            format!("control={}", self.control),
            // 本客户端要读设备名做 UI 展示
            "send_device_meta=true".to_owned(),
            // 必须开：codec id 与首帧尺寸只在这里下发，
            // 关掉的话渲染端拿不到分辨率就没法建解码器、也没法算触摸坐标。
            "send_stream_meta=true".to_owned(),
            "send_frame_meta=true".to_owned(),
            // 不下发 cleanup=true：那会让服务端退出时 unlink 掉 jar，
            // 下一次会话直接 ClassNotFoundException。我们自己负责清理。
            format!("video_codec={}", self.codec.server_option()),
        ];

        if self.max_size > 0 {
            args.push(format!("max_size={}", self.max_size));
        }
        args.push(format!("max_fps={}", self.max_fps));
        // 服务端要的是 bit/s，不是 Mbps：写成 8000 会被当成 8 kbps
        args.push(format!("video_bit_rate={}", self.bit_rate * 1_000_000));
        args.push(format!("show_touches={}", self.show_touches));
        args.push(format!("stay_awake={}", self.stay_awake));
        args.push(format!("power_off_on_close={}", self.power_off_on_close));
        args
    }
}

/// 会话建立成功后交给上层的描述信息。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    /// 会话标识，同时用作 scid。
    pub session_id: u32,
    /// 设备序列号
    pub serial: String,
    /// 本机转发端口
    pub local_port: u16,
    /// 设备端监听的本地 socket
    pub device_socket: String,
    /// 设备名（服务端握手下发的 64 字节字段）
    pub device_name: String,
    /// 视频尺寸
    pub width: u32,
    pub height: u32,
    /// 编码格式
    pub codec: Codec,
}

/// 控制通道句柄。
///
/// 可以**克隆**，并且在视频泵后台读帧的同时并发使用——
/// 这正是交互场景需要的：一边收画面，一边注入触摸。
///
/// 写入用 `Mutex` 串行化，避免两条控制消息的字节交错。
#[derive(Clone)]
pub struct ControlSender {
    control: Arc<tokio::sync::Mutex<tokio::net::TcpStream>>,
}

impl ControlSender {
    /// 原样写一条已经编码好的控制消息。
    pub async fn send(&self, bytes: &[u8]) -> Result<()> {
        let mut control = self.control.lock().await;
        control.write_all(bytes).await?;
        control.flush().await?;
        Ok(())
    }

    /// 注入一次触摸（坐标为**设备像素**）。
    async fn touch_at(
        &self,
        action: TouchAction,
        x: i32,
        y: i32,
        screen: (u16, u16),
    ) -> Result<()> {
        let pressed = matches!(action, TouchAction::Down | TouchAction::Move);
        let event = TouchEvent {
            action,
            pointer_id: 0,
            x: x.clamp(0, i32::from(screen.0) - 1),
            y: y.clamp(0, i32::from(screen.1) - 1),
            screen_width: screen.0,
            screen_height: screen.1,
            // pressure 是 0..=1 的浮点；按下给满，抬起必须给 0，
            // 否则 Android 会把它当成一次悬停拖拽
            pressure: if pressed { 1.0 } else { 0.0 },
            buttons: if pressed { 1 } else { 0 },
        };
        self.send(&scrcpy_protocol::encode_touch(&event)).await
    }

    /// 触摸事件（以**设备像素**为坐标系）。
    pub async fn touch(
        &self,
        action: TouchAction,
        x: i32,
        y: i32,
        screen: (u16, u16),
    ) -> Result<()> {
        self.touch_at(action, x, y, screen).await
    }

    /// 按键按下 / 抬起。
    pub async fn key(&self, keycode: i32, action: KeyAction) -> Result<()> {
        let event = KeyEvent {
            action,
            keycode,
            repeat: 0,
            metastate: 0,
        };
        self.send(&scrcpy_protocol::encode_key(&event)).await
    }

    /// 注入文本。
    pub async fn text(&self, value: &str) -> Result<()> {
        self.send(&scrcpy_protocol::encode_text(value)).await
    }

    /// 滚轮 / 惯性滑动。
    pub async fn scroll(&self, x: i32, y: i32, h: f32, v: f32, screen: (u16, u16)) -> Result<()> {
        let event = ScrollEvent {
            x: x.clamp(0, i32::from(screen.0) - 1),
            y: y.clamp(0, i32::from(screen.1) - 1),
            screen_width: screen.0,
            screen_height: screen.1,
            h_scroll: h.clamp(-16.0, 16.0),
            v_scroll: v.clamp(-16.0, 16.0),
        };
        self.send(&scrcpy_protocol::encode_scroll(&event)).await
    }
}

/// 一条已建立的投屏会话。
///
/// 视频与控制是**两条独立的 TCP 连接**：
///
/// - 视频：服务端单向下发，交给 [`ScrcpySession::take_video`] 取走的读取端；
/// - 控制：客户端单向写入，通过 [`ScrcpySession::control_sender`] 克隆句柄使用。
///
/// 视频端只能被**一个**读者独占，否则两条任务抢同一个 socket 会让帧错乱；
/// 控制端则可以随意克隆、并发写。把这两件事在类型上分开，
/// 是为了让「投屏 + 交互」这个最常见的用法不需要调用方自己加锁。
pub struct ScrcpySession {
    info: SessionInfo,
    /// 被 `take_video` 取走后就空了
    video: Option<tokio::net::TcpStream>,
    control: Arc<tokio::sync::Mutex<tokio::net::TcpStream>>,
    client: AdbClient,
    /// server jar 的设备端路径，收尾时要删
    remote_path: PathBuf,
    stopped: AtomicBool,
}

impl ScrcpySession {
    /// 会话元信息。
    pub fn info(&self) -> &SessionInfo {
        &self.info
    }

    /// 设备像素尺寸，交互坐标换算用。
    pub fn screen_size(&self) -> (u16, u16) {
        (self.info.width as u16, self.info.height as u16)
    }

    /// 取一个控制通道句柄（可克隆、可并发）。
    pub fn control_sender(&self) -> ControlSender {
        ControlSender {
            control: Arc::clone(&self.control),
        }
    }

    /// 取出视频读取端。
    ///
    /// 只能取一次；取走后本会话仍可继续用于控制与收尾。
    pub fn take_video(&mut self) -> Result<tokio::net::TcpStream> {
        self.video.take().ok_or(SessionError::VideoStreamClosed)
    }

    /// 启动后台视频泵，返回 `(元信息, 视频包接收端)`。
    ///
    /// 泵会在视频流结束时**自动收尾**：删设备端 jar、撤反向隧道。
    /// 调用方只需要在通道关闭时结束自己的循环。
    ///
    /// 需要同时交互时，先 [`control_sender`](Self::control_sender) 克隆一份句柄，
    /// 再调用本方法。
    pub async fn pump_video(mut self) -> Result<(SessionInfo, mpsc::Receiver<VideoPacket>)> {
        let video = self.take_video()?;
        let info = self.info.clone();
        let (tx, rx) = mpsc::channel(VIDEO_QUEUE_DEPTH);

        tokio::spawn(async move {
            let mut video = video;
            while let Ok(packet) = read_video_packet(&mut video).await {
                // 渲染端跟不上时靠通道背压自然限速
                if tx.send(packet).await.is_err() {
                    break;
                }
            }
            tracing::debug!("视频流结束");
            self.shutdown().await;
        });

        Ok((info, rx))
    }

    /// 读取下一个视频包。仅在**没有**调用 `pump_video` 时可用。
    pub async fn next_video_packet(&mut self) -> Result<VideoPacket> {
        let stream = self.video.as_mut().ok_or(SessionError::VideoStreamClosed)?;
        read_video_packet(stream).await
    }

    /// 写一条控制消息。
    pub async fn send_control(&self, bytes: &[u8]) -> Result<()> {
        self.control_sender().send(bytes).await
    }

    /// 注入一次触摸（调用方坐标为**显示尺寸**，这里换算成设备像素）。
    pub async fn touch(&self, x: i32, y: i32, pressed: bool, display: (u16, u16)) -> Result<()> {
        let device = self.screen_size();
        let action = if pressed {
            TouchAction::Down
        } else {
            TouchAction::Up
        };
        self.control_sender()
            .touch(
                action,
                scale_axis(x, display.0, device.0),
                scale_axis(y, display.1, device.1),
                device,
            )
            .await
    }

    /// 注入一次按键。
    pub async fn key(&self, keycode: i32, pressed: bool) -> Result<()> {
        let action = if pressed {
            KeyAction::Down
        } else {
            KeyAction::Up
        };
        self.control_sender().key(keycode, action).await
    }

    /// 注入文本。
    pub async fn text(&self, value: &str) -> Result<()> {
        self.control_sender().text(value).await
    }

    /// 结束会话：删掉设备端 jar、撤掉反向隧道。
    ///
    /// 逐个吞掉错误——关闭路径不应该因为清理失败而 panic 或卡住。
    pub async fn stop(&self) {
        self.shutdown().await;
    }

    /// 收尾清理，幂等。
    async fn shutdown(&self) {
        // `swap` 保证并发调用也只清理一次
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }

        if let Err(e) = self
            .client
            .shell(
                &self.info.serial,
                &format!("rm -f {}", self.remote_path.display()),
            )
            .await
        {
            tracing::warn!(error = %e, "删除设备端 server 失败");
        }
        // 我们建的是**反向**隧道，所以也必须按反向撤销；
        // 调 remove_forward 会留下一条不会被回收的 adb reverse 条目。
        if let Err(e) = self
            .client
            .remove_reverse(&self.info.serial, &self.info.device_socket)
            .await
        {
            tracing::debug!(error = %e, "移除反向隧道失败");
        }
    }

    pub(crate) fn new(
        info: SessionInfo,
        video: tokio::net::TcpStream,
        control: tokio::net::TcpStream,
        client: AdbClient,
        remote_path: PathBuf,
    ) -> Self {
        Self {
            info,
            video: Some(video),
            control: Arc::new(tokio::sync::Mutex::new(control)),
            client,
            remote_path,
            stopped: AtomicBool::new(false),
        }
    }
}

/// 按比例把显示坐标映射到设备坐标，并夹到有效范围内。
fn scale_axis(value: i32, from: u16, to: u16) -> i32 {
    if from == 0 || to == 0 {
        return 0;
    }
    let scaled = (i64::from(value) * i64::from(to) / i64::from(from)) as i32;
    scaled.clamp(0, i32::from(to) - 1)
}

/// 从视频 socket 读一个完整包（12 字节帧头 + payload）。
pub async fn read_video_packet(stream: &mut tokio::net::TcpStream) -> Result<VideoPacket> {
    let mut header = [0u8; PACKET_HEADER_LENGTH];
    read_exact(stream, &mut header).await?;

    // 帧头最后 4 字节是 payload 长度，必须先取出来才知道还要读多少
    let size = i32::from_be_bytes([header[8], header[9], header[10], header[11]]);
    if size < 0 {
        return Err(SessionError::Parse(ParseError::NegativeSize(size)));
    }

    let mut raw = vec![0u8; PACKET_HEADER_LENGTH + size as usize];
    raw[..PACKET_HEADER_LENGTH].copy_from_slice(&header);
    read_exact(stream, &mut raw[PACKET_HEADER_LENGTH..]).await?;

    Ok(scrcpy_protocol::parse_video_packet(&raw)?)
}
/// 建立会话的工厂。
///
/// 之所以是工厂而不是构造函数：端口转发、设备 socket 名、scid
/// 都要在调用时才确定，测试也需要能注入替身。
pub struct SessionFactory {
    client: AdbClient,
    server_jar: PathBuf,
}

impl SessionFactory {
    pub fn new(client: AdbClient, server_jar: impl Into<PathBuf>) -> Self {
        Self {
            client,
            server_jar: server_jar.into(),
        }
    }

    /// 完整建立一条会话。
    ///
    /// `session_id` 由调用方决定而不是内部生成：上层（Tauri）需要把用户可见的
    /// 会话标识与 scid 对齐，同一个 id 停止后可以再次启动。
    pub async fn start(
        &self,
        session_id: &str,
        serial: &str,
        options: &SessionOptions,
    ) -> Result<ScrcpySession> {
        let scid = scid_from(session_id);
        let device_socket = device_socket(scid);
        let remote_path = remote_server_path(scid);

        self.push_server(serial, &remote_path).await?;
        tracing::debug!(%serial, %remote_path, "server 已推送");

        // 反向隧道 = 设备侧监听、本机监听端承接。必须**先**在本机 bind
        // 再建 reverse，否则服务端一连回来就会 Connection refused。
        let listener = bind_local().await?;
        let local_port = listener.local_addr()?.port();
        self.reverse(serial, &device_socket, local_port).await?;
        tracing::debug!(local_port, %device_socket, "反向隧道已建立");

        let args = options.server_args(scid);
        tracing::debug!(args = %args.join(" "), "启动设备端 server");
        self.spawn_server(serial, &remote_path, &args).await?;

        // 服务端按 video → audio → control 的顺序连出（audio 已关）。
        // 握手与流元信息都带超时：个别 ROM 会在建编码器/虚拟显示时静默卡住，
        // 不设超时调用方会永远等下去。
        let (mut video, control) = tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
            let (video, _) = listener.accept().await?;
            tracing::debug!("视频连接已接入");
            let (control, _) = listener.accept().await?;
            tracing::debug!("控制连接已接入");
            Ok::<_, std::io::Error>((video, control))
        })
        .await
        .map_err(|_| SessionError::HandshakeTimeout(HANDSHAKE_TIMEOUT.as_millis() as u64))??;

        // 反向拓扑下服务端是 connect 方，不发 dummy byte，流直接从设备名开始
        let device_name = tokio::time::timeout(HANDSHAKE_TIMEOUT, read_device_name(&mut video))
            .await
            .map_err(|_| SessionError::HandshakeTimeout(HANDSHAKE_TIMEOUT.as_millis() as u64))??;
        tracing::debug!(%device_name, "读到设备名");

        // codec id 与首帧尺寸在流最前面，必须在返回之前拿到：
        // 渲染端要靠它建解码器、算触摸坐标，不能推到后台任务里。
        let (codec, width, height) =
            tokio::time::timeout(HANDSHAKE_TIMEOUT, read_stream_meta(&mut video))
                .await
                .map_err(|_| {
                    SessionError::HandshakeTimeout(HANDSHAKE_TIMEOUT.as_millis() as u64)
                })??;
        tracing::debug!(?codec, width, height, "读到流元信息");

        let info = SessionInfo {
            session_id: scid,
            serial: serial.to_owned(),
            local_port,
            device_socket,
            device_name,
            width,
            height,
            // 以服务端实际选中的编码器为准，而不是请求的那个：设备可能不支持会静默回退
            codec,
        };

        // 控制通道没有握手，但必须关掉 Nagle，否则每次点击都要等一个 RTT
        let _ = control.set_nodelay(true);

        Ok(ScrcpySession::new(
            info,
            video,
            control,
            self.client.clone(),
            PathBuf::from(remote_server_path(scid)),
        ))
    }

    /// 把 server jar 推到设备。
    async fn push_server(&self, serial: &str, remote_path: &str) -> Result<()> {
        android_core::file::push(&self.client, serial, &self.server_jar, remote_path)
            .await
            .map(|_| ())
            .map_err(|e| SessionError::PushFailed {
                path: self.server_jar.clone(),
                reason: e.to_string(),
            })
    }

    /// 建立反向隧道：设备侧 `localabstract:scrcpy_<scid>` ← 本机 `tcp:<port>`。
    ///
    /// 先让内核分配一个空闲端口再 bind，这样几乎不会撞上别的进程；
    /// 万一撞上（内核分配与 bind 之间存在竞态）就换一个端口重来。
    async fn reverse(&self, serial: &str, device_socket: &str, port: u16) -> Result<()> {
        for _ in 0..5 {
            match self
                .client
                .reverse(serial, device_socket, &format!("tcp:{port}"))
                .await
            {
                Ok(()) => return Ok(()),
                Err(e) => {
                    tracing::debug!(%e, port, "反向隧道建立被拒，重试");
                    let _ = self.client.remove_reverse(serial, device_socket).await;
                    tokio::time::sleep(CONNECT_RETRY_INTERVAL).await;
                }
            }
        }
        Err(SessionError::ForwardFailed(
            "连续 5 次无法建立反向隧道".to_owned(),
        ))
    }

    /// 拉起设备端 server。
    ///
    /// 用 `app_process` 直接跑 jar，无需 root（jar 是以 shell 用户写下的）。
    /// 关键点：`CLASSPATH` 指向 jar，`app_process` 后面的类名是 server 的入口。
    ///
    /// **必须 `setsid` 并重定向标准流**：服务端要以「后台常驻」的方式活着，
    /// 而它继承的是 `adb shell` 的会话。普通 `cmd &` 会在 shell 退出
    /// （也就是我们读完返回值关掉连接）时收到 SIGHUP 被杀掉——
    /// 表现为隧道建好了、却没有任何连接进来，最后握手超时。
    /// `setsid` 另起会话 + `</dev/null` 断开 stdin，服务端才能真正脱离。
    async fn spawn_server(&self, serial: &str, remote_path: &str, args: &[String]) -> Result<()> {
        // 类名之后第一个参数**必须是协议版本**，`args[0]` 不是 key=value 而是版本号；
        // 漏掉它服务端会把 `scid=…` 当成版本号，解析失败后立刻退出。
        let cmd = format!(
            "CLASSPATH={remote_path} setsid app_process /system/bin \
             com.genymobile.scrcpy.Server {} {} </dev/null >/dev/null 2>&1 &",
            scrcpy_protocol::SUPPORTED_VERSION,
            args.join(" ")
        );

        let deadline = std::time::Instant::now() + SERVER_STARTUP_TIMEOUT;
        loop {
            tracing::debug!(cmd = %cmd, "执行启动命令");
            match self.client.shell(serial, &cmd).await {
                Ok(out) => {
                    tracing::debug!(exit = out.exit_code, stdout = %out.stdout, "启动命令返回");
                    if out.success() {
                        return Ok(());
                    }
                    if std::time::Instant::now() >= deadline {
                        return Err(SessionError::ServerStartupTimeout(
                            SERVER_STARTUP_TIMEOUT.as_millis() as u64,
                        ));
                    }
                    tokio::time::sleep(CONNECT_RETRY_INTERVAL).await;
                }
                Err(e) => {
                    tracing::debug!(error = %e, "启动命令发送失败");
                    return Err(SessionError::Adb(e));
                }
            }
        }
    }
}

/// 读 `send_stream_meta=true` 时下发的流元信息：4 字节 codec id + 12 字节会话尺寸。
///
/// 这两段是 `Streamer.writeVideoHeader()` 与 `Streamer.writeSessionMeta()`
/// 连续写出的**裸字节**，没有 12 字节帧头——所以不能当成一个视频包来解析。
///
/// 返回 `(编码格式, 宽, 高)`。
pub async fn read_stream_meta(video: &mut tokio::net::TcpStream) -> Result<(Codec, u32, u32)> {
    let mut buf = [0u8; CODEC_ID_LENGTH + SESSION_META_LENGTH];
    read_exact(video, &mut buf).await?;

    let codec_id = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]);
    let meta = scrcpy_protocol::parse_session_meta(&buf[CODEC_ID_LENGTH..])?;

    Ok((Codec::from_id(codec_id), meta.width, meta.height))
}

/// 设备端 socket 名，与 scrcpy 官方一致。
pub fn device_socket(scid: u32) -> String {
    format!("localabstract:scrcpy_{scid:08x}")
}

/// 由会话标识推导 scid。
///
/// scrcpy 官方用序号自增；这里用标识的散列，让同一个 `session_id`
/// 每次得到同一个 scid（可重复启停），不同会话互不干扰。
///
/// 必须落在 **31 位**内：服务端用 `Integer.parseInt(value, 16)` 解析，
/// 超过 `i32::MAX` 会直接抛 `NumberFormatException`，套接字根本不会创建。
pub fn scid_from(session_id: &str) -> u32 {
    let mut hash: u32 = 2_166_136_261;
    for byte in session_id.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(16_777_619);
    }
    // 取 31 位并避开 0（0 在有些实现里被当作「未设置」）
    (hash & 0x7fff_ffff) | 1
}

/// 在本机回环上开一个监听口，接住设备端连回来的视频/控制两条连接。
pub async fn bind_local() -> Result<tokio::net::TcpListener> {
    tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| SessionError::ConnectionFailed(e.to_string()))
}

/// 读服务端在视频 socket 上最先下发的 64 字节设备名。
///
/// 反向拓扑（`tunnel_forward=false`）下服务端是 connect 方，
/// **不会**发 dummy byte——那个字节只存在于服务端 listen 的分支里。
pub async fn read_device_name(video: &mut tokio::net::TcpStream) -> Result<String> {
    let mut name_field = [0u8; DEVICE_NAME_FIELD_LENGTH];
    read_exact(video, &mut name_field).await?;
    Ok(scrcpy_protocol::decode_device_name(&name_field))
}

async fn read_exact(stream: &mut tokio::net::TcpStream, buf: &mut [u8]) -> Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        let n = stream.read(&mut buf[filled..]).await?;
        if n == 0 {
            return Err(SessionError::VideoStreamClosed);
        }
        filled += n;
    }
    Ok(filled)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 默认选项能启动视频与控制() {
        let opts = SessionOptions::default();
        assert!(opts.video);
        assert!(opts.control);
        assert!(!opts.audio);
    }

    #[test]
    fn 服务端参数全部是_key_value_且显式声明开关() {
        let args = SessionOptions::default().server_args(0x1234_5678);

        assert!(
            args.iter().all(|a| a.contains('=')),
            "存在非 key=value 参数：{args:?}"
        );
        for expected in [
            "video=true",
            "audio=false",
            "control=true",
            "send_device_meta=true",
            "send_stream_meta=true",
            "send_frame_meta=true",
            "tunnel_forward=false",
            "video_codec=h264",
        ] {
            assert!(args.iter().any(|a| a == expected), "缺少参数 {expected}");
        }
    }

    #[test]
    fn 码率按_bps_下发() {
        let args = SessionOptions {
            bit_rate: 8,
            ..Default::default()
        }
        .server_args(1);
        // 服务端单位是 bit/s：8 Mbps 必须写成 8000000
        assert!(
            args.iter().any(|a| a == "video_bit_rate=8000000"),
            "{args:?}"
        );
    }

    #[test]
    fn 不下发_cleanup_以免服务端退出时删掉_jar() {
        // cleanup=true 会让服务端退出时 unlink 掉 jar，
        // 下一次会话就会以 ClassNotFoundException 收场。
        let args = SessionOptions::default().server_args(1);
        assert!(!args.iter().any(|a| a.starts_with("cleanup=")), "{args:?}");
    }

    #[test]
    fn scid_始终落在31位以内() {
        for id in ["it-handshake", "it-touch", "it-stop", "it-reuse", ""] {
            let scid = scid_from(id);
            assert!(scid <= 0x7fff_ffff, "{id} → {scid:#x} 超出 31 位");
        }
    }

    #[test]
    fn 关闭控制会写到参数里() {
        let opts = SessionOptions {
            control: false,
            audio: true,
            ..Default::default()
        };
        let args = opts.server_args(1);
        assert!(args.iter().any(|a| a == "control=false"));
        assert!(args.iter().any(|a| a == "audio=true"));
    }

    #[test]
    fn 尺寸为0时不下发_max_size_否则下发() {
        let opts = SessionOptions {
            max_size: 0,
            ..Default::default()
        };
        assert!(!opts
            .server_args(1)
            .iter()
            .any(|a| a.starts_with("max_size=")));

        let opts = SessionOptions {
            max_size: 720,
            ..Default::default()
        };
        assert!(opts.server_args(1).iter().any(|a| a == "max_size=720"));
    }

    #[test]
    fn scid_对同一序列号稳定_对不同序列号不同_且不为零() {
        assert_eq!(scid_from("d4535f72"), scid_from("d4535f72"));
        assert_ne!(scid_from("d4535f72"), scid_from("emulator-5554"));
        assert_ne!(scid_from("d4535f72"), 0);
    }

    #[test]
    fn 设备socket名与官方一致() {
        assert_eq!(device_socket(1), "localabstract:scrcpy_00000001");
        assert_eq!(device_socket(0xdead_beef), "localabstract:scrcpy_deadbeef");
    }
}
