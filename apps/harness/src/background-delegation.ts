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
 * （plugin middleware 也射進去，#327）沒有 `task`，`wrapModelCall` 在那裡不加 `subagent`；`wrapToolCall` 按呼叫者身分只接手
 * root 的，子代理幻覺出來的 `subagent` 呼叫原樣交下去、落到 `UNKNOWN_TOOL`（[#1045](https://github.com/DemianLi/nexus-agent/issues/1045)：
 * 之前只比工具名，子代理那一層也接手，前景用 root 那份 `task` 派出巢狀孫代理、背景把孫代理掛到 root 的 host 上）。
 *
 * ## 沙箱快照
 *
 * 接受那一刻用控制器的 `delegate` 包住 {@link BackgroundSubagentHost.start}：日誌在包裡開，參與者把
 * `sandbox/mode {source:'delegation'}` 寫進去；之後每一輪由 host 的 `enter` 用 `delegateFromLog` 讀回（#827）。
 * **沒有控制器**（沒掛沙箱 plugin 的組裝）時兩頭都原樣跑——`delegateFromLog` 在日誌上找不到那一顆會拋。
 *
 * @module
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { INVALID_ARGS, putToolResultMeta, toolCallSessionAddress, toolRefusal } from '@nexus/core';
import type { PluginEntry, SessionLog, SessionRegistry, ToolErrorInfo } from '@nexus/core';
import type { SandboxModeController } from '@nexus/plugin-sandbox-policy';
import { createMiddleware } from 'langchain';
import type { BackgroundSubagentMeta } from '@nexus/wire';
import { z } from 'zod';

import { isBackgroundAddress } from './background-run-id.js';
import {
  BackgroundSubagentError,
  BackgroundSubagentHost,
  backgroundRefusalInfo,
  withReturnGuidance,
} from './background-subagents.js';
import type { BackgroundParentPort, ModelChoice } from './background-subagents.js';
import { describeSubagentModels, resolveModelSelection } from './subagent-model-selection.js';
import type { ModelSelectionConfig } from './subagent-model-selection.js';
import type { BackgroundAgent, BackgroundSubagentControl } from './background-subagents.js';

/** 模型看到的工具名（dsh 的預設名，`toolName: 'subagent'`）。 */
export const SUBAGENT_TOOL_NAME = 'subagent';
/** 列出自己派出的背景子代理（dsh `tool-subagent-control/src/list-agents.ts`，`477b4f4`）。 */
export const LIST_AGENTS_TOOL_NAME = 'list_agents';
/** 列出授權清單裡的模型（#877；dsh `tool-subagent/src/list-models.ts`，`477b4f4`）。 */
export const LIST_SUBAGENT_MODELS_TOOL_NAME = 'list_subagent_models';
/** 只停一個背景子代理當下那一輪（dsh `tool-subagent-control/src/index.ts`，`477b4f4`）。 */
export const INTERRUPT_AGENT_TOOL_NAME = 'interrupt_agent';
/** 對背景子代理追加指示（dsh `tool-subagent-control/src/index.ts`，`477b4f4`）。 */
export const SEND_MESSAGE_TOOL_NAME = 'send_message';
/** 被換掉的基座委派工具。 */
const BASE_DELEGATION_TOOL_NAME = 'task';
/** `subagent` 參數不合 schema 時的碼，同圍堵認出 schema 不合時給的那一組（dsh `ToolArgsError`）。 */
const SUBAGENT_ARGS_ERROR: ToolErrorInfo = { name: 'ToolArgsError', code: INVALID_ARGS };

/** 這個 middleware 的名字。 */
export const BACKGROUND_DELEGATION_MIDDLEWARE_NAME = 'nexusBackgroundDelegation';

/** 選項：只有沙箱那一頭，其餘都從組裝推。 */
export interface BackgroundSubagentsOptions {
  /** 沙箱控制器（cli／serve 建的那一個）。沒有就不做快照與讀回。 */
  readonly sandbox?: Pick<SandboxModeController, 'delegate' | 'delegateFromLog'>;
  /** 每個主對話同時存活的背景子代理上限，預設 8（#836），見 `BackgroundSubagentHostOptions.maxActive`。 */
  readonly maxActive?: number;
  /**
   * 依選擇建一顆模型實例（[#876](https://github.com/DemianLi/nexus-agent/issues/876)、
   * [#877](https://github.com/DemianLi/nexus-agent/issues/877)）：背景子代理被指定了模型（與推理等級）時，組裝點用它建出那一張圖
   * 要用的模型。**每個 `(子代理, 模型, 推理等級)` 只被叫一次**（host 快取編好的圖），實例不共用。
   * 省略＝這份組裝建不出別的模型（沒連真實供應商的組裝），指定模型的圖當場編不出來。
   */
  readonly modelFor?: (choice: ModelChoice) => BaseChatModel;
  /**
   * 這個會話允許模型逐次替子代理挑模型（#877）：**給了，`subagent` 才多 `model`／`reasoning_effort` 兩格並註冊
   * `list_subagent_models`；省略，這兩樣都不存在、帶了這兩格的呼叫會被拒絕**。授權清單是日誌上記著的政策（#875），
   * 由 serve 在 `createAgent` 時取樣／讀回後傳進來；工具面在整個會話內不變（dsh：定義靜態，catalog 變動不改 prompt 前綴）。
   */
  readonly modelSelection?: ModelSelectionConfig;
}

const subagentSchema = z.object({
  description: z.string().describe('交給子代理的任務，寫清楚它需要的背景與期待的產出。'),
  subagent_type: z.string().describe('要用哪一種子代理（見上面的清單）。'),
  run_in_background: z
    .boolean()
    .optional()
    .describe('預設 true：當場回子代理編號，你接著做別的事。要等結果才能往下時傳 false。'),
});

/** 開了選模型的 `subagent`：多兩個選填欄位（#877；欄位名照 dsh，沒有 `provider`）。 */
const selectingSubagentSchema = subagentSchema.extend({
  model: z
    .string()
    .optional()
    .describe(
      '子代理用哪一顆模型（型錄 id）。省略＝沿用你現在用的這顆。先用 list_subagent_models 看可選的。',
    ),
  reasoning_effort: z
    .string()
    .optional()
    .describe(
      '子代理在這顆模型上的推理等級。省略＝這顆模型的預設；換了模型卻沒給，也用新模型的預設。',
    ),
});

/** 接在描述後面、講怎麼選模型的那一段（#877；照 dsh `choiceDescription` 的意思）。 */
const SELECTION_DESCRIPTION =
  '\n\n選模型是選填的：省略 `model` 與 `reasoning_effort` 就沿用你現在的模型。要指定時，先用 `list_subagent_models` ' +
  '看可選的模型與它的推理等級；換了模型卻沒給推理等級，就用新模型的預設。選模型只在背景委派（`run_in_background` 為 true）時可用。';

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
   * @param port - 背景子代理往主對話這個方向的出口：結算通知（#840）與子代理寫來的話（#849）。**沒給就沒有人被通知、
   *   子代理也寄不出去**：cli 的 REPL 一行一輪，沒有可以叫醒的一輪。
   * @returns 收掉的函式（等進行中的輪收完），上面掛著 `control`：wire 對單一背景子代理傳話、單獨停的控制面（#865）。
   */
  attach(
    sessions: SessionRegistry,
    compile: (subagent: string, choice?: ModelChoice) => BackgroundAgent,
    port: BackgroundParentPort = {},
  ): (() => Promise<void>) & { readonly control: BackgroundSubagentControl } {
    // 一份組裝一個會話（serve 一條 thread 一份組裝）：第二次接上會把第一個 host 的位置蓋掉，
    // 那個 host 的子代理就從工具的視線裡消失，所以直接拒絕，不靜靜蓋掉。
    if (this.#host !== undefined) throw new Error('背景子代理已經接上一個會話，一份組裝只接一個');
    const sandbox = this.#options.sandbox;
    const host = new BackgroundSubagentHost({
      sessions,
      compile,
      ...(port.onSettled !== undefined && { onSettled: port.onSettled }),
      ...(port.onMessage !== undefined && { onMessage: port.onMessage }),
      ...(port.onStatus !== undefined && { onStatus: port.onStatus }),
      ...(this.#options.maxActive !== undefined && { maxActive: this.#options.maxActive }),
      ...(sandbox !== undefined && {
        enter: <T>(log: SessionLog, run: () => T): T => sandbox.delegateFromLog(log, run),
      }),
    });
    this.#host = host;
    const close = async (): Promise<void> => {
      if (this.#host === host) this.#host = undefined;
      await host.close();
    };
    return Object.assign(close, { control: host.control });
  }

  /** 組裝用的條目：一顆最外層的 middleware。 */
  entry(): PluginEntry {
    return {
      plugin: {
        name: 'background-delegation',
        apply: (registry) => {
          registry.middleware.use(this.#middleware(), { prepend: true });
          // 只在 root：子代理不派子代理，也不該去列別人派的。
          registry.tools.register(this.#listAgentsTool(), { rootOnly: true });
          registry.tools.register(this.#interruptAgentTool(), { rootOnly: true });
          // 只有這個會話有授權清單才註冊（#877；dsh：`list_subagent_models` 只在政策存在時註冊）。
          if (this.#options.modelSelection !== undefined) {
            registry.tools.register(this.#listSubagentModelsTool(), { rootOnly: true });
          }
          // `send_message` 不是 rootOnly：背景子代理要能往上傳訊（#849）。誰能傳給誰由工具本體按呼叫者身分判。
          registry.tools.register(this.#sendMessageTool());
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
    const selecting = this.#options.modelSelection !== undefined;
    const instance = tool(async () => '', {
      name: SUBAGENT_TOOL_NAME,
      description: selecting ? description + SELECTION_DESCRIPTION : description,
      schema: selecting ? selectingSubagentSchema : subagentSchema,
    }) as unknown as StructuredToolInterface;
    this.#tool = { description, instance };
    return instance;
  }

  /**
   * `list_agents`：薄薄一層，讀 host 的目錄，不自己另存一份。名字、描述與輸出逐字照 dsh
   * （`tool-subagent-control/src/list-agents.ts`）。
   *
   * **描述裡「做完會通知」「用 send_message 接著談」兩句是 dsh 的原文**，那兩個機制是 #840、#839；
   * 這個選項在 #841 翻預設之前不進產品，翻預設的前置就是它們都合併。
   *
   * 只做 `children`：我們沒有子代理再派子代理，`descendants` 沒有東西可列；診斷列（目錄壞掉）在行程內不會發生。
   */
  #listAgentsTool() {
    return tool(
      () => {
        const host = this.#host;
        if (host === undefined) throw new Error('背景子代理還沒接上會話，列不出來');
        const entries = host.list();
        return entries.length === 0
          ? '(no subagents)'
          : entries.map((entry) => `${entry.runId} [${entry.status}] — ${entry.label}`).join('\n');
      },
      {
        name: LIST_AGENTS_TOOL_NAME,
        description:
          'List subagents you started, with their ids, labels, and status. ' +
          'running means it is working; inactive means it is not currently working. ' +
          'You will be notified when a subagent finishes; there is no need to keep checking its status. ' +
          'Use send_message to continue the conversation.',
        schema: z.object({}),
      },
    );
  }

  /**
   * `list_subagent_models`（#877）：授權清單裡有哪些模型、某一顆有哪些推理等級。**schema 固定、不列舉模型**（dsh：
   * 把會變動的清單放進每次請求的前綴會讓快取失效）。授權在前，不在清單裡的 id 一律拒絕，見 `describeSubagentModels`。
   */
  #listSubagentModelsTool() {
    const selection = this.#options.modelSelection!;
    return tool(({ model }: { model?: string }) => describeSubagentModels(selection, { model }), {
      name: LIST_SUBAGENT_MODELS_TOOL_NAME,
      description:
        'List the models a subagent may use, without changing your own. Call with no arguments to list the authorized ' +
        'models, or with `model` to see the reasoning efforts of that exact model. Use the returned ids with the ' +
        '`model` and `reasoning_effort` fields of the subagent tool.',
      schema: z.object({
        model: z
          .string()
          .optional()
          .describe('Exact model id to inspect. Omit to list the authorized models.'),
      }),
    });
  }

  /**
   * `interrupt_agent`：只停該背景子代理當下那一輪，**不等它停穩就回**。名字、描述與參數逐字照 dsh
   * （`tool-subagent-control/src/index.ts`）。
   *
   * 不存在的、沒在跑的、別人（別的主對話）的編號都是被接受的 no-op，照樣回同一句（dsh 明寫，也讓模型
   * 不能藉由回應試探編號）。host 是這個主對話的，別人的編號在這裡本來就不存在。
   * 描述裡「用 send_message 接著談」是 dsh 原文，對應機制是 #839。
   */
  #interruptAgentTool() {
    return tool(
      ({ agent_id }: { agent_id: string }) => {
        const host = this.#host;
        if (host === undefined) throw new Error('背景子代理還沒接上會話，停不了');
        host.interrupt(agent_id);
        return `interrupt requested for agent ${agent_id}`;
      },
      {
        name: INTERRUPT_AGENT_TOOL_NAME,
        description:
          'Ask a subagent to stop its current work. This call returns without waiting for it to stop. ' +
          "You can continue a direct child's conversation later with send_message. " +
          'Subagents it started will keep running.',
        schema: z.object({
          agent_id: z
            .string()
            .describe(
              'The id of an agent created under you: your direct child or a deeper descendant.',
            ),
        }),
      },
    );
  }

  /**
   * `send_message`：回的是**送達回條，不是對方的回答**。兩個方向，由**呼叫者的身分**決定（`toolCallSessionAddress`）：
   *
   * - root → 自己派出去的背景子代理（#839）：`host.send`。
   * - 背景子代理 → 它的直接 parent（#849）：`host.sendToParent`，收件人必須是 root 的會話 id。
   * - 其他（前景一次性子代理、認不出身分）：拒絕。dsh「只有 resident continuable 的 Activation 能傳給 parent」。
   *
   * **描述是 dsh 的原文**（#858 之後）：跑著的子代理在下一步領走（`BackgroundSubagentHost.send` 插進它當下那一輪），閒著的開新的一輪。
   * 傳給 parent 那一向，主對話有 `next-step`，忙著就插進去。
   */
  #sendMessageTool() {
    return tool(
      ({ agent_id, message }: { agent_id: string; message: string }, config?: unknown): string => {
        const host = this.#host;
        if (host === undefined) throw new Error('背景子代理還沒接上會話，傳不了');
        const address = toolCallSessionAddress(config);
        if (address?.kind === 'root') {
          void host.send({ runId: agent_id, message });
        } else if (address !== undefined && isBackgroundAddress(address)) {
          host.sendToParent({
            runId: (address as { runId: string }).runId,
            targetId: agent_id,
            message,
          });
        } else {
          throw new Error(
            '只有主對話與可繼續的背景子代理能用 send_message；你是一次性子代理，做完把結果當最後一則回覆交回去就好',
          );
        }
        return `message delivered to agent ${agent_id}`;
      },
      {
        name: SEND_MESSAGE_TOOL_NAME,
        description:
          'Send a message to an agent. A working agent receives it at its next step; an idle agent starts a new turn with it. ' +
          "Returns delivery confirmation, not the agent's answer.",
        schema: z.object({
          agent_id: z
            .string()
            .describe(
              'The id of one of your background subagents (from subagent or list_agents), or your direct parent when you are a resident continuable child.',
            ),
          message: z.string().describe('The message to deliver to the agent.'),
        }),
      },
    );
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
        // 只接手 root 的呼叫（#1045）：`subagent` 只在 root 那一層的模型視野裡（上面看到 `task` 才加），子代理的模型看不到它，
        // 叫了就原樣交下去，落到基座的「沒有這顆工具」、由最內層標 `UNKNOWN_TOOL`（#1024）。同 dsh：派發與 schema 用同一份
        // 逐 agent 視圖，看不到的呼叫在派發那一步是 `ToolNotFoundError`（`packages/core/tools/src/index.ts:1230-1252`、
        // `:1578-1579`，`5badb15`）。這一份實例掛在每一層（#327），哪一層要從這次呼叫的身分查（`registry.ts` 的 `use`）；
        // 認不出身分的也不接手。前提：root 那一層有 `task`——沒有 profile 拿掉它（基座內建的 profile 沒有）。
        const caller = toolCallSessionAddress({ configurable: request.runtime?.configurable });
        if (caller?.kind !== 'root') return handler(request);
        const callId = request.toolCall.id ?? '';
        const selection = this.#options.modelSelection;
        // 沒開選模型卻帶了這兩格：拒絕，不靜靜忽略（zod 預設會丟掉多餘欄位，模型會以為選了）。dsh：關著的實例不但不顯示、還拒絕。
        if (selection === undefined) {
          const raw = request.toolCall.args as Record<string, unknown> | undefined;
          if (raw !== undefined && ('model' in raw || 'reasoning_effort' in raw)) {
            return toolRefusal('這個會話沒有開子代理選模型，不能指定 model 或 reasoning_effort', {
              callId,
              name: SUBAGENT_TOOL_NAME,
            });
          }
        }
        const parsed = (
          selection === undefined ? subagentSchema : selectingSubagentSchema
        ).safeParse(request.toolCall.args);
        // 參數不合 schema 帶 `INVALID_ARGS`，同 dsh `defineTool` 的 `ToolArgsError`（`packages/core/tools/src/schema.ts:599`，
        // `5badb15`）。host 拒絕 `start`（名額滿、已關）照 dsh `SubagentError` 帶碼（#1046，見下面的 `catch`）；其餘拒絕
        // 不帶碼：dsh `subagent` 的同類拒絕是工具本體拋一般的 `Error`（`packages/subagent/tool-subagent/src/index.ts:294-295`），
        // 渲染出來沒有碼（#1024）。
        if (!parsed.success) {
          return toolRefusal(`subagent 的參數不合：${parsed.error.message}`, {
            callId,
            name: SUBAGENT_TOOL_NAME,
            error: SUBAGENT_ARGS_ERROR,
          });
        }
        const {
          description,
          subagent_type: subagentType,
          run_in_background: background,
        } = parsed.data;
        const requested = parsed.data as { model?: string; reasoning_effort?: string };
        const asksForModel =
          requested.model !== undefined || requested.reasoning_effort !== undefined;

        // 前景走基座的 `task`，它的圖與模型在組裝期寫死，帶不進去（#877 的偏離登記）：拒絕，不靜靜用 root 的。
        if (background === false && asksForModel) {
          return toolRefusal(
            '只有背景委派能指定 model 或 reasoning_effort；前景（run_in_background 為 false）用你現在的模型',
            { callId, name: SUBAGENT_TOOL_NAME },
          );
        }
        let choice: ModelChoice | undefined;
        if (selection !== undefined) {
          const resolved = resolveModelSelection(selection, requested);
          if (!resolved.ok) {
            return toolRefusal(resolved.error, { callId, name: SUBAGENT_TOOL_NAME });
          }
          choice = resolved.choice;
        }

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
          // 回報指引只接在背景派出去的（#849）：前景的 `task` 是一次性的，寄不出話，也不該被告知要寄。
          const start = () =>
            host.start({
              subagent: subagentType,
              text: withReturnGuidance(description, host.rootSessionId),
              ...(choice !== undefined && { choice }),
              // root 那一份記子代理目錄，指回這一顆呼叫（#1023）。
              ...(callId !== '' && { callId }),
            });
          const started = sandbox === undefined ? start() : sandbox.delegate(start);
          // 編號告訴折疊器：背景那一輪的卡從日誌開、namespace 是 `[編號, 'tools']`，沒有這一格就永遠認不出是誰的
          // （#832）。寫在這次呼叫自己的槽裡，圍堵收尾時帶進 `tool/result`，即時與重播是同一份。
          const key: BackgroundSubagentMeta = {
            kind: 'background-subagent',
            runId: started.runId,
            subagentType,
            // 被指定的模型與推理等級（#889）：畫面據它說這個子代理跑哪一顆；沒指定就不放，跟著主對話。
            ...(choice !== undefined && {
              model: choice.model,
              ...(choice.effort !== undefined && { reasoningEffort: choice.effort }),
            }),
          };
          putToolResultMeta(SUBAGENT_TOOL_NAME, key);
          // 第一輪的下場不在這次呼叫裡等：失敗已記在它自己的日誌（`outcome` 永遠不 reject）。
          return new ToolMessage({
            content: `子代理已在背景啟動，編號：${started.runId}（${subagentType}）。`,
            tool_call_id: callId,
            name: SUBAGENT_TOOL_NAME,
          });
        } catch (error) {
          // host 拒絕（名額滿、已關）帶 dsh `SubagentError` 的碼（#1046），見 `backgroundRefusalInfo`；其餘（編不出圖等）不帶。
          const info =
            error instanceof BackgroundSubagentError ? backgroundRefusalInfo(error) : undefined;
          return toolRefusal(error instanceof Error ? error.message : String(error), {
            callId,
            name: SUBAGENT_TOOL_NAME,
            ...(info !== undefined && { error: info }),
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
