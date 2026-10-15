#!/usr/bin/env node
/**
 * Harness 单一入口：按顺序执行工程校验流水线。
 *
 *   node scripts/verify.mjs                      # 完整校验（format→lint→typecheck→test→build）
 *   node scripts/verify.mjs --fast               # 跳过 build
 *   node scripts/verify.mjs --fix                # format/lint 阶段自动修复
 *   node scripts/verify.mjs --stages lint,test   # 只跑指定阶段
 *   node scripts/verify.mjs --only rust          # 只跑 Rust 侧
 *   node scripts/verify.mjs --coverage           # 测试阶段附带覆盖率
 *   node scripts/verify.mjs --list               # 列出阶段与检查项
 */
import { parseArgs } from 'node:util';
import { ROOT } from './lib/paths.mjs';
import { color, log, table } from './lib/logger.mjs';
import { run } from './lib/proc.mjs';

/**
 * 在所有工作区子包中递归执行某个 npm script。
 * 显式排除根包：根包的同名脚本会再次调用本脚本，若被包含将造成无限递归。
 * （pnpm 默认也不包含根包，这里是双保险。）
 */
const RECURSE = (script) => ['-r', '--filter', '!android-controller', 'run', script];

const { values, positionals } = parseArgs({
  options: {
    stages: { type: 'string' },
    only: { type: 'string' },
    fast: { type: 'boolean', default: false },
    fix: { type: 'boolean', default: false },
    coverage: { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
    bail: { type: 'boolean', default: true },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
});

const PLAN = {
  format: {
    title: '格式检查 (Prettier / rustfmt)',
    ts: [['pnpm', ['exec', 'prettier', '--check', '.']]],
    rs: [['cargo', ['fmt', '--all', '--', '--check']]],
    fix: {
      ts: [['pnpm', ['exec', 'prettier', '--write', '.']]],
      rs: [['cargo', ['fmt', '--all']]],
    },
  },
  lint: {
    title: '静态检查 (ESLint / Stylelint / Clippy)',
    ts: [
      ['pnpm', ['exec', 'eslint', '.', '--max-warnings', '0']],
      ['pnpm', ['exec', 'stylelint', '**/*.css']],
    ],
    rs: [
      [
        'cargo',
        ['clippy', '--workspace', '--all-targets', '--all-features', '--', '-D', 'warnings'],
      ],
    ],
    fix: {
      ts: [
        ['pnpm', ['exec', 'eslint', '.', '--fix']],
        ['pnpm', ['exec', 'stylelint', '**/*.css', '--fix']],
      ],
    },
  },
  typecheck: {
    title: '类型检查 (tsc / cargo check)',
    ts: [['pnpm', ['-r', 'run', 'typecheck']]],
    rs: [['cargo', ['check', '--workspace', '--all-targets']]],
  },
  test: {
    title: '测试 (Vitest / cargo test)',
    ts: [['pnpm', RECURSE('test')]],
    // 单元测试与集成测试跑全 workspace；
    // 文档测试必须排除 Tauri 应用 crate——它的构建脚本会在 out 目录留下一个
    // 82 字节的 msvcrt.lib 桩，`--workspace` 下这个搜索路径会泄漏给其它 crate 的
    // 文档测试，导致 `__CxxFrameHandler3` 无法解析（见 docs/adr/0007）。
    rs: [
      ['cargo', ['test', '--workspace', '--lib', '--bins', '--tests']],
      ['cargo', ['test', '--workspace', '--exclude', 'android-controller', '--doc']],
    ],
    coverage: { ts: [RECURSE('test:coverage')] },
  },
  build: {
    title: '构建 (Vite / cargo build)',
    ts: [['pnpm', ['--filter', '@ac/desktop', 'run', 'build']]],
    rs: [['cargo', ['build', '--workspace']]],
  },
};

const STAGE_ORDER = Object.keys(PLAN);

function usage() {
  console.log(`
${color.bold('Android Controller · 工程校验')}

  pnpm verify              完整流水线
  pnpm verify:fast         跳过构建
  pnpm verify:fix          自动修复可修复项
  pnpm verify -- --coverage 附带覆盖率

${color.bold('阶段')}: ${STAGE_ORDER.join(' → ')}
`);
}

if (values.help) {
  usage();
  process.exit(0);
}

if (values.list) {
  table(
    STAGE_ORDER.flatMap((s) => {
      const p = PLAN[s];
      return [
        [color.bold(s), p.title, p.ts.map(([c, a]) => `${c} ${a.join(' ')}`).join(' | ')],
        ['', color.gray('rust'), p.rs.map(([c, a]) => `${c} ${a.join(' ')}`).join(' | ')],
      ];
    }),
    ['stage', 'name', 'commands'],
  );
  process.exit(0);
}

const requested = values.stages
  ? values.stages
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : STAGE_ORDER.filter((s) => !(values.fast && s === 'build'));

const unknown = requested.filter((s) => !(s in PLAN));
if (unknown.length > 0) {
  log.fail(`未知阶段: ${unknown.join(', ')}。可用: ${STAGE_ORDER.join(', ')}`);
  process.exit(2);
}

if (values.only && !['ts', 'rust'].includes(values.only)) {
  log.fail(`--only 仅支持 ts | rust，收到: ${values.only}`);
  process.exit(2);
}
const sides = values.only === 'rust' ? ['rs'] : values.only === 'ts' ? ['ts'] : ['ts', 'rs'];

const results = [];
let failed = false;

for (const stage of requested) {
  const plan = PLAN[stage];
  log.step(`${stage} · ${plan.title}`);

  const commands = [];
  for (const side of sides) {
    if (values.fix && plan.fix?.[side]) commands.push(...plan.fix[side]);
    else if (values.coverage && plan.coverage?.[side]) commands.push(...plan.coverage[side]);
    else commands.push(...plan[side]);
  }

  for (const [cmd, args] of commands) {
    const started = Date.now();
    const res = await run(cmd, args, { cwd: ROOT, stream: false });
    const ms = Date.now() - started;
    const label = color.gray(`${cmd} ${args.join(' ')}`);
    if (res.code === 0) {
      log.ok(label, color.gray(`${ms}ms`));
      results.push({ stage, cmd, ok: true, ms });
    } else {
      failed = true;
      log.fail(label, color.gray(`${ms}ms`));
      const out = `${res.stdout}${res.stderr}`.trim();
      if (out) console.error(color.gray(out.split(/\r?\n/).slice(-60).join('\n')));
      results.push({ stage, cmd, ok: false, ms });
      if (values.bail) break;
    }
  }

  if (failed && values.bail) break;
}

const passed = results.filter((r) => r.ok).length;
console.log('');
if (failed) {
  log.fail(color.bold(`校验未通过：${passed}/${results.length} 项通过`));
  process.exit(1);
}
log.ok(color.bold(`校验通过：${passed}/${results.length} 项`));
void positionals;
