/**
 * 計劃模式的**行為**驗收（[#116](https://github.com/DemianLi/nexus-agent/issues/116)）。
 *
 * `packages/nexus-plugin-plan-mode` 那邊的薄測試看的是 registry 的內容；這裡看的是
 * **模型收到的 prompt** 與**跑完之後的 state**——一個 middleware 有沒有作用，只有在
 * 真的組出一個 agent、真的跑一輪之後才看得見。
 *
 * 四組，各自釘一件不同的事：
 *
 * 1. **指引**：開著才夾、關著一個字都不多、而且不會踩掉別人的 prompt。
 * 2. **`exit_plan_mode` 的三條路**：有人核准、沒人可問、不在模式裡——三種結局要分得開。
 * 3. **模式狀態活得過什麼**：同一條 thread 的下一輪、以及一次真的壓縮。
 * 4. **`prepend` 的證據**：模式外的呼叫拿到的是「不在計劃模式」，不是核准的措辭。
 * 5. **`/plan` 這條路**：人打的那一行到底有沒有讓下一輪的 prompt 變得不一樣
 *    （[#120](https://github.com/DemianLi/nexus-agent/issues/120)）。
 */

import { PassThrough } from 'node:stream';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import { Command, MemorySaver } from '@langchain/langgraph';
import { SessionLog } from '@nexus/core';
import type { NexusPlugin, SessionEvent } from '@nexus/core';
import { createEchoPlugin, ECHO_TOOL_NAME } from '@nexus/plugin-echo';
import { createMemoryPlugin } from '@nexus/plugin-memory';
import {
  createPlanModePlugin,
  DEFAULT_PLAN_GUIDANCE,
  EXIT_PLAN_MODE_TOOL_NAME,
  NOT_IN_PLAN_MODE_MESSAGE,
  PLAN_APPROVED_MESSAGE,
  PLAN_ARGS_ERROR_MESSAGE,
  PLAN_ENTERED_MESSAGE,
  PLAN_LEFT_MESSAGE,
  PLAN_MODE_STATE_KEY,
} from '@nexus/plugin-plan-mode';
import { createSummarizationMiddleware } from 'deepagents';
import { describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { runRepl } from './cli.js';
import { HEADLESS_APPROVALS } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

/** 一輪 prompt 裡的 system 訊息。指引併進的是 system prompt，不是對話。 */
function systemPrompt(messages: readonly BaseMessage[]): string {
  return messages
    .filter((message) => message.getType() === 'system')
    .map((message) => message.text)
    .join('\n');
}

/**
 * 跑完之後 state 裡的模式旗標。
 *
 * **這一層轉型是必要的，不是偷懶。** agent 的 state 型別是組裝當下靜態算出來的，而
 * 計劃模式的 key 由 plugin 在執行期經 `registry.middleware.use()` 接進去——型別上
 * 看不到它。要讓型別看得到，`createNexusAgent` 得把 plugin 的 `stateSchema` 一路帶到
 * 回傳型別上，那是另一件事。
 */
function planModeOf(state: unknown): unknown {
  return (state as Record<string, unknown>)[PLAN_MODE_STATE_KEY];
}

/** 訊息裡最後一則工具結果。 */
function lastToolMessage(messages: readonly BaseMessage[]): BaseMessage | undefined {
  return [...messages].reverse().find((message) => message.getType() === 'tool');
}

/** 一份會呼叫 `exit_plan_mode` 再收工的腳本。 */
function planScript(): ScriptedChatModel {
  return new ScriptedChatModel({
    turns: [
      {
        content: '我先規劃。',
        toolCalls: [{ name: EXIT_PLAN_MODE_TOOL_NAME, args: { plan: '# 計劃\n\n先看再改。' } }],
      },
      { content: '開始動手。' },
    ],
  });
}

describe('計劃指引進不進 system prompt', () => {
  it('startActive 開著就夾進去', async () => {
    const model = new ScriptedChatModel({ turns: [{ content: '好。' }] });
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [createPlanModePlugin({ startActive: true })],
    });

    try {
      await agent.invoke(toAgentInvocation('嗨。'));
    } finally {
      await dispose();
    }

    expect(systemPrompt(model.lastPrompt)).toContain(DEFAULT_PLAN_GUIDANCE);
  });

  /**
   * **這一條是「未激活不增加 token」那句話的執行版**（dsh
   * `packages/plan/plan-mode/README.zh.md` 的 Token 影響）。middleware 掛著、工具註冊著、
   * 但 prompt 裡一個字都沒有多——不然「掛了這個 plugin」就變成一筆每輪都在付的稅。
   */
  it('預設是關的，prompt 裡一個字都不多', async () => {
    const model = new ScriptedChatModel({ turns: [{ content: '好。' }] });
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [createPlanModePlugin()],
    });

    try {
      await agent.invoke(toAgentInvocation('嗨。'));
    } finally {
      await dispose();
    }

    expect(systemPrompt(model.lastPrompt)).not.toContain(DEFAULT_PLAN_GUIDANCE);
  });

  it('部署換掉的指引就是原樣那一段', async () => {
    const guidance = '<部署自己寫的那一段>';
    const model = new ScriptedChatModel({ turns: [{ content: '好。' }] });
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [createPlanModePlugin({ startActive: true, guidance })],
    });

    try {
      await agent.invoke(toAgentInvocation('嗨。'));
    } finally {
      await dispose();
    }

    const prompt = systemPrompt(model.lastPrompt);
    expect(prompt).toContain(guidance);
    expect(prompt).not.toContain(DEFAULT_PLAN_GUIDANCE);
  });

  /**
   * **兩段同時到得了模型。**
   *
   * 分開測的話，一個會把另一個吃掉的實作兩條都會綠，所以要同時斷言。
   *
   * **但它抓不到「取代式」的實作，這一點量過了**：計劃模式的 middleware 是
   * `prepend` 的，站在記憶**外面**，所以就算它把 `systemMessage` 整個換掉，記憶也是
   * 之後才接上去的——實測把 `concat` 改成 `new SystemMessage(guidance)`，這一條照樣綠。
   * 真正釘住 `concat` 的是下面那條「更外層的 prompt 不會被吃掉」。
   */
  it('記憶與指引在同一份 prompt 裡同時存在', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-plan-'));
    await writeFile(join(root, 'AGENTS.md'), '使用者的代號是胡桃。');
    const model = new ScriptedChatModel({ turns: [{ content: '好。' }] });

    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      plugins: [createMemoryPlugin(), createPlanModePlugin({ startActive: true })],
    });

    try {
      await agent.invoke(toAgentInvocation('嗨。'));
    } finally {
      await dispose();
    }

    const prompt = systemPrompt(model.lastPrompt);
    expect(prompt).toContain('胡桃');
    expect(prompt).toContain(DEFAULT_PLAN_GUIDANCE);
  });
  /**
   * **這一條才是 `concat` 的絆索。**
   *
   * 計劃模式站在記憶外面，所以吃不掉記憶——要證明「疊加不是取代」有意義，得放一個
   * **比它更外層**的 prompt 貢獻者。`prepend` 的 middleware 之間依註冊順序排，所以
   * 先註冊的 `marker` 更外層：它先在 system prompt 上留記號，計劃模式後跑。
   * 把 `concat` 換成取代，這個記號會靜靜消失——那正是
   * `dynamicSystemPromptMiddleware` 那條路的下場，也是刻意不用它的原因。
   */
  it('更外層的 prompt 不會被吃掉', async () => {
    const marker = '<更外層的那一段>';
    const outer: NexusPlugin = {
      name: 'outer-prompt',
      apply: (registry) =>
        void registry.middleware.use(
          {
            name: 'outerPrompt',
            wrapModelCall: (
              request: { systemMessage?: { concat: (text: string) => unknown } },
              handler: (next: unknown) => unknown,
            ) =>
              handler(
                request.systemMessage === undefined
                  ? { ...request, systemPrompt: marker }
                  : { ...request, systemMessage: request.systemMessage.concat(`\n${marker}`) },
              ),
          } as never,
          { prepend: true },
        ),
    };

    const model = new ScriptedChatModel({ turns: [{ content: '好。' }] });
    const { agent, dispose } = await createNexusAgent({
      model,
      // 順序有意義：`outer` 先註冊，所以它排在計劃模式**外面**。
      plugins: [outer, createPlanModePlugin({ startActive: true })],
    });

    try {
      await agent.invoke(toAgentInvocation('嗨。'));
    } finally {
      await dispose();
    }

    const prompt = systemPrompt(model.lastPrompt);
    expect(prompt).toContain(marker);
    expect(prompt).toContain(DEFAULT_PLAN_GUIDANCE);
  });
});

/** 一顆核准中斷在問的那幾件事。 */
function actionRequests(interrupts: unknown): { name?: string; args?: { plan?: string } }[] {
  const first = (interrupts as { value?: { actionRequests?: unknown } }[] | undefined)?.[0];
  const requests = first?.value?.actionRequests;
  return Array.isArray(requests) ? (requests as { name?: string; args?: { plan?: string } }[]) : [];
}

describe('exit_plan_mode 的三條路', () => {
  /**
   * **這一條撐著整個設計的那句話**：「人批准計劃」與「人批准這次工具呼叫」是同一件事，
   * 所以不另建評審通道。少了它那句話是空的——一個把 `plan` 丟掉的實作，
   * 「獲准之後模式關掉」照樣會綠，而按下批准的人根本沒看到要批准什麼。
   *
   * 計劃全文走的是核准請求的 `args`，`@nexus/wire` 的 `pending.actions` 原樣帶著它
   * （`conversation.ts` 的 `actions: { name, args, description }`），所以瀏覽器那端
   * 讀得到。閘門給的理由落在 `description`。
   */
  it('要批准的人看得到計劃全文', async () => {
    const model = planScript();
    const { agent, dispose } = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      plugins: [createPlanModePlugin({ startActive: true })],
    });

    try {
      const paused = await agent.invoke(toAgentInvocation('幫我改一下。'), {
        configurable: { thread_id: 'sees-plan' },
      });
      const requests = actionRequests(paused.__interrupt__);

      expect(requests.map((request) => request.name)).toEqual([EXIT_PLAN_MODE_TOOL_NAME]);
      expect(requests[0]?.args?.plan).toBe('# 計劃\n\n先看再改。');
    } finally {
      await dispose();
    }
  });

  /**
   * **有人在的時候：計劃交出去 → 停下來等 → 獲准 → 模式關掉。**
   *
   * 「人批准計劃」與「人批准這次工具呼叫」是同一件事，所以這裡走的就是
   * [#113](https://github.com/DemianLi/nexus-agent/issues/113) 已經有的那條核准迴圈，
   * 沒有第二套評審通道。
   */
  it('獲准 → 模式關掉，下一輪的 prompt 沒有指引了', async () => {
    const model = planScript();
    const { agent, dispose } = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      plugins: [createPlanModePlugin({ startActive: true })],
    });
    const config = { configurable: { thread_id: 'approve' } };

    try {
      const paused = await agent.invoke(toAgentInvocation('幫我改一下。'), config);
      // 停在核准點——工具還沒跑，所以模式一定還開著。
      expect(paused.__interrupt__).toBeDefined();

      const after = await agent.invoke(
        new Command({ resume: { decisions: [{ type: 'approve' }] } }) as never,
        config,
      );

      expect(planModeOf(after)).toBe(false);
      expect(lastToolMessage(after.messages as BaseMessage[])?.text).toContain(
        PLAN_APPROVED_MESSAGE,
      );
      // 模式關了，所以獲准之後那一輪的 prompt 裡不該再有指引。
      expect(systemPrompt(model.lastPrompt)).not.toContain(DEFAULT_PLAN_GUIDANCE);
    } finally {
      await dispose();
    }
  });

  /**
   * **沒有人可問的時候：確定性拒絕，而且模式還開著。**
   *
   * 這正是 `startActive` 的 JSDoc 警告的那個結局——在收不了核准決定的入口打開計劃模式，
   * 等於把那一輪鎖死：計劃被拒、模式沒關、而今天沒有第二條路出去。**寫成測試是因為
   * 它是設計的後果，不是缺陷**：改掉它要先有開啟／關閉的命令，那是另一張卡。
   */
  it('headless → 確定性拒絕，而且模式還開著', async () => {
    const model = planScript();
    const { agent, dispose } = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      approvals: HEADLESS_APPROVALS,
      plugins: [createPlanModePlugin({ startActive: true })],
    });

    let result;
    try {
      result = await agent.invoke(toAgentInvocation('幫我改一下。'), {
        configurable: { thread_id: 'headless' },
      });
    } finally {
      await dispose();
    }

    // 沒有停下來等——這是 #113 的整個重點。
    expect(result.__interrupt__).toBeUndefined();
    const denial = lastToolMessage(result.messages as BaseMessage[]);
    expect(denial?.text).toContain('是沒有人被問到');
    expect(denial?.text).not.toContain(PLAN_APPROVED_MESSAGE);
    // **模式沒關**：工具沒跑，那個 `Command` 就沒有發生。
    expect(planModeOf(result)).toBe(true);
  });

  /**
   * **不在模式裡的時候：說的是模式，不是核准。**
   *
   * 這一條是 `prepend: true` 的證據。少了它，`fold` 會把計劃模式的 middleware 排到
   * 核准閘門**之後**，於是這次呼叫會先撞上閘門、拿到一句關於核准的話——而真正的原因
   * 是「你不在計劃模式」。兩句話都「不是成功」，但只有一句說得出為什麼。
   */
  it('模式外呼叫 → 說的是「不在計劃模式」，不是核准的措辭', async () => {
    const model = planScript();
    const { agent, dispose } = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      approvals: HEADLESS_APPROVALS,
      plugins: [createPlanModePlugin()],
    });

    let result;
    try {
      result = await agent.invoke(toAgentInvocation('幫我改一下。'), {
        configurable: { thread_id: 'not-in-mode' },
      });
    } finally {
      await dispose();
    }

    const refusal = lastToolMessage(result.messages as BaseMessage[]);
    expect(refusal?.text).toContain(NOT_IN_PLAN_MODE_MESSAGE);
    expect(refusal?.text).not.toContain('是沒有人被問到');
  });
});

describe('模式狀態活得過什麼', () => {
  it('同一條 thread 的下一輪還在', async () => {
    const model = new ScriptedChatModel({
      turns: [{ content: '第一輪。' }, { content: '第二輪。' }],
    });
    const { agent, dispose } = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      plugins: [createPlanModePlugin({ startActive: true })],
    });
    const config = { configurable: { thread_id: 'across-turns' } };

    try {
      await agent.invoke(toAgentInvocation('第一句。'), config);
      const second = await agent.invoke(toAgentInvocation('第二句。'), config);
      expect(planModeOf(second)).toBe(true);
    } finally {
      await dispose();
    }

    // 狀態還在，所以第二輪的 prompt 也還夾著指引。
    expect(systemPrompt(model.lastPrompt)).toContain(DEFAULT_PLAN_GUIDANCE);
  });

  /**
   * **壓縮會重寫 `messages`，這一條問的是「它會不會順手把別人的 key 也一起吃掉」。**
   *
   * 不能假設。middleware state 在自己的 key 底下，但摘要器動的是同一份 state 物件，
   * 而「它只改 `messages`」是實作細節不是承諾——基座哪天改了，這條會紅。
   * 低門檻的摘要器是照 `summarization.test.ts` 的做法換掉內建那個。
   */
  it('一次真的壓縮之後還在', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-plan-sum-'));
    const backend = new ContainedFilesystemBackend({ rootDir: root });
    const model = new ScriptedChatModel({
      turns: Array.from({ length: 12 }, (_, index) => ({ content: `第 ${index + 1} 次回話。` })),
    });

    const tuned: NexusPlugin = {
      name: 'tuned-summarization',
      apply: (registry) =>
        void registry.middleware.use(
          createSummarizationMiddleware({
            backend,
            trigger: { type: 'messages', value: 3 },
            keep: { type: 'messages', value: 1 },
          }) as never,
        ),
    };

    const { agent, dispose } = await createNexusAgent({
      model,
      backend,
      checkpointer: new MemorySaver(),
      plugins: [createPlanModePlugin({ startActive: true }), tuned],
    });
    const config = { configurable: { thread_id: 'summarize' } };

    let last;
    try {
      for (const line of ['第一句。', '第二句。', '第三句。', '第四句。']) {
        last = await agent.invoke(toAgentInvocation(line), config);
      }
    } finally {
      await dispose();
    }

    // **先證明壓縮真的發生了。** 少了這一句，一個根本沒觸發摘要的組裝也會讓下面兩條
    // 通過——那時綠的是「什麼都沒發生」，不是「熬過了壓縮」。摘要器把歷史 offload 到
    // `/conversation_history`，那個目錄非空就是它跑過的外顯（照 `summarization.test.ts`）。
    expect(await readdir(join(root, 'conversation_history'))).not.toHaveLength(0);

    expect(planModeOf(last)).toBe(true);
    expect(systemPrompt(model.lastPrompt)).toContain(DEFAULT_PLAN_GUIDANCE);
  });
});

describe('工具目錄不隨模式變動', () => {
  /**
   * 照 dsh：模式沒啟用時 `exit_plan_mode` 仍然留在面向模型的 schema 裡，
   * 「這樣狀態轉換不會在規劃策略變更之外額外造成工具目錄變動」。
   * 代價是 `startActive: false` 的組裝裡它是活的 schema、死的執行路徑——上面那條
   * 「模式外呼叫」測的就是那條死路徑說了什麼。
   */
  it('模式關著的時候工具也在，而且排得進 toolOrder', async () => {
    const model = new ScriptedChatModel({ turns: [{ content: '好。' }] });
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [createEchoPlugin(), createPlanModePlugin()],
      toolOrder: [EXIT_PLAN_MODE_TOOL_NAME, ECHO_TOOL_NAME, '<unlisted-tools>'],
    });

    try {
      await agent.invoke(toAgentInvocation('嗨。'));
    } finally {
      await dispose();
    }

    expect(model.boundToolNames.slice(0, 2)).toEqual([EXIT_PLAN_MODE_TOOL_NAME, ECHO_TOOL_NAME]);
  });
});

/**
 * `/plan` 走完整條線：**真的執行器 → 真的 REPL → 真的 agent 迴圈**。
 *
 * 為什麼要走 `runRepl` 而不是直接呼叫 handler：這一條要證明的不是 handler 回了什麼
 * 字串（那歸 `packages/nexus-plugin-plan-mode` 的單元測試），而是**人打的那一行真的
 * 讓下一輪的 prompt 變得不一樣**。中間隔著 `parseCommand` 的 lookahead、執行器的
 * 配對日誌、`beforeAgent` 的邊界提交與 checkpointer——少了任何一段，指引都到不了模型，
 * 而每一段都只有在真的接起來的時候才驗得到。
 *
 * **checkpointer 不是佈景。** 沒有它，state 在兩次 invoke 之間不留，第二輪一開始
 * `beforeAgent` 讀到的是 `stateSchema` 的初值——那一格會把 `committed` 同步成 `false`，
 * 計劃模式在第二輪就自己掉了。CLI 有它（`MemorySaver`），所以這裡也有。
 */
describe('/plan 這條路', () => {
  /** 餵幾行進 REPL，把印出來的東西與日誌一起收回來。 */
  async function repl(
    plugins: readonly NexusPlugin[],
    lines: string,
    turns: number,
  ): Promise<{
    model: ScriptedChatModel;
    stdout: string;
    stderr: string;
    events: readonly SessionEvent[];
  }> {
    const model = new ScriptedChatModel({
      turns: Array.from({ length: turns }, () => ({ content: '好。' })),
    });
    const { agent, commands, dispose } = await createNexusAgent({
      model,
      plugins,
      checkpointer: new MemorySaver(),
    });
    const sessionLog = new SessionLog('plan-repl');
    const events: SessionEvent[] = [];
    sessionLog.subscribe((event) => events.push(event));

    const out: string[] = [];
    const err: string[] = [];
    const input = new PassThrough();
    input.end(lines);

    try {
      await runRepl(
        agent,
        { input, output: new PassThrough() },
        { log: (line) => void out.push(line), error: (line) => void err.push(line) },
        sessionLog,
        commands,
      );
    } finally {
      await dispose();
    }
    return { model, stdout: out.join('\n'), stderr: err.join('\n'), events };
  }

  /**
   * **一進一出，兩輪的 prompt 要不一樣。**
   *
   * 只斷言「開了之後有」的話，一個永遠都夾指引的實作照樣綠；只斷言「關了之後沒有」
   * 的話，一個從來不夾的實作也綠。兩輪一起比才擋得住。
   */
  it('/plan 之後那一輪夾指引，/plan off 之後那一輪不夾', async () => {
    const { model, stdout } = await repl(
      [createEchoPlugin(), createPlanModePlugin()],
      '/plan\n先想想\n/plan off\n動手吧\n/exit\n',
      2,
    );

    expect(model.prompts).toHaveLength(2);
    expect(systemPrompt(model.prompts[0] ?? [])).toContain(DEFAULT_PLAN_GUIDANCE);
    expect(systemPrompt(model.prompts[1] ?? [])).not.toContain(DEFAULT_PLAN_GUIDANCE);
    // 兩句話都印給人看了——命令的結果不進模型，只進終端機。
    expect(stdout).toContain(PLAN_ENTERED_MESSAGE);
    expect(stdout).toContain(PLAN_LEFT_MESSAGE);
  });

  /**
   * **命令那兩行不能變成模型的一輪。** 這是 `@nexus/plugin-commands` 那條「認得的就
   * 不掉回模型」在計劃模式上的驗收：模型只該看到兩句人話，日誌裡則是兩對命令事件。
   */
  it('命令走命令的路，模型只收到那兩句人話', async () => {
    const { events } = await repl(
      [createEchoPlugin(), createPlanModePlugin()],
      '/plan\n先想想\n/plan off\n動手吧\n/exit\n',
      2,
    );

    expect(events.filter((event) => event.type === 'command/run')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'command/done')).toHaveLength(2);
    expect(
      events
        .filter((event) => event.type === 'turn/start')
        .map((event) => (event.data as { text?: string }).text),
    ).toEqual(['先想想', '動手吧']);
  });

  /**
   * **人自己打的那一句不會被某個節點再印一次。**
   *
   * 基座把這一輪的輸入訊息掛在**第一個真的寫了東西的節點**的 update 上，而在
   * [#120](https://github.com/DemianLi/nexus-agent/issues/120) 之前沒有任何 plugin 的
   * `beforeAgent` 回傳非空更新——所以這個形狀是這張卡第一次讓它現形的：畫面上會出現
   * `[nexusPlanMode.before_agent] 先想想`，看起來像那個 plugin 在說話。`runTurn` 因此
   * 濾掉 human message，這一條釘著它。
   */
  it('進了計劃模式之後，使用者那句話不會在畫面上出現兩次', async () => {
    const { stdout } = await repl(
      [createEchoPlugin(), createPlanModePlugin()],
      '/plan\n先想想\n/exit\n',
      1,
    );

    expect(stdout).toContain(PLAN_ENTERED_MESSAGE);
    expect(stdout).not.toContain('先想想');
    expect(stdout).not.toContain('before_agent');
  });

  /**
   * **收不下的參數走 `printer.error`，而且不驚動模型。**
   *
   * `/plan of` 是打錯的 `/plan off`，而它在語法上是一個合法的命令行——`parseCommand`
   * 收得下、註冊表也找得到，所以它**會**進 handler。分辨對錯的是 handler 自己的文法，
   * 而它回 `error`。掉回模型的話，模型會收到一行沒頭沒尾的 `/plan of`。
   */
  it('/plan of 回報錯誤，模式沒動，模型沒被驚動', async () => {
    const { model, stderr, stdout } = await repl(
      [createEchoPlugin(), createPlanModePlugin()],
      '/plan of\n說點什麼\n/exit\n',
      1,
    );

    expect(stderr).toContain(PLAN_ARGS_ERROR_MESSAGE);
    expect(model.prompts).toHaveLength(1);
    expect(systemPrompt(model.prompts[0] ?? [])).not.toContain(DEFAULT_PLAN_GUIDANCE);
    expect(stdout).not.toContain(PLAN_ENTERED_MESSAGE);
  });
});
