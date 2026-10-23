/**
 * **每次模型呼叫實際送出的東西，變了才記一份進日誌**
 * （[#1020](https://github.com/DemianLi/nexus-agent/issues/1020)）：系統提示詞、工具清單、呼叫設定。
 *
 * 追溯一輪「為什麼回得不聰明」，今天看得到模型做了什麼、想了什麼，看不到它**當時被給了什麼**：系統提示詞由多顆
 * middleware 現組、工具清單被改寫（`task` 的說明按註冊的子代理現組、子代理的工具被篩）、取樣設定寫死在模型建構式裡，日誌一份都沒記。
 * 唯一送出完整請求的是 LangSmith tracing，預設端點在外網，跟完全內網的前提衝突。
 *
 * ## 兩顆事件，照 dsh 的快照語意
 *
 * - `request/header`：`{ header: { config, tools? }, reason }`，照 dsh 同名事件（`packages/core/session/src/types.ts:390-397`，
 *   `5badb15`）——**變更才記一份完整快照**，不是每次呼叫都記。
 * - `request/system`：`{ system, reason }`，渲染後的系統提示詞全文，同樣變更才記。dsh 把它叫 `system/message`，是模型可見
 *   的 surface 節點（`packages/core/session/src/types.ts:330`）、對話史就從它導出；我們的對話史由訊息串重建、系統提示詞是
 *   每次呼叫現組的，這顆**只是快照、不進模型**——名字沿用會讓照 dsh 的投影去讀它的人靜靜讀錯（同 `model/start` 不叫
 *   `step/start` 的理由，見 `model-calls.ts`），所以換一個講實話的名字。
 *
 * 兩顆分開（dsh 也分開，`header.system` 明令不准有）：系統提示詞很長、很少變；工具與設定短、變得勤。合成一顆的話，工具清單
 * 一變就得把幾十 KB 的提示詞再抄一遍。
 *
 * 兩顆都帶 `modelCall`（[#1021](https://github.com/DemianLi/nexus-agent/issues/1021)），指回**記下它的那次呼叫**的
 * `model/start`。`reason` 是 `'initial'`（這份日誌第一份）或 `'change'`（跟上一份不同）。
 *
 * ## 記錄點：模型本身，不是 middleware
 *
 * 「記到的就是送出的」是這張卡的承重句。請求在 middleware 洋蔥裡一路被改寫，而**我們的 `wrapModelCall` 不是洋蔥最內層**：
 * deepagents 把它自己的幾顆放在我們交出去那串的**後面**（`createDeepAgent` 的 `mergeMiddlewareStack`，
 * `deepagents@1.13.1`）——`memory`（把記憶檔內容附加到系統提示詞）、prompt cache、工具排除（`createToolExclusionMiddleware`，
 * 最後才 push）。排在我們最內層的 middleware 看到的請求，還要再被它們改一輪。
 *
 * 所以記錄點放在**模型被叫的那一刻**：本檔的 middleware 把 `request.model` 包上一個 callback handler，
 * `handleChatModelStart` 拿到的就是 LangChain 即將送進供應商的東西——含系統訊息的完整訊息串、`bindTools` 之後的工具
 * （`options.tools`／`invocation_params.tools`）、供應商層的呼叫參數（`invocation_params`：模型 id、溫度、top_p、輸出上限、
 * 推理強度）。這一格不依賴 middleware 的順序，記到的就是送出的。實測見 `request-snapshot.test.ts`。
 *
 * 掛 callback 要往 `request.model` 上綁設定，而基座之後綁工具只認**一層** `RunnableBinding`；中止訊號那顆也在綁，所以兩顆經
 * {@link ./model-binding.ts} 併成同一層，不各包一層（疊兩層，產品路徑上整輪失敗）。
 *
 * handler 設 `awaitHandlers = true`：事件在請求送出**之前**落地，不會被背景化到回覆之後。
 *
 * ## 偏離 dsh
 *
 * - **沒有 `reason: 'resume'` 與 `'series'`。** dsh 的 loop 實例第一次請求即使 header 沒變也記一份 `'resume'`；我們
 *   用日誌上最後一份當基準，**續接後沒變就不重記**（卡 #1020 的驗收句：長會話不讓日誌線性膨脹）。`'series'`
 *   是 dsh 為提示快取前綴分析標「新的訊息序列」，我們沒有消費者。續接時要 stringify 日誌上最後一份 header 當基準
 *   （`baselineOf`），建不起來那條 thread 就送不出去（#1726 起不再吞）。判斷不可達：`request/header` 沒進過任何一版
 *   release；寫入時同一份 header 已在同一個 handler 裡被原生 `JSON.stringify` 過，同一個 runtime 續接不會拋。剩下的只有
 *   跨 runtime（撐得較深的 Node 寫、Node 22 續接），那時這次請求的 HTTP body 一樣 stringify 不出去。
 * - **沒有 `request/context`**（dsh 的路由中繼資料：上下文窗口、`systemPromptUpdate`）。我們的窗口由設定檔型錄給，
 *   不是請求帶的。
 * - **`config` 是供應商層實際收到的參數**（`invocation_params`），不是 dsh 的 `LlmCallConfig{provider, model, reasoningEffort,
 *   temperature, maxTokens, stop}`：LangChain 的模型實例沒有 provider 欄；多出來的 body 參數（如關思考的 `thinking`）
 *   進 `config.extra`，因為那正是「為什麼這次回得不一樣」的線索。
 * - **系統提示詞只記文字。** 內容區塊裡的非文字部分（如 Anthropic 的 `cache_control` 標記）不記。
 *
 * ## 已知的限制
 *
 * - **每次呼叫都變的提示詞，每次都記。** 比對的是渲染後的全文；有 plugin 把時間戳、計數器之類的東西夾進系統提示詞，就是
 *   每次呼叫一份。出廠的提示詞組裝沒有這種內容（實測連續呼叫只記一份），但新 plugin 這樣做時日誌會線性膨脹——要在那個
 *   plugin 的設計裡避開，不是在這裡截。
 * - **腳本模型不報呼叫參數與工具。** `ScriptedChatModel` 沒有 `invocationParams`，所以它組出來的快照 `config` 是空的；
 *   帶工具與設定的比對一律用真的 `ChatOpenAI` 打本機假端點（`apps/harness/src/request-snapshot.test.ts`）。
 * - **動態模型（函式）不記。** `request.model` 不是 Runnable 時包不了，照舊交出去。
 *
 * ## 不進模型，遙測不放行
 *
 * 兩顆都用 `{ ignorable: true }` 寫（[#507](https://github.com/DemianLi/nexus-agent/issues/507)：純資訊性的新種類不升格式版本），
 * 不在 `MODEL_VISIBLE_EVENT_TABLE`。會話遙測的鏡像**不送**它們（系統提示詞可能含工作區內容，見
 * {@link ./session-telemetry.ts | isMirroredEvent}）。
 *
 * ## 記不進去，這次請求不送（[#1726](https://github.com/DemianLi/nexus-agent/issues/1726)）
 *
 * 照 dsh：`request/header` 直接 `append`、不吞（`packages/core/agent-loop/src/agent.ts:637-650`，`687f282e`），寫不進去這次請求
 * 就不送，「日誌 = 模型收到的」不破。抽取、比對、`append` 任何一步拋，都讓這次模型呼叫在送出**之前**失敗：handler 設
 * `raiseError = true`，LangChain 的 `handleChatModelStart` 只在這個旗標為真時把 handler 的錯重拋
 * （`@langchain/core@1.2.9` `callbacks/manager.js:362-380`），所以基座表達得出來，不需要偏離。副作用：LangChain 重拋前會自己往
 * `console.error` 印一行 `Error in handler RequestSnapshotHandler, handleLLMStart: …`。
 *
 * 錯經 {@link ./model-calls.ts} 記成 `model/end{outcome:'error'}` 往外拋；它沒有回報碼，{@link ./stream-retry.ts} 不重打，同 dsh。
 * 基準只在**記成功之後**才前進（dsh 的 `requestHeaderLogged` 也是寫成功才設），所以下一次呼叫會再試、第一份照樣是 `initial`。
 *
 * 兩顆的寫入順序是先 `request/system` 後 `request/header`：**`append` 寫 header 時拋**（含超過深度上限），日誌上已經有這次的
 * `request/system`，它指回的那次呼叫 `model/end` 是 `outcome:'error'`、沒有送出。形狀同 dsh：`step()` 先寫 `system/message`（`agent.ts:423`）與 `user/message`
 * （`:430-439`），再寫 `request/header`（`:637-650`），header 寫不進去時那一步的 system 與 user 一樣留在日誌上。dsh 的不變量是
 * 「送出的必定在送出之前就在日誌上」，不是「日誌上的必定被送出」；讀 `request/system` 的地方取的是最近（生效）的那一份
 * （`packages/nexus-plugin-trajectory/src/trajectory.ts` 的 `noteSnapshot`、`apps/harness/src/log-derived-history.fixture.ts`）。
 *
 * **已知差異（#1731）：抽取階段拋的，連 `request/system` 都不寫。** {@link extractRequest} 是 {@link recordRequestSnapshot} 的引數，
 * 工具參數拷不動、巢狀太深都在抽取時就拋，輪不到寫 system；dsh 的 `step()` 在這一步已經寫了 system 與 user。#1731 之前，
 * 工具參數太深是 `append` 寫 header 時才拒，system 先落下了一顆；現在沒有。對讀的人沒有影響（沒送出的請求，日誌上沒有它的
 * 快照，下一次呼叫補記 `initial`），只是「失敗那一次也有 system」不再對這一類成立。
 *
 * header 超過寫入那一關的 600 層上限時，工具清單不變，這條 thread 之後**每次**呼叫都會在這裡失敗（#1726 驗收 4）。這是
 * #1661 偏離的後果，不是照 dsh：dsh 寫 header 那一關沒有深度上限（`packages/core/session/src/index.ts:808-811` 迭代的
 * `snapshotJsonValue`），601 層到原生 stringify 上限之間照寫照送；我們在這個區間 fail-closed（見 `session-log.ts` 的
 * `SESSION_EVENT_MAX_DEPTH`）。#1526 的有損值到不了這裡：工具參數與 `extra` 先經 `jsonCopy` 洗過，`config` 的數字欄把 `-0`
 * 正規化成 `0`。
 *
 * **先洗過再收，是偏離 dsh（理由 1，基座表達不出來）。** dsh 的 `snapshotJsonValue` 對巢狀的 `undefined`、函式、`toJSON`、`NaN`、
 * `-0` 一律拒收；我們用 `JSON.stringify` 洗掉。原因是基座送出時就是 `JSON.stringify`：LangChain 把請求 body 序列化成 JSON 才送
 * 給供應商，所以洗過之後的才是「模型實際收到的」，日誌上的才等於它。照 dsh 拒收的話，工具 schema 裡一個 `undefined` 欄位就讓
 * 那顆工具所在的每條 thread 每一輪都失敗，而供應商根本看不到那一格。
 *
 * ## 拷不動的參數也是這次請求不送，錯誤帶工具名稱（[#1731](https://github.com/DemianLi/nexus-agent/issues/1731)）
 *
 * 工具 `parameters` 與 `config.extra` 先拷成純 JSON 再進 header（{@link jsonCopy}）。改寫前拷不動（循環、頂層是函式、原生
 * stringify 爆堆疊）回 `undefined`、呼叫端把那一格拿掉，日誌上記下一份**少了參數**的 header，沒有任何提示；現在照 dsh 的
 * `append` 拒收：dsh 的 `snapshotJsonValue` 拷不動回 `undefined`，由 `Session.append` 拋（不帶路徑的通用 `Error`，
 * `packages/core/session/src/index.ts:808-811`），欄位不會被丟掉。我們當場拋，等於這次請求不送，同上一節。
 * **訊息帶「是哪一格」（`tools["name"].parameters`）是偏離，理由 2（產品需求超出 dsh）**，與 `session-log.ts` 的
 * `snapshotJsonValue` 已登記的「帶路徑的 `TypeError`」同類：多人共用的主機上，管理者要靠錯誤定位是哪一顆工具。
 * 深度超過上限的也一樣：寫入那一關的路徑只印前 8 段，看得到索引、看不到名字。
 *
 * @module
 */

import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { Serialized } from '@langchain/core/load/serializable';
import type { BaseMessage } from '@langchain/core/messages';
import { RunnableBinding } from '@langchain/core/runnables';
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from './base-types.js';
import { currentModelCall, withModelCall } from './model-call-scope.js';
import { bindModelConfig } from './model-binding.js';
import type { SessionLookup } from './registry.js';
import { nestingExceeds } from './logged-message.js';
import {
  SESSION_EVENT_MAX_DEPTH,
  SessionEventDepthError,
  snapshotJsonValue,
} from './session-log.js';
import type { SessionLog } from './session-log.js';

/** middleware 的名字。名字不撞基座任何一個，所以它是 novel entry。 */
export const REQUEST_SNAPSHOT_MIDDLEWARE_NAME = 'nexusRequestSnapshot';

/** 為什麼記這一份：這份日誌的第一份，或跟上一份不同。 */
export type RequestSnapshotReason = 'initial' | 'change';

/** 一件送給模型的工具的描述。 */
export interface RequestToolSchema {
  readonly name: string;
  readonly description?: string;
  /** JSON Schema，原樣。 */
  readonly parameters?: unknown;
}

/** 供應商層實際收到的呼叫設定。 */
export interface RequestConfig {
  readonly model?: string;
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxTokens?: number;
  readonly reasoningEffort?: string;
  readonly stop?: readonly string[];
  /** 其餘的 body 參數（`modelKwargs` 展開的，如關思考的 `thinking`），鍵照字母排。 */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** `request/header` 的酬載主體。 */
export interface RequestHeader {
  readonly config: RequestConfig;
  /** 沒有工具的請求整個不放這一格。 */
  readonly tools?: readonly RequestToolSchema[];
}

/** 從一次模型呼叫抽出來的、要記的東西。 */
export interface ExtractedRequest {
  readonly system: string;
  readonly header: RequestHeader;
}

/** `invocation_params` 裡不進 `config.extra` 的鍵：已經有專屬欄位、或不是「設定」。 */
const NOT_EXTRA = new Set([
  'model',
  'model_name',
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'max_output_tokens',
  'reasoning_effort',
  'reasoning',
  'stop',
  'tools',
  'functions',
  'messages',
  'stream',
  'stream_options',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 工具 `parameters` 與 `config.extra` 的值在 `request/header` 事件裡前面還有幾層：`data`（第 1 層）→ `header`（2）→
 * `tools` 或 `config`（3）→ 一顆工具或 `extra`（4），值本身的根從第 5 層起。所以值自己最多巢狀
 * {@link SESSION_EVENT_MAX_DEPTH} 減這一段，跟寫入那一關（`SessionLog.append`）拒收的是同一批。
 */
const HEADER_VALUE_PREFIX_DEPTH = 4;

/**
 * 拷成純 JSON，**拷不動就當場拋、帶上是哪一格**（[#1731](https://github.com/DemianLi/nexus-agent/issues/1731)）。
 *
 * 照 dsh 的 `append` 拒收：`request/header` 的內容原樣交給 `append`，`snapshotJsonValue` 拷不動回 `undefined`、`append` 拋，
 * 不會丟掉欄位（`packages/core/session/src/index.ts:808-811`，`687f282e`）。訊息帶「是哪一格」是理由 2 的偏離。改寫前這裡拷不動回 `undefined`、呼叫端把那一格拿掉，
 * 日誌上記下一份**少了參數**的 header，「日誌 = 模型收到的」不成立，也沒有任何提示。
 *
 * 值在 `JSON.stringify` 之後才進日誌，所以 JSON 本來就丟的（巢狀裡的 `undefined`、函式、`toJSON` 的轉換）照舊——那是
 * 供應商收到的 JSON，也是 #1526 說的「先洗過」（偏離 dsh，理由 1，見檔頭）。這裡拋的只有**整格拷不成 JSON**的：循環、頂層是函式／symbol、`BigInt`、
 * 原生 stringify 爆堆疊。
 *
 * **深度先量**：原生 `JSON.stringify` 是遞迴的（Node 22 約 4100 層就 `RangeError`），而寫入那一關另有 600 層的上限
 * （{@link SESSION_EVENT_MAX_DEPTH}，#1661）。後者拒收時錯誤訊息的路徑只印前 8 段，看得到工具的索引、看不到名字；
 * MCP 是 serve 層掛的，一個 server 的病態 schema 會讓掛了它的每條 thread 每一輪都失敗，管理者要能一眼找到是哪一顆。所以在拷之前
 * 先迭代量，超過就拋同一種 {@link SessionEventDepthError}（`classifyTurnFailure` 認它的 `code`），訊息帶 `where`。
 * 量的是同一條線，對 JSON 的工具 schema **不改變哪些值記得進去**。它量的是拷之前的值，跟拷之後不完全是同一個數：
 * 同一顆物件只走一次，會**少報**（交給 `append` 那一關，訊息照舊不帶名字）；任何 `typeof` 是 `object` 的都算一層，
 * 所以也會**多報**——最深處的 `Date` 在 JSON 往返後是字串，不再佔那一層，剛好 596 層的值會被這裡拒、`append` 其實收得下。
 * 工具 schema 實務上不帶 `Date` 這類東西；多報的方向是 fail-closed，不會讓寫不進去的值溜過去。
 *
 * @param where - 這個值是哪一格，例如 `tools["echo"].parameters`（括號裡是工具名稱，不是索引）；進錯誤訊息。
 */
function jsonCopy(value: unknown, where: string): unknown {
  const reject = (cause: unknown): never => {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new TypeError(`request/header 的 ${where} 拷不成純 JSON，這次請求不送：${reason}`, {
      cause,
    });
  };
  const limit = SESSION_EVENT_MAX_DEPTH - HEADER_VALUE_PREFIX_DEPTH;
  let exceeds = false;
  try {
    exceeds = nestingExceeds(value, limit);
  } catch (error) {
    return reject(error);
  }
  if (exceeds) {
    throw new SessionEventDepthError(
      `request/header 的 ${where} 巢狀太深：前面還有 ${HEADER_VALUE_PREFIX_DEPTH} 層，超過上限 ${SESSION_EVENT_MAX_DEPTH} 層`,
    );
  }
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    return reject(error);
  }
  if (text === undefined) return reject(new TypeError(`是 ${typeof value}，不是 JSON`));
  return JSON.parse(text) as unknown;
}

/** 一則訊息的文字（區塊裡只取文字部分）。 */
function textOf(message: BaseMessage): string {
  return message.text;
}

/** 把各供應商的工具形狀收成 {@link RequestToolSchema}；認不得形狀但有名字的只留名字。 */
function normalizeTool(raw: unknown): RequestToolSchema | undefined {
  if (!isRecord(raw)) return undefined;
  // OpenAI：{ type: 'function', function: { name, description, parameters } }
  const inner = isRecord(raw['function']) ? raw['function'] : raw;
  const name = inner['name'];
  if (typeof name !== 'string' || name === '') return undefined;
  const description = inner['description'];
  // 各家把 schema 放在不同的鍵：OpenAI `parameters`、Anthropic `input_schema`、LangChain 工具的 JSON `schema`。
  const parameters = inner['parameters'] ?? inner['input_schema'] ?? inner['inputSchema'];
  const copy =
    parameters === undefined
      ? undefined
      : jsonCopy(parameters, `tools[${JSON.stringify(name)}].parameters`);
  return {
    name,
    ...(typeof description === 'string' ? { description } : {}),
    ...(copy === undefined ? {} : { parameters: copy }),
  };
}

function extractConfig(
  invocation: Record<string, unknown>,
  fallbackModel: string | undefined,
): RequestConfig {
  const pick = (...keys: string[]): unknown => {
    for (const key of keys) if (invocation[key] !== undefined) return invocation[key];
    return undefined;
  };
  // `-0` 寫成 `0`：供應商收到的 JSON 就是 `0`，而寫入那一關拒收 `-0`（#1526），不正規化的話設了 `-0` 的主機每次呼叫都送不出去。
  const number = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? (value === 0 ? 0 : value) : undefined;
  const model = pick('model', 'model_name');
  const effortRaw = pick('reasoning_effort');
  const reasoning = invocation['reasoning'];
  const effort =
    typeof effortRaw === 'string'
      ? effortRaw
      : isRecord(reasoning) && typeof reasoning['effort'] === 'string'
        ? reasoning['effort']
        : undefined;
  const stop = invocation['stop'];
  const extraKeys = Object.keys(invocation)
    .filter((key) => !NOT_EXTRA.has(key) && invocation[key] !== undefined)
    .sort();
  const extra: Record<string, unknown> = {};
  for (const key of extraKeys) {
    extra[key] = jsonCopy(invocation[key], `config.extra.${key}`);
  }
  const resolvedModel = typeof model === 'string' ? model : fallbackModel;
  const temperature = number(pick('temperature'));
  const topP = number(pick('top_p'));
  const maxTokens = number(pick('max_tokens', 'max_completion_tokens', 'max_output_tokens'));
  return {
    ...(resolvedModel === undefined ? {} : { model: resolvedModel }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { topP }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
    ...(Array.isArray(stop) && stop.every((each) => typeof each === 'string')
      ? { stop: stop as string[] }
      : {}),
    ...(Object.keys(extra).length === 0 ? {} : { extra }),
  };
}

/**
 * 從 `handleChatModelStart` 收到的東西抽出要記的。純函式。
 *
 * @param messages - LangChain 即將送出的訊息串（一批一條，這裡只有一條）。
 * @param invocation - `extraParams.invocation_params`：供應商層的呼叫參數；沒有就是空物件。
 * @param options - `extraParams.options`：這次呼叫的選項，`bindTools` 綁的工具在 `tools`。
 * @param fallbackModel - 供應商層沒報模型 id 時的備援（模型實例序列化出來的 `model`）。
 */
export function extractRequest(
  messages: readonly (readonly BaseMessage[])[],
  invocation: unknown,
  options: unknown,
  fallbackModel?: string,
): ExtractedRequest {
  const batch = messages[0] ?? [];
  const system = batch
    .filter((message) => message.getType() === 'system')
    .map(textOf)
    .join('\n\n');
  const params = isRecord(invocation) ? invocation : {};
  const rawTools =
    (Array.isArray(params['tools']) ? params['tools'] : undefined) ??
    (isRecord(options) && Array.isArray(options['tools']) ? options['tools'] : undefined) ??
    [];
  const tools = rawTools.flatMap((raw) => {
    const tool = normalizeTool(raw);
    return tool === undefined ? [] : [tool];
  });
  return {
    system,
    header: {
      config: extractConfig(params, fallbackModel),
      ...(tools.length === 0 ? {} : { tools }),
    },
  };
}

/** 這份日誌上最後一份快照的指紋；`undefined` 表示還沒有。 */
interface Baseline {
  header: string | undefined;
  system: string | undefined;
}

const baselines = new WeakMap<SessionLog, Baseline>();

/** 第一次碰這份日誌時，從它已有的事件讀基準（續接一份舊日誌：沒變就不重記）。 */
function baselineOf(log: SessionLog): Baseline {
  const known = baselines.get(log);
  if (known !== undefined) return known;
  const fresh: Baseline = { header: undefined, system: undefined };
  const events = log.events;
  for (let at = events.length - 1; at >= 0; at -= 1) {
    const event = events[at]!;
    if (fresh.header === undefined && event.type === 'request/header') {
      // 先拷一份沒凍過的再 stringify（#1526）：日誌裡的是凍過的，V8 對凍過的巢狀撐得比較淺（CI 的 Node 22 上凍過的陣列
      // 約 2200 層、沒凍過的約 4100 層），續接回來的舊日誌可能更深（新寫的有 600 層上限，#1661）。拋在這裡的話基準永遠建不起來，
      // 這條 thread 之後每次呼叫都在送出之前失敗（#1726，見檔頭「記不進去，這次請求不送」）。
      fresh.header = JSON.stringify(
        snapshotJsonValue(event.data.header, 'request/header 的 header'),
      );
    } else if (fresh.system === undefined && event.type === 'request/system') {
      fresh.system = event.data.system;
    }
    if (fresh.header !== undefined && fresh.system !== undefined) break;
  }
  baselines.set(log, fresh);
  return fresh;
}

/**
 * 比對基準，變了（或第一份）就記。記成功才前進基準。
 *
 * @param log - 這次呼叫寫進的日誌。
 * @param modelCall - 這次呼叫的識別，見 {@link ./model-call-scope.ts}；沒有就不附。
 */
export function recordRequestSnapshot(
  log: SessionLog,
  request: ExtractedRequest,
  modelCall: number | undefined,
): void {
  const baseline = baselineOf(log);
  if (baseline.system !== request.system) {
    log.append(
      'request/system',
      withModelCall(
        {
          system: request.system,
          reason: baseline.system === undefined ? ('initial' as const) : ('change' as const),
        },
        modelCall,
      ),
      { ignorable: true },
    );
    baseline.system = request.system;
  }
  const header = JSON.stringify(request.header);
  if (baseline.header !== header) {
    log.append(
      'request/header',
      withModelCall(
        {
          header: request.header,
          reason: baseline.header === undefined ? ('initial' as const) : ('change' as const),
        },
        modelCall,
      ),
      { ignorable: true },
    );
    baseline.header = header;
  }
}

/** 模型被叫的那一刻抓請求。每次呼叫一個，綁著那次呼叫要寫進的日誌與識別。 */
class RequestSnapshotHandler extends BaseCallbackHandler {
  readonly name = 'nexusRequestSnapshot';
  /** 請求送出**之前**落地，不背景化。 */
  override awaitHandlers = true;
  /** 記不進去就讓這次請求不送（#1726）：LangChain 只在這個旗標為真時把 handler 的錯重拋。見檔頭。 */
  override raiseError = true;

  constructor(
    private readonly log: SessionLog,
    private readonly modelCall: number | undefined,
  ) {
    super();
  }

  override handleChatModelStart(
    llm: Serialized,
    messages: BaseMessage[][],
    _runId: string,
    _parentRunId?: string,
    extraParams?: Record<string, unknown>,
  ): void {
    const kwargs = (llm as { kwargs?: Record<string, unknown> }).kwargs ?? {};
    const fallback = kwargs['model'] ?? kwargs['model_name'] ?? kwargs['modelName'];
    recordRequestSnapshot(
      this.log,
      extractRequest(
        messages,
        extraParams?.['invocation_params'],
        extraParams?.['options'],
        typeof fallback === 'string' ? fallback : undefined,
      ),
      this.modelCall,
    );
  }
}

/**
 * 建那顆 middleware。**無狀態，一份走遍 root 與每個子代理**——日誌每次從執行期的 `configurable` 現算，基準住在日誌上
 * （`WeakMap`），不在 closure 裡。
 *
 * **要排在我們交出去那串的最內層、緊貼 `turnCancelModelSignal` 外面**：它也包 `request.model`，這一顆在它外面，
 * 所以外面每一顆 middleware 看到的仍是原本的模型。見檔頭「記錄點」一節，為什麼記錄點不在 middleware 這一層。
 *
 * @param sessions - 註冊表的 `sessions` 通道，用來問「這次呼叫該寫進哪一份」。
 */
export function createRequestSnapshotRecorder(sessions: {
  forCall(config: unknown): SessionLookup;
}): AgentMiddleware {
  return createMiddleware({
    name: REQUEST_SNAPSHOT_MIDDLEWARE_NAME,
    wrapModelCall: (request, handler) => {
      const found = sessions.forCall({
        configurable: (request as { runtime?: { configurable?: unknown } }).runtime?.configurable,
      });
      // 動態模型（函式）包不了，照舊交出去——那條路上不記。
      if (found.kind !== 'ok' || !RunnableBinding.isRunnable(request.model)) {
        return handler(request);
      }
      const watcher = new RequestSnapshotHandler(found.log, currentModelCall(found.log));
      return handler({
        ...request,
        model: bindModelConfig(request.model, (current) => ({
          ...current,
          callbacks: [...(Array.isArray(current.callbacks) ? current.callbacks : []), watcher],
        })),
      });
    },
  }) as unknown as AgentMiddleware;
}
