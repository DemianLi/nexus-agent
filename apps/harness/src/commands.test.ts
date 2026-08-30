/**
 * 人的命令，**在真的 REPL 裡**。
 *
 * `packages/nexus-plugin-commands` 那兩個檔案驗的是解析、執行與配對關係；這裡驗的是
 * 接線 —— 一行 `/name` 到底走了哪條路。三條路都要有人守：跑 handler、掉回模型、
 * 收工。少了「掉回模型」那一條，一個把所有斜線行都吞掉的實作照樣會綠。
 *
 * 對應 [#118](https://github.com/DemianLi/nexus-agent/issues/118)。
 */

import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { SessionLog } from '@nexus/core';
import type { NexusPlugin, SessionEvent } from '@nexus/core';
import { createEchoPlugin, ECHO_TOOL_NAME } from '@nexus/plugin-echo';

import { createNexusAgent } from './agent-factory.js';
import { createCliAgent, DEFAULT_PLUGINS, runRepl } from './cli.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';

/** 一輪：叫一次 echo 就收工。腳本只有這一輪，**第二輪會拋**。 */
const ONE_TURN: readonly ScriptedTurn[] = [
  { content: '回聲一下。', toolCalls: [{ name: ECHO_TOOL_NAME, args: { message: '嗨' } }] },
  { content: '好了。' },
];

function recorder() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    printer: {
      log: (line: string) => void out.push(line),
      error: (line: string) => void err.push(line),
    },
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
  };
}

/** 註冊一個 `/ping` 的 plugin，並記下它被叫到時收到什麼。 */
function pingPlugin(seen: string[], result: { kind: 'success' | 'error'; text?: string }) {
  const plugin: NexusPlugin = {
    name: 'ping',
    apply(registry) {
      registry.commands.register({
        name: 'ping',
        description: '回一句話，不驚動模型',
        input: { hint: '[任何字]' },
        handler: ({ rawInput }) => {
          seen.push(rawInput);
          return result as { kind: 'success'; text?: string };
        },
      });
    },
  };
  return plugin;
}

async function replFor(plugins: readonly NexusPlugin[]) {
  const { agent, commands } = await createNexusAgent({
    model: new ScriptedChatModel({ turns: ONE_TURN }),
    plugins,
  });
  const sessionLog = new SessionLog('t');
  const events: SessionEvent[] = [];
  sessionLog.subscribe((event) => events.push(event));
  return { agent, commands, sessionLog, events };
}

/** 餵幾行進 REPL，回它印出來的東西與日誌。 */
async function feed(plugins: readonly NexusPlugin[], lines: string) {
  const { agent, commands, sessionLog, events } = await replFor(plugins);
  const { printer, stdout, stderr } = recorder();
  const input = new PassThrough();
  input.end(lines);
  await runRepl(agent, { input, output: new PassThrough() }, printer, sessionLog, commands);
  return { stdout: stdout(), stderr: stderr(), events, commands };
}

describe('一行 `/name` 走哪條路', () => {
  it('註冊過的命令跑 handler，**模型一次都沒被叫到**', async () => {
    const seen: string[] = [];
    const { stdout } = await feed(
      [createEchoPlugin(), pingPlugin(seen, { kind: 'success', text: 'pong' })],
      '/ping 哈囉\n/exit\n',
    );

    expect(seen).toEqual([' 哈囉']);
    expect(stdout).toContain('pong');
    // 模型只有一輪腳本。命令若被送進模型，這裡會看到 echo 的輸出。
    expect(stdout).not.toContain('回聲：');
  });

  it('**不認得的斜線行照樣送給模型**——這一行的行為跟接上命令之前一模一樣', async () => {
    const seen: string[] = [];
    const { stdout } = await feed(
      [createEchoPlugin(), pingPlugin(seen, { kind: 'success', text: 'pong' })],
      '/nope 隨便\n/exit\n',
    );

    expect(seen).toEqual([]);
    expect(stdout).toContain('回聲：嗨');
  });

  it('`/pinging` 不是 `/ping`——它掉回模型', async () => {
    const seen: string[] = [];
    const { stdout } = await feed(
      [createEchoPlugin(), pingPlugin(seen, { kind: 'success', text: 'pong' })],
      '/pinging\n/exit\n',
    );

    expect(seen).toEqual([]);
    expect(stdout).toContain('回聲：嗨');
  });

  it('普通一句話還是送給模型', async () => {
    const seen: string[] = [];
    const { stdout } = await feed(
      [createEchoPlugin(), pingPlugin(seen, { kind: 'success', text: 'pong' })],
      '說點什麼\n/exit\n',
    );
    expect(seen).toEqual([]);
    expect(stdout).toContain('回聲：嗨');
  });

  it('`/exit` 收工，而且**它不在 `list()` 裡**——它控制的是 REPL 不是 agent', async () => {
    const seen: string[] = [];
    const { commands } = await feed(
      [createEchoPlugin(), pingPlugin(seen, { kind: 'success', text: 'pong' })],
      '/exit\n',
    );
    expect(commands.list().map((entry) => entry.name)).toEqual(['ping']);
  });
});

describe('結果印去哪裡', () => {
  it('失敗的命令印進 stderr，而且**不關掉 REPL**', async () => {
    const seen: string[] = [];
    const { stdout, stderr } = await feed(
      [createEchoPlugin(), pingPlugin(seen, { kind: 'error', text: '這個命令現在不能用' })],
      '/ping\n說點什麼\n/exit\n',
    );

    expect(stderr).toContain('這個命令現在不能用');
    // 下一句還問得出去。
    expect(stdout).toContain('回聲：嗨');
  });

  it('沒話說的成功什麼都不印', async () => {
    const seen: string[] = [];
    const { stdout, stderr } = await feed(
      [createEchoPlugin(), pingPlugin(seen, { kind: 'success' })],
      '/ping\n/exit\n',
    );
    expect(seen).toEqual(['']);
    expect(stdout).toBe('');
    expect(stderr).toBe('');
  });
});

describe('日誌', () => {
  it('跑過的命令留下一對事件，掉回模型的那行不留', async () => {
    const seen: string[] = [];
    const { events } = await feed(
      [createEchoPlugin(), pingPlugin(seen, { kind: 'success', text: 'pong' })],
      '/ping\n/nope\n/exit\n',
    );

    const commandEvents = events.filter((event) => event.type.startsWith('command/'));
    expect(commandEvents.map((event) => event.type)).toEqual(['command/run', 'command/done']);
    // `/nope` 那行走的是模型，所以日誌裡有它的 turn 而沒有它的 command。
    expect(events.some((event) => event.type === 'turn/start')).toBe(true);
  });
});

describe('預設組裝', () => {
  it('配套入口真的接上了，而且一段正常的命令流不誤報', async () => {
    const violations: string[] = [];
    const { dispose, sessionLog, attachInvariants } = await createCliAgent(
      { live: false },
      DEFAULT_PLUGINS,
      undefined,
      (error) => violations.push(error.message),
    );
    try {
      const detach = attachInvariants(sessionLog);
      expect(detach).toBeDefined();

      sessionLog.append('command/run', {
        commandId: 'cmd-1',
        name: 'ping',
        args: '',
        source: { kind: 'user' },
      });
      sessionLog.append('command/done', { commandId: 'cmd-1', kind: 'success' });
      expect(violations).toEqual([]);

      // **同一條線上手動製造一次缺陷**：接上去了才報得出來，這一句是在證明上面那個
      // 「不誤報」不是因為沒人在看。
      sessionLog.append('command/done', { commandId: 'cmd-幽靈', kind: 'success' });
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('@nexus/plugin-commands');

      // **第二種缺陷：漏掉一顆 `command/done`。** 這個形狀值得單獨釘一次，因為
      // 「done 配得到 run」那一條**抓不到它**——漏掉的是 done，懸空的是 run。抓到它的
      // 是序列性那一條，而且要等下一次執行來才踩得到。
      sessionLog.append('command/run', {
        commandId: 'cmd-2',
        name: 'ping',
        args: '',
        source: { kind: 'user' },
      });
      sessionLog.append('command/run', {
        commandId: 'cmd-3',
        name: 'ping',
        args: '',
        source: { kind: 'user' },
      });
      expect(violations).toHaveLength(2);
      expect(violations[1]).toMatch(/"cmd-2" 還沒落定/);
    } finally {
      await dispose();
    }
  });
});
