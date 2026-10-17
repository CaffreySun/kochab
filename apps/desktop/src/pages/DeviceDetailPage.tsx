import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Button, Dialog, MessagePlugin, Textarea } from 'tdesign-react';
import type { DeviceInfo } from '@ac/ipc-contract';
import { EmptyState } from '@ac/ui';
import type { Api } from '../ipc';
import { toMessage } from '../ipc';
import { fileStamp } from '../features/devices/RecordDialog';
import { MIRROR_PRIORITY, useMirror } from '../features/mirror/useMirror';
import { MirrorRail } from '../features/mirror/MirrorRail';
import { MirrorStage } from '../features/mirror/MirrorStage';
import { useMirrorOptions } from '../features/settings/mirrorOptions';
import { useDetailWindow } from '../features/window/useDetailWindow';
import type { DetailPanel } from '../windowMode';
import { AppsPage } from './AppsPage';
import { FilesPage } from './FilesPage';
import { OverviewPage } from './OverviewPage';

/** `1080x2160` → 宽高比；解析不出来时给出 null。 */
function parseResolution(resolution: string | null): number | null {
  const match = resolution?.match(/^(\d+)x(\d+)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return width / height;
}

export interface DeviceDetailPageProps {
  api: Api | null;
  device: DeviceInfo | null;
  /** 当前打开的面板；`null` 表示只有投屏 */
  panel: DetailPanel | null;
  onPanelChange: (panel: DetailPanel | null) => void;
  /** 递增的「开始投屏」请求序号 */
  startRequest: number;
}

/**
 * 设备详情页。
 *
 * 形态是「一块 9:16 的投屏 + 右侧一条竖排按钮栏」，设备身份写在系统标题栏里，
 * 所以内容区没有头部、没有标签页，画面基本占满。
 *
 * 点应用 / 概览 / 文件只是把窗口向右变宽、多出一块面板；投屏组件**不卸载**——
 * 卸载会停掉会话再重建，而 SPS/PPS 只在建连时下发，重建期间画面是黑的。
 */
export function DeviceDetailPage({
  api,
  device,
  panel,
  onPanelChange,
  startRequest,
}: DeviceDetailPageProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // 解码器要拿到同一个 canvas；用回调 ref 把它交给 useMirror 持有的 ref
  const setCanvas = useCallback((element: HTMLCanvasElement | null) => {
    canvasRef.current = element;
  }, []);
  const options = useMirrorOptions();
  const serial = device?.serial ?? '';

  const mirror = useMirror(
    api,
    serial,
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

  const [textOpen, setTextOpen] = useState(false);
  const [draftText, setDraftText] = useState('');

  // 设备旋转后画面尺寸会变，窗口比例必须跟着换，否则横屏画面被塞进竖屏窗口
  const liveResolution = mirror.info ? `${mirror.info.width}x${mirror.info.height}` : null;
  const aspect = mirror.info
    ? mirror.info.width / mirror.info.height
    : (parseResolution(device?.screenResolution ?? null) ?? 9 / 16);

  useDetailWindow(device, panel !== null, liveResolution);

  const { start, status } = mirror;
  const startRef = useRef(start);
  useEffect(() => {
    startRef.current = start;
  }, [start]);

  // 已处理到哪个请求序号；用 ref 而不是 state，避免 handler 依赖它引起重渲染。
  // 用计数器而不是布尔值：用户手动停掉之后又点一次「投屏」也要能再启动一次。
  const handledStart = useRef(0);
  useEffect(() => {
    if (!device) return;
    if (startRequest <= handledStart.current) return;
    handledStart.current = startRequest;
    void startRef.current();
  }, [startRequest, device]);

  const { pressKey } = mirror;
  const onKey = useCallback((keycode: number) => void pressKey(keycode), [pressKey]);

  const takeScreenshot = useCallback(async () => {
    if (!api || !device) return;
    try {
      const saved = await api.screenshot(device.serial, `截屏_${fileStamp()}`);
      await MessagePlugin.success(`已保存到 ${saved.path}`);
    } catch (cause) {
      await MessagePlugin.error(`截屏失败：${toMessage(cause)}`);
    }
  }, [api, device]);

  if (!device) {
    return (
      <div className="ac-detail">
        <EmptyState description="请回到主窗口的设备列表重新连接后再打开。" title="设备未连接" />
      </div>
    );
  }

  const streaming = status === 'streaming';

  return (
    <div
      className="ac-detail"
      data-orientation={aspect > 1 ? 'landscape' : 'portrait'}
      style={{ '--ac-mirror-aspect': aspect } as CSSProperties}
    >
      {/* 画面与竖排按钮栏始终在一起：横屏时这一组在上、面板在下 */}
      <div className="ac-detail__main">
        <MirrorStage
          error={mirror.error}
          info={mirror.info}
          sendTouch={mirror.sendTouch}
          setCanvas={setCanvas}
          stats={mirror.stats}
          status={status}
          onStart={() => void mirror.start()}
        />

        <MirrorRail
          panel={panel}
          status={status}
          onKey={onKey}
          onOpenText={() => setTextOpen(true)}
          onRestart={() => {
            void mirror.stop().then(() => mirror.start());
          }}
          onScreenshot={() => void takeScreenshot()}
          onStop={() => void mirror.stop()}
          onTogglePanel={(next) => onPanelChange(panel === next ? null : next)}
        />
      </div>

      {panel ? (
        <section className="ac-detail__panel">
          {panel === 'apps' ? <AppsPage api={api} device={device} /> : null}
          {panel === 'files' ? <FilesPage api={api} device={device} /> : null}
          {panel === 'overview' ? <OverviewPage api={api} device={device} /> : null}
        </section>
      ) : null}

      {/* 文字注入用弹窗：竖排按钮栏塞不下输入框，放画面底部又会占掉一条画面高度 */}
      {textOpen ? (
        <Dialog
          visible
          attach="body"
          cancelBtn={null}
          confirmBtn={null}
          header="注入文字"
          onCancel={() => setTextOpen(false)}
          onClose={() => setTextOpen(false)}
        >
          <div className="ac-detail__text">
            <Textarea
              autosize={{ minRows: 2, maxRows: 5 }}
              disabled={!streaming}
              placeholder="输入要发送到设备的文字"
              value={draftText}
              onChange={(value) => setDraftText(value)}
            />
            <div className="ac-detail__text-actions">
              <Button
                disabled={!streaming || draftText.length === 0}
                size="small"
                theme="primary"
                onClick={() => {
                  void mirror.sendText(draftText).then(() => {
                    setDraftText('');
                    setTextOpen(false);
                  });
                }}
              >
                注入
              </Button>
              <Button size="small" variant="outline" onClick={() => setTextOpen(false)}>
                关闭
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
