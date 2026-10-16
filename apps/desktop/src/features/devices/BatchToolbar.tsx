import { useState } from 'react';
import { Button, MessagePlugin, Space } from 'tdesign-react';
import type { Api } from '../../ipc';

export interface BatchToolbarProps {
  api: Api | null;
  /** 已勾选的设备序列号 */
  selected: string[];
  onClear: () => void;
  onMirrorWall: (serials: string[]) => void;
}

/** 批量恢复分辨率用的命令。 */
const RESET_RESOLUTION = 'wm size reset';
const REBOOT = 'reboot';

/**
 * 多选后的批量操作条。
 *
 * 逐台执行并汇总结果：批量命令没有统一的原子性，
 * 与其谎报成功，不如把每台的结果摊开给用户看。
 */
export function BatchToolbar({ api, selected, onClear, onMirrorWall }: BatchToolbarProps) {
  const [running, setRunning] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{ label: string; failed: string[] } | null>(null);

  if (selected.length === 0) return null;

  const run = async (label: string, command: string) => {
    if (!api) return;
    setRunning(label);
    setLastResult(null);
    const failed: string[] = [];
    for (const serial of selected) {
      try {
        const out = await api.shellExec(serial, command);
        if (out.exitCode !== 0) failed.push(serial);
      } catch {
        failed.push(serial);
      }
    }
    setRunning(null);
    setLastResult({ label, failed });
    if (failed.length === 0) void MessagePlugin.success(`${label}：${selected.length} 台全部完成`);
    else void MessagePlugin.error(`${label}：${failed.length} 台失败`);

    // 重启后需要重新读取列表
    if (command === REBOOT) onClear();
  };

  return (
    <div className="ac-batch">
      <Space breakLine size="small">
        <Button
          disabled={Boolean(running)}
          loading={running === '重启设备'}
          size="small"
          variant="outline"
          onClick={() => void run('重启设备', REBOOT)}
        >
          重启设备
        </Button>
        <Button
          disabled={Boolean(running)}
          loading={running === '恢复分辨率'}
          size="small"
          variant="outline"
          onClick={() => void run('恢复分辨率', RESET_RESOLUTION)}
        >
          恢复分辨率
        </Button>
        <Button size="small" variant="outline" onClick={() => onMirrorWall(selected)}>
          投屏墙（{selected.length}）
        </Button>
        <Button disabled={Boolean(running)} size="small" variant="text" onClick={onClear}>
          取消选择
        </Button>
      </Space>

      {lastResult ? (
        <p className="ac-batch__result" data-testid="batch-result">
          {lastResult.label}：{selected.length - lastResult.failed.length} 台成功
          {lastResult.failed.length > 0 ? `，失败 ${lastResult.failed.join('、')}` : ''}
        </p>
      ) : null}
    </div>
  );
}
