# ADR-0004：自研 adb server 协议客户端

- 状态：已采纳
- 日期：2026-10-14

## 背景

设备列举、应用管理、文件传输全部依赖 adb。可选路径：

1. 调用 `adb` 可执行文件并解析 stdout；
2. 使用 npm 上的 adb 库（`@devicefarmer/adbkit`、`adbkit-promises`、`node-adb` 等）；
3. 直接实现 adb server 的 socket 协议。

## 决策

在 `crates/adb-client` 中**直接实现 adb server 协议**（`127.0.0.1:5037`），
只依赖系统里存在的 `adb` 可执行文件（用于必要时启动 server 与定位 SDK）。

实现的服务：

| 服务 | 请求格式 | 用途 |
| --- | --- | --- |
| `host:devices-l` / `host:track-devices` | 4 位十六进制长度 + 负载 | 设备发现与变更监听 |
| `host:connect:<addr>` / `host:disconnect:<serial>` | 同上 | 无线设备 |
| `host:transport:<serial>` | 同上 | 把后续连接切换到指定设备 |
| `host:transport-any` | 同上 | shell / sync 用的通用通道 |
| `shell:<cmd>` | 1 位长度 + 负载 | 执行 shell |
| `sync:` | 子命令序列 | push / pull / stat / list |

## 理由

1. **可测试**。协议是纯字节；自己实现后，传输层可注入 `AsyncRead/AsyncWrite`，
   单元测试能对请求字节与响应解析做精确断言，CI 无需设备。
2. **零运行时依赖**。npm 库会引入数十个传递依赖，跨平台边缘行为（路径转义、
   Windows CRLF、并发流控）需要额外验证。
3. **错误可控**。adb server 的 `FAIL` 响应、超时、半关闭连接都能映射为具名错误，
   而不是散落各处的字符串匹配。
4. **长期稳定**。adb server 协议多年未变；第三方库反而是更不稳定的依赖。

## 代价

- 需要自己维护对 `sync:` 子命令与 Android 版本差异的了解。
- 需要保证与不同 Platform Tools 版本兼容，靠真机集成测试覆盖。

## 备选方案

- **拉起 `adb` 子进程解析 stdout**：简单，但 `sync:`（文件传输）无法通过 stdout 高效传输，
  且大文件需要额外临时文件；错误只能靠退出码与 stderr 文本推断。
- **`@devicefarmer/adbkit`**：API 友好，但传输层不可注入，难以做协议级单测。