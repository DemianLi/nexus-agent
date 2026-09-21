import {
  GOAL_COMMAND_NAME,
  GOAL_NONE_MESSAGE,
  GOAL_NOT_ATTACHED_MESSAGE,
} from '@nexus/plugin-goal';
import { PLAN_COMMAND_NAME, PLAN_ENTERED_MESSAGE } from '@nexus/plugin-plan-mode';

import {
  appendDecision,
  appendHumanTurn,
  emptyConversation,
  reduceConversation,
  uniformDecisions,
} from '@nexus/wire';
import type { ConversationState } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';
import { documentedFixture } from './documented-fixture.js';
import { approvalAt, serveClient } from './fixtures.js';
import { DEFAULT_PORT, parseServeArgs, runServe } from './serve.js';
import type { RunningServe } from './serve.js';

/**
 * 進入點。
 *
 * 起在 port 0——由作業系統挑一個空的，所以這條測試可以跟別人平行跑，也不需要任何
 * 憑證或外部服務（[#31](https://github.com/DemianLi/nexus-agent/issues/31)）。
 * 它驗的是**整條線真的接得起來**：CLI 的組裝 → pump → SSE → 瀏覽器端 client →
 * 折疊器，中間走真的 HTTP。
 */

let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe('serve 的旗標', () => {
  it('預設值就是文件上寫的那些', () => {
    expect(parseServeArgs([])).toEqual({
      live: false,
      port: DEFAULT_PORT,
      // **續行預設關**，兩個入口同一個決定：dsh 的續行驅動器是「需要你刻意掛載的可選
      // 消費方」，而我們的入口點擁有輪迴圈，掛載的等價物就是這個旗標。（2026-09-19 註：dsh 的
      // base 其實出廠就掛著續行驅動器，這個前提待重核，見調研筆記 §三第 18 列。）
      goalDriver: false,
      // 印設定預設關——它是一個診斷出口，不是一種跑法（#454）。
      dumpConfig: false,
      help: false,
    });
  });

  it('--goal-driver 打得開', () => {
    expect(parseServeArgs(['--goal-driver']).goalDriver).toBe(true);
  });

  it('port 不是合法整數就當場說清楚', () => {
    expect(() => parseServeArgs(['--port', '七'])).toThrow('--port 要給 0 到 65535');
    expect(() => parseServeArgs(['--port', '99999'])).toThrow('--port 要給 0 到 65535');
  });

  it('--plugins 給空字串是錯的，不是「沒給」', () => {
    expect(() => parseServeArgs(['--plugins', '  '])).toThrow('--plugins 要給一個模組路徑');
  });

  it('--help 只印用法，不起 server', async () => {
    const lines: string[] = [];
    const result = await runServe({ argv: ['--help'], log: (line) => lines.push(line) });
    expect(result).toBeUndefined();
    expect(lines.join('\n')).toContain('pnpm --filter @nexus/harness run serve');
  });
});

describe('起起來之後', () => {
  it('port 被佔住時說得出原因，而不是行程莫名其妙地死掉', async () => {
    running = await runServe({ argv: ['--port', '0'], log: () => undefined, env: {} });
    const taken = Number(new URL((running as RunningServe).url).port);
    await expect(
      runServe({ argv: ['--port', String(taken)], log: () => undefined, env: {} }),
    ).rejects.toThrow(/EADDRINUSE|address already in use/);
  });

  it('瀏覽器端連得上，而且一路折得出對話', async () => {
    const lines: string[] = [];
    running = await runServe({
      argv: ['--port', '0'],
      log: (line) => lines.push(line),
      env: {},
    });
    expect(running).toBeDefined();
    const started = running as RunningServe;
    // 印出來的那幾行是人要看的：位址、模型、plugin 清單。
    expect(lines[0]).toContain(started.url);
    expect(lines[1]).toContain('假模型');
    expect(lines[2]).toContain('echo');

    const client = await serveClient(started);
    const events = await client.openEvents('web');
    await client.runStart('web', '把這句話回聲一次。');

    let state: ConversationState = appendHumanTurn(emptyConversation(), '把這句話回聲一次。');
    while (state.status === 'running') {
      const next = await events.next();
      if (next.done === true) {
        break;
      }
      state = reduceConversation(state, next.value);
    }

    // 預設清單只有 echo，而 CLI 的假模型腳本第一輪就是呼叫它——「工具真的接上了」
    // 因此是這條線上看得到的事，不是靠讀 log 推的。
    const tools = state.entries.filter((entry) => entry.kind === 'tool');
    expect(tools.map((entry) => (entry.kind === 'tool' ? entry.name : ''))).toContain('echo');
    expect(state.entries.some((entry) => entry.kind === 'ai' && entry.text.length > 0)).toBe(true);
    expect(state.status).toBe('idle');
  });
});

/**
 * **工具本體拋錯不會把 serve 行程弄掛**（[#346](https://github.com/DemianLi/nexus-agent/issues/346)）。
 *
 * 修好之前這個 fixture 在真的 `serve` 行程上是 exit 1——所有 thread 一起斷。在 vitest 裡行程
 * 不會真的死（vitest 自己接住了），所以判準是**這條測試期間的未處理 rejection 數**，再加上
 * 「同一條 thread 再送一句、另一條 thread 也送一句都跑得完」那一半。
 */
describe('serve 上的工具拋錯', () => {
  it('同一條 thread 再送一句、另一條 thread 也送一句都跑得完，沒有未處理的 rejection', async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', record);
    try {
      running = await runServe({
        argv: ['--port', '0', '--plugins', 'src/tool-throw.fixture.ts'],
        log: () => undefined,
        env: {},
      });
      const client = await serveClient(running as RunningServe);

      const converse = async (threadId: string, sentences: readonly string[]) => {
        const events = await client.openEvents(threadId);
        let state: ConversationState = emptyConversation();
        for (const sentence of sentences) {
          state = appendHumanTurn(state, sentence);
          await client.runStart(threadId, sentence);
          while (state.status === 'running') {
            const next = await events.next();
            if (next.done === true) break;
            state = reduceConversation(state, next.value);
          }
          expect(state.status).toBe('idle');
        }
        return state;
      };

      // 腳本第一句就叫那顆一律拋錯的 `echo`；第二句落在腳本的第四輪。
      await converse('first', ['把這句話回聲一次。', '再說一句。']);
      // 另一條 thread 有自己的一份假模型，又撞一次拋錯。
      await converse('second', ['把這句話回聲一次。']);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(unhandled.map(String)).toEqual([]);
    } finally {
      process.off('unhandledRejection', record);
    }
  });
});

/**
 * **這一條守的是 `serve.ts` 那一行組裝**，不是發派面本身——那一整套在
 * [`slash-wire.test.ts`](./slash-wire.test.ts) 裡對著自己建的 handler 走完。
 * 這裡只問一件事：`createCliAgent` 回的那個註冊點有沒有真的一路傳到線上
 * （[#123](https://github.com/DemianLi/nexus-agent/issues/123) 之前它在這一行被丟掉）。
 *
 * 紅了而 `slash-wire.test.ts` 還綠著，代表發派面是好的、`serve.ts` 沒接上。
 */
describe('serve 的命令面', () => {
  it('預設清單起的 server 上，瀏覽器打得到 /plan', async () => {
    running = await runServe({ argv: ['--port', '0'], log: () => undefined, env: {} });
    const started = running as RunningServe;
    const client = await serveClient(started);
    await client.openEvents('planning');

    const listed = await client.slashList('planning');
    if (listed.kind !== 'ok') throw new Error(listed.message);
    expect(listed.commands.map((command) => command.name)).toContain(PLAN_COMMAND_NAME);

    // **這就是那份 `startActive: true` 的 fixture 清單不再是必要的那一刻**：不用
    // `--plugins`，瀏覽器自己打得開計劃模式。
    expect(await client.slashRun('planning', `/${PLAN_COMMAND_NAME}`)).toEqual({
      kind: 'success',
      command_id: expect.any(String),
      text: PLAN_ENTERED_MESSAGE,
    });
  });

  it('**每條 thread 各有各的目標**——`/goal` 在真的 serve 上找得到自己那一份', async () => {
    // 這一條同時是 `/goal` 那個「一份 registry 只接一份日誌」假設的實地驗收：
    // `serve.ts` 每個 thread 呼叫一次 `createCliAgent`，所以各自一份 registry 一份日誌。
    // 假設破掉的話這裡不會靜靜串台，會直接收到 `goalAmbiguousMessage` 那句錯誤。
    running = await runServe({ argv: ['--port', '0'], log: () => undefined, env: {} });
    const started = running as RunningServe;
    const client = await serveClient(started);
    await client.openEvents('alpha');
    await client.openEvents('beta');

    const created = await client.slashRun('alpha', `/${GOAL_COMMAND_NAME} 把測試修綠`);
    if (created.kind !== 'success') throw new Error(JSON.stringify(created));
    expect(created.text).toContain('目標建好了');
    expect(created.text).toContain('目標：把測試修綠');

    // beta 看不到 alpha 的目標。
    const other = await client.slashRun('beta', `/${GOAL_COMMAND_NAME}`);
    if (other.kind !== 'success') throw new Error(JSON.stringify(other));
    expect(other.text).toBe(GOAL_NONE_MESSAGE);

    // 而 alpha 自己再問一次還在。
    const again = await client.slashRun('alpha', `/${GOAL_COMMAND_NAME}`);
    if (again.kind !== 'success') throw new Error(JSON.stringify(again));
    expect(again.text).toContain('目標：把測試修綠');
  });

  it('**沒先訂事件流就打 `/goal` 也接得上**——接線在共用的那條懶載入路徑上', async () => {
    // `/goal` 是第一個正確性**依賴 `attachSession` 跑過**的命令：`/plan` 的狀態活在
    // `apply` 閉包裡，沒有接線這一步。而這整套測試（含 `slash-wire.test.ts`）一直都是
    // 先 `openEvents` 再發派，所以「先發派」這個順序從來沒有人走過。
    //
    // 接線要是掛在事件流那個 endpoint 上，這裡收到的會是 `GOAL_NOT_ATTACHED_MESSAGE`
    // ——一句為了排除這種情況而寫的錯誤，出現在一條合法的路徑上。
    running = await runServe({ argv: ['--port', '0'], log: () => undefined, env: {} });
    const started = running as RunningServe;
    const client = await serveClient(started);

    const created = await client.slashRun('gamma', `/${GOAL_COMMAND_NAME} 把測試修綠`);
    if (created.kind !== 'success') throw new Error(JSON.stringify(created));
    expect(created.text).toContain('目標建好了');
    expect(created.text).not.toContain(GOAL_NOT_ATTACHED_MESSAGE);
  });
});

/**
 * **這一條同時是 [#113](https://github.com/DemianLi/nexus-agent/issues/113) 的對照組。**
 * CLI 與 eval 那兩個入口把核准關掉了（收不了決定，停下來只會作廢一整輪），而
 * `serve` 這條刻意維持開著——瀏覽器那端真的按得下去。兩邊的差別是選的不是漏的，
 * 而這條是「serve 沒有跟著關掉」的證據：它整條走過提問 → 停住 → 按核准 → 收結果。
 * 它紅了而 `cli.test.ts` 的「CLI 的核准政策」還綠著，代表關錯了入口。
 */
describe('核准那份清單', () => {
  it('docs/operations.md 寫的那道指令真的停得下來，也接得回去', async () => {
    running = await runServe({
      // **fixture 是從 `docs/operations.md` 讀進來的，不是抄的**（#490）——文件教人跑的那道
      // 指令改了路徑，這一條會當場紅。開發計劃 Phase 5 的驗收句共用同一份：預設清單不觸發
      // 任何中斷，少了它「核准工具」那半句在瀏覽器裡跑不出來。
      argv: ['--port', '0', '--plugins', documentedFixture()],
      log: () => undefined,
      env: {},
    });
    const started = running as RunningServe;
    const client = await serveClient(started);
    const events = await client.openEvents('gated');
    await client.runStart('gated', '把這句話回聲一次。');

    let state: ConversationState = appendHumanTurn(emptyConversation(), '把這句話回聲一次。');
    const drainUntil = async (done: (current: ConversationState) => boolean) => {
      while (!done(state)) {
        const next = await events.next();
        if (next.done === true) {
          break;
        }
        state = reduceConversation(state, next.value);
      }
    };

    await drainUntil((current) => current.status === 'awaiting-input');
    const pending = approvalAt(state.pendings);
    expect(pending.actions.map((action) => action.name)).toEqual(['echo']);
    expect(pending.allowedDecisions).toEqual(['approve', 'reject']);
    // 停住的時候工具還沒跑——不然這條驗的只是「畫面上有張卡片」。卡本身是有的：照 dsh，`tool/call`
    // 在核准之前就記，pump 照它開卡（#297）；還沒跑的樣子是執行中、沒有結果文字。
    expect(
      state.entries
        .filter((entry) => entry.kind === 'tool')
        .map((entry) => (entry.kind === 'tool' ? [entry.name, entry.status, entry.text] : [])),
    ).toEqual([['echo', 'running', undefined]]);

    state = appendDecision(state, pending.interruptId, 'approve');
    await client.inputRespond('gated', {
      namespace: [...pending.namespace],
      interrupt_id: pending.interruptId,
      response: uniformDecisions(pending, 'approve'),
    });

    // 核准之後 echo 真的跑了。**不能只等 idle**：中斷那一輪自己也發 completed。
    await drainUntil((current) =>
      current.entries.some((entry) => entry.kind === 'tool' && entry.status === 'done'),
    );
    expect(
      state.entries
        .filter((entry) => entry.kind === 'tool')
        .map((entry) => (entry.kind === 'tool' ? [entry.name, entry.status] : [])),
    ).toEqual([['echo', 'done']]);
  });
});
