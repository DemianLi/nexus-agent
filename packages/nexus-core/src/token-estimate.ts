/**
 * 一份請求送出去會是幾個 token：**錨在供應商上一次報的實數上，只估增量**
 * （[#588](https://github.com/DemianLi/nexus-agent/issues/588)，量測與拍板見
 * [#586](https://github.com/DemianLi/nexus-agent/issues/586)）。
 *
 * ## 算法
 *
 * ```
 * E(req) = Σ o200k(每則訊息的文字 ＋ 工具呼叫名與參數 ＋ 工具定義 JSON) ＋ 4 × 則數（system 也算一則）
 * T(m)   = AI 訊息 m 身上 `usage_metadata.input_tokens`——產出它的那次請求的實數
 *
 * 有錨（這串訊息裡最後一則帶實數的 AI 訊息 a）：
 *   est = T(a) ＋ (E(req) − E(送出 a 的那份請求)) × c
 *   c   = (T(a) − T(f)) ÷ (E(送出 a 的那份) − E(送出 f 的那份))，f ＝ 這串裡最早那則帶實數的 AI 訊息
 *         只有兩格都在帳上、估算增加量 ≥ 500、實數增加量 > 0 才算；否則 1
 * 沒錨（這條 thread 的第一次）：
 *   est = T(ref) ＋ (E(req) − E(ref))，ref ＝ 同一個行程裡同模型、同工具組的別條 thread 的第一次
 * 連 ref 都沒有（行程剛起來）：est = E(req)——demian 拍板接受的例外
 * ```
 *
 * 「送出 a 的那份請求」的 E 由 {@link TokenAnchorBook} 在那次呼叫回來時記下，以 AI 訊息的 id 為鍵。帳上沒有（行程
 * 重開、續接）時退到這串訊息裡 a 之前的那一段——摘要、剪刀與參數截斷在兩邊一樣就抵消，不一樣時差的是「這一次
 * 才開始被剪的那幾則」，有界。
 *
 * **比例只用內容那一截算**：兩個實數相減、兩個估算相減，system 與工具定義那一截抵掉。用整份 prompt 的比例會把
 * 套版開銷一起放大——#586 量到 `gpt-oss-20b` 因此從 0.6% 被拉到 17%。
 *
 * ## 量到的
 *
 * #586 錄下 serve 組裝出來的 92 份 body、原樣送 NVIDIA 取 `prompt_tokens`：第 2 次以後最大誤差 nemotron 8.9%、
 * `gpt-oss-20b` 0.6%；借錨的第一次 6.9%／0.0%；例外那一次 −23%～+26%。舊算法（`countTokensApproximately`）
 * 最大 63.5%／56.6%。
 *
 * ## 與 dsh 的偏離（AGENTS.md 的規則）
 *
 * **錨照 dsh**：`packages/llm/token-meter/src/index.ts` 的 `measure()`（`46a7f68`）也是「上一次成功呼叫的供應商
 * 用量當錨、加估算的增量」。偏的是兩格，理由都是 demian 的要求（每一次 ≤10%）dsh 那套做不到——它的形狀在同一批
 * 資料上量到最大 79.8%：
 *
 * 1. **估算器**：dsh 是固定密度「4 個字元一個 token」（`estimate.ts`）。中文一個字在 o200k 大約是 0.9 個 token，
 *    所以讀一份中文檔時增量只估到三分之一。換成 o200k。
 * 2. **內容比例**：dsh 的增量不乘任何東西。nemotron 的 tokenizer 在內容上比 o200k 多約 16%，大的增量一來就超過
 *    10%。dsh 沒有這一格；比例從這條 thread 自己的兩次實數學。
 *
 * 另外 dsh 只在「用量 ≥ 那次的估算」時才採用錨（保守的那一邊），我們一律採用：目標是雙向 10%，不是只防少估。
 *
 * @module
 */

import { createHash } from 'node:crypto';
import type { BaseMessage } from '@langchain/core/messages';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { Tiktoken } from 'js-tiktoken/lite';
import o200kBase from 'js-tiktoken/ranks/o200k_base';

/** 每則訊息的角色框架開銷。#586 的評估用同一個值。 */
const MESSAGE_OVERHEAD = 4;

/** 內容比例要算得穩，估算增加量至少要這麼多。#586 的評估用同一個值。 */
const MIN_RATIO_SPAN = 500;

/** 帳上最多記幾則 AI 訊息。超過就丟最舊的——那些多半早被摘要掉了。 */
const MAX_SENT_ENTRIES = 20_000;

/**
 * 沒有空白的一段超過這麼長就切開來編。
 *
 * js-tiktoken 對一個 regex 片段做 BPE 合併是平方級的：4 萬個 `X` 連在一起要編一分多鐘（量過）。切成 128 字元
 * 一塊之後 4 萬個 `X` 是 0.25 秒，而 #586 那四種素材（中文、混合、英文程式碼）的 token 數差不到 0.01%——
 * 一般文字裡這麼長的無空白片段本來就少，中文段落雖然沒有空白，切點多一兩個 token 而已。
 */
const MAX_RUN = 128;
const LONG_RUN = new RegExp(`\\S{${MAX_RUN + 1},}`, 'g');

let encoder: Tiktoken | undefined;

/** 一段文字直接編。**特殊 token 的字串一律當一般文字**：預設的 `encode` 碰到 `<|endoftext|>` 這種字串會拋。 */
function encoded(text: string): number {
  if (text.length === 0) return 0;
  encoder ??= new Tiktoken(o200kBase);
  return encoder.encode(text, [], []).length;
}

/** o200k 的 token 數，長的無空白片段切開來編，見 {@link MAX_RUN}。 */
function o200k(text: string): number {
  let total = 0;
  let last = 0;
  for (const match of text.matchAll(LONG_RUN)) {
    total += encoded(text.slice(last, match.index));
    for (let start = 0; start < match[0].length; start += MAX_RUN)
      total += encoded(match[0].slice(start, start + MAX_RUN));
    last = match.index + match[0].length;
  }
  return total + encoded(text.slice(last));
}

/** 摘要器交給下一層、或剪刀收到的那份請求，估算要的只有這幾格。 */
export interface EstimatedRequest {
  readonly messages?: readonly BaseMessage[];
  readonly systemMessage?: unknown;
  readonly tools?: unknown;
  readonly model?: unknown;
}

const perMessage = new WeakMap<object, number>();
const perTool = new WeakMap<object, number>();

/**
 * 內容裡模型看得到的文字。**推理區塊不算**：`ChatOpenAI` 送回模型時丟掉它（見 `langchain-reasoning-block-roundtrip`
 * 那條記憶），算進來會高估。其他認不得的區塊照 JSON 算，同 dsh 的 `estimateStructuralBlock`。
 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content as unknown[]) {
    if (typeof block === 'string') text += block;
    else if (block !== null && typeof block === 'object') {
      const { type, text: blockText } = block as { type?: unknown; text?: unknown };
      if (type === 'reasoning' || type === 'thinking') continue;
      text += typeof blockText === 'string' ? blockText : JSON.stringify(block);
    }
  }
  return text;
}

/** 一則訊息的 E。同一個物件只編一次。 */
function messageTokens(message: BaseMessage): number {
  const cached = perMessage.get(message);
  if (cached !== undefined) return cached;
  let text = contentText(message.content);
  const calls = (message as { tool_calls?: readonly { name?: unknown; args?: unknown }[] })
    .tool_calls;
  for (const call of calls ?? []) text += String(call.name ?? '') + JSON.stringify(call.args ?? {});
  const tokens = o200k(text) + MESSAGE_OVERHEAD;
  perMessage.set(message, tokens);
  return tokens;
}

/** 一個工具定義的 E：送上線的那個 OpenAI 形狀的 JSON。轉不過去就照原物件的 JSON。 */
function toolTokens(tool: unknown): number {
  if (tool === null || typeof tool !== 'object') return 0;
  const cached = perTool.get(tool);
  if (cached !== undefined) return cached;
  let json: string;
  try {
    json = JSON.stringify(convertToOpenAITool(tool as Record<string, unknown>));
  } catch {
    json = JSON.stringify(tool) ?? '';
  }
  const tokens = o200k(json);
  perTool.set(tool, tokens);
  return tokens;
}

/** system 那一則的 E。沒有就是 0。 */
function systemTokens(system: unknown): number {
  if (system === null || typeof system !== 'object') return 0;
  const cached = perMessage.get(system);
  if (cached !== undefined) return cached;
  const text = contentText((system as { content?: unknown }).content);
  const tokens = text.length === 0 ? 0 : o200k(text) + MESSAGE_OVERHEAD;
  perMessage.set(system, tokens);
  return tokens;
}

/**
 * 一份請求的 E（不錨）。
 *
 * @param request - 要估的請求；`messages` 可以只給一段前綴。
 * @returns o200k 算出來的 token 數。
 */
export function estimateRequestTokens(request: EstimatedRequest): number {
  let total = systemTokens(request.systemMessage);
  for (const message of request.messages ?? []) total += messageTokens(message);
  if (Array.isArray(request.tools)) for (const tool of request.tools) total += toolTokens(tool);
  return total;
}

/** 模型的名字：`ChatOpenAI` 叫 `model`，舊的叫 `modelName`。認不出就是 `undefined`。 */
function modelNameOf(model: unknown): string | undefined {
  if (model === null || typeof model !== 'object') return undefined;
  const { model: name, modelName } = model as { model?: unknown; modelName?: unknown };
  if (typeof name === 'string') return name;
  return typeof modelName === 'string' ? modelName : undefined;
}

/** 一則 AI 訊息的實數，與報它的模型。不是 AI 訊息、或沒有正的實數，就是 `undefined`。 */
function reportedInput(
  message: BaseMessage,
): { readonly tokens: number; readonly model: string | undefined } | undefined {
  if (message.getType() !== 'ai') return undefined;
  const usage = (message as { usage_metadata?: { input_tokens?: unknown } }).usage_metadata;
  const tokens = usage?.input_tokens;
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return undefined;
  const meta = (message as { response_metadata?: { model_name?: unknown; model?: unknown } })
    .response_metadata;
  const model =
    typeof meta?.model_name === 'string'
      ? meta.model_name
      : typeof meta?.model === 'string'
        ? meta.model
        : undefined;
  return { tokens, model };
}

/**
 * 換過模型的 thread 不能錨在舊模型的實數上：同一份 body 兩顆模型差約 27%（#586）。**兩邊有一邊不知道就放行**——
 * 認不出名字的組裝（測試替身、沒報 `model_name` 的供應商）不該因此永遠失去錨。
 */
function sameModel(reported: string | undefined, current: string | undefined): boolean {
  return reported === undefined || current === undefined || reported === current;
}

/** 借錨用的鍵：模型＋工具組。**不含 system**：它逐條 thread 可能不同，差的那一截由 E 的增量吸收。 */
function firstCallKey(request: EstimatedRequest): string {
  // LangChain 的工具叫 `name`，已經是 OpenAI 形狀的叫 `function.name`。
  const names = Array.isArray(request.tools)
    ? (request.tools as { name?: unknown; function?: { name?: unknown } }[])
        .map((tool) => tool?.name ?? tool?.function?.name)
        .map((name) => (typeof name === 'string' ? name : '?'))
        .sort()
    : [];
  return createHash('sha1')
    .update(JSON.stringify([modelNameOf(request.model) ?? null, names]))
    .digest('hex');
}

/** 估出來的數，與它是怎麼來的。 */
export interface TokenEstimate {
  /** 估算的 token 數。 */
  readonly tokens: number;
  /** `anchor`：錨在這串訊息裡的實數上；`borrowed`：借別條 thread 的第一次；`estimate`：純估算（例外）。 */
  readonly basis: 'anchor' | 'borrowed' | 'estimate';
}

/**
 * 錨定估算要的那本帳：每一則 AI 訊息是從多大（E）的請求生出來的，與每一組「模型＋工具」的第一次。
 *
 * **一個行程一本**（{@link defaultTokenAnchorBook}）：serve 一條 thread 建一個 agent，借錨要跨 thread 才借得到。
 * 鍵是 AI 訊息的 id，跨 agent 共用不會撞。
 */
export class TokenAnchorBook {
  readonly #sent = new Map<string, number>();
  readonly #firstCalls = new Map<string, { readonly tokens: number; readonly estimated: number }>();

  /**
   * 整本清空。**給測試用**：同一個測試檔裡的組裝共用行程那一本，不清的話後一條會借到前一條的第一次，數字隨
   * 執行順序變。
   */
  clear(): void {
    this.#sent.clear();
    this.#firstCalls.clear();
  }

  /** 送出 id 那則 AI 訊息的請求，E 是多少。 */
  sentEstimate(id: string | undefined): number | undefined {
    return id === undefined ? undefined : this.#sent.get(id);
  }

  /** 同模型、同工具組的別條 thread 的第一次。 */
  firstCall(request: EstimatedRequest): { tokens: number; estimated: number } | undefined {
    return this.#firstCalls.get(firstCallKey(request));
  }

  /**
   * 一次呼叫回來了：記下它的 E；它是一條 thread 的第一次的話，也記成借錨的來源（同一組只記第一個）。
   *
   * @param response - 下一層回來的東西；不是帶 id 的 AI 訊息就不記。
   * @param sent - 送出去的那份請求。
   * @param estimated - 那份請求的 E。
   * @param basis - 那份請求是怎麼估的；不是 `anchor` 就代表它是一條 thread 的第一次。
   */
  record(
    response: unknown,
    sent: EstimatedRequest,
    estimated: number,
    basis: TokenEstimate['basis'],
  ): void {
    if (response === null || typeof response !== 'object') return;
    const message = response as BaseMessage;
    if (typeof message.getType !== 'function' || message.getType() !== 'ai') return;
    const id = message.id;
    if (typeof id === 'string') {
      this.#sent.delete(id);
      this.#sent.set(id, estimated);
      if (this.#sent.size > MAX_SENT_ENTRIES) {
        const oldest = this.#sent.keys().next().value;
        if (oldest !== undefined) this.#sent.delete(oldest);
      }
    }
    if (basis === 'anchor') return;
    const reported = reportedInput(message);
    if (reported === undefined || !sameModel(reported.model, modelNameOf(sent.model))) return;
    const key = firstCallKey(sent);
    if (!this.#firstCalls.has(key))
      this.#firstCalls.set(key, { tokens: reported.tokens, estimated });
  }
}

/** 行程共用的那本。測試要隔離就自己 `new` 一本傳進去。 */
export const defaultTokenAnchorBook = new TokenAnchorBook();

/**
 * 錨定估算。
 *
 * @param request - 要估的請求。錨從它的 `messages` 裡找。
 * @param book - 帳。
 * @returns 估算值與它的來源。
 */
export function estimateAnchoredTokens(
  request: EstimatedRequest,
  book: TokenAnchorBook = defaultTokenAnchorBook,
): TokenEstimate & { readonly estimated: number } {
  const messages = request.messages ?? [];
  const estimated = estimateRequestTokens(request);
  const current = modelNameOf(request.model);
  let last = -1;
  let first = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const reported = reportedInput(messages[index]!);
    if (reported === undefined || !sameModel(reported.model, current)) continue;
    if (last < 0) last = index;
    first = index;
  }
  if (last >= 0) {
    const anchor = messages[last]!;
    const tokens = reportedInput(anchor)!.tokens;
    const before =
      book.sentEstimate(anchor.id) ??
      estimateRequestTokens({ ...request, messages: messages.slice(0, last) });
    let ratio = 1;
    const earliest = messages[first]!;
    const earliestSent = first < last ? book.sentEstimate(earliest.id) : undefined;
    const lastSent = book.sentEstimate(anchor.id);
    if (earliestSent !== undefined && lastSent !== undefined) {
      const span = lastSent - earliestSent;
      const grown = tokens - reportedInput(earliest)!.tokens;
      if (span >= MIN_RATIO_SPAN && grown > 0) ratio = grown / span;
    }
    return {
      tokens: Math.round(tokens + (estimated - before) * ratio),
      basis: 'anchor',
      estimated,
    };
  }
  const borrowed = book.firstCall(request);
  if (borrowed !== undefined)
    return {
      tokens: Math.round(borrowed.tokens + (estimated - borrowed.estimated)),
      basis: 'borrowed',
      estimated,
    };
  return { tokens: estimated, basis: 'estimate', estimated };
}
