# 开发流程

## 第一次

```bash
corepack enable     # 启用 pnpm
pnpm bootstrap      # 装依赖 + 检查 Tauri 前置条件
pnpm doctor         # 确认 adb / scrcpy-server / 设备
pnpm verify         # 确认工具链全绿，再开始写代码
```

## 日常

```bash
pnpm dev            # Tauri 开发模式（Vite HMR + Rust 热重启）
pnpm dev:web        # 只启动渲染进程（浏览器预览模式，使用模拟数据）
pnpm verify:fix     # 自动修格式与可自动修复的 lint
```

## 提交前

```bash
pnpm verify                    # 必过
pnpm test:device               # 改了 adb / scrcpy / 设备相关逻辑时必过
```

## 加一个功能的标准流程

1. **想清楚放哪一层**：UI？领域？协议？见 [ARCHITECTURE.md §2](ARCHITECTURE.md)。
2. **先写契约**：需要新命令就先在 `packages/ipc-contract/src/commands.ts` 登记。
3. **先写测试**：协议/解析类改动先写测试再写实现。
4. **实现**：`adb-client` → `android-core` → `commands` → UI，自下而上。
5. **校验 + 评审**：对照 [ENGINEERING.md §10](ENGINEERING.md#10-代码评审清单)。

## 加一个依赖

先确认「能不能不用」——adb 与 scrcpy 相关能力本项目一律自研（见 ADR-0004 / ADR-0005）。
确认需要时：

1. 在根 `pnpm-workspace.yaml` 的 catalog 中登记版本；
2. 在 `Cargo.toml` 的 `[workspace.dependencies]` 中登记版本（Rust 同理）；
3. 在 ADR 里补一段「为什么自研不划算」。

## 报告问题

请附上：

- `pnpm doctor` 的完整输出
- 操作系统版本（Windows 版本号 / macOS 版本号）
- 设备型号与 Android 版本
- `adb version` / `scrcpy --version`
- 相关日志（`RUST_LOG=debug pnpm dev`）