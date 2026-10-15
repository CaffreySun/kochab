import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DeviceInfo } from '@ac/ipc-contract';
import { createApi, createDefaultTransport, type Api } from '../../ipc';

export type DevicesStatus = 'loading' | 'ready' | 'error';

export interface DevicesState {
  devices: DeviceInfo[];
  status: DevicesStatus;
  error: string | null;
  selectedSerial: string | null;
  select: (serial: string | null) => void;
  refresh: () => Promise<void>;
  /** 传输层类型，用于界面提示当前是否处于浏览器预览模式 */
  transportKind: 'tauri' | 'mock' | null;
}

/** 初始化 API（真实传输或浏览器预览用的模拟传输） */
export function useApi(): Api | null {
  const [api, setApi] = useState<Api | null>(null);

  useEffect(() => {
    let cancelled = false;
    void createDefaultTransport().then((transport) => {
      if (!cancelled) setApi(createApi(transport));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return api;
}

/**
 * 设备列表状态。
 *
 * 设计约束：
 * 1. 设备列表由后端事件驱动（`device://changed`），前端不轮询；
 * 2. 进入页面时主动拉取一次作为初始快照；
 * 3. 选中的设备必须存在于列表中，设备被拔掉后自动回退到第一台。
 */
export function useDevices(api: Api | null): DevicesState {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [status, setStatus] = useState<DevicesStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [selectedSerial, setSelectedSerial] = useState<string | null>(null);

  const applyDevices = useCallback((list: DeviceInfo[]) => {
    setDevices(list);
    setStatus('ready');
    setError(null);
    setSelectedSerial((prev) =>
      prev && list.some((d) => d.serial === prev) ? prev : (list[0]?.serial ?? null),
    );
  }, []);

  const failWith = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
    setStatus('error');
  }, []);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      applyDevices(await api.deviceList());
    } catch (e) {
      failWith(e);
    }
  }, [api, applyDevices, failWith]);

  useEffect(() => {
    if (!api) return undefined;

    let disposed = false;
    const unlisteners: Array<() => void> = [];

    void (async () => {
      try {
        const list = await api.deviceList();
        if (!disposed) applyDevices(list);
      } catch (e) {
        if (!disposed) failWith(e);
      }
    })();

    void api
      .onDeviceChanged((next) => {
        if (!disposed) applyDevices(next);
      })
      .then((un) => unlisteners.push(un));

    void api
      .onAdbServerLost((reason) => {
        if (!disposed) failWith(reason || 'adb server 已断开');
      })
      .then((un) => unlisteners.push(un));

    return () => {
      disposed = true;
      for (const un of unlisteners) un();
    };
  }, [api, applyDevices, failWith]);

  return useMemo(
    () => ({
      devices,
      status,
      error,
      selectedSerial,
      select: setSelectedSerial,
      refresh,
      transportKind: api?.transportKind ?? null,
    }),
    [devices, status, error, selectedSerial, refresh, api],
  );
}
