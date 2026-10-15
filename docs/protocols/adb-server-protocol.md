# adb server 协议笔记

> 面向实现。本文所有「实测」结论均来自 **Platform Tools 37.0.0 / adb 1.0.41（Windows）**
> 配 **Xiaomi MIX 2S / Android 13**，与文档不符处以实测为准并回填本文件。
>
> 权威来源：<https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/daemon/file_sync_protocol.h>

## 1. 连接模型

adb client 不直接与设备通信，而是连到本机 **adb server**（默认 `127.0.0.1:5037`），
server 再通过 USB / TCP 与设备上的 **adbd** 通信。

一次典型交互：

```
client ──connect──► adb server
       ──► "host:transport:<serial>"   切换后续流量到某台设备
       ──► "shell:<cmd>"               执行 shell
       ◄── "OKAY" + 原始 stdout 字节流
```

## 2. 请求格式（实测）

```text
"%04x" + service
```

- 长度是 **service 的字节数**。
- **结尾没有 `\n`**。

> ⚠️ 踩坑：按「长度 + `\n`」的写法发送，adb server 会返回
> `FAIL unknown host service 'devices-l\0'`。
> 多数第三方实现（含若干 LLM 生成的代码）都会在这里写错。

响应：

```text
OKAY                       成功，无负载
OKAY + "%04x" + payload    成功，有负载
FAIL + "%04x" + reason     失败；reason 带 NUL 结尾，展示前应 trim 掉
```

## 3. 连接生命周期：**一条连接只服务一次操作**

> ⚠️ 这是自研 adb 客户端最容易踩、也最难自查的坑。实测结果：

| 请求 | 服务端行为 |
| --- | --- |
| `host:version` | 返回 `OKAY00040029` 后**关闭连接** |
| `host:devices-l` | 返回列表后**关闭连接** |
| `host:connect:` / `host:disconnect:` | 返回结果后关闭连接 |
| `host:transport:<serial>` | **不关闭**，把连接切到「设备模式」 |
| `shell:<cmd>` | 返回输出流，执行完关闭连接 |
| `sync:` | 子命令流结束后关闭连接 |

即：**一条 TCP 连接只能承载「一次 host 服务」或「一次 `host:transport:` + 一次设备服务」**。

复用连接的客户端在第二次请求时会读到 EOF，
症状是「第一次成功、第二次报 `early eof`」——因为服务端早已关闭。

因此本项目：

- `AdbClient` **不持有**连接，每次公开方法都向 `TransportFactory` 索取一条新连接；
- 本机回环 TCP 建连成本极低（< 1ms），远比「省一条连接但偶尔读到脏状态」划算；
- 单测里的 `MockFactory` **只提供一条连接**，第二次 `connect()` 直接报错，
  把这条协议约束固化成可执行的测试
  （`adb-client` 的 `每次操作都会新建连接` 用例）。

## 4. 设备选择：必须用 `host:transport:`

> ⚠️ 实测：**`host-serial:<serial>:shell:…` 会返回 `unknown host service`。**

正确做法是在**同一条连接**上依次发送：

```text
host:transport:<serial>   → OKAY
shell:<cmd>               → OKAY + 输出流
sync:                     → OKAY + sync 子协议
```

`host:transport:<serial>` 失败时返回 `FAIL device '<serial>' not found`，
应映射为「设备不存在」而不是「协议错误」。

## 4. host 服务

| 请求 | 响应 |
| --- | --- |
| `host:version` | `OKAY` + `"0004"` + 4 字节小端版本号（实测 41） |
| `host:devices-l` | `OKAY` + `"%04x"` + 设备列表 |
| `host:track-devices` | `OKAY` 后**持续**推送 `"%04x"` + 设备记录 |
| `host:connect:<addr>` | `OKAY` + 结果文本 |
| `host:disconnect:<serial>` | `OKAY` + 结果文本 |
| `host:transport:<serial>` | `OKAY` 或 `FAIL` |
| `host:kill` | `OKAY` |

## 5. 设备列表有两种格式（实测）

### `host:devices-l` → 长格式，**空格**分隔

```text
d4535f72               device product:polaris model:MIX_2S device:polaris transport_id:5
```

serial 与 state 之间是一串空格，其后是 `key:value` 属性。
**不是**制表符——这是最容易写错的地方。

### `host:track-devices` → 短格式，**制表符**分隔

```text
d4535f72\tdevice
```

推送的每条记录都带 4 位十六进制长度前缀，长度 = `serial.len() + 1 + state.len() + 1`。
长度字段为 0 表示「所有设备都消失了」。

> 解析器必须同时容忍制表符与空白分隔，并对第二个 token 之后的 `k:v` 做属性解析。

## 6. 设备状态取值

| 状态 | 含义 |
| --- | --- |
| `device` | 就绪 |
| `offline` | 已连接但无法通信 |
| `unauthorized` | 设备上未确认 USB 调试授权 |
| `connecting` / `authorizing` | 建立连接 / 无线调试授权中 |
| `bootloader` / `recovery` / `sideload` / `host` | 特殊模式 |
| `no` | 无权限（Windows 驱动问题） |

adb 会随版本新增状态，**不认识的状态必须归入 `unknown` 而不是报错**，
否则整个设备列表会不可用。

## 7. shell 服务与退出码

`shell:<cmd>` 的响应体是原始字节流，**没有退出码通道**，且 stdout 与 stderr 被合并。

本项目的做法是在命令尾部追加哨兵：

```sh
( <cmd> ); __ac_rc=$?; printf '\n<token>%s' "$__ac_rc"
```

两个细节都是踩出来的：

1. **必须用子 shell `( )` 包住原命令**。否则 `exit 42` 会直接结束整个 shell，
   后面的哨兵根本没机会执行 —— 表现为「永远拿不到退出码」。
2. **必须先存后打**。写成 `printf ... "$?"` 会拿到**前一条 `printf`** 的退出码（恒为 0）。
   正确顺序是 `__ac_rc=$?` 紧跟在原命令之后。

解析时：

1. 找哨兵**最后一次**出现的位置（命令自身可能输出同样内容）；
2. stdout = 该位置之前、最后一个换行符之前的部分；
3. 退出码 = 紧随其后的十进制数字。

**必须等哨兵和退出码数字都到齐才能判定结束**：
TCP 分片可能让哨兵先到、退出码后到，提前结束会得到「空退出码」。
本项目在读循环里用 `exit_code()` 做完整性判定。

超时：协议层面无法取消，只能客户端主动断开。断开后连接已关闭（无需额外处理），
把结果标记为 `timed_out` 即可。

## 8. sync 服务（文件传输）

握手 `sync:` 得到 `OKAY` 后进入子命令流。

### 8.1 命令 id 是 4 字节 ASCII magic

```c
#define MKID(a, b, c, d) ((a) | ((b) << 8) | ((c) << 16) | ((d) << 24))
#define ID_LSTAT_V1 MKID('S', 'T', b'A', 'T')   // 线上就是 "STAT"
#define ID_LIST_V1  MKID('L', 'I', 'S', 'T')   // "LIST"
#define ID_SEND_V1  MKID('S', 'E', 'N', 'D')   // "SEND"
#define ID_RECV_V1  MKID('R', 'E', 'C', 'V')   // "RECV"
#define ID_DENT_V1  MKID('D', 'E', 'N', 'T')   // "DENT"
#define ID_DONE     MKID('D', 'O', 'N', 'E')   // "DONE"
#define ID_DATA     MKID('D', 'A', 'T', 'A')   // "DATA"
#define ID_OKAY     MKID('O', 'K', 'A', 'Y')   // "OKAY"
#define ID_FAIL     MKID('F', 'A', 'I', 'L')   // "FAIL"
```

> ⚠️ 最大的坑：这些**不是** 1/2/3/4 这种小整数。
> 实测把 `1..=12` 全部试了一遍，设备一律返回
> `FAIL unknown command 0000000N`，而且连接随即关闭。

### 8.2 请求是定长头 + 路径

```c
struct SyncRequest { uint32 id; uint32 path_length; } __attribute__((packed));
// 后跟 path_length 字节路径（无 NUL 结尾）；path_length 上限 1024
```

### 8.3 记录布局

| 结构 | 字段 |
| --- | --- |
| `stat_v1` | `id mode size mtime` |
| `dent_v1` | `id mode size mtime namelen` + `name[namelen]` |
| `data` | `id size` + `size` 字节数据 |
| `status` | `id msglen` + `msglen` 字节消息（仅 `FAIL` 时有） |

### 8.4 握手节奏

- **`STAT`**：请求发完直接回 16 字节 `stat_v1`。adbd 对 `lstat` 失败**不报错**，
  而是回全零 → `mode == 0` 表示「不存在」。
- **`LIST`**：直接回一串 `dent_v1`，以 `DONE` + 4 个零 u32 结束。
  目录不存在时同样只回 `DONE`（空列表），**不会**回 `FAIL`。
- **`SEND`**：路径格式是 `"<path>,<mode>"`（`mode` 为十进制可被 `strtoul(base=0)` 解析）。
  设备创建文件后**不会**先回 `OKAY`——客户端直接发 `DATA`/`DONE`，
  全部发完才收到**一个** `OKAY`（或失败时的 `FAIL`）。
  注意：**每块数据后没有单独的确认**。
- **`RECV`**：**没有** `OKAY` 握手，失败直接 `FAIL`，成功直接是 `DATA` 流，
  以 `DONE` 结束。

分块大小上限 64 KiB（设备端 `SYNC_DATA_MAX`）。

## 9. 端口转发（投屏依赖）

`host:transport:<serial>` 之后发 `host:<serial>:forward:<local>;<remote>`
（forward 属于 host 侧，因此要先选设备）。

scrcpy 使用 `forward tcp:PORT localabstract:scrcpy`，
之后客户端连 `127.0.0.1:PORT`。这条通道的响应是**裸字节流**，没有 `OKAY`/`FAIL` 行。

## 10. 其他实测坑位

- `FAIL` 的原因串带 NUL 结尾，展示前必须 `trim_end_matches('\0')`。
- 设备休眠会掉线，`devices-l` 里条目消失或变 `offline`；`adb reconnect offline` 有时能救回。
- Windows 上 `adb devices` CLI 的输出用制表符，而协议层的 `devices-l` 用空格，
  两者不要互相印证。
- 设备重启后串号可能变化（本机 MIX 2S 掉线重连后仍是 `d4535f72`，
  但无线调试一定会变）。
## 11. `reverse` 的特殊之处（实测于 adb 1.0.41 / Platform Tools 37）

`reverse` 与 `forward` 在协议层面有两处根本差异，踩错过代价很大：

### 11.1 服务名不同

| 操作 | 服务名 |
| --- | --- |
| forward | `host-serial:<serial>:forward:<local>;<remote>` |
| reverse 建 | `host:tport:serial:<serial>` 然后 `reverse:forward:<remote>;<local>` |
| reverse 删 | `host:tport:serial:<serial>` 然后 `reverse:killforward:<remote>` |
| reverse 列 | `host:tport:serial:<serial>` 然后 `reverse:list-forward` |

- **没有** `host-serial:<serial>:reverse:…`，实测返回
  `FAIL unknown host service 'reverse:…'`。
- 选设备必须用 `host:tport:serial:<serial>`。用 `host:transport:<serial>`
  虽然能拿到 `OKAY`，但 `reverse` 随即以
  `FAIL device offline (no transport)` 失败。

### 11.2 响应字节不一样

逐字节实测（十六进制）：

```text
host:tport:serial:<serial>  → 4f4b4159 "OKAY" + 01000000 + 00000000
reverse:forward:<r>;<l>     → 4f4b4159 "OKAY" + 4f4b4159 "OKAY"
reverse:killforward:<r>     → 4f4b4159 "OKAY" + 4f4b4159 "OKAY"
reverse:list-forward        → 4f4b4159 "OKAY" + "3030" + 负载（ASCII 十六进制长度前缀）
```

注意 `host:tport:` 后面跟的是 **8 字节二进制尾巴**，不是 host 服务惯用的
ASCII 十六进制长度前缀——按 `read_length_prefixed` 读会报
「长度字段包含非法字符」。

### 11.3 顺序必须是「先 reverse 后 forward」

`host:transport:<serial>` + `reverse:<remote>;<local>` 会让 **Windows 版 adb server
直接崩溃**（进程消失，后续连接全部 `ECONNREFUSED`）。
用正确的 `host:tport:serial:` + `reverse:forward:` 则完全正常。

### 11.4 `adb reverse` 的方向

`adb reverse <remote> <local>` 中，`remote` 是**设备侧**，`local` 是**主机侧**。
所以要让设备端连出、主机监听，应当是：

```bash
adb reverse localabstract:scrcpy_<scid> tcp:<hostport>
```

`adb reverse --list` 会显示成 `UsbFfs localabstract:… tcp:…`。
用 USB 连接时走的是 `UsbFfs` 传输，主机**不需要**、也不能再去连 `127.0.0.1:<port>`。

对照实验（写错方向时的症状）：

```bash
adb reverse tcp:28120 localabstract:scrcpy_xxx   # ← 方向反了
# 设备监听 tcp:28120 并转发到主机 localabstract:…，主机连 127.0.0.1:28120 得到 ECONNREFUSED
```