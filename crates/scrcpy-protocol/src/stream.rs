//! scrcpy 4.1 的握手与流头。
//!
//! 所有布局均**以 scrcpy v4.1 服务端源码为准**
//! （`device/DesktopConnection.java`、`device/Streamer.java`），
//! 而不是旧版协议文档——两者已经完全不同。
//!
//! # 视频 socket
//!
//! **客户端不发送任何握手数据**。服务端先 accept，再主动下发：
//!
//! ```text
//! [u8 ] dummy byte     仅 send_dummy_byte=true（默认），且只发在**第一条**已接受的 socket 上
//! [64B] device name    仅 send_device_meta=true，写在第一条 socket（视频）上
//! [u32] codec id       仅 send_stream_meta=true
//! [u32] session flags  仅 send_stream_meta=true，固定 bit31 = 1
//! [u32] width
//! [u32] height
//! ```
//!
//! 之后循环的是 12 字节帧头 + payload，**大端**：
//!
//! ```text
//! [i64] ptsAndFlags   bit62 = CONFIG，bit61 = KEY_FRAME，其余为 pts（微秒）
//! [i32] packetSize
//! [.. ] payload
//! ```
//!
//! 会话元信息（`writeSessionMeta`）**不是**带帧头的包，而是紧跟在 codec id 之后的
//! 12 字节裸数据；只有 `send_stream_meta=true` 时才发送。
//!
//! # 控制 socket
//!
//! 控制通道**不做任何握手**：服务端 accept 后立刻开始读控制消息，
//! 既没有 dummy byte，也没有设备名（见 `ControlChannel` 构造）。

/// 设备名字段长度（含结尾 NUL）。
pub const DEVICE_NAME_FIELD_LENGTH: usize = 64;

/// 设备名最多可用的 UTF-8 字节数（留 1 字节给 NUL）。
pub const DEVICE_NAME_MAX_BYTES: usize = DEVICE_NAME_FIELD_LENGTH - 1;

/// 流元信息总长度：`codec_id + flags + width + height`。
pub const STREAM_META_LENGTH: usize = 16;

/// 会话元信息长度：`flags + width + height`。
pub const SESSION_META_LENGTH: usize = 12;

/// 帧头长度。
pub const PACKET_HEADER_LENGTH: usize = 12;

/// 帧头标志位（`Streamer.PACKET_FLAG_*`）。
pub mod flags {
    /// 会话元信息标记（`1L << 63`）
    pub const SESSION: i64 = 1i64 << 63;
    /// 包内是编码器配置数据（SPS/PPS），不是一帧画面（`1L << 62`）
    pub const CONFIG: i64 = 1i64 << 62;
    /// 该帧是关键帧（`1L << 61`）
    pub const KEY_FRAME: i64 = 1i64 << 61;

    /// 所有标志位的掩码
    pub const MASK: i64 = SESSION | CONFIG | KEY_FRAME;
}

/// `writeSessionMeta` 写出的 32 位标志：仅 bit31（= `PACKET_FLAG_SESSION >> 32`）。
pub const SESSION_FLAG: u32 = 1 << 31;

/// 会话元信息里「尺寸变化由客户端触发」的低位标记。
pub const SESSION_CLIENT_RESIZE: u32 = 1;

/// 视频编码格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Codec {
    #[default]
    H264,
    H265,
    Av1,
    Vp8,
    Vp9,
    /// 未知编码，保留设备侧原始 id
    Unknown(u32),
}

impl Codec {
    /// 从线上的 4 字节 codec id 解析。
    ///
    /// 这个 id 是编码名的 **ASCII FOURCC**（`VideoCodec.java`），不是 0/1/2 的
    /// 枚举序号：`"h264"` 的十六进制恰好是 `0x68323634`。
    pub fn from_id(id: u32) -> Self {
        match id {
            0x6832_3634 => Self::H264, // "h264"
            0x6832_3635 => Self::H265, // "h265"
            0x0061_7631 => Self::Av1,  // "\0av1"
            0x0076_7038 => Self::Vp8,  // "\0vp8"
            0x0076_7039 => Self::Vp9,  // "\0vp9"
            other => Self::Unknown(other),
        }
    }

    pub fn id(&self) -> u32 {
        match self {
            Self::H264 => 0x6832_3634,
            Self::H265 => 0x6832_3635,
            Self::Av1 => 0x0061_7631,
            Self::Vp8 => 0x0076_7038,
            Self::Vp9 => 0x0076_7039,
            Self::Unknown(id) => *id,
        }
    }

    /// scrcpy 服务端 `video_codec` 选项取值。
    pub fn server_option(&self) -> &'static str {
        match self {
            Self::H264 => "h264",
            Self::H265 => "h265",
            Self::Av1 => "av1",
            Self::Vp8 => "vp8",
            Self::Vp9 => "vp9",
            Self::Unknown(_) => "unknown",
        }
    }

    /// 从服务端选项字符串解析。
    pub fn from_server_option(value: &str) -> Option<Self> {
        match value {
            "h264" => Some(Self::H264),
            "h265" | "hevc" => Some(Self::H265),
            "av1" => Some(Self::Av1),
            "vp8" => Some(Self::Vp8),
            "vp9" => Some(Self::Vp9),
            _ => None,
        }
    }
}

/// 视频流元信息（`send_stream_meta=true` 时随设备名一起下发）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreamMeta {
    pub codec: Codec,
    /// 视频尺寸（像素）
    pub width: u32,
    pub height: u32,
    /// 尺寸变化是否由客户端触发
    pub client_resize: bool,
}

/// 会话尺寸变化通知。
///
/// 设备旋转或客户端 `resize_display` 后，服务端会再发一次这12 字节。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionMeta {
    pub width: u32,
    pub height: u32,
    pub client_resize: bool,
}

/// 一个视频包。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VideoPacket {
    /// 编码器初始化数据（SPS/PPS），原样交给解码器
    Config { data: Vec<u8> },
    /// 一帧画面
    Frame {
        /// 展示时间戳（微秒）
        pts_us: u64,
        is_key_frame: bool,
        data: Vec<u8>,
    },
}

/// 视频流上的一个条目。
///
/// 视频 socket 上**不只有视频包**：设备旋转或客户端 `resize_display` 后，
/// 服务端会调用 `Streamer.writeSessionMeta()` 再写一次会话尺寸。
///
/// 关键点：这段是**12 字节裸数据**（`flags`、`width`、`height`），
/// **没有** 12 字节帧头。若把它当帧头解析，`height` 会被误读成 payload 长度，
/// 之后整条流就永久错位（表现为「帧长度为负」）。
///
/// 判据：真实帧头的第 63 位（[`flags::SESSION`]）永远是 0
/// （`writeFrameMeta` 只会设置 CONFIG / KEY_FRAME），而会话元信息首 4 字节
/// 固定是 `0x8000_0000`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VideoStreamItem {
    /// 会话尺寸变化（设备旋转 / 客户端请求 resize）
    Session(SessionMeta),
    /// 一个编码包
    Packet(VideoPacket),
}

impl VideoPacket {
    pub fn is_config(&self) -> bool {
        matches!(self, Self::Config { .. })
    }

    pub fn data(&self) -> &[u8] {
        match self {
            Self::Config { data } | Self::Frame { data, .. } => data,
        }
    }

    /// 展示时间戳（毫秒），供 UI 显示延迟。
    pub fn pts_ms(&self) -> Option<u64> {
        match self {
            Self::Config { .. } => None,
            Self::Frame { pts_us, .. } => Some(pts_us / 1000),
        }
    }
}

/// 解析失败的类型化描述。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    /// 数据不足
    Truncated { needed: usize, available: usize },
    /// 设备名不是合法 UTF-8
    InvalidUtf8,
    /// 帧 payload 长度为负
    NegativeSize(i32),
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Truncated { needed, available } => {
                write!(f, "数据不足：需要 {needed} 字节，实际 {available} 字节")
            }
            Self::InvalidUtf8 => write!(f, "字段不是合法 UTF-8"),
            Self::NegativeSize(size) => write!(f, "帧长度为负：{size}"),
        }
    }
}

impl std::error::Error for ParseError {}

/// 解码 64 字节设备名字段。
///
/// 服务端用 `getUtf8TruncationIndex` 截断到 63 字节并以 NUL 结尾，
/// 因此这里按「首个 NUL 截断」处理。
///
/// # Examples
///
/// ```
/// use scrcpy_protocol::decode_device_name;
///
/// let mut field = [0u8; 64];
/// field[..3].copy_from_slice("abc".as_bytes());
/// assert_eq!(decode_device_name(&field), "abc");
/// ```
pub fn decode_device_name(field: &[u8; DEVICE_NAME_FIELD_LENGTH]) -> String {
    let end = field.iter().position(|&b| b == 0).unwrap_or(field.len());
    // 服务端保证不会截断到多字节字符中间，但仍做一次容错
    String::from_utf8_lossy(&field[..end]).into_owned()
}

/// 大端读取器。
#[derive(Debug)]
pub struct BigEndianReader<'a> {
    data: &'a [u8],
    offset: usize,
}

impl<'a> BigEndianReader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, offset: 0 }
    }

    pub fn offset(&self) -> usize {
        self.offset
    }

    pub fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.offset)
    }

    pub fn is_empty(&self) -> bool {
        self.remaining() == 0
    }

    /// 取剩余全部字节。
    pub fn rest(&mut self) -> &'a [u8] {
        let out = &self.data[self.offset..];
        self.offset = self.data.len();
        out
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], ParseError> {
        if self.remaining() < n {
            return Err(ParseError::Truncated {
                needed: self.offset + n,
                available: self.data.len(),
            });
        }
        let out = &self.data[self.offset..self.offset + n];
        self.offset += n;
        Ok(out)
    }

    pub fn u8(&mut self) -> Result<u8, ParseError> {
        Ok(self.take(1)?[0])
    }

    pub fn u16(&mut self) -> Result<u16, ParseError> {
        let b = self.take(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }

    pub fn u32(&mut self) -> Result<u32, ParseError> {
        let b = self.take(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    pub fn i32(&mut self) -> Result<i32, ParseError> {
        Ok(self.u32()? as i32)
    }

    pub fn i64(&mut self) -> Result<i64, ParseError> {
        let b = self.take(8)?;
        Ok(i64::from_be_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
    }
}

/// 解析流元信息（16 字节大端：`codec_id`、`flags`、`width`、`height`）。
pub fn parse_stream_meta(data: &[u8]) -> Result<StreamMeta, ParseError> {
    let mut r = BigEndianReader::new(data);
    let codec_id = r.u32()?;
    let session_flags = r.u32()?;
    let width = r.u32()?;
    let height = r.u32()?;

    Ok(StreamMeta {
        codec: Codec::from_id(codec_id),
        width,
        height,
        client_resize: session_flags & SESSION_CLIENT_RESIZE != 0,
    })
}

/// 解析会话尺寸通知（12 字节大端：`flags`、`width`、`height`）。
pub fn parse_session_meta(data: &[u8]) -> Result<SessionMeta, ParseError> {
    let mut r = BigEndianReader::new(data);
    let flags = r.u32()?;
    let width = r.u32()?;
    let height = r.u32()?;

    Ok(SessionMeta {
        width,
        height,
        client_resize: flags & SESSION_CLIENT_RESIZE != 0,
    })
}

/// 构造会话尺寸通知字节（12 字节大端：`flags`、`width`、`height`）。
pub fn encode_session_meta(meta: SessionMeta) -> Vec<u8> {
    let mut out = Vec::with_capacity(SESSION_META_LENGTH);
    let mut flags = SESSION_FLAG;
    if meta.client_resize {
        flags |= SESSION_CLIENT_RESIZE;
    }
    out.extend_from_slice(&flags.to_be_bytes());
    out.extend_from_slice(&meta.width.to_be_bytes());
    out.extend_from_slice(&meta.height.to_be_bytes());
    out
}

/// 构造流元信息字节（测试与回放用）。
pub fn encode_stream_meta(meta: &StreamMeta) -> Vec<u8> {
    let mut out = Vec::with_capacity(STREAM_META_LENGTH);
    out.extend_from_slice(&meta.codec.id().to_be_bytes());
    let mut flags = SESSION_FLAG;
    if meta.client_resize {
        flags |= SESSION_CLIENT_RESIZE;
    }
    out.extend_from_slice(&flags.to_be_bytes());
    out.extend_from_slice(&meta.width.to_be_bytes());
    out.extend_from_slice(&meta.height.to_be_bytes());
    out
}

/// 会话元信息首 4 字节的标志位分布：`SESSION` 落在第 63 位，
/// 写进线上字节时恰好是**高 32 位的最高位**，所以首字节固定是 `0x80`。
pub const SESSION_META_PREFIX: u8 = 0x80;

/// 判断一个 8 字节前缀是不是会话元信息（而不是帧头）。
///
/// 只看向最高位：帧头的 `ptsAndFlags` 里第 63 位恒为 0。
pub fn is_session_meta_prefix(prefix: &[u8]) -> bool {
    prefix.len() >= 8 && prefix[0] & SESSION_META_PREFIX != 0
}

/// 解析一个完整的视频包（12 字节帧头 + payload）。
///
/// # Examples
///
/// ```
/// use scrcpy_protocol::{parse_video_packet, VideoPacket};
///
/// let mut raw = Vec::new();
/// raw.extend_from_slice(&1234i64.to_be_bytes()); // pts
/// raw.extend_from_slice(&2i32.to_be_bytes()); // size
/// raw.extend_from_slice(&[0xaa, 0xbb]);
///
/// let packet = parse_video_packet(&raw).unwrap();
/// assert_eq!(packet, VideoPacket::Frame { pts_us: 1234, is_key_frame: false, data: vec![0xaa, 0xbb] });
/// ```
pub fn parse_video_packet(raw: &[u8]) -> Result<VideoPacket, ParseError> {
    let mut r = BigEndianReader::new(raw);
    let pts_and_flags = r.i64()?;
    let size = r.i32()?;

    if size < 0 {
        return Err(ParseError::NegativeSize(size));
    }

    let payload = r.take(size as usize)?.to_vec();

    if pts_and_flags & flags::CONFIG != 0 {
        return Ok(VideoPacket::Config { data: payload });
    }

    Ok(VideoPacket::Frame {
        pts_us: (pts_and_flags & !flags::MASK) as u64,
        is_key_frame: pts_and_flags & flags::KEY_FRAME != 0,
        data: payload,
    })
}

/// 构造一个视频包（测试与回放用）。
pub fn encode_video_packet(packet: &VideoPacket) -> Vec<u8> {
    let (pts_and_flags, data) = match packet {
        VideoPacket::Config { data } => (flags::CONFIG, data.clone()),
        VideoPacket::Frame {
            pts_us,
            is_key_frame,
            data,
        } => {
            let mut v = *pts_us as i64;
            if *is_key_frame {
                v |= flags::KEY_FRAME;
            }
            (v, data.clone())
        }
    };

    let mut out = Vec::with_capacity(PACKET_HEADER_LENGTH + data.len());
    out.extend_from_slice(&pts_and_flags.to_be_bytes());
    out.extend_from_slice(&(data.len() as i32).to_be_bytes());
    out.extend_from_slice(&data);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 帧头标志位与服务端常量一致() {
        // Streamer.PACKET_FLAG_SESSION / CONFIG / KEY_FRAME
        assert_eq!(flags::SESSION, 1i64 << 63);
        assert_eq!(flags::CONFIG, 1i64 << 62);
        assert_eq!(flags::KEY_FRAME, 1i64 << 61);
        assert_eq!(SESSION_FLAG, 1u32 << 31, "session flags 只写低 32 位");
    }

    #[test]
    fn 解析普通帧() {
        let raw = encode_video_packet(&VideoPacket::Frame {
            pts_us: 42,
            is_key_frame: false,
            data: vec![1, 2, 3],
        });
        assert_eq!(raw.len(), 12 + 3);
        assert_eq!(
            parse_video_packet(&raw).unwrap(),
            parse_video_packet(&raw).unwrap()
        );
        assert_eq!(
            parse_video_packet(&raw).unwrap(),
            VideoPacket::Frame {
                pts_us: 42,
                is_key_frame: false,
                data: vec![1, 2, 3]
            }
        );
    }

    #[test]
    fn 解析关键帧_标志位为_bit61() {
        let packet = VideoPacket::Frame {
            pts_us: 7,
            is_key_frame: true,
            data: vec![],
        };
        let raw = encode_video_packet(&packet);

        // ptsAndFlags 大端存放，bit61 落在首字节的 0x20 位
        assert_eq!(raw[0] & 0x20, 0x20);
        assert_eq!(parse_video_packet(&raw).unwrap(), packet);
    }

    #[test]
    fn 配置包_标志位为_bit62_且无时间戳() {
        let packet = VideoPacket::Config {
            data: vec![0x67, 0x42],
        };
        let raw = encode_video_packet(&packet);

        assert_eq!(raw[0] & 0x40, 0x40, "bit62 应置位");
        assert_eq!(parse_video_packet(&raw).unwrap(), packet);
        assert!(packet.is_config());
        assert_eq!(packet.pts_ms(), None);
    }

    #[test]
    fn 时间戳不会与标志位混淆() {
        // 一个很大的 pts 也不应被误判成 config / key frame
        let packet = VideoPacket::Frame {
            pts_us: 0x003F_FFFF_FFFF_FFFF,
            is_key_frame: false,
            data: vec![9],
        };
        let parsed = parse_video_packet(&encode_video_packet(&packet)).unwrap();
        assert_eq!(parsed, packet);
    }

    #[test]
    fn 数据不足时报明确错误() {
        assert_eq!(
            parse_video_packet(&[0, 0, 0]),
            Err(ParseError::Truncated {
                needed: 8,
                available: 3
            })
        );
        // 头完整但 payload 被截断
        let mut raw = Vec::new();
        raw.extend_from_slice(&0i64.to_be_bytes());
        raw.extend_from_slice(&10i32.to_be_bytes());
        raw.extend_from_slice(&[1, 2]);
        assert_eq!(
            parse_video_packet(&raw),
            Err(ParseError::Truncated {
                needed: 22,
                available: 14
            })
        );
    }

    #[test]
    fn 负长度被拒绝() {
        let mut raw = Vec::new();
        raw.extend_from_slice(&0i64.to_be_bytes());
        raw.extend_from_slice(&(-1i32).to_be_bytes());
        assert_eq!(parse_video_packet(&raw), Err(ParseError::NegativeSize(-1)));
    }

    #[test]
    fn 设备名按首个_nul_截断() {
        let mut field = [0u8; 64];
        field[..10].copy_from_slice("Xiaomi MIX".as_bytes());
        assert_eq!(decode_device_name(&field), "Xiaomi MIX");
    }

    #[test]
    fn 设备名无_nul_时取满_64_字节() {
        let field = [b'x'; 64];
        assert_eq!(decode_device_name(&field).len(), 64);
    }

    #[test]
    fn 流元信息往返一致() {
        let meta = StreamMeta {
            codec: Codec::H264,
            width: 1080,
            height: 1920,
            client_resize: false,
        };
        let raw = encode_stream_meta(&meta);
        assert_eq!(raw.len(), STREAM_META_LENGTH);
        assert_eq!(
            &raw[..4],
            &0x6832_3634u32.to_be_bytes(),
            "H.264 的 codec id 是 ASCII \"h264\""
        );
        assert_eq!(&raw[4..8], &SESSION_FLAG.to_be_bytes());
        assert_eq!(parse_stream_meta(&raw).unwrap(), meta);
    }

    #[test]
    fn 会话元信息带客户端缩放标记() {
        let mut raw = Vec::new();
        raw.extend_from_slice(&(SESSION_FLAG | SESSION_CLIENT_RESIZE).to_be_bytes());
        raw.extend_from_slice(&720u32.to_be_bytes());
        raw.extend_from_slice(&1280u32.to_be_bytes());

        let meta = parse_session_meta(&raw).unwrap();
        assert_eq!(
            meta,
            SessionMeta {
                width: 720,
                height: 1280,
                client_resize: true
            }
        );
        assert_eq!(meta.width, 720);
    }

    #[test]
    fn 会话元信息缺失缩放标记时为_false() {
        let mut raw = Vec::new();
        raw.extend_from_slice(&SESSION_FLAG.to_be_bytes());
        raw.extend_from_slice(&1080u32.to_be_bytes());
        raw.extend_from_slice(&2400u32.to_be_bytes());

        assert!(!parse_session_meta(&raw).unwrap().client_resize);
    }

    #[test]
    fn 会话元信息前缀与帧头可区分() {
        // 旋转时服务端插的是 12 字节裸会话元信息，没有帧头
        let mut meta = Vec::new();
        meta.extend_from_slice(&SESSION_FLAG.to_be_bytes());
        meta.extend_from_slice(&2400u32.to_be_bytes());
        meta.extend_from_slice(&1080u32.to_be_bytes());
        assert!(is_session_meta_prefix(&meta[..8]));

        // 普通帧：pts 很小，高位全 0
        let mut frame = Vec::new();
        frame.extend_from_slice(&1_234_567i64.to_be_bytes());
        frame.extend_from_slice(&2i32.to_be_bytes());
        assert!(!is_session_meta_prefix(&frame[..8]));

        // config 包（1<<62）与关键帧（1<<61）都不是会话位
        let mut config = Vec::new();
        config.extend_from_slice(&flags::CONFIG.to_be_bytes());
        config.extend_from_slice(&2i32.to_be_bytes());
        assert!(!is_session_meta_prefix(&config[..8]));

        let mut key = Vec::new();
        key.extend_from_slice(&(flags::KEY_FRAME | 1000).to_be_bytes());
        key.extend_from_slice(&2i32.to_be_bytes());
        assert!(!is_session_meta_prefix(&key[..8]));
    }

    #[test]
    fn 编码器映射与往返() {
        // 线上是编码名的 ASCII FOURCC，不是枚举序号
        assert_eq!(Codec::H264.id(), u32::from_be_bytes(*b"h264"));
        assert_eq!(Codec::H265.id(), u32::from_be_bytes(*b"h265"));
        assert_eq!(Codec::from_id(Codec::H264.id()), Codec::H264);
        assert_eq!(Codec::from_id(Codec::H265.id()), Codec::H265);
        assert_eq!(Codec::from_id(Codec::Av1.id()), Codec::Av1);
        assert_eq!(Codec::from_id(0x6832_3634), Codec::H264, "实测值");
        assert_eq!(Codec::from_id(99), Codec::Unknown(99));
        assert_eq!(Codec::Unknown(99).id(), 99);

        for codec in [Codec::H264, Codec::H265, Codec::Av1, Codec::Vp8, Codec::Vp9] {
            assert_eq!(
                Codec::from_server_option(codec.server_option()),
                Some(codec)
            );
        }
        assert_eq!(Codec::from_server_option("hevc"), Some(Codec::H265));
        assert_eq!(Codec::from_server_option("nope"), None);
    }

    #[test]
    fn 读取器_大端且有边界检查() {
        let mut r = BigEndianReader::new(&[0x01, 0x02, 0x03, 0x04, 0x05]);
        assert_eq!(r.u16().unwrap(), 0x0102);
        assert_eq!(r.u16().unwrap(), 0x0304);
        assert_eq!(r.remaining(), 1);
        assert!(r.u16().is_err());
        assert_eq!(r.rest(), &[0x05]);
        assert!(r.is_empty());
    }

    #[test]
    fn 零长度帧合法() {
        let packet = VideoPacket::Frame {
            pts_us: 0,
            is_key_frame: true,
            data: vec![],
        };
        assert_eq!(
            parse_video_packet(&encode_video_packet(&packet)).unwrap(),
            packet
        );
    }
}
