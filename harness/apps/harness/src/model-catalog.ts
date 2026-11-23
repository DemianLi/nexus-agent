/**
 * 模型型錄：每顆模型的窗口、輸出上限、收哪些種類的輸入、推理等級，以及怎麼關推理
 * （[#729](https://github.com/DemianLi/nexus-agent/issues/729)）。
 *
 * 照 dsh `llm-pi-ai` 的型錄形狀（`packages/llm/llm-pi-ai/src/catalog.ts:574-610`，`477b4f4`）：**型錄的來源是設定，
 * 不去問端點有哪些模型**；每一筆帶 `id`、`contextWindow`、`maxTokens`（設了就是這顆每次請求的預設輸出上限）、
 * `input`、`reasoningEfforts` 與 `compat`；`models` 整份取代型錄（`README.md:99`），不是逐筆合併。
 * 只有查詢與解析在這裡，不裝功能；設定的邊界在 `settings/live-model.ts`。
 *
 * ## 與 dsh 的差異
 *
 * - **多一格 `tokenizer`（#1102）。** dsh 的型錄沒有這一格：它的估算器是固定密度（4 個字元一個 token，見
 *   `token-estimate.ts` 的偏離），不分模型。我們的估算以 o200k 為底，而出廠預設模型把數字逐位切詞，數字為主的內容
 *   會少估到一半。dsh 表達得出來的做法（固定密度加錨）在同一批資料上更差，所以這是我們才有的缺口，記在條目上、跟 id
 *   同一筆（理由同下面的 `compat`：換模型時要一起換）。
 * - **多一格 `imageBudget`（#1270）。** dsh 的圖片請求額度住在 adapter 的部署 profile（`maxRequestImageBytes`，
 *   `packages/llm/llm-pi-ai/src/adapter.ts:370`，`5badb150`），是一個部署一份；我們沒有 profile 這一層，而端點的收圖上限是
 *   **每顆模型各自的**（`meta/llama-3.2-90b-vision-instruct` 每次請求最多一張），跟 id 同一筆、換模型時一起換。形狀照
 *   `LlmImageRequestBudget`（`maxImages`、`maxBytes`），單位是張數與位元組。
 * - **`compat` 收 `chatTemplateKwargs` 與 `supportsFinishReason`（#1538）。** dsh 的 `compat` 是 pi-ai 的一整組線上相容開關（系統提示放哪個角色、
 *   哪個欄位限制輸出、思考怎麼送……）；我們沒有 pi-ai 那一層，只有一個要送 chat template 參數的需求。值裡只認
 *   `{ $var: 'thinking.enabled' }` 這一個佔位符（dsh 有三個：另兩個是 `thinking.effort`、`thinking.budget`，
 *   `catalog.ts:152-160`），因為今天沒有任何等級的線上寫法會被送出去：每會話可選的只有 `off` 與 `default`（#723，
 *   `model-selection-host.ts`），`default` 是「不加任何設定」，沒有東西要解 `thinking.effort`、`thinking.budget`。
 * - **`reasoningEfforts` 的值今天沒有消費者，只讀鍵。** 鍵是給人選的等級名字，`off` 是「不推理」；{@link thinkingOffBody}
 *   只看 `off` 這個鍵在不在，不讀值，其餘等級的值也不會被送出去。
 * - **`reasoningEfforts` 的驗證只搬 dsh 的前三條（#1561）。** 照 `resolveModelReasoning`（`packages/llm/llm-pi-ai/src/catalog.ts:741-756`，
 *   `687f282e`）：空 dict（含 YAML 寫了 `reasoningEfforts:` 卻沒給值的 `null`，dsh `:741` 同樣把兩者併成一則）、`off` 以外的等級沒有線上的寫法、
 *   值是空字串，三種都在載入時拒收，訊息指名是哪一顆模型的哪一級。
 *   **形狀不同**：dsh 的 `invalid()` 回傳型別是 `never`，當場拋出，只報第一個問題（`catalog.ts:676-678`）；這裡是 zod 的 `superRefine`，
 *   收集**所有**問題一次報完（一筆裡好幾個等級寫壞時不必改一個、重跑一次）。
 *   **不搬**的兩件（理由 1：基座表達不出來）：nexus 沒有 pi-ai 的 `thinkingLevelMap`，`off` 以外沒有線上路徑，「`default` ＝ 不送」是最接近的
 *   實作，隱含的 `default` 已登記在 `model-selection-host.ts` 開頭「與 dsh 的差異」第一條。後果有兩件：第四條「`off` 以外至少一級」不搬
 *   （`{ off: null }` 是有意義的宣告：這顆會推理、可以關掉、預設照模型自己的）；鍵不限制在 dsh 的 `THINKING_LEVELS`（出廠那一筆的鍵是
 *   `off` 與 `default`，`default` 不在其中）。`thinkingLevelMap` 本身是 pi-ai 自己的預設行為，不適用。
 * - **`chat_template_kwargs` 只有「關」那一邊會送。** pi-ai 在非 `off` 的等級底下會把 `thinking.enabled` 解成 `true`
 *   一併送出；我們的主請求今天不帶這一格，只有標題這種要關推理的用途才帶（#650）。所以 `default` 是模型自己的預設，
 *   **開不開推理各顆不同，不代表會推理**。主請求都不送時，`nvidia/nemotron-3.5-bolt-e4b` 35 則回覆的推理 token 全是 0，
 *   `nvidia/nemotron-3.5-super-vl-120b-a12b` 24 則全部大於 0。明著送 `enable_thinking: true` 跟不送不等價：Bolt 這時才推理，
 *   同一份請求（時間讀數排在問題之後）8 次裡有 6 次不呼叫工具（量測：2026-10-30，NVIDIA 閘道，#2155），所以 `default` 不明送。
 *
 * @module
 */

import { z } from 'zod';

/** 一筆模型的輸入種類。 */
const inputKinds = ['text', 'image'] as const;

/** chat template 參數的值：字面值，或請求狀態的佔位符（今天只認 `thinking.enabled`）。 */
const chatTemplateValue = z.union([
  z.strictObject({ $var: z.literal('thinking.enabled') }),
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

/** 一筆型錄條目的欄位，見檔頭。`strictObject`：多寫一個欄位是打錯字。跨欄位的檢查在下面的 {@link modelEntrySchema}。 */
const modelEntryFields = z.strictObject({
  /** 送給端點的模型 id。 */
  id: z.string().min(1),
  /** 請求加回應合起來的上限（token）。今天沒有消費者，記量過的下限，給摘要門檻與選模型的卡用。 */
  contextWindow: z.number().int().positive(),
  /**
   * 這顆每一次請求送出去的 `max_tokens`。**下限 1 是承重的**：`live-model.ts` 的 `isDerivedContextOverflow`
   * 唯一的前提是我們送出去的輸出上限恆為正數（那樣伺服器回來的負值才只可能是它自己導出來的）。
   */
  maxTokens: z.number().int().positive(),
  /**
   * 收哪些種類的輸入。**這是對端點的宣告，不是檢查**：宣告收圖、端點卻不收，會在請求當下被供應商拒絕。
   * 沒寫就是「沒宣告」，不當成收圖，見 {@link acceptsImages}。
   */
  input: z.array(z.enum(inputKinds)).optional(),
  /**
   * 一次請求收得下的圖有多少（[#1270](https://github.com/DemianLi/nexus-agent/issues/1270)，照 dsh `LlmImageRequestBudget`）。
   * 單位是**張數與位元組**（圖片 base64 的總長度），不是 token。**沒寫就是沒宣告＝不檢查**（同 dsh 的「absent leaves … unbounded」）：
   * 超額時最舊的圖被換成佔位字並記一筆 `image/offload`，之後每次請求都沿用。只有量過端點的才宣告，量法與數字寫在條目旁的註解。
   */
  imageBudget: z
    .strictObject({
      maxImages: z.number().int().positive().optional(),
      maxBytes: z.number().int().positive().optional(),
    })
    .optional(),
  /**
   * 可選的推理等級：鍵是給人選的名字，值是線上的寫法，`null` 是沒有線上寫法（`off:`）；`false` 是這顆不推理。
   * 沒寫就是沒宣告。
   */
  reasoningEfforts: z
    .union([
      z.literal(false),
      z.record(z.string(), z.string().nullable()),
      // YAML 寫了 `reasoningEfforts:` 卻沒給值會是 `null`。dsh 把它跟 `{}` 併成同一則訊息（`catalog.ts:741`）；這裡讓它過了欄位這一層，
      // 由下面的 `superRefine` 帶 id 拒收（欄位層的 union 錯誤只有 `Invalid input`，沒有指名是哪一顆）。型別是 `never`：拒收之後不會有 `null` 流到消費者。
      z.null().transform((value) => value as never),
    ])
    .optional(),
  /**
   * 這顆模型的 tokenizer 跟 o200k 不一樣的地方，給 token 估算用（[#1102](https://github.com/DemianLi/nexus-agent/issues/1102)）。
   * 今天只有一格：`digits: 'single'` 是這顆把數字逐位切成一個 token 一位（o200k 是最多三位一組）。**沒寫就是照
   * o200k 估**。只有量過的才宣告：`nemotron-3-super-120b-a12b` 量到數字為主的內容（CSV）真實是 o200k 的 1.88 倍，
   * 按位數計之後差 0.0%。
   */
  tokenizer: z.strictObject({ digits: z.enum(['grouped', 'single']) }).optional(),
  /** 線上相容開關，見檔頭「與 dsh 的差異」。 */
  compat: z
    .strictObject({
      /** 送成 `chat_template_kwargs` 的參數。 */
      chatTemplateKwargs: z.record(z.string(), chatTemplateValue).optional(),
      /**
       * 這個端點的串流會不會送 `finish_reason`（#1538，照 dsh `supportsFinishReason`，`llm-pi-ai/src/catalog.ts:401-405`）。
       * **沒寫就是 `true`**：串流在收到結束原因之前結束算斷線、陌生的結束原因算失敗。內網自架端點（vLLM 之類）不送時設 `false`，
       * 兩項檢查都關掉，行為同沒有這一層。
       */
      supportsFinishReason: z.boolean().optional(),
    })
    .optional(),
});

/**
 * 一筆型錄條目，見檔頭。
 *
 * `reasoningEfforts` 照 dsh `resolveModelReasoning` 的前三條檢查（`packages/llm/llm-pi-ai/src/catalog.ts:741-756`，`687f282e`）：
 * 空 dict 拒收、`off` 以外的等級不能留空（沒有線上的寫法）、值不能是空字串。放在條目這一層，因為 record 那一支拿不到 `id`，訊息要指名是哪一顆。
 */
export const modelEntrySchema = modelEntryFields.superRefine((entry, context) => {
  const efforts = entry.reasoningEfforts;
  if (efforts === undefined || efforts === false) return;
  // 欄位型別排除了 `null`（見 `reasoningEfforts` 那一格），所以比較要先放寬。
  if ((efforts as unknown) === null || Object.keys(efforts).length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['reasoningEfforts'],
      message: `模型 "${entry.id}" 的 reasoningEfforts 是空的：列出提供的等級，非推理模型寫 false，或整格不寫`,
    });
    return;
  }
  for (const [level, wire] of Object.entries(efforts)) {
    if (wire === null) {
      if (level !== 'off') {
        context.addIssue({
          code: 'custom',
          path: ['reasoningEfforts', level],
          message: `模型 "${entry.id}" 的 reasoningEfforts.${level} 沒有線上的寫法：要寫送給端點的值，只有 off 可以留空`,
        });
      }
    } else if (wire === '') {
      context.addIssue({
        code: 'custom',
        path: ['reasoningEfforts', level],
        message: `模型 "${entry.id}" 的 reasoningEfforts.${level} 不能是空字串`,
      });
    }
  }
});

/** 驗過的一筆條目。 */
export type ModelEntry = z.infer<typeof modelEntrySchema>;

/** 型錄：一串條目，`id` 不重複。 */
export const modelCatalogSchema = z.array(modelEntrySchema).superRefine((entries, context) => {
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (seen.has(entry.id)) {
      context.addIssue({
        code: 'custom',
        path: [index, 'id'],
        message: `型錄裡 "${entry.id}" 出現了不只一次`,
      });
    }
    seen.add(entry.id);
  }
});

/**
 * 依模型 id 查那一筆。
 *
 * @param catalog - 型錄。
 * @param id - 模型 id。
 * @returns 那一筆；型錄沒有就 `undefined`。
 */
export function findModelEntry(catalog: readonly ModelEntry[], id: string): ModelEntry | undefined {
  return catalog.find((entry) => entry.id === id);
}

/**
 * 依模型 id 取那一筆，型錄沒有就拋。
 *
 * @param catalog - 型錄。
 * @param id - 模型 id。
 * @returns 那一筆。
 */
export function requireModelEntry(catalog: readonly ModelEntry[], id: string): ModelEntry {
  const entry = findModelEntry(catalog, id);
  if (entry === undefined) {
    const known = catalog.map((each) => each.id).join('、');
    throw new Error(`型錄裡沒有模型 "${id}"（型錄有：${known === '' ? '（空的）' : known}）`);
  }
  return entry;
}

/**
 * 型錄裡把數字逐位切詞的模型 id，給 {@link TokenAnchorBook} 的建構子（[#1102](https://github.com/DemianLi/nexus-agent/issues/1102)）。
 *
 * @param catalog - 型錄。
 * @returns 宣告了 `tokenizer.digits: 'single'` 的那幾顆的 id。
 */
export function singleDigitModelIds(catalog: readonly ModelEntry[]): string[] {
  return catalog.filter((entry) => entry.tokenizer?.digits === 'single').map((entry) => entry.id);
}

/** 收不收圖的三種答案。 */
export type ImageSupport = 'accepts' | 'rejects' | 'undeclared';

/**
 * 這一筆收不收圖。**沒宣告 `input` 就回 `'undeclared'`，不當成收圖**——同 dsh 的 `read_image` 要明確宣告才放行
 * （`packages/fs/tool-fs/src/read-image.ts:128-130`）。
 *
 * @param entry - 型錄條目。
 * @returns `'accepts'`（宣告了 `image`）、`'rejects'`（宣告了 `input` 但沒有 `image`）、`'undeclared'`（沒宣告）。
 */
export function acceptsImages(entry: ModelEntry): ImageSupport {
  if (entry.input === undefined) return 'undeclared';
  return entry.input.includes('image') ? 'accepts' : 'rejects';
}

/**
 * 這一筆**宣告了** `off` 那一級（`reasoningEfforts` 有 `off` 這個鍵）。看宣告，不看值：`off: null` 在 dsh 的意思是「支援，但什麼都不送」。
 * 標題請求紀錄的 `reasoningEffort` 與 {@link thinkingOffBody} 共用這一個判準，記的跟送的出自同一處（[#1573](https://github.com/DemianLi/nexus-agent/issues/1573)）。
 *
 * @param entry - 型錄條目。
 * @returns 宣告了就 `true`；沒宣告、`reasoningEfforts` 是 `false`（不推理）或沒寫，都是 `false`。
 */
export function declaresOffEffort(entry: ModelEntry): boolean {
  const efforts = entry.reasoningEfforts;
  return efforts !== undefined && efforts !== false && Object.hasOwn(efforts, 'off');
}

/**
 * 要關掉推理時加進請求 body 的東西：`off` 那一級加上 `compat.chatTemplateKwargs`，把 `thinking.enabled` 解成 `false`。
 * 沒宣告 `off` 那一級、不推理的模型、或沒有 chat template 參數，都是空物件（什麼都不加）。
 *
 * @param entry - 型錄條目。
 * @returns 要疊進請求 body 的頂層欄位。
 */
export function thinkingOffBody(entry: ModelEntry): Record<string, unknown> {
  if (!declaresOffEffort(entry)) return {};
  const template = entry.compat?.chatTemplateKwargs;
  if (template === undefined) return {};
  const resolved: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(template)) {
    resolved[name] = typeof value === 'object' && value !== null && '$var' in value ? false : value;
  }
  return { chat_template_kwargs: resolved };
}
