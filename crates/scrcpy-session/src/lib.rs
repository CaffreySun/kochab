//! scrcpy 会话编排。
//!
//! 把「一台已连接设备」变成「一条可交互的投屏会话」：
//! 推送 server → 端口转发 → 拉起设备端进程 → 视频/控制双通道握手。
//!
//! 协议细节全部在 [`scrcpy_protocol`]，本 crate 只负责**编排与生命周期**。

pub mod error;
pub mod session;

pub use error::{Result, SessionError};
pub use session::{
    device_socket, read_video_packet, remote_server_path, scid_from, ControlSender, ScrcpySession,
    SessionFactory, SessionInfo, SessionOptions,
};

pub use scrcpy_protocol::{Codec, VideoPacket};
