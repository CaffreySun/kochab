import { describe, expect, it } from 'vitest';
import { deviceWindowLabel } from './openDeviceWindow';
import { buildDeviceUrl, entryIntent, parseWindowRoute } from '../../windowMode';

describe('设备详情窗口', () => {
  // 回归：窗口标签一度是 `device-<serial>-<tab>`，于是同一台设备会被打开三次，
  // 窗口内点标签还会再开一个窗口。一台设备只能有一个窗口。
  it('窗口标签只按设备区分，与面板无关', () => {
    expect(deviceWindowLabel('d4535f72')).toBe('device-d4535f72');
  });

  it('入口意图决定是否自动投屏', () => {
    // 点「投屏」= 我要投屏；不抢右栏，用户可能正开着文件页
    expect(entryIntent('mirror')).toEqual({ startMirror: true });

    // 点「应用」/「文件」只定位右栏，不替用户占掉一条设备会话
    expect(entryIntent('apps')).toEqual({ panel: 'apps', startMirror: false });
    expect(entryIntent('files')).toEqual({ panel: 'files', startMirror: false });
  });

  it('URL 带上初始面板与是否自动投屏', () => {
    expect(buildDeviceUrl('d4535f72', 'mirror')).toBe(
      'index.html?window=device&serial=d4535f72&panel=apps&mirror=1',
    );
    expect(buildDeviceUrl('d4535f72', 'files')).toBe(
      'index.html?window=device&serial=d4535f72&panel=files&mirror=0',
    );
  });

  it('解析查询串还原初始状态', () => {
    expect(parseWindowRoute('?window=device&serial=d4535f72&panel=files&mirror=1')).toEqual({
      kind: 'device',
      serial: 'd4535f72',
      panel: 'files',
      startMirror: true,
    });
  });

  it('非法面板回落到应用页，而不是渲染空白右栏', () => {
    expect(parseWindowRoute('?window=device&serial=d4535f72&panel=nope')).toEqual({
      kind: 'device',
      serial: 'd4535f72',
      panel: 'apps',
      startMirror: false,
    });
  });

  it('缺少 serial 时退回主窗口', () => {
    expect(parseWindowRoute('?window=device&panel=apps')).toEqual({ kind: 'shell' });
  });
});
