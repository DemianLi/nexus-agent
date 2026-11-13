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
  if (references.length === 0) return NONE;
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
  return values;
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

/**
 * 這一份連線手上要遮的值（#2669）：每一把解析出來的憑證；header 代入後的整個值（`prefix` 接憑證，連 prefix 一起遮成一段，與 Rust 宿主收整個
 * header 值一致）；`Authorization`、`Proxy-Authorization` 另收 scheme 後面那一段（server 常只回顯 token），切法同宿主：第一個空白之後、修掉頭尾空白。
 *
 * 只收**憑證引用**解出來的東西：設定裡直接寫的字串值不是憑證，不進來（宿主那邊分不出來才一律收，見 `docs/credentials-file.md`）。
 * 一份連線的值在建立時就定了（值換了，池鍵的指紋換、開的是另一份連線，各帶自己的遮蔽器），所以同一份連線的重連沿用同一組值。
 */
export function redactorFor(config: McpConfig, credentials: ResolvedCredentials): Redactor {
  if (credentials.size === 0) return createRedactor([]);
  const values = new Set<string>(credentials.values());
  const { connection } = config;
  if (connection.transport !== 'stdio') {
    for (const [name, value] of Object.entries(connection.headers ?? {})) {
      if (typeof value === 'string') continue;
      const resolved = credentials.get(value.credential);
      if (resolved === undefined) continue;
      const composed = `${value.prefix ?? ''}${resolved}`;
      values.add(composed);
      if (/^(?:proxy-)?authorization$/iu.test(name)) {
        const afterScheme = /^\S*\s+([\s\S]*)$/u.exec(composed)?.[1]?.trim();
        if (afterScheme !== undefined && afterScheme !== '') values.add(afterScheme);
      }
    }
  }
  return createRedactor(values);
}
