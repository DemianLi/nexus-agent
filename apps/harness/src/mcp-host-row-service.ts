/**
 * `MCP_HOST_ROW_SERVICE` 的實作（#3000 E4b）：把外掛已經包過沙箱、解析好憑證的一列設定，換成宿主 `mcp/client` 的 `open` 收的 `server`。
 *
 * 實際的連線欄位交給 {@link hostHttpConnection} 與 {@link hostStdioConnection}（遮蔽、憑證檢查的規則只在那兩處）；這裡補三件它們不管的事：
 *
 * - 其餘的設定欄位（逾時、`failOnStartupError`、指引上限、重連）原樣帶，`approval` 不帶（宿主整列拒絕，核准閘門留在 TS）。
 * - stdio 的 `command` 不是路徑（例如沒被沙箱包裝的 `npx`）時照 `PATH` 找成絕對路徑，因為宿主不查 `PATH`。TS 自己連的那條路由 Node 查，換條路不能因此壞掉。
 * - stdio 的 `credentialEnv`：`env` 裡寫成 `{ credential }` 的那幾個名字，值是修過頭尾的憑證（兩條路對憑證的修剪一致，由 {@link hostStdioConnection} 核對）。
 *
 * @module
 */

import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import type { McpConfig, McpHostRowBuilder } from '@nexus/plugin-mcp';

import type { ResolvedCredential } from './credentials.js';
import { hostHttpConnection } from './mcp-host-http-row.js';
import { hostStdioConnection } from './mcp-host-stdio-row.js';

/** 沿 `PATH` 找可執行檔；有斜線的原樣，找不到也原樣（讓 {@link hostStdioConnection} 以「要絕對路徑」拒絕並指名它）。 */
export function resolveOnPath(
  command: string,
  pathVar: string | undefined = process.env.PATH,
): string {
  if (command.includes('/')) return command;
  for (const dir of (pathVar ?? '').split(delimiter)) {
    if (dir === '' || !dir.startsWith('/')) continue;
    const candidate = join(dir, command);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return command;
}

/** 外掛的憑證表（名字 → 值）換成 harness 那兩個函式收的形狀。 */
function asResolved(credentials: ReadonlyMap<string, string>): Map<string, ResolvedCredential> {
  return new Map(
    [...credentials].map(([name, value]) => [name, { value, source: 'env' as const }]),
  );
}

/**
 * @param config - 外掛驗過的設定，stdio 的 `command` 與 `args` 已照沙箱政策包過。
 * @param credentials - 解析好的憑證值，名字 → 值。
 * @returns 宿主 `open` 的 `server`。
 * @throws 憑證不合規則（`InvalidCredentialError`）、stdio 的 `command` 找不到絕對路徑；訊息不含憑證值。
 */
export function mcpHostRow(
  config: McpConfig,
  credentials: ReadonlyMap<string, string>,
): ReturnType<McpHostRowBuilder> {
  const resolved = asResolved(credentials);
  const { connection } = config;
  const common = {
    serverName: config.serverName,
    toolCallTimeoutMs: config.toolCallTimeoutMs,
    livenessTimeoutMs: config.livenessTimeoutMs,
    failOnStartupError: config.failOnStartupError,
    maxInstructionBytes: config.maxInstructionBytes,
    reconnect: config.reconnect,
    elicitation: config.elicitation,
  };
  if (connection.transport === 'http') {
    return {
      ...common,
      connection: hostHttpConnection({
        url: connection.url,
        ...(connection.headers !== undefined && { headers: connection.headers }),
        credentials: resolved,
      }),
    };
  }
  const env: Record<string, string> = {};
  const credentialEnv: Record<string, { credential: string; hit: ResolvedCredential }> = {};
  for (const [name, value] of Object.entries(connection.env ?? {})) {
    if (typeof value === 'string') {
      env[name] = value;
      continue;
    }
    const hit = resolved.get(value.credential);
    if (hit === undefined) throw new Error(`憑證 ${value.credential} 沒有解析到值`);
    env[name] = hit.value.trim();
    credentialEnv[name] = { credential: value.credential, hit };
  }
  return {
    ...common,
    connection: hostStdioConnection({
      command: resolveOnPath(connection.command),
      args: connection.args ?? [],
      ...(connection.cwd !== undefined && { cwd: connection.cwd }),
      env,
      credentialEnv,
    }),
  };
}
