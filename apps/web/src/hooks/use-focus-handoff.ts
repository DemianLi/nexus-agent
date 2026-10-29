import { useMemo, useRef, useState } from 'react';

/**
 * 按鈕帶動的讀取，讀完之後焦點的交接（[#2009](https://github.com/DemianLi/nexus-agent/issues/2009)）。往前翻與觀測分頁的
 * 「載入這一輪的細節」共用這一份，判斷只寫在這裡（規格 §8「焦點搬動的判斷寫在換手那一層」）。
 *
 * - **按下去那一刻焦點在鈕上才記**（`arm`）。捲動帶動的往前翻、「看這一輪」帶動的拉取不經過鈕，不記，讀完也不搬。
 * - **讀完時焦點掉了才搬**（`land`）：鈕卸載之後焦點在 body。鈕還在（還有更早的、失敗改成重試）焦點本來就在鈕上；
 *   讀取中人自己 Tab 走了也不搶（§8「只在焦點本來會丟掉時才搬」）。搬不搬，這一筆都在 `land` 結束。
 * - 讀取中鈕不卸載（`disabled`＋`focusableWhenDisabled`），所以讀取中焦點一直在鈕上，失敗時也還在。
 */
export function useFocusHandoff<K>() {
  const armed = useRef<{ readonly key: K } | undefined>(undefined);
  return useMemo(
    () => ({
      arm(key: K, button: Element) {
        armed.current = document.activeElement === button ? { key } : undefined;
      },
      /** 記著、還沒交出去的那一筆。 */
      pending(): K | undefined {
        return armed.current?.key;
      },
      /** `scroll`：目標可能在畫面外（觀測分頁拉回來的那一輪），先捲到看得見再聚焦。 */
      land(target: HTMLElement | null | undefined, { scroll = false }: { scroll?: boolean } = {}) {
        armed.current = undefined;
        if (!focusLost() || target === null || target === undefined) return;
        if (scroll) target.scrollIntoView({ block: 'nearest' });
        target.focus({ preventScroll: true });
      },
    }),
    [],
  );
}

/** 焦點掉了：不在任何元素上（鈕卸載之後是 body）。 */
export function focusLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body;
}

/**
 * 讀取中鈕的報讀名稱：維持按下去之前那一句。名稱一變，焦點停在鈕上時有些報讀器會唸出來（§8「讀取中不唸」）；
 * 按「再試一次」的那一刻錯誤就清掉了（`use-conversation.ts` 的 `loadEarlier`），所以要自己記住上一句。
 */
export function useSettledLabel(label: string, loading: boolean): string {
  const [settled, setSettled] = useState(label);
  if (!loading && settled !== label) setSettled(label);
  return loading ? settled : label;
}
