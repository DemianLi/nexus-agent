/**
 * 設定裡的憑證引用（[#1989](https://github.com/DemianLi/nexus-agent/issues/1989)）：`connection.env` 與 `connection.headers` 的值
 * 可以寫 `{ credential: <名字> }`，建連線那一刻向宿主的 {@link MCP_CREDENTIALS_SERVICE} 要值、代入。
 *
 * - **值只存在交給 SDK transport 的連線選項裡**：`McpConfig`、池鍵字串、`label`、錯誤訊息都只帶名字。
 * - **解析是同步的**（{@link McpCredentials.resolve}）：`apply` 在取用池之前就解析完，池只拿到解析好的名字 → 值。
 * - **一份連線建立時抓住值**：重連用同一份解析好的值，不重新解析；值換了，池鍵裡的指紋跟著換，下一次取用連新的一份。
 * - 宿主沒有提供服務、名字沒有值、服務拋錯，都是這一列連不上（走 `failOnStartupError` 那條），訊息寫列、欄位與憑證名。
 *
 * @module
 */

import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { McpConfig } from './index.js';
import { createRedactor } from './redact.js';
import type { Redactor } from './redact.js';

/** 宿主交憑證服務的服務名。 */
export const MCP_CREDENTIALS_SERVICE = 'mcp:credentials';

/** 一把憑證代入到哪裡：stdio 子行程的環境變數，或 HTTP 的 header。宿主照它決定這個值收不收（#2667）。 */
export type McpCredentialUse = 'env' | 'header';

/**
 * 宿主的憑證服務：按名字給值，沒有就是 `undefined`；讀不到（例如受管檔權限不對）或值放不進 `use` 指的地方，就拋，訊息不帶值。
 * 給出來的值就是要代入的值，這一側不另外修剪或檢查。
 */
export interface McpCredentials {
  resolve(name: string, use: McpCredentialUse): string | undefined;
}

declare module '@nexus/core' {
  interface NexusServices {
    /** MCP 設定裡憑證引用的值從這裡來。見 {@link MCP_CREDENTIALS_SERVICE}。 */
    'mcp:credentials': McpCredentials;
  }
}

/** 憑證名的形狀：環境變數形狀，跟 harness 受管憑證檔的鍵同一條（`apps/harness/src/credentials.ts` 的 `CREDENTIAL_NAME_PATTERN`）。 */
export const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const credentialName = z
  .string()
  .regex(CREDENTIAL_REF_PATTERN, '憑證名要是環境變數形狀：[A-Za-z_][A-Za-z0-9_]*');

/** `connection.env` 的一個值：字串，或引用一把憑證。 */
export const envValueSchema = z.union([z.string(), z.strictObject({ credential: credentialName })]);

/** `connection.headers` 的一個值：字串，或引用一把憑證，代入時接在 `prefix`（例如 `'Bearer '`）後面。 */
export const headerValueSchema = z.union([
  z.string(),
  z.strictObject({ credential: credentialName, prefix: z.string().optional() }),
]);

/** 這一列引用到的憑證：名字 → 值。 */
export type ResolvedCredentials = ReadonlyMap<string, string>;

// eslint-disable-next-line no-restricted-syntax -- 唯讀的空表，沒有人寫進去
const NONE: ResolvedCredentials = new Map();

/** 這一列每一處引用：欄位路徑、憑證名與代入到哪裡。 */
function referencesOf(
  config: McpConfig,
): { readonly field: string; readonly name: string; readonly use: McpCredentialUse }[] {
  const connection = config.connection;
  const values = connection.transport === 'stdio' ? connection.env : connection.headers;
  const field = connection.transport === 'stdio' ? 'connection.env' : 'connection.headers';
  const use: McpCredentialUse = connection.transport === 'stdio' ? 'env' : 'header';
  return Object.entries(values ?? {}).flatMap(([key, value]) =>
    typeof value === 'string' ? [] : [{ field: `${field}.${key}`, name: value.credential, use }],
  );
}

/**
 * 解析這一列引用到的每一把憑證。沒有引用就不呼叫服務。
 *
 * @throws 服務缺席、名字沒有值、服務拋錯；訊息有列、欄位與憑證名，加上服務自己拋的錯（例如來源層），不含值。
 */
export function resolveCredentials(
  config: McpConfig,
  service: McpCredentials | undefined,
): ResolvedCredentials {
  const references = referencesOf(config);
  if (references.length === 0) {
    assertLiteralAuthorizationUsable(config, NONE);
    return NONE;
  }
  const values = new Map<string, string>();
  // 同一列的引用都是同一種 `use`（看 transport），所以照名字去重不會漏掉另一種檢查。
  for (const { field, name, use } of references) {
    if (values.has(name)) continue;
    const where = `MCP 伺服器 "${config.serverName}" 的 ${field} 引用的憑證 "${name}"`;
    if (service === undefined) throw new Error(`${where} 解析不了：這個入口沒有提供憑證服務`);
    let value: string | undefined;
    try {
      value = service.resolve(name, use);
    } catch (error) {
      throw new Error(`${where} 讀不到：${error instanceof Error ? error.message : String(error)}`);
    }
    if (value === undefined) throw new Error(`${where} 沒有值`);
    values.set(name, value);
  }
  assertLiteralAuthorizationUsable(config, values);
  return values;
}

/** 這一列直接寫成字串的 `Authorization`／`Proxy-Authorization` 太短，整列連不上（D359，理由見 {@link hostHeaders}）。 */
function assertLiteralAuthorizationUsable(
  config: McpConfig,
  credentials: ResolvedCredentials,
): void {
  const { connection } = config;
  if (connection.transport === 'stdio') return;
  try {
    hostHeaders(connection.headers ?? {}, credentials);
  } catch (error) {
    throw new Error(
      `MCP 伺服器 "${config.serverName}" 的 ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** 指紋的金鑰：行程內隨機、不落盤，池鍵裡的指紋因此換不回值。 */
const FINGERPRINT_KEY = randomBytes(32);

/** 解析出來的值的指紋（HMAC-SHA256，hex）；沒有引用是空字串。 */
export function credentialFingerprint(credentials: ResolvedCredentials): string {
  if (credentials.size === 0) return '';
  const entries = [...credentials].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHmac('sha256', FINGERPRINT_KEY).update(JSON.stringify(entries)).digest('hex');
}

/** 把 `env` 或 `headers` 換成實際的值；引用的值必須已在 `credentials` 裡。 */
export function substituted(
  values: Readonly<Record<string, string | { credential: string; prefix?: string | undefined }>>,
  credentials: ResolvedCredentials,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      if (typeof value === 'string') return [key, value];
      const resolved = credentials.get(value.credential);
      if (resolved === undefined) throw new Error(`憑證 "${value.credential}" 沒有先解析`);
      return [key, `${value.prefix ?? ''}${resolved}`];
    }),
  );
}

/** 網址的 query 值至少幾個 code point 才收（理由見 {@link queryValuesOf}）。 */
const MIN_QUERY_VALUE_CODE_POINTS = 8;

/**
 * 網址 query 要遮的值：整串、每個參數值的原樣（沒解碼）與解碼後（`URLSearchParams`，`+` 當空白），跟宿主 `secrets()`（`config.rs`）收的一樣，
 * 讓 server 只回顯值、換了參數順序、解碼或再編碼之後回顯都遮得掉。網址解析不了就沒有。
 *
 * **與宿主不同的一處：不到 {@link MIN_QUERY_VALUE_CODE_POINTS} 個 code point 的不收。** 宿主只在錯誤裡遮短值；這裡斷線判斷
 * （`isConnectionLost`）讀的是遮過的訊息，`v=2` 的 `2` 會把 `MCP error -32000` 切斷。代價：短的 query 值（多半是 `v=2`、`limit=10` 這類設定）
 * 回顯時不遮，整串的 `?…` 仍由 `withUrlScrubbing` 的整段比對遮。
 */
function queryValuesOf(url: string): string[] {
  let query: string;
  try {
    query = new URL(url).search.slice(1);
  } catch {
    return [];
  }
  if (query === '') return [];
  const raw = query.split('&').map((pair) => {
    const at = pair.indexOf('=');
    return at < 0 ? pair : pair.slice(at + 1);
  });
  const decoded = [...new URLSearchParams(query).values()];
  return [query, ...raw, ...decoded].filter(
    (value) => [...value].length >= MIN_QUERY_VALUE_CODE_POINTS,
  );
}

/**
 * 授權用的 header（小寫）：不分大小寫比對，設定裡直接寫成字串也當憑證（D359）。Rust 宿主的 `AUTHORIZATION_HEADERS`（`host/src/mcp/config.rs`）要與它同一份，
 * 兩邊各有一支測試對 `credentials-vectors.json` 的 `credentialHeaderNames`；加名字先改這裡與那一行。
 */
export const AUTHORIZATION_HEADER_NAMES = ['authorization', 'proxy-authorization'] as const;

const isAuthorizationHeader = (name: string): boolean =>
  (AUTHORIZATION_HEADER_NAMES as readonly string[]).includes(name.toLowerCase());

/** 一個 header 的整個值修過頭尾之後至少幾個 code point，直接寫的授權 header 才收；同憑證值的門檻（宿主 `MIN_VALUE_CODE_POINTS`）。 */
const MIN_LITERAL_AUTHORIZATION_CODE_POINTS = 8;

/** {@link hostHeaders} 的輸出：宿主 HTTP 列的 `headers` 與 `credentialHeaders`。 */
export interface HostHeaders {
  /** 代入之後的成品。字面值修過整個值的頭尾；憑證引用是 prefix 接上修過頭尾的憑證。 */
  readonly headers: Readonly<Record<string, string>>;
  /** 哪幾個 header 是憑證：名字 → prefix（沒有就 `''`）。 */
  readonly credentialHeaders: Readonly<Record<string, string>>;
}

/**
 * 設定的 `headers` 哪幾個是憑證，與代入之後各自的值（D359）。宿主的 HTTP 列（`credentialHeaders`）與
 * {@link redactorFor} 都從這裡拿，所以兩條路對「什麼算憑證」只有這一份判斷。
 *
 * - 憑證引用：算憑證，值是 `prefix` 接上修過頭尾（`String.prototype.trim`，同宿主 `check_value`）的憑證。
 * - 直接寫成字串的 `Authorization`／`Proxy-Authorization`：自動當憑證（prefix `''`，整個值）。其他字串 header 是字面值，不列。
 * - 字面值修整個值的頭尾，憑證引用只修憑證。宿主要求 prefix 之後那段與修過的相同、header 值裡不能有頭尾換行，所以這裡先修。
 *
 * @throws 直接寫的授權 header 整個值修完不到 {@link MIN_LITERAL_AUTHORIZATION_CODE_POINTS} 個 code point（含空的），或引用的憑證不在 `credentials` 裡（沒有先解析）；訊息只有欄位與名字，不含值。
 */
export function hostHeaders(
  headers: Readonly<Record<string, string | { credential: string; prefix?: string | undefined }>>,
  credentials: ResolvedCredentials,
): HostHeaders {
  const out: Record<string, string> = {};
  const credentialHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      out[name] = trimmed;
      if (!isAuthorizationHeader(name)) continue;
      if ([...trimmed].length < MIN_LITERAL_AUTHORIZATION_CODE_POINTS) {
        throw new Error(
          `connection.headers.${name} 直接寫成字串的授權 header，整個值修掉頭尾空白之後不到 ${MIN_LITERAL_AUTHORIZATION_CODE_POINTS} 個字元；請換成較長的值，或改用憑證引用`,
        );
      }
      credentialHeaders[name] = '';
      continue;
    }
    const resolved = credentials.get(value.credential);
    if (resolved === undefined) throw new Error(`憑證 "${value.credential}" 沒有先解析`);
    const prefix = value.prefix ?? '';
    out[name] = `${prefix}${resolved.trim()}`;
    credentialHeaders[name] = prefix;
  }
  return { headers: out, credentialHeaders };
}

/**
 * 這一份連線手上要遮的值（#2669）：每一把解析出來的憑證；{@link hostHeaders} 列為憑證的 header 的整個值（`prefix` 接憑證，連 prefix 一起遮成一段，
 * 與 Rust 宿主收整個 header 值一致）與 prefix 之後的憑證本身；`Authorization`、`Proxy-Authorization` 另收 scheme 後面那一段（server 常只回顯 token），
 * 切法同宿主：第一個空白之後、修掉頭尾空白。header 收修過頭尾的值（server 回顯的多半是修過的，`fetch` 只去掉 HTTP 空白），也收憑證服務給的原樣憑證值。
 *
 * header 與 env 只收**憑證**：憑證引用解出來的，與直接寫成字串的 `Authorization`／`Proxy-Authorization`（D359）；其他字面值不進來。
 * HTTP 網址的 query 值收（不到 8 個 code point 的不收，見 {@link queryValuesOf}）：token 就寫在網址裡，沒有引用。
 * 一份連線的值在建立時就定了（值換了，池鍵的指紋換、開的是另一份連線，各帶自己的遮蔽器），所以同一份連線的重連沿用同一組值。
 *
 * @throws 呼叫方要先跑過 {@link resolveCredentials}：它先擋掉直接寫的授權 header 太短與未解析的憑證引用，這裡才不會拋（同 {@link hostHeaders}）。
 */
export function redactorFor(config: McpConfig, credentials: ResolvedCredentials): Redactor {
  const values = new Set<string>(credentials.values());
  const { connection } = config;
  if (connection.transport !== 'stdio') {
    for (const value of queryValuesOf(connection.url)) values.add(value);
    const { headers, credentialHeaders } = hostHeaders(connection.headers ?? {}, credentials);
    for (const [name, prefix] of Object.entries(credentialHeaders)) {
      const whole = headers[name] ?? '';
      values.add(whole);
      values.add(whole.slice(prefix.length));
      if (isAuthorizationHeader(name)) {
        const afterScheme = /^\S*\s+([\s\S]*)$/u.exec(whole)?.[1]?.trim();
        if (afterScheme !== undefined && afterScheme !== '') values.add(afterScheme);
      }
    }
  }
  return createRedactor(values);
}
