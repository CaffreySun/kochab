#!/usr/bin/env node
/**
 * 一次性环境准备：校验前置工具 → 安装 JS/Rust 依赖 → 报告 Tauri 平台前置条件。
 * 该脚本不会修改系统配置；若检测到缺失项，只给出可执行的修复指引。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, IS_WINDOWS, IS_MACOS } from './lib/paths.mjs';
import { color, log, table } from './lib/logger.mjs';
import { run, runOrThrow, which } from './lib/proc.mjs';

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const REQUIRED_NODE_MAJOR = 22;

const tools = [];
async function probe(name, args, { required = true } = {}) {
  const bin = await which(name);
  if (!bin) {
    tools.push([name, required ? color.red('缺失') : color.gray('未安装'), required]);
    return null;
  }
  const res = await run(name, args, {});
  const detail = (res.stdout || res.stderr).split(/\r?\n/)[0]?.trim() ?? '';
  tools.push([name, color.green(bin), detail]);
  if (required && res.code !== 0) process.exitCode = 1;
  return { bin, detail, code: res.code };
}

async function main() {
  log.step('前置工具链');
  await probe('node', ['-v']);
  await probe('pnpm', ['-v']);
  const rustc = await probe('rustc', ['-V']);
  await probe('cargo', ['-V']);
  await probe('adb', ['version']);
  await probe('scrcpy', ['--version']);
  if (IS_WINDOWS) await probe('git', ['--version']);

  table(
    tools.map(([n, p, d]) => [n, p, d === true ? color.red('不可用') : d]),
    ['tool', 'status', 'detail'],
  );

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < REQUIRED_NODE_MAJOR) {
    log.fail(`Node 版本过低：需要 >= ${REQUIRED_NODE_MAJOR}，当前 ${process.versions.node}`);
    process.exit(1);
  }
  if (!rustc) {
    log.fail('未检测到 Rust 工具链，请访问 https://rustup.rs 安装');
    process.exit(1);
  }

  log.step('平台前置条件（Tauri 2）');
  if (IS_WINDOWS) {
    log.info('需要：Microsoft C++ Build Tools（MSVC v143）+ WebView2 Runtime');
    log.info(
      'WebView2：Windows 11 与已更新的 Windows 10 默认内置；缺失时安装 Evergreen Bootstrapper',
    );
    const cl = await which('cl.exe');
    cl
      ? log.ok('检测到 MSVC 编译器')
      : log.warn('未在 PATH 检测到 cl.exe，请确认已安装 C++ Build Tools 且已重启终端');
  } else if (IS_MACOS) {
    log.info('需要：Xcode Command Line Tools');
    const xcode = await run('xcode-select', ['-p']);
    xcode.code === 0
      ? log.ok(`Xcode CLT: ${xcode.stdout.trim()}`)
      : log.warn('未检测到 Xcode Command Line Tools，请执行 `xcode-select --install`');
  }

  log.step('安装依赖');
  log.info('pnpm install …');
  await runOrThrow('pnpm', ['install'], { cwd: ROOT, stream: true });
  log.ok('JS 依赖安装完成');

  log.info('cargo fetch …');
  await runOrThrow('cargo', ['fetch'], { cwd: ROOT, stream: true });
  log.ok('Rust 依赖拉取完成');

  console.log('');
  log.ok(
    color.bold('环境准备完成。下一步：'),
    color.cyan('pnpm doctor'),
    '检查设备，',
    color.cyan('pnpm verify'),
    '跑全量校验',
  );
  void pkg;
}

await main();
