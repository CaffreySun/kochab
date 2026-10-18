import { beforeEach, describe, expect, it } from 'vitest';
import { readShellHistory, rememberShellCommand } from './shellHistory';
import { readDevicePrefs, sanitizeDevicePrefs } from './useDevicePrefs';

describe('shell 历史', () => {
  beforeEach(() => window.localStorage.clear());

  it('新命令在最前，重复命令不产生副本', () => {
    rememberShellCommand('getprop ro.product.model');
    rememberShellCommand('wm size');
    const history = rememberShellCommand('getprop ro.product.model');

    expect(history).toEqual(['getprop ro.product.model', 'wm size']);
    expect(readShellHistory()).toEqual(history);
  });

  it('忽略空白命令，并限制最多 20 条', () => {
    expect(rememberShellCommand('   ')).toEqual([]);

    for (let index = 0; index < 25; index += 1) {
      rememberShellCommand(`echo ${index}`);
    }
    const history = readShellHistory();
    expect(history).toHaveLength(20);
    expect(history[0]).toBe('echo 24');
  });

  it('localStorage 损坏时退回空历史', () => {
    window.localStorage.setItem('kochab.shellHistory', '{bad json');
    expect(readShellHistory()).toEqual([]);
  });
});

describe('设备偏好', () => {
  it('过滤非法别名与重复置顶项', () => {
    expect(
      sanitizeDevicePrefs({
        aliases: { a: ' 测试机 ', b: '', c: 42 },
        pinned: ['a', 'a', 7, 'b'],
      }),
    ).toEqual({ aliases: { a: '测试机' }, pinned: ['a', 'b'] });
  });

  it('读取损坏内容时返回空配置', () => {
    window.localStorage.setItem('kochab.devicePrefs', '[]');
    expect(readDevicePrefs()).toEqual({ aliases: {}, pinned: [] });
  });
});
