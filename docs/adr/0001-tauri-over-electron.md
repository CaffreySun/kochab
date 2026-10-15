# ADR-0001：桌面框架选型（Tauri 2 而非 Electron）

- 状态：已采纳
- 日期：2026-10-14

## 背景

产品需要跨 Windows / macOS 的桌面应用，核心能力是与 adb server 通信、维持长连接、
把 H.264 码流送进界面。候选：Electron、Tauri 2、Flutter、Qt。

## 决策

采用 **Tauri 2 + Rust 后端 + React 渲染进程**。

## 理由

1. **装机体积与内存**。Electron 每个应用携带一份 Chromium；本项目常驻后台并维持视频流，
   Tauri 使用系统 WebView，安装包小一个数量级。
2. **后端语言匹配问题域**。adb/scrcpy 本质是「字节协议 + 长连接 + 进程管理」，
   Rust 在这一层的心智负担与内存安全保证都优于 Node。
3. **前端仍是标准 Web**。TDesign、React、Vitest 生态可直接使用，UI 迭代不受影响。

## 代价与缓解

| 代价 | 缓解 |
| --- | --- |
| macOS 使用 WKWebView，WebCodecs 需 Safari 16.4+ | `bundle.macOS.minimumSystemVersion = 13.0`；WebCodecs 能力在 `session_start` 前探测，不支持时给出明确提示 |
| 需要额外的系统前置（C++ Build Tools / Xcode CLT） | `pnpm bootstrap` 显式检查并给出安装指引 |
| Rust 学习成本 | 领域层接口刻意做窄，UI 侧团队可先独立推进 |

## 备选方案

- **Electron**：WebCodecs 无兼容顾虑、开发体验统一，但体积与内存代价不可接受。
- **Flutter / Qt**：UI 一致性更好，但无法复用 TDesign，与「使用 TDesign 设计系统」的要求冲突。