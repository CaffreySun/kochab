import { useCallback, useRef, useState } from 'react';
import { Button, Input, Space, Tag } from 'tdesign-react';
import { ANDROID_KEY, KEYCODE_BACK } from '@ac/scrcpy-web';
import type { DeviceInfo } from '@ac/ipc-contract';
import type { Api } from '../../ipc';
import { MIRROR_PRIORITY, useMirror } from './useMirror';
import { useMirrorOptions } from '../settings/mirrorOptions';

export interface MirrorTileProps {
  api: Api | null;
  device: DeviceInfo;
}

/**
 * 单台设备的投屏磁贴。
 *
 * 每块磁贴**自带完整的会话与解码器**（一个 `useMirror` 实例、一块画布），
 * 因此同一页面里放 N 块就是 N 路并发投屏，彼此互不干扰：
 * 事件按 `sessionId` 分发，各自的解码器只吃自己那一路的帧。
 */
export function MirrorTile({ api, device }: MirrorTileProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const options = useMirrorOptions();
  const mirror = useMirror(
    api,
    device.serial,
    canvasRef,
    {
      maxSize: options.maxSize,
      maxFps: options.maxFps,
      bitRate: options.bitRate,
      showTouches: options.showTouches,
      stayAwake: options.stayAwake,
    },
    'mirror',
    MIRROR_PRIORITY,
  );
  const [draftText, setDraftText] = useState('');
  const [expanded, setExpanded] = useState(false);
  const dragging = useRef(false);

  const { sendTouch } = mirror;

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

  const title = [device.manufacturer, device.model].filter(Boolean).join(' ') || device.serial;
  const streaming = mirror.status === 'streaming';

  return (
    <article
      className={['ac-mirror-tile', expanded ? 'ac-mirror-tile--expanded' : '']
        .filter(Boolean)
        .join(' ')}
      data-serial={device.serial}
      data-testid="mirror-tile"
    >
      <header className="ac-mirror-tile__header">
        <span className="ac-mirror-tile__title">{title}</span>
        <Space size="small">
          {mirror.info ? (
            <Tag size="small" variant="light-outline">
              {mirror.info.width}×{mirror.info.height}
            </Tag>
          ) : null}
          {mirror.stats ? (
            <Tag data-testid="mirror-fps" size="small" variant="light-outline">
              {mirror.stats.fps.toFixed(0)} fps
            </Tag>
          ) : null}
          <Tag
            data-testid="mirror-status"
            size="small"
            theme={streaming ? 'success' : mirror.status === 'error' ? 'danger' : 'default'}
            variant="light-outline"
          >
            {statusLabel(mirror.status)}
          </Tag>
          <Button size="small" variant="text" onClick={() => setExpanded((prev) => !prev)}>
            {expanded ? '收起' : '放大'}
          </Button>
        </Space>
      </header>

      <div className="ac-mirror-tile__stage">
        <canvas
          ref={canvasRef}
          className="ac-mirror-tile__canvas"
          data-testid="mirror-canvas"
          onPointerCancel={endDrag}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
        />
        {!streaming ? (
          <p className="ac-mirror-tile__hint">
            {mirror.status === 'starting' ? '正在协商会话…' : '点击「开始投屏」建立会话'}
          </p>
        ) : null}
      </div>

      {mirror.error ? (
        <p className="ac-mirror-tile__error" role="alert">
          {mirror.error}
        </p>
      ) : null}

      <footer className="ac-mirror-tile__footer">
        <Space breakLine size="small">
          <Button
            disabled={streaming}
            loading={mirror.status === 'starting'}
            size="small"
            theme="primary"
            variant={streaming ? 'outline' : 'base'}
            onClick={() => void mirror.start()}
          >
            开始投屏
          </Button>
          <Button
            disabled={!mirror.info}
            size="small"
            variant="outline"
            onClick={() => void mirror.stop()}
          >
            停止
          </Button>
          <Button
            disabled={!streaming}
            size="small"
            variant="outline"
            onClick={() => mirror.sendKey(KEYCODE_BACK, true)}
          >
            返回
          </Button>
          <Button
            disabled={!streaming}
            size="small"
            variant="outline"
            onClick={() => mirror.sendKey(ANDROID_KEY.KEYCODE_HOME, true)}
          >
            主页
          </Button>
          <Button
            disabled={!streaming}
            size="small"
            variant="outline"
            onClick={() => mirror.sendKey(ANDROID_KEY.KEYCODE_APP_SWITCH, true)}
          >
            多任务
          </Button>
          <Button
            disabled={!streaming}
            size="small"
            variant="outline"
            onClick={() => mirror.sendKey(ANDROID_KEY.KEYCODE_VOLUME_DOWN, true)}
          >
            音量 −
          </Button>
          <Button
            disabled={!streaming}
            size="small"
            variant="outline"
            onClick={() => mirror.sendKey(ANDROID_KEY.KEYCODE_VOLUME_UP, true)}
          >
            音量 +
          </Button>
        </Space>

        {expanded ? (
          <Space size="small">
            <Input
              placeholder="输入文字后点右侧按钮注入"
              size="small"
              value={draftText}
              onChange={(value) => setDraftText(value)}
            />
            <Button
              disabled={!streaming}
              size="small"
              variant="outline"
              onClick={() => {
                void mirror.sendText(draftText).then(() => setDraftText(''));
              }}
            >
              注入文本
            </Button>
          </Space>
        ) : null}
      </footer>
    </article>
  );
}

function statusLabel(status: ReturnType<typeof useMirror>['status']): string {
  switch (status) {
    case 'idle':
      return '未开始';
    case 'starting':
      return '连接中';
    case 'streaming':
      return '投屏中';
    case 'stopped':
      return '已停止';
    case 'error':
      return '出错';
    default:
      return status;
  }
}
