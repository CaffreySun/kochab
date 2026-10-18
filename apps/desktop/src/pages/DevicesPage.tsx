import { useCallback, useMemo, useState } from 'react';
import { Button, Dialog, Input, Select, Space, Tag } from 'tdesign-react';
import { LinkIcon, RefreshIcon, SearchIcon } from 'tdesign-icons-react';
import type { DeviceConnectionState, DeviceInfo } from '@kochab/ipc-contract';
import { EmptyState, type DeviceCardAction } from '@kochab/ui';
import { DeviceRecordingCard } from '../features/recording/DeviceRecordingCard';
import type { Api } from '../ipc';
import { DevicePreview } from '../features/preview/DevicePreview';
import { DeviceMoreMenu } from '../features/devices/DeviceMoreMenu';
import { BatchToolbar } from '../features/devices/BatchToolbar';
import { UNGROUPED, useDeviceGroups } from '../features/devices/useDeviceGroups';
import { useDevicePrefs } from '../features/devices/useDevicePrefs';
import type { DevicesState } from '../features/devices/useDevices';
import { openDeviceWindow } from '../features/window/openDeviceWindow';

/** 默认同时开启多少路缩略图预览。 */
export const DEFAULT_PREVIEW_LIMIT = 4;

export interface DevicesPageProps {
  api: Api | null;
  /** 设备数据由 App 统一订阅后传入，避免两处各维护一份列表 */
  devices: DevicesState;
  previewEnabled: boolean;
  previewLimit: number;
}

export type WorkspaceTab = 'mirror' | 'apps' | 'files';

type StateFilter = 'all' | DeviceConnectionState;

const RECENT_ADDRESSES_KEY = 'kochab.recentAddresses';
const RECENT_ADDRESSES_LIMIT = 5;

function readRecentAddresses(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(RECENT_ADDRESSES_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .slice(0, RECENT_ADDRESSES_LIMIT);
  } catch {
    return [];
  }
}

function rememberAddress(address: string): string[] {
  const next = [address, ...readRecentAddresses().filter((item) => item !== address)].slice(
    0,
    RECENT_ADDRESSES_LIMIT,
  );
  try {
    window.localStorage.setItem(RECENT_ADDRESSES_KEY, JSON.stringify(next));
  } catch {
    // 写不进去不影响本次连接
  }
  return next;
}

/** 设备列表页：工具栏 + 设备卡片网格（含实时缩略图与竖排操作栏）。 */
export function DevicesPage({
  api,
  devices: devicesState,
  previewEnabled,
  previewLimit,
}: DevicesPageProps) {
  const { devices, status, error, refresh } = devicesState;
  const [keyword, setKeyword] = useState('');
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [address, setAddress] = useState('');
  const [connectOpen, setConnectOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [recentAddresses, setRecentAddresses] = useState<string[]>(readRecentAddresses);
  const [groupFilter, setGroupFilter] = useState<string>('all');
  const [assignTarget, setAssignTarget] = useState<{ serial: string; current: string } | null>(
    null,
  );
  const [newGroupName, setNewGroupName] = useState('');
  const { groups, groupOf, assign, createAndAssign, removeGroup } = useDeviceGroups();
  const { prefs, aliasOf, setAlias, isPinned, togglePinned } = useDevicePrefs();

  const visible = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    const matched = devices.filter((device) => {
      if (stateFilter !== 'all' && device.state !== stateFilter) return false;
      if (groupFilter !== 'all' && groupOf(device.serial) !== groupFilter) return false;
      if (!needle) return true;
      const alias = aliasOf(device.serial);
      return (
        device.serial.toLowerCase().includes(needle) ||
        (device.model ?? '').toLowerCase().includes(needle) ||
        (device.manufacturer ?? '').toLowerCase().includes(needle) ||
        (alias ?? '').toLowerCase().includes(needle)
      );
    });
    // 置顶优先；其次按分组聚在一起，未分组排最后；组内保持 adb 上报的原始顺序。
    const order = new Map<string, number>(groups.names.map((name, index) => [name, index]));
    const rank = (name: string): number => {
      if (name === UNGROUPED) return Number.MAX_SAFE_INTEGER;
      return order.get(name) ?? Number.MAX_SAFE_INTEGER;
    };
    const pinRank = (serial: string): number => {
      const index = prefs.pinned.indexOf(serial);
      return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    };
    return [...matched].sort((a, b) => {
      const pinnedDiff = pinRank(a.serial) - pinRank(b.serial);
      if (pinnedDiff !== 0) return pinnedDiff;
      const diff = rank(groupOf(a.serial)) - rank(groupOf(b.serial));
      return diff !== 0 ? diff : 0;
    });
  }, [devices, keyword, stateFilter, groupFilter, groupOf, groups.names, aliasOf, prefs.pinned]);

  /** 前 N 台就绪设备参与缩略图预览，避免设备一多就把主机压垮 */
  const previewSerials = useMemo(() => {
    const ready = visible.filter((device) => device.state === 'device');
    return new Set(ready.slice(0, previewLimit).map((device) => device.serial));
  }, [visible, previewLimit]);

  const selectedSerials = useMemo(() => [...selected].sort(), [selected]);

  const readyVisible = useMemo(
    () => visible.filter((device) => device.state === 'device'),
    [visible],
  );
  const allReadySelected =
    readyVisible.length > 0 && readyVisible.every((device) => selected.has(device.serial));

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allReadySelected) {
        for (const device of readyVisible) next.delete(device.serial);
      } else {
        for (const device of readyVisible) next.add(device.serial);
      }
      return next;
    });
  }, [allReadySelected, readyVisible]);

  const toggleSelected = useCallback((serial: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(serial);
      else next.delete(serial);
      return next;
    });
  }, []);

  const handleAction = useCallback((action: DeviceCardAction, serial: string) => {
    // 设备工作区是独立窗口，不再在主窗口内切换路由
    switch (action) {
      case 'apps':
        void openDeviceWindow(serial, 'apps');
        break;
      case 'files':
        void openDeviceWindow(serial, 'files');
        break;
      default:
        void openDeviceWindow(serial, 'mirror');
        break;
    }
  }, []);

  const connect = async () => {
    if (!api || !address.trim()) return;
    const target = address.trim();
    setConnecting(true);
    setConnectError(null);
    try {
      await api.connectWireless(target);
      setRecentAddresses(rememberAddress(target));
      setAddress('');
      setConnectOpen(false);
      await refresh();
    } catch (cause) {
      setConnectError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setConnecting(false);
    }
  };

  // assign 之后必须同步高亮：否则对话框里选中的分组和设备的真实分组会对不上。
  const applyAssign = (name: string) => {
    if (!assignTarget) return;
    assign(assignTarget.serial, name);
    setAssignTarget({ ...assignTarget, current: name === UNGROUPED ? UNGROUPED : name });
  };

  const deleteGroup = (name: string) => {
    removeGroup(name);
    setAssignTarget((prev) =>
      prev && prev.current === name ? { ...prev, current: UNGROUPED } : prev,
    );
  };

  return (
    <>
      <div className="kochab-devices__toolbar">
        {/* 单一 flex 容器：所有控件都是直接 flex item，换行行为完全可控。
            两个 <Space> 会各自占 max-content 宽度，右侧「刷新」会被挤出可视区。 */}
        <Select
          options={[
            { label: '全部状态', value: 'all' },
            { label: '已连接', value: 'device' },
            { label: '未授权', value: 'unauthorized' },
            { label: '已断开', value: 'offline' },
          ]}
          size="small"
          style={{ width: 110 }}
          value={stateFilter}
          onChange={(value) => setStateFilter(value as StateFilter)}
        />
        <Select
          options={[
            { label: '全部分组', value: 'all' },
            ...groups.names.map((name) => ({ label: name, value: name })),
            { label: UNGROUPED, value: UNGROUPED },
          ]}
          size="small"
          style={{ width: 120 }}
          value={groupFilter}
          onChange={(value) => setGroupFilter(typeof value === 'string' ? value : 'all')}
        />
        <Input
          clearable
          placeholder="搜索设备"
          prefixIcon={<SearchIcon />}
          size="small"
          style={{ width: 140 }}
          value={keyword}
          onChange={(value) => setKeyword(value)}
        />
        <Tag variant="light-outline">已选 {selected.size} 台</Tag>
        <Button
          disabled={readyVisible.length === 0}
          size="small"
          variant="outline"
          onClick={toggleAll}
        >
          {allReadySelected ? '取消全选' : '全选'}
        </Button>
        <Tag variant="light-outline">
          共 {visible.length} 台 · 预览 {previewSerials.size}/{previewLimit}
        </Tag>

        <Button
          icon={<LinkIcon />}
          size="small"
          theme="primary"
          variant="outline"
          onClick={() => setConnectOpen(true)}
        >
          连接设备
        </Button>
        <Button
          icon={<RefreshIcon />}
          loading={status === 'loading'}
          size="small"
          variant="outline"
          onClick={() => void refresh()}
        >
          刷新
        </Button>
      </div>

      <BatchToolbar
        api={api}
        selected={selectedSerials}
        onClear={() => setSelected(new Set())}
        onDeviceListStale={() => void refresh()}
        onMirrorWall={(serials) => {
          // 投屏墙 = 每台设备各开一个独立投屏窗口，不做单窗口多宫格
          for (const serial of serials) void openDeviceWindow(serial, 'mirror');
        }}
      />

      {error ? (
        <div role="alert">
          <Tag theme="danger" variant="light-outline">
            {error}
          </Tag>
        </div>
      ) : null}

      {status !== 'loading' && visible.length === 0 ? (
        <EmptyState
          action={
            <Button size="small" variant="outline" onClick={() => void refresh()}>
              重新扫描
            </Button>
          }
          description="USB：打开手机「开发者选项 → USB 调试」并授权。无线：手机与本机连同一网络后点「连接设备」；已用 USB 连接的设备可从卡片「更多 → 无线调试」开启。"
          title={devices.length === 0 ? '没有检测到设备' : '没有匹配的设备'}
        />
      ) : null}

      <div className="kochab-device-grid">
        {visible.map((device: DeviceInfo) => (
          <DeviceRecordingCard
            key={device.serial}
            api={api}
            checked={selected.has(device.serial)}
            device={device}
            group={groupOf(device.serial)}
            name={aliasOf(device.serial)}
            preview={
              <DevicePreview
                api={api}
                device={device}
                enabled={previewEnabled && previewSerials.has(device.serial)}
              />
            }
            railMore={
              <DeviceMoreMenu
                alias={aliasOf(device.serial)}
                api={api}
                device={device}
                pinned={isPinned(device.serial)}
                onDeviceListStale={() => void refresh()}
                onRename={(name) => setAlias(device.serial, name)}
                onTogglePin={() => togglePinned(device.serial)}
              />
            }
            onAction={handleAction}
            onCheckedChange={toggleSelected}
            onGroup={(serial) => setAssignTarget({ serial, current: groupOf(serial) })}
            onOpen={(serial) => void openDeviceWindow(serial, 'mirror')}
          />
        ))}
      </div>

      <Dialog
        attach="body"
        cancelBtn="取消"
        confirmBtn="确定"
        header={`设置分组 · ${assignTarget?.serial ?? ''}`}
        visible={assignTarget !== null}
        onCancel={() => {
          setAssignTarget(null);
          setNewGroupName('');
        }}
        onClose={() => {
          setAssignTarget(null);
          setNewGroupName('');
        }}
        onConfirm={() => {
          if (!assignTarget) return;
          const name = newGroupName.trim();
          if (name) createAndAssign(assignTarget.serial, name);
          setAssignTarget(null);
          setNewGroupName('');
        }}
      >
        <div className="kochab-group">
          <Space breakLine size="small">
            <Button
              size="small"
              theme={assignTarget?.current === UNGROUPED ? 'primary' : 'default'}
              variant="outline"
              onClick={() => applyAssign(UNGROUPED)}
            >
              {UNGROUPED}
            </Button>
            {groups.names.map((name) => (
              <Button
                key={name}
                size="small"
                theme={assignTarget?.current === name ? 'primary' : 'default'}
                variant="outline"
                onClick={() => applyAssign(name)}
              >
                {name}
              </Button>
            ))}
          </Space>
          <Input
            placeholder="新建分组名称"
            value={newGroupName}
            onChange={(value) => setNewGroupName(String(value))}
          />
          {groups.names.length > 0 ? (
            <div className="kochab-group__remove">
              <span className="kochab-group__hint">
                删除分组后，组内设备会回到「{UNGROUPED}」。
              </span>
              <Space breakLine size="small">
                {groups.names.map((name) => (
                  <Button
                    key={name}
                    size="small"
                    theme="danger"
                    variant="text"
                    onClick={() => deleteGroup(name)}
                  >
                    删除「{name}」
                  </Button>
                ))}
              </Space>
            </div>
          ) : null}
        </div>
      </Dialog>

      <Dialog
        attach="body"
        cancelBtn="取消"
        confirmBtn="连接"
        confirmLoading={connecting}
        header="连接设备"
        visible={connectOpen}
        width={460}
        onCancel={() => {
          setConnectOpen(false);
          setConnectError(null);
        }}
        onClose={() => {
          setConnectOpen(false);
          setConnectError(null);
        }}
        onConfirm={() => void connect()}
      >
        <div className="kochab-connect">
          <p className="kochab-connect__hint">
            手机需与本机在同一网络。已通过 USB 连接的设备，可在卡片「更多 → 无线调试」一键开启；
            或先在手机终端执行 <code>adb tcpip 5555</code>。
          </p>
          <Input
            clearable
            placeholder="192.168.1.10:5555"
            value={address}
            onChange={(value) => setAddress(String(value))}
            onEnter={() => void connect()}
          />
          {recentAddresses.length > 0 ? (
            <div className="kochab-connect__recent">
              <span>最近</span>
              {recentAddresses.map((item) => (
                <Button key={item} size="small" variant="outline" onClick={() => setAddress(item)}>
                  {item}
                </Button>
              ))}
            </div>
          ) : null}
          {connectError ? (
            <Tag theme="danger" variant="light-outline">
              {connectError}
            </Tag>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}
