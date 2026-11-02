/**
 * 「從日誌推回的歷史」對「實際送給模型的請求」的比對，**子代理、核准、中止、插話、重啟**這幾類場景
 * （[#1343](https://github.com/DemianLi/nexus-agent/issues/1343)，地圖 [#1339](https://github.com/DemianLi/nexus-agent/issues/1339) 的 Fog）。
 *
 * 量法與判定見 `log-derived-history.fixture.ts` 檔頭；對照文件是 `.docs/log-derived-history-vs-wire-2026-10-08.md` §二「第二輪」，
 * 這裡把那一輪的場景（SA、SS、ST、SR、SC 系列）從一次性探針搬進版控。**沒有已知差異清單**：#1190、#1207 修完之後這幾類都應該逐位元組相同，
 * 哪一格不同就是退步（或新發現），要開卡，不是往清單裡加。
 *
 * 全走 serve 的串流路徑（`runServeDriver`，出貨清單、真的落盤、一個日誌目錄裡 root 與各子代理各一份）。主呼叫分不出是 root 還是子代理的：
 * 腳本在子代理任務描述裡放記號（`CHILD-…`），比對時以那個記號把請求分給各自的日誌。
 *
 * ## 這份測試不證明什麼
 *
 * - 假端點：真供應商的串流分塊與行為沒量（見 `.docs/` 的真模型一節）。
 * - SR 系列（重啟）有**循環性**：續接是從日誌推出歷史再灌回狀態，所以「重啟與不重啟相同」證明的是今天重啟不改變請求，不是推導本身正確。
 *   推導本身的檢驗是每個場景對整份日誌逐呼叫比的那一步（`expectAllSame`）。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  aiDone,
  childLogsOf,
  compareToLog,
  idleWithContent,
  LOW_SUMMARIZATION,
  mainOnly,
  PRUNE_MARKER,
  rootLogOf,
  runServeDriver,
  settle,
  TRUNCATE_MARKER,
} from './log-derived-history.fixture.js';
import type {
  Body,
  DriverCtx,
  DriverRun,
  LogFile,
  Reply,
  Script,
  Verdict,
} from './log-derived-history.fixture.js';
import { approvalAt } from './fixtures.js';
import { TOOL_OUTCOME_UNKNOWN_TEXT } from '@nexus/core';
import { uniformDecisions } from '@nexus/wire';
import type { ConversationState } from '@nexus/wire';
import { join } from 'node:path';

beforeAll(() => {
  vi.stubEnv('NVIDIA_API_KEY', 'nvapi-fake-for-log-derived-history');
});
afterAll(() => {
  vi.unstubAllEnvs();
});

const explain = (verdicts: readonly Verdict[]): string =>
  verdicts
    .filter((v) => v.kinds.length > 0 || !v.systemMatches)
    .map(
      (v) =>
        `\n呼叫 ${String(v.call)}：種類=[${v.kinds.join(',')}] 系統訊息${v.systemMatches ? '相符' : '不符'}` +
        (v.detail === undefined ? '' : `\n  ${v.detail}`),
    )
    .join('');

/**
 * 以第一則使用者訊息裡的 `CHILD-…` 記號認出這個請求是哪個子代理的；沒有記號就是 root。
 * 摘要把第一則使用者訊息換掉之後，記號靠摘要文字帶（`summaryReply` 把它抄進去）。
 */
const markerOf = (body: Body): string => {
  const first = body.messages.find((message) => message.role === 'user');
  return (
    /CHILD-[A-Z0-9]+/.exec(JSON.stringify(first?.content ?? ''))?.[0] ??
    /摘要 (CHILD-[A-Z0-9]+)/.exec(JSON.stringify(body.messages))?.[1] ??
    'ROOT'
  );
};

/** 不帶工具的呼叫（標題、摘要）：回固定文字，摘要那種（請求裡有子代理記號）把記號抄進去，讓摘要後的請求認得出是誰的。 */
const summaryReply = (body: Body): Reply => {
  const mark = /CHILD-[A-Z0-9]+/.exec(JSON.stringify(body.messages))?.[0];
  return { content: mark === undefined ? '標題' : `摘要 ${mark}` };
};

/** 一份日誌屬於誰：root，或開頭的輸入事件（背景 `turn/start`、前景 `user/message`）裡的記號。 */
function logOwner(log: LogFile, run: DriverRun): string {
  if (rootLogOf(run) === log) return 'ROOT';
  const opening = log.events.find((e) => e.type === 'turn/start' || e.type === 'user/message');
  const mark = /CHILD-[A-Z0-9]+/.exec(JSON.stringify(opening?.data ?? ''))?.[0];
  if (mark === undefined) throw new Error(`認不出子代理日誌 ${log.file} 屬於哪個記號`);
  return mark;
}

/**
 * 斷言一個場景：每一份日誌的每一次主呼叫，推導與請求逐位元組相同、系統訊息相符。
 *
 * @param expected - 每個擁有者（`ROOT` 或 `CHILD-…`）預期比幾次；數量不對代表場景沒跑成預期的樣子（例如子代理根本沒被叫起來）。
 */
async function expectAllSame(
  name: string,
  run: DriverRun,
  expected: Readonly<Record<string, number>>,
): Promise<void> {
  const owners = [rootLogOf(run), ...childLogsOf(run)].map(
    (log) => [logOwner(log, run), log] as const,
  );
  expect(owners.map(([owner]) => owner).sort(), `${name}：有哪幾份日誌`).toEqual(
    Object.keys(expected).sort(),
  );
  for (const [owner, log] of owners) {
    const bodies = run.mainBodies.filter((body) => markerOf(body) === owner);
    const verdicts = await compareToLog(log.events, bodies);
    expect(verdicts.length, `${name}／${owner}：主呼叫數`).toBe(expected[owner]);
    expect(
      verdicts.filter((v) => v.kinds.length > 0 || !v.systemMatches),
      `${name}／${owner}：推導與請求不同${explain(verdicts)}`,
    ).toEqual([]);
  }
}

/** 只有 root 的場景。 */
const expectRootSame = (name: string, run: DriverRun, calls: number) =>
  expectAllSame(name, run, { ROOT: calls });

/** 腳本：依請求的記號分流給 root 與各子代理，各自有自己的計數。標題這類不帶工具的呼叫回固定字串，不佔號。 */
const routed = (
  root: (k: number, body: Body) => Reply,
  children: Record<string, (k: number, body: Body) => Reply>,
): Script => {
  const counters = new Map<string, number>();
  return (_index, body) => {
    if ((body.tools?.length ?? 0) === 0) return summaryReply(body);
    const mark = markerOf(body);
    const k = counters.get(mark) ?? 0;
    counters.set(mark, k + 1);
    const fn = mark === 'ROOT' ? root : children[mark];
    return fn === undefined ? {} : fn(k, body);
  };
};

const subagentCall = (id: string, description: string, tool = 'subagent'): Reply => ({
  tools: [{ id, name: tool, args: { description, subagent_type: 'general-purpose' } }],
});
const echo = (id: string, message: string) => ({ id, name: 'echo', args: { message } });

/** 背景子代理的編號（`bg-` 加 12 位十六進位）：從工具結果裡讀。 */
const bgIdIn = (body: Body): string => {
  for (const message of [...body.messages].reverse()) {
    const hit = /bg-[0-9a-f]{12}/.exec(JSON.stringify(message.content ?? ''));
    if (message.role === 'tool' && hit !== null) return hit[0];
  }
  return 'bg-unknown';
};

const FOREGROUND_PATCH = [
  '- id: background-subagents',
  '  config:',
  '    backgroundMode: one-shot',
  '    maxActiveSubagents: 8',
].join('\n');
const APPROVAL_PATCH = [
  '- insert:',
  '    - id: approval-demo',
  `      name: '${join(process.cwd(), 'src', 'approval.fixture.ts')}'`,
].join('\n');

/** 答核准直到對話收尾：每一張核准卡由 `decide` 決定准或拒。 */
async function answerApprovals(
  ctx: DriverCtx,
  decide: (tool: string, n: number) => 'approve' | 'reject',
  done: (state: ConversationState) => boolean,
): Promise<void> {
  let n = 0;
  for (;;) {
    await ctx.fold((s) => s.pendings.length > 0 || (s.status === 'idle' && done(s)));
    if (ctx.state().pendings.length === 0) return;
    const pending = approvalAt(ctx.state().pendings, 0);
    await ctx.client.inputRespond('alpha', {
      namespace: [...pending.namespace],
      interrupt_id: pending.interruptId,
      response: uniformDecisions(pending, decide(pending.actions[0]?.name ?? '?', n++)),
    });
    await ctx.fold((s) => s.pendings.length === 0);
  }
}

describe('背景與前景子代理', () => {
  it('SA0 背景子代理：根派工、子代理叫一次工具、完成後叫醒根再跑一輪', async () => {
    const run = await runServeDriver(
      async (ctx) => {
        await ctx.client.runStart('alpha', '派一個子代理');
        await ctx.fold(idleWithContent);
        await settle(3000);
      },
      routed((k) => (k === 0 ? subagentCall('call_sub', 'CHILD-A0 算一下') : {}), {
        'CHILD-A0': (k) =>
          k === 0 ? { tools: [echo('call_ce', '子的回聲')] } : { content: '子任務完成：四十二。' },
      }),
    );
    await expectAllSame('SA0', run, { ROOT: 3, 'CHILD-A0': 2 });
  }, 90_000);

  it('SS2 前景 task（one-shot 模式）：子代理當場做完回報，子日誌有自己的輸入（#1207）', async () => {
    const run = await runServeDriver(
      async (ctx) => {
        await ctx.client.runStart('alpha', '派前景');
        await ctx.fold(aiDone(2));
        await ctx.client.runStart('alpha', '再說一輪');
        await ctx.fold(aiDone(3));
      },
      routed((k) => (k === 0 ? subagentCall('call_t', 'CHILD-F 回聲後回報', 'task') : {}), {
        'CHILD-F': (k) =>
          k === 0 ? { tools: [echo('call_fe', '前景子')] } : { content: '前景子完成。' },
      }),
      FOREGROUND_PATCH,
    );
    await expectAllSame('SS2', run, { ROOT: 3, 'CHILD-F': 2 });
    // #1207：前景子日誌出生時先寫一顆輸入（`user/message`），不靠父日誌補。
    const child = childLogsOf(run)[0]!;
    expect(child.events.some((e) => e.type === 'user/message')).toBe(true);
  }, 90_000);

  it('SS3 背景子代理中途用 send_message 向上傳訊，父的那一輪還在跑', async () => {
    const run = await runServeDriver(
      async (ctx) => {
        await ctx.client.runStart('alpha', '派背景並等');
        await ctx.fold(idleWithContent);
        await settle(3500);
      },
      routed(
        (k) => {
          if (k === 0) return subagentCall('call_s', 'CHILD-U 邊做邊回報');
          return k === 1 ? { delay: 1200, content: '我先等一下。' } : {};
        },
        {
          'CHILD-U': (k) =>
            k === 0
              ? {
                  tools: [
                    {
                      id: 'call_up',
                      name: 'send_message',
                      args: { agent_id: 'alpha', message: '進度：做了一半。' },
                    },
                  ],
                }
              : { content: '全部完成。' },
        },
      ),
    );
    await expectAllSame('SS3', run, { ROOT: 3, 'CHILD-U': 2 });
  }, 90_000);

  it('SS4b 父用 send_message 對還在跑的背景子代理插話', async () => {
    const run = await runServeDriver(
      async (ctx) => {
        await ctx.client.runStart('alpha', '派背景再插話');
        await ctx.fold(idleWithContent);
        await settle(4000);
      },
      routed(
        (k, body) => {
          if (k === 0) return subagentCall('call_s', 'CHILD-S 慢慢做');
          if (k === 1) {
            return {
              tools: [
                {
                  id: 'call_sm',
                  name: 'send_message',
                  args: { agent_id: bgIdIn(body), message: '改成只回一個字。' },
                },
              ],
            };
          }
          return {};
        },
        {
          'CHILD-S': (k) =>
            k === 0
              ? { delay: 1500, tools: [echo('call_ce', '慢工')] }
              : { content: '收到，完成。' },
        },
      ),
    );
    await expectAllSame('SS4b', run, { ROOT: 4, 'CHILD-S': 2 });
  }, 90_000);

  it('SS5 兩個併發背景子代理，後派的先完成', async () => {
    const run = await runServeDriver(
      async (ctx) => {
        await ctx.client.runStart('alpha', '派兩個');
        await ctx.fold(idleWithContent);
        await settle(4500);
      },
      routed(
        (k) =>
          k === 0
            ? {
                tools: [
                  {
                    id: 'call_a',
                    name: 'subagent',
                    args: { description: 'CHILD-A 慢', subagent_type: 'general-purpose' },
                  },
                  {
                    id: 'call_b',
                    name: 'subagent',
                    args: { description: 'CHILD-B 快', subagent_type: 'general-purpose' },
                  },
                ],
              }
            : {},
        {
          'CHILD-A': (k) =>
            k === 0 ? { delay: 1500, tools: [echo('call_ae', 'A')] } : { content: 'A 完成。' },
          'CHILD-B': (k) => (k === 0 ? { tools: [echo('call_be', 'B')] } : { content: 'B 完成。' }),
        },
      ),
    );
    await expectAllSame('SS5', run, { ROOT: 4, 'CHILD-A': 2, 'CHILD-B': 2 });
  }, 90_000);

  it('SS6 已完成的背景子代理，父用 send_message 讓它續談第二輪', async () => {
    const run = await runServeDriver(
      async (ctx) => {
        await ctx.client.runStart('alpha', '派背景，完成後續談');
        await ctx.fold(idleWithContent);
        await settle(5000);
      },
      routed(
        (k, body) => {
          if (k === 0) return subagentCall('call_s', 'CHILD-C 先做第一件');
          if (k === 1) return { content: '等它做完。' };
          if (k === 2) {
            return {
              tools: [
                {
                  id: 'call_sm',
                  name: 'send_message',
                  args: { agent_id: bgIdIn(body), message: '再做第二件。' },
                },
              ],
            };
          }
          return {};
        },
        {
          'CHILD-C': (k) =>
            k === 0
              ? { content: '第一件完成。' }
              : k === 1
                ? { tools: [echo('call_c2', '第二件')] }
                : { content: '第二件完成。' },
        },
      ),
    );
    await expectAllSame('SS6', run, { ROOT: 5, 'CHILD-C': 3 });
  }, 90_000);

  it('SS7 使用者按停背景子代理、再對它說話：第一次呼叫被中止、日誌沒有回覆（#1190）', async () => {
    const run = await runServeDriver(
      async (ctx) => {
        await ctx.client.runStart('alpha', '派一個慢的');
        await ctx.fold(idleWithContent);
        let id = 'bg-unknown';
        for (let i = 0; i < 100 && id === 'bg-unknown'; i++) {
          await settle(50);
          for (const body of ctx.bodies) if (bgIdIn(body) !== 'bg-unknown') id = bgIdIn(body);
        }
        expect(id, '背景子代理的編號').not.toBe('bg-unknown');
        await settle(300);
        await ctx.client.subagentInterrupt('alpha', id);
        await settle(800);
        await ctx.client.subagentSend('alpha', id, '改做別的：回一個字');
        await settle(4000);
      },
      routed(
        (k) =>
          k === 0
            ? subagentCall('call_s', 'CHILD-I 很慢')
            : k === 1
              ? { content: '派出去了。' }
              : {},
        {
          'CHILD-I': (k) =>
            k === 0 ? { delay: 4000, content: '本來要說的很多。' } : { content: '好，一個字。' },
        },
      ),
    );
    await expectAllSame('SS7', run, { ROOT: 4, 'CHILD-I': 2 });
    // 前提：子代理的第一次呼叫真的沒有回覆（被中止），不然這一格什麼都沒證明。
    const child = childLogsOf(run)[0]!;
    const firstStart = child.events.findIndex((e) => e.type === 'model/start');
    const firstEnd = child.events.findIndex((e) => e.type === 'model/end');
    expect(
      child.events.slice(firstStart, firstEnd).some((e) => e.type === 'assistant/message'),
    ).toBe(false);
  }, 90_000);

  it('SS8 子代理自己的剪刀與截斷：寫進子代理那份日誌，推導與請求相同（#1302、#1303）', async () => {
    const run = await runServeDriver(
      async (ctx) => {
        await ctx.client.runStart('alpha', '派一個要做大事的');
        await ctx.fold(idleWithContent);
        await settle(5000);
      },
      routed((k) => (k === 0 ? subagentCall('call_s', 'CHILD-P 大結果與長參數') : {}), {
        // 先寫長參數、兩輪小結果讓它被截斷，再來大結果、再一輪讓它被剪（摘要與截斷同輪不並行，所以分開）。
        'CHILD-P': (k) => {
          if (k === 0) {
            return {
              tools: [
                {
                  id: 'call_w',
                  name: 'write_file',
                  args: { file_path: '/a.txt', content: 'abc'.repeat(2_000) },
                },
              ],
            };
          }
          if (k === 1 || k === 2 || k === 4)
            return { tools: [echo(`call_s${String(k)}`, `小${String(k)}`)] };
          if (k === 3) return { tools: [echo('call_mid', '中'.repeat(10_000))] };
          return { content: '都做完了。' };
        },
      }),
      LOW_SUMMARIZATION,
    );
    const child = childLogsOf(run)[0]!;
    const root = rootLogOf(run);
    // 前提：剪刀與截斷真的發生在子代理那一份，而且 root 的日誌沒有。
    expect(child.events.some((e) => e.type === 'compaction/prune')).toBe(true);
    expect(child.events.some((e) => e.type === 'compaction/truncate-args')).toBe(true);
    expect(root.events.some((e) => e.type === 'compaction/prune')).toBe(false);
    expect(root.events.some((e) => e.type === 'compaction/truncate-args')).toBe(false);
    expect(
      run.mainBodies.some(
        (b) => markerOf(b) === 'CHILD-P' && JSON.stringify(b.messages).includes(PRUNE_MARKER),
      ),
    ).toBe(true);
    expect(
      run.mainBodies.some(
        (b) => markerOf(b) === 'CHILD-P' && JSON.stringify(b.messages).includes(TRUNCATE_MARKER),
      ),
    ).toBe(true);
    await expectAllSame('SS8', run, { ROOT: 3, 'CHILD-P': 6 });
  }, 90_000);
});

describe('核准', () => {
  const approved = (k: number): Reply => (k === 0 ? { tools: [echo('call_e1', '核准我')] } : {});

  it('SA1 核准後續說', async () => {
    const run = await runServeDriver(
      async (ctx) => {
        await ctx.client.runStart('alpha', '叫 echo');
        await answerApprovals(ctx, () => 'approve', aiDone(2));
        await ctx.client.runStart('alpha', '再說一輪');
        await ctx.fold(aiDone(3));
      },
      mainOnly(approved),
      APPROVAL_PATCH,
    );
    await expectRootSame('SA1', run, 3);
    expect(rootLogOf(run).events.some((e) => e.type === 'approval/asked')).toBe(true);
  }, 90_000);

  it('SA2 拒絕後續說（拒絕訊息是核准層固定的文字）', async () => {
    const run = await runServeDriver(
      async (ctx) => {
        await ctx.client.runStart('alpha', '叫 echo');
        await answerApprovals(ctx, () => 'reject', aiDone(2));
        await ctx.client.runStart('alpha', '再說一輪');
        await ctx.fold(aiDone(3));
      },
      mainOnly(approved),
      APPROVAL_PATCH,
    );
    await expectRootSame('SA2', run, 3);
  }, 90_000);

  it('SA3 同一批兩個要核准的工具，一准一拒', async () => {
    const run = await runServeDriver(
      async (ctx) => {
        await ctx.client.runStart('alpha', '兩個一起');
        await answerApprovals(ctx, (_tool, n) => (n === 0 ? 'approve' : 'reject'), aiDone(2));
        await ctx.client.runStart('alpha', '再說一輪');
        await ctx.fold(aiDone(3));
      },
      mainOnly((k) =>
        k === 0
          ? {
              tools: [
                echo('call_e1', 'A'),
                { id: 'call_w1', name: 'write_file', args: { file_path: '/b.txt', content: 'hi' } },
              ],
            }
          : {},
      ),
      APPROVAL_PATCH,
    );
    await expectRootSame('SA3', run, 3);
  }, 90_000);

  it('SA4 批次裡有免核准的 ls 與要核准的 echo：免核准的在續接輪不重跑', async () => {
    const run = await runServeDriver(
      async (ctx) => {
        await ctx.client.runStart('alpha', '混批');
        await answerApprovals(ctx, () => 'approve', aiDone(2));
        await ctx.client.runStart('alpha', '再說一輪');
        await ctx.fold(aiDone(3));
      },
      mainOnly((k) =>
        k === 0
          ? { tools: [{ id: 'call_ls', name: 'ls', args: { path: '/' } }, echo('call_e1', '混批')] }
          : {},
      ),
      APPROVAL_PATCH,
    );
    await expectRootSame('SA4', run, 3);
  }, 90_000);

  it('SR3 停在核准點時重啟 serve：核准不跨重啟，該呼叫成為「結果未知」，推導補出的與請求逐位元組相同', async () => {
    const run = await runServeDriver(
      [
        async (ctx) => {
          await ctx.client.runStart('alpha', '叫 echo');
          await ctx.fold((s) => s.pendings.length > 0);
        },
        async (ctx) => {
          await settle(1500);
          expect(ctx.state().pendings, '重啟後核准卡不在').toHaveLength(0);
          await ctx.client.runStart('alpha', '重啟後說一句');
          await ctx.fold(aiDone(1));
        },
      ],
      mainOnly((k) => (k === 0 ? { tools: [echo('call_e1', '卡住')] } : {})),
      APPROVAL_PATCH,
    );
    await expectRootSame('SR3', run, 2);
    // 重啟後那次請求裡 echo 的結果是「結果未知」，日誌裡沒有這顆 tool/result（推導補的）。
    const events = rootLogOf(run).events;
    expect(events.some((e) => e.type === 'approval/asked')).toBe(true);
    expect(
      events.some(
        (e) => e.type === 'tool/result' && (e.data as { callId: string }).callId === 'call_e1',
      ),
    ).toBe(false);
    // 補出來的那則結果文字是核准層與中斷處理約定的固定句，不是任何一邊算出來又自己比自己：重啟路徑與推導用同一個函式，
    // 只比兩邊相同擋不住這個函式被改掉，所以這裡直接釘住線上看到的內容。
    const last = run.mainBodies.at(-1)!;
    const closed = last.messages.find(
      (m) => m.role === 'tool' && (m as { tool_call_id?: string }).tool_call_id === 'call_e1',
    );
    expect(String(closed?.content), '重啟後線上的 echo 結果').toBe(TOOL_OUTCOME_UNKNOWN_TEXT);
  }, 90_000);

  it('ST3 停在核准點時按停止，再說一句：日誌補一顆被取消的 tool/result', async () => {
    const run = await runServeDriver(
      async (ctx) => {
        await ctx.client.runStart('alpha', '叫 echo');
        await ctx.fold((s) => s.pendings.length > 0);
        await ctx.client.runCancel('alpha');
        await settle(1000);
        await ctx.client.runStart('alpha', '算了，改問別的');
        await ctx.fold(aiDone(1));
      },
      mainOnly((k) => (k === 0 ? { tools: [echo('call_e1', '卡在核准')] } : {})),
      APPROVAL_PATCH,
    );
    await expectRootSame('ST3', run, 2);
  }, 90_000);
});

describe('中止與插話', () => {
  it('ST1 跑著時 steer 插話', async () => {
    const run = await runServeDriver(
      async (ctx) => {
        await ctx.client.runStart('alpha', '先做第一步');
        await settle(400);
        await ctx.client.runStart('alpha', '插話：改成只回一個字', { mode: 'steer' });
        await ctx.fold(aiDone(2));
      },
      mainOnly((k) => (k === 0 ? { delay: 1000, tools: [echo('call_e1', '第一步')] } : {})),
    );
    await expectRootSame('ST1', run, 2);
    expect(rootLogOf(run).events.some((e) => e.type === 'inbox/spliced')).toBe(true);
  }, 90_000);

  it('ST2 模型呼叫進行中按停止，再說一句', async () => {
    const run = await runServeDriver(
      async (ctx) => {
        await ctx.client.runStart('alpha', '先做一步');
        await ctx.fold(aiDone(1));
        await ctx.client.runStart('alpha', '再來一個慢的');
        await settle(600);
        await ctx.client.runCancel('alpha');
        await settle(1500);
        await ctx.client.runStart('alpha', '算了，講個字');
        await settle(2500);
      },
      mainOnly((k) =>
        k === 0
          ? { tools: [echo('call_e1', '一步')] }
          : k === 2
            ? { delay: 2000, content: '慢慢說的很長的話。' }
            : {},
      ),
    );
    await expectRootSame('ST2', run, 4);
  }, 90_000);

  /** 第一次模型呼叫就被按停：整份日誌沒有任何回覆（#1190 之前推導整份拒推，`reply-missing`）。 */
  const firstCallStopped = mainOnly((k) =>
    k === 0 ? { delay: 2500, content: '被停掉的長回覆。' } : {},
  );
  const stopFirst = async (ctx: DriverCtx) => {
    await ctx.client.runStart('alpha', '第一句，會被停掉');
    await settle(600);
    await ctx.client.runCancel('alpha');
    await settle(1500);
  };

  it('ST4 第一次模型呼叫就按停止（整份日誌沒有任何回覆），再說兩句', async () => {
    const run = await runServeDriver(async (ctx) => {
      await stopFirst(ctx);
      await ctx.client.runStart('alpha', '第二句，真的要答');
      await ctx.fold(aiDone(1));
      await ctx.client.runStart('alpha', '第三句');
      await ctx.fold(aiDone(2));
    }, firstCallStopped);
    await expectRootSame('ST4', run, 3);
    // 前提：第一次呼叫確實沒有回覆。
    const events = rootLogOf(run).events;
    const firstReply = events.findIndex((e) => e.type === 'assistant/message');
    const secondStart = events.findIndex(
      (e, i) => e.type === 'model/start' && i > events.findIndex((x) => x.type === 'model/start'),
    );
    expect(firstReply).toBeGreaterThan(secondStart);
  }, 90_000);

  it('SR5 第一次模型呼叫被按停、馬上重啟、再說一句：使用者第一句沒有丟（#1190）', async () => {
    const control = await runServeDriver(async (ctx) => {
      await stopFirst(ctx);
      await ctx.client.runStart('alpha', '第二句，真的要答');
      await ctx.fold(aiDone(1));
    }, firstCallStopped);
    const restart = await runServeDriver(
      [
        stopFirst,
        async (ctx) => {
          await ctx.client.runStart('alpha', '第二句，真的要答');
          await ctx.fold(aiDone(1));
        },
      ],
      firstCallStopped,
    );
    await expectRootSame('SR5-restart', restart, 2);
    const lastOf = (r: DriverRun) =>
      JSON.stringify(r.mainBodies.at(-1)!.messages.slice(1)).replace(
        /session_[0-9a-f]{8}/g,
        'session_X',
      );
    expect(lastOf(restart)).toBe(lastOf(control));
    expect(lastOf(restart)).toContain('第一句，會被停掉');
  }, 120_000);

  it('SR4 第一次呼叫被停、再說一句得到回覆，這之後才重啟：重啟後的請求與不重啟相同', async () => {
    const first = async (ctx: DriverCtx) => {
      await stopFirst(ctx);
      await ctx.client.runStart('alpha', '第二句，真的要答');
      await ctx.fold(aiDone(1));
    };
    // 重啟後的 client 從新的串流起算，已完成的回覆數歸零。
    const third = (aiCount: number) => async (ctx: DriverCtx) => {
      await ctx.client.runStart('alpha', '第三句');
      await ctx.fold(aiDone(aiCount));
    };
    const control = await runServeDriver(async (ctx) => {
      await first(ctx);
      await third(2)(ctx);
    }, firstCallStopped);
    const restart = await runServeDriver([first, third(1)], firstCallStopped);
    await expectRootSame('SR4-restart', restart, 3);
    const lastOf = (r: DriverRun) =>
      JSON.stringify(r.mainBodies.at(-1)!.messages.slice(1)).replace(
        /session_[0-9a-f]{8}/g,
        'session_X',
      );
    expect(lastOf(restart)).toBe(lastOf(control));
  }, 120_000);
});

describe('串流分塊', () => {
  it('SC1 推理拆三字一片、內容拆兩字一片、兩個並行工具呼叫的參數片段交錯（含引號與換行）', async () => {
    const run = await runServeDriver(
      async (ctx) => {
        await ctx.client.runStart('alpha', '分塊測試');
        await ctx.fold(aiDone(2));
        await ctx.client.runStart('alpha', '再問');
        await ctx.fold(aiDone(3));
      },
      mainOnly((k) =>
        k === 0
          ? {
              chunky: true,
              reasoning: '先想一想要叫哪兩個工具。',
              content: '我來叫兩個。',
              tools: [
                echo('call_x', '甲：這是一段比較長的參數內容'),
                echo('call_y', '乙：另一段也很長的參數內容、含引號 " 與換行 \\n'),
              ],
            }
          : k === 1
            ? { chunky: true, reasoning: '收到結果。', content: '兩個都叫完了，結果如上。' }
            : {},
      ),
    );
    await expectRootSame('SC1', run, 3);
  }, 90_000);
});
