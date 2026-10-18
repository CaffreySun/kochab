#!/usr/bin/env node
/** 启动 Tauri 开发环境（Vite HMR + Rust 热重启）。 */
import { ROOT } from './lib/paths.mjs';
import { log } from './lib/logger.mjs';
import { runOrThrow } from './lib/proc.mjs';

log.info('启动 @kochab/desktop 开发模式（Ctrl+C 退出）');
await runOrThrow('pnpm', ['--filter', '@kochab/desktop', 'dev'], { cwd: ROOT, stream: true });
