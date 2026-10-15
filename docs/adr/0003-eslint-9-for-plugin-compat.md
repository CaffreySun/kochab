# ADR-0003：ESLint 固定 9.x

- 状态：已采纳
- 日期：2026-10-14

## 背景

工程最初选用 ESLint 10.12 + `eslint-plugin-react@7.37.5`。

## 问题

`eslint-plugin-react` 的内部工具函数依赖 `context.getFilename()` 与
`context.getScope()`。这两个 API 在 ESLint 10 中已被移除，导致配置加载或 lint 阶段直接抛出：

```
TypeError: Error while loading rule 'react/display-name':
  contextOrFilename.getFilename is not a function
```

该插件尚未发布支持 ESLint 10 的版本（截至 2026-10-14，最新仍是 7.37.5，
其 peer 范围声明为 `eslint ^3 || … || ^9.7`）。

## 决策

ESLint 与 `@eslint/js` 固定在 `~9.39.5`。

## 后果

- 与插件生态保持兼容，不阻塞开发。
- flat config、`projectService` 类型感知 lint、`react-hooks` v7 的新规则
  （如 `set-state-in-effect`、`refs`）在 ESLint 9 下全部可用。
- 待 `eslint-plugin-react` 发布 ESLint 10 兼容版本后，再评估升级。

## 备选方案

- **去掉 `eslint-plugin-react`**：会失去 `react/jsx-sort-props`、`react/no-unstable-nested-components`
  等对组件质量有实质帮助的规则。
- **等插件适配**：阻塞交付。