import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Tabs, Tag } from 'tdesign-react';
import { DesktopIcon, ViewListIcon } from 'tdesign-icons-react';
import type { DeviceInfo } from '@ac/ipc-contract';
import { EmptyState } from '@ac/ui';
import type { Api } from '../ipc';
import { MirrorPane } from '../features/mirror/MirrorPane';
import type { DetailPanel } from '../windowMode';
import { AppsPage } from './AppsPage';
import { FilesPage } from './FilesPage';
import { OverviewPage } from './OverviewPage';

export interface DeviceDetailPageProps {
  api: Api | null;
  device: DeviceInfo | null;
  /** 右栏当前面板 */
  panel: DetailPanel;
  onPanelChange: (panel: DetailPanel) => void;
  /** 递增的「开始投屏」请求序号，见 `MirrorPane` */
  startRequest: number;
}

const SPLIT_KEY = 'ac.detailSplit';
/** 左栏（投屏）默认占比 */
const DEFAULT_SPLIT = 40;
/**
 * 两侧的最小可用宽度（像素）。
 *
 * 投屏区小于约 320px 就看不清画面，右栏小于约 460px 表格就没法用，
 * 所以拖拽被两端夹住；窗口自身的 minWidth 保证两者能同时满足。
 */
const MIN_LEFT_PX = 320;
const MIN_RIGHT_PX = 460;
const MIN_SPLIT = 20;
const MAX_SPLIT = 80;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 读取上次的栏宽比例；损坏或缺失时回落到默认值。 */
function readSplit(): number {
  try {
    const raw = window.localStorage.getItem(SPLIT_KEY);
    const value = raw === null ? Number.NaN : Number(raw);
    if (Number.isFinite(value)) return clamp(value, MIN_SPLIT, MAX_SPLIT);
  } catch {
    // localStorage 不可用（隐私模式）：用默认比例即可，不必打断页面
  }
  return DEFAULT_SPLIT;
}

function persistSplit(value: number): void {
  try {
    window.localStorage.setItem(SPLIT_KEY, String(value));
  } catch {
    // 写不进去就退化成「本次窗口内生效」
  }
}

/**
 * 设备详情页。
 *
 * 布局是「投屏常驻左栏 + 右栏切换 应用 / 文件 / 概览」：投屏是这台设备唯一
 * 持续变化的信息，所以它不参与标签切换——切面板时**不能卸载** `MirrorPane`，
 * 否则会话会被停掉重建。
 */
export function DeviceDetailPage({
  api,
  device,
  panel,
  onPanelChange,
  startRequest,
}: DeviceDetailPageProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const [split, setSplit] = useState(readSplit);
  const splitRef = useRef(split);
  const [panelHidden, setPanelHidden] = useState(false);

  useEffect(() => {
    splitRef.current = split;
  }, [split]);

  const onSplitterDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    draggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const onSplitterMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const rect = rootRef.current?.getBoundingClientRect();
    // jsdom 里没有布局，getBoundingClientRect 全是 0，直接跳过避免除零
    if (!rect || rect.width <= 0) return;

    const minPct = (MIN_LEFT_PX / rect.width) * 100;
    const maxPct = 100 - (MIN_RIGHT_PX / rect.width) * 100;
    // 容器窄到两个下限冲突时，固定给左栏下限，避免来回抖动
    const next =
      maxPct <= minPct
        ? minPct
        : clamp(((event.clientX - rect.left) / rect.width) * 100, minPct, maxPct);
    setSplit(next);
  }, []);

  const onSplitterUp = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    persistSplit(splitRef.current);
  }, []);

  const title =
    device === null
      ? ''
      : [device.manufacturer, device.model].filter(Boolean).join(' ') || device.serial;

  const header = (
    <header className="ac-detail__header">
      <div className="ac-detail__identity">
        <strong>{title}</strong>
        {device ? <span>{device.serial}</span> : null}
        {device ? (
          <Tag
            size="small"
            theme={device.state === 'device' ? 'success' : 'danger'}
            variant="light-outline"
          >
            {device.state === 'device' ? '已连接' : device.state}
          </Tag>
        ) : null}
      </div>
      {device ? (
        <Button
          icon={panelHidden ? <ViewListIcon /> : <DesktopIcon />}
          size="small"
          variant="outline"
          onClick={() => setPanelHidden((prev) => !prev)}
        >
          {panelHidden ? '显示面板' : '专注投屏'}
        </Button>
      ) : null}
    </header>
  );

  if (!device) {
    return (
      <div className="ac-detail">
        {header}
        <EmptyState description="请回到主窗口的设备列表重新连接后再打开。" title="设备未连接" />
      </div>
    );
  }

  return (
    <div ref={rootRef} className="ac-detail">
      {header}

      <div className="ac-detail__body">
        {/* 收起面板时让投屏吃掉整宽；否则按拖拽比例（两端都有最小宽度兜底） */}
        <section
          className="ac-detail__mirror"
          style={{ flexBasis: panelHidden ? '100%' : `${split}%` }}
        >
          <MirrorPane api={api} device={device} startRequest={startRequest} />
        </section>

        {panelHidden ? null : (
          <>
            {/* 分隔条：可拖拽调整栏宽（表意靠 aria-orientation + label，不靠颜色） */}
            <div
              aria-label="调整投屏区宽度"
              aria-orientation="vertical"
              className="ac-detail__splitter"
              role="separator"
              onPointerCancel={onSplitterUp}
              onPointerDown={onSplitterDown}
              onPointerMove={onSplitterMove}
              onPointerUp={onSplitterUp}
            />

            <section className="ac-detail__panel">
              <Tabs value={panel} onChange={(value) => onPanelChange(value)}>
                <Tabs.TabPanel label="应用" value="apps" />
                <Tabs.TabPanel label="文件" value="files" />
                <Tabs.TabPanel label="概览" value="overview" />
              </Tabs>

              <div className="ac-detail__panel-body">
                {panel === 'apps' ? <AppsPage api={api} device={device} /> : null}
                {panel === 'files' ? <FilesPage api={api} device={device} /> : null}
                {panel === 'overview' ? <OverviewPage api={api} device={device} /> : null}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
