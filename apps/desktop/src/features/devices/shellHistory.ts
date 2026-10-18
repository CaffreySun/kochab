const STORAGE_KEY = 'kochab.shellHistory';
const LIMIT = 20;

/** 最近执行过的命令；内容损坏时返回空数组，不影响命令行使用。 */
export function readShellHistory(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .slice(0, LIMIT);
  } catch {
    return [];
  }
}

/**
 * 记录一条命令并返回最新历史。
 *
 * 同一命令再次执行时移到最前，而不是留下重复项；
 * 最多保留 20 条，避免 localStorage 越用越大。
 */
export function rememberShellCommand(command: string): string[] {
  const trimmed = command.trim();
  if (!trimmed) return readShellHistory();
  const next = [trimmed, ...readShellHistory().filter((item) => item !== trimmed)].slice(0, LIMIT);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 写不进去就只保留内存里的历史
  }
  return next;
}
