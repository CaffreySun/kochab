# scrcpy 设备端 server（v4.1）

来源：<https://github.com/Genymobile/scrcpy/releases/download/v4.1/scrcpy-server-v4.1>

| 项 | 值 |
| --- | --- |
| 版本 | 4.1 |
| 大小 | 733706 字节 |
| SHA-256 | `deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae` |

scrcpy 4.x 的 Windows / macOS 发行包里**不再附带**这个文件——服务端 jar 被嵌进了
可执行本体。我们需要独立的一份，因此直接从 release 资产取。

## 为什么提交进仓库

投屏会话每次启动都要把它 push 到 `/data/local/tmp/scrcpy-server.jar`。
运行时联网下载会带来两个问题：首次启动要等、离线环境直接不可用。
733 KB 换取确定性的启动路径是划算的。

## 版本必须与协议层一致

`crates/scrcpy-protocol` 的 `SUPPORTED_VERSION` 就是 `"4.1"`，
设备端 server 会用它校验版本；不一致时服务端直接拒绝启动。
升级 scrcpy 协议时，这个文件和 `SUPPORTED_VERSION` 要一起换。

## 不要下发 `cleanup=true`

服务端带 `cleanup=true` 时，它的 CleanUp 线程会在会话结束后
`unlink` 掉 `/data/local/tmp/scrcpy-server.jar`。
本项目每次会话都会重新 push，所以自清理只会制造竞态——
下一次会话刚推上去的 jar 可能被上一个会话的 CleanUp 删掉，
表现为 `ClassNotFoundException: com.genymobile.scrcpy.Server`。

## 校验

```bash
# Windows
(Get-FileHash assets/scrcpy-server-v4.1 -Algorithm SHA256).Hash.ToLower()

# macOS / Linux
shasum -a 256 assets/scrcpy-server-v4.1
```