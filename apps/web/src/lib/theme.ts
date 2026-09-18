/**
 * 亮暗三態：淺、深、跟隨系統，預設跟隨系統（`.docs/web-ui-spec.md` §6，決議在
 * [#391](https://github.com/DemianLi/nexus-agent/issues/391#issuecomment-5722962752)）。
 *
 * **套用邏輯有兩份**：這裡一份，`index.html` 的內嵌腳本一份。內嵌腳本是唯一在第一次繪製前生效的位置
 * （沒有 SSR，harness 也不送 HTML），所以不能只留這一份；兩份用 `theme.test.ts` 對齊 key 與結果。
 * 改這裡的判斷時，同一個 PR 改內嵌腳本。
 *
 * **失敗的約定**同 `remembered-thread.ts`：讀不到、寫不進、存的東西不認得，都當成沒存過，退回跟隨系統。
 *
 * @module
 */

/** 存在哪個鍵（`nexus.` 命名空間照 `nexus.threads.current`）。`index.html` 的內嵌腳本寫的是同一個字串。 */
export const THEME_PREFERENCE_KEY = 'nexus.theme.preference';

export type ThemePreference = 'system' | 'light' | 'dark';

/** 按一下切到哪一態：跟隨系統 → 淺色 → 深色 → 跟隨系統。 */
export const NEXT_THEME: Record<ThemePreference, ThemePreference> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

export const THEME_LABEL: Record<ThemePreference, string> = {
  system: '跟隨系統',
  light: '淺色',
  dark: '深色',
};

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** 系統偏好的 media query；沒有 `matchMedia`（jsdom）時是 `undefined`。 */
export function systemDarkQuery(): MediaQueryList | undefined {
  return typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : undefined;
}

/** 光是讀 `localStorage` 這個全域就可能拋（擋掉網站資料時），連這一下也包起來。 */
function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function readThemePreference(): ThemePreference {
  try {
    const raw = storage()?.getItem(THEME_PREFERENCE_KEY);
    return raw === 'light' || raw === 'dark' ? raw : 'system';
  } catch {
    return 'system';
  }
}

export function writeThemePreference(preference: ThemePreference): void {
  try {
    storage()?.setItem(THEME_PREFERENCE_KEY, preference);
  } catch (error) {
    console.error(`寫不進 ${THEME_PREFERENCE_KEY}，這次的選擇只留在這個分頁：`, error);
  }
}

/** 在 `<html>` 上套出結果：深色掛 `.dark`，`color-scheme` 跟著設（捲軸與原生輸入框才會一起變）。 */
export function applyTheme(preference: ThemePreference): void {
  const dark =
    preference === 'dark' || (preference === 'system' && systemDarkQuery()?.matches === true);
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
}
