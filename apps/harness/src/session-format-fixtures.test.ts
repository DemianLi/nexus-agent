/**
 * 已出貨格式的夾具，用今天的讀取路徑讀（[#1529](https://github.com/DemianLi/nexus-agent/issues/1529) 第一刀，驗收 B、C、D）。
 *
 * 夾具在 `fixtures/session-format/<名>/`，每份**由那一版出貨的寫入器實際寫出**（產生器在
 * `scripts/session-format-fixtures/generate.ts`，PR 內文貼了每個 tag 的產生指令與 rev 核對），旁邊的 `expected.json`
 * 記事件數、`type` 序列、推回模型的角色序列（逐格標明是哪一版的讀方算的），以及觸發讀方相容分支的那幾條的輸出。
 *
 * 每份複製到暫存目錄再讀：續接會改寫 header 與日誌，夾具本身不能被動到。
 */

import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RELEASED_SESSION_FORMAT_VERSIONS,
  SESSION_FORMAT_CATALOG,
  SESSION_FORMAT_EDGES,
  SESSION_LOG_FORMAT_VERSION,
  SessionFormatUnsupportedError,
  createSessionFormatCatalog,
  currentMessageFeedback,
  interruptedTurnClosers,
  replayConversation,
  resumeClosingInterruptedTurn,
} from '@nexus/core';
import type { SessionEvent, SessionFormatCatalog } from '@nexus/core';

import { historyFrames } from './conversation-history.js';
import { openJsonlSessionStore, parseJsonlSessionBody } from './jsonl-session-store.js';
import { assertSameWorkspaceRoot } from './resume-guards.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/session-format/', import.meta.url));
const REPO = fileURLToPath(new URL('../../../', import.meta.url));

interface Replay {
  readonly computedBy: string;
  readonly kind: 'replayed' | 'unreplayable';
  readonly roles?: readonly string[];
  readonly reason?: string;
}

interface Expected {
  readonly writer: {
    readonly rev: string;
    readonly commit: string;
    readonly formatVersion: number;
    readonly released: boolean;
  };
  readonly sessions: Readonly<
    Record<
      string,
      {
        readonly headerVersion: number;
        readonly eventCount: number;
        readonly types: readonly string[];
        readonly replay: Replay;
      }
    >
  >;
  readonly triggers: readonly {
    readonly edge: number;
    readonly session: string;
    readonly feedback?: readonly unknown[];
    readonly replay?: Omit<Replay, 'computedBy'>;
    readonly closers?: readonly unknown[];
    readonly lifecyclesAfterResume?: readonly unknown[];
    readonly workspaceRootRecorded?: boolean;
    readonly resumeWithWorkspace?: string;
    readonly summaries?: readonly { readonly beforeCall: boolean }[];
    readonly firstHalf?: { readonly eventCount: number; readonly replay: Replay };
  }[];
}

const names = readdirSync(FIXTURES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const expectedOf = (name: string): Expected =>
  JSON.parse(readFileSync(join(FIXTURES, name, 'expected.json'), 'utf8')) as Expected;

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'nexus-session-format-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** 把一份夾具複製到暫存目錄底下的 `as`（省略即夾具名），回傳那個目錄。 */
async function copied(name: string, as = name): Promise<string> {
  const into = join(scratch, as);
  await cp(join(FIXTURES, name), into, { recursive: true });
  return into;
}

function replaySummary(events: readonly SessionEvent[]): Omit<Replay, 'computedBy'> {
  const replay = replayConversation(events);
  return replay.kind === 'replayed'
    ? { kind: 'replayed', roles: replay.messages.map((message) => message.getType()) }
    : { kind: 'unreplayable', reason: replay.reason };
}

function closerSummary(events: readonly SessionEvent[]): unknown[] {
  return interruptedTurnClosers(events).map((event) =>
    event.type === 'turn/end'
      ? { type: event.type, reason: event.data.reason?.kind }
      : { type: event.type },
  );
}

/** 歷史畫面上每一顆收尾 frame 的 `event`。 */
function lifecycles(events: readonly SessionEvent[]): unknown[] {
  return historyFrames(events, 50_000).flatMap((frame) => {
    const { method, params } = frame as {
      method?: string;
      params?: { data?: { event?: unknown } };
    };
    return method === 'lifecycle' ? [params?.data?.event] : [];
  });
}

describe.each(names)('夾具 %s', (name) => {
  const expected = expectedOf(name);
  const ids = Object.keys(expected.sessions).sort();

  it('list 列得出每一條，沒有讀不懂的', async () => {
    const listing = await openJsonlSessionStore({ directory: await copied(name) }).list();
    expect(listing.unreadable).toBe(0);
    expect(listing.sessions.map((session) => session.header.id).sort()).toEqual(ids);
  });

  it.each(ids)('唯讀打開 %s：事件、版本與推回模型的歷史等於 expected.json', async (id) => {
    const session = expected.sessions[id]!;
    const opened = await openJsonlSessionStore({ directory: await copied(name) }).open(id);
    expect(opened.header.version).toBe(session.headerVersion);
    const events = await opened.read();
    expect(events).toHaveLength(session.eventCount);
    expect(events.map((event) => event.type)).toEqual(session.types);
    const { computedBy: _, ...replay } = session.replay;
    expect(replaySummary(events)).toEqual(replay);
  });

  it.each(ids)(
    '續接 %s 之後再寫一筆、收掉，strict 整份重讀：seq 連續、header 是這一版',
    async (id) => {
      const directory = await copied(name);
      const store = openJsonlSessionStore({ directory });
      const resumed = await resumeClosingInterruptedTurn(store, id);
      const next: SessionEvent = {
        type: 'turn/start',
        seq: resumed.events.length,
        time: 1,
        data: { kind: 'message', text: '夾具續寫' },
      };
      await resumed.stored.append([next]);
      await resumed.stored.close();

      const header = JSON.parse(await readFile(join(directory, `${id}.header.json`), 'utf8')) as {
        version: number;
      };
      expect(header.version).toBe(SESSION_LOG_FORMAT_VERSION);
      const { events } = parseJsonlSessionBody(id, await readFile(join(directory, `${id}.jsonl`)), {
        version: header.version,
        recovery: 'strict',
      });
      expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));
      expect(events).toHaveLength(resumed.events.length + 1);
      expect(events.at(-1)?.type).toBe('turn/start');
    },
  );

  for (const trigger of expected.triggers) {
    it(`格式 ${String(trigger.edge)} 的讀方分支（${trigger.session}）照 expected.json`, async () => {
      const opened = await openJsonlSessionStore({ directory: await copied(name) }).open(
        trigger.session,
      );
      const events = await opened.read();
      if (trigger.replay !== undefined) {
        expect(replaySummary(events)).toEqual(trigger.replay);
      }
      if (trigger.workspaceRootRecorded !== undefined) {
        expect(opened.header.workspaceRoot !== undefined).toBe(trigger.workspaceRootRecorded);
        let outcome = 'allowed';
        try {
          assertSameWorkspaceRoot('fixture', trigger.session, opened.header, '/elsewhere');
        } catch (error: unknown) {
          outcome = (error as Error).name;
        }
        expect(outcome).toBe(trigger.resumeWithWorkspace);
      }
      if (trigger.feedback !== undefined) {
        expect(
          currentMessageFeedback(events).map((entry) => ({
            turn: entry.turn,
            target: 'messageId' in entry.item ? 'message' : 'turn',
            rating: entry.item.rating,
          })),
        ).toEqual(trigger.feedback);
      }
      if (trigger.closers !== undefined) {
        expect(closerSummary(events)).toEqual(trigger.closers);
      }
      if (trigger.lifecyclesAfterResume !== undefined) {
        // 經出貨的續接路徑補結，再畫歷史：舊檔形狀（補結接在 end-seed 後面）那一輪只收一次。
        const store = openJsonlSessionStore({ directory: await copied(name, `${name}-resume`) });
        const resumed = await resumeClosingInterruptedTurn(store, trigger.session);
        await resumed.stored.close();
        expect(lifecycles(resumed.events)).toEqual(trigger.lifecyclesAfterResume);
      }
      if (trigger.summaries !== undefined) {
        expect(
          events.flatMap((event) =>
            event.type === 'compaction/summary'
              ? [{ beforeCall: event.data.beforeCall === true }]
              : [],
          ),
        ).toEqual(trigger.summaries);
      }
      if (trigger.firstHalf !== undefined) {
        // 前半由格式 44 的程式碼寫、由它自己推過一次；今天的讀方對同一段要推出一樣的東西。
        const { computedBy: _, ...replay } = trigger.firstHalf.replay;
        expect(replaySummary(events.slice(0, trigger.firstHalf.eventCount))).toEqual(replay);
      }
    });
  }
});

describe('規則（驗收 D）', () => {
  it('每個出過貨的格式版本都有一份由那一版寫的夾具', () => {
    for (const version of RELEASED_SESSION_FORMAT_VERSIONS) {
      const name = `v${String(version)}`;
      expect(names, `缺 fixtures/session-format/${name}/`).toContain(name);
      const { writer } = expectedOf(name);
      expect(writer.formatVersion).toBe(version);
      expect(writer.released).toBe(true);
    }
  });

  it('每條帶 readerBranch 的邊，都有一份比它舊的夾具含觸發它的事件', () => {
    const triggered = new Set(
      names.flatMap((name) => {
        const expected = expectedOf(name);
        return expected.triggers
          .filter((trigger) => expected.writer.formatVersion < trigger.edge)
          .map((trigger) => trigger.edge);
      }),
    );
    const branched = SESSION_FORMAT_EDGES.filter((edge) => edge.readerBranch !== undefined);
    expect(branched.length).toBeGreaterThan(0);
    for (const edge of branched) {
      expect(triggered, `${String(edge.from)}→${String(edge.to)} 沒有夾具觸發`).toContain(edge.to);
    }
  });

  it('readerBranch 指到的檔與行都在', () => {
    for (const edge of SESSION_FORMAT_EDGES) {
      if (edge.readerBranch === undefined) continue;
      const [path, line] = edge.readerBranch.split(':');
      const file = join(REPO, path!);
      expect(existsSync(file), edge.readerBranch).toBe(true);
      expect(readFileSync(file, 'utf8').split('\n').length).toBeGreaterThanOrEqual(Number(line));
    }
  });
});

describe('接線（驗收 B）：13→14 標成 breaking，經出貨的 store 讀', () => {
  const breaking: SessionFormatCatalog = createSessionFormatCatalog(
    SESSION_FORMAT_CATALOG.edges.map((edge) =>
      edge.to === 14 ? { ...edge, kind: 'breaking' as const } : edge,
    ),
  );

  it('v13 的夾具：列表算進讀不懂，唯讀打開與續接都拒讀並說沒有 v13 的遷移', async () => {
    const store = openJsonlSessionStore({ directory: await copied('v13'), catalog: breaking });
    const listing = await store.list();
    expect(listing.unreadable).toBe(Object.keys(expectedOf('v13').sessions).length);
    expect(listing.sessions).toEqual([]);
    for (const open of [() => store.open('cli'), () => store.resume('cli')]) {
      const error: unknown = await open().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SessionFormatUnsupportedError);
      expect((error as Error).message).toContain('沒有 v13 的遷移');
    }
  });

  it('v14 的夾具照常讀回', async () => {
    const store = openJsonlSessionStore({ directory: await copied('v14'), catalog: breaking });
    expect((await store.list()).unreadable).toBe(0);
    const events = await (await store.open('cli')).read();
    expect(events).toHaveLength(expectedOf('v14').sessions['cli']!.eventCount);
  });
});
