# 测试策略

## 1. 分层

| 层 | 工具 | 覆盖对象 | 是否需要设备 |
| --- | --- | --- | --- |
| 协议层单测 | `cargo test`（crate 内 `#[cfg(test)]`） | adb / scrcpy 字节布局、解析器、编解码 | 否 |
| 领域层单测 | `cargo test` | 应用列表解析、文件条目解析、路径校验、错误映射 | 否 |
| 传输层测试 | `cargo test` + 内存 mock socket | 请求拼装、响应解析、错误分支 | 否 |
| 渲染层单测 | Vitest | 纯函数（坐标映射、按键映射、手势归一化） | 否 |
| 组件测试 | Vitest + Testing Library | UI 交互、状态流转、错误展示 | 否 |
| 应用级测试 | Vitest + mock Transport | 页面数据流、空态/错误态 | 否 |
| 真机集成测试 | `cargo test` + `ANDROID_TEST_DEVICE` | 端到端设备能力、投屏握手 | **是** |

**设计要求**：越靠上的层越依赖真实环境，因此业务逻辑必须尽量下沉。
任何一段逻辑如果只能在有设备时验证，就是分层出了问题。

## 2. 常规命令

```bash
pnpm test                 # 全部 JS + Rust 单测
pnpm test -- --only rust  # 仅 Rust
pnpm test:coverage        # 前端覆盖率 + 门禁
pnpm test:device          # 真机集成测试（自动挑选设备）
pnpm test:device -- --serial d4535f72 --filter scrcpy
```

## 3. 真机测试的启用方式

设备集成测试**默认安全跳过**：`cargo test` 在没有 `ANDROID_TEST_DEVICE` 环境变量时
会把相关用例标记为跳过而不是失败，保证任何人的 `pnpm test` 都是绿的。

```rust
// crates/android-core/src/testing.rs
pub fn device_serial() -> Option<String> {
    std::env::var("ANDROID_TEST_DEVICE").ok().filter(|s| !s.is_empty())
}
```

`pnpm test:device` 会执行 `adb devices -l`，挑第一台 `state=device` 的设备，
注入 `ANDROID_TEST_DEVICE` 后运行 `cargo test --workspace`。

CI 中可手动触发带设备的 job（自托管 runner）。

## 4. 覆盖率门禁

`vitest.shared.ts` 配置了 v8 覆盖率阈值：

| 指标 | 阈值 |
| --- | --- |
| lines | 70% |
| functions | 70% |
| branches | 60% |
| statements | 70% |

Rust 侧不强制数值门槛，但 `cargo clippy -- -D warnings` 与 `cargo test` 必须是硬门禁。

## 5. 测试编写要求

### 协议层

- **断言精确字节**。例如控制消息编码后必须等于某个字节序列，
  而不是「包含某些字段」。协议错一位就是设备行为异常，必须精确到字节。
- 覆盖：正常、空、越界（声明长度大于实际）、非法枚举值、UTF-8 非法序列。

### 解析层

- `pm list -f` / `dumpsys` 这类命令的输出在不同 Android 版本上差异巨大，
  必须用**多个真实样本**做 fixture，且 fixture 要写明来源设备与 Android 版本。
- 解析失败必须返回可读错误，不能 `unwrap`。

### 组件层

- 用 `getByRole` / `getByLabelText` 查询，不要用 class 选择器。
- 测试名称写成行为描述：`「设备未就绪时禁用所有动作」`，而不是 `「renders correctly」`。
- 每个组件至少覆盖：正常态、空态、错误态、禁用态。

**已知的例外**：TDesign 的 `Switch` 不输出 `aria-checked`，因此
`getByRole('switch', { checked: true })` 永远匹配不到——断言开关状态只能用
`.t-switch` + `t-is-checked` 这类 class 判据（见 `pages.test.tsx` 的 `SettingsPage` 用例）。
这是组件库的无障碍缺口，不是可以靠改写测试绕开的问题。

TDesign 组件的**按钮文案随语言包变化**，对话框/弹层的确认按钮不要用
`getByRole('button', { name: '确定' })` 去猜：由调用方显式传 `confirmBtn` / `cancelBtn`
（`DevicesPage` 的分组对话框即如此），测试才能稳定按 `role` 查询。

### 真机测试

- 只做**只读或可回滚**的操作（列举、读取、截图、启动后再 force-stop）。
- 会改设备状态的用例（安装、卸载、删除文件）必须使用一次性资源名，
  并在结束时清理。
- 不得依赖设备的初始状态；需要特定前置条件的用例先自行准备。
- 用 `pnpm test:device` 运行，默认**串行**（`--test-threads 1`）：
  所有用例共用同一台设备，并行会抢编码器与设备端临时文件，结果随机失败。
  确实需要并行时用 `pnpm test:device -- --test-threads 4` 显式打开。
- 投屏用例覆盖到「建立会话 → 连续收到 H.264 config/关键帧 → 注入触摸」，
  并对帧做**协议级断言**（起始码、非空、尺寸一致），而不是只看有没有报错。
- 应用导出用例只读设备：导出到 `tempfile` 临时目录后校验**文件确实落盘、
  大小与返回值一致、文件名符合落盘规则**（单文件用建议名、多文件保留原名），
  不在设备上产生任何写入。

## 6. 已知的测试债

- 视频画面的**像素级**校验尚未实现：目前断言到「H.264 帧格式正确且连续到达」，
  还不比对解码后的图像内容。