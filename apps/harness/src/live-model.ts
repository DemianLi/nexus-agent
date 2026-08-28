import { resolve } from 'node:path';
import { ChatOpenAI } from '@langchain/openai';

/**
 * Phase 0 的真實供應商接線（issue #31）。
 *
 * 走 NVIDIA 的 OpenAI 相容端點：JS 這邊沒有 NVIDIA 專用的 LangChain 整合
 * （`@langchain/nvidia-ai-endpoints` 只有 Python 版），所以用 `@langchain/openai`
 * 指過去。這裡驗的是接線 —— tool call 的參數回得來、streaming 的事件形狀對得上 ——
 * 不是模型品質；供應商比較在 Phase 2 與 Phase 5（見開發計劃第 7 節決策點 2）。
 */
export const LIVE_BASE_URL = 'https://integrate.api.nvidia.com/v1';

/**
 * NVIDIA 閘道上的模型 id。接線用，與 Phase 2 的 DeepSeek 相容性驗收無關。
 *
 * **原本是 `deepseek-ai/deepseek-v4-flash-0731`，換掉是因為它不回應**
 * （[#57](https://github.com/DemianLi/nexus-agent/issues/57)：`/models` 列得到它，
 * 推論請求 60 秒零回應）。換的是同系列的 pro —— #57 當時清單上沒有同系列的替代品，
 * 2026-08-27 複驗時它出現了。**端點沒修好，是我們換了 id。**
 *
 * 換之前驗的不只是「回 200」：帶著 `tools` 定義問一句話，實測 `finish_reason` 是
 * `tool_calls`、參數是合法 JSON。光看 200 不算 —— 這條路整條的用途就是工具呼叫。
 *
 * **它慢**：一次簡單的呼叫約 37 秒。`cli:live` / `spike:live` 跑起來體感像卡住，
 * 但那是慢不是掛住（#57 的現象是**永遠**不回來）。
 *
 * 這是**預設**的 id。eval 的尺寸比較會把三個橫階的 id 傳進 {@link createLiveModel}
 * （開發計劃第 5 節 Phase 5），`cli:live` / `serve:live` / `spike:live` 三條路仍然走這個常數。
 */
export const LIVE_MODEL_ID = 'deepseek-ai/deepseek-v4-pro-0813';

/** 環境變數名。刻意不叫 `OPENAI_API_KEY`（`@langchain/openai` 的預設），免得這把 key 是誰的變模糊。 */
export const LIVE_API_KEY_ENV = 'NVIDIA_API_KEY';

/**
 * 單一請求的逾時上限。
 *
 * **這不是調校，是止血。** 這個端點的失敗模式是**永遠不回來**（[#57](https://github.com/DemianLi/nexus-agent/issues/57)），
 * 而尺寸比較是一連串請求 —— 沒有上限的話，中間掛住一次換來的是整輪比較沒有結果，
 * 而不是「那一格失敗」。90 秒是量出來的：實測最慢的成功回應是 43 秒
 * （`meta/muse-glimmer-30b`），掛住的那兩個在 90 秒仍是零位元組。
 */
export const LIVE_TIMEOUT_MS = 90_000;

/**
 * 真實供應商的 model。
 *
 * key **只從環境變數讀**，缺少時直接失敗，沒有預設值也不 fallback
 * （[docs/standards.md](../../../docs/standards.md) 的秘密處理規則）。
 *
 * @param modelId - 要指到哪個模型。省略即 {@link LIVE_MODEL_ID}；尺寸比較把三個橫階的
 *   id 逐一傳進來（見 [`eval/tiers.ts`](./eval/tiers.ts)）。**除了這個參數，兩邊的取樣
 *   設定、逾時、金鑰來源完全相同** —— 否則比的不是模型是設定。
 */
export function createLiveModel(modelId: string = LIVE_MODEL_ID): ChatOpenAI {
  const apiKey = process.env[LIVE_API_KEY_ENV];
  if (!apiKey) {
    throw new Error(
      `缺少環境變數 ${LIVE_API_KEY_ENV}。真實供應商的 key 只從環境變數讀，` +
        '沒有預設值也不 fallback。把它放進專案根目錄的 .env（該檔已被 .gitignore 排除），' +
        '或在 shell 裡設好；欄位名見 .env.example。',
    );
  }

  return new ChatOpenAI({
    apiKey,
    model: modelId,
    configuration: { baseURL: LIVE_BASE_URL },
    temperature: 1,
    topP: 0.95,
    maxTokens: 16384,
    timeout: LIVE_TIMEOUT_MS,
  });
}

/** 專案根目錄的 `.env`（已被 .gitignore 排除）。 */
const ENV_FILE = resolve(import.meta.dirname, '../../../.env');

/**
 * 需要時把根目錄的 `.env` 填進環境變數。
 *
 * **這不是 fallback。** key 一律從環境變數讀（[docs/standards.md](../../../docs/standards.md)），
 * `.env` 只是填充環境變數的其中一種方式：檔案不存在就安靜跳過，缺的變數留給
 * {@link createLiveModel} 當場失敗並指名缺哪一個。已經設好的環境變數不會被檔案蓋掉。
 */
export function loadLiveEnvIfNeeded(): void {
  if (process.env[LIVE_API_KEY_ENV]) return;
  try {
    process.loadEnvFile(ENV_FILE);
  } catch {
    // 沒有 .env 就靠 shell 裡既有的環境變數。
  }
}
