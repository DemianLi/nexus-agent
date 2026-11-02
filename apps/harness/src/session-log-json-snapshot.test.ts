/**
 * 會話日誌的 JSON 快照，走真的 JSONL 後端（[#1526](https://github.com/DemianLi/nexus-agent/issues/1526) 驗收 A、A2、C）。
 *
 * 規則本身的單元測試在 `packages/nexus-core/src/session-log.test.ts`。這一份量的是**接線**：記憶體裡那顆事件、
 * 落盤之後續接讀回來的那顆、以及續接接上 seed（`#adoptSeed`）之後的那顆，三份是同一個東西。
 *
 * - **A**：`JSON.parse` 出來的自有 `"__proto__"` 鍵。改寫前副本用 `copy[key] =` 賦值，走的是原型 setter：
 *   記憶體裡那顆的原型被換掉（而且沒被凍），落盤時鍵消失。
 * - **A2**：同一個鍵經過訊息那條路（`toLoggedMessage` → `append` → 續接 → `fromLoggedMessage`）。#1526 時這個鍵在進日誌**之前**
 *   就丟了：`@langchain/core@1.2.9` 的 `Serializable.toJSON`（`dist/load/validation.js:85`）用賦值拷 kwargs，`toDict()`
 *   出來的 args 原型被換掉、自有鍵沒了，所以當時只能斷言「原型乾淨、沒有繼承來的 `x`」。#1660 起 `toLoggedMessage`
 *   自己取欄位，這裡改回卡上原本的斷言：續接讀回的 args 仍有**自有**的 `"__proto__"` 鍵，內容同模型送的，記憶體與磁碟一致。
 * - **C**：深巢狀，前後各夾一則普通事件。比對用 `JSON.stringify`：vitest 的 `toEqual` 本身是遞迴的。
 *   - **C1（舊日誌）**：寫入那一關有深度上限（`SESSION_EVENT_MAX_DEPTH`，#1661），但上限之前寫下的日誌可能更深。
 *     磁碟上一份 3000 層的舊日誌，續接讀回、接上 seed 都照收，讀方不設限。深度取 3000：原生 `JSON.stringify` 對凍過的
 *     陣列在 CI（Node 22.23.3 Linux x64）約 2200 層就爆，沒凍過的約 4100 層，夾在中間才驗得到「凍過的那份要先拷」。
 *   - **C2（超過上限）**：Node 22 的原生 `JSON.stringify` 連沒凍過的也是遞迴的，CI（22.19.0 與 22.23.3）上 4104 層就
 *     寫不出去；寫入失敗那一批留在佇列頭，**前後的事件也一起落不了盤**。5000 層那一則在 `append` 就拒，前後照常。
 *   - **C3（剛好上限）**：上限值本身在真的後端上寫得出去、讀得回來。
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AIMessage } from '@langchain/core/messages';
import {
  attachSessionPersistence,
  fromLoggedMessage,
  SESSION_EVENT_MAX_DEPTH,
  SessionRegistry,
  snapshotJsonValue,
  toLoggedMessage,
} from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openJsonlSessionStore } from './jsonl-session-store.js';
import { sessionsUnder } from './session-files.fixture.js';

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
 * 拷一份沒凍過的：凍過的深陣列直接 `JSON.stringify` 會撞 `RangeError`（V8 走遞迴慢路徑）。後端寫入前也是這樣做
 * （`materializeAppendBatch`），但那支有寫入的深度上限，比對舊日誌要用不設限的那支。
 */
function thawed(events: readonly SessionEvent[]): readonly SessionEvent[] {
  return snapshotJsonValue(events, '比對') as readonly SessionEvent[];
}

/** 序列化日誌裡的事件：先拷一份沒凍過的再 `JSON.stringify`。 */
function json(events: readonly SessionEvent[]): string[] {
  return thawed(events).map((event) => JSON.stringify(event));
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

describe('A2：經過訊息那條路（#1526、#1660）', () => {
  it('工具呼叫參數帶 "__proto__"：記下、續接、推回訊息之後 args 仍有自有的 "__proto__" 鍵，原型乾淨，記憶體與磁碟一致', async () => {
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
      expect(Object.hasOwn(args, '__proto__'), label).toBe(true);
      expect(Object.getOwnPropertyDescriptor(args, '__proto__')?.value, label).toEqual({ x: 1 });
      expect(Object.getPrototypeOf(args), label).toBe(Object.prototype);
      expect(args['x'], label).toBeUndefined();
      expect(args['a'], label).toBe(1);
    }
    sameJson(live, stored);
  });
});

describe('C：深巢狀（#1526、#1661）', () => {
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

  /** 各份的 `tool/result` 依序是哪幾個 callId。 */
  function callIdsOf(events: readonly SessionEvent[]): string[] {
    return events
      .filter((event) => event.type === 'tool/result')
      .map((event) => (event.data as { callId: string }).callId);
  }

  it('C1：上限之前寫下的舊日誌，中間夾 3000 層物件、陣列與交錯巢狀：續接讀回、接上 seed 都照收且相同', async () => {
    const DEPTH = 3_000;
    const deep = [
      ['deep-object', nestedObject(DEPTH)],
      ['deep-array', nestedArray(DEPTH)],
      ['deep-mixed', nestedMixed(DEPTH)],
    ] as const;
    // 今天的 `append` 收不下 3000 層，舊日誌只能直接造在磁碟上：先寫佔位字串，再把那一行換成深的。
    const sessions = new SessionRegistry('root');
    const persistence = attachSessionPersistence(
      sessions,
      openJsonlSessionStore({ directory: dir }),
      { warn: () => {} },
    );
    sessions.root.append('tool/result', { callId: 'before', isError: false });
    for (const [callId] of deep) {
      sessions.root.append('tool/result', {
        callId,
        isError: false,
        meta: `placeholder:${callId}`,
      });
    }
    sessions.root.append('tool/result', { callId: 'after', isError: false });
    await persistence.flush();
    await persistence.dispose();
    // 只有 root 那一份；經 `session-files.fixture.ts` 找（#1868），改的是它的日誌原文。
    const [session, ...others] = await sessionsUnder(dir);
    expect(others).toEqual([]);
    const path = session!.logPath;
    let text = await readFile(path, 'utf8');
    for (const [callId, meta] of deep) {
      const placeholder = JSON.stringify(`placeholder:${callId}`);
      expect(text.split(placeholder)).toHaveLength(2);
      text = text.replace(placeholder, JSON.stringify(meta));
    }
    await writeFile(path, text);

    const resumed = await openJsonlSessionStore({ directory: dir }).resume('root');
    try {
      const stored = resumed.events;
      // 接上 seed 走的是 `#adoptSeed` 那條快照，不設上限。
      const adopted = new SessionRegistry('root', { rootSeed: stored }).root.events;
      const callIds = ['before', ...deep.map(([callId]) => callId), 'after'];
      expect(callIdsOf(stored)).toEqual(callIds);
      expect(callIdsOf(adopted)).toEqual(callIds);
      const metas = thawed(adopted)
        .filter((event) => event.type === 'tool/result')
        .map((event) => (event.data as { meta?: unknown }).meta)
        .slice(1, -1);
      expect(metas.map((meta) => JSON.stringify(meta))).toEqual(
        deep.map(([, meta]) => JSON.stringify(meta)),
      );
      sameJson(stored, adopted);
    } finally {
      await resumed.stored.close();
    }
  });

  it('C2：前後各一則普通事件，中間一則 5000 層：那一則在 append 就拒，前後照常落盤、續接讀得回來', async () => {
    let rejected: unknown;
    const { live, stored, adopted } = await roundTrip((sessions) => {
      sessions.root.append('tool/result', { callId: 'before', isError: false });
      try {
        sessions.root.append('tool/result', {
          callId: 'deep',
          isError: false,
          meta: nestedObject(5_000),
        });
      } catch (error: unknown) {
        rejected = error;
      }
      sessions.root.append('tool/result', { callId: 'after', isError: false });
    });
    // 先看落盤：沒有上限時，Node 22 上這一批寫不出去，`flush` 就拋了，走不到這裡。
    for (const [label, events] of [
      ['記憶體', live],
      ['落盤讀回', stored],
      ['接上 seed', adopted],
    ] as const) {
      expect(callIdsOf(events), label).toEqual(['before', 'after']);
    }
    sameJson(live, stored);
    expect(rejected).toBeInstanceOf(TypeError);
    expect((rejected as TypeError).message).toContain(`超過上限 ${SESSION_EVENT_MAX_DEPTH} 層`);
  });

  it(`C3：剛好 ${SESSION_EVENT_MAX_DEPTH} 層的物件、陣列與交錯巢狀：收得下、落得了盤、續接讀得回來且相同`, async () => {
    // 上限值本身在真的後端上要安全：`data` 本身算第 1 層，所以 `meta` 包上限減一層。
    const levels = SESSION_EVENT_MAX_DEPTH - 1;
    const deep = [
      ['edge-object', nestedObject(levels)],
      ['edge-array', nestedArray(levels)],
      ['edge-mixed', nestedMixed(levels)],
    ] as const;
    const { live, stored, adopted } = await roundTrip((sessions) => {
      for (const [callId, meta] of deep) {
        sessions.root.append('tool/result', { callId, isError: false, meta });
      }
    });
    const callIds = deep.map(([callId]) => callId);
    for (const [label, events] of [
      ['記憶體', live],
      ['落盤讀回', stored],
      ['接上 seed', adopted],
    ] as const) {
      expect(callIdsOf(events), label).toEqual(callIds);
    }
    sameJson(live, stored);
    sameJson(live, adopted);
  });
});
