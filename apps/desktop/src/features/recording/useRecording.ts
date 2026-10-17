import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RecordingStatus, SavedFile } from '@ac/ipc-contract';
import type { Api } from '../../ipc';

const INACTIVE: RecordingStatus = { active: false, startedAt: null, maxSeconds: 180 };

/** `2026-10-17 21:15:30` → `20261017_211530`，用于下载目录里的文件名。 */
export function fileStamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** 读秒显示；超过 1 小时也只显示 `mm:ss`，录屏上限只有 3 分钟。 */
export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

export interface UseRecordingOptions {
  /** 到达设备端时限自动停止并保存成功时回调（只在一个窗口触发） */
  onSaved?: (file: SavedFile) => void;
}

export interface RecordingView {
  active: boolean;
  startedAt: number | null;
  maxSeconds: number;
  elapsed: number;
  busy: boolean;
  start: () => Promise<void>;
  stop: () => Promise<SavedFile | null>;
  cancel: () => Promise<void>;
}

/**
 * 单台设备的录屏状态。
 *
 * 状态真值在 Rust 侧：同一台设备在设备页、投屏窗口、设备菜单里各有一个组件实例，
 * 任何一个入口开始/停止都会通过 `recording://changed` 同步到其它窗口。
 * 因此这里不在组件卸载时停止录屏——投屏中断或窗口关闭不应打断录制。
 */
export function useRecording(
  api: Api | null,
  serial: string,
  options: UseRecordingOptions = {},
): RecordingView {
  const [status, setStatus] = useState<RecordingStatus>(INACTIVE);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const stoppingRef = useRef(false);
  const autoStoppedRef = useRef(false);
  const onSavedRef = useRef(options.onSaved);

  useEffect(() => {
    onSavedRef.current = options.onSaved;
  }, [options.onSaved]);

  useEffect(() => {
    if (!api || !serial) return;
    let alive = true;
    let unlisten: (() => void) | undefined;

    void api
      .recordStatus(serial)
      .then((next) => {
        if (alive) setStatus(next);
      })
      .catch(() => {
        // 查询失败时按未录制处理；真正的开始/停止仍会返回明确错误
      });

    void api
      .onRecordingChanged((payload) => {
        if (payload.serial !== serial) return;
        setStatus({
          active: payload.active,
          startedAt: payload.startedAt,
          maxSeconds: payload.maxSeconds,
        });
      })
      .then((off) => {
        if (alive) unlisten = off;
        else off();
      });

    return () => {
      alive = false;
      unlisten?.();
    };
  }, [api, serial]);

  useEffect(() => {
    if (!status.active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [status.active, status.startedAt]);

  const elapsed =
    status.active && status.startedAt
      ? Math.max(0, Math.floor((now - status.startedAt) / 1000))
      : 0;

  const start = useCallback(async () => {
    if (!api || !serial || busy) return;
    setBusy(true);
    try {
      setStatus(await api.startRecording(serial));
    } finally {
      setBusy(false);
    }
  }, [api, busy, serial]);

  const stop = useCallback(async (): Promise<SavedFile | null> => {
    if (!api || !serial || stoppingRef.current) return null;
    stoppingRef.current = true;
    setBusy(true);
    try {
      const saved = await api.stopRecording(serial, `录屏_${fileStamp()}`);
      setStatus(INACTIVE);
      return saved;
    } finally {
      stoppingRef.current = false;
      setBusy(false);
    }
  }, [api, serial]);

  const cancel = useCallback(async () => {
    if (!api || !serial || busy) return;
    setBusy(true);
    try {
      await api.cancelRecording(serial);
      setStatus(INACTIVE);
    } finally {
      setBusy(false);
    }
  }, [api, busy, serial]);

  useEffect(() => {
    if (!status.active) {
      autoStoppedRef.current = false;
      return;
    }
    if (status.maxSeconds <= 0 || elapsed < status.maxSeconds) return;
    if (autoStoppedRef.current) return;
    autoStoppedRef.current = true;
    void stop()
      .then((saved) => {
        if (saved) onSavedRef.current?.(saved);
      })
      .catch(() => {
        // 自动停止失败时保持 active，用户仍可手动重试
        autoStoppedRef.current = false;
      });
  }, [elapsed, status.active, status.maxSeconds, stop]);

  return useMemo(
    () => ({
      active: status.active,
      startedAt: status.startedAt,
      maxSeconds: status.maxSeconds,
      elapsed,
      busy,
      start,
      stop,
      cancel,
    }),
    [status, elapsed, busy, start, stop, cancel],
  );
}
