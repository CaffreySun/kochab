# ADR-0007 文档测试排除 Tauri 应用 crate

- 状态：已采纳
- 日期：2026-10-15

## 背景

`pnpm verify` 的测试步骤最初是 `cargo test --workspace`。加入 `scrcpy-protocol`
的文档测试（`///` 示例）后，**只有**这三个文档测试失败，报的是链接错误：

```text
msvcrt.lib : warning LNK4003: 无效的库格式；已忽略
error LNK2001: 无法解析的外部符号 `__CxxFrameHandler3`
```

有趣的是：单独 `cargo test -p scrcpy-protocol --doc` 完全正常，
只有 `--workspace` 会失败。

## 原因

`tauri_build::build()`（`apps/desktop/src-tauri/build.rs`）会在 crate 的
`OUT_DIR` 里生成一个 **82 字节的 `msvcrt.lib` 桩**，并把该目录作为链接搜索路径。

`--workspace` 构建时，这个 `-L` 路径会泄漏给同一次构建中其它 crate 的文档测试链接。
链接器按 `/LIBPATH` 顺序查找 `/defaultlib:msvcrt`，先命中那个 82 字节的无效桩并
忽略它，真正的 C 运行库就找不到了，于是 `__CxxFrameHandler3`（展开/回溯所需）
无法解析。

`adb-client` 的文档测试恰好没触发，是因为它的链接组合下桩没有遮蔽到所需符号——
这是巧合，不值得依赖。

## 决策

把测试拆成两步：

```bash
cargo test --workspace --lib --bins --tests                              # 单元 + 集成
cargo test --workspace --exclude kochab --doc                # 文档测试
```

**后果**

- 文档测试仍然被强制执行，没有降低覆盖率。
- 多一条命令，`scripts/verify.mjs` 承担了这个约定，并在注释里写明了原因。
- 文档测试**不覆盖** `apps/desktop/src-tauri`。该 crate 目前没有文档测试
  （它的公开 API 是 Tauri 命令层，由 `commands/mod.rs` 的契约测试覆盖），
  所以没有实际损失。

## 备选方案

1. **删掉文档测试** —— 牺牲可执行文档，且并没有解决根因。
2. **在 `apps/desktop` 上加 `tauri_build = { features = [] }` 之类** ——
   无法阻止桩文件生成。
3. **全局 `RUSTFLAGS`** 覆盖链接顺序 —— 影响所有构建，风险远大于收益。