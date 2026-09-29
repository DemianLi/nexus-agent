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
 * - **`compat` 只收 `chatTemplateKwargs`。** dsh 的 `compat` 是 pi-ai 的一整組線上相容開關（系統提示放哪個角色、
 *   哪個欄位限制輸出、思考怎麼送……）；我們沒有 pi-ai 那一層，只有一個要送 chat template 參數的需求。值裡只認
 *   `{ $var: 'thinking.enabled' }` 這一個佔位符（dsh 有三個：另兩個是 `thinking.effort`、`thinking.budget`，
 *   `catalog.ts:152-160`），因為今天沒有人選推理等級或預算。
 * - **`reasoningEfforts` 的值今天沒有消費者。** 鍵是給人選的等級名字，`off` 是「不推理」；沒有每會話選等級
 *   （#723），所以值（線上的寫法）不會被送出去，只有 `off` 這一級會被 {@link thinkingOffBody} 讀到。
 * - **`chat_template_kwargs` 只有「關」那一邊會送。** pi-ai 在非 `off` 的等級底下會把 `thinking.enabled` 解成 `true`
 *   一併送出；我們的主請求今天不帶這一格（預設就是開著），只有標題這種要關推理的用途才帶（#650）。**沒有量過
 *   「明著送 `enable_thinking: true`」跟「不送」是不是等價**（這台機器沒有 key，量不了），所以保留今天的送法。
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

/** 一筆型錄條目，見檔頭。`strictObject`：多寫一個欄位是打錯字。 */
export const modelEntrySchema = z.strictObject({
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
   * 可選的推理等級：鍵是給人選的名字，值是線上的寫法，`null` 是沒有線上寫法（`off:`）；`false` 是這顆不推理。
   * 沒寫就是沒宣告。
   */
  reasoningEfforts: z
    .union([z.literal(false), z.record(z.string(), z.string().nullable())])
    .optional(),
  /** 線上相容開關，見檔頭「與 dsh 的差異」。 */
  compat: z
    .strictObject({
      /** 送成 `chat_template_kwargs` 的參數。 */
      chatTemplateKwargs: z.record(z.string(), chatTemplateValue).optional(),
    })
    .optional(),
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
 * 要關掉推理時加進請求 body 的東西：`off` 那一級加上 `compat.chatTemplateKwargs`，把 `thinking.enabled` 解成 `false`。
 * 沒宣告 `off` 那一級、不推理的模型、或沒有 chat template 參數，都是空物件（什麼都不加）。
 *
 * @param entry - 型錄條目。
 * @returns 要疊進請求 body 的頂層欄位。
 */
export function thinkingOffBody(entry: ModelEntry): Record<string, unknown> {
  const efforts = entry.reasoningEfforts;
  if (efforts === undefined || efforts === false || !Object.hasOwn(efforts, 'off')) return {};
  const template = entry.compat?.chatTemplateKwargs;
  if (template === undefined) return {};
  const resolved: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(template)) {
    resolved[name] = typeof value === 'object' && value !== null && '$var' in value ? false : value;
  }
  return { chat_template_kwargs: resolved };
}
