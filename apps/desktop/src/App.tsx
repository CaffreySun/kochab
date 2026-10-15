import { useCallback, useMemo, useState } from 'react';
import { Loading, Tabs } from 'tdesign-react';
import type { DeviceInfo } from '@ac/ipc-contract';
import type { Api } from './ipc';
import { useApi, useDevices } from './features/devices/useDevices';
import { AppsPage } from './pages/AppsPage';
import { DevicesPage } from './pages/DevicesPage';
import { FilesPage } from './pages/FilesPage';
import { MirrorPage } from './pages/MirrorPage';

export interface AppProps {
  /**
   * 显式注入 API；默认由 `useApi` 按运行环境选择真实或 mock 传输。
   * 测试可通过注入 mock 传输来驱动同一套界面。
   */
  api?: Api;
}

type PageKey = 'devices' | 'apps' | 'files' | 'mirror';

export function App({ api: injected }: AppProps = {}) {
  const autoApi = useApi();
  const api = injected ?? autoApi;
  // 顶层也订阅一次设备列表：其它页面要用它的选中态与设备详情
  const { devices, selectedSerial, select } = useDevices(api);
  const [page, setPage] = useState<PageKey>('devices');

  const selectedDevice: DeviceInfo | null = useMemo(
    () => devices.find((device) => device.serial === selectedSerial) ?? null,
    [devices, selectedSerial],
  );

  const openPage = useCallback(
    (next: 'apps' | 'files' | 'mirror', serial: string) => {
      select(serial);
      setPage(next);
    },
    [select],
  );

  if (!api) {
    return (
      <div className="ac-app">
        <Loading loading size="small" text="正在初始化…" />
      </div>
    );
  }

  return (
    <div className="ac-app">
      <header className="ac-app__header">
        <div className="ac-app__brand">
          <h1 className="ac-app__title">Android Controller</h1>
          <span className="ac-app__subtitle">基于 adb 与 scrcpy 协议</span>
        </div>
      </header>

      <nav className="ac-app__nav">
        <Tabs value={page} onChange={(value) => setPage(value)}>
          <Tabs.TabPanel label="设备" value="devices">
            <DevicesPage api={api} onOpenPage={openPage} />
          </Tabs.TabPanel>
          <Tabs.TabPanel label="应用管理" value="apps">
            <AppsPage api={api} device={selectedDevice} />
          </Tabs.TabPanel>
          <Tabs.TabPanel label="文件管理" value="files">
            <FilesPage api={api} device={selectedDevice} />
          </Tabs.TabPanel>
          <Tabs.TabPanel label="投屏" value="mirror">
            <MirrorPage api={api} device={selectedDevice} />
          </Tabs.TabPanel>
        </Tabs>
      </nav>
    </div>
  );
}
