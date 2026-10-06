/**
 * 一份請求送出去會是幾個 token：**錨在供應商上一次報的實數上，只估增量**
 * （[#588](https://github.com/DemianLi/nexus-agent/issues/588)，量測與拍板見
 * [#586](https://github.com/DemianLi/nexus-agent/issues/586)）。
 *
 * ## 算法
 *
 * ```
 * E(req) = Σ o200k(每則訊息的文字 ＋ 工具呼叫名與參數 ＋ 工具定義 JSON) ＋ 4 × 則數（system 也算一則）
 *          超過 4 萬字元的一段只抽樣、不全量編（#952），其餘逐位精確；以內容為鍵備忘，換了訊息物件也不重編
 *          型錄宣告逐位切詞數字的模型再加 Σ (L − ⌈L÷3⌉)，L ＝ 每一串連續 ASCII 數字（≥ 2 位）的長度（#1102）
 * T(m)   = AI 訊息 m 身上 `usage_metadata.input_tokens`——產出它的那次請求的實數
 *
 * 有錨（這串訊息裡最後一則帶實數的 AI 訊息 a）：
 *   est = T(a) ＋ (E(req) − E(送出 a 的那份請求)) × c
 *   c   = (T(a) − T(f)) ÷ (E(送出 a 的那份) − E(送出 f 的那份))，f ＝ 這串裡最早那則帶實數的 AI 訊息
 *         只有兩格都在帳上、估算增加量 ≥ 500、實數增加量 > 0 才算；否則 c̄
 * 沒錨（這條 thread 的第一次）：
 *   est = T(ref) ＋ (E(req) − E(ref)) × c̄，ref ＝ 同一個行程裡同模型、同工具組的別條 thread 的第一次
 * 連 ref 都沒有（行程剛起來）：est = E(req)——demian 拍板接受的例外
 *
 * c̄ ＝ 同一個行程、同模型最近一次學到的內容比例，還沒學到就是 1。每次呼叫回來都學一次，條件同 c：
 *   錨定的那次學 (T − T(f)) ÷ (E − E(送出 f 的那份))；借錨的那次學 (T − T(ref)) ÷ (E − E(ref))
 * ```
 *
 * **c̄ 補的是單錨的那一次**：一條 thread 的第二次只有一則錨，自己的比例算不出來。#588 驗收時 nemotron 的第二次
 * 讀進一份兩萬多字的中文檔（佔整份 body 的 73%），比例用 1 就少估 10.1%；借行程的比例之後是 −3.2%。代價是上一條
 * thread 的內容跟這一次不像時會借錯方向——nemotron 在這批素材上的比例落在 1.07～1.16，錯借的上限大約是
 * 「0.1 × 增量佔比」，驗收裡最差的一筆是 +5.1%。
 *
 * 「送出 a 的那份請求」的 E 由 {@link TokenAnchorBook} 在那次呼叫回來時記下，以 AI 訊息的 id 為鍵。帳上沒有（行程
 * 重開、續接）時退到這串訊息裡 a 之前的那一段——摘要、剪刀與參數截斷在兩邊一樣就抵消，不一樣時差的是「這一次
 * 才開始被剪的那幾則」，有界。
 *
 * **比例只用內容那一截算**：兩個實數相減、兩個估算相減，system 與工具定義那一截抵掉。用整份 prompt 的比例會把
 * 套版開銷一起放大——#586 量到 `gpt-oss-20b` 因此從 0.6% 被拉到 17%。
 *
 * ## 逐位切詞的數字（[#1102](https://github.com/DemianLi/nexus-agent/issues/1102)）
 *
 * o200k 把數字切成最多三位一組；`nemotron-3-super-120b-a12b` 是**一位一個 token**。數字為主的內容因此少估到一半：
 * 錄下產品 body 送真端點量到的 真實 ÷ o200k——中文 1.10、程式碼 1.09、JSON 日誌 1.43、表格 1.53、十六進位 1.55、
 * CSV 1.88、純數字 2.47。**c̄ 是單一個數，補不了這個**：它學到「CSV 的 1.88」之後借給中文，中文就多估 62%；學到中文的
 * 1.10 再借給 CSV，CSV 少估 36%。所以要在 E 這一層把數字數對，c̄ 才只需要補剩下那個跟內容無關的 ≈1.1。
 *
 * 做法：連續 L 位 ASCII 數字，o200k 算 ⌈L÷3⌉，這類模型算 L，差額加在 E 上。**只對型錄條目宣告
 * `tokenizer.digits: 'single'` 的模型做**（沒宣告的照舊，`gpt-oss-20b` 的 ±0.6% 不動），只有量過的才宣告。差額跟著
 * 訊息一起記，備忘不分模型，所以同一份內容換模型不會拿錯。`estimateTextTokens`（外溢層用的精確數）不加：它量的是
 * o200k 本身。差額掃全文、不跟著超長抽樣走——一個正則掃過去很便宜，抽樣的目的是省編碼。
 *
 * 修好之後在 nemotron 上用同一組情境量（真端點的 `prompt_tokens`；素材是手搭的 OpenAI 訊息，不是
 * serve 錄的 body）：冷行程貼 40k 字元 CSV 從 −51.2% 到 −0.5%；中文教過 c̄ 之後再貼 CSV（借錨）從 −46.1% 到 +9.3%；
 * 單錨的第二次，c̄ 從 CSV 借給中文的 +81.4% 到 −8.5%、從中文借給 CSV 的 −39.8% 到 +7.8%；JSON 日誌 −16.3% 到 +5.9%。
 * 最差一筆 +9.3%。`gpt-oss-20b`（沒宣告）同一組情境全部在 ±0.5% 以內，跟修之前一樣。**留下的**：模型自己的固定
 * 開銷（例如只有一則短訊息的第一次，估 77 實 299），這個絕對差 200 多個 token、跟內容無關，#588 驗收時就在。
 *
 * ## 編碼器（[#1107](https://github.com/DemianLi/nexus-agent/issues/1107)）
 *
 * o200k 的實作是 `gpt-tokenizer`（純 JS、零相依、MIT），不是 `js-tiktoken`。換的理由是速度，而且 token 數**逐位相同**
 * （`token-estimate.test.ts` 的「編碼器對照」用 js-tiktoken 當對照組重算過各種素材）：同一台機器上，一次全新的 10 萬字元
 * 隨機漢字（最壞的素材）js-tiktoken 4.4 秒、gpt-tokenizer 0.13 秒；一般中文散文差約兩個數量級。載入也輕：載入後常駐堆
 * +17 MB（js-tiktoken +72 MB）、載入含初始化 76 ms（222 ms）。它內部有一個合併結果的 LRU（上限 10 萬筆），實測對抗性輸入
 * 之後最多增 14 MB，不會無界成長。**這一換讓 `estimateTextTokens`（外溢層的精確數）同樣變快，數字不變。**
 * 抽樣（{@link sampledTokens}）與它的誤差界線**沒有動**；編碼器夠快之後還要不要抽樣是另一個問題。
 *
 * ## 量到的
 *
 * #586 錄下 serve 組裝出來的 92 份 body、原樣送 NVIDIA 取 `prompt_tokens`：第 2 次以後最大誤差 nemotron 8.9%、
 * `gpt-oss-20b` 0.6%；借錨的第一次 6.9%／0.0%；例外那一次 −23%～+26%。舊算法（`countTokensApproximately`）
 * 最大 63.5%／56.6%。
 *
 * #588 驗收用同一套量法重跑 20 組情境（含預算觸發摘要、截參數寫檔），這個檔的算法：第 2 次以後最大 nemotron
 * 5.1%、`gpt-oss-20b` 0.6%；借錨的第一次 1.8%／0.0%；例外那一次 −25.2%／+22.2%。
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
 *    10%。dsh 沒有這一格；比例從這條 thread 自己的兩次實數學，學不到就借行程裡最近學到的。
 *
 * 3. **載體與跨 thread 借錨**：dsh 的量測是 ctx 上的服務，狀態逐 session 存（`WeakMap<Session, …>`），沒有跨 session
 *    學的東西。我們多了「借別條 thread 的第一次」與 c̄（上面兩格的理由），所以帳要跨 thread 共用。共用的是**一個進入點
 *    建的 {@link TokenAnchorBook} 實例**（`runServe` 一本給所有 thread），由組裝點一路注入到摘要器——對應 dsh 的 ctx
 *    注入，而不是模組全域（[#702](https://github.com/DemianLi/nexus-agent/issues/702)）。理由同 #588：目標是每一次 ≤10%，
 *    第一次沒有錨就只能借。
 *
 * 4. **逐位切詞的數字**（#1102）：dsh 的估算器是固定密度、沒有 tokenizer 的概念，所以也沒有這一格；它的做法（每 4 個
 *    字元一個 token）對純數字更糟：四位的 `1234` 在逐位切詞下是 4 個 token，它算 1 個（o200k 算 2 個）。表達不出來的是「這顆模型的數字怎麼切」——退到最接近的：型錄條目上一個明著宣告的欄位，估算器
 *    據此加差額。
 *
 * 另外 dsh 只在「用量 ≥ 那次的估算」時才採用錨（保守的那一邊），我們一律採用：目標是雙向 10%，不是只防少估。
 *
 * @module
 */

import { createHash } from 'node:crypto';
import type { BaseMessage } from '@langchain/core/messages';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import o200k_base from 'gpt-tokenizer/encoding/o200k_base';

/** 每則訊息的角色框架開銷。#586 的評估用同一個值。 */
const MESSAGE_OVERHEAD = 4;

/** 內容比例要算得穩，估算增加量至少要這麼多。#586 的評估用同一個值。 */
const MIN_RATIO_SPAN = 500;

/** 帳上最多記幾則 AI 訊息。超過就丟最舊的——那些多半早被摘要掉了。 */
const MAX_SENT_ENTRIES = 20_000;

/**
 * 沒有空白的一段（以及一整段空白）超過這麼長就切開來編。**這是防崩潰與防卡死的承重件，不是微調**（#1107 換編碼器時重量）。
 *
 * gpt-tokenizer 對一個 regex 片段做 BPE 合併，片段很長時有幾種壞法（各量過，Node 25.9，不切的情況）：四萬個 `X` 連在一起
 * 0.6 秒；十八萬字元的空白與換行 11 秒；十五萬個隨機漢字（中間沒有空白）**四十三秒之後拋 `RangeError: Maximum call stack
 * size exceeded`**（`push(...tokens)` 展開太大的陣列）。後者在 {@link estimateTextTokens} 上會讓外溢層那一次工具呼叫整個
 * 失敗。切成 128 字元一塊之後這些都只是一般成本，而 #586 那四種素材（中文、混合、英文程式碼）的 token 數與不切差不到 0.01%。
 * 前一個編碼器（js-tiktoken）是另一種壞法（平方級，四萬個 `X` 要一分多鐘），所以 128 這個數字是那時量的；換編碼器後沒有
 * 理由動它，**而且換了之後每一個素材的 token 數與前一個編碼器逐位相同**（`token-estimate.test.ts` 的對照測試）。
 *
 * **連續空白同理**（#719 量到）：外溢層在工具呼叫的路徑上量長結果，不能被一則怪輸出卡住。
 */
const MAX_RUN = 128;
const LONG_RUN = new RegExp(`\\S{${MAX_RUN + 1},}|\\s{${MAX_RUN + 1},}`, 'g');

/**
 * 編碼選項：**特殊 token 的字串一律當一般文字**。gpt-tokenizer 預設碰到 `<|endoftext|>` 這種字串會拋
 * （`Disallowed special token found`）；清空 `disallowedSpecial` 就當一般文字編，與前一個編碼器 `encode(text, [], [])`
 * 的結果逐位相同（`token-estimate.test.ts` 對照過）。
 */
const ENCODE_OPTIONS = { disallowedSpecial: new Set<string>() } as const;

/** 一段文字直接編。呼叫 `o200k_base.encode`（物件上的屬性，不先解構），測試才攔得到。 */
function encoded(text: string): number {
  if (text.length === 0) return 0;
  return o200k_base.encode(text, ENCODE_OPTIONS).length;
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

/**
 * 短於這麼多字元的不進備忘：編它比雜湊它還便宜。
 */
const MEMO_MIN_CHARS = 256;

/** 備忘最多記幾筆。每筆是一個 40 字元的雜湊鍵加一個數，滿了丟最久沒用的。 */
const MEMO_MAX_ENTRIES = 20_000;

/**
 * 超過這麼多字元的一段文字，請求估算只量幾個等距的窗口、按比例推整段，見 {@link sampledTokens}。
 */
const SAMPLE_OVER_CHARS = 40_000;
const SAMPLE_WINDOWS = 32;
const SAMPLE_WINDOW_CHARS = 1_000;

/**
 * 以文字內容為鍵的備忘（**exact** 與 **sampled** 兩種各記各的）。
 *
 * **為什麼要有它**（[#952](https://github.com/DemianLi/nexus-agent/issues/952)）：下面的 `perMessage`／`perTool` 以物件
 * 為鍵，而物件跨輪不穩——存檔點（`MemorySaver`）每次讀回來都反序列化出新的訊息物件，量過：同一則訊息第二輪就不是同一個
 * 物件。於是歷史裡每一則都在**每一輪**重編一次，而當時的編碼器 js-tiktoken 在中文上約 7 µs／字元（二十七萬字元 1.8 秒；#1107 換成 gpt-tokenizer 之後慢兩個數量級，見檔頭「編碼器」），長中文
 * 歷史的每輪開頭就同步卡住好幾秒，serve 此時處理不了任何請求。文字是不可變的，以內容的 sha1 為鍵，換了物件、換了 thread
 * 都命中；結果與不備忘逐位相同。
 *
 * 備忘的是一個純函式（文字 → 數），所以放模組層級不違反 [#702](https://github.com/DemianLi/nexus-agent/issues/702)
 * 對「帳」的要求：那條管的是會隨 thread 變的狀態。
 */
const memo = new Map<string, number>();

function memoized(
  text: string,
  mode: 'exact' | 'sampled',
  compute: (text: string) => number,
): number {
  if (text.length < MEMO_MIN_CHARS) return compute(text);
  const key = `${mode}:${createHash('sha1').update(text).digest('hex')}`;
  const hit = memo.get(key);
  if (hit !== undefined) {
    // 命中就挪到最後，LRU。
    memo.delete(key);
    memo.set(key, hit);
    return hit;
  }
  const value = compute(text);
  memo.set(key, value);
  if (memo.size > MEMO_MAX_ENTRIES) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  return value;
}

/** 從 `start` 起 `length` 個字元，不把代理對切成兩半。 */
function windowAt(text: string, start: number, length: number): string {
  let from = start;
  const low = text.charCodeAt(from);
  if (low >= 0xdc00 && low <= 0xdfff) from += 1;
  let to = Math.min(text.length, from + length);
  const high = text.charCodeAt(to - 1);
  if (high >= 0xd800 && high <= 0xdbff) to -= 1;
  return text.slice(from, to);
}

/**
 * 一段**很長**的文字約幾個 token：頭到尾等距取 {@link SAMPLE_WINDOWS} 個窗口各編一次，按字元數的比例推整段。
 *
 * 只在請求估算用（壓力檢查、預算、剪刀），那裡不要求精確、要求的是別把事件迴圈卡住：第一次看到一則八十萬字元的中文
 * 工具結果，全量編要 1.8 秒以上，抽樣只編三萬兩千字元（約 0.2 秒）。等距而不是只取開頭，是因為長結果常常前後不是同一種東西
 * （前面一段 JSON、後面一大段中文）。結果是確定的，同一段文字永遠推出同一個數，所以帳上記的 E 與之後再估的 E 是同一個。
 * 單段文字的入口 {@link estimateTextTokens} 不抽樣：外溢層用它做預算的硬保證。
 *
 * **量到的誤差**：五種素材（中文文件、去掉空白的中文、程式碼、lockfile、每 7000 字元換一種的混合）各取
 * 4.5 萬～30 萬字元三種長度三個起點，對全量編的偏差最大 6.0%，多數在 3% 以內。16 個窗口時同一批最大 12.6%，所以是 32 個
 * 一千字元的窗口，不是 16 個兩千字元的：同樣編三萬兩千字元，窗口多、切到不同種內容的機會大。
 */
function sampledTokens(text: string): number {
  if (text.length <= SAMPLE_OVER_CHARS) return o200k(text);
  const stride = (text.length - SAMPLE_WINDOW_CHARS) / (SAMPLE_WINDOWS - 1);
  let tokens = 0;
  let chars = 0;
  for (let index = 0; index < SAMPLE_WINDOWS; index += 1) {
    const piece = windowAt(text, Math.floor(index * stride), SAMPLE_WINDOW_CHARS);
    tokens += o200k(piece);
    chars += piece.length;
  }
  return Math.round((tokens * text.length) / Math.max(1, chars));
}

/** 請求估算裡一段文字的 token 數：備忘過，超長的抽樣。 */
function requestTextTokens(text: string): number {
  return memoized(text, text.length > SAMPLE_OVER_CHARS ? 'sampled' : 'exact', sampledTokens);
}

/** 摘要器交給下一層、或剪刀收到的那份請求，估算要的只有這幾格。 */
export interface EstimatedRequest {
  readonly messages?: readonly BaseMessage[];
  readonly systemMessage?: unknown;
  readonly tools?: unknown;
  readonly model?: unknown;
}

/**
 * 一段內容的兩個量：`tokens` 是 o200k 的 token 數（備忘過、超長的抽樣），`excess` 是**逐位切詞的模型比 o200k 多出來**
 * 的那一截（見 {@link digitExcess}）。分開記，是因為同一則訊息可能被不同的模型估——快取在物件上，不能把某個模型的答案
 * 烤進去。
 */
interface Counted {
  readonly tokens: number;
  readonly excess: number;
}

const NONE: Counted = { tokens: 0, excess: 0 };

const perMessage = new WeakMap<object, Counted>();
const perTool = new WeakMap<object, Counted>();

/**
 * o200k 的數字規則是「最多三位一組」，所以連續 L 位的數字是 ceil(L/3) 個 token；逐位切詞的模型是 L 個。多出來的
 * 就是 L − ceil(L/3)，對全文每一段連續數字加總（[#1102](https://github.com/DemianLi/nexus-agent/issues/1102)）。
 *
 * 只認 ASCII 數字：量測用的素材（CSV、JSON、表格、hex）全是它，全形數字等沒量過就不猜。**掃全文，不抽樣**：
 * 一個正規表達式線性掃過去比編碼便宜三個數量級（八十萬字元約幾毫秒）。
 */
function digitExcess(text: string): number {
  let excess = 0;
  for (const match of text.matchAll(/\d{2,}/g))
    excess += match[0].length - Math.ceil(match[0].length / 3);
  return excess;
}

/** 一段文字的兩個量。 */
function countText(text: string): Counted {
  return { tokens: requestTextTokens(text), excess: digitExcess(text) };
}

/**
 * 不算進內容的區塊。
 *
 * - **推理**：`ChatOpenAI` 送回模型時丟掉它（`@langchain/openai` 不回傳推理區塊），算進來會高估。
 * - **工具呼叫**：AI 訊息的 `content` 裡還有一份 `tool_call` 區塊，跟 `tool_calls` 欄位是同一個東西；送上線的只有
 *   後者（`content` 是 `null`）。兩份都算就是算兩次——#588 驗收時一則帶三千字參數的 `write_file` 因此估多了 27%。
 */
const UNSENT_BLOCKS = new Set([
  'reasoning',
  'thinking',
  'tool_call',
  'tool_call_chunk',
  'invalid_tool_call',
]);

/** 內容裡模型看得到的文字。認不得的區塊照 JSON 算，同 dsh 的 `estimateStructuralBlock`。 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content as unknown[]) {
    if (typeof block === 'string') text += block;
    else if (block !== null && typeof block === 'object') {
      const { type, text: blockText } = block as { type?: unknown; text?: unknown };
      if (typeof type === 'string' && UNSENT_BLOCKS.has(type)) continue;
      text += typeof blockText === 'string' ? blockText : JSON.stringify(block);
    }
  }
  return text;
}

/**
 * 一段文字的 E（不錨、不含訊息框架）。給外溢層（#719）量「這一則結果佔多少預算」用，與 {@link estimateRequestTokens}
 * 是同一把尺——單段文字的入口只有這一個，#715 算圖時也走它。
 *
 * @param text - 要估的文字。
 * @returns o200k 算出來的 token 數。
 */
export function estimateTextTokens(text: string): number {
  return memoized(text, 'exact', o200k);
}

/** 一則訊息的 E。同一個物件只編一次。 */
function messageTokens(message: BaseMessage): Counted {
  const cached = perMessage.get(message);
  if (cached !== undefined) return cached;
  let text = contentText(message.content);
  const calls = (message as { tool_calls?: readonly { name?: unknown; args?: unknown }[] })
    .tool_calls;
  for (const call of calls ?? []) text += String(call.name ?? '') + JSON.stringify(call.args ?? {});
  const counted = withOverhead(countText(text));
  perMessage.set(message, counted);
  return counted;
}

/** 每則訊息的角色框架開銷，加在 o200k 那一截上。 */
function withOverhead(counted: Counted): Counted {
  return { tokens: counted.tokens + MESSAGE_OVERHEAD, excess: counted.excess };
}

/** 一個工具定義的 E：送上線的那個 OpenAI 形狀的 JSON。轉不過去就照原物件的 JSON。 */
function toolTokens(tool: unknown): Counted {
  if (tool === null || typeof tool !== 'object') return NONE;
  const cached = perTool.get(tool);
  if (cached !== undefined) return cached;
  let json: string;
  try {
    json = JSON.stringify(convertToOpenAITool(tool as Record<string, unknown>));
  } catch {
    json = JSON.stringify(tool) ?? '';
  }
  const counted = countText(json);
  perTool.set(tool, counted);
  return counted;
}

/** system 那一則的 E。沒有就是 0。 */
function systemTokens(system: unknown): Counted {
  if (system === null || typeof system !== 'object') return NONE;
  const cached = perMessage.get(system);
  if (cached !== undefined) return cached;
  const text = contentText((system as { content?: unknown }).content);
  const counted = text.length === 0 ? NONE : withOverhead(countText(text));
  perMessage.set(system, counted);
  return counted;
}

/**
 * 一份請求的 E（不錨）。
 *
 * @param request - 要估的請求；`messages` 可以只給一段前綴。
 * @param options - `singleDigits`：這顆模型把數字逐位切成一個 token 一位（[#1102](https://github.com/DemianLi/nexus-agent/issues/1102)），
 *   連續數字按位數計，不按 o200k 的三位一組。省略就是 o200k 原樣。
 * @returns token 數：o200k 算出來的，加上 `singleDigits` 時逐位切詞多出來的那一截。
 */
export function estimateRequestTokens(
  request: EstimatedRequest,
  options: { readonly singleDigits?: boolean } = {},
): number {
  let tokens = 0;
  let excess = 0;
  const add = (counted: Counted): void => {
    tokens += counted.tokens;
    excess += counted.excess;
  };
  add(systemTokens(request.systemMessage));
  for (const message of request.messages ?? []) add(messageTokens(message));
  if (Array.isArray(request.tools)) for (const tool of request.tools) add(toolTokens(tool));
  return options.singleDigits === true ? tokens + excess : tokens;
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

/** 這串訊息裡帶實數、模型對得上的 AI 訊息：最後一則（錨）與最早一則。都沒有就是 −1。 */
function anchorsIn(
  messages: readonly BaseMessage[],
  current: string | undefined,
): { readonly last: number; readonly first: number } {
  let last = -1;
  let first = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const reported = reportedInput(messages[index]!);
    if (reported === undefined || !sameModel(reported.model, current)) continue;
    if (last < 0) last = index;
    first = index;
  }
  return { last, first };
}

/** 兩個點之間的內容比例：估算增加量 ≥ 500、實數增加量 > 0 才算得出來。 */
function contentRatio(grown: number, span: number): number | undefined {
  return span >= MIN_RATIO_SPAN && grown > 0 ? grown / span : undefined;
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
 * 錨定估算要的那本帳：每一則 AI 訊息是從多大（E）的請求生出來的、每一組「模型＋工具」的第一次，與每個模型最近
 * 一次學到的內容比例。
 *
 * **一本帳由進入點建、注入到每個要用它的組裝**（[#702](https://github.com/DemianLi/nexus-agent/issues/702)），
 * 不是模組全域：serve 一條 thread 建一個 agent，借錨要跨 thread 才借得到，所以 `runServe` 建一本傳給所有 thread；
 * CLI 一個行程一個組裝，省略即各建一本。測試與 eval 每題各 `new` 一本就彼此隔離，不必伸手清全域。
 * 鍵是 AI 訊息的 id，跨 agent 共用不會撞。
 */
export class TokenAnchorBook {
  readonly #singleDigitModels: ReadonlySet<string>;
  readonly #sent = new Map<string, number>();
  readonly #firstCalls = new Map<string, { readonly tokens: number; readonly estimated: number }>();
  readonly #ratios = new Map<string, number>();

  /**
   * @param options - `singleDigitModels`：把數字逐位切詞的模型 id（型錄條目的 `tokenizer.digits: 'single'`，
   *   [#1102](https://github.com/DemianLi/nexus-agent/issues/1102)）。不在裡面的模型照 o200k 的三位一組估。
   */
  constructor(options: { readonly singleDigitModels?: Iterable<string> } = {}) {
    this.#singleDigitModels = new Set(options.singleDigitModels ?? []);
  }

  /** 這個模型是不是逐位切詞數字。認不出名字的模型不是。 */
  singleDigits(model: string | undefined): boolean {
    return model !== undefined && this.#singleDigitModels.has(model);
  }

  /** 這個模型最近一次學到的內容比例（c̄）。還沒學到就是 `undefined`。 */
  learnedRatio(model: string | undefined): number | undefined {
    return this.#ratios.get(model ?? '');
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
   * 一次呼叫回來了：記下它的 E，從它與它的參考點學一次內容比例；它是一條 thread 的第一次的話，也記成借錨的來源
   * （同一組只記第一個）。
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
    const reported = reportedInput(message);
    const current = modelNameOf(sent.model);
    if (reported === undefined || !sameModel(reported.model, current)) return;
    this.#learn(current, reported.tokens, sent, estimated, basis);
    if (basis === 'anchor') return;
    const key = firstCallKey(sent);
    if (!this.#firstCalls.has(key))
      this.#firstCalls.set(key, { tokens: reported.tokens, estimated });
  }

  /**
   * 學一次內容比例：錨定的那次對這串裡最早那則錨，借錨的那次對借來的那一次。純估算的那次沒有參考點，不學。
   * 學不出來（兩點太近、實數沒增加）就留著上一次學到的。
   */
  #learn(
    model: string | undefined,
    tokens: number,
    sent: EstimatedRequest,
    estimated: number,
    basis: TokenEstimate['basis'],
  ): void {
    let ratio: number | undefined;
    if (basis === 'anchor') {
      const messages = sent.messages ?? [];
      const earliest = messages[anchorsIn(messages, model).first];
      const earliestSent = this.sentEstimate(earliest?.id);
      if (earliest !== undefined && earliestSent !== undefined)
        ratio = contentRatio(tokens - reportedInput(earliest)!.tokens, estimated - earliestSent);
    } else if (basis === 'borrowed') {
      const ref = this.firstCall(sent);
      if (ref !== undefined) ratio = contentRatio(tokens - ref.tokens, estimated - ref.estimated);
    }
    if (ratio !== undefined) this.#ratios.set(model ?? '', ratio);
  }
}

/**
 * 錨定估算。
 *
 * @param request - 要估的請求。錨從它的 `messages` 裡找。
 * @param book - 帳。由進入點注入，見 {@link TokenAnchorBook}。
 * @returns 估算值與它的來源。
 */
export function estimateAnchoredTokens(
  request: EstimatedRequest,
  book: TokenAnchorBook,
): TokenEstimate & { readonly estimated: number } {
  const messages = request.messages ?? [];
  const current = modelNameOf(request.model);
  const digits = { singleDigits: book.singleDigits(current) };
  const estimated = estimateRequestTokens(request, digits);
  const learned = book.learnedRatio(current) ?? 1;
  const { last, first } = anchorsIn(messages, current);
  if (last >= 0) {
    const anchor = messages[last]!;
    const tokens = reportedInput(anchor)!.tokens;
    const before =
      book.sentEstimate(anchor.id) ??
      estimateRequestTokens({ ...request, messages: messages.slice(0, last) }, digits);
    let ratio: number | undefined;
    const earliest = messages[first]!;
    const earliestSent = first < last ? book.sentEstimate(earliest.id) : undefined;
    const lastSent = book.sentEstimate(anchor.id);
    if (earliestSent !== undefined && lastSent !== undefined)
      ratio = contentRatio(tokens - reportedInput(earliest)!.tokens, lastSent - earliestSent);
    return {
      tokens: Math.round(tokens + (estimated - before) * (ratio ?? learned)),
      basis: 'anchor',
      estimated,
    };
  }
  const borrowed = book.firstCall(request);
  if (borrowed !== undefined)
    return {
      tokens: Math.round(borrowed.tokens + (estimated - borrowed.estimated) * learned),
      basis: 'borrowed',
      estimated,
    };
  return { tokens: estimated, basis: 'estimate', estimated };
}
