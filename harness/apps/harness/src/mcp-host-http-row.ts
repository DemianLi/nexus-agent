/**
 * 一台 HTTP MCP server 交給宿主（`harness/native/sandbox-spawner/host`，#2570 D2b）的那一段 `connection`。
 *
 * 宿主只收成品：`headers` 是代入之後的字串，`credentialHeaders`（header 名 → prefix）標出哪幾個是憑證。**只有這些進宿主的遮蔽器**，
 * 沒標的是字面值，不遮。哪幾個是憑證由 `@nexus/plugin-mcp` 的 `hostHeaders` 判斷（`redactorFor` 用同一個函式，兩條路只有一份判斷）：
 *
 * - 憑證引用：值是 `prefix` 接上憑證；憑證照 {@link assertUsableMcpCredential} 檢查（修頭尾空白、不到 8 個字元拒收），交出去的是修過的。
 * - 直接寫成字串的 `Authorization`／`Proxy-Authorization`（D359）：自動列為憑證，prefix 是 `''`，整個值照同一套規則檢查。
 * - 其他字串 header 是字面值：整個值修掉頭尾空白再送（宿主不收頭尾有換行的 header 值，TS 外掛自己連的那條路收得下，不修就會「換一條路就壞」）。
 *
 * @module
 */

import { hostHeaders } from '@nexus/plugin-mcp';

import type { ResolvedCredential } from './credentials.js';
import { assertUsableMcpCredential } from './mcp-credential.js';

/** 設定裡 `connection.headers` 的一個值：字串，或引用一把憑證，接在 `prefix` 後面。 */
export type McpHostHeaderValue = string | { readonly credential: string; readonly prefix?: string };

/** {@link hostHttpConnection} 的輸入。 */
export interface McpHostHttpInput {
  /** 網址，原樣交給宿主驗。 */
  readonly url: string;
  /** 設定的 `headers`，憑證引用還沒代入。 */
  readonly headers?: Readonly<Record<string, McpHostHeaderValue>>;
  /** `headers` 引用到的憑證：名字 → 憑證服務解析到的那一筆。每個引用都要有。 */
  readonly credentials: ReadonlyMap<string, ResolvedCredential>;
}

/** 交給宿主的 `connection`：宿主 `mcp::config` 的 http 那一支。 */
export interface McpHostHttpConnection {
  readonly transport: 'http';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly credentialHeaders: Readonly<Record<string, string>>;
}

/**
 * @param input - 見 {@link McpHostHttpInput}。
 * @returns 宿主收的 `connection`；沒有 header 時 `headers` 與 `credentialHeaders` 都是 `{}`。
 * @throws 引用的憑證不在 `credentials` 裡、憑證值不合 {@link assertUsableMcpCredential}（`InvalidCredentialError`），或直接寫成字串的授權 header 不合同一套規則；訊息不含值。
 */
export function hostHttpConnection(input: McpHostHttpInput): McpHostHttpConnection {
  const headers = input.headers ?? {};
  const checked = new Map<string, string>();
  for (const value of Object.values(headers)) {
    if (typeof value === 'string' || checked.has(value.credential)) continue;
    const hit = input.credentials.get(value.credential);
    if (hit === undefined) throw new Error(`憑證 ${value.credential} 沒有解析到值`);
    checked.set(value.credential, assertUsableMcpCredential(value.credential, hit, 'header'));
  }
  const out = hostHeaders(headers, checked);
  for (const [name, prefix] of Object.entries(out.credentialHeaders)) {
    // 憑證引用在上面檢查過了；這裡補的是直接寫成字串的授權 header 的字元規則（header 放不下的字元）。空的與不到 8 個字元已由 `hostHeaders` 先擋。
    if (typeof headers[name] !== 'string') continue;
    try {
      assertUsableMcpCredential(
        name,
        { value: (out.headers[name] ?? '').slice(prefix.length), source: 'env' },
        'header',
      );
    } catch {
      throw new Error(
        `connection.headers.${name} 直接寫成字串的授權 header 含有 HTTP header 放不下的字元（換行、NUL 等控制字元，或 U+00FF 之後的字元）；請改用憑證引用，或換成合規的值`,
      );
    }
  }
  return {
    transport: 'http',
    url: input.url,
    headers: out.headers,
    credentialHeaders: out.credentialHeaders,
  };
}
