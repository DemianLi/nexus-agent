/**
 * `sessions` 通道的接線，**兩條進入點各驗一次**。
 *
 * 這一檔存在的理由與 [`session-log-paths.test.ts`](./session-log-paths.test.ts) 同型：
 * `@nexus/core` 那側的測試證得了 runner 對，證不了**兩條進入點真的呼叫它**。而這個通道
 * 漏掉任何一條的下場特別安靜——CLI 漏了就是打了指令沒反應，web 漏了就是每個 thread 的
 * 域狀態不存在，兩種都不會紅。
 *
 * @see [#126](https://github.com/DemianLi/nexus-agent/issues/126)
 */

import { PassThrough } from 'node:stream';

import { createEchoPlugin } from '@nexus/plugin-echo';
import { createGoalPlugin, GOAL_CLEARED_MESSAGE, GOAL_COMMAND_NAME } from '@nexus/plugin-goal';
import { SessionLog } from '@nexus/core';
import { createWireClient } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { createCliAgent, runCli } from './cli.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const MODEL = (): ScriptedChatModel => new ScriptedChatModel({ turns: [{ content: '好的。' }] });

/** 收 stdout / stderr 的 printer，形狀照 `cli.test.ts` 那份。 */
function recorder(): {
  printer: {
    log: (line: string) => void;
    error: (line: string) => void;
    write: (chunk: string) => void;
  };
  stdout: () => string;
  stderr: () => string;
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    printer: {
      log: (line) => out.push(line),
      error: (line) => err.push(line),
      write: (chunk) => out.push(chunk),
    },
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
  };
}

describe('組裝點', () => {
  it('沒有人 join 就回 undefined——沒有參與者不在熱路徑上多掛訂閱', async () => {
    const { attachSession, dispose } = await createNexusAgent({
      model: MODEL(),
      plugins: [createEchoPlugin()],
    });
    try {
      expect(attachSession(new SessionLog('none'))).toBeUndefined();
    } finally {
      await dispose();
    }
  });

  it('有人 join 就接得起來，交出去的是呼叫端給的那一份日誌', async () => {
    const plugin = createGoalPlugin();
    const { attachSession, dispose } = await createNexusAgent({
      model: MODEL(),
      plugins: [createEchoPlugin(), plugin],
    });
    try {
      const log = new SessionLog('one');
      const detach = attachSession(log);
      expect(detach).toBeDefined();
      expect(plugin.attached()).toHaveLength(1);
      plugin.serviceFor(log)?.create({ objective: '接上了' });
      expect(log.events.map((event) => event.type)).toEqual(['goal/change']);
      detach?.();
      expect(plugin.attached()).toEqual([]);
    } finally {
      await dispose();
    }
  });
});

describe('CLI 那條', () => {
  it('`runCli` 真的接了——安裝當下寫的那一筆被已經在看的檢查看到', async () => {
    // 觀測點是 fixture 裡那個一看到 `goal/change` 就吭聲的配套入口，理由見它的檔頭。
    // 這一行印得出來，同時證了四件事：參與者裝上了、它寫得動日誌、它在安裝當下就讀得
    // 回自己寫的東西（`GoalService.create()` append 完會立刻讀自己的折疊——`observe()`
    // 要是等這一輪裝完才生效，那一行會拋，參與者整個不算，這裡就是空的），以及接線順序
    // 是「不變量先、參與者後」——反過來的話，安裝期寫的那一筆沒有人在看。
    const { printer, stderr } = recorder();
    await runCli({
      argv: ['--plugins', 'src/cli-session-participant.fixture.ts', '說點什麼'],
      input: new PassThrough(),
      output: new PassThrough(),
      printer,
    });
    expect(stderr()).toContain(
      '[不變量] invariant violated by "@nexus/goal-probe": 看到 goal/change',
    );
  });

  it('**REPL 裡打 `/goal` 真的動得了那一份日誌**——預設清單，不帶 `--plugins`', async () => {
    // 這是 [#126](https://github.com/DemianLi/nexus-agent/issues/126) 在 CLI 這條路上的
    // 端到端驗收，而它必須走 `runCli`：上面那條證的是「參與者裝上了」，證不了「人打的
    // 那一行找得到它」。中間那一段是 `apply` 閉包裡的那一格，只有真的發派一次才走得到。
    const { printer, stdout } = recorder();
    const input = new PassThrough();
    input.end(`/${GOAL_COMMAND_NAME} 把測試修綠
/${GOAL_COMMAND_NAME}
/${GOAL_COMMAND_NAME} clear
/exit
`);
    await runCli({ argv: [], input, output: new PassThrough(), printer });

    const text = stdout();
    expect(text).toContain('目標建好了');
    expect(text).toContain('目標：把測試修綠');
    // 第二行是查看：狀態還在，代表它讀的是同一份折疊而不是每次重來。
    expect(text).toContain('狀態：進行中');
    expect(text).toContain(GOAL_CLEARED_MESSAGE);
    // **模型一次都沒被叫到**——命令不進模型。假模型的第一輪是回聲，它沒出現。
    expect(text).not.toContain('回聲：');
  });
});

describe('web 那條', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('每個 thread 的日誌各接一次——`wire-handler` 沒有把它丟掉', async () => {
    const plugin = createGoalPlugin();
    const built = await createCliAgent({ live: false }, [createEchoPlugin(), plugin]);
    const handler = createWireHandler({
      createAgent: async () => ({
        agent: built.agent as unknown as PumpAgent,
        commands: built.commands,
        dispose: built.dispose,
        attachSession: built.attachSession,
      }),
    });
    close = () => handler.close();
    const client = createWireClient({
      baseUrl: 'http://session-participants.test',
      fetch: async (input, init) => handler.handle(new Request(input as string, init)),
    });

    expect(plugin.attached()).toEqual([]);
    await client.openEvents('t1');
    expect(plugin.attached()).toHaveLength(1);
    await client.openEvents('t2');
    // **一個 thread 一份日誌，所以是兩個服務不是一個**——這正是服務綁日誌而不是綁
    // registry 的理由。
    expect(plugin.attached()).toHaveLength(2);
  });
});
