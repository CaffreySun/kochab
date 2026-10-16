# 工程规范

本文件是**可执行约定**的说明。凡是能被工具检查的，`pnpm verify` 一定会挡住；
凡是只能靠约定的，写在这里并在评审时对照。

## 1. 工具链一览

| 关注点 | 工具 | 配置 |
| --- | --- | --- |
| 格式 | Prettier 3 + rustfmt | `.prettierrc.json` / `rustfmt.toml` |
| 静态检查 | ESLint 9（类型感知） + Clippy | `eslint.config.js` / `Cargo.toml` |
| 类型 | `tsc --noEmit` + `cargo check` | `tsconfig.base.json` |
| 测试 | Vitest 5 + Testing Library + `cargo test` | `vitest.shared.ts` |
| 构建 | Vite 8 + Cargo | `apps/desktop/vite.config.ts` |
| 图标 | `tauri icon` | `assets/app-icon.svg` |

**唯一入口**是 `pnpm verify`，不要手动敲各条命令（避免漏项、漏过滤参数）。

```bash
pnpm verify              # format → lint → typecheck → test → build
pnpm verify:fast         # 同上但跳过 build
pnpm verify:fix          # 自动修复 format / lint
pnpm verify -- --stages lint,test
pnpm verify -- --only rust
pnpm verify -- --coverage
pnpm verify:list         # 列出所有阶段与实际执行的命令
```

## 2. 目录约定

```
apps/<应用>/          前端应用（渲染进程 + src-tauri）
packages/<库>/        无副作用的前端库
crates/<库>/          Rust 库
docs/                 文档（ADR 与协议笔记放这里）
scripts/              Node 工具脚本，一律 ESM + .mjs
```

- 一个包一个职责。出现「顺便加个工具函数」时先想清楚该放哪个包。
- 包的 `package.json` **不得**声明 `lint` / `format` / `typecheck` 之外的编排脚本；
  这些由根目录的 `verify.mjs` 统一驱动。
- 私有依赖用 pnpm `catalog:` 引用，**禁止**在子包里写死版本号（见 §4）。

## 3. 命名

| 场景 | 规则 | 例 |
| --- | --- | --- |
| Rust 类型 / 函数 / 模块 | `snake_case`（类型 `PascalCase`） | `SessionError` / `open_session` |
| Tauri 命令名 | `snake_case`，`{领域}_{动作}` | `app_uninstall` |
| 事件名 | `<domain>://<kebab-event>` | `device://changed` |
| TS 类型 / 组件 | `PascalCase` | `DeviceCard` |
| TS 函数 / 变量 | `camelCase` | `useDevices` |
| CSS 类 | BEM 化的 `ac-` 前缀 | `.ac-device-card__header` |
| 环境变量 | `SCREAMING_SNAKE_CASE` | `SCRCPY_SERVER_PATH` |
| 特性开关（cargo） | `device-tests` / `codegen` | |

命令名与事件名的唯一事实来源是对应的 TS 常量表；Rust 侧有测试做双向比对。

## 4. 依赖管理

- 全部依赖版本集中在根目录 `pnpm-workspace.yaml` 的 `catalog` / `catalogs`。
  新增依赖先在 catalog 登记，再在包里写 `"catalog:"`。
- Cargo 依赖统一在根 `Cargo.toml` 的 `[workspace.dependencies]` 声明版本，
  子 crate 只写 `foo.workspace = true`。
- **不引入运行时第三方依赖来做 adb / scrcpy 的事**（见 ADR-0004 / ADR-0005）。
  引入新依赖需要在 ADR 里说明为什么自研不划算。

### 版本约束的既有取舍

- TypeScript 固定 5.x：`typescript-eslint@8` 的 peer 范围是 `<6.1.0`，用 TS 7 会失去类型感知 lint。
- React 固定 18.x：TDesign 命令式 API 依赖 `ReactDOM.render`，React 19 已移除。
  见 [ADR-0002](adr/0002-react-18-for-tdesign-imperative-api.md)。
- ESLint 固定 9.x：`eslint-plugin-react@7` 在 ESLint 10 下直接崩溃。
  见 [ADR-0003](adr/0003-eslint-9-for-plugin-compat.md)。
- `eslint-plugin-react-hooks` 只启用 `rules-of-hooks` 与 `exhaustive-deps` 两条。
  v7 的 `configs.flat.recommended` 会连带启用 React Compiler 全套规则，
  它们与本项目的两类正常写法冲突：① 组件挂载时在 effect 里取数后 `setState`
  （没有数据层时的标准写法）；② TDesign 的 Table/List 用渲染函数属性表达单元格，
  会被判成「在 render 里定义组件」。为规则扭曲代码不划算，因此只留真正防 bug 的两条。

## 5. TypeScript 规范

`tsconfig.base.json` 是唯一来源，所有包 `extends` 它。已启用的严格项：

`strict`、`noUncheckedIndexedAccess`（协议解析里尤其重要）、`noImplicitOverride`、
`noImplicitReturns`、`noFallthroughCasesInSwitch`、`noUnusedLocals`、`noUnusedParameters`、
`verbatimModuleSyntax`、`isolatedModules`、`erasableSyntaxOnly`。

未启用 `exactOptionalPropertyTypes`：与 TDesign / React 18 的 props 类型有已知摩擦，
可选性改由 IPC 边界与运行期校验保证。

补充约定：

- **禁止 `any`**。确实需要逃生舱时用 `unknown` + 类型收窄。
- 领域数据只从 `@ac/ipc-contract` 引入，不要在别处重复定义。
- 组件 props 一律显式声明 `interface`，不使用 `React.FC`。
- 自定义 hook 以 `use` 开头，返回具名对象而非位置数组（便于演进）。
- JSX 属性顺序：`react/jsx-sort-props` 已开启（回调属性在最后、简写在前、`key` 最前）。

## 6. Rust 规范

- 错误一律用 `thiserror` 定义具名枚举，禁止 `anyhow` 出现在库 crate 中
  （`anyhow` 只允许出现在 `main.rs` 与二进制入口）。
- 面向用户的错误文案在 `android-core::CoreError` 的 `#[error(...)]` 里写，
  上层只做错误码映射，不再二次翻译。
- 公开函数必须有文档注释，说明**前置条件**与**失败情形**，而不是复述函数名。
- 协议层代码禁止 `unwrap()` / `expect()`，一律返回 `Result`。
  clippy 以 `-D warnings` 运行，任何 `unwrap_used` 类问题都会挡住提交。
- 日志用 `tracing`，格式 `tracing::debug!(serial = %serial, "…")`；
  不要用 `println!`。

## 7. 样式规范

- 使用 TDesign 设计令牌，不写死颜色。语义令牌定义在 `packages/ui/src/styles/index.css`
  （`--ac-bg-container`、`--ac-text-primary` …）。
- 组件样式与组件同目录，类名统一 `ac-` 前缀。
- 尊重 `prefers-reduced-motion`。
- 语义与无障碍：可点击元素用 `<button>`；纯图标控件必须有 `aria-label`；
  状态变化需对读屏软件可感知。

> TDesign 的 `Button` 在 `disabled` 时会渲染成 `<div>`，丢失 button 语义。
> 统一使用 `@ac/ui` 的 `ActionButton`，它强制 `tag="button"`。

## 8. 错误处理约定

- **Rust**：底层错误（I/O、协议）保留原始上下文；领域错误翻译为用户可读文案；
  命令层映射为稳定错误码。
- **TypeScript**：`invoke` 的失败统一为 `{ code, message }`；
  UI 面向用户的提示用 `message`，分支逻辑用 `code`。
- **禁止静默失败**：`catch {}` 空块、`?? []` 掩盖错误都不允许；
  确实可以忽略时写注释说明理由。

## 9. 提交规范

使用 Conventional Commits，PR 必须通过 `pnpm verify`：

```
feat(adb): 支持 host:transport 的设备选择
fix(scrcpy): 修正视频流在设备旋转后的分辨率更新
docs(adr): 记录为何选择 Tauri 而非 Electron
test(core): 为 pm list 解析补充系统应用场景
chore(harness): 升级 ESLint 到 9.x
```

- 一次提交只做一件事；重构与行为变更分开提交。
- 不提交生成物：`dist/`、`target/`、`node_modules/`、`apps/desktop/src-tauri/gen/`。
- 不提交密钥；`.env*` 已在 `.gitignore`，`.env.example` 例外。

## 10. 代码评审清单

- [ ] 新增依赖是否已登记 catalog / workspace.dependencies？能否用现有能力实现？
- [ ] 新增命令是否已在 `ipc-contract` 登记，且错误码稳定？
- [ ] 是否有对应测试？协议/解析类改动是否有边界用例（空、超长、非法、越界）？
- [ ] 是否有真机相关的行为未被 `pnpm test:device` 覆盖？
- [ ] 跨平台：是否用到了 `/` 拼接路径、硬编码换行、平台专有 API？
- [ ] `pnpm verify` 是否全绿？

## 11. 组件库（TDesign）踩过的坑

这几条都**不是**能靠类型检查挡住的，改动相关代码前先看一眼。

- **`Form.FormItem` 会克隆直接子元素并注入 `value` / `onChange`**，把子控件上显式写的
  `value` 覆盖成表单域里的值。表单没有 `data` 时那个值就是 `undefined`，
  于是控件渲染成空白/关闭，而且**不报错、不警告**。
  受控控件必须套一层普通元素（本项目用 `<div>`），让 FormItem 去绑那一层。
  回归测试见 `pages.test.tsx` 的 `SettingsPage` 用例。
- **`Popup` 没有触发元素时无法定位**：不传触发子元素、只用 `visible` 受控挂载时，
  弹层会被丢到窗口左上角（而不是跟着调用方）。要么给它一个引用子元素，
  要么直接用 `Dialog`——`Dialog` 挂在 `body` 上居中显示，不受祖先
  `overflow: hidden` 影响。`更多 → 命令行` 就是这么做的。
- **`Switch` 不写 `aria-checked`**：Visual 上开了/关了都对，但 UI Automation 读到的
  `ToggleState` 永远是 `Off`；而 `InputNumber` 的 UIA `ValuePattern.SetValue`
  也只改 DOM、不触发 React 的 `onChange`。**用 UIA 做交互验证时不要拿这两样当判据**：
  开关状态看截图，输入改值要用真实鼠标点击输入框 + 键盘输入。
