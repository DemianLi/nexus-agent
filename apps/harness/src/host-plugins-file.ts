/**
 * 宿主的插件清單 `host-plugins.json`（[#2570](https://github.com/DemianLi/nexus-agent/issues/2570) E4a）：整份由 harness 在
 * 啟動器換成監督行程之前產生，管理者不手改。宿主只在起來時讀它，所以每次啟動都照當下的環境重寫。
 *
 * - **只有一列 `mcp`，環境有設才有**：`NODE_EXTRA_CA_CERTS` 指的檔是宿主唯一信任的根（宿主不讀系統根，也不讀別的來源）。
 *   沒設就沒有那一列，檔案寫成 `[]`，宿主不掛 MCP 插件。`NODE_EXTRA_CA_CERTS` 是 `launch-env.ts` 的 bootstrap 名字，`.env`
 *   本來就設不了，所以只看行程環境不會漏掉哪一層。
 * - **代理跟著那一列**：同一份環境用 TS 那邊同一個 `resolveProxyPolicy` 解，有代理才寫 `proxy`。只看行程環境：啟動器跑在
 *   `.env` 載入之前，home 的 `.env` 設的代理 TS 這邊生效、宿主這邊不會（見升級指南 `host-plugins-generated`）。
 * - **整份覆寫**：舊檔裡的列（包括管理者手寫的）不保留；原子替換，權限 0600（代理網址可能帶帳密）。
 *
 * @module
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { resolveProxyPolicy } from '@nexus/core';

import { processLaunchEnv } from './launch-env.js';

/** 宿主 `mcp` 插件的 `proxy`：宿主 `ProxyPolicy::parse` 收的形狀，`source` 不寫。 */
export interface HostProxyConfig {
  readonly httpProxy?: string;
  readonly httpsProxy?: string;
  readonly noProxy: string;
}

/** 清單的一列：宿主 `host/plugins.rs` 收的形狀。 */
export interface HostPluginRow {
  readonly name: 'mcp';
  readonly config: { readonly roots: string; readonly proxy?: HostProxyConfig };
}

/**
 * @param env - 啟動器看到的環境。
 * @param cwd - 相對路徑照它解成絕對路徑：宿主的工作目錄不是啟動器的。
 * @returns 要寫進清單的列；`NODE_EXTRA_CA_CERTS` 沒設（或只有空白）是空陣列。
 */
export function hostPluginRows(
  env: NodeJS.ProcessEnv,
  cwd: string = process.cwd(),
): readonly HostPluginRow[] {
  const roots = env.NODE_EXTRA_CA_CERTS?.trim();
  if (roots === undefined || roots === '') return [];
  const { policy } = resolveProxyPolicy(processLaunchEnv(env));
  const proxy: HostProxyConfig | undefined =
    policy.source === 'none'
      ? undefined
      : {
          ...(policy.httpProxy !== undefined && { httpProxy: policy.httpProxy }),
          ...(policy.httpsProxy !== undefined && { httpsProxy: policy.httpsProxy }),
          noProxy: policy.noProxy,
        };
  return [
    { name: 'mcp', config: { roots: resolve(cwd, roots), ...(proxy !== undefined && { proxy }) } },
  ];
}

/**
 * 把清單寫到 `path`（整份取代）。
 *
 * @param path - 通常是 `<home>/host-plugins.json`；它的目錄要已經存在。
 * @param rows - {@link hostPluginRows} 的結果。
 * @throws 寫不進去（權限、磁碟）。暫存檔不留。
 */
export function writeHostPluginsFile(path: string, rows: readonly HostPluginRow[]): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}
