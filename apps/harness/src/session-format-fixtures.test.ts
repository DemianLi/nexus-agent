/**
 * 已出貨格式的夾具，用今天的讀取路徑讀（[#1529](https://github.com/DemianLi/nexus-agent/issues/1529) 第一刀，驗收 B、C、D）。
 *
 * 夾具在 `fixtures/session-format/<名>/`，每份**由那一版出貨的寫入器實際寫出**（產生器在
 * `scripts/session-format-fixtures/generate.ts`，PR 內文貼了每個 tag 的產生指令與 rev 核對），旁邊的 `expected.json`
 * 記事件數、`type` 序列、推回模型的角色序列（逐格標明是哪一版的讀方算的），以及觸發讀方相容分支的那幾條的輸出。
 *
 * 每份複製到暫存目錄再讀：續接會把舊兩檔遷成這一版的世代檔、舊 header 換成墓碑，夾具本身不能被動到。
 */

import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFeedbackService } from '@nexus/plugin-feedback';
import { deriveBrowserTimeZoneContext } from '@nexus/plugin-time-context';
import { applyTrajectory, initialTrajectory, viewTrajectory } from '@nexus/plugin-trajectory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  approvalPolicyOnResume,
  RELEASED_SESSION_FORMAT_VERSIONS,
  SESSION_FORMAT_CATALOG,
  SESSION_FORMAT_EDGES,
  SESSION_LOG_FORMAT_VERSION,
  SessionCorruptionError,
  SessionFormatUnsupportedError,
  createSessionFormatCatalog,
  generationLogFilename,
  parseGenerationLogFilename,
  currentMessageFeedback,
  interruptedTurnClosers,
  isSubagentSessionHeader,
  pageContextOfBlock,
  recordedApprovalPolicy,
  replayConversation,
  resumeClosingInterruptedTurn,
  SessionLog,
  SessionSeq,
} from '@nexus/core';
import type { SessionEvent, SessionFormatCatalog } from '@nexus/core';

import { historyFrames } from './conversation-history.js';
import { imageOffloadCalls } from './image-offload-calls.fixture.js';
import type { ImageOffloadCall } from './image-offload-calls.fixture.js';
import { attemptCalls, requestSnapshotCalls } from './request-snapshot-calls.fixture.js';
import type { AttemptCall, RequestSnapshotCall } from './request-snapshot-calls.fixture.js';
import { ratingsByTurn } from './eval/session-scan.js';
import { MEMORY_DURABILITY } from './feedback.fixture.js';
import {
  legacyTwoFilePathsIn,
  openJsonlSessionStore,
  parseJsonlSessionBody,
  sessionPathsIn,
} from './jsonl-session-store.js';
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
    readonly typesAfterResume?: readonly string[];
    readonly workspaceRootRecorded?: boolean;
    readonly resumeWithWorkspace?: string;
    readonly summaries?: readonly { readonly beforeCall: boolean }[];
    readonly firstHalf?: { readonly eventCount: number; readonly replay: Replay };
    readonly approvalPolicyRecorded?: boolean;
    readonly approvalPolicyOnResume?: string;
    readonly browserTimeZone?: unknown;
    readonly imageOffloadCalls?: readonly ImageOffloadCall[];
    readonly parentSession?: string;
    readonly originRecorded?: boolean;
    readonly subagent?: boolean;
    readonly profile?: string;
    readonly pageContexts?: readonly (string | null)[];
    readonly snapshotCalls?: readonly RequestSnapshotCall[];
    readonly attemptCalls?: readonly AttemptCall[];
    /** 寫入器自己的 `replayConversation` 推出的每一則人話內容（`JSON.stringify` 過）。 */
    readonly ownHumanContents?: readonly string[];
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

/** 推回的對話歷史裡，每一則人話附的畫面情境（`label`）；沒附的是 `null`。 */
function humanPageContexts(events: readonly SessionEvent[]): (string | null)[] {
  const replay = replayConversation(events);
  if (replay.kind !== 'replayed') throw new Error(`推不回對話歷史：${replay.reason}`);
  return replay.messages
    .filter((message) => message.getType() === 'human')
    .map((message) =>
      Array.isArray(message.content)
        ? (message.content.map(pageContextOfBlock).find((context) => context !== undefined)
            ?.label ?? null)
        : null,
    );
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

describe('格式 52 的日誌沒有停止原因（#1847）', () => {
  it('歷史、重放與軌跡都走得通，線上不出現這幾個鍵', async () => {
    const id = Object.keys(expectedOf('v52').sessions)[0]!;
    const store = openJsonlSessionStore({ directory: await copied('v52') });
    const events = await (await store.open(id, 'read')).read();
    // 夾具裡沒有結算通知與中止：接上那一版寫得出的形狀，兩個都沒有 `cause`。
    const last = events.at(-1)!;
    const appended = (type: SessionEvent['type'], data: unknown, at: number) =>
      ({ ...last, seq: last.seq + at, type, data }) as SessionEvent;
    const reply = events.findLast((event) => event.type === 'assistant/message')!;
    const all = [
      ...events,
      appended(
        'turn/start',
        {
          kind: 'subagent-settled',
          text: 'stopped',
          summary: 'stopped',
          reason: 'aborted',
          senderSessionId: 'sub',
        },
        1,
      ),
      appended('assistant/message', reply.data, 2),
      appended('turn/end', {}, 3),
      appended('turn/start', { kind: 'message', text: '再一句' }, 4),
      appended('assistant/message', reply.data, 5),
      appended('turn/end', { reason: { kind: 'aborted' } }, 6),
    ];
    expect(replayConversation(all).kind).toBe('replayed');
    const trajectory = viewTrajectory(
      all.reduce((state, event) => applyTrajectory(state, event), initialTrajectory()),
    );
    expect(trajectory.turns.at(-1)?.end).toBe('aborted');
    const wire = JSON.stringify([historyFrames(all, 50_000), trajectory]);
    expect(wire).toContain('subagent/settle-notice');
    expect(wire).not.toMatch(/"(?:cause|stopCause|endCause)":/u);
  });
});

describe.each(names)('夾具 %s', (name) => {
  const expected = expectedOf(name);
  const ids = Object.keys(expected.sessions).sort();
  /** 夾具裡這條會話最新的世代檔版號；只有舊兩檔是 `undefined`。 */
  const generationOf = (id: string): number | undefined => {
    const { sessionDirectory } = sessionPathsIn(join(FIXTURES, name), id);
    const versions = existsSync(sessionDirectory)
      ? readdirSync(sessionDirectory)
          .map(parseGenerationLogFilename)
          .filter((version) => version !== undefined)
      : [];
    return versions.length === 0 ? undefined : Math.max(...versions);
  };
  const twoFileIds = ids.filter((id) => generationOf(id) === undefined);
  const generationIds = ids.filter((id) => generationOf(id) === SESSION_LOG_FORMAT_VERSION);
  const olderGenerationIds = ids.filter((id) => {
    const version = generationOf(id);
    return version !== undefined && version < SESSION_LOG_FORMAT_VERSION;
  });

  it('list 列得出每一條，沒有讀不懂的', async () => {
    const listing = await openJsonlSessionStore({ directory: await copied(name) }).list();
    expect(listing.unreadable).toBe(0);
    expect(listing.sessions.map((session) => session.header.id).sort()).toEqual(ids);
    // 列出來的 header 轉譯成這一版，原版號另交（#1856）。
    for (const session of listing.sessions) {
      expect(session.header.version).toBe(SESSION_LOG_FORMAT_VERSION);
      expect(session.storedFormatVersion).toBe(expected.sessions[session.header.id]!.headerVersion);
    }
  });

  it.each(ids)('唯讀打開 %s：事件、版本與推回模型的歷史等於 expected.json', async (id) => {
    const session = expected.sessions[id]!;
    const opened = await openJsonlSessionStore({ directory: await copied(name) }).open(id, 'read');
    // header 轉譯成這一版，磁碟上那個版號另交（#1856，照 dsh `types.ts:96-100` 加上登記的偏離）。
    expect(opened.header.version).toBe(SESSION_LOG_FORMAT_VERSION);
    expect(opened.storedFormatVersion).toBe(session.headerVersion);
    const events = await opened.read();
    expect(events).toHaveLength(session.eventCount);
    expect(events.map((event) => event.type)).toEqual(session.types);
    const { computedBy: _, ...replay } = session.replay;
    expect(replaySummary(events)).toEqual(replay);
  });

  it.each(twoFileIds)(
    '續接 %s 之後再寫一筆、收掉：遷成這一版的世代檔，strict 整份重讀 seq 連續；舊日誌一個位元組都沒動、舊 header 換成墓碑',
    async (id) => {
      const directory = await copied(name);
      const legacy = legacyTwoFilePathsIn(directory, id);
      const source = await readFile(legacy.log);
      const store = openJsonlSessionStore({ directory });
      const resumed = await resumeClosingInterruptedTurn(store, id);
      expect(resumed.header.version).toBe(SESSION_LOG_FORMAT_VERSION);
      expect(resumed.storedFormatVersion).toBe(expected.sessions[id]!.headerVersion);
      const next: SessionEvent = {
        type: 'turn/start',
        seq: SessionSeq(resumed.events.length),
        time: 1,
        data: { kind: 'message', text: '夾具續寫' },
      };
      await resumed.stored.append([next]);
      await resumed.stored.close();

      expect(await readFile(legacy.log)).toEqual(source);
      const generation = await readFile(sessionPathsIn(directory, id).log);
      const newline = generation.indexOf(0x0a);
      const headerLine = generation.toString('utf8', 0, newline);
      const { migratedFrom, ...rest } = JSON.parse(headerLine) as Record<string, unknown>;
      expect(rest).toMatchObject({ type: 'session', id, version: SESSION_LOG_FORMAT_VERSION });
      const { bytes, acceptedBytes, sha256 } = migratedFrom as Record<string, number | string>;
      expect(bytes).toBe(source.byteLength);
      expect(acceptedBytes).toBeLessThanOrEqual(source.byteLength);
      const prefix = source.subarray(0, Number(acceptedBytes));
      expect(sha256).toBe(createHash('sha256').update(prefix).digest('hex'));
      // 新世代的本文從已接受的前綴原樣開頭，續寫接在後面。
      expect(generation.subarray(newline + 1, newline + 1 + prefix.byteLength).equals(prefix)).toBe(
        true,
      );
      // 墓碑是同一份 header 行，只少了遷移來源。
      expect(JSON.parse(await readFile(legacy.header, 'utf8'))).toEqual(rest);
      const { events } = parseJsonlSessionBody(id, generation.subarray(newline + 1), {
        version: SESSION_LOG_FORMAT_VERSION,
        recovery: 'strict',
      });
      expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));
      expect(events).toHaveLength(resumed.events.length + 1);
      expect(events.at(-1)?.type).toBe('turn/start');
    },
  );

  it.each(generationIds)(
    '續接 %s 之後再寫一筆、收掉：接在同一份世代檔後面，不遷移；原本的位元組與舊路徑的墓碑都沒動',
    async (id) => {
      const directory = await copied(name);
      const paths = sessionPathsIn(directory, id);
      const legacy = legacyTwoFilePathsIn(directory, id);
      const source = await readFile(paths.log);
      const tombstone = await readFile(legacy.header);
      const store = openJsonlSessionStore({ directory });
      const resumed = await resumeClosingInterruptedTurn(store, id);
      expect(resumed.storedFormatVersion).toBe(expected.sessions[id]!.headerVersion);
      const next: SessionEvent = {
        type: 'turn/start',
        seq: SessionSeq(resumed.events.length),
        time: 1,
        data: { kind: 'message', text: '夾具續寫' },
      };
      await resumed.stored.append([next]);
      await resumed.stored.close();

      const generation = await readFile(paths.log);
      expect(generation.subarray(0, source.byteLength).equals(source)).toBe(true);
      expect(await readFile(legacy.header)).toEqual(tombstone);
      const newline = generation.indexOf(0x0a);
      const header = JSON.parse(generation.toString('utf8', 0, newline)) as Record<string, unknown>;
      expect(header).not.toHaveProperty('migratedFrom');
      const { events } = parseJsonlSessionBody(id, generation.subarray(newline + 1), {
        version: SESSION_LOG_FORMAT_VERSION,
        recovery: 'strict',
      });
      expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));
      expect(events).toHaveLength(resumed.events.length + 1);
    },
  );

  it.each(olderGenerationIds)(
    '續接 %s 之後再寫一筆、收掉：舊世代遷成這一版的世代檔，本文原樣開頭；舊世代、舊路徑一個位元組都沒動',
    async (id) => {
      const directory = await copied(name);
      const { sessionDirectory } = sessionPathsIn(directory, id);
      const older = join(sessionDirectory, generationLogFilename(generationOf(id)!));
      const legacy = legacyTwoFilePathsIn(directory, id);
      const source = await readFile(older);
      const legacyHeader = existsSync(legacy.header) ? await readFile(legacy.header) : undefined;
      const legacyLog = existsSync(legacy.log) ? await readFile(legacy.log) : undefined;
      const store = openJsonlSessionStore({ directory });
      const resumed = await resumeClosingInterruptedTurn(store, id);
      expect(resumed.header.version).toBe(SESSION_LOG_FORMAT_VERSION);
      expect(resumed.storedFormatVersion).toBe(expected.sessions[id]!.headerVersion);
      const next: SessionEvent = {
        type: 'turn/start',
        seq: SessionSeq(resumed.events.length),
        time: 1,
        data: { kind: 'message', text: '夾具續寫' },
      };
      await resumed.stored.append([next]);
      await resumed.stored.close();

      expect(await readFile(older)).toEqual(source);
      if (legacyHeader !== undefined) expect(await readFile(legacy.header)).toEqual(legacyHeader);
      if (legacyLog !== undefined) expect(await readFile(legacy.log)).toEqual(legacyLog);
      const generation = await readFile(sessionPathsIn(directory, id).log);
      const newline = generation.indexOf(0x0a);
      const header = JSON.parse(generation.toString('utf8', 0, newline)) as Record<string, unknown>;
      // 世代對世代不記遷移來源（只有從舊兩檔遷的才記），其餘各格照舊、只換版號。
      const sourceNewline = source.indexOf(0x0a);
      const { migratedFrom: _, ...sourceHeader } = JSON.parse(
        source.toString('utf8', 0, sourceNewline),
      ) as Record<string, unknown>;
      expect(header).toEqual({ ...sourceHeader, version: SESSION_LOG_FORMAT_VERSION });
      const body = source.subarray(sourceNewline + 1);
      expect(generation.subarray(newline + 1, newline + 1 + body.byteLength).equals(body)).toBe(
        true,
      );
      const { events } = parseJsonlSessionBody(id, generation.subarray(newline + 1), {
        version: SESSION_LOG_FORMAT_VERSION,
        recovery: 'strict',
      });
      expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));
      expect(events).toHaveLength(resumed.events.length + 1);
    },
  );

  for (const trigger of expected.triggers) {
    it(`格式 ${String(trigger.edge)} 的讀方分支（${trigger.session}）照 expected.json`, async () => {
      const opened = await openJsonlSessionStore({ directory: await copied(name) }).open(
        trigger.session,
        'read',
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
            ...('messageId' in entry.item
              ? { target: 'message', messageId: entry.item.messageId }
              : { target: 'turn' }),
            rating: entry.item.rating,
          })),
        ).toEqual(trigger.feedback);
        // 驗收 H（#1606）：同一份舊日誌經插件的 `list`（讀之前先過 schema）照樣讀得出來——回放驗證不能把出貨過的舊格式當成壞掉。
        // 對不到回覆的舊評分不回（#1850），所以只比對得到回覆的。
        const listed = await createFeedbackService(
          { maxNoteBytes: 8192 },
          () => MEMORY_DURABILITY,
        ).list(new SessionLog(trigger.session, { seed: events }));
        expect(
          listed.ok && listed.value.items.map((item) => [item.messageId, item.rating]),
        ).toEqual(
          (trigger.feedback as { target: string; messageId?: string; rating: string }[])
            .filter((entry) => entry.target === 'message')
            .map((entry) => [entry.messageId, entry.rating]),
        );
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
      if (trigger.typesAfterResume !== undefined) {
        // 今天的續接在舊寫入器留下的 end-seed 後面補結（輪已由新一輪收掉的不補），再唯讀打開一次：讀盤的關係驗證要讀得過（#1597）。
        const store = openJsonlSessionStore({ directory: await copied(name, `${name}-reread`) });
        const resumed = await resumeClosingInterruptedTurn(store, trigger.session);
        await resumed.stored.close();
        const reread = await (await store.open(trigger.session, 'read')).read();
        expect(reread.map((event) => event.type)).toEqual(trigger.typesAfterResume);
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
      if (trigger.approvalPolicyOnResume !== undefined) {
        expect(recordedApprovalPolicy(events) !== undefined).toBe(trigger.approvalPolicyRecorded);
        expect(approvalPolicyOnResume(events)).toBe(trigger.approvalPolicyOnResume);
      }
      if (trigger.subagent !== undefined) {
        expect(opened.header.parentSession).toBe(trigger.parentSession);
        expect(opened.header.origin !== undefined).toBe(trigger.originRecorded);
        expect(isSubagentSessionHeader(opened.header)).toBe(trigger.subagent);
      }
      if (trigger.pageContexts !== undefined) {
        expect(opened.header.profile).toBe(trigger.profile);
        expect(humanPageContexts(events)).toEqual(trigger.pageContexts);
      }
      if (trigger.ownHumanContents !== undefined) {
        // 點名提示照日誌上的 `mention.tool` 組字，缺席照 `task` 的字：今天重放出來的人話要跟 55 自己重放出來的（＝55 送給模型的）逐位元組相同（#2649）。
        const replay = replayConversation(events);
        if (replay.kind !== 'replayed') throw new Error(`推不回對話歷史：${replay.reason}`);
        expect(
          replay.messages
            .filter((message) => message.getType() === 'human')
            .map((message) => JSON.stringify(message.content)),
        ).toEqual(trigger.ownHumanContents);
      }
      if (trigger.browserTimeZone !== undefined) {
        expect(deriveBrowserTimeZoneContext(events)).toEqual(trigger.browserTimeZone);
      }
      // 打得開就是讀盤的關係驗證（55 起的快照與嘗試位置規則）讀得過；歸屬再逐筆比。
      if (trigger.snapshotCalls !== undefined) {
        expect(requestSnapshotCalls(events)).toEqual(trigger.snapshotCalls);
      }
      if (trigger.attemptCalls !== undefined) {
        expect(attemptCalls(events)).toEqual(trigger.attemptCalls);
      }
      if (trigger.imageOffloadCalls !== undefined) {
        const calls = imageOffloadCalls(events);
        expect(calls).toEqual(trigger.imageOffloadCalls);
        // 決定記在 `model/start` 之後的那次（#2354；帶這一欄的觸發只產出這一種位置）：只有那一次推導與送出不同，下一次起每次都一樣。
        const starts = events.filter((event) => event.type === 'model/start');
        const offload = events.find((event) => event.type === 'image/offload')!;
        const late = starts.filter((start) => start.seq < offload.seq).length - 1;
        expect(late).toBeGreaterThanOrEqual(0);
        expect(
          calls.map((call) => JSON.stringify(call.derived) !== JSON.stringify(call.sent)),
        ).toEqual(calls.map((_, index) => index === late));
      }
    });
  }
});

describe('輪已收的 end-seed 之後，配舊呼叫的 tool/result 拒開（#1597）', () => {
  // 停在核准點的那一輪收了、呼叫沒配到；跨重啟再也配不到（`session-relationships.ts` 的 end-seed）。這條只讓檢查更嚴，
  // 拿掉它任何合法日誌都不會紅，所以用 v0.5.19 寫的前段接一顆不該有的結果守。
  it('paused-resumed 接一顆 callId 對到 end-seed 前那顆呼叫的 tool/result：唯讀打開拒成 SessionCorruptionError', async () => {
    const store = openJsonlSessionStore({ directory: await copied('v14-carried-turn') });
    const resumed = await store.resume('paused-resumed');
    await resumed.stored.append([
      {
        type: 'tool/result',
        seq: SessionSeq(resumed.events.length),
        time: 1,
        data: { callId: 'paused-resumed-call', isError: false },
      },
    ]);
    await resumed.stored.close();

    const opened = await store.open('paused-resumed', 'read');
    const caught: unknown = await opened.read().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(SessionCorruptionError);
    expect((caught as Error).message).toContain('tool-result-without-call');
  });
});

describe('對不到回覆的舊評分（#1850）：評分清單不回，離線掃描照算', () => {
  const service = createFeedbackService({ maxNoteBytes: 8192 }, () => MEMORY_DURABILITY);

  async function fixtureEvents(name: string): Promise<readonly SessionEvent[]> {
    const opened = await openJsonlSessionStore({ directory: await copied(name) }).open(
      'cli',
      'read',
    );
    return opened.read();
  }

  async function listedOf(events: readonly SessionEvent[]): Promise<unknown> {
    const listed = await service.list(new SessionLog('cli', { seed: events }));
    return listed.ok && listed.value.items.map((item) => [item.messageId, item.rating]);
  }

  function scannedOf(events: readonly SessionEvent[]): unknown[] {
    return [...ratingsByTurn(events)].map(([turn, item]) => [
      turn,
      'messageId' in item ? item.messageId : null,
      item.rating,
    ]);
  }

  it('v8：日誌沒有記回覆，那一輪的評分只有掃描讀得到', async () => {
    const events = await fixtureEvents('v8');
    expect(await listedOf(events)).toEqual([]);
    expect(scannedOf(events)).toEqual([[0, null, 'negative']]);
  });

  it('v9：回覆沒有 id 的那一輪不回，回覆帶 id 的那一輪照回', async () => {
    const events = await fixtureEvents('v9');
    expect(await listedOf(events)).toEqual([['fixture-reply', 'positive']]);
    expect(scannedOf(events)).toEqual([
      [0, null, 'negative'],
      [17, 'fixture-reply', 'positive'],
    ]);
  });
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

  it('readerBranch 指到的那一行就是那條分支：檔在、行裡有它的錨點', () => {
    // 邊的 `to` → 那一行一定有的字串。改了讀方、行號漂了，這裡紅；加了新的 readerBranch 沒登錨點，也紅。
    const anchors = new Map<number, string>([
      [9, 'if (logged === undefined) {'],
      [10, "if ('messageId' in stored) {"],
      [13, 'if (header.workspaceRoot === undefined) return;'],
      [29, 'if (open) {'],
      [33, "if (turnOpen || suspended) close(event.time, { event: 'completed' });"],
      [34, "return recordedApprovalPolicy(events) ?? 'ask';"],
      [45, 'event.data.beforeCall === true ? messagesBefore : messagesBefore + 1'],
      [51, "header.origin === 'subagent' || (header.parentSession !== undefined"],
      [52, "if (site.layout === 'two-file') {"],
      [55, "if (field(event, 'modelCall') !== undefined) {"],
      [56, "const tool = mention.tool ?? 'task';"],
    ]);
    const branched = SESSION_FORMAT_EDGES.filter((edge) => edge.readerBranch !== undefined);
    expect(branched.map((edge) => edge.to)).toEqual([...anchors.keys()]);
    for (const edge of branched) {
      const [path, line] = edge.readerBranch!.split(':');
      const file = join(REPO, path!);
      expect(existsSync(file), edge.readerBranch).toBe(true);
      const text = readFileSync(file, 'utf8').split('\n')[Number(line) - 1];
      expect(text, edge.readerBranch).toContain(anchors.get(edge.to));
    }
  });
});

describe('33→34 的讀方分支只有一份（#1797）', () => {
  // 入口改回自己寫一份 `recordedApprovalPolicy(...) ?? 'ask'` 時行為不變，入口層的續接測試抓不到，只能看原始碼。
  it.each(['apps/harness/src/cli.ts', 'apps/harness/src/serve-run.ts'])(
    '%s 續接的核准政策呼叫 approvalPolicyOnResume，不自己讀日誌',
    (path) => {
      const source = readFileSync(join(REPO, path), 'utf8');
      // serve 的續接與分叉（#1580）共用一份 `history`，所以引數名不固定，只看它交的是日誌的事件。
      expect(source).toMatch(/approvalPolicyOnResume\((?:resumed|history)\.events\)/u);
      expect(source).not.toContain('recordedApprovalPolicy');
    },
  );
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
    for (const open of [() => store.open('cli', 'read'), () => store.resume('cli')]) {
      const error: unknown = await open().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SessionFormatUnsupportedError);
      expect((error as Error).message).toContain('沒有 v13 的遷移');
    }
  });

  it('v14 的夾具照常讀回', async () => {
    const store = openJsonlSessionStore({ directory: await copied('v14'), catalog: breaking });
    expect((await store.list()).unreadable).toBe(0);
    const events = await (await store.open('cli', 'read')).read();
    expect(events).toHaveLength(expectedOf('v14').sessions['cli']!.eventCount);
  });
});
