import { Button, Space } from 'tdesign-react';
import type { Api } from '../../ipc';
import { useTasks } from '../tasks/TasksProvider';

/** 恢复被开发者选项改过的屏幕尺寸。 */
const RESET_RESOLUTION = 'wm size reset';
/** 重启设备。 */
const REBOOT = 'reboot';

export interface BatchToolbarProps {
  api: Api | null;
  /** 已勾选的设备序列号 */
  selected: string[];
  onClear: () => void;
  onMirrorWall: (serials: string[]) => void;
  /** 重启会让设备短暂离线，通知上层去重新扫描 */
  onDeviceListStale?: () => void;
}

/**
 * 多选后的批量操作条。
 *
 * 批量命令没有统一原子性：与其在按钮上谎报成功，不如把每台结果摊到任务页。
 * 执行交给全局任务队列（`useTasks`），所以这里只是入口按钮。
 */
export function BatchToolbar({
  api,
  selected,
  onClear,
  onMirrorWall,
  onDeviceListStale,
}: BatchToolbarProps) {
  const { busy, submit } = useTasks();

  if (selected.length === 0) return null;

  const runShell = async (label: string, command: string) => {
    if (!api) return;
    await submit(label, selected, async (serial) => {
      const out = await api.shellExec(serial, command);
      if (out.exitCode !== 0) throw new Error(`退出码 ${out.exitCode}`);
      const first = out.stdout.trim().split('\n')[0];
      return first || undefined;
    });
    // 重启后设备会短暂离线，显式让上层重新扫描一次，
    // 否则用户会盯着仍然显示「已连接」的卡片干等。
    if (command === REBOOT) onDeviceListStale?.();
  };

  return (
    <div className="ac-batch">
      <Space breakLine size="small">
        <Button
          disabled={busy}
          loading={busy}
          size="small"
          variant="outline"
          onClick={() => void runShell('重启设备', REBOOT)}
        >
          重启设备
        </Button>
        <Button
          disabled={busy}
          size="small"
          variant="outline"
          onClick={() => void runShell('恢复分辨率', RESET_RESOLUTION)}
        >
          恢复分辨率
        </Button>
        <Button
          disabled={busy}
          size="small"
          variant="outline"
          onClick={() => onMirrorWall(selected)}
        >
          投屏墙（{selected.length}）
        </Button>
        <Button disabled={busy} size="small" variant="text" onClick={onClear}>
          取消选择
        </Button>
      </Space>
    </div>
  );
}
