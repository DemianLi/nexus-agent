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
