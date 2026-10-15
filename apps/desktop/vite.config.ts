import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { workspaceAliases } from './vite.aliases.ts';

/** Tauri 在 dev 模式下访问开发服务器的地址；端口必须与 tauri.conf.json 保持一致 */
export const DEV_SERVER_PORT = 1420;
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: workspaceAliases,
  },
  // Tauri 使用 Chromium/WebKit 作为渲染引擎，target 需与之一致
  clearScreen: false,
  server: {
    port: DEV_SERVER_PORT,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: DEV_SERVER_PORT + 1 } : undefined,
    watch: {
      ignored: ['**/src-tauri/**', '**/target/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: 'es2022',
    // Vite 8 默认使用 oxc 压缩；显式指定 esbuild 会要求额外安装该包
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    outDir: 'dist',
    emptyOutDir: true,
    reportCompressedSize: false,
  },
});
