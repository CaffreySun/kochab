/**
 * 浏览器键盘事件 → Android KeyEvent 键码的映射。
 *
 * scrcpy 的做法是把 DOM `KeyboardEvent.code` 翻译成 Android `KeyEvent` 常量。
 * 这里只依赖 `code`（物理按键位置），保证非英文输入法下也能得到一致的物理键。
 */

/** Android KeyEvent 常量（仅列出桌面键盘会触发的部分） */
export const ANDROID_KEY = {
  KEYCODE_UNKNOWN: 0,
  KEYCODE_HOME: 3,
  KEYCODE_BACK: 4,
  KEYCODE_CALL: 5,
  KEYCODE_ENDCALL: 6,
  KEYCODE_0: 7,
  KEYCODE_1: 8,
  KEYCODE_2: 9,
  KEYCODE_3: 10,
  KEYCODE_4: 11,
  KEYCODE_5: 12,
  KEYCODE_6: 13,
  KEYCODE_7: 14,
  KEYCODE_8: 15,
  KEYCODE_9: 16,
  KEYCODE_STAR: 17,
  KEYCODE_POUND: 18,
  KEYCODE_DPAD_UP: 19,
  KEYCODE_DPAD_DOWN: 20,
  KEYCODE_DPAD_LEFT: 21,
  KEYCODE_DPAD_RIGHT: 22,
  KEYCODE_DPAD_CENTER: 23,
  KEYCODE_VOLUME_UP: 24,
  KEYCODE_VOLUME_DOWN: 25,
  KEYCODE_POWER: 26,
  KEYCODE_CAMERA: 27,
  KEYCODE_A: 29,
  KEYCODE_Z: 54,
  KEYCODE_DEL: 67,
  KEYCODE_ENTER: 66,
  KEYCODE_TAB: 61,
  KEYCODE_SPACE: 62,
  KEYCODE_ESCAPE: 111,
  KEYCODE_FORWARD_DEL: 112,
  KEYCODE_MENU: 82,
  KEYCODE_NOTIFICATION: 83,
  KEYCODE_SEARCH: 84,
  KEYCODE_MEDIA_PLAY_PAUSE: 85,
  KEYCODE_MEDIA_STOP: 86,
  KEYCODE_MEDIA_NEXT: 87,
  KEYCODE_MEDIA_PREVIOUS: 88,
  KEYCODE_MOVE_HOME: 122,
  KEYCODE_MOVE_END: 123,
  KEYCODE_PAGE_UP: 92,
  KEYCODE_PAGE_DOWN: 93,
  KEYCODE_APP_SWITCH: 187,
  KEYCODE_VOLUME_MUTE: 164,
  KEYCODE_F1: 131,
  KEYCODE_F12: 142,
} as const;

/** `KeyboardEvent.code` 到 Android 键码的静态表（字母/数字/功能键之外） */
const CODE_TABLE: Readonly<Record<string, number>> = {
  Escape: ANDROID_KEY.KEYCODE_ESCAPE,
  Enter: ANDROID_KEY.KEYCODE_ENTER,
  NumpadEnter: ANDROID_KEY.KEYCODE_ENTER,
  Tab: ANDROID_KEY.KEYCODE_TAB,
  Space: ANDROID_KEY.KEYCODE_SPACE,
  Backspace: ANDROID_KEY.KEYCODE_DEL,
  Delete: ANDROID_KEY.KEYCODE_FORWARD_DEL,
  ArrowUp: ANDROID_KEY.KEYCODE_DPAD_UP,
  ArrowDown: ANDROID_KEY.KEYCODE_DPAD_DOWN,
  ArrowLeft: ANDROID_KEY.KEYCODE_DPAD_LEFT,
  ArrowRight: ANDROID_KEY.KEYCODE_DPAD_RIGHT,
  Home: ANDROID_KEY.KEYCODE_MOVE_HOME,
  End: ANDROID_KEY.KEYCODE_MOVE_END,
  PageUp: ANDROID_KEY.KEYCODE_PAGE_UP,
  PageDown: ANDROID_KEY.KEYCODE_PAGE_DOWN,
  MediaPlayPause: ANDROID_KEY.KEYCODE_MEDIA_PLAY_PAUSE,
  MediaStop: ANDROID_KEY.KEYCODE_MEDIA_STOP,
  MediaTrackNext: ANDROID_KEY.KEYCODE_MEDIA_NEXT,
  MediaTrackPrevious: ANDROID_KEY.KEYCODE_MEDIA_PREVIOUS,
};

/** 非标准但部分平台可用的 `code` 别名 */
const KEY_FALLBACK: Readonly<Record<string, number>> = {
  Backspace: ANDROID_KEY.KEYCODE_DEL,
  Delete: ANDROID_KEY.KEYCODE_FORWARD_DEL,
  Enter: ANDROID_KEY.KEYCODE_ENTER,
  Esc: ANDROID_KEY.KEYCODE_ESCAPE,
  Spacebar: ANDROID_KEY.KEYCODE_SPACE,
  Space: ANDROID_KEY.KEYCODE_SPACE,
  ArrowUp: ANDROID_KEY.KEYCODE_DPAD_UP,
  Up: ANDROID_KEY.KEYCODE_DPAD_UP,
  ArrowDown: ANDROID_KEY.KEYCODE_DPAD_DOWN,
  Down: ANDROID_KEY.KEYCODE_DPAD_DOWN,
  ArrowLeft: ANDROID_KEY.KEYCODE_DPAD_LEFT,
  Left: ANDROID_KEY.KEYCODE_DPAD_LEFT,
  ArrowRight: ANDROID_KEY.KEYCODE_DPAD_RIGHT,
  Right: ANDROID_KEY.KEYCODE_DPAD_RIGHT,
  Home: ANDROID_KEY.KEYCODE_MOVE_HOME,
  End: ANDROID_KEY.KEYCODE_MOVE_END,
  PageUp: ANDROID_KEY.KEYCODE_PAGE_UP,
  PageDown: ANDROID_KEY.KEYCODE_PAGE_DOWN,
  ' ': ANDROID_KEY.KEYCODE_SPACE,
};

/**
 * 解析 Android 键码。
 *
 * @param code `KeyboardEvent.code`
 * @param key  `KeyboardEvent.key`，仅在 `code` 为空或未知时作为兜底
 * @returns Android 键码；无法映射时返回 `KEYCODE_UNKNOWN`
 */
export function resolveAndroidKeyCode(code: string, key?: string): number {
  if (code) {
    const direct = CODE_TABLE[code];
    if (direct !== undefined) return direct;

    if (code.startsWith('Key') && code.length === 4) {
      return ANDROID_KEY.KEYCODE_A + (code.charCodeAt(3) - 0x41);
    }
    if (code.startsWith('Digit') && code.length === 6) {
      const digit = code.charCodeAt(5) - 0x30;
      if (digit >= 0 && digit <= 9) return ANDROID_KEY.KEYCODE_0 + digit;
    }
    if (code.startsWith('Numpad') && code.length > 6) {
      const last = code.charCodeAt(code.length - 1);
      if (last >= 0x30 && last <= 0x39) return ANDROID_KEY.KEYCODE_0 + (last - 0x30);
    }
    if (code.startsWith('F') && code.length >= 2 && code.length <= 3) {
      const n = Number(code.slice(1));
      if (Number.isInteger(n) && n >= 1 && n <= 12) {
        return ANDROID_KEY.KEYCODE_F1 + (n - 1);
      }
    }
  }

  if (key) {
    const fallback = KEY_FALLBACK[key];
    if (fallback !== undefined) return fallback;
    if (key.length === 1) {
      // `KeyboardEvent.key` 在未按 Shift 时是小写，这里统一按大写字母处理
      const ch = key.toUpperCase().charCodeAt(0);
      if (ch >= 0x41 && ch <= 0x5a) return ANDROID_KEY.KEYCODE_A + (ch - 0x41);
      if (ch >= 0x30 && ch <= 0x39) return ANDROID_KEY.KEYCODE_0 + (ch - 0x30);
    }
  }

  return ANDROID_KEY.KEYCODE_UNKNOWN;
}

/** 是否属于「返回键」，用于无物理键盘时的悬浮按钮 */
export const KEYCODE_BACK = ANDROID_KEY.KEYCODE_BACK;
