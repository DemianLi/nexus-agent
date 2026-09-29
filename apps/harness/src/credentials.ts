/**
 * 憑證服務：按名字解析 key，**順序照 dsh**：啟動環境 > 受管檔 > 目前資料夾 `.env` > harness home `.env`
 * （[#730](https://github.com/DemianLi/nexus-agent/issues/730) 的 B 段）。
 *
 * 對照 dsh `packages/credentials/credentials-local`（`477b4f4`）與 `packages/llm/llm-deepseek-api-key`：
 *
 * - **受管檔**放在 harness home 底下（{@link CREDENTIALS_FILE}），帶版本的 YAML，只放憑證：
 *   ```yaml
 *   version: 1
 *   refs:
 *     NVIDIA_API_KEY: nvapi-…
 *   ```
 *   任何其他內容都明確拒絕，不靜靜忽略：根不是 mapping、未知的頂層鍵、鍵不是環境變數形狀、值不是非空字串、
 *   重複鍵、壞掉的 YAML。**錯誤訊息不引原文**——YAML 解析器自己的訊息會把出錯那一行帶出來，而那一行是秘密。
 * - **讀之前先查權限**：group 或 other 有任何權限位元就拒絕，訊息帶 `chmod 600`（`owner-only.ts`，與瀏覽器會話
 *   密鑰檔共用）。寫入時檔 0600、目錄 0700——**這一段還沒有寫入路徑**（沒有設定頁，手動編輯，dsh 也允許）。
 * - **內容從不寫進行程的環境變數**：跟兩層 `.env`（`launch-env.ts`，會寫）不同，這是受管檔存在的意義。
 *   它擋得住子行程「順手繼承」，擋不住以同一個使用者身分跑的 agent——dsh 的 README 也明說了這一點。
 * - **值只在請求當下解析**：模型的 `configuration.apiKey` 是函式，每次請求前呼叫（`live-model.ts`）。
 *
 * ## 偏離 dsh
 *
 * - **重載是「每次解析先 `stat`，時間或大小變了才重讀」**，不是檔案監看（dsh 用 chokidar 加 100ms 去抖）。
 *   模型每次請求都會取 key，所以「改了檔、下一次請求就用新的」成立，少一個相依、沒有計時器要在測試裡處理。
 *   代價：沒有請求就沒有重載，也就不會在請求之外提早發現檔案壞了——**啟動那一次**（{@link CredentialService.check}）
 *   仍然完整檢查、壞了就起不來。
 * - **執行期重載失敗保留最後一份可用內容並警告一次**，同 dsh 的熱重載；啟動那一次則拋。
 * - 沒有 `records`（`grant`／`api-key` 記錄）：我們沒有第二種憑證。出現就當未知頂層鍵拒絕。
 * - 服務是一個函式庫物件，由入口建、往下傳，不放進 `registry.services`：消費者只有模型那兩顆，
 *   不需要 plugin 也能取得它。
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument, type YAMLError } from 'yaml';

import { assertOwnerOnlyMode } from './owner-only.js';
import type { LaunchEnvironment } from './launch-env.js';

/** 受管憑證檔在 harness home 底下的名字。 */
export const CREDENTIALS_FILE = '.credentials.yaml';

/** 這個版本讀得懂的文件版本。 */
export const CREDENTIALS_DOCUMENT_VERSION = 1;

/** 一把憑證是從哪一層來的。 */
export type CredentialOrigin = 'env' | 'file' | 'project-env' | 'user-env';

/** 解析結果。**值只在這個物件上**，不進日誌、不進錯誤訊息。 */
export interface ResolvedCredential {
  readonly value: string;
  readonly source: CredentialOrigin;
}

/** 憑證服務。同步：受管檔很小，同步讀讓「建構時快速失敗」與「請求時再解析」用同一個函式。 */
export interface CredentialService {
  /**
   * 按名字解析。
   *
   * @param name - 環境變數形狀的名字（例如 `NVIDIA_API_KEY`）。
   * @returns 第一個有非空值的層；都沒有是 `undefined`。
   * @throws 受管檔第一次讀就壞了（權限、格式）。已經讀過一次好的，之後壞了保留最後一份並警告。
   */
  resolve(name: string): ResolvedCredential | undefined;
  /**
   * 啟動時完整檢查受管檔：權限、格式、內容。檔案不存在是正常的。
   *
   * @throws 任何一項不過。
   */
  check(): void;
}

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** 不引原文的 YAML 錯誤描述：只有錯誤碼與位置。 */
function describeYamlError(error: YAMLError): string {
  const at = error.linePos?.[0];
  return `${error.code}${at === undefined ? '' : `（第 ${String(at.line)} 行第 ${String(at.col)} 欄）`}`;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/**
 * 解析一份受管檔的文字。
 *
 * @param file - 只用在訊息裡。
 * @param text - 檔案內容。
 * @returns `refs`：名字 → 值。
 * @throws 不合格的內容；**訊息不含任何值**。
 */
export function parseCredentialsDocument(file: string, text: string): ReadonlyMap<string, string> {
  const fail = (why: string): never => {
    throw new Error(`受管憑證檔 ${file} 認不得：${why}`);
  };
  if (text.trim() === '') return new Map();
  const document = parseDocument(text, { uniqueKeys: true, prettyErrors: false });
  const [problem] = document.errors;
  if (problem !== undefined) fail(`YAML 錯誤 ${describeYamlError(problem)}`);
  const root: unknown = document.toJS();
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    return fail('根要是一個 mapping（version 與 refs）');
  }
  const record = root as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'version' && key !== 'refs') {
      return fail(`不認得的頂層鍵 "${key}"（只有 version 與 refs）`);
    }
  }
  if (record.version !== CREDENTIALS_DOCUMENT_VERSION) {
    return fail(`version 要是 ${String(CREDENTIALS_DOCUMENT_VERSION)}`);
  }
  const refs = record.refs ?? {};
  if (refs === null || typeof refs !== 'object' || Array.isArray(refs)) {
    return fail('refs 要是 mapping（名字: 值）');
  }
  const out = new Map<string, string>();
  for (const [name, value] of Object.entries(refs as Record<string, unknown>)) {
    if (!NAME_PATTERN.test(name)) return fail(`refs 的鍵 "${name}" 不是環境變數形狀的名字`);
    // 不引值：連型別都只說「不是字串」。
    if (typeof value !== 'string') return fail(`refs.${name} 要是字串`);
    if (value.length === 0) {
      return fail(`refs.${name} 是空字串（要移除一把憑證就刪掉那一行，不要留空）`);
    }
    out.set(name, value);
  }
  return out;
}

/** {@link createCredentialService} 的參數。 */
export interface CredentialServiceOptions {
  /** 已解析的 harness home：受管檔在它底下。 */
  readonly home: string;
  /** 兩層 `.env` 與行程繼承的快照。 */
  readonly launchEnv: LaunchEnvironment;
  /** 執行期重載失敗往哪裡講（一次）。省略即 stderr。 */
  readonly warn?: (line: string) => void;
}

/**
 * 建憑證服務。
 *
 * @param options - 見 {@link CredentialServiceOptions}。
 */
export function createCredentialService(options: CredentialServiceOptions): CredentialService {
  const file = join(options.home, CREDENTIALS_FILE);
  const warn = options.warn ?? ((line: string) => void process.stderr.write(line));
  /** 最後一份好的內容，與它是憑哪個 stat 讀來的。 */
  let good: { readonly signature: string; readonly refs: ReadonlyMap<string, string> } | undefined;
  /** 最後一次警告過的 stat 簽章：同一個壞檔只講一次。 */
  let warned: string | undefined;

  /** 讀（必要時重讀）受管檔。壞了：第一次拋，讀好過就保留最後一份並警告。 */
  function stored(): ReadonlyMap<string, string> {
    let signature: string;
    let mode: number;
    try {
      const info = statSync(file);
      mode = info.mode;
      signature = `${String(info.mtimeMs)}:${String(info.size)}:${String(info.ino)}:${String(info.mode)}`;
    } catch (error) {
      if (isMissing(error)) {
        good = undefined;
        return new Map();
      }
      throw error;
    }
    if (good?.signature === signature) return good.refs;
    try {
      assertOwnerOnlyMode('受管憑證檔', file, mode);
      const refs = parseCredentialsDocument(file, readFileSync(file, 'utf8'));
      good = { signature, refs };
      return refs;
    } catch (error) {
      if (good === undefined) throw error;
      if (warned !== signature) {
        warned = signature;
        warn(`credentials: 重載失敗，繼續用上一份可用的內容：${(error as Error).message}\n`);
      }
      return good.refs;
    }
  }

  return {
    resolve(name) {
      const inherited = options.launchEnv.get(name, ['process']);
      if (inherited !== undefined) return { value: inherited.value, source: 'env' };
      const value = stored().get(name);
      if (value !== undefined) return { value, source: 'file' };
      const dotenv = options.launchEnv.get(name, ['project-env', 'user-env']);
      if (dotenv !== undefined) {
        return {
          value: dotenv.value,
          source: dotenv.source === 'project-env' ? 'project-env' : 'user-env',
        };
      }
      return undefined;
    },
    check() {
      stored();
    },
  };
}

/**
 * 沒有啟動快照時的退路：只看給定環境（預設 `process.env`），**每次解析都重讀**。
 *
 * dsh 在沒掛憑證服務時同樣退回啟動環境（`llm-deepseek-api-key`）。eval／spike 之外的測試與嵌入方走這條。
 *
 * @param env - 環境，省略即 `process.env`。
 */
export function ambientCredentials(env: NodeJS.ProcessEnv = process.env): CredentialService {
  return {
    resolve(name) {
      const value = env[name];
      return value === undefined || value.length === 0 ? undefined : { value, source: 'env' };
    },
    check() {},
  };
}
