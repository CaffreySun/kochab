# Android Controller

跨平台 Android 设备管理与实时投屏控制软件。

- **设备列表**：实时感知 USB / 无线 / 模拟器设备，插拔即更新
- **无线调试**：一键 `tcpip` 并连接同一台设备，也可切回 USB
- **截屏 / 录屏**：PNG 截图与 MP4 录屏直接落到系统「下载」目录
- **应用管理**：列举、搜索、安装、卸载、清数据、启动
- **实时投屏**：基于 scrcpy 协议，画面直接嵌入应用窗口，支持触摸 / 键盘 / 滚轮 / 剪贴板
- **文件管理**：浏览设备目录，拖拽上传下载

技术栈：Tauri 2（Rust） + React 18 + TDesign + 自研 adb 客户端 + 自研 scrcpy 协议客户端。
支持 Windows 10+ 与 macOS 13+。

---

## 快速开始

```bash
corepack enable                 # 启用 pnpm（首次）
pnpm bootstrap                  # 安装依赖 + 检查 Tauri 前置条件
pnpm doctor                     # 诊断 adb / scrcpy-server / 已连接设备
pnpm dev                        # 启动开发模式
pnpm verify                     # 跑全量校验（格式/静态/类型/测试/构建）
```

带真机跑集成测试：

```bash
pnpm test:device                # 自动挑选第一台就绪设备
pnpm test:device -- --serial d4535f72
```

> `pnpm doctor` 会告诉你缺什么、怎么补。设备相关问题先看它。

## 投屏是怎么工作的

投屏不是拉起 `scrcpy.exe` 窗口，而是自己实现客户端协议，把画面渲染在应用界面里：

```
设备 scrcpy-server ──adb reverse──► Rust 拆包 ──事件──► 渲染进程 WebCodecs ──► <canvas>
```

- Rust 只拆包转发**压缩后**的字节（H.264 Annex-B），解码在渲染进程用系统硬解码完成；
- 渲染进程把 Annex-B 转成 AVCC 并构造 `AVCDecoderConfigurationRecord` 后交给 `VideoDecoder`；
- 交互（触摸 / 按键 / 文本 / 滚轮）以**语义命令**发到 Rust，由 Rust 统一编码协议字节，
  保证字节布局只有一处实现。

因此 macOS 需要 **13.0+**（WebCodecs 从 Safari 16.4 起可用）。

协议细节与踩坑记录见 [docs/protocols/scrcpy-protocol.md](docs/protocols/scrcpy-protocol.md)。

## 目录结构

```
.
├─ apps/
│  └─ desktop/            # Tauri 应用：渲染进程（React + TDesign）+ src-tauri（命令层）
├─ crates/                # Rust 领域层，可脱离 UI 独立测试
│  ├─ adb-client/         # adb server 协议（host/transport/shell/sync）
│  ├─ android-core/       # 设备 / 应用 / 文件 / 工具链定位
│  ├─ scrcpy-protocol/    # scrcpy 协议编解码（纯字节层）
│  └─ scrcpy-session/     # 投屏会话编排
├─ packages/              # 前端工作区包
│  ├─ ipc-contract/       # Rust ↔ 渲染进程的契约（命令名 / 事件名 / 数据类型）
│  ├─ ui/                 # TDesign 共享展示组件
│  └─ scrcpy-web/         # WebCodecs 解码与输入映射
├─ docs/                  # 架构、工程规范、测试策略、ADR、协议笔记
└─ scripts/               # Harness 脚本（bootstrap / doctor / verify / dev）
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 分层架构、数据流、投屏链路、扩展点 |
| [docs/ENGINEERING.md](docs/ENGINEERING.md) | 目录约定、命名、依赖管理、代码规范、提交规范 |
| [docs/TESTING.md](docs/TESTING.md) | 测试分层、真机测试、覆盖率门禁 |
| [docs/adr/](docs/adr/) | 架构决策记录（为什么这么选，以及放弃了什么） |
| [docs/protocols/](docs/protocols/) | adb / scrcpy 协议笔记与踩坑记录 |

## 许可

MIT