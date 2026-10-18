# 0013 项目更名为 Kochab

- 日期：2026-10-18
- 状态：已接受

## 背景

项目准备开源，旧名「Android Controller」过于通用，既不利于搜索，也无法承载后续「多设备编排 + AI 控制」的定位。

命名过程中曾考虑 FleetDeck，但检索发现同名的商业 RMM 产品（远程桌面/设备群管理）已经存在，业务高度重叠，因此放弃。最终选择一个不直接描述功能的名字。

## 决策

产品名定为 **Kochab**。

Kochab 是小熊座 β，古代的北极星，和 Pherkad 一起被称为「极地守卫」。它不描述功能，只描述角色：在多台设备之间提供一个稳定的导航/控制基准。后续 AI 也在这个控制面上做编排，而不是另外套一层聊天界面。

同步调整：

- Tauri `productName` / 窗口标题：`Kochab`
- Bundle identifier：`dev.kochab.desktop`
- Rust crate / lib / binary：`kochab` / `kochab_lib` / `kochab`
- npm 包：根包 `kochab`，工作区 scope `@kochab/*`
- localStorage key 前缀：`kochab.*`
- CSS/BEM 前缀：`kochab-`
- 仓库地址：`https://github.com/CaffreySun/kochab`

## 后果

- 可执行文件、安装包、应用数据目录随 identifier 改变；旧 `dev.androidcontroller.desktop` 下的 localStorage 不会迁移，本地设置会重置一次。0.1.0 尚未对外发布，因此不做兼容层。
- 旧名称只保留在 git 历史中，不保留代码别名或 re-export。
