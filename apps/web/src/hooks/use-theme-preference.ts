import { useEffect, useSyncExternalStore } from 'react';

import {
  applyTheme,
  NEXT_THEME,
  readThemePreference,
  systemDarkQuery,
  THEME_PREFERENCE_KEY,
  writeThemePreference,
} from '@/lib/theme';
import type { ThemePreference } from '@/lib/theme';

/** 同一個分頁裡的其他使用者（切換鈕以外還有 Toaster）；`storage` 事件只發給**別的**分頁。 */
const listeners = new Set<() => void>();

/** 寫不進 `localStorage` 時，這次的選擇只留在這個分頁（別的分頁改了偏好就讓位）。 */
let unsaved: ThemePreference | undefined;

function snapshot(): ThemePreference {
  return unsaved ?? readThemePreference();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // `key === null` 是別的分頁呼叫了 `localStorage.clear()`。
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_PREFERENCE_KEY || event.key === null) {
      unsaved = undefined;
      onChange();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(onChange);
    // 沒有人在看了，只留在這個分頁的那一份也沒有要留給誰（測試之間也不殘留）。
    if (listeners.size === 0) unsaved = undefined;
    window.removeEventListener('storage', onStorage);
  };
}

/**
 * 目前的亮暗偏好與「切到下一態」。第一次套用在 `main.tsx`（`createRoot` 之前），這裡只管之後的變化：
 * 跟隨系統時跟著系統偏好走，別的分頁改了偏好時跟著改。
 *
 * **偏好的真相在 `localStorage`**，每個掛著這個 hook 的元件讀的是同一份，所以切換鈕按下去 Toaster 也跟著變。
 */
export function useThemePreference(): [ThemePreference, () => void] {
  const preference = useSyncExternalStore(subscribe, snapshot);

  useEffect(() => {
    applyTheme(preference);
    if (preference !== 'system') {
      return;
    }
    const query = systemDarkQuery();
    if (query === undefined) {
      return;
    }
    const follow = () => applyTheme('system');
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  }, [preference]);

  const cycle = () => {
    const next = NEXT_THEME[preference];
    unsaved = writeThemePreference(next) ? undefined : next;
    listeners.forEach((listener) => listener());
  };

  return [preference, cycle];
}
