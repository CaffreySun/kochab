import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '@ac/ipc-contract';
import { createApi } from '../../ipc';
import type { Api } from '../../ipc';
import { createMockTransport } from '../../ipc/mock';
import { formatDuration, useRecording } from './useRecording';

function Harness({ api }: { api: Api }) {
  const recording = useRecording(api, 'd4535f72');
  return (
    <span data-testid="state">
      {recording.active ? `recording ${formatDuration(recording.elapsed)}` : 'idle'}
    </span>
  );
}

describe('useRecording', () => {
  it('挂载时读取后端状态，并按 startedAt 计算读秒', async () => {
    const api = createApi(
      createMockTransport({
        device_record_status: {
          active: true,
          startedAt: Date.now() - 65_000,
          maxSeconds: 180,
        },
      }),
    );
    render(<Harness api={api} />);

    const state = await screen.findByTestId('state');
    await waitFor(() => {
      expect(state).toHaveTextContent(/recording 01:0[5-9]/);
    });
  });

  it('到达设备端时限会自动停止并保存一次', async () => {
    const onInvoke = (command: string) => {
      calls.push(command);
    };
    const calls: string[] = [];
    const transport = createMockTransport(
      {
        device_record_status: {
          active: true,
          startedAt: Date.now() - 181_000,
          maxSeconds: 180,
        },
        device_record_stop: { path: '/tmp/recording.mp4', bytes: 1024 },
      },
      { onInvoke },
    );
    const api = createApi(transport);
    render(<Harness api={api} />);

    await waitFor(() => {
      expect(calls.filter((command) => command === COMMANDS.deviceRecordStop)).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.getByTestId('state')).toHaveTextContent('idle');
    });
  });
});
