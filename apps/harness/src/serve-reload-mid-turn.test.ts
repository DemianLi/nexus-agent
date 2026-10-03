/**
 * **模型還在串流、回覆還沒落盤時重新整理**（[#953](https://github.com/DemianLi/nexus-agent/issues/953) 第一刀），對著真的 server 走一次：
 * 一個 client 開跑，另一個 client 照 web 的 `use-conversation.ts` 做一次「開下行 → 拿歷史 → 折 → 再折即時」。
 *
 * 那一刻日誌上只有開著的這一輪（`turn/start`、`model/start`），沒有任何回覆。歷史重播曾經因此回 `reply-missing`，
 * 被當成「舊格式、模型的回覆沒有保存」，而且那句話在回覆落盤之後還留在畫面上（歷史是一次拿的）。
 *
 * **前提一定要先確認**：拿歷史的那一刻畫面是執行中、還沒有回覆——不然「不是舊格式」是這一輪已經收尾之後的平凡答案。
 *
 * **第二刀還沒做**：中途接上之後，進行中的半段回覆在畫面上是接不起來的（它的 `message-start` 在下行開之前就送過了），
 * 回覆要重新整理一次才出現。這一組不斷言那一半，等第二刀補。
 */

import type { ConversationState, Event } from '@nexus/wire';
import { emptyConversation, reduceAll, reduceConversation } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { serveClient } from './fixtures.js';
import { startScriptedServe } from './scripted-serve.js';
import type { ScriptedServe } from './scripted-serve.js';

let served: ScriptedServe | undefined;
afterEach(async () => {
  await served?.close();
  served = undefined;
});

const THREAD = 'reload-mid-turn';

function isRootRunning(event: Event): boolean {
  const data = event.params.data as { event?: string; graph_name?: string } | null;
  return event.method === 'lifecycle' && data?.event === 'running';
}

describe('回覆串流到一半重新整理', () => {
  it('不報舊格式；畫面是執行中、人話在；跑完之後再拿歷史也不是舊格式、回覆在', async () => {
    served = await startScriptedServe([
      { content: '這是一段慢慢吐出來的回覆。', tokenDelayMs: 150 },
    ]);
    const sender = await serveClient(served.running);
    const first = await sender.openEvents(THREAD);
    await sender.runStart(THREAD, '哈囉');
    for (;;) {
      const next = await first.next();
      if (next.done === true) throw new Error('下行在開跑之前就斷了');
      if (isRootRunning(next.value)) break;
    }
    // 讓模型呼叫真的開始：回覆已經在串流，但還沒講完。
    await new Promise((resolve) => setTimeout(resolve, 600));

    // 重新整理：另一個 client 照 web 的順序，先開下行、再拿歷史、折，之後折即時。
    const reloaded = await serveClient(served.running);
    const live = await reloaded.openEvents(THREAD);
    const page = await reloaded.threadHistory(THREAD);
    if (page.kind !== 'ok') throw new Error(`歷史拿不到：${page.message}`);
    let state: ConversationState = reduceAll(emptyConversation(), page.result.events);
    // 前提：拿歷史的那一刻這一輪還在跑、回覆還沒有。
    expect(state.status).toBe('running');
    expect(state.entries.map((entry) => entry.kind)).toEqual(['human']);
    expect(page.result.legacy).toBe(false);
    expect(state.entries[0]).toMatchObject({ kind: 'human', text: '哈囉' });

    for (;;) {
      const next = await live.next();
      if (next.done === true) throw new Error('下行在 root 收尾之前就斷了');
      state = reduceConversation(state, next.value);
      const data = next.value.params.data as { event?: string; graph_name?: string } | null;
      if (
        next.value.method === 'lifecycle' &&
        data?.graph_name === 'root' &&
        (data.event === 'completed' || data.event === 'failed')
      ) {
        break;
      }
    }
    expect(state.status).toBe('idle');

    const after = await reloaded.threadHistory(THREAD);
    if (after.kind !== 'ok') throw new Error(`歷史拿不到：${after.message}`);
    expect(after.result.legacy).toBe(false);
    const settled = reduceAll(emptyConversation(), after.result.events);
    expect(settled.entries.map((entry) => entry.kind)).toEqual(['human', 'ai']);
  }, 30000);
});
