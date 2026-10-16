import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dropdown, Input, Loading, Space, Tag } from 'tdesign-react';
import {
  AddIcon,
  ArrowLeftIcon,
  HomeIcon,
  KeyboardIcon,
  MinusIcon,
  MoreIcon,
  ViewModuleIcon,
} from 'tdesign-icons-react';
import { ANDROID_KEY, KEYCODE_BACK } from '@ac/scrcpy-web';
import type { DeviceInfo } from '@ac/ipc-contract';
import type { Api } from '../../ipc';
import { MIRROR_PRIORITY, type MirrorStatus, useMirror } from './useMirror';
import { useMirrorOptions } from '../settings/mirrorOptions';

export interface MirrorPaneProps {
  api: Api | null;
  device: DeviceInfo;
  /**
   * 递增的「开始投屏」请求序号。
   *
   * 每次用户从卡片点「投屏」就 +1，用来触发一次自动开始。用计数器而不是布尔值，
   * 是因为用户可能手动停掉之后又点一次「投屏」，布尔值无法表达「再来一次」。
   * 初始值 >0 表示进窗口就自动开始。
   */
  startRequest?: number;
}

/**
 * 设备详情页常驻的投屏面板。
 *
 * 与大屏磁贴的区别：这里不放标题（设备身份由页面头部统一负责），
 * 只留画面 + 一行控制条，把纵向空间尽量让给画面。
 *
 * 它**必须常驻挂载**：右栏在应用 / 文件 / 概览之间切换时不能卸载本组件，
 * 否则投屏会话会被停掉再重建（SPS/PPS 只在建连时下发，重建期间画面是黑的）。
 */
export function MirrorPane({ api, device, startRequest = 0 }: MirrorPaneProps) {
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
  const [textOpen, setTextOpen] = useState(false);
  const dragging = useRef(false);

  const { sendTouch, start, status } = mirror;
  const streaming = status === 'streaming';

  // 已处理到哪个请求序号；用 ref 而不是 state，避免 handler 依赖它引起重渲染。
  const handledStart = useRef(0);
  const startRef = useRef(start);
  useEffect(() => {
    startRef.current = start;
  }, [start]);

  useEffect(() => {
    if (startRequest <= handledStart.current) return;
    handledStart.current = startRequest;
    void startRef.current();
  }, [startRequest]);

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

  const key = (keycode: number) => () => mirror.sendKey(keycode, true);

  return (
    <article className="ac-mirror-pane" data-testid="mirror-pane">
      <div className="ac-mirror-pane__stage">
        <canvas
          ref={canvasRef}
          className="ac-mirror-pane__canvas"
          data-testid="mirror-canvas"
          onPointerCancel={endDrag}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
        />

        {streaming ? null : (
          <div className="ac-mirror-pane__overlay">
            {status === 'starting' ? (
              <Loading loading size="small" text="正在协商会话…" />
            ) : (
              <>
                <Button size="small" theme="primary" onClick={() => void mirror.start()}>
                  开始投屏
                </Button>
                <p className="ac-mirror-pane__hint" role={mirror.error ? 'alert' : undefined}>
                  {mirror.error ?? '开始后即可在这台设备上操作应用与文件'}
                </p>
              </>
            )}
          </div>
        )}
      </div>

      <div className="ac-mirror-pane__controls">
        <Space size="small">
          <Button
            aria-label="返回键"
            disabled={!streaming}
            icon={<ArrowLeftIcon />}
            size="small"
            title="返回"
            variant="outline"
            onClick={key(KEYCODE_BACK)}
          />
          <Button
            aria-label="主页键"
            disabled={!streaming}
            icon={<HomeIcon />}
            size="small"
            title="主页"
            variant="outline"
            onClick={key(ANDROID_KEY.KEYCODE_HOME)}
          />
          <Button
            aria-label="多任务键"
            disabled={!streaming}
            icon={<ViewModuleIcon />}
            size="small"
            title="多任务"
            variant="outline"
            onClick={key(ANDROID_KEY.KEYCODE_APP_SWITCH)}
          />
          <Button
            aria-label="音量减"
            disabled={!streaming}
            icon={<MinusIcon />}
            size="small"
            title="音量 −"
            variant="outline"
            onClick={key(ANDROID_KEY.KEYCODE_VOLUME_DOWN)}
          />
          <Button
            aria-label="音量加"
            disabled={!streaming}
            icon={<AddIcon />}
            size="small"
            title="音量 +"
            variant="outline"
            onClick={key(ANDROID_KEY.KEYCODE_VOLUME_UP)}
          />
          <Button
            aria-label="注入文字"
            disabled={!streaming}
            icon={<KeyboardIcon />}
            size="small"
            theme={textOpen ? 'primary' : 'default'}
            title="注入文字"
            variant={textOpen ? 'base' : 'outline'}
            onClick={() => setTextOpen((prev) => !prev)}
          />
          <Dropdown
            maxColumnWidth={140}
            options={[
              { content: '停止投屏', value: 'stop', disabled: !streaming },
              { content: '重新开始', value: 'restart', disabled: !streaming },
            ]}
            placement="top-right"
            trigger="click"
            onClick={(option) => {
              if (option.value === 'stop') void mirror.stop();
              if (option.value === 'restart') void mirror.stop().then(() => mirror.start());
            }}
          >
            <Button
              aria-label="更多投屏操作"
              icon={<MoreIcon />}
              size="small"
              title="更多"
              variant="outline"
            />
          </Dropdown>
        </Space>

        <Space size="small">
          {mirror.info ? (
            <Tag data-testid="mirror-resolution" size="small" variant="light-outline">
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
            theme={streaming ? 'success' : status === 'error' ? 'danger' : 'default'}
            variant="light-outline"
          >
            {statusLabel(status)}
          </Tag>
        </Space>
      </div>

      {textOpen ? (
        <div className="ac-mirror-pane__text">
          <Input
            disabled={!streaming}
            placeholder="输入文字后点右侧按钮注入到设备"
            size="small"
            value={draftText}
            onChange={(value) => setDraftText(value)}
          />
          <Button
            disabled={!streaming || draftText.length === 0}
            size="small"
            variant="outline"
            onClick={() => {
              void mirror.sendText(draftText).then(() => setDraftText(''));
            }}
          >
            注入
          </Button>
        </div>
      ) : null}
    </article>
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
