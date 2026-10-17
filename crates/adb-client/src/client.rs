//! adb server 客户端。
//!
//! # 核心约束：一条连接只服务一次操作
//!
//! 实测（adb 1.0.41）：
//!
//! | 请求 | 服务端行为 |
//! | --- | --- |
//! | `host:version` / `host:devices-l` | 返回响应后**关闭连接** |
//! | `host:connect:` / `host:disconnect:` | 返回响应后关闭连接 |
//! | `host:transport:<serial>` | **不关闭**，把连接切到「设备模式」 |
//! | `shell:` / `sync:`（设备服务） | 执行完关闭连接 |
//!
//! 所以一次「选设备 + 执行」的组合必须独占一条连接；
//! 本实现每次公开方法都向 [`TransportFactory`] 索取新连接，
//! 从根本上杜绝「复用连接导致第二次请求读到 EOF」的问题。

use std::net::{SocketAddr, ToSocketAddrs};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tracing::{debug, warn};

use crate::codec;
use crate::device::{parse_device_list, DeviceListEntry, DeviceState};
use crate::error::{AdbError, Result};
use crate::sync::SyncSession;
use crate::transport::{TcpFactory, Transport, TransportFactory};

/// adb server 默认监听地址。
pub const DEFAULT_ENDPOINT: &str = "127.0.0.1:5037";

/// shell 命令的默认超时。
pub const DEFAULT_SHELL_TIMEOUT: Duration = Duration::from_secs(30);

/// 单次读取的缓冲区大小。
const READ_BUF: usize = 16 * 1024;

/// 等待「可选负载」的最长时间。
const OPTIONAL_PAYLOAD_TIMEOUT: Duration = Duration::from_millis(400);

/// `tcpip:` / `usb:` 切换后等待 adb server 发完说明并关闭连接的上限。
const NETWORK_MODE_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

/// 执行一次 shell 的结果。
///
/// 注意：`adb shell` 会把 stdout 与 stderr **合并**到同一条流里，
/// 因此这里只有 `stdout`，无法区分两者。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellOutput {
    pub command: String,
    /// 设备端返回的退出码；无法确定时为 `-1`
    pub exit_code: i32,
    pub stdout: String,
    pub timed_out: bool,
}

impl ShellOutput {
    pub fn success(&self) -> bool {
        self.exit_code == 0 && !self.timed_out
    }

    /// 去除首尾空白后的输出，便于直接展示。
    pub fn text(&self) -> &str {
        self.stdout.trim()
    }
}

/// adb server 客户端。
///
/// 本身不持有连接（连接是「一次性的」），因此可以自由克隆与并发使用。
#[derive(Clone, Debug)]
pub struct AdbClient {
    factory: Arc<dyn TransportFactory>,
    endpoint: String,
}

impl AdbClient {
    /// 指向默认地址的客户端；此时不建立 socket。
    pub fn new(endpoint: &str) -> Result<Self> {
        // 先做一次地址解析，把配置错误提前暴露
        resolve(endpoint)?;
        Ok(Self {
            factory: Arc::new(TcpFactory::new(resolve(endpoint)?)),
            endpoint: endpoint.to_owned(),
        })
    }

    /// 指向默认地址的客户端。
    pub fn connect() -> Result<Self> {
        Self::new(DEFAULT_ENDPOINT)
    }

    /// 用任意传输工厂构造（测试用）。
    pub fn with_factory(factory: Arc<dyn TransportFactory>) -> Self {
        Self {
            factory,
            endpoint: "mock://adb".into(),
        }
    }

    /// 用一条固定的 mock 传输构造（单次操作的测试用）。
    pub fn with_transport(transport: Box<dyn Transport>) -> Self {
        Self::with_factory(Arc::new(crate::testing::MockFactory::new(transport)))
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// 开一条新连接。
    async fn open(&self) -> Result<Box<dyn Transport>> {
        self.open_with_mode(false).await
    }

    /// 打开一条推送连接（读取不施加超时）。
    async fn open_push(&self) -> Result<Box<dyn Transport>> {
        self.open_with_mode(true).await
    }

    async fn open_with_mode(&self, push: bool) -> Result<Box<dyn Transport>> {
        let attempt = if push {
            self.factory.connect_push().await
        } else {
            self.factory.connect().await
        };
        attempt.map_err(|e| {
            debug!(endpoint = %self.endpoint, error = %e, "建立 adb 连接失败");
            AdbError::ServerUnreachable {
                endpoint: format!("{}（{e}）", self.endpoint),
            }
        })
    }

    /// 执行一条「一次性」的 host 请求并读取长度前缀负载。
    async fn host_request(&self, service: &str) -> Result<Vec<u8>> {
        let mut t = self.open().await?;
        codec::send_request(t.as_mut(), service).await?;
        codec::read_status(t.as_mut()).await?;
        codec::read_length_prefixed(t.as_mut()).await
    }

    /// 把连接切换到指定设备（设备服务的前置步骤）。
    ///
    /// 这一步不会关闭连接，后续的设备服务必须在**同一条连接**上发送。
    async fn select_device(t: &mut (dyn Transport + '_), serial: &str) -> Result<()> {
        codec::send_request(t, &format!("host:transport:{serial}")).await?;
        codec::read_status(t).await.map_err(|e| {
            if matches!(e, AdbError::ServerRejected { .. }) {
                debug!(serial, "host:transport 被拒绝，视为设备不存在");
                AdbError::DeviceNotFound {
                    serial: serial.to_owned(),
                }
            } else {
                e
            }
        })
    }

    // ---------------------------------------------------------------- host 服务

    /// `host:version`，返回 adb server 版本号。
    pub async fn version(&self) -> Result<u32> {
        let mut t = self.open().await?;
        codec::send_request(t.as_mut(), "host:version").await?;
        codec::read_status(t.as_mut()).await?;

        // 版本号是 4 个 ASCII 十六进制字符（例如 `0029` 表示 41），
        // 不是二进制整数——早期实现按小端 u32 解析，会把 `"0029"` 读成 959590448。
        let raw = codec::read_length_prefixed(t.as_mut()).await?;
        let text = std::str::from_utf8(&raw).map_err(|_| AdbError::MalformedResponse {
            reason: format!(
                "版本号应为 ASCII 十六进制，实际含非 UTF-8 字节（{} 字节）",
                raw.len()
            ),
        })?;
        u32::from_str_radix(text.trim(), 16).map_err(|_| AdbError::MalformedResponse {
            reason: format!("版本号应为十六进制字符串，实际为 {text:?}"),
        })
    }

    /// `host:devices-l`，一次性列出全部设备。
    pub async fn devices(&self) -> Result<Vec<DeviceListEntry>> {
        let payload = self.host_request("host:devices-l").await?;
        parse_device_list(&payload)
    }

    /// `host:connect:<address>`，连接网络设备。
    ///
    /// `address` 形如 `192.168.1.10:5555`（省略端口时 adb 默认 5555）。
    pub async fn connect_device(&self, address: &str) -> Result<String> {
        let address = address.trim();
        if address.is_empty() {
            return Err(AdbError::ServerRejected {
                message: "设备地址不能为空".into(),
            });
        }
        let payload = self
            .host_request(&format!("host:connect:{address}"))
            .await?;
        Ok(String::from_utf8_lossy(&payload).trim().to_owned())
    }

    /// `host:disconnect:<serial>`，断开网络设备。
    pub async fn disconnect_device(&self, serial: &str) -> Result<String> {
        if serial.trim().is_empty() {
            return Err(AdbError::ServerRejected {
                message: "设备序列号不能为空".into(),
            });
        }
        let payload = self
            .host_request(&format!("host:disconnect:{serial}"))
            .await?;
        Ok(String::from_utf8_lossy(&payload).trim().to_owned())
    }

    /// `host:track-devices`，订阅设备增删。
    ///
    /// 该服务返回 `OKAY` 后**持续**推送变更，因此 [`DeviceTracker`] 独占一条连接。
    pub async fn track_devices(&self) -> Result<DeviceTracker> {
        // 推送连接必须用 `open_push`：普通连接带读超时，
        // 没有设备变化时会把这条长连接反复踢断。
        let mut t = self.open_push().await?;
        codec::send_request(t.as_mut(), "host:track-devices").await?;
        codec::read_status(t.as_mut()).await?;
        Ok(DeviceTracker { transport: t })
    }

    // ---------------------------------------------------------------- shell 服务

    /// 在指定设备上执行 shell 命令（默认 30 秒超时）。
    pub async fn shell(&self, serial: &str, command: &str) -> Result<ShellOutput> {
        self.shell_with_timeout(serial, command, DEFAULT_SHELL_TIMEOUT)
            .await
    }

    /// 在指定设备上执行 shell 命令，可指定超时。
    ///
    /// adb 的 `shell:` 服务没有退出码通道，这里用「子 shell + 哨兵」把退出码带回来：
    ///
    /// ```sh
    /// ( <cmd> ); __ac_rc=$?; printf '\n<token>%s' "$__ac_rc"
    /// ```
    ///
    /// - 用 `( )` 包住原命令：`exit 42` 只会结束子 shell，不会吃掉后面的哨兵；
    /// - **先存后打**：`$?` 必须紧跟在原命令之后求值，
    ///   直接写 `printf ... "$?"` 会拿到前一个 `printf` 的退出码（恒为 0）。
    pub async fn shell_with_timeout(
        &self,
        serial: &str,
        command: &str,
        timeout: Duration,
    ) -> Result<ShellOutput> {
        let token = exit_token();
        self.shell_with_token(serial, command, timeout, &token)
            .await
    }

    /// 与 [`Self::shell_with_timeout`] 相同，但退出码哨兵由调用方指定（供测试使用）。
    async fn shell_with_token(
        &self,
        serial: &str,
        command: &str,
        timeout: Duration,
        token: &str,
    ) -> Result<ShellOutput> {
        let service = format!("shell:({command}); __ac_rc=$?; printf '\\n{token}%s' \"$__ac_rc\"");

        let mut t = self.open().await?;
        Self::select_device(t.as_mut(), serial).await?;
        codec::send_request(t.as_mut(), &service).await?;
        codec::read_status(t.as_mut()).await?;

        let read = async {
            let mut raw = Vec::new();
            let mut buf = [0u8; READ_BUF];
            loop {
                match t.read_some(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        raw.extend_from_slice(&buf[..n]);
                        // 哨兵与退出码**都**到齐才能提前结束：
                        // 哨兵可能先于退出码字节到达，此时结束会得到空退出码
                        if exit_code(&raw, token).is_some() {
                            break;
                        }
                    }
                    Err(e) => return Err(e),
                }
            }
            Ok::<_, std::io::Error>(raw)
        };

        match tokio::time::timeout(timeout, read).await {
            Ok(Ok(raw)) => {
                let (stdout, exit_code) = split_exit(&raw, token)
                    .unwrap_or_else(|| (String::from_utf8_lossy(&raw).into_owned(), -1));
                Ok(ShellOutput {
                    command: command.to_owned(),
                    exit_code,
                    stdout,
                    timed_out: false,
                })
            }
            Ok(Err(e)) => Err(AdbError::from(e)),
            Err(_) => {
                warn!(
                    serial,
                    command,
                    timeout_ms = timeout.as_millis(),
                    "shell 命令超时"
                );
                Ok(ShellOutput {
                    command: command.to_owned(),
                    exit_code: -1,
                    stdout: String::new(),
                    timed_out: true,
                })
            }
        }
    }

    // ---------------------------------------------------------------- 网络调试

    /// 让设备把 adbd 切换为 TCP 监听（`adb tcpip <port>`）。
    ///
    /// 响应是 `OKAY` 后面跟一行普通文本（如 `restarting in TCP mode port: 5555`），
    /// 没有长度前缀，最后以 EOF 结束。**必须把这段读完再断开**：
    /// 实测只读到 `OKAY` 就关闭连接，adb server 会中止重启，设备仍停在 USB 模式
    /// （命令却返回成功）。
    pub async fn tcpip(&self, serial: &str, port: u16) -> Result<()> {
        self.network_mode(serial, &format!("tcpip:{port}")).await
    }

    /// 让设备把 adbd 切回 USB 模式（`adb usb`）。
    pub async fn usb(&self, serial: &str) -> Result<()> {
        self.network_mode(serial, "usb:").await
    }

    async fn network_mode(&self, serial: &str, service: &str) -> Result<()> {
        let mut t = self.open().await?;
        Self::select_device(t.as_mut(), serial).await?;
        codec::send_request(t.as_mut(), service).await?;
        codec::read_status(t.as_mut()).await?;
        drain_until_eof(t.as_mut(), NETWORK_MODE_DRAIN_TIMEOUT).await
    }

    // ---------------------------------------------------------------- 设备侧 host 服务

    /// 执行一个**需要先选设备**的 host 服务：`forward` / `killforward` / `list-forward`。
    ///
    /// 这类服务不能直接用 `host:` 前缀，也不接受 `host-serial:` 以外的写法；
    /// 必须先发 `host:transport:<serial>` 再发 `host-serial:<serial>:<service>`。
    ///
    /// 实测响应帧序列（adb 1.0.41）：
    ///
    /// ```text
    /// OKAY            ← host:transport 的响应
    /// OKAY | FAIL     ← 服务状态；FAIL 后跟 4 位十六进制长度 + 原因
    /// OKAY            ← 监听器建立结果；旧版 adb 可能不发，此时读操作得到 EOF
    /// [0005]27183     ← 可选负载，仅「新建转发」时出现（已存在则无负载）
    /// ```
    ///
    /// 三个状态位与可选负载都必须**分别**读取：把 `OKAYOKAYOKAY` 当成一次
    /// 读 12 字节，会在负载存在时错位，把端口号读成别的数据。
    pub async fn device_host_service(&self, serial: &str, service: &str) -> Result<Vec<u8>> {
        let mut t = self.open().await?;
        Self::select_device(t.as_mut(), serial).await?;
        codec::send_request(t.as_mut(), &format!("host-serial:{serial}:{service}")).await?;
        read_statuses_then_payload(t.as_mut()).await
    }

    /// 与 [`device_host_service`](Self::device_host_service) 相同的响应解析，
    /// 但服务名**不带** `host-serial:` 前缀。
    ///
    /// `reverse:` 系列属于这一类：它必须在 `host:transport:<serial>` 之后
    /// 直接发送，写成 `host-serial:<serial>:reverse:...` 会得到
    /// `unknown host service`。
    async fn device_raw_service(&self, serial: &str, service: &str) -> Result<Vec<u8>> {
        let mut t = self.open().await?;
        Self::select_device(t.as_mut(), serial).await?;
        codec::send_request(t.as_mut(), service).await?;
        read_statuses_then_payload(t.as_mut()).await
    }

    /// 建立端口转发：`local`（如 `tcp:27183`）→ 设备的 `remote`
    /// （如 `localabstract:scrcpy_1234abcd`）。
    ///
    /// 重复建立同一条转发是**幂等**的，adb 直接返回 OKAY 而不报端口占用。
    pub async fn forward(&self, serial: &str, local: &str, remote: &str) -> Result<()> {
        self.device_host_service(serial, &format!("forward:{local};{remote}"))
            .await
            .map(|_| ())
    }

    /// 移除端口转发。
    ///
    /// 转发不存在时 adb 返回 `FAIL listener 'tcp:27183' not found`；
    /// 调用方（例如会话收尾）应当容忍这种错误。
    pub async fn remove_forward(&self, serial: &str, local: &str) -> Result<()> {
        self.device_host_service(serial, &format!("killforward:{local}"))
            .await
            .map(|_| ())
    }

    /// 列出当前所有转发，每行一条，形如
    /// `d4535f72 tcp:27183 localabstract:scrcpy_1234abcd.`
    pub async fn list_forward(&self, serial: &str) -> Result<Vec<String>> {
        let payload = self.device_host_service(serial, "list-forward").await?;
        Ok(String::from_utf8_lossy(&payload)
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect())
    }

    // ---------------------------------------------------------------- reverse 隧道

    /// 建立反向隧道：设备侧 `remote` ← 本机 `local`。
    ///
    /// 和 [`forward`](Self::forward) 正好相反：adbd 在**设备侧**监听
    /// `remote`（如 `localabstract:scrcpy_1234abcd`），设备上的进程连它时，
    /// 流量被转回**本机**的 `local`（如 `tcp:27183`）。
    ///
    /// scrcpy 用这条路径：服务端 `tunnel_forward=false` 时会主动 connect，
    /// 所以本机必须先监听、再由设备连回来。
    pub async fn reverse(&self, serial: &str, remote: &str, local: &str) -> Result<()> {
        self.device_raw_service(serial, &format!("reverse:forward:{remote};{local}"))
            .await
            .map(|_| ())
    }

    /// 移除一条反向隧道。
    pub async fn remove_reverse(&self, serial: &str, remote: &str) -> Result<()> {
        self.device_raw_service(serial, &format!("reverse:killforward:{remote}"))
            .await
            .map(|_| ())
    }

    /// 移除全部反向隧道。
    pub async fn remove_all_reverse(&self, serial: &str) -> Result<()> {
        self.device_raw_service(serial, "reverse:killforward-all")
            .await
            .map(|_| ())
    }

    /// 列出当前所有反向隧道。
    pub async fn list_reverse(&self, serial: &str) -> Result<Vec<String>> {
        let payload = self
            .device_raw_service(serial, "reverse:list-forward")
            .await?;
        Ok(String::from_utf8_lossy(&payload)
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect())
    }

    // ---------------------------------------------------------------- sync 服务

    /// 打开针对指定设备的 `sync:` 会话（文件传输）。
    ///
    /// 会话独占一条连接直到 [`SyncSession`] 被丢弃。
    pub async fn open_sync(&self, serial: &str) -> Result<SyncSession> {
        let mut t = self.open().await?;
        Self::select_device(t.as_mut(), serial).await?;
        codec::send_request(t.as_mut(), "sync:").await?;
        codec::read_status(t.as_mut()).await.map_err(|e| match e {
            AdbError::ServerRejected { message } => AdbError::SyncFailed(message),
            other => other,
        })?;
        Ok(SyncSession::new(t, serial))
    }
}

/// `host:track-devices` 的事件流，独占一条连接直到 `Drop`。
pub struct DeviceTracker {
    transport: Box<dyn Transport>,
}

impl DeviceTracker {
    /// 阻塞等待下一个设备变更。
    ///
    /// - `Ok(Some(entry))`：设备列表发生了一次变化（可能新增、移除或状态改变）
    /// - `Ok(None)`：adb server 关闭了推送流
    pub async fn next(&mut self) -> Result<Option<DeviceListEntry>> {
        let len = match codec::read_length(self.transport.as_mut()).await {
            Ok(len) => len,
            Err(AdbError::Io(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                return Ok(None)
            }
            Err(e) => return Err(e),
        };

        // 空负载表示「所有设备都消失了」
        if len == 0 {
            return Ok(Some(DeviceListEntry {
                serial: String::new(),
                state: DeviceState::Unknown,
                props: Default::default(),
            }));
        }

        let mut buf = vec![0u8; len];
        self.transport.read_exact(&mut buf).await?;
        let entry = DeviceListEntry::parse_line(&String::from_utf8_lossy(&buf))?;
        debug!(serial = %entry.serial, state = %entry.state, "设备变更");
        Ok(Some(entry))
    }
}

/// 读到 EOF（或超时）为止，丢弃内容。
///
/// `tcpip:` / `usb:` 在 `OKAY` 之后会再发一行说明文本，且**没有长度前缀**。
/// 必须把这条连接读干净再关闭，否则 adb server 可能在重启 adbd 前就被打断。
async fn drain_until_eof(t: &mut (dyn Transport + '_), limit: Duration) -> Result<()> {
    let read = async {
        let mut buf = [0u8; READ_BUF];
        loop {
            match t.read_some(&mut buf).await {
                Ok(0) => return Ok::<_, std::io::Error>(()),
                Ok(_) => {}
                // 有些 transport 把对端关闭报成 EOF 错误
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
                Err(e) => return Err(e),
            }
        }
    };

    match tokio::time::timeout(limit, read).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(AdbError::Io(e)),
        // 超时说明服务已经接受请求，只是没关连接：继续执行，不把成功报成失败
        Err(_) => Ok(()),
    }
}

/// 读取 forward/reverse 类服务的响应：一串 `OKAY` 状态位，外加可选的长度前缀负载。
///
/// 实测（adb 1.0.41）这组服务会写：
///
/// ```text
/// OKAY   OKAY [OKAY] [<4位十六进制长度><负载>]
/// ```
///
/// - `forward:tcp:27183;localabstract:x`（新建）→ `OKAY OKAY OKAY 0005 27183`
/// - `forward:…`（已存在）→ `OKAY OKAY OKAY`
/// - `forward:…`（失败）→ `OKAY FAIL 001e listener … not found`
/// - `reverse:forward:…` → `OKAY OKAY OKAY`
/// - `list-forward`（空）→ `OKAY OKAY 0000`
///
/// 状态位数不固定，所以不能按「读 N 个状态位」写死：这里循环读到
/// 出现非 `OKAY` 的 4 字节为止，把它当作负载长度前缀。
///
/// 超时后视为「本次没有负载」——旧版 adb 不发第三个状态位。
async fn read_statuses_then_payload(t: &mut (dyn Transport + '_)) -> Result<Vec<u8>> {
    // 第一个状态位失败时 read_status 会把原因读出来
    codec::read_status(t).await?;

    loop {
        let read_word = async {
            let mut word = [0u8; 4];
            t.read_exact(&mut word).await?;
            Ok::<_, AdbError>(word)
        };

        let word = match tokio::time::timeout(OPTIONAL_PAYLOAD_TIMEOUT, read_word).await {
            Ok(Ok(word)) => word,
            // EOF 或超时：响应到此为止，没有负载
            Ok(Err(AdbError::Io(e))) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                return Ok(Vec::new())
            }
            Ok(Err(e)) => return Err(e),
            Err(_) => return Ok(Vec::new()),
        };

        match &word {
            b"OKAY" => continue,
            b"FAIL" => return Err(codec::read_reason(t).await),
            _ => {
                let len = codec::parse_hex_len(&word)?;
                let mut payload = vec![0u8; len];
                t.read_exact(&mut payload).await?;
                return Ok(payload);
            }
        }
    }
}

/// 生成本次 shell 调用唯一的哨兵串。
///
/// 组成：进程号 + 进程内自增序号，保证同一进程内不会重复；
/// 只含十六进制与下划线，嵌入 shell 命令是安全的。
fn exit_token() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("__AC_EXIT_{:x}_{:x}__", std::process::id(), n)
}

/// 提取哨兵之后的退出码；数字尚未到达时返回 `None`。
fn exit_code(raw: &[u8], token: &str) -> Option<i32> {
    let pos = rfind(raw, token.as_bytes())?;
    let rest = &raw[pos + token.len()..];
    let digits: String = rest
        .iter()
        .take_while(|b| b.is_ascii_digit())
        .map(|b| *b as char)
        .collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

/// 从原始输出中切出 `(stdout, exit_code)`。
///
/// 哨兵格式为 `\n<token><exit>`。取**最后一次**出现，
/// 避免命令自身输出了相同内容时误判。
fn split_exit(raw: &[u8], token: &str) -> Option<(String, i32)> {
    let pos = rfind(raw, token.as_bytes())?;
    let code = exit_code(raw, token).unwrap_or(-1);

    // stdout 结束于哨兵前的那个换行符
    let stdout_end = raw[..pos].iter().rposition(|&b| b == b'\n').unwrap_or(pos);
    Some((
        String::from_utf8_lossy(&raw[..stdout_end]).into_owned(),
        code,
    ))
}

/// 查找 `needle` 最后一次出现的字节偏移。
fn rfind(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .enumerate()
        .filter(|(_, w)| *w == needle)
        .map(|(i, _)| i)
        .next_back()
}

fn resolve(endpoint: &str) -> Result<SocketAddr> {
    endpoint
        .to_socket_addrs()
        .map_err(|e| AdbError::ServerUnreachable {
            endpoint: format!("{endpoint}（{e}）"),
        })?
        .next()
        .ok_or_else(|| AdbError::ServerUnreachable {
            endpoint: format!("{endpoint}（未解析到任何地址）"),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{MockFactory, MockTransport};

    #[tokio::test]
    async fn 版本号按_ascii_十六进制解析() {
        // 真实 adb server 对 host:version 回的是 OKAY + 0004 + "0029"。
        let client = AdbClient::with_transport(Box::new(MockTransport::okay_with(b"0029")));

        assert_eq!(client.version().await.unwrap(), 41);
    }

    #[tokio::test]
    async fn 版本号不是十六进制时报错() {
        let client = AdbClient::with_transport(Box::new(MockTransport::okay_with(b"zzzz")));

        assert!(matches!(
            client.version().await,
            Err(AdbError::MalformedResponse { .. })
        ));
    }

    #[tokio::test]
    async fn 设备列表使用正确的服务名() {
        let payload = b"d4535f72\tdevice\nemulator-5554\toffline\n";
        let mock = MockTransport::okay_with(payload);
        let log = mock.written();
        let client = AdbClient::with_transport(Box::new(mock));

        let devices = client.devices().await.unwrap();

        assert_eq!(devices.len(), 2);
        assert_eq!(log.requests(), vec!["000ehost:devices-l".to_string()]);
    }

    #[tokio::test]
    async fn 服务器拒绝时返回错误() {
        let client =
            AdbClient::with_transport(Box::new(MockTransport::fail("device 'x' not found")));

        let err = client.devices().await.unwrap_err();
        assert_eq!(
            err.to_string(),
            "adb server 返回了失败响应：device 'x' not found"
        );
    }

    #[tokio::test]
    async fn 每次操作都会新建连接() {
        // 工厂只提供一条连接；第二次操作必然失败——
        // 这正是 adb 协议的约束：连接不可复用。
        let factory = Arc::new(MockFactory::new(Box::new(MockTransport::okay_with(b""))));
        let client = AdbClient::with_factory(factory.clone());

        assert!(client.devices().await.is_ok());
        assert!(client.devices().await.is_err(), "连接不应被复用");
        assert_eq!(factory.connects(), 2);
    }

    #[tokio::test]
    async fn 设备追踪使用推送连接() {
        // 推送连接不能带读超时：`host:track-devices` 在没有设备变化时
        // 本该一直阻塞，套上超时会让这条长连接每 30 秒被自己踢断一次。
        let factory = Arc::new(MockFactory::new(Box::new(MockTransport::okay_with(b""))));
        let client = AdbClient::with_factory(factory.clone());

        assert!(client.track_devices().await.is_ok());
        assert_eq!(factory.connects(), 1);
        assert_eq!(factory.push_connects(), 1, "track_devices 必须走推送连接");
    }

    #[tokio::test]
    async fn 普通操作不使用推送连接() {
        let factory = Arc::new(MockFactory::new(Box::new(MockTransport::okay_with(b""))));
        let client = AdbClient::with_factory(factory.clone());

        assert!(client.devices().await.is_ok());
        assert_eq!(factory.push_connects(), 0);
    }

    #[tokio::test]
    async fn 空地址与空序列号被拒绝() {
        let client = AdbClient::with_transport(Box::new(MockTransport::okay_with(b"")));

        assert!(client.connect_device("  ").await.is_err());
        assert!(client.disconnect_device("").await.is_err());
    }

    #[tokio::test]
    async fn shell_先切换设备再执行命令() {
        let token = "__AC_EXIT_TEST_0__";
        // 第一次 OKAY 对应 host:transport，第二次对应 shell
        let mut response = b"OKAY".to_vec();
        response.extend_from_slice(b"OKAY");
        response.extend_from_slice(b"hello\n__AC_EXIT_TEST_0__0");
        let mock = MockTransport::new(response);
        let log = mock.written();
        let client = AdbClient::with_transport(Box::new(mock));

        let out = client
            .shell_with_token("d4535f72", "echo hi", Duration::from_secs(5), token)
            .await
            .unwrap();

        assert_eq!(out.stdout, "hello");
        assert_eq!(out.exit_code, 0);
        assert!(out.success());

        let raw = String::from_utf8_lossy(&log.bytes()).into_owned();
        let transport_at = raw
            .find("host:transport:d4535f72")
            .expect("应先发送 host:transport");
        let shell_at = raw.find("shell:(").expect("随后应发送 shell:");
        assert!(transport_at < shell_at, "顺序错误：先选设备再执行命令");
        assert!(raw.contains(token), "命令尾部应携带退出码哨兵：{raw}");
    }

    #[tokio::test]
    async fn shell_用子壳包裹原命令并先存后打退出码() {
        let token = "__AC_EXIT_TEST_9__";
        let mut response = b"OKAYOKAY".to_vec();
        response.extend_from_slice(b"\n__AC_EXIT_TEST_9__42");
        let mock = MockTransport::new(response);
        let log = mock.written();
        let client = AdbClient::with_transport(Box::new(mock));

        client
            .shell_with_token("d4535f72", "exit 42", Duration::from_secs(5), token)
            .await
            .unwrap();

        let raw = String::from_utf8_lossy(&log.bytes()).into_owned();
        // `( exit 42 )` 让 exit 只结束子壳；`__ac_rc=$?` 必须在任何 printf 之前求值
        assert!(
            raw.contains("shell:(exit 42); __ac_rc=$?"),
            "实际请求：{raw}"
        );
        assert!(
            raw.find("__ac_rc=$?").unwrap() < raw.find("printf").unwrap(),
            "退出码必须在 printf 之前保存：{raw}"
        );
    }

    #[tokio::test]
    async fn shell_设备不存在时报明确错误() {
        let client =
            AdbClient::with_transport(Box::new(MockTransport::fail("device 'nope' not found")));

        let err = client.shell("nope", "echo hi").await.unwrap_err();
        assert!(
            matches!(err, AdbError::DeviceNotFound { .. }),
            "实际错误：{err}"
        );
    }

    #[tokio::test]
    async fn shell_非零退出码被正确解析() {
        let token = "__AC_EXIT_TEST_1__";
        let mut response = b"OKAY".to_vec();
        response.extend_from_slice(b"OKAY");
        response.extend_from_slice(b"error: not found\n__AC_EXIT_TEST_1__251");
        let client = AdbClient::with_transport(Box::new(MockTransport::new(response)));

        let out = client
            .shell_with_token(
                "d4535f72",
                "pm uninstall nope",
                Duration::from_secs(5),
                token,
            )
            .await
            .unwrap();

        assert_eq!(out.exit_code, 251);
        assert!(!out.success());
        assert_eq!(out.text(), "error: not found");
    }

    #[tokio::test]
    async fn shell_哨兵缺失时不误报成功() {
        let client = AdbClient::with_transport(Box::new(MockTransport::new(
            b"OKAYOKAYsome output".to_vec(),
        )));

        let out = client
            .shell_with_token("d4535f72", "exit", Duration::from_secs(5), "__AC_EXIT_T__")
            .await
            .unwrap();

        // 设备侧没打出哨兵 → 退出码未知，不能当作成功
        assert!(!out.success());
        assert_eq!(out.exit_code, -1);
        assert_eq!(out.stdout, "some output");
    }

    #[tokio::test]
    async fn 设备跟踪解析推送() {
        // "d4535f72\tdevice\n" = 16 字节；"emulator-5554\toffline\n" = 22 字节
        let mut response = b"OKAY".to_vec();
        response.extend_from_slice(b"0010d4535f72\tdevice\n");
        response.extend_from_slice(b"0016emulator-5554\toffline\n");
        let client = AdbClient::with_transport(Box::new(MockTransport::new(response)));

        let mut tracker = client.track_devices().await.unwrap();

        let first = tracker.next().await.unwrap().unwrap();
        assert_eq!(first.serial, "d4535f72");
        assert_eq!(first.state, DeviceState::Device);

        let second = tracker.next().await.unwrap().unwrap();
        assert_eq!(second.serial, "emulator-5554");
        assert_eq!(second.state, DeviceState::Offline);

        // 流结束
        assert!(tracker.next().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn 设备跟踪使用短格式制表符分隔() {
        // 实测 track-devices 推送的是制表符分隔的短格式，与 devices-l 的长格式不同
        let entry = DeviceListEntry::parse_line("d4535f72\tdevice").unwrap();
        assert_eq!(entry.serial, "d4535f72");
        assert!(entry.props.is_empty());
    }

    #[test]
    fn 退出码哨兵解析() {
        let token = "__AC_EXIT_1_0__";
        let raw = b"hello\nline2\n__AC_EXIT_1_0__0";

        let (stdout, code) = split_exit(raw, token).unwrap();
        assert_eq!(stdout, "hello\nline2");
        assert_eq!(code, 0);
    }

    #[test]
    fn 空输出时退出码仍可解析() {
        let token = "__AC_EXIT_1_1__";
        let raw = b"\n__AC_EXIT_1_1__127";

        let (stdout, code) = split_exit(raw, token).unwrap();
        assert_eq!(stdout, "");
        assert_eq!(code, 127);
    }

    #[test]
    fn 输出不含换行时也能还原() {
        let token = "__AC_EXIT_1_2__";
        let raw = b"no-newline-output\n__AC_EXIT_1_2__2";

        let (stdout, code) = split_exit(raw, token).unwrap();
        assert_eq!(stdout, "no-newline-output");
        assert_eq!(code, 2);
    }

    #[test]
    fn 命令自身输出哨兵时取最后一次() {
        let token = "__AC_EXIT_1_3__";
        let raw = b"fake __AC_EXIT_1_3__9\nreal\n__AC_EXIT_1_3__3";

        let (stdout, code) = split_exit(raw, token).unwrap();
        assert_eq!(stdout, "fake __AC_EXIT_1_3__9\nreal");
        assert_eq!(code, 3);
    }

    #[test]
    fn 缺少哨兵时返回_none() {
        assert!(split_exit(b"just output", "__AC_EXIT_1_4__").is_none());
    }

    #[test]
    fn 哨兵生成不重复() {
        assert_ne!(exit_token(), exit_token());
        assert!(exit_token().starts_with("__AC_EXIT_"));
    }

    #[tokio::test]
    async fn tcpip_只读一个状态位并携带端口() {
        let mock = MockTransport::new(b"OKAYOKAY".to_vec());
        let log = mock.written();
        let client = AdbClient::with_transport(Box::new(mock));

        client.tcpip("d4535f72", 5555).await.unwrap();

        let raw = String::from_utf8_lossy(&log.bytes()).into_owned();
        assert!(raw.contains("host:transport:d4535f72"), "实际请求：{raw}");
        assert!(raw.contains("tcpip:5555"), "实际请求：{raw}");
    }

    #[tokio::test]
    async fn usb_切回_usb_模式() {
        let mock = MockTransport::new(b"OKAYOKAY".to_vec());
        let log = mock.written();
        let client = AdbClient::with_transport(Box::new(mock));

        client.usb("192.168.1.158:5555").await.unwrap();

        let raw = String::from_utf8_lossy(&log.bytes()).into_owned();
        assert!(raw.contains("host:transport:192.168.1.158:5555"));
        assert!(raw.contains("usb:"));
    }

    #[test]
    fn shell_结果判定() {
        let ok = ShellOutput {
            command: "ls".into(),
            exit_code: 0,
            stdout: "a\n".into(),
            timed_out: false,
        };
        assert!(ok.success());
        assert_eq!(ok.text(), "a");

        let failed = ShellOutput {
            exit_code: 1,
            ..ok.clone()
        };
        assert!(!failed.success());

        let timeout = ShellOutput {
            exit_code: -1,
            timed_out: true,
            ..ok
        };
        assert!(!timeout.success());
    }
}
