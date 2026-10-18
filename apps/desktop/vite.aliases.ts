import { fileURLToPath, URL } from 'node:url';

/**
 * 工作区内部包的源码别名。
 *
 * 使用数组形式（而非对象形式）是为了保证顺序：对象形式会把 `@kochab/ui`
 * 当作前缀匹配，导致 `@kochab/ui/styles.css` 被错误地解析成
 * `packages/ui/src/index.ts/styles.css`。CSS 子路径必须排在前面。
 */
export const workspaceAliases = [
  {
    find: '@kochab/ui/styles.css',
    replacement: fileURLToPath(new URL('../../packages/ui/src/styles/index.css', import.meta.url)),
  },
  {
    find: '@kochab/ipc-contract',
    replacement: fileURLToPath(
      new URL('../../packages/ipc-contract/src/index.ts', import.meta.url),
    ),
  },
  {
    find: '@kochab/scrcpy-web',
    replacement: fileURLToPath(new URL('../../packages/scrcpy-web/src/index.ts', import.meta.url)),
  },
  {
    find: '@kochab/ui',
    replacement: fileURLToPath(new URL('../../packages/ui/src/index.ts', import.meta.url)),
  },
];
