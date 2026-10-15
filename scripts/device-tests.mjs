#!/usr/bin/env node
/**
 * 真机集成测试入口。
 *
 * 自动化测试默认只在无设备环境下安全跳过；本脚本从 `adb devices -l` 中
 * 选取第一台就绪设备（或使用 --serial 指定），注入 ANDROID_TEST_DEVICE，
 * 让 Rust 侧的设备集成测试真正执行而不是跳过。
 */
import { parseArgs } from 'node:util';
import { ROOT } from './lib/paths.mjs';
import { color, log } from './lib/logger.mjs';
import { run, runOrThrow, which } from './lib/proc.mjs';

const { values } = parseArgs({
  options: {
    serial: { type: 'string' },
    filter: { type: 'string' },
    'test-threads': { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`
${color.bold('真机集成测试')}

  pnpm test:device                      使用第一台就绪设备
  pnpm test:device -- --serial XXX      指定设备
  pnpm test:device -- --filter scrcpy   只跑匹配名称的测试
`);
  process.exit(0);
}

if (!(await which('adb'))) {
  log.fail('未找到 adb，无法运行真机测试');
  process.exit(1);
}

let serial = values.serial;
if (!serial) {
  const list = await run('adb', ['devices']);
  serial = list.stdout
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .find(([, state]) => state === 'device')?.[0];
}

if (!serial) {
  log.fail('没有就绪设备（state=device）。连接设备并完成 USB 调试授权后重试。');
  process.exit(1);
}

log.ok(`目标设备：${color.cyan(serial)}`);

// 只要 lib/bins/tests：真机测试不需要 doctest，
// 而 doctest 会在 Windows 上与其它编译任务抢链接器。
const args = ['test', '--workspace', '--lib', '--bins', '--tests'];
if (values.filter) args.push('--test', values.filter);
// 真机测试默认**串行**：所有用例共用同一台设备，
// 并行会同时抢编码器与设备端的临时文件，结果随机失败。
args.push('--', '--test-threads', values['test-threads'] ?? '1');

await runOrThrow('cargo', args, {
  cwd: ROOT,
  stream: true,
  env: { ...process.env, ANDROID_TEST_DEVICE: serial },
});

log.ok(color.bold('真机集成测试通过'));
