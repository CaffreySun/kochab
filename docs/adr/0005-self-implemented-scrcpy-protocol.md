# ADR-0005：自研 scrcpy 客户端协议

- 状态：已采纳
- 日期：2026-10-14

## 背景

scrcpy 官方客户端是 C + SDL 的桌面程序，`scrcpy-server` 是设备端的 Java 程序。
scrcpy **没有提供可供第三方嵌入的客户端 API 或窗口句柄**。

## 决策

在 `crates/scrcpy-protocol` + `crates/scrcpy-session` 中实现 scrcpy 客户端协议：

1. `adb push` 把随包分发的 `scrcpy-server` 推到 `/data/local/tmp/`（路径带 scid）；
2. `adb reverse` 建立设备 Unix socket（`localabstract:scrcpy_<scid>`）→ 本机 TCP 的隧道，
   由**本机监听**（`tunnel_forward=false`，服务端主动连出）；
3. `adb shell` 以 `app_process` 启动设备端 server（必须 `setsid` 脱离会话，
   且类名后第一个参数必须是协议版本）；
4. **客户端不发送任何握手数据**：服务端连过来后先发 64 字节设备名，
   再发 codec id（ASCII FOURCC）与会话尺寸；
5. 之后在视频连接上收帧，在控制连接上收发控制消息。

## 理由

1. **可嵌入是硬需求**。产品要求屏幕显示在应用界面内，并能叠加自定义控制层。
   拉起原生 `scrcpy.exe` 只会得到一个独立的 SDL 窗口，与 TDesign 界面割裂，
   且无法做悬浮按键、画质调节、录制等集成功能。
2. **协议本身稳定且有文档**。scrcpy 官方维护协议文档与版本号；
   字节布局可在 `scrcpy-protocol` 中固化为纯函数 + 单元测试。
3. **控制通道与视频通道分离**。视频只出不进，控制只进不出，Rust 侧可分别处理，
   不会互相阻塞。

## 代价

- 必须跟随 scrcpy 的协议版本演进。缓解：`scrcpy-protocol` 显式声明支持的版本常量，
  不匹配时返回 `UnsupportedVersion` 而不是行为异常。
- 设备端 server 文件需要随应用分发。缓解：
  定位顺序 `SCRCPY_SERVER_PATH` 环境变量 → scrcpy 安装目录 → `vendor/scrcpy-server`，
  由 `pnpm doctor` 一键诊断。

## 备选方案

- **拉起原生 scrcpy 进程**：零开发量，但用户体验割裂，无法定制 UI。
- **ws-scrcpy / STF 等开源实现**：以浏览器方案为主，需要额外的 WebSocket 服务层，
  且与我们自研 adb 客户端的能力重复。