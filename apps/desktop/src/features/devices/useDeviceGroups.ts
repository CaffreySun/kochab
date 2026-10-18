import { useCallback, useEffect, useMemo, useState } from 'react';

/** 未分组设备的分组名。用常量而不是空串，才能在 UI 里明确显示出来。 */
export const UNGROUPED = '未分组';

const STORAGE_KEY = 'kochab.deviceGroups';

export interface DeviceGroups {
  /** serial -> 分组名 */
  bySerial: Record<string, string>;
  /** 已知分组名，按创建顺序 */
  names: string[];
}

const EMPTY: DeviceGroups = { bySerial: {}, names: [] };

function sanitize(raw: unknown): DeviceGroups {
  if (!raw || typeof raw !== 'object') return EMPTY;
  const bySerialRaw = (raw as { bySerial?: unknown }).bySerial;
  if (!bySerialRaw || typeof bySerialRaw !== 'object') return EMPTY;

  const bySerial: Record<string, string> = {};
  const names: string[] = [];
  for (const [serial, value] of Object.entries(bySerialRaw as Record<string, unknown>)) {
    // 只接受非空字符串，避免损坏的 localStorage 内容渗进 UI
    if (typeof value !== 'string') continue;
    const name = value.trim();
    if (!name) continue;
    bySerial[serial] = name;
    if (!names.includes(name)) names.push(name);
  }
  return { bySerial, names };
}

/** 读取分组配置；内容损坏时返回空配置，不阻断启动。 */
export function readDeviceGroups(): DeviceGroups {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? sanitize(JSON.parse(raw)) : EMPTY;
  } catch {
    return EMPTY;
  }
}

function persist(groups: DeviceGroups): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(groups));
  } catch {
    // 写不进去就退化成「本次会话内生效」
  }
}

export interface UseDeviceGroups {
  groups: DeviceGroups;
  /** 取某台设备的分组名；未分组返回 `UNGROUPED` */
  groupOf: (serial: string) => string;
  /** 把设备移入某个分组；传 `UNGROUPED` 表示移出分组 */
  assign: (serial: string, name: string) => void;
  /** 新建分组并把设备移进去，返回新分组名 */
  createAndAssign: (serial: string, name: string) => string | null;
  /** 删除分组，组内设备一并变为未分组 */
  removeGroup: (name: string) => void;
}

/**
 * 设备分组。
 *
 * 分组只影响列表的组织方式（筛选 + 排序），不影响任何设备能力，
 * 所以只存「序列号 -> 分组名」，不复制设备信息。
 */
export function useDeviceGroups(): UseDeviceGroups {
  const [groups, setGroups] = useState<DeviceGroups>(EMPTY);

  // 首屏不能先渲染空分组再闪一下，否则用户会看到设备跳位。
  useEffect(() => {
    setGroups(readDeviceGroups());
  }, []);

  const groupOf = useCallback((serial: string) => groups.bySerial[serial] ?? UNGROUPED, [groups]);

  const assign = useCallback((serial: string, name: string) => {
    const trimmed = name.trim();
    setGroups((prev) => {
      const bySerial = { ...prev.bySerial };
      if (!trimmed || trimmed === UNGROUPED) delete bySerial[serial];
      else bySerial[serial] = trimmed;
      const next: DeviceGroups = { bySerial, names: prev.names };
      persist(next);
      return next;
    });
  }, []);

  const createAndAssign = useCallback((serial: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    setGroups((prev) => {
      const bySerial = { ...prev.bySerial, [serial]: trimmed };
      // 名字已存在就直接归入，不要产生同名分组
      const names = prev.names.includes(trimmed) ? prev.names : [...prev.names, trimmed];
      const next: DeviceGroups = { bySerial, names };
      persist(next);
      return next;
    });
    return trimmed;
  }, []);

  const removeGroup = useCallback((name: string) => {
    setGroups((prev) => {
      const bySerial: Record<string, string> = {};
      for (const [serial, group] of Object.entries(prev.bySerial)) {
        if (group !== name) bySerial[serial] = group;
      }
      const next: DeviceGroups = {
        bySerial,
        names: prev.names.filter((n) => n !== name),
      };
      persist(next);
      return next;
    });
  }, []);

  return useMemo(
    () => ({ groups, groupOf, assign, createAndAssign, removeGroup }),
    [groups, groupOf, assign, createAndAssign, removeGroup],
  );
}
