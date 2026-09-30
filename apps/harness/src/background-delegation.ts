/**
 * 背景派出的委派工具 `subagent`（[#831](https://github.com/DemianLi/nexus-agent/issues/831)，地圖
 * [#737](https://github.com/DemianLi/nexus-agent/issues/737) 的第 5 張）。**預設關**：
 * `createNexusAgent({ backgroundSubagents })` 不給就完全沒有這顆 middleware。
 *
 * ## 為什麼是新工具，不是給 `task` 加欄位（偏離登記）
 *
 * dsh 的委派工具自己帶 `run_in_background`（`packages/subagent/tool-subagent/src/index.ts:111/303`，`477b4f4`）。
 * 基座的 `task` schema 固定，zod 會剝掉多的欄位；langchain 又禁止在 `wrapModelCall` 裡**修改**已註冊的工具
 * （`You have modified a tool in "wrapModelCall" hook … This is not supported.`）。表達不出來，退到最接近的：
 * `wrapModelCall` 把 `task` 從模型視野**拿掉**、**加上** `subagent`（兩件事 langchain 都允許，探針有斷言，見 #831），
 * `wrapToolCall`（最外層）承接它。
 *
 * - **`run_in_background: false`**：把呼叫改派給基座的 `task`（`toolCall.name` 換成 `task`、`request.tool` 換成
 *   `wrapModelCall` 順手記下的基座實例），內層的沙箱快照、圍堵、輸出上限、核准閘門看到的仍是 `task`，行為同今天。
 *   回給模型的結果名字改回 `subagent`。
 * - **`true`（預設，同 dsh continuable）**：在收件匣接受的那一刻把第一輪交給 {@link BackgroundSubagentHost}，
 *   當場回編號。
 * - **模型直接送 `task`**（藏起來的那顆）：**不攔**，基座照樣跑，等同 `run_in_background: false`。它沒被宣告過，
 *   只有壞掉的模型才會送；行為與前景一致，所以不值得為它多一條錯誤路徑（探針實測，#831）。
 *
 * **這顆在疊上的位置（量到的）**：`nexusToolFailureContainment` ＞ `nexusTurnCancel`（外層守衛）＞ **這顆** ＞
 * `nexusApprovalGate` ＞ … ＞ `nexusMaxTokens`；沙箱 plugin 的 `wrapToolCall` 也在這顆裡面。所以前景改派後，
 * 核准閘門、輸出上限、沙箱快照看到的是 `task`；**圍堵與外層的中止守衛在外面，看到的是 `subagent`**（圍堵的日誌事件名、
 * 中止後回的「還沒動手」結果都用 `subagent`）。wire 的子代理卡、`thread-pump.ts` 收回時選碼的 `DELEGATION_TOOL`
 * 也還在比對 `task`——這幾處歸 #832，預設關的今天不會被走到。
 *
 * `subagent` 的描述取自當次請求裡 `task` 的描述（改掉跟背景矛盾的兩句，見 {@link TASK_DESCRIPTION_REWRITES}），所以子代理清單永遠與 fold 定的同步，不另外維護。子代理的疊
 * （plugin middleware 也射進去，#327）沒有 `task`，所以在那裡什麼都不做，不需要 rootOnly 樁。
 *
 * ## 沙箱快照
 *
 * 接受那一刻用控制器的 `delegate` 包住 {@link BackgroundSubagentHost.start}：日誌在包裡開，參與者把
 * `sandbox/mode {source:'delegation'}` 寫進去；之後每一輪由 host 的 `enter` 用 `delegateFromLog` 讀回（#827）。
 * **沒有控制器**（沒掛沙箱 plugin 的組裝）時兩頭都原樣跑——`delegateFromLog` 在日誌上找不到那一顆會拋。
 *
 * @module
 */

import { ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { putToolResultMeta, toolRefusal } from '@nexus/core';
import type { PluginEntry, SessionLog, SessionRegistry } from '@nexus/core';
import type { SandboxModeController } from '@nexus/plugin-sandbox-policy';
import { createMiddleware } from 'langchain';
import type { BackgroundSubagentMeta } from '@nexus/wire';
import { z } from 'zod';

import { BackgroundSubagentHost } from './background-subagents.js';
import type { BackgroundAgent } from './background-subagents.js';

/** 模型看到的工具名（dsh 的預設名，`toolName: 'subagent'`）。 */
export const SUBAGENT_TOOL_NAME = 'subagent';
/** 被換掉的基座委派工具。 */
const BASE_DELEGATION_TOOL_NAME = 'task';

/** 這個 middleware 的名字。 */
export const BACKGROUND_DELEGATION_MIDDLEWARE_NAME = 'nexusBackgroundDelegation';

/** 選項：只有沙箱那一頭，其餘都從組裝推。 */
export interface BackgroundSubagentsOptions {
  /** 沙箱控制器（cli／serve 建的那一個）。沒有就不做快照與讀回。 */
  readonly sandbox?: Pick<SandboxModeController, 'delegate' | 'delegateFromLog'>;
}

const subagentSchema = z.object({
  description: z.string().describe('交給子代理的任務，寫清楚它需要的背景與期待的產出。'),
  subagent_type: z.string().describe('要用哪一種子代理（見上面的清單）。'),
  run_in_background: z
    .boolean()
    .optional()
    .describe('預設 true：當場回子代理編號，你接著做別的事。要等結果才能往下時傳 false。'),
});

/**
 * 基座 `task` 描述裡跟「背景」矛盾的兩句：一次性的生命週期（`ephemeral`）與「每次都是全新的、只回一份最終報告」。
 * 逐字錨點，**換的是基座 1.13.1 的原文**；原文變了這裡的比對會落空，`background-delegation.test.ts` 的上游絆索會紅，
 * 那時要重讀新的描述再決定怎麼改。
 */
export const TASK_DESCRIPTION_REWRITES: readonly (readonly [from: string, to: string])[] = [
  ['Launch an ephemeral subagent', 'Launch a subagent'],
  [
    'Each invocation is stateless: the agent sees only the prompt you give it and returns a single final report.',
    'Each new delegation starts fresh: the agent sees only the prompt you give it, and reports its final result when it finishes.',
  ],
];

/** 接在 `task` 描述後面的那一段。 */
const BACKGROUND_DESCRIPTION =
  '\n\n`run_in_background` 預設 true：子代理在背景跑，這次呼叫當場回它的編號，你可以接著做別的事。' +
  '要等它的結果才能往下時傳 `false`，這次呼叫會等它跑完並回結果。';

/** 接在系統提示詞後面的那一句（dsh `tool-subagent/src/index.ts:594-603`）。 */
const PARALLEL_SENTENCE =
  '要派幾個互不相依的子代理時，在同一則訊息裡一起呼叫 `subagent`，派出去後繼續做有用的事，不要乾等。';

/**
 * 背景派出的接線點：一份組裝一個。`createNexusAgent` 建它，`attachSession` 時 {@link BackgroundDelegation.attach}
 * 建 host（**在任何圖的環境之外**，見 `background-subagents.ts` 檔頭）。
 */
export class BackgroundDelegation {
  readonly #options: BackgroundSubagentsOptions;
  #host: BackgroundSubagentHost | undefined;
  /** 當次請求裡看到的基座 `task`。前景改派要用它的實例。 */
  #baseTask: StructuredToolInterface | undefined;
  /** 描述沒變就重用同一個工具實例。 */
  #tool: { readonly description: string; readonly instance: StructuredToolInterface } | undefined;

  constructor(options: BackgroundSubagentsOptions = {}) {
    this.#options = options;
  }

  /**
   * 會話接上來時建 host。
   *
   * @param sessions - 這次組裝綁的會話註冊表。
   * @param compile - 按名字編帶存檔點的圖（`AgentHandle.compileSubagent` 包好存檔點）。
   * @returns 收掉的函式（等進行中的輪收完）。
   */
  attach(
    sessions: SessionRegistry,
    compile: (subagent: string) => BackgroundAgent,
  ): () => Promise<void> {
    const sandbox = this.#options.sandbox;
    const host = new BackgroundSubagentHost({
      sessions,
      compile,
      ...(sandbox !== undefined && {
        enter: <T>(log: SessionLog, run: () => T): T => sandbox.delegateFromLog(log, run),
      }),
    });
    this.#host = host;
    return async () => {
      if (this.#host === host) this.#host = undefined;
      await host.close();
    };
  }

  /** 組裝用的條目：一顆最外層的 middleware。 */
  entry(): PluginEntry {
    return {
      plugin: {
        name: 'background-delegation',
        apply: (registry) => {
          registry.middleware.use(this.#middleware(), { prepend: true });
        },
      },
    };
  }

  #subagentTool(baseDescription: string): StructuredToolInterface {
    const description =
      TASK_DESCRIPTION_REWRITES.reduce(
        (text, [from, to]) => text.replace(from, to),
        baseDescription,
      ) + BACKGROUND_DESCRIPTION;
    if (this.#tool?.description === description) return this.#tool.instance;
    const instance = tool(async () => '', {
      name: SUBAGENT_TOOL_NAME,
      description,
      schema: subagentSchema,
    }) as unknown as StructuredToolInterface;
    this.#tool = { description, instance };
    return instance;
  }

  #middleware() {
    return createMiddleware({
      name: BACKGROUND_DELEGATION_MIDDLEWARE_NAME,
      wrapModelCall: (request, handler) => {
        const base = request.tools.find((each) => each.name === BASE_DELEGATION_TOOL_NAME);
        // 子代理的疊沒有 `task`：什麼都不做。
        if (base === undefined) return handler(request);
        this.#baseTask = base as unknown as StructuredToolInterface;
        const description = typeof base.description === 'string' ? base.description : '';
        const { systemMessage } = request;
        return handler({
          ...request,
          tools: [
            ...request.tools.filter((each) => each.name !== BASE_DELEGATION_TOOL_NAME),
            this.#subagentTool(description),
          ],
          systemMessage: systemMessage.concat(`\n${PARALLEL_SENTENCE}`),
        });
      },
      wrapToolCall: async (request, handler) => {
        if (request.toolCall.name !== SUBAGENT_TOOL_NAME) return handler(request);
        const callId = request.toolCall.id ?? '';
        const parsed = subagentSchema.safeParse(request.toolCall.args);
        if (!parsed.success) {
          return toolRefusal(`subagent 的參數不合：${parsed.error.message}`, {
            callId,
            name: SUBAGENT_TOOL_NAME,
          });
        }
        const {
          description,
          subagent_type: subagentType,
          run_in_background: background,
        } = parsed.data;

        if (background === false) {
          const base = this.#baseTask;
          if (base === undefined) {
            return toolRefusal('沒有可用的 task 工具，前景委派做不了', {
              callId,
              name: SUBAGENT_TOOL_NAME,
            });
          }
          const result = await handler({
            ...request,
            toolCall: {
              ...request.toolCall,
              name: BASE_DELEGATION_TOOL_NAME,
              args: { description, subagent_type: subagentType },
            },
            tool: base,
          } as never);
          // 模型叫的是 `subagent`，回給它的結果也用這個名字。`task` 收尾回的是 `Command`（帶狀態更新），
          // 訊息在 `update.messages` 裡；只換屬於這次呼叫的那一則，其餘原樣留著。
          return renameResult(result, callId);
        }

        const host = this.#host;
        if (host === undefined) {
          return toolRefusal('背景子代理還沒接上會話，派不出去', {
            callId,
            name: SUBAGENT_TOOL_NAME,
          });
        }
        try {
          // **接受那一刻**：同步（沒有 await），包在沙箱的 delegate 裡。
          const sandbox = this.#options.sandbox;
          const start = () => host.start({ subagent: subagentType, text: description });
          const started = sandbox === undefined ? start() : sandbox.delegate(start);
          // 編號告訴折疊器：背景那一輪的卡從日誌開、namespace 是 `[編號, 'tools']`，沒有這一格就永遠認不出是誰的
          // （#832）。寫在這次呼叫自己的槽裡，圍堵收尾時帶進 `tool/result`，即時與重播是同一份。
          const key: BackgroundSubagentMeta = {
            kind: 'background-subagent',
            runId: started.runId,
            subagentType,
          };
          putToolResultMeta(SUBAGENT_TOOL_NAME, key);
          // 第一輪的下場不在這次呼叫裡等：失敗已記在它自己的日誌（`outcome` 永遠不 reject）。
          return new ToolMessage({
            content: `子代理已在背景啟動，編號：${started.runId}（${subagentType}）。`,
            tool_call_id: callId,
            name: SUBAGENT_TOOL_NAME,
          });
        } catch (error) {
          return toolRefusal(error instanceof Error ? error.message : String(error), {
            callId,
            name: SUBAGENT_TOOL_NAME,
          });
        }
      },
    });
  }
}

/** 一則工具結果改名成 `subagent`：ToolMessage 直接換；`Command` 換它 `update.messages` 裡屬於這次呼叫的那一則。 */
function renameResult<T>(result: T, callId: string): T {
  const rename = (message: ToolMessage): ToolMessage =>
    new ToolMessage({
      content: message.content,
      tool_call_id: message.tool_call_id,
      name: SUBAGENT_TOOL_NAME,
      status: message.status,
      ...(message.artifact !== undefined && { artifact: message.artifact }),
      ...(message.additional_kwargs !== undefined && {
        additional_kwargs: message.additional_kwargs,
      }),
    });
  if (ToolMessage.isInstance(result)) return rename(result) as T;
  if (!(result instanceof Command)) return result;
  const update = result.update;
  if (typeof update !== 'object' || update === null || !('messages' in update)) return result;
  const messages = (update as { messages: unknown }).messages;
  if (!Array.isArray(messages)) return result;
  const next = messages.map((message: unknown) =>
    ToolMessage.isInstance(message) && message.tool_call_id === callId ? rename(message) : message,
  );
  return new Command({
    update: { ...(update as Record<string, unknown>), messages: next },
    ...(result.goto !== undefined && { goto: result.goto }),
    ...(result.graph !== undefined && { graph: result.graph }),
    ...(result.resume !== undefined && { resume: result.resume }),
  }) as T;
}
