# 0010 从 LinkAndroid 吸收的设备工具

- 状态：已采纳
- 日期：2026-10-17

## 背景

[LinkAndroid](https://github.com/modstart-lib/linkandroid)（Apache-2.0）与本项目定位相近：
连接 Android 设备后投屏、管理应用与文件。它基于 Electron + adbkit，本项目是
Tauri + 自研 adb/scrcpy 协议客户端，因此**不复制其代码**，只评估其产品行为与实现思路，
挑出本项目缺失且值得做的部分，按本项目分层重新实现。

调研范围：`electron/mapi/{adb,file,app,scrcpy,task}`、`src/pages/Device` 下的设备动作与弹窗。
明确排除大模型/脚本生成相关模块。

## 取舍

| LinkAndroid 能力 | 它的做法 | 本项目结论 |
| --- | --- | --- |
| 截屏 | `adb screencap` → base64 → 内嵌图片美化页 | **采纳核心**：`screencap` 落盘 PNG、pull 到系统「下载」，不引入美化页 |
| 录屏 | 设备端 `screenrecord` → pull → ffmpeg 转 MP4/GIF | **采纳 MP4 链路**；GIF 依赖外部 ffmpeg，不引入 |
| 无线调试 | `adb tcpip 5555` + 读 `wlan0` 地址 + `adb connect` | **采纳**，但用自研 adb 客户端的 `tcpip:` / `usb:` host 服务，不拉起 adb 子进程 |
| 恢复分辨率 | 读 `wm size`/`wm density`，只重置被覆盖项，重置前确认 | **采纳并加强**：重置后重新读取，确认覆盖项真的消失 |
| 应用管理 / 文件管理 / 分组 / 任务记录 | 单窗口内多弹窗 | 本项目已具备（独立窗口 + 面板），不迁移交互 |
| 终端 | `vue-command` 包装 `adb shell` | 本项目已有一次性命令弹层；流式交互终端不在本轮 |
| 应用投屏（虚拟屏） | scrcpy `new_display` + 启动指定包 | 暂不采纳：需要「同一设备多会话/多窗口」模型，见下 |
| 无线配对（Android 11+） | mDNS 发现配对服务 + `adb pair`（TLS/SPAKE2） | 暂不采纳：配对不走 adb server 协议，需直接实现 TLS 配对；本轮测试机为 Android 10，无法端到端验证 |
| 投屏时关闭设备屏幕 | scrcpy 客户端发 `SET_DISPLAY_POWER` | 暂不采纳：会话收尾时恢复亮屏需要覆盖窗口关闭/崩溃路径，单独设计 |
| 相机/OTG 投屏、定时脚本、GIF 录制 | 各自独立子系统 | 超出「同类软件设备工具」范围，不做 |

## 决策

新增四个后端能力，全部落在 `android-core`，Tauri 命令层只做参数校验与目录选择：

1. **`media::screenshot`**：`screencap -p` 写 `/data/local/tmp/ac-shot-*.png`，
   sync pull 到「下载」目录，成功后删除远端临时文件。
2. **`media::start_recording` / `stop_recording`**：
   - 后台启动 `screenrecord --time-limit 180 --bit-rate 8M`，stdout/stderr 重定向到设备端日志，
     并且必须套 `nohup ... </dev/null`：本项目读完退出码哨兵就断开 adb shell，
     不 detach 时后台进程会收到 HUP，命令虽然返回了 PID，设备上却没有文件；
   - 停止时 `kill -2` 发 `SIGINT`——只有收到中断，`screenrecord` 才会写完 MP4 的 moov box；
     随后轮询进程退出、确认文件非空，再 pull；
   - 启动后 500ms 内进程已退出且文件为空则报错，并带上设备端日志。
3. **`network::enable` / `disable`**：读 `wlan0` → `tcpip:5555` → 重试 `host:connect`；
   关闭时 `usb:` → 断开 TCP 条目。`tcpip:` / `usb:` 的响应是 `OKAY` + 一行普通文本
   （如 `restarting in TCP mode port: 5555`，**没有长度前缀**），必须读到 EOF 再断开：
   只读 `OKAY` 就关闭连接，adb server 会中止 adbd 重启，命令却返回成功。
   这两个服务也不能复用 `forward` 那套「多个状态位 + 可选负载」的解析。
4. **`display::inspect` / `reset`**：解析 `wm size` / `wm density` 的物理值与覆盖值；
   没有覆盖时直接返回「无需恢复」，有覆盖时逐项 reset 并重新读取验证。

前端：

- 设备卡片「更多」新增 **截屏 / 录屏 / 无线调试（无线设备显示「关闭无线端口」）**；
- 「恢复分辨率」改走 `device_reset_display`，批量操作同样使用该命令，
  任务详情会显示「720x1440 → 1080x2160；密度 320 → 440」这类真实结果；
- 录屏弹窗负责开始/停止/180 秒自动停止/保存路径与「打开所在文件夹」。

约束不变：新增能力不引入 npm / crate 依赖；设备端临时文件都带本机 PID 与时间戳，
避免并发覆盖；所有轮询都有上限，不会无限等设备。

## 未采纳项的触发条件

- **应用投屏**：先让会话注册表支持一台设备多条会话（不同 scid），再给
  `SessionOptions` 增加 `video_source` / `new_display` / `start_app`；
  窗口模型也要从「一设备一窗口」扩展。
- **无线配对**：需要实现 adb 的 TLS 配对（SPAKE2）或调用外部 `adb pair`，
  且必须有一台 Android 11+ 设备做端到端验证。
- **关屏投屏**：需要把 `turn_screen_off` 作为会话状态，在 `session_stop`、
  窗口销毁、进程退出三条路径上恢复亮屏。

## 验证

（真机验证记录见提交说明。）
