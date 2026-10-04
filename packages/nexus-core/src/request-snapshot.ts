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
 *   是 dsh 為提示快取前綴分析標「新的訊息序列」，我們沒有消費者。
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
 * ## 記不進去不能扳倒模型呼叫
 *
 * 同 {@link ./model-calls.ts}：抽取、比對、`append` 任何一步拋都吞掉，這次不記。基準只在**記成功之後**才前進，所以失敗的
 * 那次下一次會再試。
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

/** 拷成純 JSON；拷不動（循環、函式）回 `undefined`。 */
function jsonCopy(value: unknown): unknown {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
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
  const copy = parameters === undefined ? undefined : jsonCopy(parameters);
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
  const number = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
    const copy = jsonCopy(invocation[key]);
    if (copy !== undefined) extra[key] = copy;
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
      fresh.header = JSON.stringify(event.data.header);
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
  override raiseError = false;

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
    try {
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
    } catch {
      // 見檔頭「記不進去不能扳倒模型呼叫」。
    }
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
