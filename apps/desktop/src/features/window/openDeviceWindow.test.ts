import { describe, expect, it } from 'vitest';
import { deviceWindowLabel } from './openDeviceWindow';
import { buildDeviceUrl, parseWindowRoute } from '../../windowMode';

describe('设备窗口', () => {
  // 回归：窗口标签一度是 `device-<serial>-<tab>`，于是同一台设备会被打开三次，
  // 窗口内点标签还会再开一个窗口。一台设备只能有一个窗口。
  it('窗口标签只按设备区分，与标签页无关', () => {
    expect(deviceWindowLabel('d4535f72')).toBe('device-d4535f72');
  });

  it('URL 里的 tab 只是初始标签', () => {
    expect(buildDeviceUrl('d4535f72', 'apps')).toBe(
      'index.html?window=device&serial=d4535f72&tab=apps',
    );

    expect(parseWindowRoute('?window=device&serial=d4535f72&tab=files')).toEqual({
      kind: 'device',
      serial: 'd4535f72',
      tab: 'files',
    });
  });

  it('非法 tab 回落到投屏，而不是渲染空工作区', () => {
    expect(parseWindowRoute('?window=device&serial=d4535f72&tab=nope')).toEqual({
      kind: 'device',
      serial: 'd4535f72',
      tab: 'mirror',
    });
  });

  it('缺少 serial 时退回主窗口', () => {
    expect(parseWindowRoute('?window=device&tab=apps')).toEqual({ kind: 'shell' });
  });
});
