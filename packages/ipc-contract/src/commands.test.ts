import { describe, expect, it } from 'vitest';
import { COMMANDS, type CommandName } from './commands';
import { EVENTS, type EventName } from './events';

const entries = Object.entries(COMMANDS);
const eventEntries = Object.entries(EVENTS);

describe('命令名注册表', () => {
  it('不能为空', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it('所有命令名唯一', () => {
    const values = entries.map(([, value]) => value);
    expect(new Set(values).size).toBe(values.length);
  });

  it('所有命令名符合 {领域}_{动作} 的 snake_case 约定', () => {
    const pattern = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
    for (const [key, value] of entries) {
      expect(value, `命令 ${key} 应匹配 ${pattern}`).toMatch(pattern);
    }
  });

  it('键名是命令名的 camelCase 形式', () => {
    const toCamel = (snake: string) =>
      snake
        .split('_')
        .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
        .join('');

    for (const [key, value] of entries) {
      expect(toCamel(value), `命令名 ${value} 推导出的键名应与 ${key} 一致`).toBe(key);
    }
  });

  it('导出类型 CommandName 与运行时取值一致', () => {
    const sample: CommandName = COMMANDS.deviceList;
    expect(sample).toBe('device_list');
  });
});

describe('事件名注册表', () => {
  it('所有事件名唯一', () => {
    const values = eventEntries.map(([, value]) => value);
    expect(new Set(values).size).toBe(values.length);
  });

  it('所有事件名符合 <domain>://<kebab-event> 约定', () => {
    const pattern = /^[a-z][a-z0-9]*:\/\/[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
    for (const [key, value] of eventEntries) {
      expect(value, `事件 ${key} 应匹配 ${pattern}`).toMatch(pattern);
    }
  });

  it('导出类型 EventName 与运行时取值一致', () => {
    const sample: EventName = EVENTS.deviceChanged;
    expect(sample).toBe('device://changed');
  });
});
