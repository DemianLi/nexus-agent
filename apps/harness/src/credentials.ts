/**
 * 憑證服務：按名字解析 key，順序**照 dsh，分兩邊**（[#730](https://github.com/DemianLi/nexus-agent/issues/730) 的 B 段、
 * [#1540](https://github.com/DemianLi/nexus-agent/issues/1540)）：
 *
 * - **serve（對應 dsh 的 Web profile）掛受管檔，而且它最優先**：受管檔 > 啟動環境 > 目前資料夾 `.env` > harness home `.env`。
 *   理由同 dsh `packages/credentials/credentials-local/src/index.ts:1-20`：使用者（管理者）明確存進受管檔的 key 必須一致生效，
 *   環境變數（CI、`EnvironmentFile=`、shell profile 替別的工具 export 的那一把）只在檔裡沒有值時才用。決策紀錄
 *   `.agents/notes/implemented/architecture/2026-10-09-stored-credential-precedence.md`，其中**否決**了「受管值蓋掉環境值時警告」，所以這裡
 *   也沒有執行期警告、沒有退回舊序的開關；起動時印一行來源（{@link describeKeySource}），對應 dsh `describe` 回報的 `source`。
 * - **一次性入口（CLI、eval、spike）對應 dsh 的 headless profile，不掛受管檔**：啟動環境 > 目前資料夾 `.env` > harness home `.env`，
 *   不 `stat`、不讀、不檢查受管檔，壞掉的受管檔也不擋。理由同 `2026-10-12-headless-environment-auth.md`：一次性任務自己帶進來的 key
 *   （`NVIDIA_API_KEY=… pnpm cli:live`）不該被共用 home 上的受管檔靜靜換掉。
 *
 * 兩邊都以 `store` 旗標區分，沒有預設值（{@link CredentialServiceOptions.store}）。
 *
 * 對照 dsh `packages/credentials/credentials-local` 與 `packages/llm/llm-deepseek-api-key`（`1517a4db`，條文引自 `687f282e` 的 clone）：
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
  /**
   * 那一層是哪個檔（`file` 是受管憑證檔、`project-env`／`user-env` 是那份 `.env`）；`env` 沒有。
   * 只給錯誤訊息指名「去哪裡改」用（#1541），不含值。
   */
  readonly path?: string;
}

/** 憑證服務。同步：受管檔很小，同步讀讓「建構時快速失敗」與「請求時再解析」用同一個函式。 */
export interface CredentialService {
  /** 這份服務有沒有掛受管檔。`false` 的入口不讀它（錯誤訊息據此指路，見 `missingKeyMessage`）。 */
  readonly store: boolean;
  /**
   * 按名字解析。
   *
   * @param name - 環境變數形狀的名字（例如 `NVIDIA_API_KEY`）。
   * @returns 第一個有非空值的層（`store` 時受管檔最先）；都沒有是 `undefined`。
   * @throws 受管檔第一次讀就壞了（權限、格式）。已經讀過一次好的，之後壞了保留最後一份並警告。沒掛受管檔時不會拋。
   */
  resolve(name: string): ResolvedCredential | undefined;
  /**
   * 啟動時完整檢查受管檔：權限、格式、內容。檔案不存在是正常的。沒掛受管檔（`store: false`）是空操作：不 `stat`、不讀。
   *
   * @throws 任何一項不過。
   */
  check(): void;
}

/**
 * 一把憑證的名字長什麼樣：環境變數形狀。受管檔 `refs` 的鍵與 `live-model` 的 `apiKeyEnv`（#1604）共用這一條，
 * 同 dsh `credentials/src/index.ts:19` 的 `REF_PATTERN`。
 */
export const CREDENTIAL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

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
    if (!CREDENTIAL_NAME_PATTERN.test(name))
      return fail(`refs 的鍵 "${name}" 不是環境變數形狀的名字`);
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
  /**
   * 掛不掛受管檔。**沒有預設值**（呼叫端要明說自己是哪一邊）：`true` 是 serve，受管檔最優先；`false` 是一次性入口，
   * 完全不碰受管檔。
   */
  readonly store: boolean;
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
  const { store } = options;
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
    store,
    resolve(name) {
      // 受管檔最優先（serve）；一次性入口整格跳過，連 `stat` 都不做。
      if (store) {
        const value = stored().get(name);
        if (value !== undefined) return { value, source: 'file', path: file };
      }
      const inherited = options.launchEnv.get(name, ['process']);
      if (inherited !== undefined) return { value: inherited.value, source: 'env' };
      const dotenv = options.launchEnv.get(name, ['project-env', 'user-env']);
      if (dotenv !== undefined) {
        return {
          value: dotenv.value,
          source: dotenv.source === 'project-env' ? 'project-env' : 'user-env',
          ...(dotenv.path === undefined ? {} : { path: dotenv.path }),
        };
      }
      return undefined;
    },
    check() {
      if (store) stored();
    },
  };
}

/**
 * 起動時講「這一把 key 來自哪一層」的那一行（[#1540](https://github.com/DemianLi/nexus-agent/issues/1540) Q2 (a)）：
 * 只有名字與來源，**不含值的任何片段**。一次性入口（沒掛受管檔）的那一行寫明「此入口不讀受管檔」，讓人看得出為什麼 serve 用的 key 在這裡沒生效。
 * 還沒有任何一層有值時回 `undefined`：缺 key 由 `createLiveModel` 當場失敗並指名缺哪一個，這裡不重複。
 *
 * @param credentials - 這次啟動的憑證服務。
 * @param name - 變數名字。
 * @returns 一行話（不帶時間或前綴，呼叫端自己加）；沒有值是 `undefined`。
 */
export function describeKeySource(
  credentials: CredentialService,
  name: string,
): string | undefined {
  const hit = credentials.resolve(name);
  if (hit === undefined) return undefined;
  const from =
    hit.source === 'file'
      ? `受管檔 ${hit.path ?? ''}`.trimEnd()
      : hit.source === 'env'
        ? '啟動環境'
        : `${hit.path ?? (hit.source === 'project-env' ? '目前資料夾的 .env' : 'harness home 的 .env')}`;
  return `${name}：來自${from}${credentials.store ? '' : '（此入口不讀受管檔）'}`;
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
    store: false,
    resolve(name) {
      const value = env[name];
      return value === undefined || value.length === 0 ? undefined : { value, source: 'env' };
    },
    check() {},
  };
}
