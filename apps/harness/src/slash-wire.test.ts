/**
 * 斜線命令那一條線：從瀏覽器端的 client，走真的 handler，到真的命令註冊表。
 *
 * **這一組驗的核心不是「打得到」，是「發派面明文保證序列」**
 * （[#123](https://github.com/DemianLi/nexus-agent/issues/123)）。
 *
 * `@nexus/plugin-plan-mode` 的偏離註記押著一句話：`/plan` 改的是 graph state，而
 * LangGraph JS 沒有「在 invoke 之外寫 state」，所以退到「plugin 內持一格 pending
 * intent，`beforeAgent` 在下一次 invoke 開頭交出去」——**那個退法的誠實性建立在
 * 「命令一定跑在兩輪之間」上**。REPL 裡那句話是白送的（readline 一行一輪）；這條線
 * 上不是：命令可以在 run 飛在半空時到、可以在 thread 停在核准點時到、可以兩個分頁同時
 * 到。三種都在這裡走一遍。
 *
 * 兩個最容易假綠的地方，各配了對照：
 *
 * - 「日誌裡一個字都沒有」（認不得的一行）配著「認得的那一行留下一對」——不然
 *   「命令根本沒發派出去」也長這樣。
 * - 「並行的第二個被拒」配著「第一個真的成功了」與「日誌裡只有一對」——不然
 *   「兩個都被擋掉」也長這樣。
 */

import type { NexusPlugin, SessionLog } from '@nexus/core';
import { createCommandsInvariantPlugin } from '@nexus/plugin-commands/invariant';
import { createEchoPlugin } from '@nexus/plugin-echo';
import {
  PLAN_ALREADY_ACTIVE_MESSAGE,
  PLAN_ARGS_ERROR_MESSAGE,
  PLAN_COMMAND_NAME,
  PLAN_ENTERED_MESSAGE,
} from '@nexus/plugin-plan-mode';
import { createWireClient } from '@nexus/wire';
import type { WireClient } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_PLUGINS, createCliAgent } from './cli.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const BASE_URL = 'http://slash.test';

interface Wired {
  readonly client: WireClient;
  /** 這條 thread 的日誌。**開線之後才有**——pump 是 lazy 建的。 */
  log(): SessionLog;
  readonly violations: readonly string[];
  close(): Promise<void>;
}

let opened: Wired | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

/**
 * 起一條完整的線：真的組裝、真的 handler、真的 client，零 port 零憑證。
 *
 * 日誌是從 `attachTelemetry` 那條縫拿的——**那是組裝點唯一看得到 pump 那份日誌的地方**
 * （`ThreadAgent` 的說明），拿它當觀測點不需要在 handler 上開新的洞。
 */
async function wire(plugins: readonly NexusPlugin[] = DEFAULT_PLUGINS): Promise<Wired> {
  const violations: string[] = [];
  const built = await createCliAgent({ live: false }, plugins, undefined, (error) =>
    violations.push(error.message),
  );
  let captured: SessionLog | undefined;
  const handler = createWireHandler({
    createAgent: async () => ({
      agent: built.agent as unknown as PumpAgent,
      commands: built.commands,
      dispose: built.dispose,
      attachTelemetry: (log) => {
        captured = log;
        return undefined;
      },
      attachInvariants: built.attachInvariants,
    }),
  });
  const client = createWireClient({
    baseUrl: BASE_URL,
    fetch: async (input, init) => handler.handle(new Request(input as string, init)),
  });
  const wired: Wired = {
    client,
    log: () => {
      if (captured === undefined) throw new Error('這條 thread 還沒建起來');
      return captured;
    },
    violations,
    close: () => handler.close(),
  };
  opened = wired;
  return wired;
}

/** 日誌裡的命令事件，照原順序。 */
function commandEvents(log: SessionLog): readonly { type: string; data: unknown }[] {
  return log.events
    .filter((event) => event.type.startsWith('command/'))
    .map((event) => ({ type: event.type, data: event.data }));
}

describe('打得到 /plan', () => {
  it('預設清單就打得到，回的是計劃模式自己那句話', async () => {
    const { client } = await wire();
    // 開線＝建 thread。上行都排在下行之後，跟 `use-conversation` 同一條規矩。
    await client.openEvents('t');

    const entered = await client.slashRun('t', `/${PLAN_COMMAND_NAME}`);
    expect(entered).toEqual({
      kind: 'success',
      command_id: expect.any(String),
      text: PLAN_ENTERED_MESSAGE,
    });
  });

  it('第二次打的是同一個註冊表——執行器是一條 thread 一個，不是一次請求一個', async () => {
    const { client } = await wire();
    await client.openEvents('t');

    await client.slashRun('t', `/${PLAN_COMMAND_NAME}`);
    const again = await client.slashRun('t', `/${PLAN_COMMAND_NAME}`);
    // 一次請求一個執行器的話，plugin 那格 pending intent 也會是新的，這裡就會拿到
    // 「開了」而不是「本來就開著」。**同一個方向按第二次是 noop，而 noop 是成功**
    // （`/plan` 的三值裡沒有「已經那樣了所以算失敗」這一格），所以判準在 `text` 上。
    expect(again).toEqual({
      kind: 'success',
      command_id: expect.any(String),
      text: PLAN_ALREADY_ACTIVE_MESSAGE,
    });
  });

  it('參數不合法是命令自己的錯，不是這條線的錯', async () => {
    const { client } = await wire();
    await client.openEvents('t');
    const result = await client.slashRun('t', `/${PLAN_COMMAND_NAME} of`);
    expect(result).toEqual({
      kind: 'error',
      command_id: expect.any(String),
      text: PLAN_ARGS_ERROR_MESSAGE,
    });
  });
});

describe('清單', () => {
  it('線上看得到 /plan，看不到 /exit 也看不到 /help', async () => {
    const { client } = await wire();
    await client.openEvents('t');

    const listed = await client.slashList('t');
    if (listed.kind !== 'ok') throw new Error(listed.message);
    const names = listed.commands.map((command) => command.name);
    expect(names).toContain(PLAN_COMMAND_NAME);
    // `/exit` 與 `/help` 是 REPL 那個發派面自己的（[#122](https://github.com/DemianLi/nexus-agent/pull/122)）：
    // 瀏覽器裡沒有東西可以 exit，而清單自己就是 help。
    expect(names).not.toContain('exit');
    expect(names).not.toContain('help');
  });

  it('同一條 thread 上兩次拿到的清單一模一樣', async () => {
    // **這是「不需要 `commands/change`」那個宣稱的主詞。** dsh 有 `ScopedLayers` 與執行期
    // 的 effect disposer，清單真的會變；我們的註冊全發生在組裝期。沒有這條，那個宣稱
    // 就沒有東西在守（[#108](https://github.com/DemianLi/nexus-agent/issues/108)）。
    const { client } = await wire();
    await client.openEvents('t');

    const first = await client.slashList('t');
    await client.slashRun('t', `/${PLAN_COMMAND_NAME}`);
    const second = await client.slashList('t');
    expect(second).toEqual(first);
  });

  it('`formatCommandHelp` 與 `assertNoReplNameCollision` 沒有被搬出 cli.ts', async () => {
    // 那兩個是 REPL 發派面自己的（`/help` 要把 `/exit` 補回清單裡、撞名要當場擋）。
    // **一旦它們被匯出，這條線就會有人拿去重用**——而那正好會把 `/exit` 與 `/help`
    // 帶進瀏覽器的清單裡。
    const cli: Record<string, unknown> = await import('./cli.js');
    expect(Object.keys(cli)).not.toContain('formatCommandHelp');
    expect(Object.keys(cli)).not.toContain('assertNoReplNameCollision');
  });
});

describe('認不得的一行', () => {
  it('回 unknown，而且日誌裡一個字都沒留', async () => {
    const wired = await wire();
    await wired.client.openEvents('t');

    expect(await wired.client.slashRun('t', '/nope')).toEqual({ kind: 'unknown' });
    // `/planning` 不是 `/plan`——`parseCommand` 的 lookahead 就是為了這個。
    expect(await wired.client.slashRun('t', '/planning')).toEqual({ kind: 'unknown' });
    expect(commandEvents(wired.log())).toEqual([]);

    // **對照組**：認得的那一行留下一對。少了它，「命令根本沒發派出去」也是空日誌。
    await wired.client.slashRun('t', `/${PLAN_COMMAND_NAME}`);
    expect(commandEvents(wired.log()).map((event) => event.type)).toEqual([
      'command/run',
      'command/done',
    ]);
    expect(wired.violations).toEqual([]);
  });
});

describe('序列', () => {
  it('run 在飛的時候不收斜線命令，而且說得出為什麼', async () => {
    const wired = await wire();
    await wired.client.openEvents('t');

    // `run.start` 回的是收件回條——它回來的時候那一輪還在飛（`ThreadPump` 的 `running`
    // 是在 `submit` 裡同步就翻的，正是為了這一刻）。
    await wired.client.runStart('t', '把這句話回聲一次。');
    const rejected = await wired.client.slashRun('t', `/${PLAN_COMMAND_NAME}`);
    expect(rejected).toEqual({ kind: 'rejected', message: expect.stringContaining('正在跑') });
    // 被拒的那一次不進日誌：它從來沒有進過 handler。
    expect(commandEvents(wired.log())).toEqual([]);
  });

  it('停在核准點的時候也不收', async () => {
    const gate: NexusPlugin = {
      name: 'gate-everything',
      apply: (registry) =>
        void registry.approvals.gate(() => ({ kind: 'ask', reason: '先給人看過' })),
    };
    const wired = await wire([...DEFAULT_PLUGINS, gate]);
    const events = await wired.client.openEvents('t');
    await wired.client.runStart('t', '把這句話回聲一次。');
    for await (const event of events) {
      if (event.method === 'input.requested') break;
    }

    const rejected = await wired.client.slashRun('t', `/${PLAN_COMMAND_NAME}`);
    expect(rejected).toEqual({
      kind: 'rejected',
      message: expect.stringContaining('停在核准點'),
    });
  });

  it('兩個分頁同時打：一個做完，一個被拒，日誌裡只有一對', async () => {
    // **這一條是這張卡的重點。** `handle()` 是一次請求一次呼叫，本身沒有序列性——
    // 放行的話兩次執行會在日誌裡交錯，而 `@nexus/plugin-commands` 的配套入口會把那件事
    // 報成違規（執行器的檔頭寫著那不是誤報）。
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const slow: NexusPlugin = {
      name: 'slow-command',
      apply: (registry) =>
        void registry.commands.register({
          name: 'slow',
          description: '等人放行才回來。',
          handler: async () => {
            entered?.();
            await new Promise<void>((resolve) => (release = resolve));
            return { kind: 'success', text: '放行了。' };
          },
        }),
    };
    const wired = await wire([createEchoPlugin(), createCommandsInvariantPlugin(), slow]);
    await wired.client.openEvents('t');

    const first = wired.client.slashRun('t', '/slow');
    await started;
    const second = await wired.client.slashRun('t', '/slow');
    expect(second).toEqual({ kind: 'rejected', message: expect.stringContaining('已經有一個') });

    // 被擋住的時候 `run.start` 也一樣——`/plan` 那格 pending intent 不能跟飛行中那一輪
    // 的 `beforeAgent` 賽跑，所以這道閘是雙向的。
    const blocked = await wired.client.runStart('t', '一句話');
    expect(blocked).toEqual({
      type: 'error',
      id: expect.any(Number),
      error: 'invalid_argument',
      message: expect.stringContaining('正在跑一個斜線命令'),
    });

    // **`input.respond` 這條路不必再擋一次，而這是那句話的絆索。** 斜線命令在飛的
    // 時候，這條 thread 一定不是停在核准點的（發派時就檢查了），而 `run.start` 已經
    // 被擋住、沒有第二個 run 起得來去掛新的中斷——所以這裡永遠沒有中斷可以回答。
    // 那道保證哪天鬆掉，這一條會先紅。
    const noInterrupt = await wired.client.inputRespond('t', {
      namespace: [],
      interrupt_id: 'int-1',
      response: { decisions: [{ type: 'approve' }] },
    });
    expect(noInterrupt).toMatchObject({ type: 'error', error: 'no_such_interrupt' });

    release?.();
    expect(await first).toEqual({
      kind: 'success',
      command_id: expect.any(String),
      text: '放行了。',
    });
    // 一對，不是兩對，也不是交錯的兩對。
    expect(commandEvents(wired.log()).map((event) => event.type)).toEqual([
      'command/run',
      'command/done',
    ]);
    expect(wired.violations).toEqual([]);
  });
});
