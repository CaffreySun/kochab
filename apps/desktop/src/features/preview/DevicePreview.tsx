import { useEffect, useRef } from 'react';
import { Loading } from 'tdesign-react';
import type { DeviceInfo } from '@ac/ipc-contract';
import type { Api } from '../../ipc';
import { PREVIEW_PRIORITY, useMirror } from '../mirror/useMirror';

/** 卡片缩略图的会话参数：够看清界面即可，重点是省设备与主机开销。 */
export const PREVIEW_OPTIONS = {
  maxSize: 480,
  maxFps: 5,
  bitRate: 1,
} as const;

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
 * 注意 scrcpy 同一个设备只能有一条会话，所以这里和「投屏」工作区是
 * 二选一的关系——离开设备列表时本组件卸载，会话随之结束。
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
  const start = mirror.start;
  const stop = mirror.stop;

  useEffect(() => {
    if (!enabled || device.state !== 'device') return undefined;
    void start();
    return () => {
      void stop();
    };
  }, [enabled, device.serial, device.state, start, stop]);

  if (!enabled) {
    return <span className="ac-preview__placeholder">预览已关闭</span>;
  }

  // 同一台设备同时只能有一条会话：投屏窗口接管后，缩略图会收到 closed 事件。
  // 这时给出明确说明，而不是留一块黑画布让人以为坏了。
  if (mirror.status === 'stopped') {
    return <span className="ac-preview__placeholder">投屏占用中</span>;
  }

  return (
    <div className="ac-preview">
      <canvas ref={canvasRef} className="ac-preview__canvas" data-testid="preview-canvas" />
      {mirror.status === 'starting' ? <Loading loading size="small" /> : null}
      {mirror.status === 'error' ? (
        <span className="ac-preview__error" title={mirror.error ?? undefined}>
          预览失败
        </span>
      ) : null}
    </div>
  );
}
