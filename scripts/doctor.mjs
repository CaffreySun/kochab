#!/usr/bin/env node
/**
 * 环境诊断：报告 adb / scrcpy-server / 已连接设备的可用性。
 * 目的是让「为什么投不起来」这类问题在 5 秒内被定位。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { ROOT, IS_WINDOWS, IS_MACOS } from './lib/paths.mjs';
import { color, log, table } from './lib/logger.mjs';
import { run, which } from './lib/proc.mjs';

/**
 * 定位 scrcpy server 文件。
 * 查找顺序必须与 Rust 侧 `android_core::toolchain::resolve_scrcpy_server` 保持一致：
 *   1. 环境变量 SCRCPY_SERVER_PATH
 *   2. scrcpy 可执行文件所在目录（含 macOS 的 ../Resources）
 *   3. <repo>/vendor/scrcpy-server
 */
function resolveScrcpyServer(scrcpyPath) {
  const direct = [];
  if (process.env.SCRCPY_SERVER_PATH) {
    direct.push({ from: 'SCRCPY_SERVER_PATH', p: process.env.SCRCPY_SERVER_PATH });
  }
  direct.push({ from: 'vendor/scrcpy-server', p: path.join(ROOT, 'vendor', 'scrcpy-server') });

  if (scrcpyPath) {
    const dir = path.dirname(scrcpyPath);
    const rels = ['.', '..', path.join('..', 'Resources'), path.join('..', '..', 'Resources')];
    for (const rel of rels) {
      const target = path.resolve(dir, rel);
      if (!existsSync(target)) continue;
      for (const name of readdirSync(target)) {
        if (name.startsWith('scrcpy-server')) {
          return {
            from: `scrcpy 安装目录 (${rel === '.' ? './' : rel})`,
            p: path.join(target, name),
          };
        }
      }
    }
  }

  for (const c of direct) if (existsSync(c.p)) return c;
  return null;
}

function parseDevices(stdout) {
  const devices = [];
  let header = true;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (header) {
      header = false;
      continue;
    }
    const [serial, state, ...rest] = line.trim().split(/\s+/);
    const props = {};
    for (const p of rest) {
      const idx = p.indexOf(':');
      if (idx > 0) props[p.slice(0, idx)] = p.slice(idx + 1);
    }
    devices.push({ serial, state, props });
  }
  return devices;
}

log.step('外部工具');
const adbPath = await which('adb');
const scrcpyPath = await which('scrcpy');
table(
  [
    [
      'adb',
      adbPath ? color.green(adbPath) : color.red('未找到'),
      adbPath ? '必需' : '请安装 Android Platform Tools',
    ],
    [
      'scrcpy',
      scrcpyPath ? color.green(scrcpyPath) : color.yellow('未找到'),
      scrcpyPath ? '用于定位 server' : '不影响功能，仅影响 server 自动发现',
    ],
  ],
  ['tool', 'path', 'note'],
);

log.step('scrcpy server');
const server = resolveScrcpyServer(scrcpyPath);
if (server) {
  let size = 0;
  try {
    size = statSync(server.p).size;
  } catch {
    /* 忽略 */
  }
  log.ok(`${server.p}`, color.gray(`${(size / 1024).toFixed(0)} KiB · 来源 ${server.from}`));
} else {
  log.warn('未找到 scrcpy server 文件');
  log.info('解决方式（任选其一）：');
  log.info(`  1. 安装 scrcpy 并确保在 PATH 中${IS_MACOS ? '（brew install scrcpy）' : ''}`);
  log.info('  2. 设置环境变量 SCRCPY_SERVER_PATH 指向 scrcpy-server 文件');
  log.info(`  3. 放入 ${path.join(ROOT, 'vendor', 'scrcpy-server')}`);
}

log.step('已连接设备');
if (!adbPath) {
  log.fail('未找到 adb，无法列出设备');
  process.exit(1);
}
const list = await run('adb', ['devices', '-l']);
const devices = parseDevices(list.stdout);
if (devices.length === 0) {
  log.warn('当前没有设备连接');
  log.info('请开启手机「开发者选项 → USB 调试」，连接后在手机上确认 USB 调试授权');
} else {
  table(
    devices.map((d) => [
      d.serial,
      d.state === 'device' ? color.green(d.state) : color.yellow(d.state),
      d.props.model ?? '',
      d.props.product ?? '',
      d.props.transport_id ?? '',
    ]),
    ['serial', 'state', 'model', 'product', 'transport'],
  );
  const ready = devices.filter((d) => d.state === 'device');
  if (ready.length > 0) {
    log.ok(`${ready.length} 台设备就绪`, color.gray('运行 `pnpm test:device` 执行真机集成测试'));
  } else {
    log.warn('设备处于非就绪状态（offline / unauthorized），请检查线缆与授权弹窗');
  }
}

log.step('运行时');
log.info(
  `Node ${process.versions.node} · 平台 ${IS_MACOS ? 'macOS' : IS_WINDOWS ? 'Windows' : process.platform}`,
);
