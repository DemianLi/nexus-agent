/**
 * 分開「瀏覽器對這個 host 的連線被占滿」與「請求只是慢」（#2250）。占滿時連 `/livez` 都排不上，
 * 一直等到逾時；只是慢時它通常在逾時內回。serve 事件迴圈卡住、或封包被丟時也會逾時，分不出來，所以畫面的話要留餘地。
 */
import { agentBaseUrl } from '@/lib/agent';

/** 探測等多久。短：它排在同一個連線池裡，別留著占位。 */
export const LIVEZ_PROBE_TIMEOUT_MS = 2_000;

/** `answered`：回來了，不管狀態碼；`timed-out`：{@link LIVEZ_PROBE_TIMEOUT_MS} 內沒回來；`failed`：請求直接失敗或被收掉。 */
export type LivezProbe = 'answered' | 'timed-out' | 'failed';

/**
 * 打一次 `/livez`。回來就算 `answered`，不看狀態碼：連線排得上就夠了。永遠 resolve，不 reject。
 * @param signal - 收掉這次探測；收掉時回 `failed`。
 */
export async function probeLivez(signal: AbortSignal): Promise<LivezProbe> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, LIVEZ_PROBE_TIMEOUT_MS);
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    const response = await fetch(`${agentBaseUrl()}/livez`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    await response.body?.cancel();
    return 'answered';
  } catch {
    return timedOut ? 'timed-out' : 'failed';
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}
