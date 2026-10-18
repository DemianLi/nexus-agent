/**
 * 會話日誌的 JSON 快照，走真的 JSONL 後端（[#1526](https://github.com/DemianLi/nexus-agent/issues/1526) 驗收 A、A2、C）。
 *
 * 規則本身的單元測試在 `packages/nexus-core/src/session-log.test.ts`。這一份量的是**接線**：記憶體裡那顆事件、
 * 落盤之後續接讀回來的那顆、以及續接接上 seed（`#adoptSeed`）之後的那顆，三份是同一個東西。
 *
 * - **A**：`JSON.parse` 出來的自有 `"__proto__"` 鍵。改寫前副本用 `copy[key] =` 賦值，走的是原型 setter：
 *   記憶體裡那顆的原型被換掉（而且沒被凍），落盤時鍵消失。
 * - **A2**：同一個鍵經過訊息那條路（`toLoggedMessage` → `append` → 續接 → `fromLoggedMessage`）。這個鍵在進日誌**之前**
 *   就丟了：`@langchain/core@1.2.9` 的 `Serializable.toJSON`（`dist/load/validation.js:85`）用賦值拷 kwargs，`toDict()`
 *   出來的 args 原型被換掉、自有鍵沒了，再經 `JSON.stringify` 就只剩 `{"a":1}`。所以這裡斷言的是日誌真正保證的事：
 *   拿到的那份原型乾淨、沒有繼承來的 `x`、記憶體與磁碟一致。上游丟鍵另開卡。
 * - **C**：深巢狀，前後各夾一則普通事件。改寫前快照是遞迴的，陣列一千多層就 `RangeError`；改寫後快照收得下，
 *   但原生 `JSON.stringify` 對凍過的陣列在 CI（Node 22.23.3 Linux x64）約 2200 層就爆，所以後端寫入前要先拷一份
 *   沒凍過的（`materializeAppendBatch`，照 dsh）。沒有那一刀時這一批永遠寫不出去，**前後兩則也一起落不了盤**，續接
 *   整個讀不到。深度取 3000：Node 22 的原生 `JSON.stringify` 連沒凍過的也是遞迴的，CI 上約 4100 層就拋，再深連改寫後
 *   也寫不出去（落盤端的上限是 #1661）。比對用 `JSON.stringify`：vitest 的 `toEqual` 本身是遞迴的。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AIMessage } from '@langchain/core/messages';
import {
  attachSessionPersistence,
  fromLoggedMessage,
  materializeAppendBatch,
  SessionRegistry,
  toLoggedMessage,
} from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openJsonlSessionStore } from './jsonl-session-store.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-json-snapshot-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 帶一個自有 `"__proto__"` 鍵的物件，形狀同模型或 MCP 回的 JSON。 */
const POLLUTING = '{"__proto__":{"x":1},"a":1}';

/**
 * 開一份新會話、記幾顆、落盤收掉，再從磁碟續接：回寫入時記憶體裡的事件、續接讀回的事件，以及接上 seed 之後的那份日誌。
 *
 * @param write - 往 root 日誌記事件。
 */
async function roundTrip(write: (sessions: SessionRegistry) => void): Promise<{
  readonly live: readonly SessionEvent[];
  readonly stored: readonly SessionEvent[];
  readonly adopted: readonly SessionEvent[];
}> {
  const sessions = new SessionRegistry('root');
  const persistence = attachSessionPersistence(
    sessions,
    openJsonlSessionStore({ directory: dir }),
    {
      warn: () => {},
    },
  );
  write(sessions);
  const live = sessions.root.events;
  await persistence.flush();
  await persistence.dispose();

  const resumed = await openJsonlSessionStore({ directory: dir }).resume('root');
  try {
    // 接上 seed 走的是 `#adoptSeed` 那條快照。
    const adopted = new SessionRegistry('root', { rootSeed: resumed.events }).root.events;
    return { live, stored: resumed.events, adopted };
  } finally {
    await resumed.stored.close();
  }
}

/**
 * 序列化日誌裡的事件：先拷一份沒凍過的再 `JSON.stringify`。凍過的深陣列直接序列化會撞 `RangeError`（V8 走遞迴慢路徑），
 * 後端寫入前也是這樣做（`materializeAppendBatch`）。
 */
function json(events: readonly SessionEvent[]): string[] {
  return materializeAppendBatch(events).map((event) => JSON.stringify(event));
}

/** 每一顆都是同一份 JSON（比位元組，不靠 vitest 的遞迴比對）。 */
function sameJson(a: readonly SessionEvent[], b: readonly SessionEvent[]): void {
  expect(b.length).toBeGreaterThanOrEqual(a.length);
  expect(json(b.slice(0, a.length))).toEqual(json(a));
}

describe('A：自有的 "__proto__" 鍵照樣是自有鍵（#1526）', () => {
  it('記憶體裡那顆、落盤讀回的、接上 seed 的三份都留著這個鍵，原型都沒被換掉', async () => {
    const meta = JSON.parse(POLLUTING) as Record<string, unknown>;
    // 前提：`JSON.parse` 給的是自有鍵，不是原型。
    expect(Object.hasOwn(meta, '__proto__')).toBe(true);

    const { live, stored, adopted } = await roundTrip((sessions) => {
      sessions.root.append('tool/result', { callId: 'c1', isError: false, meta });
    });

    for (const [label, events] of [
      ['記憶體', live],
      ['落盤讀回', stored],
      ['接上 seed', adopted],
    ] as const) {
      const event = events.find((candidate) => candidate.type === 'tool/result');
      const data = (event?.data as { meta: Record<string, unknown> }).meta;
      expect(Object.hasOwn(data, '__proto__'), label).toBe(true);
      expect(Object.getPrototypeOf(data), label).toBe(Object.prototype);
      expect(data['x'], label).toBeUndefined();
      expect(data['a'], label).toBe(1);
    }
    sameJson(live, stored);
  });
});

describe('A2：經過訊息那條路（#1526）', () => {
  it('工具呼叫參數帶 "__proto__"：記下、續接、推回訊息之後 args 的原型乾淨、沒有繼承來的鍵，記憶體與磁碟一致', async () => {
    const ai = new AIMessage({
      id: 'm1',
      content: '',
      tool_calls: [
        { id: 'c1', name: 'probe', args: JSON.parse(POLLUTING) as Record<string, unknown> },
      ],
    });
    const { live, stored } = await roundTrip((sessions) => {
      sessions.root.append('assistant/message', { message: toLoggedMessage(ai) });
    });
    for (const [label, events] of [
      ['記憶體', live],
      ['落盤讀回', stored],
    ] as const) {
      const event = events.find((candidate) => candidate.type === 'assistant/message');
      const message = fromLoggedMessage(
        (event?.data as { message: Parameters<typeof fromLoggedMessage>[0] }).message,
      ) as AIMessage;
      const args = message.tool_calls?.[0]?.args as Record<string, unknown>;
      expect(Object.getPrototypeOf(args), label).toBe(Object.prototype);
      expect(args['x'], label).toBeUndefined();
      expect(args['a'], label).toBe(1);
    }
    sameJson(live, stored);
  });
});

describe('C：深巢狀不撞 RangeError（#1526）', () => {
  const DEPTH = 3_000;

  function nestedObject(depth: number): unknown {
    let value: unknown = 'leaf';
    for (let level = 0; level < depth; level++) value = { next: value };
    return value;
  }

  function nestedArray(depth: number): unknown {
    let value: unknown = 'leaf';
    for (let level = 0; level < depth; level++) value = [value];
    return value;
  }

  function nestedMixed(depth: number): unknown {
    let value: unknown = 'leaf';
    for (let level = 0; level < depth; level++) value = level % 2 ? { next: value } : [value];
    return value;
  }

  it('前後各一則普通事件，中間夾 3000 層物件、陣列與交錯巢狀：全部收得下，續接每一則都讀得回來且相同', async () => {
    const deep = [
      ['deep-object', nestedObject(DEPTH)],
      ['deep-array', nestedArray(DEPTH)],
      ['deep-mixed', nestedMixed(DEPTH)],
    ] as const;
    const { live, stored, adopted } = await roundTrip((sessions) => {
      sessions.root.append('tool/result', { callId: 'before', isError: false });
      for (const [callId, meta] of deep) {
        sessions.root.append('tool/result', { callId, isError: false, meta });
      }
      sessions.root.append('tool/result', { callId: 'after', isError: false });
    });
    const callIds = ['before', ...deep.map(([callId]) => callId), 'after'];
    for (const [label, events] of [
      ['記憶體', live],
      ['落盤讀回', stored],
      ['接上 seed', adopted],
    ] as const) {
      expect(
        events
          .filter((event) => event.type === 'tool/result')
          .map((event) => (event.data as { callId: string }).callId),
        label,
      ).toEqual(callIds);
    }
    const metas = materializeAppendBatch(live)
      .filter((event) => event.type === 'tool/result')
      .map((event) => (event.data as { meta?: unknown }).meta)
      .slice(1, -1);
    expect(metas.map((meta) => JSON.stringify(meta))).toEqual(
      deep.map(([, meta]) => JSON.stringify(meta)),
    );
    sameJson(live, stored);
    sameJson(live, adopted);
  });
});
