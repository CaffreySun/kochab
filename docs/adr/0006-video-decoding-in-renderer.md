# ADR-0006：视频解码放在渲染进程

- 状态：已采纳
- 日期：2026-10-14

## 背景

投屏链路中，H.264 码流从设备到画面之间有三种放置解码器的位置：
Rust（后端）、渲染进程（WebCodecs）、外部进程（原生 scrcpy）。

## 决策

Rust 只做拆包与转发，**不解码**；把压缩后的字节通过 Tauri 事件送到渲染进程，
由 WebCodecs `VideoDecoder` 解码后绘制到 `<canvas>`。

## 理由

1. **数据量决定了唯一可行解**。1080×2400 RGBA 原始帧约 10 MB；30fps 即 300 MB/s。
   经 Tauri IPC 传原始帧在任何平台上都不可行。而压缩帧单帧仅数 KB。
2. **能用系统硬解码**。WebCodecs 在 Chromium 与 WebKit 上均映射到平台的媒体解码器，
   CPU 占用远低于软件解码。
3. **Rust 侧保持纯粹**。协议 crate 里不引入 ffmpeg / openh264 等重量依赖，
   保持可测试与可交叉编译。

## 代价

- **macOS 最低版本被抬高**：WKWebView 的 WebCodecs 需 Safari 16.4+，
  因此 `bundle.macOS.minimumSystemVersion = 13.0`。
- 需要处理编解码器协商失败、设备旋转导致的分辨率变化、解码器 reset 等边界。
- 前端要维护帧缓冲与背压逻辑（`@ac/scrcpy-web` 的职责）。

## 缓解

- 投屏开始前做能力探测（`typeof VideoDecoder !== 'undefined'`），
  不支持时给出明确的升级提示而不是白屏。
- 控制消息走独立通道，**不依赖视频链路**，
  因此即使解码失败，返回/主页/音量等按键仍然可用，会话不会彻底不可用。

## 备选方案

- **Rust 侧用 `openh264` / `ffmpeg` 解码**：可行但要引入 C 依赖与交叉编译配置，
  且 IPC 带宽不可接受。
- **透传到原生 scrcpy 窗口**：等于放弃 ADR-0005 的收益。