import { useCallback, useRef } from 'react';
import { Button, Loading } from 'tdesign-react';
import type { MirrorStatus } from './useMirror';
import { formatDuration } from '../recording/useRecording';

export interface MirrorStageProps {
  /** 回调 ref：调用方需要把这个 canvas 交给解码器，用回调形式避免 ref 对象的变型问题 */
  setCanvas: (element: HTMLCanvasElement | null) => void;
  status: MirrorStatus;
  error: string | null;
  /** 正在录屏时的秒数；null 表示未录屏 */
  recordingSeconds?: number | null;
  onStart: () => void;
  sendTouch: (action: 'down' | 'move' | 'up', clientX: number, clientY: number) => void;
}

/**
 * 投屏画面（纯展示）。
 *
 * 这里**只**放画面：控制按钮在右侧竖排栏里、设备身份在系统标题栏里，
 * 所以画面能占满整个内容区、几乎不留黑边。
 *
 * 它必须常驻挂载：右栏面板开合时不能卸载本组件，否则会话会被停掉重建，
 * 而 SPS/PPS 只在建连时下发，重建期间画面是黑的。
 */
export function MirrorStage({
  setCanvas,
  status,
  error,
  recordingSeconds = null,
  onStart,
  sendTouch,
}: MirrorStageProps) {
  const dragging = useRef(false);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      dragging.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      sendTouch('down', event.clientX, event.clientY);
    },
    [sendTouch],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!dragging.current) return;
      sendTouch('move', event.clientX, event.clientY);
    },
    [sendTouch],
  );

  const endDrag = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!dragging.current) return;
      dragging.current = false;
      sendTouch('up', event.clientX, event.clientY);
    },
    [sendTouch],
  );

  const streaming = status === 'streaming';

  return (
    <section className="ac-mirror-stage" data-testid="mirror-stage">
      <canvas
        ref={setCanvas}
        className="ac-mirror-stage__canvas"
        data-testid="mirror-canvas"
        onPointerCancel={endDrag}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
      />

      {/* 录制状态不依赖投屏状态：投屏中断/重连时仍然可见 */}
      {recordingSeconds !== null ? (
        <div className="ac-mirror-stage__recording" data-testid="recording-badge">
          <span aria-hidden="true" className="ac-mirror-stage__recording-dot" />
          录制中 {formatDuration(recordingSeconds)}
        </div>
      ) : null}

      {streaming ? null : (
        <div className="ac-mirror-stage__overlay">
          {status === 'starting' ? (
            <Loading loading size="small" text="正在协商会话…" />
          ) : (
            <>
              <Button size="small" theme="primary" onClick={onStart}>
                开始投屏
              </Button>
              <p className="ac-mirror-stage__hint" role={error ? 'alert' : undefined}>
                {error ?? '开始后即可在这台设备上操作应用与文件'}
              </p>
            </>
          )}
        </div>
      )}

      {/* 状态标签给读屏用；视觉上已经在标题栏与浮层里表达过了 */}
      <span className="ac-visually-hidden" data-testid="mirror-status">
        {statusLabel(status)}
      </span>
    </section>
  );
}

function statusLabel(status: MirrorStatus): string {
  switch (status) {
    case 'idle':
      return '未开始';
    case 'starting':
      return '连接中';
    case 'streaming':
      return '投屏中';
    case 'stopped':
      return '已停止';
    case 'busy':
      return '被占用';
    case 'error':
      return '出错';
    default:
      return status;
  }
}
