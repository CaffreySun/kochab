import { Tabs } from 'tdesign-react';
import type { DeviceInfo } from '@ac/ipc-contract';
import { EmptyState } from '@ac/ui';
import type { Api } from '../ipc';
import { MirrorTile } from '../features/mirror/MirrorTile';
import { AppsPage } from './AppsPage';
import { FilesPage } from './FilesPage';
import type { WorkspaceTab } from './DevicesPage';

export interface DeviceWorkspacePageProps {
  api: Api | null;
  device: DeviceInfo | null;
  tab: WorkspaceTab;
  /**
   * 独立窗口之间不共享路由：换标签等于再开一个窗口，
   * 这里只负责把意图交回给 App（由它去创建/聚焦窗口）。
   */
  onTabChange: (tab: WorkspaceTab) => void;
}

/**
 * 独立窗口里的单设备工作区。
 *
 * 与主窗口的差别只有「没有左侧导航」；里面的组件（投屏磁贴 / 应用 / 文件）
 * 与主窗口用的是同一批。
 */
export function DeviceWorkspacePage({ api, device, tab, onTabChange }: DeviceWorkspacePageProps) {
  // 标签栏在设备断开时也要保留，否则用户无法切换到别的标签自救
  const tabBar = (
    <Tabs value={tab} onChange={(value) => onTabChange(value)}>
      <Tabs.TabPanel label="投屏" value="mirror" />
      <Tabs.TabPanel label="应用" value="apps" />
      <Tabs.TabPanel label="文件" value="files" />
    </Tabs>
  );

  // 独立窗口没有左侧设备列表兜底，窗口内必须始终自报家门。
  const header = device ? (
    <header className="ac-device-window__header">
      <strong>
        {[device.manufacturer, device.model].filter(Boolean).join(' ') || device.serial}
      </strong>
      <span>{device.serial}</span>
    </header>
  ) : null;

  if (!device) {
    return (
      <div className="ac-device-window">
        {header}
        {tabBar}
        <EmptyState
          description="设备可能已断开或被移除，请回到主窗口的设备列表查看。"
          title="设备未连接"
        />
      </div>
    );
  }

  return (
    <div className="ac-device-window">
      {header}
      {tabBar}
      {tab === 'mirror' ? <MirrorTile api={api} device={device} /> : null}
      {tab === 'apps' ? <AppsPage api={api} device={device} /> : null}
      {tab === 'files' ? <FilesPage api={api} device={device} /> : null}
    </div>
  );
}
