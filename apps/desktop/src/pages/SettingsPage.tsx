import { useCallback, useEffect, useState } from 'react';
import { Button, Form, InputNumber, Loading, Space, Switch, Tag } from 'tdesign-react';
import type { ToolchainStatus } from '@ac/ipc-contract';
import type { Api } from '../ipc';
import { toMessage } from '../ipc';
import { DEFAULT_PREVIEW_LIMIT } from './DevicesPage';
import { DEFAULT_MIRROR_OPTIONS, type MirrorOptions } from '../features/settings/mirrorOptions';

const MIRROR_PRESETS: Array<{ label: string; options: Partial<MirrorOptions> }> = [
  { label: '流畅', options: { maxSize: 720, maxFps: 30, bitRate: 4 } },
  { label: '均衡', options: { maxSize: 1080, maxFps: 30, bitRate: 8 } },
  { label: '高清', options: { maxSize: 0, maxFps: 60, bitRate: 16 } },
];

function matchesPreset(options: MirrorOptions, preset: Partial<MirrorOptions>): boolean {
  return Object.entries(preset).every(
    ([key, value]) => options[key as keyof MirrorOptions] === value,
  );
}

export interface SettingsPageProps {
  api: Api | null;
  previewEnabled: boolean;
  onPreviewEnabledChange: (enabled: boolean) => void;
  previewLimit: number;
  onPreviewLimitChange: (limit: number) => void;
  mirrorOptions: MirrorOptions;
  onMirrorOptionsChange: (options: MirrorOptions) => void;
}

/** 设置页：预览开关与并发上限、工具链自检。 */
export function SettingsPage({
  api,
  previewEnabled,
  onPreviewEnabledChange,
  previewLimit,
  onPreviewLimitChange,
  mirrorOptions,
  onMirrorOptionsChange,
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
        <h2 className="ac-settings__heading">投屏画质</h2>
        <p className="ac-settings__hint">
          新开投屏窗口时使用的默认参数。改动会立即保存，新开的窗口按新参数建立会话；
          已经建立的会话不受影响。
        </p>
        <div className="ac-settings__presets">
          {MIRROR_PRESETS.map((preset) => {
            const active = matchesPreset(mirrorOptions, preset.options);
            return (
              <Button
                key={preset.label}
                size="small"
                theme={active ? 'primary' : 'default'}
                variant={active ? 'base' : 'outline'}
                onClick={() => onMirrorOptionsChange({ ...mirrorOptions, ...preset.options })}
              >
                {preset.label}
              </Button>
            );
          })}
          <Button
            size="small"
            variant="text"
            onClick={() => onMirrorOptionsChange(DEFAULT_MIRROR_OPTIONS)}
          >
            恢复默认
          </Button>
        </div>
        <Form labelAlign="left" labelWidth={120}>
          <Form.FormItem help="短边像素上限；填 0 表示跟随设备原始分辨率" label="分辨率上限">
            <div>
              <InputNumber
                max={4096}
                min={0}
                step={120}
                theme="column"
                value={mirrorOptions.maxSize}
                onChange={(value) =>
                  onMirrorOptionsChange({ ...mirrorOptions, maxSize: Number(value) || 0 })
                }
              />
            </div>
          </Form.FormItem>
          <Form.FormItem help="每秒帧率上限" label="帧率">
            <div>
              <InputNumber
                max={120}
                min={1}
                theme="column"
                value={mirrorOptions.maxFps}
                onChange={(value) =>
                  onMirrorOptionsChange({
                    ...mirrorOptions,
                    maxFps: Number(value) || DEFAULT_MIRROR_OPTIONS.maxFps,
                  })
                }
              />
            </div>
          </Form.FormItem>
          <Form.FormItem help="视频码率（Mbps）" label="码率">
            <div>
              <InputNumber
                max={100}
                min={1}
                theme="column"
                value={mirrorOptions.bitRate}
                onChange={(value) =>
                  onMirrorOptionsChange({
                    ...mirrorOptions,
                    bitRate: Number(value) || DEFAULT_MIRROR_OPTIONS.bitRate,
                  })
                }
              />
            </div>
          </Form.FormItem>
          <Form.FormItem label="显示触摸点">
            <div>
              <Switch
                value={mirrorOptions.showTouches}
                onChange={(value) =>
                  onMirrorOptionsChange({ ...mirrorOptions, showTouches: Boolean(value) })
                }
              />
            </div>
          </Form.FormItem>
          <Form.FormItem label="保持屏幕常亮">
            <div>
              <Switch
                value={mirrorOptions.stayAwake}
                onChange={(value) =>
                  onMirrorOptionsChange({ ...mirrorOptions, stayAwake: Boolean(value) })
                }
              />
            </div>
          </Form.FormItem>
        </Form>
      </section>

      <section className="ac-settings__section">
        <h2 className="ac-settings__heading">设备列表预览</h2>
        <p className="ac-settings__hint">
          卡片上的实时缩略图本质是一条低清低帧率的投屏会话。同一台设备同时只能有一条会话，
          因此离开设备列表（比如进入某台设备的投屏）时预览会自动停止。
        </p>
        <Form labelAlign="left" labelWidth={120}>
          <Form.FormItem label="开启缩略图">
            <div>
              <Switch value={previewEnabled} onChange={onPreviewEnabledChange} />
            </div>
          </Form.FormItem>
          <Form.FormItem help="设备较多时限制同时预览的数量，避免主机解码压力过大" label="并发上限">
            <div>
              <InputNumber
                max={12}
                min={1}
                theme="column"
                value={previewLimit}
                onChange={(value) => onPreviewLimitChange(Number(value) || DEFAULT_PREVIEW_LIMIT)}
              />
            </div>
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
