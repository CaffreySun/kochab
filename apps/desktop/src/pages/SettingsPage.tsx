import { useCallback, useEffect, useState } from 'react';
import { Button, Form, InputNumber, Loading, Space, Switch, Tag } from 'tdesign-react';
import type { ToolchainStatus } from '@ac/ipc-contract';
import type { Api } from '../ipc';
import { toMessage } from '../ipc';
import { DEFAULT_PREVIEW_LIMIT } from './DevicesPage';

export interface SettingsPageProps {
  api: Api | null;
  previewEnabled: boolean;
  onPreviewEnabledChange: (enabled: boolean) => void;
  previewLimit: number;
  onPreviewLimitChange: (limit: number) => void;
}

/** 设置页：预览开关与并发上限、工具链自检。 */
export function SettingsPage({
  api,
  previewEnabled,
  onPreviewEnabledChange,
  previewLimit,
  onPreviewLimitChange,
}: SettingsPageProps) {
  const [diagnostics, setDiagnostics] = useState<ToolchainStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const diagnose = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    setError(null);
    try {
      setDiagnostics(await api.toolchainDiagnostics());
    } catch (cause) {
      setError(toMessage(cause, '读取工具链状态失败'));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void diagnose();
  }, [diagnose]);

  return (
    <div className="ac-settings">
      <section className="ac-settings__section">
        <h2 className="ac-settings__heading">设备列表预览</h2>
        <p className="ac-settings__hint">
          卡片上的实时缩略图本质是一条低清低帧率的投屏会话。同一台设备同时只能有一条会话，
          因此离开设备列表（比如进入某台设备的投屏）时预览会自动停止。
        </p>
        <Form labelAlign="left" labelWidth={120}>
          <Form.FormItem label="开启缩略图">
            <Switch value={previewEnabled} onChange={onPreviewEnabledChange} />
          </Form.FormItem>
          <Form.FormItem help="设备较多时限制同时预览的数量，避免主机解码压力过大" label="并发上限">
            <InputNumber
              max={12}
              min={1}
              theme="column"
              value={previewLimit}
              onChange={(value) => onPreviewLimitChange(Number(value) || DEFAULT_PREVIEW_LIMIT)}
            />
          </Form.FormItem>
        </Form>
      </section>

      <section className="ac-settings__section">
        <h2 className="ac-settings__heading">工具链</h2>
        <Space size="small">
          <Button loading={loading} size="small" variant="outline" onClick={() => void diagnose()}>
            重新检测
          </Button>
        </Space>

        {loading ? <Loading loading size="small" text="正在检测…" /> : null}

        {error ? (
          <div role="alert">
            <Tag theme="danger" variant="light-outline">
              {error}
            </Tag>
          </div>
        ) : null}

        {diagnostics ? (
          <dl className="ac-settings__diagnostics">
            <div>
              <dt>adb 路径</dt>
              <dd>{diagnostics.adbPath ?? '未找到（不影响连接本机已启动的 adb server）'}</dd>
            </div>
            <div>
              <dt>adb 版本</dt>
              <dd>{diagnostics.adbVersion ?? '未知'}</dd>
            </div>
            <div>
              <dt>adb server</dt>
              <dd>{diagnostics.adbServerReachable ? '可连接' : '不可连接'}</dd>
            </div>
            <div>
              <dt>scrcpy-server</dt>
              <dd>{diagnostics.scrcpyServerPath ?? '未找到'}</dd>
            </div>
            {diagnostics.problems.length > 0 ? (
              <div>
                <dt>问题</dt>
                <dd>
                  <ul className="ac-settings__problems">
                    {diagnostics.problems.map((problem) => (
                      <li key={problem}>{problem}</li>
                    ))}
                  </ul>
                </dd>
              </div>
            ) : (
              <div>
                <dt>问题</dt>
                <dd>无</dd>
              </div>
            )}
          </dl>
        ) : null}
      </section>
    </div>
  );
}
