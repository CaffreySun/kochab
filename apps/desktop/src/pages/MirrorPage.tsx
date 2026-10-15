import { useCallback, useRef, useState } from 'react';
import { Button, Input, Space, Tag } from 'tdesign-react';
import { ANDROID_KEY, KEYCODE_BACK } from '@ac/scrcpy-web';
import type { DeviceInfo } from '@ac/ipc-contract';
import { EmptyState } from '@ac/ui';
import type { Api } from '../ipc';
import { useMirror } from '../features/mirror/useMirror';

export interface MirrorPageProps {
  api: Api | null;
  device: DeviceInfo | null;
}

/** 投屏页：可交互画布 + 常用按键 + 实时统计。 */
export function MirrorPage({ api, device }: MirrorPageProps) {
  const serial = device?.state === 'device' ? device.serial : null;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mirror = useMirror(api, serial, canvasRef);
  const [draftText, setDraftText] = useState('');
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

  // 切换设备时不需要额外收尾：`useMirror` 在卸载/换设备时自己会结束会话
  if (!device) {
    return (
      <EmptyState description="请先在「设备」页选择一台已授权的设备。" title="没有选中的设备" />
    );
  }

  if (device.state !== 'device') {
    return (
      <EmptyState
        description={`设备当前状态为 ${device.state}，投屏需要设备处于已授权就绪状态。`}
        title="设备未就绪"
      />
    );
  }

  const streaming = mirror.status === 'streaming';

  return (
    <div className="ac-mirror">
      <div className="ac-mirror__toolbar">
        <Space breakLine size="small">
          <Button
            disabled={streaming}
            loading={mirror.status === 'starting'}
            size="small"
            theme="primary"
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
          <Tag
            data-testid="mirror-status"
            theme={streaming ? 'success' : 'default'}
            variant="light-outline"
          >
            {statusLabel(mirror.status)}
          </Tag>
          {mirror.info ? (
            <Tag variant="light-outline">
              {mirror.info.width}×{mirror.info.height} · {mirror.info.codec}
            </Tag>
          ) : null}
          {mirror.stats ? (
            <Tag data-testid="mirror-fps" variant="light-outline">
              {mirror.stats.fps.toFixed(1)} fps · {formatBytes(mirror.stats.bytes)}
            </Tag>
          ) : null}
        </Space>
      </div>

      {mirror.error ? (
        <div role="alert">
          <Tag theme="danger" variant="light-outline">
            {mirror.error}
          </Tag>
        </div>
      ) : null}

      <div className="ac-mirror__stage">
        <canvas
          ref={canvasRef}
          className="ac-mirror__canvas"
          data-testid="mirror-canvas"
          onPointerCancel={endDrag}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
        />
        {!streaming ? (
          <p className="ac-mirror__hint">
            {mirror.status === 'starting' ? '正在协商会话…' : '点击「开始投屏」建立会话。'}
          </p>
        ) : null}
      </div>

      <div className="ac-mirror__controls">
        <Space breakLine size="small">
          <Button size="small" variant="outline" onClick={() => mirror.sendKey(KEYCODE_BACK, true)}>
            返回
          </Button>
          <Button
            size="small"
            variant="outline"
            onClick={() => mirror.sendKey(ANDROID_KEY.KEYCODE_HOME, true)}
          >
            主页
          </Button>
          <Button
            size="small"
            variant="outline"
            onClick={() => mirror.sendKey(ANDROID_KEY.KEYCODE_APP_SWITCH, true)}
          >
            多任务
          </Button>
          <Button
            size="small"
            variant="outline"
            onClick={() => mirror.sendKey(ANDROID_KEY.KEYCODE_VOLUME_UP, true)}
          >
            音量 +
          </Button>
          <Button
            size="small"
            variant="outline"
            onClick={() => mirror.sendKey(ANDROID_KEY.KEYCODE_VOLUME_DOWN, true)}
          >
            音量 −
          </Button>
          <Button
            size="small"
            variant="outline"
            onClick={() => mirror.sendKey(ANDROID_KEY.KEYCODE_POWER, true)}
          >
            电源
          </Button>
          <Button
            size="small"
            variant="outline"
            onClick={() => mirror.sendScroll(window.innerWidth / 2, window.innerHeight / 2, 0, -1)}
          >
            上滑
          </Button>
        </Space>

        <Space size="small">
          <Input
            placeholder="输入文字后回车注入"
            size="small"
            value={draftText}
            onChange={(value) => setDraftText(value)}
          />
          <Button
            size="small"
            variant="outline"
            onClick={() => {
              void mirror.sendText(draftText).then(() => setDraftText(''));
            }}
          >
            注入文本
          </Button>
        </Space>
      </div>
    </div>
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
