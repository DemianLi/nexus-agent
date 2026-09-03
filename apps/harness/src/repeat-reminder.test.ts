/**
 * 重複工具呼叫的提醒，**在正式路徑上**。
 *
 * `packages/nexus-core/src/repeat-reminder.test.ts` 直接呼叫 `beforeModel`，量的是偵測
 * 規則；這個檔量的是另一件事——**那份 middleware 真的被組進了 `createDeepAgent` 的
 * stack，而且提醒真的進了模型下一輪的 prompt**。兩者會為不同的理由壞掉：規則對但沒
 * 接上線、或接上了線但規則錯。
 *
 * 驗收句照 [#147](https://github.com/DemianLi/nexus-agent/issues/147)：
 *
 * - 同參數重複：第 3 次那次呼叫的結果送回去之後，模型下一輪的 prompt 裡有提醒；前面沒有。
 * - 對照組：同工具**不同參數**連叫 8 次，一次提醒都沒有。
 * - 提醒之後模型照樣叫得動工具——它是建議不是阻止。
 */

import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { REPEAT_REMINDER_MARKER } from '@nexus/core';
import type { NexusPlugin } from '@nexus/core';
import { createEchoPlugin, ECHO_TOOL_NAME } from '@nexus/plugin-echo';
import { describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { transcriptLine } from './cli.js';
import { LoopingChatModel } from './looping-model.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

const GENTLE_HEAD = 'You are repeating the exact same tool call with identical arguments.';
const DETAILED_HEAD = 'Repeated tool call detected:';

/** 一輪 prompt 裡有沒有提醒，看的是記號而不是文字——文字改了測試不該跟著改。 */
function hasReminder(prompt: readonly BaseMessage[]): boolean {
  return prompt.some(
    (message) =>
      HumanMessage.isInstance(message) && message.additional_kwargs[REPEAT_REMINDER_MARKER] != null,
  );
}

/** 把一輪 prompt 裡所有提醒的全文攤平。 */
function reminderTexts(prompt: readonly BaseMessage[]): string[] {
  return prompt
    .filter(
      (message) =>
        HumanMessage.isInstance(message) &&
        message.additional_kwargs[REPEAT_REMINDER_MARKER] != null,
    )
    .map((message) => message.text);
}

/**
 * 跑一場永不停的迴圈，跑到上限為止，回每一輪模型看到的 prompt。
 *
 * `recursionLimit: 20` 換算是 6 輪（預設組裝每輪三格：`floor((20 - 1) / 3)`），足夠看到
 * 第一道與第二道門檻各一次。
 *
 * @param argsFor - 第 n 輪要用的參數。省略即每輪同一份。
 * @returns 依輪次的 prompt。
 */
async function loopPrompts(
  argsFor?: (call: number) => Record<string, unknown>,
): Promise<(readonly BaseMessage[])[]> {
  const model = new LoopingChatModel({
    toolName: ECHO_TOOL_NAME,
    ...(argsFor !== undefined && { argsFor }),
  });
  const { agent, dispose } = await createNexusAgent({
    model,
    plugins: [createEchoPlugin()],
    recursionLimit: 20,
    // 摘要關掉是為了隔離變數：跑滿的迴圈會把訊息數推過打底的 `messages: 60`，摘要一剪
    // 鏈就從剪過的訊息串重算，而這條量的是偵測本身。摘要與提醒的互動另有其位（見下）。
    summarization: false,
  });
  try {
    await expect(agent.invoke(toAgentInvocation('一直跑'))).rejects.toThrow(/Recursion limit/);
  } finally {
    await dispose();
  }
  return model.seen;
}

describe('提醒在正式路徑上進得了模型的 prompt', () => {
  it('同參數重複：第 4 輪的 prompt 有溫和版提醒，前三輪沒有', async () => {
    const prompts = await loopPrompts();
    expect(prompts.length).toBeGreaterThanOrEqual(4);

    // 前三輪：第 n 輪看到的是 n-1 次已完成的呼叫，所以最多到 2 次，還沒到門檻。
    expect(prompts.slice(0, 3).map(hasReminder)).toEqual([false, false, false]);

    // 第 4 輪看到的是第 3 次重複的結果——提醒就掛在它後面。
    expect(reminderTexts(prompts[3] ?? [])).toHaveLength(1);
    expect(reminderTexts(prompts[3] ?? [])[0]).toContain(GENTLE_HEAD);
  });

  it('繼續重複到第 5 次會再收到一條，而且是詳細版', async () => {
    const prompts = await loopPrompts();
    expect(prompts.length).toBeGreaterThanOrEqual(6);
    // **這條擋的是「提醒把鏈打斷了」。** 提醒本身是一則 human 訊息，而人講話會清零計數；
    // 少了記號的排除，第二道門檻永遠到不了，而第一條照樣出現、整條測試看起來正常。
    //
    // prompt 是累積的，所以看的是**累積條數**：第 4 輪 1 條、第 5 輪還是 1 條（那一輪
    // 是第 4 次，不是門檻）、第 6 輪 2 條。中間那格擋的是「每一輪都提醒」。
    expect(prompts.slice(3, 6).map((prompt) => reminderTexts(prompt).length)).toEqual([1, 1, 2]);

    const latest = reminderTexts(prompts[5] ?? []).at(-1) ?? '';
    expect(latest).toContain(DETAILED_HEAD);
    expect(latest).toContain(`- tool: ${ECHO_TOOL_NAME}`);
    expect(latest).toContain('- consecutive_calls: 5');
    expect(latest).toContain('- arguments: {"message":"x"}');
  });

  it('提醒之後模型照樣叫得動工具 —— 它是建議不是阻止', async () => {
    const prompts = await loopPrompts();
    const after = prompts[5] ?? [];
    // 第 6 輪的 prompt 裡，提醒之後還有第 5 次呼叫的工具結果與更後面的訊息——工具沒有
    // 被擋掉，而且模型還在被問下一步。迴圈是撞上 `recursionLimit` 才停的（見 `loopPrompts`
    // 那句 rejects），不是被這道護欄停的。
    expect(after.filter((message) => message.getType() === 'tool').length).toBeGreaterThanOrEqual(
      5,
    );
    expect(prompts.length).toBeGreaterThan(5);
  });

  it('同工具不同參數連叫滿，一次提醒都沒有', async () => {
    const prompts = await loopPrompts((call) => ({ message: `第 ${call} 次` }));
    expect(prompts.length).toBeGreaterThanOrEqual(6);
    expect(prompts.flatMap(reminderTexts)).toEqual([]);
  });

  /**
   * **被拒的呼叫也計數。**
   *
   * dsh 明列這條，理由是「模型反覆嘗試被拒絕的調用，恰恰是需要打破的循環」——它把偵測
   * 放在 post-execute，被 pre-execute 拒掉的呼叫一樣經過那裡。我們這側自動成立而且理由
   * 不同：鏈是從 `AIMessage.tool_calls` 推的，那是**模型提出了什麼**，跟工具跑了沒有無關。
   *
   * 「自動成立」是推理，不是證據，所以這裡量一次。
   */
  it('呼叫被核准閘門拒掉，照樣計數照樣提醒', async () => {
    const denyEcho: NexusPlugin = {
      name: 'deny-echo',
      apply: (registry) =>
        void registry.approvals.gate((exec, next) =>
          exec.name === ECHO_TOOL_NAME ? { kind: 'deny', reason: '這次不給跑' } : next(),
        ),
    };
    const model = new LoopingChatModel({ toolName: ECHO_TOOL_NAME });
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [createEchoPlugin(), denyEcho],
      recursionLimit: 20,
      summarization: false,
    });
    try {
      await expect(agent.invoke(toAgentInvocation('一直跑'))).rejects.toThrow(/Recursion limit/);
    } finally {
      await dispose();
    }

    // 工具一次都沒真的跑（每一則結果都是拒絕），提醒照樣在第 4 輪出現。
    const denials = (model.seen[3] ?? []).filter((message) => message.text.includes('這次不給跑'));
    expect(denials.length).toBeGreaterThanOrEqual(3);
    expect(reminderTexts(model.seen[3] ?? [])[0]).toContain(GENTLE_HEAD);
  });

  it('明著關掉就完全不出現', async () => {
    const model = new LoopingChatModel({ toolName: ECHO_TOOL_NAME });
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [createEchoPlugin()],
      recursionLimit: 20,
      summarization: false,
      repeatReminder: false,
    });
    try {
      await expect(agent.invoke(toAgentInvocation('一直跑'))).rejects.toThrow(/Recursion limit/);
    } finally {
      await dispose();
    }
    expect(model.seen.flatMap(reminderTexts)).toEqual([]);
    // 順帶：關掉之後每輪回到兩格，同一個上限跑得比較久。`floor((20 - 1) / 2)` = 9。
    expect(model.seen).toHaveLength(9);
  });
});

/**
 * **打底到 subagent，而且是在真的 subagent 那幾輪上量的。**
 *
 * root 的 `registry.middleware` 到不了 subagent（`summarization.test.ts` 那條釘著它），
 * 所以這道提醒要嘛在 `foldSubAgents` 打底、要嘛那個 subagent 完全沒有——而長任務裡真的
 * 會打轉的正是 subagent。`fold.test.ts` 釘的是「那份陣列裡有它」；這條釘的是**基座真的
 * 把那份陣列組進了 subagent 的 stack**，兩件事會為不同的理由壞掉。
 *
 * `ScriptedChatModel.prompts` 是唯一看得到 subagent 那幾輪的地方——`lastPrompt` 永遠是
 * root 的，因為 subagent 跑完 root 還會再問一次。
 */
describe('subagent 那一輪也有', () => {
  it('subagent 自己重複三次，第四輪的 prompt 裡有提醒', async () => {
    const crew: NexusPlugin = {
      name: 'crew',
      apply: (registry) =>
        void registry.subagents.register({ name: 'writer', description: '負責寫東西。' }),
    };
    const repeat = {
      content: '',
      toolCalls: [{ name: ECHO_TOOL_NAME, args: { message: '同一句' } }],
    };
    const model = new ScriptedChatModel({
      turns: [
        // 0：root 派工。
        {
          content: '',
          toolCalls: [{ name: 'task', args: { description: '去寫', subagent_type: 'writer' } }],
        },
        // 1–3：subagent 連叫三次同參數的 echo。
        repeat,
        repeat,
        repeat,
        // 4：subagent 收工——這一輪的 prompt 裡該有提醒。
        { content: '寫完了。' },
        // 5：root 收工。
        { content: '收工。' },
      ],
    });

    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [createEchoPlugin(), crew],
      summarization: false,
    });
    try {
      await agent.invoke(toAgentInvocation('叫 writer 去做事。'));
    } finally {
      await dispose();
    }

    const prompts = model.prompts;
    expect(prompts).toHaveLength(6);
    // subagent 的前三輪還沒到門檻，第四輪（index 4）才有。
    expect(prompts.slice(0, 4).map(hasReminder)).toEqual([false, false, false, false]);
    expect(reminderTexts(prompts[4] ?? [])[0]).toContain(GENTLE_HEAD);
    // **root 那一輪沒有。** 鏈是各自的 `state.messages`，subagent 的重複不會漏到 root
    // 頭上——共用一份實例但不共用狀態，這一格就是那件事的驗收。
    expect(hasReminder(prompts[5] ?? [])).toBe(false);
  });
});

/**
 * **提醒在 CLI 上看得見。**
 *
 * `cli.ts` 一律跳過 human 訊息（避免把使用者自己打的那句再印一次），而提醒就是一則
 * 合成的 human 訊息——照舊規則它會整條不見，於是這道護欄唯一的產出在畫面上一個字都沒有。
 * 這一組釘的就是那個例外，順帶釘住例外不會反過來把使用者那句也印出來。
 */
describe('提醒在 CLI 的逐字稿上印得出來', () => {
  it('帶記號的提醒印出來，掛的是提醒器的名字', () => {
    const line = transcriptLine(
      'agent',
      new HumanMessage({
        content: GENTLE_HEAD,
        additional_kwargs: { [REPEAT_REMINDER_MARKER]: { tool: ECHO_TOOL_NAME, count: 3 } },
      }),
    );
    expect(line).toBe(`[nexusRepeatToolReminder] ${GENTLE_HEAD}`);
  });

  it('使用者自己打的那句照樣跳過 —— 例外沒有把規則吃掉', () => {
    expect(transcriptLine('nexusPlanMode.before_agent', new HumanMessage('嗨'))).toBeUndefined();
  });
});
