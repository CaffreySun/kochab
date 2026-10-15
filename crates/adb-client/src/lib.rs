//! adb server 协议客户端。
//!
//! 本 crate 直接与本机 adb server（默认 `127.0.0.1:5037`）对话，实现
//! `host:` / `host-serial:` / `shell:` / `sync:` 四类服务，
//! 不依赖任何第三方 adb 库。
//!
//! # 分层
//!
//! | 模块 | 职责 |
//! | --- | --- |
//! | [`transport`] | 字节收发抽象（生产用 TCP，测试用内存 mock） |
//! | [`codec`] | 请求 / 响应的字节编解码 |
//! | [`device`] | 设备列表模型与解析 |
//! | [`client`] | 面向使用方的 API（host / shell） |
//! | [`sync`] | 文件传输子会话 |
//! | [`testing`] | 测试辅助（内存传输、真机开关） |
//!
//! # 示例
//!
//! ```no_run
//! # async fn demo() -> Result<(), adb_client::AdbError> {
//! use adb_client::AdbClient;
//!
//! // 客户端本身不持有连接（连接是一次性的），因此可以自由克隆与并发使用
//! let client = AdbClient::connect()?;
//! for device in client.devices().await? {
//!     println!("{} {}", device.serial, device.state);
//! }
//!
//! let out = client.shell(&"device_serial", "getprop ro.build.version.release").await?;
//! println!("{}", out.text());
//! # Ok(())
//! # }
//! ```

pub mod client;
pub mod codec;
pub mod device;
pub mod error;
pub mod sync;
pub mod testing;
pub mod transport;

pub use client::{AdbClient, DeviceTracker, ShellOutput, DEFAULT_ENDPOINT, DEFAULT_SHELL_TIMEOUT};
pub use device::{diff_state, DeviceChange, DeviceListEntry, DeviceState};
pub use error::{AdbError, Result};
pub use sync::{FileStat, SyncSession};
pub use transport::{TcpTransport, Transport};
