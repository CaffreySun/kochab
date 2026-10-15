import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

/** monorepo 根目录 */
export const ROOT = path.resolve(here, '..', '..');
/** 脚本目录 */
export const SCRIPTS = path.resolve(here, '..');

export const IS_WINDOWS = process.platform === 'win32';
export const IS_MACOS = process.platform === 'darwin';
