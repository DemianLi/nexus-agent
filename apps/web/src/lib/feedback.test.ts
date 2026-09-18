import type {
  AiEntry,
  FeedbackListResult,
  FeedbackOutcome,
  FeedbackPutResult,
  WireFeedbackItem,
} from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { FEEDBACK_COPY, isRatable } from '@/lib/feedback';
import { RatingsController } from '@/lib/feedback-ratings';
import type { RatingsRemote, RatingsView } from '@/lib/feedback-ratings';

/**
 * 按鈕放哪一則的判法在折疊器（`@nexus/wire` 的 `turn-tail.test.ts`），這裡只驗畫面那一道：收尾那則、指名得到、
 * 不是講到一半被停下來的。讀回與修改的次序照 dsh 的 `controller.client.spec.ts`（`ddefc45`）。
 */

function ai(overrides: Partial<AiEntry> = {}): AiEntry {
  return {
    kind: 'ai',
    id: 'r1',
    text: '答。',
    streaming: false,
    attribution: { kind: 'root' },
    ...overrides,
  };
}

describe('isRatable', () => {
  it('收尾那則、有 messageId 才長；被停下來的那則不長（同 dsh：凍結的半段沒有 messageId）', () => {
    expect(isRatable(ai({ turnTail: true, messageId: 'm1' }))).toBe(true);
    expect(isRatable(ai({ messageId: 'm1' }))).toBe(false);
    expect(isRatable(ai({ turnTail: true }))).toBe(false);
    expect(isRatable(ai({ turnTail: true, messageId: 'm1', stopped: true }))).toBe(false);
  });
});

function item(overrides: Partial<WireFeedbackItem> = {}): WireFeedbackItem {
  return {
    messageId: 'm1',
    rating: 'negative',
    version: 'v1',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** 一個手動放行的 promise。 */
function gate<T>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const listed = (items: readonly WireFeedbackItem[]): FeedbackOutcome<FeedbackListResult> => ({
  kind: 'ok',
  result: { ok: true, value: { items } },
});

function remote(overrides: Partial<RatingsRemote> = {}): RatingsRemote & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    list: async () => {
      calls.push('list');
      return listed([]);
    },
    put: async (params) => {
      calls.push(`put ${params.messageId} ${String(params.ifVersion)}`);
      return { kind: 'ok', result: { ok: true, value: item({ rating: params.rating }) } };
    },
    delete: async (params) => {
      calls.push(`delete ${params.messageId} ${params.ifVersion}`);
      return { kind: 'ok', result: { ok: true, value: { absent: true } } };
    },
    ...overrides,
  };
}

function controllerOf(backend: RatingsRemote): {
  controller: RatingsController;
  views: RatingsView[];
} {
  const views: RatingsView[] = [];
  return { controller: new RatingsController(backend, (view) => views.push(view)), views };
}

describe('RatingsController', () => {
  it('ensure 只讀一次；同時來的共用同一次', async () => {
    const backend = remote({
      list: async () => {
        backend.calls.push('list');
        return listed([item()]);
      },
    });
    const { controller } = controllerOf(backend);
    await Promise.all([controller.ensure(), controller.ensure()]);
    await controller.ensure();
    expect(backend.calls).toEqual(['list']);
    expect(controller.view.status).toBe('ready');
    expect(controller.view.items.get('m1')).toEqual(item());
  });

  it('修改前先讀回：拿存著的那個版本去比', async () => {
    const backend = remote({
      list: async () => {
        backend.calls.push('list');
        return listed([item({ version: 'v-stored' })]);
      },
    });
    const { controller } = controllerOf(backend);
    expect(await controller.rate('m1', 'positive')).toEqual({ ok: true });
    expect(backend.calls).toEqual(['list', 'put m1 v-stored']);
    expect(controller.view.items.get('m1')?.rating).toBe('positive');
  });

  it('修改逐筆排隊：第二次拿的是第一次落定後的版本', async () => {
    const first = gate<FeedbackOutcome<FeedbackPutResult>>();
    let puts = 0;
    const backend = remote({
      put: async (params) => {
        backend.calls.push(`put ${params.messageId} ${String(params.ifVersion)}`);
        puts += 1;
        if (puts === 1) return first.promise;
        return { kind: 'ok', result: { ok: true, value: item({ version: 'v2' }) } };
      },
    });
    const { controller } = controllerOf(backend);
    const one = controller.rate('m1', 'negative');
    const two = controller.rate('m1', 'positive');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(backend.calls).toEqual(['list', 'put m1 null']);
    first.open({ kind: 'ok', result: { ok: true, value: item({ version: 'v1' }) } });
    await Promise.all([one, two]);
    expect(backend.calls).toEqual(['list', 'put m1 null', 'put m1 v1']);
  });

  it('重連的重讀排在路上的修改後面：舊的清單蓋不回剛寫進去的版本', async () => {
    const put = gate<FeedbackOutcome<FeedbackPutResult>>();
    let reads = 0;
    const backend = remote({
      list: async () => {
        reads += 1;
        backend.calls.push(`list ${reads}`);
        // 第一次是還沒評；重讀那次 server 已經有新版本。
        return listed(reads === 1 ? [] : [item({ version: 'v-new', rating: 'positive' })]);
      },
      put: async () => {
        backend.calls.push('put');
        return put.promise;
      },
    });
    const { controller } = controllerOf(backend);
    await controller.ensure();
    const rating = controller.rate('m1', 'positive');
    const resync = controller.resync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 重讀還沒送出去：它排在那一次 put 後面。
    expect(backend.calls).toEqual(['list 1', 'put']);
    put.open({
      kind: 'ok',
      result: { ok: true, value: item({ version: 'v-new', rating: 'positive' }) },
    });
    await Promise.all([rating, resync]);
    expect(backend.calls).toEqual(['list 1', 'put', 'list 2']);
    expect(controller.view.items.get('m1')?.version).toBe('v-new');
  });

  it('收回排到了才重看：已經不是那個評分就什麼都不送', async () => {
    const backend = remote({
      list: async () => {
        backend.calls.push('list');
        return listed([item({ rating: 'positive' })]);
      },
    });
    const { controller } = controllerOf(backend);
    expect(await controller.retract('m1', 'negative')).toEqual({ ok: true });
    expect(backend.calls).toEqual(['list']);
    expect(await controller.retract('m1', 'positive')).toEqual({ ok: true });
    expect(backend.calls).toEqual(['list', 'delete m1 v1']);
    expect(controller.view.items.has('m1')).toBe(false);
  });

  it('衝突：畫上目前那筆，講衝突那一句', async () => {
    const backend = remote({
      put: async () => ({
        kind: 'ok',
        result: {
          ok: false,
          error: { code: 'version-conflict', current: item({ rating: 'positive', version: 'v9' }) },
        },
      }),
    });
    const { controller } = controllerOf(backend);
    expect(await controller.rate('m1', 'negative')).toEqual({
      ok: false,
      failure: FEEDBACK_COPY.conflict,
    });
    expect(controller.view.items.get('m1')?.version).toBe('v9');
  });

  it('讀不回來：狀態是 failed、修改不送出；下一次再試', async () => {
    let reads = 0;
    const backend = remote({
      list: async () => {
        reads += 1;
        backend.calls.push('list');
        if (reads === 1) return { kind: 'rejected', message: '斷了' };
        return listed([]);
      },
    });
    const { controller } = controllerOf(backend);
    expect(await controller.rate('m1', 'negative')).toEqual({
      ok: false,
      failure: `${FEEDBACK_COPY.generic}：斷了`,
    });
    expect(controller.view.status).toBe('failed');
    expect(backend.calls).toEqual(['list']);
    expect(await controller.rate('m1', 'negative')).toEqual({ ok: true });
    expect(backend.calls).toEqual(['list', 'list', 'put m1 null']);
  });
});
