# 架构

## 1. 设计目标

1. **可嵌入的投屏**：scrcpy 官方不提供嵌入第三方窗口的能力，画面必须能长在本应用的界面里，
   并且能叠加自己的控制层（音量键、返回键、FPS 指示等）。
2. **可测试**：adb 与 scrcpy 都是「字节协议 + 外部进程」。二者必须能与真实网络/设备解耦，
   使绝大部分逻辑能在没有设备、没有 Android SDK 的 CI 上被验证。
3. **跨 Windows / macOS**：不依赖任何平台专有 API，所有路径处理、进程调用、端口转发
   走统一抽象。
4. **UI 与能力解耦**：即使把 Tauri 换成 Electron，领域层也不需要改一行。

## 2. 分层

```
┌──────────────────────────────────────────────────────────────┐
│  apps/desktop  src/            渲染进程（React + TDesign）    │
│    ├─ pages/                  设备 / 应用 / 文件 / 投屏      │
│    ├─ features/               业务状态（hooks）                │
│    ├─ ipc/                    Transport 抽象 + 契约封装        │
│    └─ @ac/ui, @ac/scrcpy-web                                  │
└───────────────────────────┬──────────────────────────────────┘
                            │ Tauri IPC（命令 / 事件）
┌───────────────────────────┴──────────────────────────────────┐
│  apps/desktop  src-tauri/src/commands/   命令层（薄）          │
│    · 参数校验 · 错误码翻译 · 事件广播                          │
└───────────────────────────┬──────────────────────────────────┘
┌───────────────────────────┴──────────────────────────────────┐
│  crates/  领域层（不依赖 Tauri，可独立测试）                    │
│  ├─ android-core     设备 / 应用 / 文件 / 工具链                │
│  ├─ scrcpy-session   会话生命周期                               │
│  ├─ scrcpy-protocol  字节编解码                                 │
│  └─ adb-client       adb server 协议                           │
└───────────────────────────┬──────────────────────────────────┘
              ┌─────────────┴─────────────┐
              ▼                           ▼
      adb server (127.0.0.1:5037)     Android 设备
              │                      app_process + scrcpy-server
              └──────────────┬───────────┘
                             ▼
                    本地 TCP 转发端口
```

**依赖方向是单向的**：渲染进程 → 命令层 → 领域层 → 协议层。
任何一层都不得反向引用上层。领域层里出现 `tauri::` 即为违规。

## 3. crate 职责与边界

| crate | 负责 | 不负责 |
| --- | --- | --- |
| `adb-client` | adb server 四类服务的请求/响应字节；连接管理；设备选择 | shell 命令语义、应用解析、文件操作语义 |
| `android-core` | 把字节协议提升为「列出应用」「安装 APK」这类产品能力；错误文案；工具链定位 | 投屏 |
| `scrcpy-protocol` | 握手、设备元数据、控制消息的字节布局 | socket、adb、超时 |
| `scrcpy-session` | 推送 server、建反向隧道、进程启动、流泵、控制通道、会话状态机 | 字节布局细节 |

### 为什么 adb 与 scrcpy 都自己写

- 第三方 adb 库（如 `@devicefarmer/adbkit`）体量大、跨平台边缘行为多、且难以做单元测试；
  自己实现后，传输层可注入，协议层可断言精确字节。
- scrcpy 没有可嵌入的客户端库，现成实现要么拉起独立窗口（体验割裂），要么是浏览器方案
  （无法访问本机 adb）。详见 [ADR-0005](adr/0005-self-implemented-scrcpy-protocol.md)。

## 4. 投屏数据流

```
[设备] MediaCodec(H.264) ──► scrcpy-server ──► reverse 隧道（设备侧 abstract socket）
                                                      │
                                                      ▼
                          [Rust] scrcpy-session 拆包
                             │  ① 读 64B device name
                             │  ② 读 codec id（ASCII FOURCC）+ 12B 会话尺寸
                             ▼
                    之后是连续的 [12B 帧头][payload]
                             │
         ┌───────────────────┴───────────────────┐
         ▼                                       ▼
    config 包（SPS/PPS）                     帧（Annex-B）
    经 session://video 广播                   经 session://video 广播
         │                                       │
         └───────────────────┬───────────────────┘
                             ▼
              [渲染进程] Annex-B → AVCC 转换
                   + AVCDecoderConfigurationRecord
                             ▼
                    WebCodecs VideoDecoder
                             ▼
                        <canvas>
```

隧道方向：`tunnel_forward=false` + `adb reverse`，**服务端主动连出**，
本机监听并接住视频、控制两条连接。详见
[协议笔记](protocols/scrcpy-protocol.md)。

### 关键决策：Rust 不解码视频

Rust 侧只做拆包与转发，把**压缩后**的字节交给渲染进程用 WebCodecs 解码。

- 若 Rust 解码再传原始帧：1080×2400 RGBA ≈ 10 MB/帧，30fps 就是 300 MB/s 的 IPC 流量，不可行。
- 传压缩帧：单帧几 KB 到几十 KB，IPC 开销可忽略，且能用上系统硬解码。

两个实现细节值得记下来：

1. **负载用 base64**。Tauri 事件负载走 JSON，`Vec<u8>` 会被序列化成数字数组
   （约 4 倍膨胀），base64 只有 1.33 倍，且前端一次 `atob` 就能拿回字节。
2. **Annex-B → AVCC 的转换在渲染进程做**。服务端下发的是 Annex-B，
   而 WebCodecs 的 H.264 解码要求 `description`（`AVCDecoderConfigurationRecord`）
   与 AVCC 长度前缀。转换是纯函数，放在 `@ac/scrcpy-web` 里并且有单测。

代价是 **macOS WKWebView 需要 Safari 16.4+**（WebCodecs 首发版本），因此 `bundle.macOS.minimumSystemVersion`
固定为 13.0。详见 [ADR-0006](adr/0006-video-decoding-in-renderer.md)。

### 控制消息方向

渲染进程把「语义事件」（触摸 / 按键 / 文本 / 滚轮）通过
`session_touch` / `session_key` / `session_text` / `session_scroll` 发到 Rust，
**由 Rust 用 `scrcpy-protocol` 编码**后写入控制 socket。

之所以不在渲染进程编码字节：那会让同一份字节布局有 Rust 与 TS 两处实现，
而两者只能靠人工保持同步。现在字节布局的唯一实现仍然是 `scrcpy-protocol`，
前端只负责「点击 → 设备像素坐标」这种它天然掌握的事情
（`@ac/scrcpy-web` 的 `clientPointToDevice`）。

## 5. IPC 契约

```
packages/ipc-contract/src/
├─ commands.ts   命令名 + 参数类型映射
├─ events.ts     事件名
└─ types.ts      传输数据结构
```

约束：

1. 新增命令必须先在 `commands.ts` 登记，否则 Rust 侧有测试会失败（双向比对）。
2. Rust 侧数据结构统一 `#[serde(rename_all = "camelCase")]`，与 TS 字段名逐字对齐。
3. 领域错误在 `CommandError::from(CoreError)` 中翻译为稳定错误码（snake_case），
   前端按错误码分支，文案可以随时改。

## 6. 状态管理原则

- **设备列表是事件驱动的**：adb server 的 `host:track-devices` 推送变化，
  Rust 侧监听后广播 `device://changed`，前端不做轮询。
- **投屏会话是命令式的**：会话是有状态的（视频流、控制 socket、统计），
  以 `session_start` / `session_stop` 显式控制，前端持有 `sessionId`。
- **文件浏览是请求式的**：路径即状态，可分享、可前进后退。
- **设备详情是独立窗口**：主窗口只负责设备列表与缩略图，
  投屏 / 应用 / 文件各自开一个窗口（标签 `device-<serial>-<tab>`，
  重复点击聚焦已有窗口）。用同一个前端产物 + 查询串区分形态，
  见 [ADR 0009](adr/0009-independent-device-windows-and-session-priority.md)。
- **同一设备只有一条会话，按优先级抢占**：设备端 abstract socket 独占，
  卡片缩略图（`PREVIEW_PRIORITY`）与投屏窗口（`MIRROR_PRIORITY`）会争抢。
  低优先级不允许抢高优先级，否则两边交替黑屏。
  **绝不能复用已有会话**：SPS/PPS 只在建连时下发一次，后来者永远配不出解码器。
- **投屏参数跨窗口共享靠 `localStorage`**（`ac.mirrorOptions`）：投屏窗口是独立
  webview，由设置页写入、窗口启动时读取；`maxSize=0` 表示不下发 `max_size`，
  即跟随设备原始分辨率。
- **设备分组与任务历史也只落地在本地**（`ac.deviceGroups` / `ac.tasks`）：
  它们只是列表组织方式与执行记录，不进入 Rust 命令面。
- **批量操作走全局任务队列**（`TasksProvider`）：批量命令没有原子性，
  与其在按钮上谎报成功，不如把每台结果摊到任务页，由用户自己看哪台失败。

## 7. 扩展点

| 想做的事 | 改哪里 |
| --- | --- |
| 新增平台 | `crates/android-core/src/toolchain.rs`（工具链定位）；其余不变 |
| 新增设备属性 | `crates/android-core/src/device.rs` 的属性采集表 + `ipc-contract/types.ts` |
| 新增控制消息 | `scrcpy-protocol`（编码）+ `@ac/scrcpy-web`（触发）+ 协议笔记 |
| 换设计系统 | `@ac/ui` + `packages/ui/src/styles/index.css` 的语义令牌 |
| 新增文件操作 | `android-core/src/file.rs` + `commands.ts` 登记 |

## 8. 已知边界

- 仅支持 `device` 状态为就绪的设备做投屏；`offline` / `unauthorized` 会给出明确提示。
- 音频转发不在当前范围内（scrcpy 音频需要额外的协议分支与设备端编码器支持）。
- 无线设备首次连接需要设备端开启「无线调试」，本产品只负责发起连接。
- 不处理 Android 多用户（`--user` 参数）以外的权限模型差异；未 root 设备无法访问 `/data/data`。
- 同一台设备被投屏窗口占用时，卡片缩略图显示「投屏占用中」；关闭投屏窗口后
  缩略图会按退避重试**自动恢复**预览，不需要手动刷新。
  窗口销毁时由 Rust 侧 `on_window_event` 兜底停止该窗口发起的会话：
  前端在窗口被直接关闭时不保证能跑到 React 的清理函数，只靠前端会漏掉
  设备端的 scrcpy 进程与反向隧道，其他消费方就永远拿不到这台设备。