//! scrcpy 4.1 客户端协议编解码。
//!
//! 纯数据层，**不依赖 socket / adb / 进程**，因此可以对字节布局做精确断言。
//!
//! > 所有布局以 [scrcpy v4.1 服务端源码](https://github.com/Genymobile/scrcpy/tree/v4.1/server)
//! > 为准（`DesktopConnection.java`、`Streamer.java`、`ControlMessageReader.java`）。
//! > 旧版协议文档描述的控制消息与视频帧格式**已经过时**，
//! > 与 v4.1 存在实质差异（小端控制消息 vs. 大端视频流、u8 触摸动作、
//! > 12 字节帧头取代 u8 config 标志等）。
//!
//! # 模块
//!
//! | 模块 | 内容 | 字节序 |
//! | --- | --- | --- |
//! | [`stream`] | 握手、视频包、会话尺寸 | **大端** |
//! | [`control`] | 控制消息编码 | **小端** |

pub mod control;
pub mod error;
pub mod stream;

pub use control::{
    encode_back_or_screen_on, encode_clipboard, encode_display_power, encode_get_clipboard,
    encode_key, encode_reset_video, encode_resize_display, encode_scan_file, encode_scroll,
    encode_simple, encode_start_app, encode_text, encode_touch, msg_type, KeyAction, KeyEvent,
    ScrollEvent, TouchAction, TouchEvent,
};
pub use error::{ProtocolError, Result};
pub use stream::{
    decode_device_name, encode_stream_meta, encode_video_packet, parse_session_meta,
    parse_stream_meta, parse_video_packet, BigEndianReader, Codec, ParseError, SessionMeta,
    StreamMeta, VideoPacket, DEVICE_NAME_FIELD_LENGTH, DEVICE_NAME_MAX_BYTES, PACKET_HEADER_LENGTH,
    SESSION_CLIENT_RESIZE, SESSION_FLAG, SESSION_META_LENGTH, STREAM_META_LENGTH,
};

/// 本项目实现对应的 scrcpy 版本。
///
/// 该字符串会作为 `app_process` 的第一个参数传给设备端 server；
/// 协议不兼容时设备端会直接拒绝启动。
pub const SUPPORTED_VERSION: &str = "4.1";
