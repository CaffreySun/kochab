import { describe, expect, it } from 'vitest';
import { ANDROID_KEY, resolveAndroidKeyCode } from './keys';

describe('resolveAndroidKeyCode', () => {
  it('字母键使用 code 的物理位置', () => {
    expect(resolveAndroidKeyCode('KeyA')).toBe(ANDROID_KEY.KEYCODE_A);
    expect(resolveAndroidKeyCode('KeyQ')).toBe(ANDROID_KEY.KEYCODE_A + 16);
    expect(resolveAndroidKeyCode('KeyZ')).toBe(ANDROID_KEY.KEYCODE_Z);
  });

  it('数字键', () => {
    expect(resolveAndroidKeyCode('Digit0')).toBe(ANDROID_KEY.KEYCODE_0);
    expect(resolveAndroidKeyCode('Digit9')).toBe(ANDROID_KEY.KEYCODE_0 + 9);
  });

  it('数字小键盘', () => {
    expect(resolveAndroidKeyCode('Numpad0')).toBe(ANDROID_KEY.KEYCODE_0);
    expect(resolveAndroidKeyCode('Numpad7')).toBe(ANDROID_KEY.KEYCODE_0 + 7);
  });

  it('功能键 F1..F12', () => {
    expect(resolveAndroidKeyCode('F1')).toBe(ANDROID_KEY.KEYCODE_F1);
    expect(resolveAndroidKeyCode('F12')).toBe(ANDROID_KEY.KEYCODE_F12);
  });

  it('导航与编辑键', () => {
    expect(resolveAndroidKeyCode('Enter')).toBe(ANDROID_KEY.KEYCODE_ENTER);
    expect(resolveAndroidKeyCode('NumpadEnter')).toBe(ANDROID_KEY.KEYCODE_ENTER);
    expect(resolveAndroidKeyCode('Escape')).toBe(ANDROID_KEY.KEYCODE_ESCAPE);
    expect(resolveAndroidKeyCode('Backspace')).toBe(ANDROID_KEY.KEYCODE_DEL);
    expect(resolveAndroidKeyCode('Delete')).toBe(ANDROID_KEY.KEYCODE_FORWARD_DEL);
    expect(resolveAndroidKeyCode('Tab')).toBe(ANDROID_KEY.KEYCODE_TAB);
    expect(resolveAndroidKeyCode('Space')).toBe(ANDROID_KEY.KEYCODE_SPACE);
  });

  it('方向键映射为 DPAD', () => {
    expect(resolveAndroidKeyCode('ArrowUp')).toBe(ANDROID_KEY.KEYCODE_DPAD_UP);
    expect(resolveAndroidKeyCode('ArrowDown')).toBe(ANDROID_KEY.KEYCODE_DPAD_DOWN);
    expect(resolveAndroidKeyCode('ArrowLeft')).toBe(ANDROID_KEY.KEYCODE_DPAD_LEFT);
    expect(resolveAndroidKeyCode('ArrowRight')).toBe(ANDROID_KEY.KEYCODE_DPAD_RIGHT);
  });

  it('翻页与行首行尾', () => {
    expect(resolveAndroidKeyCode('Home')).toBe(ANDROID_KEY.KEYCODE_MOVE_HOME);
    expect(resolveAndroidKeyCode('End')).toBe(ANDROID_KEY.KEYCODE_MOVE_END);
    expect(resolveAndroidKeyCode('PageUp')).toBe(ANDROID_KEY.KEYCODE_PAGE_UP);
    expect(resolveAndroidKeyCode('PageDown')).toBe(ANDROID_KEY.KEYCODE_PAGE_DOWN);
  });

  it('媒体键', () => {
    expect(resolveAndroidKeyCode('MediaPlayPause')).toBe(ANDROID_KEY.KEYCODE_MEDIA_PLAY_PAUSE);
    expect(resolveAndroidKeyCode('MediaStop')).toBe(ANDROID_KEY.KEYCODE_MEDIA_STOP);
    expect(resolveAndroidKeyCode('MediaTrackNext')).toBe(ANDROID_KEY.KEYCODE_MEDIA_NEXT);
    expect(resolveAndroidKeyCode('MediaTrackPrevious')).toBe(ANDROID_KEY.KEYCODE_MEDIA_PREVIOUS);
  });

  it('code 缺失时用 key 兜底', () => {
    expect(resolveAndroidKeyCode('', 'a')).toBe(ANDROID_KEY.KEYCODE_A);
    expect(resolveAndroidKeyCode('', '7')).toBe(ANDROID_KEY.KEYCODE_0 + 7);
    expect(resolveAndroidKeyCode('', ' ')).toBe(ANDROID_KEY.KEYCODE_SPACE);
    expect(resolveAndroidKeyCode('', 'ArrowLeft')).toBe(ANDROID_KEY.KEYCODE_DPAD_LEFT);
  });

  it('完全无法映射时返回 KEYCODE_UNKNOWN', () => {
    expect(resolveAndroidKeyCode('F13')).toBe(ANDROID_KEY.KEYCODE_UNKNOWN);
    expect(resolveAndroidKeyCode('IntlBackslash')).toBe(ANDROID_KEY.KEYCODE_UNKNOWN);
    expect(resolveAndroidKeyCode('', '中')).toBe(ANDROID_KEY.KEYCODE_UNKNOWN);
    expect(resolveAndroidKeyCode('', '')).toBe(ANDROID_KEY.KEYCODE_UNKNOWN);
  });

  it('非法长度的 Key/Digit 前缀不会产生越界键码', () => {
    // KeyA 之外的短前缀不应被误判为字母
    expect(resolveAndroidKeyCode('Key')).toBe(ANDROID_KEY.KEYCODE_UNKNOWN);
    expect(resolveAndroidKeyCode('Digit')).toBe(ANDROID_KEY.KEYCODE_UNKNOWN);
    expect(resolveAndroidKeyCode('DigitX')).toBe(ANDROID_KEY.KEYCODE_UNKNOWN);
  });
});
