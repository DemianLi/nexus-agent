// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LIVEZ_PROBE_TIMEOUT_MS, probeLivez } from '@/lib/livez-probe';

/** 收到中止才拒絕的請求：一直排著的樣子。 */
function hanging() {
  return vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('probeLivez（#2250）', () => {
  it.each([200, 503])('回來就算 answered，不看狀態碼（%i）', async (status) => {
    const doFetch = vi.fn(async () => new Response('x', { status }));
    vi.stubGlobal('fetch', doFetch);
    await expect(probeLivez(new AbortController().signal)).resolves.toBe('answered');
    expect(doFetch).toHaveBeenCalledWith('/livez', expect.anything());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('到期還沒回來：timed-out，請求被中止，不留著占位', async () => {
    const doFetch = hanging();
    vi.stubGlobal('fetch', doFetch);
    const outcome = probeLivez(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(LIVEZ_PROBE_TIMEOUT_MS - 1);
    expect(doFetch.mock.calls[0]![1].signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toBe('timed-out');
    expect(doFetch.mock.calls[0]![1].signal!.aborted).toBe(true);
  });

  it('打出去直接失敗：failed', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(probeLivez(new AbortController().signal)).resolves.toBe('failed');
  });

  it('被收掉：請求中止，回 failed，不算逾時', async () => {
    const doFetch = hanging();
    vi.stubGlobal('fetch', doFetch);
    const owner = new AbortController();
    const outcome = probeLivez(owner.signal);
    owner.abort();
    await expect(outcome).resolves.toBe('failed');
    expect(doFetch.mock.calls[0]![1].signal!.aborted).toBe(true);
  });
});
