import { spawn } from 'node:child_process';
import { IS_WINDOWS } from './paths.mjs';

const CMD_SPECIAL = /[\s"^&|<>()%!,;=]/;

function winEscape(arg) {
  if (arg === '') return '""';
  if (!CMD_SPECIAL.test(arg)) return arg;
  return `"${String(arg).replace(/"/g, '""')}"`;
}

/**
 * 以跨平台方式执行一个命令。
 *
 * Windows 下 `.cmd`/`.bat` 垫片无法被 `shell:false` 直接 spawn，
 * 因此统一经由 `cmd.exe /d /s /c` 转发；POSIX 下直接 spawn。
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {Record<string,string|undefined>} [opts.env]
 * @param {boolean} [opts.stream] 是否把子进程输出透传到当前终端
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
export function run(cmd, args = [], opts = {}) {
  const { cwd = process.cwd(), env = {}, stream = false } = opts;
  const childEnv = { ...process.env, ...env };

  return new Promise((resolve, reject) => {
    const child = IS_WINDOWS
      ? spawn('cmd.exe', ['/d', '/s', '/c', `"${[cmd, ...args].map(winEscape).join(' ')}"`], {
          cwd,
          env: childEnv,
          windowsVerbatimArguments: true,
          shell: false,
        })
      : spawn(cmd, args, { cwd, env: childEnv, shell: false });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      if (stream) process.stdout.write(s);
    });
    child.stderr?.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (stream) process.stderr.write(s);
    });

    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** 执行并在失败时抛出错误 */
export async function runOrThrow(cmd, args, opts) {
  const res = await run(cmd, args, opts);
  if (res.code !== 0) {
    const err = new Error(`命令失败 (${res.code}): ${cmd} ${args.join(' ')}`);
    err.result = res;
    throw err;
  }
  return res;
}

/** 静默执行，仅返回退出码 */
export async function runQuiet(cmd, args, opts) {
  const res = await run(cmd, args, opts);
  return res.code;
}

/**
 * 探测可执行文件是否存在（跨平台）。
 * @returns {Promise<string|null>} 解析到的绝对路径，未找到返回 null
 */
export async function which(binary) {
  const res = await run(IS_WINDOWS ? 'where' : 'which', [binary]);
  if (res.code !== 0) return null;
  const line = res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? null;
}
