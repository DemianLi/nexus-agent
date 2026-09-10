/**
 * 絆索：**基座准不准我們動模型看到的那份工具清單**——
 * [#238](https://github.com/DemianLi/nexus-agent/issues/238) 升級載體那個未決的判準。
 *
 * ## 這一份釘的是什麼
 *
 * dsh 把升級的兩個欄位（`sandbox_permissions` ＋ `justification`）攤進**它自己擁有的**
 * `write`／`edit` schema，而且編排是「**同一顆呼叫重試一次**」
 * （`references/deepseek-harness/packages/sandbox/sandbox/src/escalation.ts` 的
 * `escalationHintMarker()`：retry this exact ⟨operation⟩ once with …）。我們照抄不了，
 * 而**卡上原本寫的理由是錯的**：它說擋住的是 `createDeepAgent()` 開頭那條
 * `TOOL_NAME_COLLISION`。那條擋的是**名字**。真正擋住「把欄位攤進 `write_file`」的是
 * langchain 自己的一條執行期檢查，在 `wrapModelCall` 的回程上（`langchain@1.5.10`，
 * `src/agents/nodes/AgentNode.ts:556-609`；dist 不附 src，從
 * `dist/agents/nodes/AgentNode.cjs.map` 的 `sourcesContent` 讀出來的）：
 *
 * - `replacedClientTools`（**同名、不同實例**）→ **一律拒**。原文理由是
 *   “Replaced tools are always rejected to preserve ToolNode execution identity.”
 * - `addedClientTools`（**名字不在註冊表裡**）→ **准**，條件是有任何 middleware 提供
 *   `wrapToolCall`（那顆工具 ToolNode 不認得，得由 middleware 自己執行掉）。
 *
 * **兩條是同一段的兩半，所以這裡兩條都釘。** 只釘拒絕那一半的話，一個把整個
 * `wrapModelCall` 的 `tools` 都當耳邊風的基座也會全綠。
 *
 * ## 為什麼這是絆索而不是回歸測試
 *
 * 這兩條規則哪天鬆掉（升版放寬同名替換），第一條會**紅**——而那正是 #238 那個未決
 * 該重開的時刻：同名替換一旦可行，「欄位攤進 `write_file`」就從「繞得過去」變成
 * 「基座支援」，載體的選擇要重算。**紅了不要改斷言，去把 #238 重開。**
 *
 * ## 沒有寫成測試、但量過的兩件（2026-09-10）
 *
 * 1. **就地改那顆 `write_file` 的 `schema`（不換實例）是繞得過去的**，而且模型面的
 *    JSON schema 真的長出那兩個欄位——上面那條檢查比的是 `original !== tool`，改屬性
 *    不換實例就命不中。**沒有採用，也沒有寫成測試**：那顆的 schema 是
 *    `z.preprocess(normalizeFilePathInput, z.object({file_path, content}))`，把 preprocess
 *    換掉之後模型送 `path`（不是 `file_path`）那一輪**當場驗證失敗**，所以真要做得從
 *    `schema.def.in`／`.def.out` 把那條 pipe 重組回去——**吃一個我們不擁有的 schema 的
 *    zod v4 內部形狀**。而且基座的 `createToolExclusionMiddleware` 排除得掉工具名
 *    （今天沒有任何 profile 排 `write_file`），焊在它 schema 上的載體會無聲消失。
 * 2. **欄位不宣告、直接騎在呼叫裡是到得了閘門的**：`wrapToolCall` 的
 *    `request.toolCall.args` 完整看得到多出來的鍵，執行也照樣成功（zod object 非 strict，
 *    多的鍵被剝掉）。**但這條不必排實跑就結掉了**——`write_file` 送給模型的那份 JSON
 *    schema 是 `additionalProperties: false`，等於我們一邊公告「這顆不收別的鍵」一邊求
 *    模型違反它。**別再為這一條開 key-gated 的實跑。**
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { Command } from '@langchain/langgraph';
import { createMiddleware, tool } from 'langchain';
import type { AgentMiddleware } from 'langchain';
import type { NexusPlugin } from '@nexus/core';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import { SANDBOX_ESCALATION_TOOL_NAME } from './sandbox-escalation.js';
import { SandboxModeController } from './sandbox-mode.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';

/** 這一顆升級工具只是**形狀**——#238 還沒定要不要真的長出它。 */
// **用正式的那個名字**：絆索量的是「加一顆沒見過的工具會被放行」，而正式的升級工具就是
// 靠那一半活著的。兩邊各寫一次字串的話，改名那天絆索會繼續量一顆已經不存在的工具。
const ESCALATION_TOOL_NAME = SANDBOX_ESCALATION_TOOL_NAME;

/**
 * 記下每一次 `bindTools` 收到的清單。
 *
 * `ScriptedChatModel.boundToolNames` 只留最後一次；這裡要的是「**改過的那份真的到得了
 * 模型**」，而不是「我們的 middleware 自己看到了什麼」——中間還隔著基座那條檢查。
 */
class RecordingModel extends ScriptedChatModel {
  readonly boundNames: string[][] = [];
  override bindTools(tools: readonly unknown[]): ScriptedChatModel {
    this.boundNames.push(
      tools.map((candidate) => {
        const name = (candidate as { name?: unknown }).name;
        return typeof name === 'string' ? name : '<匿名>';
      }),
    );
    return super.bindTools(tools);
  }
}

function probePlugin(middleware: AgentMiddleware): NexusPlugin {
  return {
    name: 'escalation-carrier-probe',
    apply: (registry) => {
      registry.middleware.use(middleware);
    },
  };
}

describe('模型看到的那份工具清單，基座准我們動到哪裡', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nexus-escalation-carrier-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** 組一台掛著 fence 的 agent 跑一輪；`middleware` 是這一條要驗的東西。 */
  async function run(
    middleware: AgentMiddleware,
    turns: readonly ScriptedTurn[],
  ): Promise<{ model: RecordingModel; toolTexts: string[] }> {
    const model = new RecordingModel({ turns });
    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({
        rootDir: root,
        mode: new SandboxModeController('workspace-write').source,
      }),
      plugins: [probePlugin(middleware)],
    });
    try {
      const result = await agent.invoke(toAgentInvocation('做一件事。'));
      return {
        model,
        toolTexts: result.messages
          .filter((message) => message.getType() === 'tool')
          .map((message) => message.text),
      };
    } finally {
      await dispose();
    }
  }

  it('**換掉**同名的 `write_file`（新實例）會被基座擋下來', async () => {
    const middleware = createMiddleware({
      name: 'WidenBuiltinWriteFile',
      wrapModelCall: (request, handler) => {
        const tools = (request.tools as unknown[]).map((candidate) => {
          if ((candidate as { name?: string }).name !== 'write_file') return candidate;
          // 一份忠實的複本，只多兩個欄位。**內容不是重點**——上面那條檢查比的是
          // `original !== tool`，所以連原封不動的複本也會被拒。
          return Object.assign(
            Object.create(Object.getPrototypeOf(candidate as object)),
            candidate,
            {
              schema: z.object({
                file_path: z.string(),
                content: z.string(),
                sandbox_permissions: z.string().optional(),
                justification: z.string().optional(),
              }),
            },
          );
        });
        return handler({ ...request, tools } as typeof request);
      },
    }) as AgentMiddleware;

    await expect(run(middleware, [{ content: '走不到這裡。' }])).rejects.toThrow(
      /You have modified a tool in "wrapModelCall"[\s\S]*write_file/,
    );
  });

  it('**加一顆**新工具是准的，而且它到得了模型、由 middleware 自己執行掉', async () => {
    const executedArgs: unknown[] = [];
    const escalation = tool(() => 'ToolNode 不認得這顆，這個函式不會被呼叫到', {
      name: ESCALATION_TOOL_NAME,
      description: '請求把這一次呼叫的沙箱模式加寬。',
      schema: z.object({ sandbox_permissions: z.string(), justification: z.string() }),
    });

    const middleware = createMiddleware({
      name: 'AddEscalationTool',
      wrapModelCall: (request, handler) =>
        handler({
          ...request,
          tools: [...(request.tools as unknown[]), escalation],
        } as typeof request),
      wrapToolCall: (request, handler) => {
        const call = request.toolCall as { name?: string; id?: string; args?: unknown };
        if (call.name !== ESCALATION_TOOL_NAME) return handler(request);
        executedArgs.push(call.args);
        // `Command` 是 middleware 自己交差的方式（同 `@nexus/plugin-plan-mode` 擋掉
        // 模式外的 `exit_plan_mode` 那一格）。**`ToolMessage` 不能省**，少了它那顆
        // `tool_call` 永遠沒有回覆。
        return new Command({
          update: {
            messages: [{ type: 'tool', content: '收到升級請求。', tool_call_id: call.id ?? '' }],
          },
        }) as never;
      },
    }) as AgentMiddleware;

    const { model, toolTexts } = await run(middleware, [
      {
        content: '',
        toolCalls: [
          {
            name: ESCALATION_TOOL_NAME,
            args: { sandbox_permissions: 'danger-full-access', justification: '要寫到工作區外面' },
          },
        ],
      },
      { content: '好了。' },
    ]);

    // 三格各自會壞在不同的地方：清單沒到模型、middleware 沒被叫到、回覆沒接回訊息串。
    expect(model.boundNames.at(-1)).toContain(ESCALATION_TOOL_NAME);
    expect(executedArgs).toEqual([
      { sandbox_permissions: 'danger-full-access', justification: '要寫到工作區外面' },
    ]);
    expect(toolTexts).toEqual(['收到升級請求。']);
  });
});
