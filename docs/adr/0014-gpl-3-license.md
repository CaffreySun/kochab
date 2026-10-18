# 0014 采用 GPL-3.0-only 许可证

- 日期：2026-10-18
- 状态：已接受

## 背景

Kochab 准备开源。项目是完整的桌面应用（Tauri + Rust + React），不是希望被闭源产品直接吸纳的基础库；需要一份明确的 copyleft 许可证。

## 决策

采用 **GPL-3.0-only**。

- `LICENSE` 放 GNU GPL v3 完整文本；
- Cargo workspace 与各 npm 包的 `license` 字段统一写 SPDX 标识 `GPL-3.0-only`；
- README 的「许可」章节指向 `LICENSE`；
- 不采用 AGPL：当前没有网络服务端；如果未来提供托管服务并希望网络使用也回馈源码，再单独评估 AGPL。

## 后果

- 分发修改版二进制时，必须按 GPLv3 提供对应源码与许可证信息；
- 衍生作品需继续使用 GPLv3，不能直接闭源；
- 现有依赖（React、TDesign、Tauri、Rust crates 等）的 MIT/Apache-2.0 许可证与 GPLv3 兼容；
- 这是项目层面的许可证选择，不构成对第三方依赖或商标的法律意见。
