# scrcpy 协议笔记

> 本项目对接 **scrcpy 4.1**。
> 本文记录的是**在 Xiaomi MIX 2S（Android 10）上实测**的行为，
> 权威来源是 [scrcpy v4.1 服务端源码](https://github.com/Genymobile/scrcpy/tree/v4.1/server)。
>
> ⚠️ **官方 `doc/develop.md` 已经过时**：它描述的控制消息布局（i64 触摸动作、
> 视频流首字节 config 标志等）与 v4.1 完全不符。遇到冲突时以源码为准。

## 1. 拓扑：必须用 `adb reverse`，不能用 `adb forward`

真实 scrcpy 4.1 客户端建立的是：

```bash
adb reverse localabstract:scrcpy_<scid> tcp:<hostport>
```

然后**主机 `listen`**，设备端 `tunnel_forward=false` 主动连出。

服务端 `DesktopConnection.open` 的两条分支：

| `tunnel_forward` | 设备端行为 | dummy byte | 主机角色 |
| --- | --- | --- | --- |
| `true` | `LocalServerSocket.accept()` | **发**（只发第一条 socket） | `adb forward` 后主动 `connect` |
| `false` | `LocalSocket.connect()` | **不发** | `adb reverse` 后 `accept` |

**实测结论**：在 adb 1.0.41 + Windows 上，`adb forward` + `tunnel_forward=true`
会让服务端卡在第二次 `accept()` 上——视频连接正常（能收到 dummy byte），
控制连接也到了设备端（`/proc/net/unix` 能看到第二个 connected socket），
但服务端就是不再往下走。`adb reverse` 拓扑则完全正常。

因此本项目**统一使用 reverse 拓扑**。

### accept 顺序

服务端固定按 `video → audio → control` 顺序建立连接。
Android 11 以下不支持音频（`Audio disabled: it is not supported before Android 11`），
但 `audio` 默认是 `true`，所以**必须显式下发 `audio=false`**，
否则会多出一条永远读不到东西的连接。

## 2. 启动参数

`app_process / com.genymobile.scrcpy.Server <版本> <key=value>…`

只有第一个是位置参数（客户端版本），其余全是 `key=value`。
这与 scrcpy 1.x/2.x 的「一长串位置参数」完全不同。

```
4.1 tunnel_forward=false video=true audio=false control=true
   scid=<8位小写十六进制> send_device_meta=true send_stream_meta=true
   send_frame_meta=true
   max_fps=60 max_size=1080 video_bit_rate=8000000
   stay_awake=true show_touches=false
```

> ⚠️ `args[0]` 必须是**协议版本号**，不能省。漏掉它服务端会把 `scid=…`
> 当成版本号，解析失败后**静默退出**——表现为隧道建好了却没有任何连接进来，
> 客户端最后握手超时。

> ⚠️ `video_bit_rate` 的单位是 **bit/s**，不是 Mbps。写 `8000` 会被当成
> 8 kbps，编码器起不来。

### 已实测踩到的坑

| 现象 | 原因 |
| --- | --- |
| `Unknown server option: mirror` | 服务端选项叫 `display_mirror`，且 4.1 已不再识别 `mirror` |
| `Unknown server option: display_mirror` | 4.1 干脆没有这个选项，直接别下发 |
| `Unknown server option: bit_rate` | 正确的名字是 `video_bit_rate` |
| `Missing client version` / 静默退出 | `args[0]` 必须是版本号 |
| `NumberFormatException: For input string: "a161382e"` | scid 虽然是十六进制，但 `Integer.parseInt(value, 0x10)` 结果必须落在 **31 位**内；`0xa161382e` = 27 亿 > `i32::MAX` |
| `ClassNotFoundException: com.genymobile.scrcpy.Server` | 上一条会话带 `cleanup=true` 会删掉 jar，下次必须重新 push |
| 服务端起了又没连回来 | 后台进程继承了 `adb shell` 的会话，shell 一退出就被 SIGHUP。必须 `setsid` + `</dev/null` 真正脱离 |

**结论：不要下发 `cleanup=true`。** 我们每次会话都重新 push server，
自清理只会制造竞态。

## 3. 视频流布局（大端）

客户端**不发送任何握手数据**——服务端从不读客户端。

### 编码格式 id 是 ASCII FOURCC

`Streamer.writeVideoHeader` 写的是 `VideoCodec.getId()`，它是编码名的
**4 字节 ASCII**（`VideoCodec.java`），**不是** 0/1/2 的枚举序号：

| 编码 | id（十六进制） | 字面量 |
| --- | --- | --- |
| H.264 | `0x68323634` | `"h264"` |
| H.265 | `0x68323635` | `"h265"` |
| AV1 | `0x00617631` | `"\0av1"` |
| VP8 | `0x00767038` | `"\0vp8"` |
| VP9 | `0x00767039` | `"\0vp9"` |

### `tunnel_forward=false`（我们使用的拓扑）

```text
[64B] device name      send_device_meta=true
[u32] codec id         send_stream_meta=true（ASCII FOURCC）
[u32] session flags    send_stream_meta=true，固定 bit31 = 1
[u32] width
[u32] height
─── 之后循环 ───
[i64] ptsAndFlags
[i32] packetSize
[..] payload
```

`Streamer.writeSessionMeta` 写的是 **12 字节裸数据**（不是带帧头的包），
而且只在 `send_stream_meta=true` 时才写。**`send_stream_meta` 必须开**，
否则客户端根本拿不到 codec 与分辨率，无法建解码器、也无法换算触摸坐标。

### `tunnel_forward=true`

在 64 字节设备名**之前**多一个 dummy byte（`send_dummy_byte` 默认 `true`，
且只发在第一条被 accept 的 socket 上，即视频连接）。

### 帧头标志位

```java
PACKET_FLAG_SESSION  = 1L << 63
PACKET_FLAG_CONFIG   = 1L << 62   // 包内是 SPS/PPS，不是画面
PACKET_FLAG_KEY_FRAME = 1L << 61
```

⚠️ 之前笔记里的「bit63 = CONFIG、bit62 = KEY_FRAME」是错的。

## 4. 控制消息布局（大端）

`ControlMessageReader` 用 `DataInputStream`，**默认大端**——
控制消息和视频流一样是大端，之前按小端实现是错的。

```text
INJECT_KEYCODE       u8 action, i32 keycode, i32 repeat, i32 metastate
INJECT_TEXT          u32 length, utf-8
INJECT_TOUCH_EVENT   u8 action, i64 pointerId,
                     i32 x, i32 y, u16 screenW, u16 screenH,
                     i16 pressure, i32 actionButton, i32 buttons
INJECT_SCROLL_EVENT  i32 x, i32 y, u16 screenW, u16 screenH,
                     i16 hScroll, i16 vScroll, i32 buttons
BACK_OR_SCREEN_ON    u8 action
GET_CLIPBOARD        u8 copyKey
SET_CLIPBOARD        i64 sequence, u8 paste, u32 length, utf-8
SET_DISPLAY_POWER    u8 on
START_APP            u8 length, utf-8
RESIZE_DISPLAY       u16 width, u16 height
SCAN_FILE            u32 length, utf-8
```

类型常量 0x00..0x16 与旧版一致（`INJECT_KEYCODE = 0` … `SCAN_FILE = 0x16`）。

### 定点数（`util/Binary.java`）

```java
u16FixedPointToFloat(short v)  = v == 0xffff ? 1f : (v & 0xffff) / 65536f
i16FixedPointToFloat(short v)  = v == 0x7fff ? 1f : v / 32768f
```

- **压力**：编码 `value * 65536`，夹到 `0..=0xffff`；`1.0` 必须显式编码成 `0xffff`
  （`0x10000` 会溢出成 0）。
- **滚动**：服务端解码后再 `× 16`，所以编码是 `value * 2048`。
  `1.0` 对应 `0x0800`，不是 `0x7fff`。

## 5. 生命周期陷阱：控制连接不能提前关闭

服务端 `Controller` 线程持续读控制连接。一旦读到 EOF，
它会认为会话结束，**连带关闭视频流**。

本项目最初的实现里 `pump_video(self)` 把 `ScrcpySession` 按值消费，
于是 `control` 字段在 spawn 出来的任务启动前就被 drop 了——
表现为「握手成功、收到 header，然后视频流立刻 EOF」。

修复：`video` 字段用 `Arc<Mutex<TcpStream>>` 包装，视频泵只持有一份 `Arc` 克隆；
会话本身必须继续存活。

## 6. scid

- 参数值是**十六进制**（`Integer.parseInt(value, 0x10)`），形如 `scid=12345678`。
- 必须落在 31 位内，否则设备端直接抛 `NumberFormatException`，
  套接字根本不会创建——客户端表现为 `AcceptTimeout`。
- 套接字名是 `scrcpy_%08x`，即把同一个整数按十六进制补零到 8 位。
- `scid = -1` 是「不用 scid」的特例，此时 socket 名就是 `scrcpy`。