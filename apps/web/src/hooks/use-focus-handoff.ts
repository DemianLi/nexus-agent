import { useMemo, useRef, useState } from 'react';

/**
 * 讀取用的鈕收掉之後焦點的交接（[#2009](https://github.com/DemianLi/nexus-agent/issues/2009)）。往前翻與觀測分頁的
 * 「載入這一輪的細節」共用這一份，判斷寫在這裡（`.docs/web-ui-spec.md` §8「焦點搬動的判斷寫在換手那一層」）；觀測分頁另有一步：
 * 交接前先展開到那一組（`trace/panel.tsx`）。
 *
 * - **焦點在鈕上才記**（`arm`）：鈕被聚焦時呼叫（鍵盤按下去之前一定先聚焦；Safari 用滑鼠點不聚焦，就不記）。判準只有焦點，
 *   不看是誰帶動的：捲動帶動的往前翻、「看這一輪」帶動的拉取，焦點通常不在鈕上，就不記；焦點停在鈕上的照樣記（含自動開始的
 *   拉取，前景子代理一展開就拉）。
 * - **鈕不在了、焦點也掉了才搬**（`land`）：鈕卸載之後焦點在 body。鈕還在（還有更早的、失敗改成重試）焦點本來就在鈕上；
 *   讀取中人自己 Tab 走了也不搶（§8「只在焦點本來會丟掉時才搬」）。鈕還在、焦點也還在上面，這一筆就留到下一次讀完
 *   （往前翻連翻幾頁，最後一頁才收掉鈕）；其餘情況這一筆在 `land` 結束。
 * - `PullControl` 與往前翻的鈕讀取中不卸載（`disabled`＋`focusableWhenDisabled`）：焦點在鈕上就留在鈕上，失敗時也還在。
 */
export function useFocusHandoff<K>() {
  const armed = useRef<{ readonly key: K; readonly button: Element } | undefined>(undefined);
  return useMemo(
    () => ({
      arm(key: K, button: Element) {
        armed.current = { key, button };
      },
      /** 記著、還沒交出去的那一筆。 */
      pending(): K | undefined {
        return armed.current?.key;
      },
      /** `scroll`：目標可能在畫面外（觀測分頁拉回來的那一輪），先捲到看得見再聚焦。 */
      land(target: HTMLElement | null | undefined, { scroll = false }: { scroll?: boolean } = {}) {
        const button = armed.current?.button;
        if (button === undefined) return;
        if (button.isConnected) {
          if (document.activeElement !== button) armed.current = undefined;
          return;
        }
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
 * 按下去的那一刻失敗就不在狀態裡了：往前翻在 `loadEarlier` 清掉錯誤（`use-conversation.ts`），觀測分頁的 `PullStatus` 讀取中不帶失敗，
 * 所以要自己記住上一句。
 */
export function useSettledLabel(label: string, loading: boolean): string {
  const [settled, setSettled] = useState(label);
  if (!loading && settled !== label) setSettled(label);
  return loading ? settled : label;
}
