const useColor = process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
const paint = (code) => (text) => (useColor ? `\u001B[${code}m${text}\u001B[0m` : text);

export const color = {
  reset: '\u001B[0m',
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  blue: paint('34'),
  magenta: paint('35'),
  cyan: paint('36'),
  gray: paint('90'),
};

const SYMBOL = {
  info: color.cyan('•'),
  ok: color.green('✔'),
  fail: color.red('✖'),
  warn: color.yellow('!'),
  skip: color.gray('-'),
};

export const log = {
  info: (...a) => console.log(`${SYMBOL.info} ${a.join(' ')}`),
  ok: (...a) => console.log(`${SYMBOL.ok} ${a.join(' ')}`),
  fail: (...a) => console.error(`${SYMBOL.fail} ${a.join(' ')}`),
  warn: (...a) => console.warn(`${SYMBOL.warn} ${a.join(' ')}`),
  skip: (...a) => console.log(`${SYMBOL.skip} ${color.gray(a.join(' '))}`),
  step: (title) => console.log(`\n${color.bold(color.blue('▌'))} ${color.bold(title)}`),
  plain: (...a) => console.log(...a),
};

export function table(rows, headers) {
  if (rows.length === 0) return;
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)),
  );
  const line = (cells) => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
  console.log(color.bold(line(headers)));
  console.log(color.gray(widths.map((w) => '─'.repeat(w)).join('  ')));
  for (const row of rows) console.log(line(row));
}
