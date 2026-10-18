import { useEffect, useRef } from 'react';
import { Loading } from 'tdesign-react';
import type { DeviceInfo } from '@kochab/ipc-contract';
import type { Api } from '../../ipc';
import { PREVIEW_PRIORITY, useMirror } from '../mirror/useMirror';

/** 卡片缩略图的会话参数：够看清界面即可，重点是省设备与主机开销。 */
export const PREVIEW_OPTIONS = {
  maxSize: 480,
  maxFps: 5,
  bitRate: 1,
} as const;

/** 退避重试间隔（毫秒）。投屏窗口可能开很久，间隔要逐步拉长而不是死循环。 */
const RETRY_DELAYS = [800, 1600, 3200, 5000, 8000] as const;

export interface DevicePreviewProps {
  api: Api | null;
  device: DeviceInfo;
  /** 是否启用预览（关闭或超出并发上限时只显示占位） */
  enabled: boolean;
}

/**
 * 设备卡片上的屏幕缩略图。
 *
 * 本质是一条**低清低帧率**的投屏会话：每台设备一条，彼此独立。
 * scrcpy 同一个设备只能有一条会话，所以这里和「投屏」窗口是二选一的关系：
 * 用户开投屏窗口时缩略图让位，**关掉投屏窗口后会自动恢复**。
 */
export function DevicePreview({ api, device, enabled }: DevicePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mirror = useMirror(
    api,
    device.serial,
    canvasRef,
    PREVIEW_OPTIONS,
    'preview',
    PREVIEW_PRIORITY,
  );
  const { start, stop, status } = mirror;

  useEffect(() => {
    if (!enabled || device.state !== 'device') return undefined;
    void start();
    return () => {
      void stop();
    };
  }, [enabled, device.serial, device.state, start, stop]);

  // 被投屏窗口占用时按退避重试；投屏一关掉，缩略图就自己回来。
  const attemptRef = useRef(0);
  useEffect(() => {
    if (!enabled || device.state !== 'device') {
      attemptRef.current = 0;
      return undefined;
    }
    // stopped = 会话被更高优先级抢占；busy = 抢回来时对方还占着
    if (status !== 'stopped' && status !== 'busy') {
      if (status === 'streaming') attemptRef.current = 0;
      return undefined;
    }

    const index = Math.min(attemptRef.current, RETRY_DELAYS.length - 1);
    attemptRef.current += 1;
    const timer = window.setTimeout(() => {
      void start();
    }, RETRY_DELAYS[index]);
    return () => {
      window.clearTimeout(timer);
    };
  }, [status, enabled, device.serial, device.state, start]);

  if (!enabled) {
    return <span className="kochab-preview__placeholder">预览已关闭</span>;
  }

  // 同一台设备同时只能有一条会话：投屏窗口接管后缩略图必须让位，
  // 并明确告知原因，而不是留一块黑画布让人以为坏了。
  if (status === 'stopped' || status === 'busy') {
    return <span className="kochab-preview__placeholder">投屏占用中</span>;
  }

  return (
    <div className="kochab-preview">
      <canvas ref={canvasRef} className="kochab-preview__canvas" data-testid="preview-canvas" />
      {status === 'starting' ? <Loading loading size="small" /> : null}
      {status === 'error' ? (
        <span className="kochab-preview__error" title={mirror.error ?? undefined}>
          预览失败
        </span>
      ) : null}
    </div>
  );
}
