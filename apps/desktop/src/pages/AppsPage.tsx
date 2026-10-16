import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, Loading, Space, Switch, Table, Tag } from 'tdesign-react';
import { open } from '@tauri-apps/plugin-dialog';
import type { AppInfo, DeviceInfo } from '@ac/ipc-contract';
import { EmptyState } from '@ac/ui';
import type { Api } from '../ipc';
import { toMessage } from '../ipc';

export interface AppsPageProps {
  api: Api | null;
  device: DeviceInfo | null;
}

type Status = 'idle' | 'loading' | 'ready' | 'error';

/** 应用管理页：列出、搜索、启动/停止、安装/卸载/清除数据。 */
export function AppsPage({ api, device }: AppsPageProps) {
  const serial = device?.state === 'device' ? device.serial : null;
  const [apps, setApps] = useState<AppInfo[]>([]);
  // 初值就是「加载中」：首次渲染直接显示加载态，避免在 effect 里同步 setState
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [showSystem, setShowSystem] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!api || !serial) return;
    try {
      setApps(await api.listApps(serial, { showSystemApps: showSystem }));
      setStatus('ready');
    } catch (cause) {
      setError(toMessage(cause, '读取应用列表失败'));
      setStatus('error');
    }
  }, [api, serial, showSystem]);

  // 设备切换由父组件用 `key` 强制重挂载，因此这里只负责首次加载；
  // `refresh` 内部不做同步 setState，避免触发级联渲染。
  useEffect(() => {
    if (!serial) return;
    void refresh();
  }, [serial, refresh]);

  /** 用户主动刷新：先显示加载态，再重新拉取 */
  const reload = useCallback(async () => {
    setStatus('loading');
    await refresh();
  }, [refresh]);

  const run = useCallback(
    async (packageName: string, label: string, action: () => Promise<unknown>) => {
      setBusy(packageName);
      setError(null);
      try {
        await action();
      } catch (cause) {
        setError(`${label}失败：${toMessage(cause)}`);
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const installApk = useCallback(async () => {
    if (!api || !serial) return;
    const picked = await open({
      multiple: false,
      filters: [{ name: 'Android 安装包', extensions: ['apk'] }],
    });
    if (typeof picked !== 'string') return;
    await run(picked, '安装', async () => {
      const result = await api.installApk(serial, picked);
      if (!result.success) throw new Error(result.rawOutput);
      await refresh();
    });
  }, [api, serial, run, refresh]);

  const visible = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    if (!needle) return apps;
    return apps.filter(
      (app) =>
        app.packageName.toLowerCase().includes(needle) ||
        (app.label ?? '').toLowerCase().includes(needle),
    );
  }, [apps, keyword]);

  if (!device) {
    return (
      <EmptyState description="请先在「设备」页选择一台已授权的设备。" title="没有选中的设备" />
    );
  }
  if (device.state !== 'device' || !serial) {
    return <EmptyState description={`设备当前状态为 ${device.state}。`} title="设备未就绪" />;
  }

  return (
    <div className="ac-page">
      <div className="ac-page__toolbar">
        <Space breakLine size="small">
          <Input
            clearable
            placeholder="搜索包名或应用名"
            size="small"
            style={{ width: 200 }}
            value={keyword}
            onChange={(value) => setKeyword(value)}
          />
          <span className="ac-page__inline-switch">
            <Switch size="small" value={showSystem} onChange={setShowSystem} />
            <span>显示系统应用</span>
          </span>
          <Button
            loading={status === 'loading'}
            size="small"
            variant="outline"
            onClick={() => void reload()}
          >
            刷新
          </Button>
          <Button size="small" theme="primary" onClick={() => void installApk()}>
            安装 APK
          </Button>
          <Tag variant="light-outline">共 {visible.length} 个</Tag>
        </Space>
      </div>

      {error ? (
        <div role="alert">
          <Tag theme="danger" variant="light-outline">
            {error}
          </Tag>
        </div>
      ) : null}

      {status === 'loading' ? <Loading loading size="small" text="正在读取应用列表…" /> : null}

      {status === 'ready' && visible.length === 0 ? (
        <EmptyState description="换个关键字，或打开「显示系统应用」。" title="没有匹配的应用" />
      ) : null}

      {visible.length > 0 ? (
        <Table
          columns={[
            {
              colKey: 'label',
              title: '应用',
              cell: ({ row }: { row: AppInfo }) => (
                <div className="ac-app-cell">
                  <span className="ac-app-cell__name">
                    {row.label ?? row.packageName}
                    {/* 类型并进名称行：右栏只有半个窗口宽，独立一列不划算 */}
                    <Tag
                      size="small"
                      theme={row.isSystem ? 'default' : 'primary'}
                      variant="light-outline"
                    >
                      {row.isSystem ? '系统' : '第三方'}
                    </Tag>
                  </span>
                  <span className="ac-app-cell__package">{row.packageName}</span>
                </div>
              ),
            },
            {
              colKey: 'actions',
              title: '操作',
              width: 220,
              cell: ({ row }: { row: AppInfo }) => (
                <Space size="small">
                  <Button
                    disabled={busy === row.packageName}
                    size="small"
                    variant="text"
                    onClick={() =>
                      void run(row.packageName, '启动', () =>
                        api!.launchApp(serial, row.packageName),
                      )
                    }
                  >
                    启动
                  </Button>
                  <Button
                    disabled={busy === row.packageName}
                    size="small"
                    variant="text"
                    onClick={() =>
                      void run(row.packageName, '停止', () => api!.stopApp(serial, row.packageName))
                    }
                  >
                    停止
                  </Button>
                  <Button
                    disabled={busy === row.packageName}
                    size="small"
                    variant="text"
                    onClick={() =>
                      void run(row.packageName, '清除数据', async () => {
                        await api!.clearAppData(serial, row.packageName);
                      })
                    }
                  >
                    清除数据
                  </Button>
                  <Button
                    disabled={busy === row.packageName || row.isSystem}
                    size="small"
                    theme="danger"
                    variant="text"
                    onClick={() =>
                      void run(row.packageName, '卸载', async () => {
                        await api!.uninstallApp(serial, row.packageName);
                        await refresh();
                      })
                    }
                  >
                    卸载
                  </Button>
                </Space>
              ),
            },
          ]}
          data={visible}
          rowKey="packageName"
          size="small"
        />
      ) : null}
    </div>
  );
}
