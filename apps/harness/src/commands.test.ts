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
import { createCliAgent, DEFAULT_PLUGINS, formatCommandHelp, runRepl } from './cli.js';
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

/** 註冊一個指定名字的命令，專門用來撞 REPL 自己那兩個名字。 */
function helpNamedPlugin(name: string): NexusPlugin {
  return {
    name: `owns-${name}`,
    apply(registry) {
      registry.commands.register({
        name,
        description: '故意撞名',
        handler: () => ({ kind: 'success' }),
      });
    },
  };
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

/**
 * `/help`：**探索面歸發派它的那一側**。
 *
 * dsh 沒有 `/help`（它的探索面是 composer 的 `/` 選單），所以這裡沒有可抄的行為，只有
 * 可抄的資料來源。真正要守的是三件事：清單裡有 `commands.list()` 看不到的那兩個、
 * 模型完全沒被驚動、以及**日誌乾淨**——`/help` 不是一次命令執行，不該留下 `command/*`。
 */
describe('/help', () => {
  it('列出註冊的命令，**並補上 `list()` 看不到的 `/exit` 與 `/help`**', async () => {
    const seen: string[] = [];
    const { stdout } = await feed(
      [createEchoPlugin(), pingPlugin(seen, { kind: 'success', text: 'pong' })],
      '/help\n/exit\n',
    );

    expect(stdout).toContain('/ping [任何字]');
    expect(stdout).toContain('回一句話，不驚動模型');
    // 這兩個永遠不在 `commands.list()` 裡——它們是 REPL 自己的。
    expect(stdout).toContain('/exit');
    expect(stdout).toContain('/help');
    // handler 沒被叫到（`/help` 不走執行器），模型也沒被叫到。
    expect(seen).toEqual([]);
    expect(stdout).not.toContain('回聲：');
  });

  it('一個命令都沒註冊時，還是印得出 REPL 自己那兩行', async () => {
    // `createEchoPlugin()` 只註冊工具，不註冊命令。
    const { stdout } = await feed([createEchoPlugin()], '/help\n/exit\n');
    expect(stdout).toContain('/exit');
    expect(stdout).toContain('/help');
    expect(stdout).not.toContain('回聲：');
  });

  it('**日誌裡沒有 `command/*`**——`/help` 不是一次命令執行', async () => {
    const seen: string[] = [];
    const { events } = await feed(
      [createEchoPlugin(), pingPlugin(seen, { kind: 'success', text: 'pong' })],
      '/help\n/exit\n',
    );
    expect(events.filter((event) => event.type.startsWith('command/'))).toEqual([]);
    // 也沒有變成一輪對話。
    expect(events.filter((event) => event.type === 'turn/start')).toEqual([]);
  });

  it('`/help 怎麼用` 照樣是求助，**不掉回模型**', async () => {
    const seen: string[] = [];
    const { stdout } = await feed(
      [createEchoPlugin(), pingPlugin(seen, { kind: 'success', text: 'pong' })],
      '/help 怎麼用\n/exit\n',
    );
    expect(stdout).toContain('/ping');
    expect(stdout).not.toContain('回聲：');
  });

  it('`/helper` 不是 `/help`——它掉回模型', async () => {
    const seen: string[] = [];
    const { stdout } = await feed(
      [createEchoPlugin(), pingPlugin(seen, { kind: 'success', text: 'pong' })],
      '/helper\n/exit\n',
    );
    expect(stdout).toContain('回聲：嗨');
  });

  it('排版：一張表排序，左欄對齊', () => {
    const lines = formatCommandHelp([
      { name: 'plan', description: '進入或離開計劃模式', input: { hint: '[off]' } },
      { name: 'zebra', description: '最後一個' },
    ]);
    expect(lines[0]).toBe('命令：');
    // `exit` / `help` 併進同一張表一起排序，不是另起一段。
    expect(lines.slice(1).map((line) => line.trim().split(/\s+/u)[0])).toEqual([
      '/exit',
      '/help',
      '/plan',
      '/zebra',
    ]);
    // 描述欄起點對齊在最長的那一行上（`/plan [off]`）。
    const starts = lines.slice(1).map((line) => line.indexOf(line.trim().split(/\s\s+/u).at(-1)!));
    expect(new Set(starts).size).toBe(1);
  });
});

describe('REPL 自己那兩個名字撞不得', () => {
  it('plugin 註冊了 `help` → **REPL 開起來就拋**，不是靜默被遮蔽', async () => {
    const { agent, commands, sessionLog } = await replFor([
      createEchoPlugin(),
      pingPlugin([], { kind: 'success' }),
      helpNamedPlugin('help'),
    ]);
    const input = new PassThrough();
    input.end('/exit\n');
    await expect(
      runRepl(
        agent,
        { input, output: new PassThrough() },
        recorder().printer,
        sessionLog,
        commands,
      ),
    ).rejects.toThrow(/"help"/u);
  });

  it('`exit` 也一樣——**這個洞在 `/help` 之前就在了**', async () => {
    const { agent, commands, sessionLog } = await replFor([
      createEchoPlugin(),
      helpNamedPlugin('exit'),
    ]);
    const input = new PassThrough();
    input.end('/exit\n');
    await expect(
      runRepl(
        agent,
        { input, output: new PassThrough() },
        recorder().printer,
        sessionLog,
        commands,
      ),
    ).rejects.toThrow(/"exit"/u);
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
