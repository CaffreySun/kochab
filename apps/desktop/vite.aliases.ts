import { fileURLToPath, URL } from 'node:url';

/**
 * 工作区内部包的源码别名。
 *
 * 使用数组形式（而非对象形式）是为了保证顺序：对象形式会把 `@ac/ui`
 * 当作前缀匹配，导致 `@ac/ui/styles.css` 被错误地解析成
 * `packages/ui/src/index.ts/styles.css`。CSS 子路径必须排在前面。
 */
export const workspaceAliases = [
  {
    find: '@ac/ui/styles.css',
    replacement: fileURLToPath(new URL('../../packages/ui/src/styles/index.css', import.meta.url)),
  },
  {
    find: '@ac/ipc-contract',
    replacement: fileURLToPath(
      new URL('../../packages/ipc-contract/src/index.ts', import.meta.url),
    ),
  },
  {
    find: '@ac/scrcpy-web',
    replacement: fileURLToPath(new URL('../../packages/scrcpy-web/src/index.ts', import.meta.url)),
  },
  {
    find: '@ac/ui',
    replacement: fileURLToPath(new URL('../../packages/ui/src/index.ts', import.meta.url)),
  },
];
