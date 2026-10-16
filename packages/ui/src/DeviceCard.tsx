import type { ReactNode } from 'react';
import { Checkbox, Tag, Tooltip } from 'tdesign-react';
import {
  AppIcon,
  FolderIcon,
  MoreIcon,
  PlayCircleIcon,
  UsbIcon,
  WifiIcon,
} from 'tdesign-icons-react';
import type { DeviceInfo } from '@ac/ipc-contract';
import { StatusDot } from './StatusDot';

/** 卡片右侧竖排操作栏的动作。 */
export type DeviceCardAction = 'screen' | 'apps' | 'files' | 'more';

export interface DeviceCardProps {
  device: DeviceInfo;
  /** 是否勾选（批量操作的作用域） */
  checked?: boolean;
  onCheckedChange?: (serial: string, checked: boolean) => void;
  /** 屏幕缩略图插槽：由调用方注入（它需要会话与解码器，属于应用层） */
  preview?: ReactNode;
  onAction?: (action: DeviceCardAction, serial: string) => void;
  /** 「更多」按钮的内容插槽：调用方需要会话等能力，因此由外部注入 */
  railMore?: ReactNode;
  onSelect?: (serial: string) => void;
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
  checked = false,
  onCheckedChange,
  preview,
  onAction,
  railMore,
  onSelect,
  group,
  transportLabel = DEFAULT_TRANSPORT_LABEL,
}: DeviceCardProps) {
  const ready = device.state === 'device';
  const title = [device.manufacturer, device.model].filter(Boolean).join(' ') || device.serial;

  return (
    <article
      aria-label={`设备 ${title}`}
      className={['ac-device-card', ready ? '' : 'ac-device-card--offline']
        .filter(Boolean)
        .join(' ')}
      data-serial={device.serial}
      data-testid="device-card"
    >
      <header className="ac-device-card__header">
        <Checkbox
          checked={checked}
          disabled={!ready}
          onChange={(value) => onCheckedChange?.(device.serial, Boolean(value))}
        />
        <Tooltip content={transportLabel[device.transport] ?? device.transport} placement="top">
          <span className="ac-device-card__transport">
            {device.transport === 'usb' ? <UsbIcon size="16px" /> : <WifiIcon size="16px" />}
          </span>
        </Tooltip>
        <button
          className="ac-device-card__identity"
          data-testid="device-select"
          title={device.serial}
          type="button"
          onClick={() => onSelect?.(device.serial)}
        >
          {device.serial}
        </button>
        <Tag size="small" theme={ready ? 'success' : 'danger'} variant="light-outline">
          {ready ? '已连接' : stateLabel(device)}
        </Tag>
      </header>

      <div className="ac-device-card__body">
        <div className="ac-device-card__preview" data-testid="device-preview">
          {preview}
        </div>

        <div className="ac-device-card__rail">
          {ACTIONS.map((action) => (
            <Tooltip key={action.key} content={action.label} placement="left">
              <button
                aria-label={action.label}
                className="ac-device-card__rail-button"
                disabled={!ready}
                type="button"
                onClick={() => onAction?.(action.key, device.serial)}
              >
                {action.icon}
              </button>
            </Tooltip>
          ))}
          {/* 「更多」由调用方注入：它的动作需要会话等能力 */}
          {railMore ?? (
            <button
              aria-label="更多"
              className="ac-device-card__rail-button"
              disabled={!ready}
              type="button"
              onClick={() => onAction?.('more', device.serial)}
            >
              <MoreIcon size="18px" />
            </button>
          )}
        </div>
      </div>

      <footer className="ac-device-card__footer">
        <StatusDot showLabel state={device.state} />
        <span className="ac-device-card__meta">
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
