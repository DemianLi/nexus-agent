import { GOAL_COMMAND_NAME, GOAL_NONE_MESSAGE } from '@nexus/plugin-goal';
import { PLAN_COMMAND_NAME, PLAN_ENTERED_MESSAGE } from '@nexus/plugin-plan-mode';
import { createWireClient } from '@nexus/wire';
import {
  appendDecision,
  appendHumanTurn,
  emptyConversation,
  reduceConversation,
  uniformDecisions,
} from '@nexus/wire';
import type { ConversationState } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';
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
    expect(parseServeArgs([])).toEqual({ live: false, port: DEFAULT_PORT, help: false });
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

    const client = createWireClient({ baseUrl: started.url });
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
    const client = createWireClient({ baseUrl: started.url });
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
    const client = createWireClient({ baseUrl: started.url });
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
});

/**
 * **這一條同時是 [#113](https://github.com/DemianLi/nexus-agent/issues/113) 的對照組。**
 * CLI 與 eval 那兩個入口把核准關掉了（收不了決定，停下來只會作廢一整輪），而
 * `serve` 這條刻意維持開著——瀏覽器那端真的按得下去。兩邊的差別是選的不是漏的，
 * 而這條是「serve 沒有跟著關掉」的證據：它整條走過提問 → 停住 → 按核准 → 收結果。
 * 它紅了而 `cli.test.ts` 的「CLI 的核准政策」還綠著，代表關錯了入口。
 */
describe('核准那份清單', () => {
  it('README 寫的那道指令真的停得下來，也接得回去', async () => {
    running = await runServe({
      // README 與開發計劃 Phase 5 驗收句共用這一份 —— 預設清單不觸發任何中斷，
      // 少了它「核准工具」那半句在瀏覽器裡跑不出來。
      argv: ['--port', '0', '--plugins', 'src/approval.fixture.ts'],
      log: () => undefined,
      env: {},
    });
    const started = running as RunningServe;
    const client = createWireClient({ baseUrl: started.url });
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
    const pending = state.pending;
    if (pending === undefined) throw new Error('沒有掛著的核准請求');
    expect(pending.actions.map((action) => action.name)).toEqual(['echo']);
    expect(pending.allowedDecisions).toEqual(['approve', 'reject']);
    // 停住的時候工具還沒跑——不然這條驗的只是「畫面上有張卡片」。
    expect(state.entries.filter((entry) => entry.kind === 'tool')).toEqual([]);

    state = appendDecision(state, 'approve');
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
