import { MessagePlugin, Tooltip } from 'tdesign-react';
import { VideoCameraIcon } from 'tdesign-icons-react';
import { DeviceCard, type DeviceCardProps } from '@kochab/ui';
import type { Api } from '../../ipc';
import { toMessage } from '../../ipc';
import { formatDuration, useRecording } from './useRecording';

export interface DeviceRecordingCardProps extends DeviceCardProps {
  api: Api | null;
}

/**
 * 带录屏入口的设备卡片。
 *
 * 录屏状态由 Rust 侧维护，这里额外挂一个 `useRecording`：设备页与投屏窗口
 * 各自独立，但开始/停止都会通过事件同步，不需要把状态抬到全局 Provider。
 */
export function DeviceRecordingCard({ api, device, ...cardProps }: DeviceRecordingCardProps) {
  const recording = useRecording(api, device.serial, {
    onSaved: (saved) => void MessagePlugin.success(`录屏已保存到 ${saved.path}`),
  });
  const ready = device.state === 'device';

  const toggle = async () => {
    try {
      if (recording.active) {
        const saved = await recording.stop();
        if (saved) void MessagePlugin.success(`录屏已保存到 ${saved.path}`);
      } else {
        await recording.start();
        void MessagePlugin.success('已开始录屏，再次点击停止');
      }
    } catch (cause) {
      void MessagePlugin.error(`录屏操作失败：${toMessage(cause)}`);
    }
  };

  const label = recording.active ? `停止录屏（${formatDuration(recording.elapsed)}）` : '录屏';

  return (
    <DeviceCard
      {...cardProps}
      device={device}
      railRecord={
        <Tooltip content={label} placement="left">
          <button
            aria-label={recording.active ? '停止录屏' : '录屏'}
            className="kochab-device-card__rail-button"
            disabled={(!ready && !recording.active) || recording.busy}
            type="button"
            onClick={() => void toggle()}
          >
            <VideoCameraIcon size="18px" />
          </button>
        </Tooltip>
      }
      recording={{ active: recording.active, elapsed: recording.elapsed }}
    />
  );
}
