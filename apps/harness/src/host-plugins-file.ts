/**
 * 宿主的插件清單 `host-plugins.json`（[#2570](https://github.com/DemianLi/nexus-agent/issues/2570) E4a）：整份由 harness 在
 * 啟動器換成監督行程之前產生，管理者不手改。宿主只在起來時讀它，所以每次啟動都照當下的環境重寫。
 *
 * - **一律一列 `mcp`**：`NODE_EXTRA_CA_CERTS` 指的檔是宿主唯一信任的根（宿主不讀系統根，也不讀別的來源），有設才帶 `roots`。
 *   沒設也要有這一列：stdio、以及直連或走 http 代理的 http MCP server 不需要根，宿主沒掛插件，per-thread 就整條沒有 MCP。沒帶 `roots` 時宿主不信任任何
 *   https 憑證：網址是 https 的 server、要走 https 代理的 http server 都連不上，錯誤訊息點名 `NODE_EXTRA_CA_CERTS`。`NODE_EXTRA_CA_CERTS` 是 `launch-env.ts` 的
 *   bootstrap 名字，`.env` 本來就設不了，所以只看行程環境不會漏掉哪一層。
 * - **代理跟著那一列**：用 TS 那邊同一個 `resolveProxyPolicy` 解，有代理才寫 `proxy`。解的是啟動器交來的分層啟動環境
 *   （行程環境、home 的 `.env`；帶 `--live` 才讀 `.env`），跟 serve 為模型請求裝代理時看的是同一份（D364）。
 * - **整份覆寫**：舊檔裡的列（包括管理者手寫的）不保留；原子替換，權限 0600（代理網址可能帶帳密）。
 *
 * @module
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { resolveProxyPolicy } from '@nexus/core';

import { processLaunchEnv, type LaunchEnvironment } from './launch-env.js';

/** 宿主 `mcp` 插件的 `proxy`：宿主 `ProxyPolicy::parse` 收的形狀，`source` 不寫。 */
export interface HostProxyConfig {
  readonly httpProxy?: string;
  readonly httpsProxy?: string;
  readonly noProxy: string;
}

/** 清單的一列：宿主 `host/plugins.rs` 收的形狀。 */
export interface HostPluginRow {
  readonly name: 'mcp';
  readonly config: { readonly roots?: string; readonly proxy?: HostProxyConfig };
}

/**
 * @param env - 啟動器看到的行程環境；`NODE_EXTRA_CA_CERTS` 只看這裡。
 * @param cwd - 相對路徑照它解成絕對路徑：宿主的工作目錄不是啟動器的。
 * @param launchEnv - 解代理用的分層啟動環境；省略是只有 `env` 那一層。
 * @returns 要寫進清單的列：一列 `mcp`；`NODE_EXTRA_CA_CERTS` 沒設（或只有空白）就不帶 `roots`。
 */
export function hostPluginRows(
  env: NodeJS.ProcessEnv,
  cwd: string = process.cwd(),
  launchEnv: LaunchEnvironment = processLaunchEnv(env),
): readonly HostPluginRow[] {
  const roots = env.NODE_EXTRA_CA_CERTS?.trim();
  const { policy } = resolveProxyPolicy(launchEnv);
  const proxy: HostProxyConfig | undefined =
    policy.source === 'none'
      ? undefined
      : {
          ...(policy.httpProxy !== undefined && { httpProxy: policy.httpProxy }),
          ...(policy.httpsProxy !== undefined && { httpsProxy: policy.httpsProxy }),
          noProxy: policy.noProxy,
        };
  return [
    {
      name: 'mcp',
      config: {
        ...(roots !== undefined && roots !== '' && { roots: resolve(cwd, roots) }),
        ...(proxy !== undefined && { proxy }),
      },
    },
  ];
}

/**
 * 把清單寫到 `path`（整份取代）。
 *
 * @param path - 通常是 `<home>/host-plugins.json`；它的目錄要已經存在。
 * @param rows - {@link hostPluginRows} 的結果。
 * @throws 寫不進去（權限、磁碟、目標是目錄）：訊息以「寫不了宿主的插件清單」開頭並指名檔案。暫存檔不留。
 */
export function writeHostPluginsFile(path: string, rows: readonly HostPluginRow[]): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw new Error(
      `寫不了宿主的插件清單 ${path}：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
