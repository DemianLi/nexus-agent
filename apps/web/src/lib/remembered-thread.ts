/**
 * 瀏覽器記住的那一條 thread——照 dsh `ClientSessions` 的 `dsh.sessions.current`
 * （`packages/api/session-controller/src/client/sessions/service.ts`，本地 clone `a305303`；
 * 這條路徑與 `c291e79` 之間沒有差異）。
 *
 * **形狀照抄**：一個 `localStorage` 鍵、整個值一份 JSON、裡面一個 id。**失敗的約定也照抄**
 * （dsh `packages/client/store/src/index.ts` 的 `attachPersistence`）：讀不到、寫不進、
 * 存的東西壞了，都只是記不住，不讓畫面壞掉——無痕模式、容量滿了、被別的版本寫壞，都不值得
 * 換來一個白畫面。
 *
 * **和 dsh 不同的一處**：dsh 的 id 由伺服器發、選取對著伺服器的清單驗；我們沒有清單
 * （[#251](https://github.com/DemianLi/nexus-agent/issues/251) 拍板的第二刀），id 是這一端自己
 * 生的，伺服器碰到一個以前寫過的 id 就接回來、沒見過就新開。所以這一端**分不出**伺服器實際上
 * 是接回來還是新開的——`resumed` 只說「這個 id 是從上一次讀回來的」，畫面上的話要照這個分寸講。
 *
 * @module
 */

/** 存在哪個鍵。 */
export const REMEMBERED_THREAD_KEY = 'nexus.threads.current';

/** 這一次載入要開哪一條。 */
export interface ThreadChoice {
  readonly threadId: string;
  /** 這個 id 是從上一次讀回來的，不是這一次才生的。 */
  readonly resumed: boolean;
}

/**
 * 拿 `localStorage`。**光是讀這個全域就可能拋**（有些瀏覽器擋掉網站資料時是 `SecurityError`），
 * 所以連這一下也包起來。
 */
function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** 讀回上一次那一條。沒有、讀不到、或存的東西不是那個形狀，都是 `undefined`。 */
function recalled(): string | undefined {
  try {
    const raw = storage()?.getItem(REMEMBERED_THREAD_KEY);
    if (raw === null || raw === undefined) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(raw);
    const threadId = (parsed as { threadId?: unknown } | null)?.threadId;
    return typeof threadId === 'string' && threadId !== '' ? threadId : undefined;
  } catch (error) {
    console.error(`讀不回 ${REMEMBERED_THREAD_KEY}，開一條新的：`, error);
    return undefined;
  }
}

/**
 * 這一次載入要開哪一條：上一次那一條，沒有就生一條新的。
 *
 * **只讀不寫。** 它是 `useState` 的初始化器，而 StrictMode 在開發模式下會把初始化器跑兩次、
 * 丟掉其中一份；在這裡寫進去的話，存到的可能是被丟掉的那一個 id，下一次重新整理就接到一條
 * 從來沒開過的 thread 上。寫的那一半是 {@link rememberThread}，由 effect 呼叫。
 */
export function recallThread(): ThreadChoice {
  const threadId = recalled();
  return threadId === undefined
    ? { threadId: crypto.randomUUID(), resumed: false }
    : { threadId, resumed: true };
}

/** 記下這一條，下一次載入接它。寫不進去就算了（見模組說明）。 */
export function rememberThread(threadId: string): void {
  try {
    storage()?.setItem(REMEMBERED_THREAD_KEY, JSON.stringify({ threadId }));
  } catch (error) {
    console.error(`寫不進 ${REMEMBERED_THREAD_KEY}，這一條 thread 下次載入接不回來：`, error);
  }
}
