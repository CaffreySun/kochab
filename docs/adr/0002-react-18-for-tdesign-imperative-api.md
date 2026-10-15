# ADR-0002：React 固定 18.x

- 状态：已采纳
- 日期：2026-10-14

## 背景

`tdesign-react@1.18.4` 的 peer 声明为 `react >= 16.13.1`，未对 React 19 做出限制，
因此 React 19 安装时无告警。

## 问题

TDesign 的命令式 API（`MessagePlugin`、`DialogPlugin`、`NotificationPlugin`、`LoadingPlugin`）
内部仍调用 React 18 才存在的 `ReactDOM.render`：

```
TypeError: reactRender is not a function
    at legacyRender (tdesign-react/es/_util/react-render.js)
    at createContainer (tdesign-react/es/message/Message.js)
```

该路径只在**运行时**触发（首次调用 `MessagePlugin.info` 时），类型检查与构建都不会报错，
单元测试若不触发该分支也无法发现。

## 决策

React 与 `react-dom` 固定在 `^18.3.1`，`@types/react*` 同步到 18.x。
并在 `pnpm-workspace.yaml` 的 catalog 中写明原因，防止被「顺手升级」。

## 后果

- 失去 React 19 的部分特性（如 `use`、Actions）。当前项目不需要。
- 未来 TDesign 支持 React 19 后，可在本 ADR 标注为待复核并统一升级。

## 备选方案

- **升级到 React 19 并规避命令式 API**：不可行。二次确认弹窗、卸载确认、加载态提示
  都依赖 `DialogPlugin` / `MessagePlugin`，这些是产品要求的核心交互。
- **fork TDesign**：维护成本远大于收益。