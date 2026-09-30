/**
 * 工具結果的外溢層（[#719](https://github.com/DemianLi/nexus-agent/issues/719)）：一則結果超過 token 預算，全文存到
 * 宿主上，模型只收到頭尾預覽加一句「全文存在這裡、用 `read_file` 去讀」。
 *
 * ## 照 dsh 的部分（`packages/spill/spill-policy/src/index.ts`，`477b4f4`）
 *
 * - 預算是**估算 token**，`maxInlineTokens` 省略就不掛（dsh `:34-40`、`:57`）；預設 12500 寫在 `cordis.yml` 那一列。
 * - 超過預算就存全文，換成**頭尾各半**的預覽加一句通知，**含通知在內不超過預算**（`:104-116`）。
 * - 通知的措辭逐字照抄（dsh `notice.ts:21-24`，`Omitted N bytes. Full formatted result stored at: …`），
 *   持久化下來的字串將來要能被辨認。
 * - **存不下就保留原結果**，不把成功變成錯誤（`:127-129`）：儲存拋錯、通知比預算還大、內容有非文字區塊，一律原樣交出。
 * - **只放過 `read`**（我們叫 `read_file`；`:135`）：讀出來的東西再外溢，模型永遠讀不完。
 * - 排在外層：**日誌與畫面看到的是換過的那一則**（dsh `tool-calls.ts:152-156`），見 {@link ./containment.ts}。
 *
 * ## 偏離（依 AGENTS.md 登記：哪一條、為什麼、退到什麼）
 *
 * 1. **只處理純文字結果。** dsh 的預算圖文共用，圖片整張保留或整張略過（`retention.ts`）。這一版只做文字：內容裡有任何
 *    非文字區塊就原樣交出。圖片的估價入口歸 [#715](https://github.com/DemianLi/nexus-agent/issues/715)／#732。
 * 2. **估算用 o200k，不是 dsh 的「四個字元一個 token」。** 同 {@link ./token-estimate.ts} 的理由（中文一字約 0.9 token，
 *    固定密度會少估兩倍以上）。o200k 的前綴 token 數**不保證**單調，所以頭尾不做 dsh 那種二分搜尋，改成「按密度猜長度、
 *    量、修正」幾輪，最後**整則再量一次**、超過就整體縮，保住「不超過預算」。
 * 3. **失敗的結果（`status: 'error'`）與 `Command` 不處理。** dsh 的 `accept` 決定沒有這兩種形狀；我們的錯誤結果是短句，
 *    `Command`（`task` 子代理的回傳）夾帶的是狀態更新，換內容會弄壞它。
 * 4. **關不掉的那一半：** 基座的 eviction（80,000 字元）不受這一層控制，這一層沒掛時它照舊在。
 *
 * @module
 */

import { ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from './base-types.js';
import { resolveToolName } from './containment.js';
import { estimateTextTokens } from './token-estimate.js';

/** 外溢層 middleware 的名字。排序斷言與錯誤訊息用得到。 */
export const SPILL_POLICY_MIDDLEWARE_NAME = 'nexusSpillPolicy';

/** 不外溢的工具：讀出來的東西再外溢，模型永遠讀不完。dsh 只放過 `read`。 */
const EXEMPT_TOOLS: ReadonlySet<string> = new Set(['read_file']);

/** 存下去的東西要回給模型的定位。 */
export interface SpillRef {
  /** 模型 `read_file` 得到的路徑。 */
  readonly locator: string;
  /** 通知裡接在定位後面的那一句怎麼取回。 */
  readonly retrievalHint: string;
}

/** 存一份全文的請求。 */
export interface SpillSaveRequest {
  /** 產生這則結果的工具。 */
  readonly toolName: string;
  /** 工具呼叫編號。 */
  readonly callId: string;
  /** 全文。 */
  readonly content: string;
}

/**
 * 外溢的儲存。**這個服務清單上別的條目也要叫得到**（#735 的搜尋工具、#713 的跨會話引用），所以它是獨立的介面，
 * 不藏在 middleware 裡。
 *
 * **存不下要拋**（不能回一個假的定位）：呼叫端把拋錯當成「保留原結果」。
 */
export interface SpillStore {
  saveText(request: SpillSaveRequest): Promise<SpillRef>;
}

/** 外溢層的設定。 */
export interface SpillPolicyOptions {
  /** 一則結果最多佔多少估算 token，含通知。 */
  readonly maxInlineTokens: number;
  /** 全文存到哪。 */
  readonly store: SpillStore;
  /** 保留原結果時講一聲。缺席就不講。 */
  readonly warn?: (message: string) => void;
  /** 算預覽最多花多久（毫秒），超過就保留原結果。預設 3000；測試用它逼出那條路。 */
  readonly timeBudgetMs?: number;
}

/** 通知裡的取回提示。措辭照 dsh `spill-local` 的 `retrievalHint`，工具名換成我們的。 */
export const SPILL_RETRIEVAL_HINT =
  'Use read_file with offset/limit, or grep this path to search within it.';

const OPEN = '(';
const CLOSE = ')';
const LOCATION = ' Full formatted result stored at: ';
const GUIDANCE_SEPARATOR = '. ';
const GAP = '\n\n[...]\n\n';

/**
 * 附在預覽後面的通知，逐字照 dsh `formatSpillNotice`（`notice.ts:21-24`）。
 *
 * @param omittedBytes - 略掉的 UTF-8 位元組數。
 * @param ref - 全文的定位。
 * @returns 括號包起來的一句話，前面沒有分隔。
 */
export function formatSpillNotice(omittedBytes: number, ref: SpillRef): string {
  return `${OPEN}Omitted ${omittedBytes} bytes.${LOCATION}${ref.locator}${GUIDANCE_SEPARATOR}${ref.retrievalHint}${CLOSE}`;
}

/** 別把一個代理對切成兩半：切點落在高低代理之間就往內退一格。 */
function sliceEnd(text: string, length: number, tail: boolean): string {
  let cut = tail ? text.length - length : length;
  const previous = text.charCodeAt(cut - 1);
  const current = text.charCodeAt(cut);
  if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) {
    cut += tail ? 1 : -1;
  }
  return tail ? text.slice(cut) : text.slice(0, cut);
}

/**
 * 頭（或尾）留多長才剛好不超過預算。o200k 的前綴 token 數不保證單調（見檔頭偏離 2），所以不二分：
 * 按目前量到的密度猜一個長度、量、按比例修正，最多幾輪，最後保證不超過。
 */
function fitEnd(
  text: string,
  budget: number,
  tail: boolean,
  density: number,
  deadline: Deadline,
): string {
  if (budget <= 0 || text.length === 0) return '';
  let length = Math.min(text.length, Math.max(1, Math.floor(budget * density)));
  let best = '';
  for (let round = 0; round < 5; round += 1) {
    deadline.check();
    const candidate = sliceEnd(text, length, tail);
    const cost = estimateTextTokens(candidate);
    if (cost <= budget) {
      if (candidate.length > best.length) best = candidate;
      // 已經貼近預算，或已經是全部：不再找。
      if (cost >= budget * 0.97 || length >= text.length) return best;
      length = Math.min(text.length, Math.floor((length * budget) / Math.max(1, cost)));
    } else {
      length = Math.floor((length * budget * 0.98) / cost);
    }
    if (length < 1) break;
  }
  // 沒貼近也沒關係，只要不超過：從 best 或更短的長度收尾。
  while (best.length === 0 && length > 0) {
    deadline.check();
    length = Math.floor(length * 0.8);
    const candidate = sliceEnd(text, length, tail);
    if (candidate.length > 0 && estimateTextTokens(candidate) <= budget) best = candidate;
  }
  return best;
}

interface Retained {
  readonly head: string;
  readonly tail: string;
}

/** 頭尾各半的預覽，`budget` 是兩段合起來的 token 上限；`density` 是每個 token 約幾個字元。 */
function retain(text: string, budget: number, density: number, deadline: Deadline): Retained {
  const headBudget = Math.ceil(budget / 2);
  const head = fitEnd(text, headBudget, false, density, deadline);
  const tail = fitEnd(text.slice(head.length), Math.floor(budget / 2), true, density, deadline);
  return { head, tail };
}

/**
 * 一場外溢最多花多久算預覽。o200k 對某些病態內容（幾十萬字元的空白、代理對）是平方級的慢（見 `token-estimate.ts` 的
 * `MAX_RUN`），這一層在工具呼叫的路徑上，不能讓一則怪結果把整輪卡住：超過就拋，呼叫端照 dsh 保留原結果。
 */
const DEFAULT_TIME_BUDGET_MS = 3_000;

/** 全文要抽樣的門檻：超過這麼多字元就只量開頭一段的密度、按比例推整則。 */
const SAMPLE_CHARS = 20_000;

class Deadline {
  readonly #until: number;
  constructor(budgetMs: number) {
    this.#until = performance.now() + budgetMs;
  }
  check(): void {
    if (performance.now() > this.#until) throw new Error('算預覽花太久');
  }
}

/**
 * 整則結果約佔多少 token，與每個 token 約幾個字元。
 *
 * 不長的全量量一次；超過 {@link SAMPLE_CHARS} 的只量開頭一段、按比例推——這一步只決定「超過沒」與預覽要切多長，
 * **預算的硬保證來自最後對換過的那一則（一定很短）的整則量測**，不靠這裡。
 */
function measure(text: string): { readonly tokens: number; readonly density: number } {
  if (text.length <= SAMPLE_CHARS * 2) {
    const tokens = estimateTextTokens(text);
    return { tokens, density: text.length / Math.max(1, tokens) };
  }
  const density = SAMPLE_CHARS / Math.max(1, estimateTextTokens(text.slice(0, SAMPLE_CHARS)));
  return { tokens: Math.ceil(text.length / density), density };
}

/** 結果訊息的文字：字串，或全是文字區塊的陣列。有別的區塊（圖片等）就是 `undefined`。 */
function plainText(content: ToolMessage['content']): string | undefined {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const block of content) {
    const typed = block as { readonly type?: unknown; readonly text?: unknown };
    if (typed.type !== 'text' || typeof typed.text !== 'string') return undefined;
    parts.push(typed.text);
  }
  return parts.join('\n');
}

/**
 * 把一則超過預算的文字換成預覽。回 `undefined` 表示不用換（沒超過）。存不下會拋。
 */
async function spill(
  text: string,
  options: SpillPolicyOptions,
  request: SpillSaveRequest,
): Promise<string | undefined> {
  const max = options.maxInlineTokens;
  // 一個 UTF-16 字元最多三個 token（UTF-8 最多三個位元組）：短到這個地步的不用量。
  if (text.length * 3 <= max) return undefined;
  const deadline = new Deadline(options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
  const { tokens, density } = measure(text);
  if (tokens <= max) return undefined;
  deadline.check();
  const ref = await options.store.saveText(request);
  const totalBytes = Buffer.byteLength(text, 'utf8');
  const worstNotice = formatSpillNotice(totalBytes, ref);
  const reserved = estimateTextTokens(GAP + worstNotice);
  if (estimateTextTokens(worstNotice) > max) {
    throw new Error(`外溢通知本身（${estimateTextTokens(worstNotice)} token）超過預算 ${max}`);
  }
  // 整則量一次；超過就整體縮，直到不超過為止（o200k 的前綴不單調，見 fitEnd）。
  let budget = Math.max(0, max - reserved);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    deadline.check();
    const { head, tail } = retain(text, budget, density, deadline);
    const omitted = totalBytes - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8');
    const notice = formatSpillNotice(omitted, ref);
    const result = head.length + tail.length === 0 ? notice : `${head}${GAP}${tail}\n\n${notice}`;
    if (estimateTextTokens(result) <= max) return result;
    budget = Math.floor(budget * 0.9);
  }
  return formatSpillNotice(totalBytes, ref);
}

/**
 * 外溢層。**每個 agent（root 與子代理）掛同一份實例**：沒有 closure 狀態，儲存本身按會話分。
 *
 * @param options - 預算與儲存。
 * @returns 一顆 `wrapToolCall` middleware。
 */
export function createSpillPolicyMiddleware(options: SpillPolicyOptions): AgentMiddleware {
  return createMiddleware({
    name: SPILL_POLICY_MIDDLEWARE_NAME,
    wrapToolCall: async (request, handler) => {
      const toolName = resolveToolName(request);
      const result = await handler(request);
      if (EXEMPT_TOOLS.has(toolName)) return result;
      if (!ToolMessage.isInstance(result) || result.status === 'error') return result;
      const text = plainText(result.content);
      if (text === undefined) return result;
      try {
        const replaced = await spill(text, options, {
          toolName,
          callId: request.toolCall.id ?? result.tool_call_id,
          content: text,
        });
        if (replaced === undefined) return result;
        // 只換內容，其餘每一格原樣帶過去。
        return new ToolMessage({
          content: replaced,
          tool_call_id: result.tool_call_id,
          name: result.name ?? toolName,
          id: result.id,
          status: result.status,
          artifact: result.artifact,
          additional_kwargs: result.additional_kwargs,
          response_metadata: result.response_metadata,
        });
      } catch (error: unknown) {
        options.warn?.(
          `spill-policy: ${toolName} 的結果存不下（${(error as Error).message}），保留原結果`,
        );
        return result;
      }
    },
  }) as AgentMiddleware;
}
