import type { ReactNode } from 'react';
import { Checkbox, Tag, Tooltip } from 'tdesign-react';
import {
  AppIcon,
  FolderIcon,
  MoreIcon,
  PlayCircleIcon,
  UsbIcon,
  UsergroupIcon,
  WifiIcon,
} from 'tdesign-icons-react';
import type { DeviceInfo } from '@kochab/ipc-contract';
import { StatusDot } from './StatusDot';

/** 卡片右侧竖排操作栏的动作。 */
export type DeviceCardAction = 'screen' | 'apps' | 'files' | 'more';

export interface DeviceCardProps {
  device: DeviceInfo;
  /** 用户自定义名称；为空时显示序列号 */
  name?: string;
  /** 是否勾选（批量操作的作用域） */
  checked?: boolean;
  onCheckedChange?: (serial: string, checked: boolean) => void;
  /** 屏幕缩略图插槽：由调用方注入（它需要会话与解码器，属于应用层） */
  preview?: ReactNode;
  onAction?: (action: DeviceCardAction, serial: string) => void;
  /** 「更多」按钮的内容插槽：调用方需要会话等能力，因此由外部注入 */
  railMore?: ReactNode;
  /** 录屏按钮插槽（位于文件与更多之间） */
  railRecord?: ReactNode;
  /** 正在录屏时在预览上显示读秒 */
  recording?: { active: boolean; elapsed: number };
  /** 打开设备详情（点卡片主体或序列号） */
  onOpen?: (serial: string) => void;
  /** 打开分组设置。与「打开详情」分开，避免两者互相顶掉 */
  onGroup?: (serial: string) => void;
  /** 设备分组名；没有分组时显示「未分组」 */
  group?: string;
  transportLabel?: Record<DeviceInfo['transport'], string>;
}

const DEFAULT_TRANSPORT_LABEL: Record<DeviceInfo['transport'], string> = {
  usb: 'USB',
  wifi: '无线',
  emulator: '模拟器',
};

/**
 * 竖排操作栏的固定按钮。
 *
 * 「更多」刻意不在这里：它由 `railMore` 插槽承载（需要下拉菜单），
 * 插槽缺席时才回退成一个普通按钮。
 */
const ACTIONS: Array<{ key: DeviceCardAction; label: string; icon: ReactNode }> = [
  { key: 'screen', label: '投屏', icon: <PlayCircleIcon size="18px" /> },
  { key: 'apps', label: '应用', icon: <AppIcon size="18px" /> },
  { key: 'files', label: '文件', icon: <FolderIcon size="18px" /> },
];

/**
 * 设备卡片：上方是设备标识与状态，中间是屏幕缩略图，右侧是竖排操作栏。
 *
 * 本组件**只负责展示**：缩略图由 `preview` 插槽传入，操作通过 `onAction` 回调外抛。
 * 这样它不需要知道会话、WebCodecs 或 api 的存在，可以脱离运行时单测。
 */
export function DeviceCard({
  device,
  name,
  checked = false,
  onCheckedChange,
  preview,
  onAction,
  railMore,
  railRecord,
  recording,
  onOpen,
  onGroup,
  group,
  transportLabel = DEFAULT_TRANSPORT_LABEL,
}: DeviceCardProps) {
  const ready = device.state === 'device';
  const title = [device.manufacturer, device.model].filter(Boolean).join(' ') || device.serial;
  const displayName = name?.trim() || device.model || device.serial;

  return (
    <article
      aria-label={`设备 ${title}`}
      className={['kochab-device-card', ready ? '' : 'kochab-device-card--offline']
        .filter(Boolean)
        .join(' ')}
      data-serial={device.serial}
      data-testid="device-card"
    >
      <header className="kochab-device-card__header">
        <Checkbox
          checked={checked}
          disabled={!ready}
          onChange={(value) => onCheckedChange?.(device.serial, Boolean(value))}
        />
        <Tooltip content={transportLabel[device.transport] ?? device.transport} placement="top">
          <span className="kochab-device-card__transport">
            {device.transport === 'usb' ? <UsbIcon size="16px" /> : <WifiIcon size="16px" />}
          </span>
        </Tooltip>
        <button
          className="kochab-device-card__identity"
          data-testid="device-select"
          title={`${device.serial}${title !== device.serial ? ` · ${title}` : ''}`}
          type="button"
          onClick={() => onOpen?.(device.serial)}
        >
          <span className="kochab-device-card__name">{displayName}</span>
          <span className="kochab-device-card__serial">{device.serial}</span>
        </button>
        <Tag size="small" theme={ready ? 'success' : 'danger'} variant="light-outline">
          {ready ? '已连接' : stateLabel(device)}
        </Tag>
        <Tooltip content="设置分组" placement="top">
          <button
            aria-label="设置分组"
            className="kochab-device-card__group-button"
            data-testid="device-group"
            type="button"
            onClick={() => onGroup?.(device.serial)}
          >
            <UsergroupIcon size="16px" />
          </button>
        </Tooltip>
      </header>

      <div className="kochab-device-card__body">
        {/* 缩略图整块可点：进详情的主要入口。缩略图本身不接指针事件，
            所以不会和「点击开详情」抢手势。 */}
        <button
          aria-label={`打开 ${title} 详情`}
          className="kochab-device-card__preview"
          data-testid="device-preview"
          title="打开设备详情"
          type="button"
          onClick={() => onOpen?.(device.serial)}
        >
          {preview}
          {recording?.active ? (
            <span className="kochab-device-card__recording" data-testid="device-recording">
              <span aria-hidden="true" className="kochab-device-card__recording-dot" />
              {formatClock(recording.elapsed)}
            </span>
          ) : null}
        </button>

        <div className="kochab-device-card__rail">
          {ACTIONS.map((action) => (
            <Tooltip key={action.key} content={action.label} placement="left">
              <button
                aria-label={action.label}
                className="kochab-device-card__rail-button"
                disabled={!ready}
                type="button"
                onClick={() => onAction?.(action.key, device.serial)}
              >
                {action.icon}
              </button>
            </Tooltip>
          ))}
          {railRecord}
          {/* 「更多」由调用方注入：它的动作需要会话等能力 */}
          {railMore ?? (
            <button
              aria-label="更多"
              className="kochab-device-card__rail-button"
              disabled={!ready}
              type="button"
              onClick={() => onAction?.('more', device.serial)}
            >
              <MoreIcon size="18px" />
            </button>
          )}
        </div>
      </div>

      <footer className="kochab-device-card__footer">
        <StatusDot showLabel state={device.state} />
        <span className="kochab-device-card__meta">
          {device.androidVersion ? `Android ${device.androidVersion}` : '未知系统'}
          {device.screenResolution ? ` · ${device.screenResolution}` : ''}
        </span>
        <Tag size="small" theme="default" variant="light-outline">
          {group ?? '未分组'}
        </Tag>
      </footer>
    </article>
  );
}

function formatClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function stateLabel(device: DeviceInfo): string {
  switch (device.state) {
    case 'unauthorized':
      return '未授权';
    case 'offline':
      return '已断开';
    case 'connecting':
      return '连接中';
    case 'authorizing':
      return '授权中';
    default:
      return '未知';
  }
}
