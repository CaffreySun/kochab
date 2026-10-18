import { useCallback, useEffect, useMemo, useState } from 'react';

/** 设备本地偏好：用户起的名字与置顶顺序。只影响列表展示，不影响设备能力。 */
export interface DevicePrefs {
  /** serial -> 自定义名称 */
  aliases: Record<string, string>;
  /** 置顶的 serial，按置顶顺序 */
  pinned: string[];
}

const STORAGE_KEY = 'kochab.devicePrefs';
const EMPTY: DevicePrefs = { aliases: {}, pinned: [] };

/** 只接受合法内容；localStorage 可能被旧版本或手工编辑污染。 */
export function sanitizeDevicePrefs(raw: unknown): DevicePrefs {
  if (!raw || typeof raw !== 'object') return EMPTY;
  const value = raw as { aliases?: unknown; pinned?: unknown };

  const aliases: Record<string, string> = {};
  if (value.aliases && typeof value.aliases === 'object') {
    for (const [serial, name] of Object.entries(value.aliases as Record<string, unknown>)) {
      if (typeof name !== 'string') continue;
      const trimmed = name.trim();
      if (serial && trimmed) aliases[serial] = trimmed;
    }
  }

  const pinned: string[] = [];
  if (Array.isArray(value.pinned)) {
    for (const serial of value.pinned) {
      if (typeof serial === 'string' && serial && !pinned.includes(serial)) {
        pinned.push(serial);
      }
    }
  }

  return { aliases, pinned };
}

export function readDevicePrefs(): DevicePrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? sanitizeDevicePrefs(JSON.parse(raw)) : EMPTY;
  } catch {
    return EMPTY;
  }
}

function persist(prefs: DevicePrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // 写不进去就只在本次会话生效
  }
}

export interface UseDevicePrefs {
  prefs: DevicePrefs;
  aliasOf: (serial: string) => string | undefined;
  setAlias: (serial: string, name: string) => void;
  isPinned: (serial: string) => boolean;
  togglePinned: (serial: string) => void;
}

export function useDevicePrefs(): UseDevicePrefs {
  const [prefs, setPrefs] = useState<DevicePrefs>(EMPTY);

  useEffect(() => {
    setPrefs(readDevicePrefs());
  }, []);

  const aliasOf = useCallback((serial: string) => prefs.aliases[serial], [prefs]);

  const setAlias = useCallback((serial: string, name: string) => {
    const trimmed = name.trim();
    setPrefs((prev) => {
      const aliases = { ...prev.aliases };
      if (trimmed) aliases[serial] = trimmed;
      else delete aliases[serial];
      const next = { ...prev, aliases };
      persist(next);
      return next;
    });
  }, []);

  const isPinned = useCallback((serial: string) => prefs.pinned.includes(serial), [prefs]);

  const togglePinned = useCallback((serial: string) => {
    setPrefs((prev) => {
      const pinned = prev.pinned.includes(serial)
        ? prev.pinned.filter((item) => item !== serial)
        : [serial, ...prev.pinned];
      const next = { ...prev, pinned };
      persist(next);
      return next;
    });
  }, []);

  return useMemo(
    () => ({ prefs, aliasOf, setAlias, isPinned, togglePinned }),
    [prefs, aliasOf, setAlias, isPinned, togglePinned],
  );
}
