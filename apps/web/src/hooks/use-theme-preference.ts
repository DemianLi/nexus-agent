import { useEffect, useState } from 'react';

import {
  applyTheme,
  NEXT_THEME,
  readThemePreference,
  systemDarkQuery,
  THEME_PREFERENCE_KEY,
  writeThemePreference,
} from '@/lib/theme';
import type { ThemePreference } from '@/lib/theme';

/**
 * 目前的亮暗偏好與「切到下一態」。第一次套用在 `main.tsx`（`createRoot` 之前），這裡只管之後的變化：
 * 跟隨系統時跟著系統偏好走，別的分頁改了偏好時跟著改（`storage` 事件只發給**別的**分頁）。
 */
export function useThemePreference(): [ThemePreference, () => void] {
  const [preference, setPreference] = useState(readThemePreference);

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

  useEffect(() => {
    // `key === null` 是別的分頁呼叫了 `localStorage.clear()`。
    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_PREFERENCE_KEY || event.key === null) {
        setPreference(readThemePreference());
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const cycle = () => {
    const next = NEXT_THEME[preference];
    writeThemePreference(next);
    setPreference(next);
  };

  return [preference, cycle];
}
