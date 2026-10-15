//! scrcpy 4.1 控制消息编解码。
//!
//! 布局以服务端 `ControlMessageReader.java`（v4.1）为准，**小端**：
//!
//! ```text
//! INJECT_KEYCODE      u8 action, i32 keycode, i32 repeat, i32 metastate
//! INJECT_TEXT         u32 length, utf-8 bytes
//! INJECT_TOUCH_EVENT  u8 action, i64 pointerId, i32 x, i32 y,
//!                     u16 screenW, u16 screenH, i16 pressure, i32 actionButton, i32 buttons
//! INJECT_SCROLL_EVENT i32 x, i32 y, u16 screenW, u16 screenH,
//!                     i16 hScroll, i16 vScroll, i32 buttons
//! BACK_OR_SCREEN_ON   u8 action
//! GET_CLIPBOARD       u8 copyKey
//! SET_CLIPBOARD       i64 sequence, u8 paste, u32 length, utf-8 bytes
//! SET_DISPLAY_POWER   u8 on
//! RESIZE_DISPLAY      u16 width, u16 height
//! START_APP           u8 length, utf-8 bytes
//! ```
//!
//! 注意与视频流的**大端**相反。另外触摸的 `action` 是 `u8`（不是旧文档的 i64），
//! `pressure` 与 `scroll` 都是 16 位定点数。

use serde::{Deserialize, Serialize};

/// 控制消息类型（与服务端 `ControlMessage` 常量一一对应）。
pub mod msg_type {
    pub const INJECT_KEYCODE: u8 = 0x00;
    pub const INJECT_TEXT: u8 = 0x01;
    pub const INJECT_TOUCH_EVENT: u8 = 0x02;
    pub const INJECT_SCROLL_EVENT: u8 = 0x03;
    pub const BACK_OR_SCREEN_ON: u8 = 0x04;
    pub const EXPAND_NOTIFICATION_PANEL: u8 = 0x05;
    pub const EXPAND_SETTINGS_PANEL: u8 = 0x06;
    pub const COLLAPSE_PANELS: u8 = 0x07;
    pub const GET_CLIPBOARD: u8 = 0x08;
    pub const SET_CLIPBOARD: u8 = 0x09;
    pub const SET_DISPLAY_POWER: u8 = 0x0a;
    pub const ROTATE_DEVICE: u8 = 0x0b;
    pub const UHID_CREATE: u8 = 0x0c;
    pub const UHID_INPUT: u8 = 0x0d;
    pub const UHID_DESTROY: u8 = 0x0e;
    pub const OPEN_HARD_KEYBOARD_SETTINGS: u8 = 0x0f;
    pub const START_APP: u8 = 0x10;
    pub const RESET_VIDEO: u8 = 0x11;
    pub const CAMERA_SET_TORCH: u8 = 0x12;
    pub const CAMERA_ZOOM_IN: u8 = 0x13;
    pub const CAMERA_ZOOM_OUT: u8 = 0x14;
    pub const RESIZE_DISPLAY: u8 = 0x15;
    pub const SCAN_FILE: u8 = 0x16;
}

/// 定点数缩放因子（与服务端 `Binary` 一致）。
mod fixed {
    /// `i16FixedPointToFloat` 的分母 2^15，再乘 16 得到滚动量
    pub const SCROLL_SCALE: f32 = 2048.0;
}

/// 小端写入器。
#[derive(Debug, Default)]
struct Buf(Vec<u8>);

impl Buf {
    fn with_capacity(n: usize) -> Self {
        Self(Vec::with_capacity(n))
    }

    fn u8(&mut self, v: u8) -> &mut Self {
        self.0.push(v);
        self
    }

    fn u16(&mut self, v: u16) -> &mut Self {
        self.0.extend_from_slice(&v.to_be_bytes());
        self
    }

    fn i16(&mut self, v: i16) -> &mut Self {
        self.0.extend_from_slice(&v.to_be_bytes());
        self
    }

    fn i32(&mut self, v: i32) -> &mut Self {
        self.0.extend_from_slice(&v.to_be_bytes());
        self
    }

    fn i64(&mut self, v: i64) -> &mut Self {
        self.0.extend_from_slice(&v.to_be_bytes());
        self
    }

    fn utf8(&mut self, s: &str) -> &mut Self {
        self.0.extend_from_slice(s.as_bytes());
        self
    }

    fn bytes(&mut self, b: &[u8]) -> &mut Self {
        self.0.extend_from_slice(b);
        self
    }

    fn finish(&self) -> Vec<u8> {
        self.0.clone()
    }
}

/// Android `MotionEvent.ACTION_*`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TouchAction {
    Down,
    Up,
    Move,
    Cancel,
}

impl TouchAction {
    pub fn code(&self) -> u8 {
        match self {
            Self::Down => 0,
            Self::Up => 1,
            Self::Move => 2,
            Self::Cancel => 3,
        }
    }

    pub fn from_code(code: u8) -> Option<Self> {
        match code {
            0 => Some(Self::Down),
            1 => Some(Self::Up),
            2 => Some(Self::Move),
            3 => Some(Self::Cancel),
            _ => None,
        }
    }
}

/// 触摸事件。
///
/// `x`/`y` 必须是**设备原始像素坐标**，由渲染进程完成 CSS 像素 → 设备像素的换算。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TouchEvent {
    pub action: TouchAction,
    pub pointer_id: i64,
    pub x: i32,
    pub y: i32,
    pub screen_width: u16,
    pub screen_height: u16,
    /// 压力，取值 0..=1
    pub pressure: f32,
    /// 鼠标按键掩码
    pub buttons: i32,
}

impl TouchEvent {
    fn base(
        action: TouchAction,
        x: i32,
        y: i32,
        screen_width: u16,
        screen_height: u16,
        pressure: f32,
    ) -> Self {
        Self {
            action,
            pointer_id: 0,
            x,
            y,
            screen_width,
            screen_height,
            pressure,
            buttons: 0,
        }
    }

    pub fn down(x: i32, y: i32, screen_width: u16, screen_height: u16) -> Self {
        Self::base(TouchAction::Down, x, y, screen_width, screen_height, 1.0)
    }

    pub fn move_to(x: i32, y: i32, screen_width: u16, screen_height: u16) -> Self {
        Self::base(TouchAction::Move, x, y, screen_width, screen_height, 1.0)
    }

    pub fn up(x: i32, y: i32, screen_width: u16, screen_height: u16) -> Self {
        Self::base(TouchAction::Up, x, y, screen_width, screen_height, 1.0)
    }

    /// 鼠标悬停：压力为 0，设备端不显示触摸圈。
    pub fn hover(x: i32, y: i32, screen_width: u16, screen_height: u16) -> Self {
        Self::base(TouchAction::Move, x, y, screen_width, screen_height, 0.0)
    }
}

/// 滚动事件。`h_scroll` / `v_scroll` 取值范围约为 `-16.0 ..= 16.0`。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScrollEvent {
    pub x: i32,
    pub y: i32,
    pub screen_width: u16,
    pub screen_height: u16,
    pub h_scroll: f32,
    pub v_scroll: f32,
}

/// Android `KeyEvent.ACTION_*`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyAction {
    Down,
    Up,
}

impl KeyAction {
    pub fn code(&self) -> u8 {
        match self {
            Self::Down => 0,
            Self::Up => 1,
        }
    }
}

/// 按键事件。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyEvent {
    pub action: KeyAction,
    pub keycode: i32,
    pub repeat: i32,
    pub metastate: i32,
}

/// 触摸的动作按钮标记。
const AMOTION_EVENT_ACTION_DOWN: i32 = 1;
const AMOTION_EVENT_ACTION_UP: i32 = 2;

/// 编码触摸事件。
///
/// # Examples
///
/// ```
/// use scrcpy_protocol::control::{encode_touch, TouchEvent};
///
/// let bytes = encode_touch(&TouchEvent::down(100, 200, 1080, 2400));
/// assert_eq!(bytes[0], 0x02);
/// assert_eq!(bytes.len(), 1 + 1 + 8 + 4 + 4 + 2 + 2 + 2 + 4 + 4);
/// assert_eq!(bytes[1], 0);                       // action = ACTION_DOWN
/// assert_eq!(&bytes[2..10], &0i64.to_be_bytes()); // pointerId
/// assert_eq!(&bytes[10..14], &100i32.to_be_bytes());
/// assert_eq!(&bytes[14..18], &200i32.to_be_bytes());
/// ```
pub fn encode_touch(event: &TouchEvent) -> Vec<u8> {
    let action_button = match event.action {
        TouchAction::Down => AMOTION_EVENT_ACTION_DOWN,
        TouchAction::Up => AMOTION_EVENT_ACTION_UP,
        _ => 0,
    };

    let mut buf = Buf::with_capacity(32);
    buf.u8(msg_type::INJECT_TOUCH_EVENT)
        .u8(event.action.code())
        .i64(event.pointer_id)
        .i32(event.x)
        .i32(event.y)
        .u16(event.screen_width)
        .u16(event.screen_height)
        .i16(to_fixed_u16(event.pressure))
        .i32(action_button)
        .i32(event.buttons);
    buf.finish()
}

/// 编码滚动事件。
pub fn encode_scroll(event: &ScrollEvent) -> Vec<u8> {
    let mut buf = Buf::with_capacity(19);
    buf.u8(msg_type::INJECT_SCROLL_EVENT)
        .i32(event.x)
        .i32(event.y)
        .u16(event.screen_width)
        .u16(event.screen_height)
        .i16(to_fixed_i16(event.h_scroll))
        .i16(to_fixed_i16(event.v_scroll))
        .i32(0);
    buf.finish()
}

/// 编码按键事件。
pub fn encode_key(event: &KeyEvent) -> Vec<u8> {
    let mut buf = Buf::with_capacity(14);
    buf.u8(msg_type::INJECT_KEYCODE)
        .u8(event.action.code())
        .i32(event.keycode)
        .i32(event.repeat)
        .i32(event.metastate);
    buf.finish()
}

/// 编码文本输入（长度前缀为 4 字节）。
pub fn encode_text(text: &str) -> Vec<u8> {
    let mut buf = Buf::with_capacity(5 + text.len());
    buf.u8(msg_type::INJECT_TEXT)
        .i32(text.len() as i32)
        .utf8(text);
    buf.finish()
}

/// 编码剪贴板写入。
///
/// `paste` 为 true 时设备端会直接把内容粘贴出去。
pub fn encode_clipboard(sequence: i64, paste: bool, text: &str) -> Vec<u8> {
    let mut buf = Buf::with_capacity(14 + text.len());
    buf.u8(msg_type::SET_CLIPBOARD)
        .i64(sequence)
        .u8(u8::from(paste))
        .i32(text.len() as i32)
        .utf8(text);
    buf.finish()
}

/// 请求剪贴板内容。`copy_key` 为 0 表示普通读取。
pub fn encode_get_clipboard(copy_key: u8) -> Vec<u8> {
    let mut buf = Buf::with_capacity(2);
    buf.u8(msg_type::GET_CLIPBOARD).u8(copy_key);
    buf.finish()
}

/// 启动指定应用（长度前缀为 1 字节）。
pub fn encode_start_app(package: &str) -> Vec<u8> {
    let bytes = package.as_bytes();
    let len = bytes.len().min(0xff) as u8;
    let mut buf = Buf::with_capacity(2 + len as usize);
    buf.u8(msg_type::START_APP)
        .u8(len)
        .bytes(&bytes[..len as usize]);
    buf.finish()
}

/// 请求重置视频流（分辨率变化后让服务端重新协商）。
pub fn encode_reset_video() -> Vec<u8> {
    vec![msg_type::RESET_VIDEO]
}

/// 请求重新扫描媒体文件。
pub fn encode_scan_file(path: &str) -> Vec<u8> {
    let mut buf = Buf::with_capacity(5 + path.len());
    buf.u8(msg_type::SCAN_FILE)
        .i32(path.len() as i32)
        .utf8(path);
    buf.finish()
}

/// 无载荷的控制消息。
pub fn encode_simple(kind: u8) -> Vec<u8> {
    vec![kind]
}

/// 开关屏幕。
pub fn encode_display_power(on: bool) -> Vec<u8> {
    let mut buf = Buf::with_capacity(2);
    buf.u8(msg_type::SET_DISPLAY_POWER).u8(u8::from(on));
    buf.finish()
}

/// 请求把画面缩放到指定尺寸（客户端侧渲染缩放）。
pub fn encode_resize_display(width: u16, height: u16) -> Vec<u8> {
    let mut buf = Buf::with_capacity(5);
    buf.u8(msg_type::RESIZE_DISPLAY).u16(width).u16(height);
    buf.finish()
}

/// 返回 / Home 组合键。
pub fn encode_back_or_screen_on(action_down: bool) -> Vec<u8> {
    let mut buf = Buf::with_capacity(2);
    buf.u8(msg_type::BACK_OR_SCREEN_ON)
        .u8(u8::from(action_down));
    buf.finish()
}

/// 压力值 → `Binary.u16FixedPointToFloat` 的定点表示。
///
/// 服务端解码规则是 `value == 0xffff ? 1.0 : value / 65536`，
/// 因此 1.0 必须显式编码成 `0xffff` 而不是 `0x10000`。
fn to_fixed_u16(value: f32) -> i16 {
    let clamped = value.clamp(0.0, 1.0);
    let scaled = (clamped * 65536.0).round();
    // 0x10000 溢出成 0，必须夹到 0xffff（服务端的「满量程」哨兵）
    scaled.clamp(0.0, 65535.0) as u16 as i16
}

/// 滚动量 → `i16FixedPointToFloat × 16` 的定点表示。
fn to_fixed_i16(value: f32) -> i16 {
    let scaled = (value * fixed::SCROLL_SCALE).round();
    scaled.clamp(i16::MIN as f32, i16::MAX as f32) as i16
}

/// 视频编码参数（供上层选择解码器）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoCodecInfo {
    pub codec: crate::stream::Codec,
    pub profile: u32,
    pub level: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 触摸事件_布局与服务端读取顺序一致() {
        let bytes = encode_touch(&TouchEvent::down(100, 200, 1080, 2400));

        assert_eq!(bytes[0], 0x02, "type");
        assert_eq!(bytes[1], 0, "action = ACTION_DOWN（u8）");
        assert_eq!(&bytes[2..10], &0i64.to_be_bytes(), "pointerId");
        assert_eq!(&bytes[10..14], &100i32.to_be_bytes(), "x");
        assert_eq!(&bytes[14..18], &200i32.to_be_bytes(), "y");
        assert_eq!(&bytes[18..20], &1080u16.to_be_bytes(), "screenW（无符号）");
        assert_eq!(&bytes[20..22], &2400u16.to_be_bytes(), "screenH");
        assert_eq!(
            &bytes[22..24],
            &(-1i16).to_be_bytes(),
            "pressure=1.0 → 0xffff"
        );
        assert_eq!(&bytes[24..28], &1i32.to_be_bytes(), "actionButton = DOWN");
        assert_eq!(&bytes[28..32], &0i32.to_be_bytes(), "buttons");
        assert_eq!(bytes.len(), 32);
    }

    #[test]
    fn 鼠标悬停压力为零() {
        let touch = encode_touch(&TouchEvent::hover(10, 20, 1080, 2400));
        assert_eq!(&touch[22..24], &0i16.to_be_bytes());

        let real = encode_touch(&TouchEvent::move_to(10, 20, 1080, 2400));
        assert_eq!(&real[22..24], &(-1i16).to_be_bytes());
        assert_eq!(touch[1], real[1], "动作一致");
    }

    #[test]
    fn 抬起时_action_与按钮标记变化() {
        let down = encode_touch(&TouchEvent::down(1, 1, 100, 100));
        let up = encode_touch(&TouchEvent::up(1, 1, 100, 100));

        assert_eq!(down[1], 0);
        assert_eq!(up[1], 1);
        assert_eq!(&down[24..28], &1i32.to_be_bytes());
        assert_eq!(&up[24..28], &2i32.to_be_bytes());
    }

    #[test]
    fn 触摸动作编码() {
        assert_eq!(TouchAction::Down.code(), 0);
        assert_eq!(TouchAction::Up.code(), 1);
        assert_eq!(TouchAction::Move.code(), 2);
        assert_eq!(TouchAction::Cancel.code(), 3);
        assert_eq!(TouchAction::from_code(2), Some(TouchAction::Move));
        assert_eq!(TouchAction::from_code(9), None);
    }

    #[test]
    fn 压力定点编码() {
        assert_eq!(to_fixed_u16(1.0), -1i16, "0xffff 作为 i16 看起来是 -1");
        assert_eq!(to_fixed_u16(0.0), 0);
        assert_eq!(
            to_fixed_u16(0.5),
            -32768i16,
            "0.5 × 0xffff 四舍五入到 0x8000，作为 i16 即 -32768"
        );
        assert_eq!(to_fixed_u16(2.0), -1i16, "超量程应被夹取");
        assert_eq!(to_fixed_u16(-1.0), 0, "负值应被夹取");
    }

    #[test]
    fn 滚动定点编码() {
        assert_eq!(to_fixed_i16(1.0), 2048);
        assert_eq!(to_fixed_i16(-1.0), -2048);
        assert_eq!(to_fixed_i16(0.0), 0);
        assert_eq!(to_fixed_i16(100.0), i16::MAX, "超量程应被夹取");
    }

    #[test]
    fn 滚动事件布局() {
        let event = ScrollEvent {
            x: 100,
            y: 200,
            screen_width: 1080,
            screen_height: 2400,
            h_scroll: 0.0,
            v_scroll: -1.0,
        };
        let bytes = encode_scroll(&event);

        assert_eq!(bytes[0], 0x03);
        assert_eq!(bytes.len(), 1 + 4 + 4 + 2 + 2 + 2 + 2 + 4);
        assert_eq!(&bytes[1..5], &100i32.to_be_bytes());
        assert_eq!(&bytes[13..15], &0i16.to_be_bytes(), "hScroll");
        assert_eq!(&bytes[15..17], &(-2048i16).to_be_bytes(), "vScroll");
    }

    #[test]
    fn 按键事件布局() {
        let bytes = encode_key(&KeyEvent {
            action: KeyAction::Down,
            keycode: 4,
            repeat: 0,
            metastate: 0,
        });

        assert_eq!(bytes[0], 0x00);
        assert_eq!(bytes.len(), 1 + 1 + 4 + 4 + 4);
        assert_eq!(bytes[1], 0, "action = ACTION_DOWN（u8）");
        assert_eq!(&bytes[2..6], &4i32.to_be_bytes(), "keycode = BACK");
    }

    #[test]
    fn 文本消息使用_4_字节长度前缀() {
        let bytes = encode_text("hi");
        assert_eq!(bytes[0], 0x01);
        assert_eq!(&bytes[1..5], &2i32.to_be_bytes());
        assert_eq!(&bytes[5..], b"hi");
    }

    #[test]
    fn 文本消息支持_unicode() {
        let bytes = encode_text("随手记");
        assert_eq!(&bytes[1..5], &9i32.to_be_bytes());
        assert_eq!(&bytes[5..], "随手记".as_bytes());
    }

    #[test]
    fn 剪贴板消息带序号与粘贴标志() {
        let bytes = encode_clipboard(7, true, "abc");
        assert_eq!(bytes[0], 0x09);
        assert_eq!(&bytes[1..9], &7i64.to_be_bytes());
        assert_eq!(bytes[9], 1, "paste");
        assert_eq!(&bytes[10..14], &3i32.to_be_bytes());
        assert_eq!(&bytes[14..], b"abc");
    }

    #[test]
    fn 启动应用使用_1_字节长度前缀() {
        let bytes = encode_start_app("com.example");
        assert_eq!(bytes[0], 0x10);
        assert_eq!(bytes[1], 11);
        assert_eq!(&bytes[2..], b"com.example");
    }

    #[test]
    fn 超长包名被截断到_255_字节() {
        let long = "x".repeat(300);
        let bytes = encode_start_app(&long);
        assert_eq!(bytes[1], 0xff);
        assert_eq!(bytes.len(), 2 + 255);
    }

    #[test]
    fn 简单消息只有类型字节() {
        assert_eq!(encode_simple(msg_type::BACK_OR_SCREEN_ON), vec![0x04]);
        assert_eq!(
            encode_simple(msg_type::EXPAND_NOTIFICATION_PANEL),
            vec![0x05]
        );
        assert_eq!(encode_simple(msg_type::EXPAND_SETTINGS_PANEL), vec![0x06]);
        assert_eq!(encode_simple(msg_type::COLLAPSE_PANELS), vec![0x07]);
        assert_eq!(encode_simple(msg_type::ROTATE_DEVICE), vec![0x0b]);
        assert_eq!(encode_reset_video(), vec![0x11]);
    }

    #[test]
    fn 返回键消息带按下状态() {
        assert_eq!(encode_back_or_screen_on(true), vec![0x04, 1]);
        assert_eq!(encode_back_or_screen_on(false), vec![0x04, 0]);
    }

    #[test]
    fn 读取剪贴板与屏幕开关() {
        assert_eq!(encode_get_clipboard(0), vec![0x08, 0]);
        assert_eq!(encode_display_power(true), vec![0x0a, 1]);
        assert_eq!(encode_display_power(false), vec![0x0a, 0]);
    }

    #[test]
    fn 调整画面尺寸() {
        assert_eq!(
            encode_resize_display(720, 1280),
            vec![0x15, 0x02, 0xd0, 0x05, 0x00]
        );
    }

    #[test]
    fn 扫描文件使用_4_字节长度前缀() {
        let bytes = encode_scan_file("/sdcard/a.mp4");
        assert_eq!(bytes[0], 0x16);
        assert_eq!(&bytes[1..5], &13i32.to_be_bytes());
        assert_eq!(&bytes[5..], b"/sdcard/a.mp4");
    }
}
