/**
 * 憑證服務：按名字解析 key，分兩邊（[#730](https://github.com/DemianLi/nexus-agent/issues/730) 的 B 段、
 * [#1540](https://github.com/DemianLi/nexus-agent/issues/1540)）：
 *
 * - **serve 掛受管檔，而且它最優先**：受管檔 > 啟動環境 > 目前資料夾 `.env` > harness home `.env`。
 *   使用者（管理者）明確存進受管檔的 key 必須一致生效，環境變數（CI、`EnvironmentFile=`、shell profile 替別的工具 export 的那一把）
 *   只在檔裡沒有值時才用。受管值蓋掉環境值時不警告、也沒有退回舊序的開關；起動時印一行來源（{@link describeKeySource}）。
 * - **一次性入口（CLI、eval、spike）不掛受管檔**：啟動環境 > 目前資料夾 `.env` > harness home `.env`，
 *   不 `stat`、不讀、不檢查受管檔，壞掉的受管檔也不擋：一次性任務自己帶進來的 key
 *   （`NVIDIA_API_KEY=… pnpm cli:live`）不該被共用 home 上的受管檔靜靜換掉。
 *
 * 兩邊都以 `store` 旗標區分，沒有預設值（{@link CredentialServiceOptions.store}）。
 *
 * 受管檔的格式、拒絕與警告的規則、重讀、權限都寫在 `docs/credentials-file.md`（Rust 端照同一份），與 dsh 的對照也在那裡。
 * 這裡只記程式要守的幾件事：
 *
 * - **`refs` 裡面**一律拒絕、不跳過：被靜靜忽略的條目讀起來就是「我存的憑證沒作用」。
 *   **`version`、`refs` 之外的頂層鍵不擋啟動**，解析器把鍵名與行號交回呼叫端，{@link createCredentialService} 經 `warn` 講一聲，
 *   **只講個數與行號，不印鍵名也不印值**。`records` 照舊拒絕：nexus 沒有這種憑證，放過它會讓人以為存進去的東西有作用。
 * - **錯誤訊息不引原文**：YAML 解析器自己的訊息會把出錯那一行帶出來，而那一行是秘密。
 * - **讀之前先查權限**：group 或 other 有任何權限位元就拒絕，訊息帶 `chmod 600`（`owner-only.ts`，與瀏覽器會話密鑰檔共用）。
 *   還沒有寫入路徑（沒有設定頁，手動編輯）。
 * - **內容從不寫進行程的環境變數**：跟兩層 `.env`（`launch-env.ts`，會寫）不同，這是受管檔存在的意義。
 *   它擋得住子行程「順手繼承」，擋不住以同一個使用者身分跑的 agent。
 * - **值只在請求當下解析**：模型的 `configuration.apiKey` 是函式，每次請求前呼叫（`live-model.ts`）。
 *   重讀靠「每次解析先 `stat`，簽章變了才重讀」，不監看檔案；呼叫了 {@link CredentialService.check} 的入口（serve 帶 `--live`）啟動時完整檢查、
 *   壞了就起不來，執行期重讀失敗保留最後一份可用內容並警告。
 * - 服務是一個函式庫物件，由入口建、往下傳，不放進 `registry.services`：消費者只有模型那兩顆，不需要 plugin 也能取得它。
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Document,
  isCollection,
  isMap,
  isPair,
  LineCounter,
  Pair,
  Parser,
  parseDocument,
  YAMLMap,
  type YAMLError,
} from 'yaml';

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
  /** 模型服務拒絕了憑證（[#2267](https://github.com/DemianLi/nexus-agent/issues/2267)）。原文可能帶部分金鑰，往外拋的錯只有固定句，這裡是唯一留原文的地方。 */
  reportRejected(line: string): void;
  /** 換掉 {@link reportRejected} 的去處，預設是 stderr。serve 的日誌比憑證服務晚建好，所以是事後接。 */
  onRejected(sink: (line: string) => void): void;
}

function rejectionChannel(): Pick<CredentialService, 'reportRejected' | 'onRejected'> {
  let sink = (line: string): void => void process.stderr.write(`${line}\n`);
  return {
    reportRejected: (line) => sink(line),
    onRejected: (next) => {
      sink = next;
    },
  };
}

/**
 * 一把憑證的名字長什麼樣：環境變數形狀。受管檔 `refs` 的鍵與 `live-model` 的 `apiKeyEnv`（#1604）共用這一條。
 */
export const CREDENTIAL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** 不引原文的 YAML 錯誤描述：只有錯誤碼與位置。 */
function describeYamlError(error: YAMLError, lines: LineCounter): string {
  const at = lines.linePos(error.pos[0]);
  return `${error.code}（第 ${String(at.line)} 行第 ${String(at.col)} 欄）`;
}

/** 受管檔不收的 CST token → 拒絕時的錯誤碼。 */
const FORBIDDEN_TOKENS: ReadonlyMap<string, string> = new Map([
  ['directive', 'DIRECTIVE_NOT_ALLOWED'],
  ['tag', 'TAG_NOT_ALLOWED'],
  ['anchor', 'ANCHOR_NOT_ALLOWED'],
  ['alias', 'ALIAS_NOT_ALLOWED'],
]);

/**
 * 第一個指令（`%YAML`、`%TAG`、不認得的 `%…`）、明示 tag（`!!str`、`!!binary`、`!foo`、`!`、`!<…>`）、
 * 錨點（`&x`）或別名（`*x`）的位置與錯誤碼。
 *
 * 一律拒絕，不看 `yaml` 有沒有發 warning：`!!str`、`!!binary` 是認得的 tag，不發任何 warning 就把值換掉（`!!binary` 變成位元組），
 * `%YAML 1.1` 換了 schema（`yes` 變成 `true`）；錨點名字收哪些字元各家實作不同，別名展開還要防別名炸彈。
 * 受管檔只放 `名字: 值`，用不到這幾樣；Rust 端照同一份樣本，也就不必實作它們。
 *
 * 從 CST 找，不從文字找：值、引號、區塊值、註解裡的 `!`、`%`、`&`、`*` 不是 token，不會誤判。
 */
function forbiddenToken(
  text: string,
): { readonly code: string; readonly offset: number } | undefined {
  let found: { readonly code: string; readonly offset: number } | undefined;
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const { type, offset } = node as { type?: unknown; offset?: unknown };
    const code = typeof type === 'string' ? FORBIDDEN_TOKENS.get(type) : undefined;
    if (typeof offset === 'number' && code !== undefined) {
      // 走訪順序不保證照檔案順序：取最前面那一個。
      if (found === undefined || offset < found.offset) found = { code, offset };
      return;
    }
    for (const value of Object.values(node)) walk(value);
  };
  for (const token of new Parser().parse(text)) walk(token);
  return found;
}

/** mapping 與序列加起來最多幾層，根的那一個是第 1 層（`docs/credentials-file.md`〈形狀〉）。 */
export const CREDENTIALS_MAX_DEPTH = 64;

/**
 * 解析之前就拒絕的字元：NUL、tab、不接 LF 的 CR、不在開頭的 U+FEFF。這幾種 `yaml` 與 Rust 宿主的 `saphyr-parser` 各自解讀
 * （照收、當換行或當錯），同一份檔兩條路會讀出不同的結果；要放 tab 的值用雙引號寫成 `\t`。
 */
function forbiddenCharacter(text: string): number | undefined {
  const at = /\0|\t|\r(?!\n)|(?<!^)\uFEFF/u.exec(text);
  return at?.index;
}

/**
 * 最深的巢狀層數，與第一個集合鍵（`? [a]`、`{a: 1}: …`）的位置。用自己的堆疊走，不遞迴：檔案再深也不會撐爆呼叫堆疊。
 * 集合鍵一律拒絕：`yaml` 把它字串化成名字的寫法，別的實作照不出來。
 */
function shapeOf(document: Document): { readonly depth: number; readonly collectionKey?: number } {
  let depth = 0;
  let collectionKey: number | undefined;
  const stack: (readonly [unknown, number])[] = [[document.contents, 0]];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const [node, level] = next;
    if (!isCollection(node)) continue;
    depth = Math.max(depth, level + 1);
    for (const item of node.items) {
      if (isPair(item)) {
        if (isCollection(item.key)) {
          const offset = item.key.range?.[0] ?? 0;
          if (collectionKey === undefined || offset < collectionKey) collectionKey = offset;
        }
        stack.push([item.key, level + 1], [item.value, level + 1]);
      } else {
        stack.push([item, level + 1]);
      }
    }
  }
  return collectionKey === undefined ? { depth } : { depth, collectionKey };
}

/** `yaml` 解得太深時，組文件或 `toJS()` 會用光呼叫堆疊。 */
function isStackOverflow(error: unknown): boolean {
  return error instanceof RangeError;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** {@link parseCredentialsDocument} 的結果。 */
export interface ParsedCredentialsDocument {
  /** `refs`：名字 → 值。 */
  readonly refs: ReadonlyMap<string, string>;
  /** `version`、`refs` 之外的頂層鍵名（照檔案裡的順序）。留在檔案裡、不解析出任何東西，由呼叫端決定怎麼講。 */
  readonly ignoredKeys: readonly string[];
  /** {@link ignoredKeys} 各在第幾行，順序一一對應。給訊息用：訊息只講行，不印鍵名。 */
  readonly ignoredLines: readonly number[];
}

/** mapping 裡的一個條目：轉成 JS 之後的鍵名、鍵在第幾行第幾欄、值的節點。 */
interface MappingEntry {
  readonly name: string;
  readonly line: number;
  readonly col: number;
  readonly value: unknown;
}

/** 位置的說法，跟 {@link describeYamlError} 同一個格式。 */
function at(entry: MappingEntry): string {
  return `第 ${String(entry.line)} 行第 ${String(entry.col)} 欄`;
}

/**
 * 一個 mapping 節點的條目，照檔案順序；不是 mapping 就是 `undefined`。
 *
 * 鍵名用 `yaml` 自己 `toJS()` 的換算（只放這一個鍵的 mapping 轉一次），所以 `true` 與 `"true"`、`1` 與 `"1"` 換出同一個名字。
 */
function mappingEntries(
  document: Document,
  lines: LineCounter,
  node: unknown,
): MappingEntry[] | undefined {
  if (!isMap(node)) return undefined;
  return node.items.map((pair) => {
    const single = new YAMLMap(document.schema);
    single.items.push(new Pair(pair.key, null));
    const [name = ''] = Object.keys(single.toJS(document) as object);
    const offset = (pair.key as { range?: [number, number, number] } | null)?.range?.[0] ?? 0;
    const { line, col } = lines.linePos(offset);
    return { name, line, col, value: pair.value };
  });
}

/**
 * 解析一份受管檔的文字。
 *
 * 空檔、只有註解的檔、空的 mapping（`{}`）都是空的倉庫，不要求 `version`。
 *
 * @param file - 只用在訊息裡。
 * @param text - 檔案內容。
 * @returns `refs`：名字 → 值；`ignoredKeys`／`ignoredLines`：不認得、但不擋的頂層鍵名與各自的行號，照檔案順序。
 * @throws 不合格的內容；**訊息不含任何值，也不含鍵名**（#2667）：要指到某個鍵或 YAML 錯誤時只講行欄，因為鍵名的位置可能被誤貼了 key。
 */
export function parseCredentialsDocument(file: string, text: string): ParsedCredentialsDocument {
  const fail = (why: string): never => {
    throw new Error(`受管憑證檔 ${file} 認不得：${why}`);
  };
  const empty: ParsedCredentialsDocument = { refs: new Map(), ignoredKeys: [], ignoredLines: [] };
  if (text.trim() === '') return empty;
  const lines = new LineCounter();
  const yamlAt = (code: string, offset: number): never => {
    const { line, col } = lines.linePos(offset);
    return fail(`YAML 錯誤 ${code}（第 ${String(line)} 行第 ${String(col)} 欄）`);
  };
  const tooDeep = (): never =>
    fail(`YAML 錯誤 NESTING_TOO_DEEP（mapping 與序列最多 ${String(CREDENTIALS_MAX_DEPTH)} 層）`);
  const character = forbiddenCharacter(text);
  if (character !== undefined) {
    // 還沒解析，LineCounter 是空的：自己數行。
    const line = text.slice(0, character).split('\n').length;
    const col = character - text.lastIndexOf('\n', character - 1);
    fail(`YAML 錯誤 CHARACTER_NOT_ALLOWED（第 ${String(line)} 行第 ${String(col)} 欄）`);
  }
  let document: Document;
  try {
    document = parseDocument(text, {
      uniqueKeys: true,
      prettyErrors: false,
      lineCounter: lines,
      // 集合鍵在 `toJS()` 裡被字串化時，`yaml` 預設經 `process.emitWarning` 把整個鍵印出來；鍵名可能是誤貼的 key。
      logLevel: 'error',
    });
  } catch (error) {
    if (isStackOverflow(error)) return tooDeep();
    throw error;
  }
  const [problem] = document.errors;
  if (problem !== undefined) fail(`YAML 錯誤 ${describeYamlError(problem, lines)}`);
  const shape = shapeOf(document);
  if (shape.depth > CREDENTIALS_MAX_DEPTH) tooDeep();
  const forbidden = forbiddenToken(text);
  if (forbidden !== undefined) yamlAt(forbidden.code, forbidden.offset);
  if (shape.collectionKey !== undefined) yamlAt('COLLECTION_KEY_NOT_ALLOWED', shape.collectionKey);
  // 只有註解的文件 `toJS()` 是 `null`：當空的倉庫。
  const root: unknown = document.toJS() ?? {};
  if (typeof root !== 'object' || Array.isArray(root)) {
    return fail('根要是一個 mapping（version 與 refs）');
  }
  const record = root as Record<string, unknown>;
  if (Object.keys(record).length === 0) return empty;
  const top = uniqueEntries(mappingEntries(document, lines, document.contents) ?? [], fail);
  if (record.version !== CREDENTIALS_DOCUMENT_VERSION) {
    return fail(`version 要是 ${String(CREDENTIALS_DOCUMENT_VERSION)}`);
  }
  if ('records' in record) {
    return fail(
      'nexus 沒有 records 這種憑證（只有 refs 底下的 名字: 值）；留著它會讓人以為存進去的東西有作用',
    );
  }
  const refs = record.refs ?? {};
  if (refs === null || typeof refs !== 'object' || Array.isArray(refs)) {
    return fail('refs 要是 mapping（名字: 值）');
  }
  const values = refs as Record<string, unknown>;
  const refsNode = top.find((entry) => entry.name === 'refs')?.value;
  const out = new Map<string, string>();
  for (const entry of uniqueEntries(mappingEntries(document, lines, refsNode) ?? [], fail)) {
    const { name } = entry;
    if (!CREDENTIAL_NAME_PATTERN.test(name)) {
      return fail(
        `refs ${at(entry)}的鍵不是環境變數形狀的名字（長 ${String([...name].length)} 個字元；鍵名不印出，以免誤貼在這裡的 key 進日誌）`,
      );
    }
    const value = values[name];
    // 不引值：連型別都只說「不是字串」。
    if (typeof value !== 'string') return fail(`refs ${at(entry)}那一把要是字串`);
    if (value.length === 0) {
      return fail(`refs ${at(entry)}那一把是空字串（要移除一把憑證就刪掉那一行，不要留空）`);
    }
    out.set(name, value);
  }
  const ignored = top.filter((entry) => entry.name !== 'version' && entry.name !== 'refs');
  return {
    refs: out,
    ignoredKeys: ignored.map((entry) => entry.name),
    ignoredLines: ignored.map((entry) => entry.line),
  };
}

/**
 * 換成同一個名字的兩個鍵，後一個會在 `toJS()` 裡靜靜蓋掉前一個（`true` 與 `"true"`、`1` 與 `"1"`）。
 * `yaml` 的 `uniqueKeys` 比的是同一個節點或純量的值，型別不同就算不同；這裡照名字再比一次，同樣講成 `DUPLICATE_KEY`（#2667）。
 */
function uniqueEntries(entries: MappingEntry[], fail: (why: string) => never): MappingEntry[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) fail(`YAML 錯誤 DUPLICATE_KEY（${at(entry)}）`);
    seen.add(entry.name);
  }
  return entries;
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
  /** 最後一次警告過的原因（stat 簽章，或 `stat:<錯誤碼>`）：同一個原因連續只講一次，讀成功就清掉。 */
  let warned: string | undefined;

  /**
   * 這一次讀不成：還沒讀好過就拋；讀好過就保留最後一份並警告，同一個原因只講一次。
   *
   * @param key - 去重用的鍵：權限、讀檔、解析失敗是 stat 簽章；`stat` 本身失敗是 `stat:<code>`（那時沒有簽章）。
   */
  function keepLastGood(error: unknown, key: string): ReadonlyMap<string, string> {
    if (good === undefined) throw error;
    if (warned !== key) {
      warned = key;
      warn(`credentials: 重載失敗，繼續用上一份可用的內容：${(error as Error).message}\n`);
    }
    return good.refs;
  }

  /** 讀（必要時重讀）受管檔。壞了（含 `stat` 本身失敗）：還沒讀好過就拋，讀好過就保留最後一份並警告。 */
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
      return keepLastGood(error, `stat:${String((error as NodeJS.ErrnoException | null)?.code)}`);
    }
    if (good?.signature === signature) {
      warned = undefined;
      return good.refs;
    }
    let parsed: ParsedCredentialsDocument;
    try {
      assertOwnerOnlyMode('受管憑證檔', file, mode);
      parsed = parseCredentialsDocument(file, readFileSync(file, 'utf8'));
    } catch (error) {
      return keepLastGood(error, signature);
    }
    good = { signature, refs: parsed.refs };
    warned = undefined;
    // 這是一份好檔：多出來的頂層鍵不擋、不算重載失敗。同一份 stat 簽章在上面就回快取了，所以每份檔只講一次。
    // 只講個數與行號，不印鍵名也不印值（#2667）：鍵名的位置可能被誤貼了 key。
    if (parsed.ignoredKeys.length > 0) {
      warn(
        `credentials: 受管憑證檔 ${file} 有 ${String(parsed.ignoredKeys.length)} 個不認得的頂層鍵（第 ${parsed.ignoredLines.map(String).join('、')} 行），已略過；只有 version 與 refs 底下的憑證會生效\n`,
      );
    }
    return parsed.refs;
  }

  return {
    store,
    ...rejectionChannel(),
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
 * eval／spike 之外的測試與嵌入方走這條。
 *
 * @param env - 環境，省略即 `process.env`。
 */
export function ambientCredentials(env: NodeJS.ProcessEnv = process.env): CredentialService {
  return {
    store: false,
    ...rejectionChannel(),
    resolve(name) {
      const value = env[name];
      return value === undefined || value.length === 0 ? undefined : { value, source: 'env' };
    },
    check() {},
  };
}
