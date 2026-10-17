import { useCallback, useEffect, useMemo, useState } from 'react';
import { Breadcrumb, Button, Loading, MessagePlugin, Space, Table, Tag } from 'tdesign-react';
import { open } from '@tauri-apps/plugin-dialog';
import type { DeviceInfo, FileEntry } from '@ac/ipc-contract';
import { EmptyState } from '@ac/ui';
import type { Api } from '../ipc';
import { toMessage } from '../ipc';

export interface FilesPageProps {
  api: Api | null;
  device: DeviceInfo | null;
}

type Status = 'idle' | 'loading' | 'ready' | 'error';

const ROOT = '/sdcard';
const QUICK_PATHS = ['/sdcard', '/sdcard/Download', '/sdcard/DCIM', '/data/local/tmp'];

/** 文件管理页：路径即状态，可前进后退。 */
export function FilesPage({ api, device }: FilesPageProps) {
  const serial = device?.state === 'device' ? device.serial : null;
  const [path, setPath] = useState(ROOT);
  const [history, setHistory] = useState<string[]>([ROOT]);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  // 初值就是「加载中」：首次渲染直接显示加载态，避免在 effect 里同步 setState
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (target: string) => {
      if (!api || !serial) return;
      try {
        const list = await api.listFiles(serial, target);
        setEntries(list);
        setPath(target);
        setStatus('ready');
      } catch (cause) {
        setError(toMessage(cause, '读取目录失败'));
        setStatus('error');
      }
    },
    [api, serial],
  );

  // 设备切换由父组件用 `key` 强制重挂载，因此这里只负责首次加载。
  // `load` 内不做同步 setState，避免触发级联渲染。
  useEffect(() => {
    if (!serial) return;
    void load(ROOT);
  }, [serial, load]);

  const navigate = useCallback(
    (target: string) => {
      setHistory((prev) => [...prev, target]);
      void load(target);
    },
    [load],
  );

  const goBack = useCallback(() => {
    setHistory((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.slice(0, -1);
      const target = next[next.length - 1] ?? ROOT;
      void load(target);
      return next;
    });
  }, [load]);

  /** 当前路径的各级，供面包屑展示 */
  const crumbs = useMemo(() => {
    const parts = path.split('/').filter(Boolean);
    const items = [{ label: '/', path: '/' }];
    let acc = '';
    for (const part of parts) {
      acc += `/${part}`;
      items.push({ label: part, path: acc });
    }
    return items;
  }, [path]);

  const withBusy = useCallback(async (label: string, action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      setError(`${label}失败：${toMessage(cause)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const download = useCallback(
    async (entry: FileEntry) => {
      if (!api || !serial) return;
      const directory = await open({ directory: true, multiple: false });
      if (typeof directory !== 'string') return;
      const target = `${directory}/${entry.name}`;
      await withBusy('下载', async () => {
        const result = await api.pullFile(serial, entry.path, target);
        await MessagePlugin.success(`已下载 ${result.bytes} 字节到 ${result.path}`);
      });
    },
    [api, serial, withBusy],
  );

  const upload = useCallback(async () => {
    if (!api || !serial) return;
    const picked = await open({ multiple: false });
    if (typeof picked !== 'string') return;
    const name = picked.split(/[\\/]/).pop() ?? 'upload.bin';
    await withBusy('上传', async () => {
      const result = await api.pushFile(serial, picked, `${path}/${name}`);
      await MessagePlugin.success(`已上传到 ${result.path}`);
      await load(path);
    });
  }, [api, serial, path, withBusy, load]);

  const remove = useCallback(
    async (entry: FileEntry) => {
      if (!api || !serial) return;
      await withBusy('删除', async () => {
        await api.deletePath(serial, entry.path);
        await load(path);
      });
    },
    [api, serial, path, withBusy, load],
  );

  const createDir = useCallback(async () => {
    if (!api || !serial) return;
    const name = globalThis.prompt('新目录名称');
    if (!name) return;
    await withBusy('新建目录', async () => {
      await api.createDir(serial, `${path}/${name}`);
      await load(path);
    });
  }, [api, serial, path, withBusy, load]);

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
          <Button disabled={history.length <= 1} size="small" variant="outline" onClick={goBack}>
            返回上级
          </Button>
          {QUICK_PATHS.map((quick) => (
            <Button key={quick} size="small" variant="text" onClick={() => navigate(quick)}>
              {quick}
            </Button>
          ))}
          <Button loading={busy} size="small" variant="outline" onClick={() => void upload()}>
            上传
          </Button>
          <Button disabled={busy} size="small" variant="outline" onClick={() => void createDir()}>
            新建目录
          </Button>
        </Space>
      </div>

      <Breadcrumb className="ac-files__breadcrumb" maxItemWidth="160px">
        {crumbs.map((crumb, index) => (
          <Breadcrumb.BreadcrumbItem
            key={crumb.path}
            onClick={index === crumbs.length - 1 ? undefined : () => navigate(crumb.path)}
          >
            {crumb.label}
          </Breadcrumb.BreadcrumbItem>
        ))}
      </Breadcrumb>

      {error ? (
        <div role="alert">
          <Tag theme="danger" variant="light-outline">
            {error}
          </Tag>
        </div>
      ) : null}

      {status === 'loading' ? <Loading loading size="small" text="正在读取目录…" /> : null}

      {status === 'ready' && entries.length === 0 ? (
        <EmptyState description="这个目录是空的，或当前权限无法读取。" title="没有内容" />
      ) : null}

      {entries.length > 0 ? (
        <div className="ac-page__scroll">
          <Table
            columns={[
              {
                colKey: 'name',
                title: '名称',
                cell: ({ row }: { row: FileEntry }) => (
                  <button
                    className="ac-files__entry"
                    disabled={!row.isDirectory}
                    type="button"
                    onClick={() => (row.isDirectory ? navigate(row.path) : undefined)}
                  >
                    {row.isDirectory ? '📁' : '📄'} {row.name}
                  </button>
                ),
              },
              {
                colKey: 'sizeBytes',
                title: '大小',
                width: 100,
                cell: ({ row }: { row: FileEntry }) =>
                  row.sizeBytes === null ? '—' : formatBytes(row.sizeBytes),
              },
              {
                colKey: 'modifiedAt',
                title: '修改时间',
                width: 156,
                cell: ({ row }: { row: FileEntry }) =>
                  row.modifiedAt === null ? '—' : new Date(row.modifiedAt).toLocaleString(),
              },
              {
                colKey: 'actions',
                title: '操作',
                width: 140,
                cell: ({ row }: { row: FileEntry }) => (
                  <Space size="small">
                    <Button
                      disabled={busy || row.isDirectory}
                      size="small"
                      variant="text"
                      onClick={() => void download(row)}
                    >
                      下载
                    </Button>
                    <Button
                      disabled={busy}
                      size="small"
                      theme="danger"
                      variant="text"
                      onClick={() => void remove(row)}
                    >
                      删除
                    </Button>
                  </Space>
                ),
              },
            ]}
            data={entries}
            rowKey="path"
            size="small"
          />
        </div>
      ) : null}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
