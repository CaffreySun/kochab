import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dialog, Progress, Space, Tag } from 'tdesign-react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import type { SavedFile } from '@ac/ipc-contract';
import type { Api } from '../../ipc';
import { toMessage } from '../../ipc';

export interface RecordDialogProps {
  api: Api | null;
  /** 已就绪设备的 serial */
  serial: string;
  open: boolean;
  onClose: () => void;
}

type Stage = 'idle' | 'starting' | 'recording' | 'stopping' | 'done' | 'error';

/** `2026-10-17 21:15:30` → `20261017_211530`，用于下载目录里的文件名。 */
export function fileStamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/**
 * 录屏对话框。
 *
 * 录屏在设备端用 `screenrecord` 跑，停止时必须发中断让 MP4 正常收尾，
 * 所以这里把「开始 / 停止 / 到时限自动停止」都收在一个组件里：
 * 用户直接关窗口不会留下一个还在录的进程。
 */
export function RecordDialog({ api, serial, open, onClose }: RecordDialogProps) {
  const [stage, setStage] = useState<Stage>('idle');
  const [startedAt, setStartedAt] = useState(0);
  const [maxSeconds, setMaxSeconds] = useState(180);
  const [elapsed, setElapsed] = useState(0);
  const [saved, setSaved] = useState<SavedFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stageRef = useRef<Stage>('idle');
  const closePending = useRef(false);
  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);

  // 重新打开时回到初始状态；`serial` 变了也一样。
  useEffect(() => {
    if (!open) return;
    setStage('idle');
    setStartedAt(0);
    setElapsed(0);
    setSaved(null);
    setError(null);
    closePending.current = false;
  }, [open, serial]);

  // 录制中每 500ms 刷新一次读秒。到设备端时限后自动停止并拉取文件，
  // 否则 screenrecord 自己结束后，文件会一直留在设备上没人收。
  useEffect(() => {
    if (stage !== 'recording' || !startedAt) return;
    const update = () => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      setElapsed(seconds);
      return seconds;
    };
    update();
    const timer = window.setInterval(update, 500);
    return () => window.clearInterval(timer);
  }, [stage, startedAt]);

  const stop = useCallback(async () => {
    if (!api) return;
    setStage('stopping');
    try {
      const file = await api.stopRecording(serial, `录屏_${fileStamp()}`);
      setSaved(file);
      setStage('done');
    } catch (cause) {
      setError(toMessage(cause, '停止录屏失败'));
      setStage('error');
    }
  }, [api, serial]);

  useEffect(() => {
    if (stage === 'recording' && elapsed >= maxSeconds && maxSeconds > 0) {
      void stop();
    }
  }, [stage, elapsed, maxSeconds, stop]);

  const start = useCallback(async () => {
    if (!api) return;
    setError(null);
    setSaved(null);
    setStage('starting');
    try {
      const info = await api.startRecording(serial);
      setMaxSeconds(info.maxSeconds);
      setElapsed(0);
      setStartedAt(Date.now());
      setStage('recording');
      if (closePending.current) {
        closePending.current = false;
        void stop();
      }
    } catch (cause) {
      setError(toMessage(cause, '开始录屏失败'));
      setStage('error');
    }
  }, [api, serial, stop]);

  /** 关闭前必须停掉设备端进程；停止失败也允许关闭，错误已经展示过。 */
  const close = useCallback(async () => {
    if (stageRef.current === 'starting') {
      closePending.current = true;
      return;
    }
    if (stageRef.current === 'recording') {
      await stop();
      return;
    }
    onClose();
  }, [onClose, stop]);

  // 组件被父级直接卸载（切设备、关窗口）时兜底停止。
  useEffect(() => {
    return () => {
      if (stageRef.current === 'recording' && api) {
        void api.stopRecording(serial, `录屏_${fileStamp()}`).catch(() => undefined);
      }
    };
  }, [api, serial]);

  const progress = maxSeconds > 0 ? Math.min(100, Math.round((elapsed / maxSeconds) * 100)) : 0;

  return (
    <Dialog
      attach="body"
      cancelBtn={null}
      closeOnEscKeydown={stage !== 'recording' && stage !== 'starting'}
      closeOnOverlayClick={false}
      confirmBtn={null}
      header={`录屏 · ${serial}`}
      visible={open}
      width={460}
      onCancel={() => void close()}
      onClose={() => void close()}
    >
      <div className="ac-record">
        {stage === 'idle' ? (
          <p className="ac-record__hint">
            录制设备屏幕为 MP4，最长 {maxSeconds} 秒；停止后自动保存到系统「下载」目录。
          </p>
        ) : null}

        {stage === 'starting' ? <p className="ac-record__hint">正在启动设备端录制…</p> : null}

        {stage === 'recording' || stage === 'stopping' ? (
          <div className="ac-record__live">
            <Space align="center" size="small">
              <Tag theme="danger" variant="light-outline">
                ● 录制中
              </Tag>
              <span className="ac-record__clock" data-testid="record-clock">
                {formatElapsed(elapsed)}
              </span>
              <span className="ac-record__limit">/ {formatElapsed(maxSeconds)}</span>
            </Space>
            <Progress percentage={progress} theme="line" />
            <p className="ac-record__hint">
              {stage === 'stopping' ? '正在停止并保存…' : '完成后可在「下载」目录找到 MP4 文件。'}
            </p>
          </div>
        ) : null}

        {stage === 'done' && saved ? (
          <div className="ac-record__done">
            <p className="ac-record__hint">已保存（{(saved.bytes / 1024 / 1024).toFixed(2)} MB）</p>
            <code className="ac-record__path">{saved.path}</code>
          </div>
        ) : null}

        {stage === 'error' ? (
          <div role="alert">
            <Tag theme="danger" variant="light-outline">
              {error}
            </Tag>
          </div>
        ) : null}

        <div className="ac-record__actions">
          {stage === 'idle' || stage === 'error' ? (
            <Button theme="primary" onClick={() => void start()}>
              {stage === 'error' ? '重新录制' : '开始录制'}
            </Button>
          ) : null}
          {stage === 'recording' ? (
            <Button theme="danger" onClick={() => void stop()}>
              停止并保存
            </Button>
          ) : null}
          {stage === 'starting' || stage === 'stopping' ? (
            <Button disabled loading>
              {stage === 'starting' ? '启动中…' : '保存中…'}
            </Button>
          ) : null}
          {stage === 'done' && saved ? (
            <Button variant="outline" onClick={() => void revealItemInDir(saved.path)}>
              打开所在文件夹
            </Button>
          ) : null}
          <Button variant="text" onClick={() => void close()}>
            关闭
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
