/**
 * 寫入口在寫入前試掛一份清單（[#2073](https://github.com/DemianLi/nexus-agent/issues/2073)）：照 serve 啟動試組那一次
 * （`serve.ts` 的 `trial`）組一份、組完就收，交出哪幾列掉了。
 *
 * 寫入口是另一個行程，serve 那棵長壽的樹碰不到，所以在這個行程裡另建一棵用完即丟的樹：樹上的列在讀清單時掛上，
 * 相容層的列在組裝時跑 `apply`。不送模型請求；serve 裡跑著的 thread 不受影響。
 *
 * **MCP 列的第一次連線**（[#2125](https://github.com/DemianLi/nexus-agent/issues/2125)）：池帶 `firstAcquireWaitMs`，
 * 沒寫 `failOnStartupError` 的列最多等 `FIRST_CONNECT_WAIT_MS`（serve 等到落定），寫了的照 serve 等到落定；掉不掉跟 serve 一樣。
 *
 * **試組的環境不是 serve 的環境。** 旗標只拿得到呼叫端給的 `--patch` 與 `--workspace`；只在 serve 環境裡掉的列，這裡看不到，
 * 在 thread 組裝時才掉（`thread-plugin-list.ts`）。
 *
 * @module
 */

import { FIRST_CONNECT_WAIT_MS, McpConnectionPool } from '@nexus/plugin-mcp';

import { AssemblyDropError } from './agent-factory.js';
import { resolveWorkspaceRoot } from './assembly-root.js';
import { createCordisRoot, entryApprovalChannel } from './cordis-root.js';
import { createCredentialService } from './credentials.js';
import { resolveHarnessHome } from './harness-home.js';
import { processLaunchEnv } from './launch-env.js';
import { loadPluginConfig } from './plugin-config.js';
import type { ConfigEntry, PluginConfigSources, StartupDrop } from './plugin-config.js';
import { assemblyDropsOf, optionalEntriesOf, requiredIds } from './startup-audit.js';

/** 試組掉了的一列。 */
export interface TrialFailure {
  readonly id: string;
  readonly stage: StartupDrop['stage'];
  readonly message: string;
  /** 必掛的列（或組裝點判成不能少掛的）。 */
  readonly required: boolean;
  /** 樹上的列缺服務：等提供者出現就會起來，不算失敗。 */
  readonly pending: boolean;
  /** 那一列疊完的宣告；模組那一步就掉的列不在清單上，沒有。 */
  readonly declaration?: Pick<ConfigEntry, 'name' | 'config'>;
}

/** {@link trialMount} 的選項。 */
export interface TrialOptions {
  /** 讀 harness home 與憑證的環境。 */
  readonly env: NodeJS.ProcessEnv;
  /** serve 帶的 `--workspace`。 */
  readonly workspace?: string;
  /** `--workspace` 的解析基準。 */
  readonly cwd: string;
}

/**
 * 照 serve 啟動試組那一次組一份清單，組完就收。
 *
 * @param sources - 要試的那一份清單的來源。
 * @param options - 環境、`--workspace` 與它的解析基準。
 * @returns 掉了的列，讀清單那一步與組裝那一步合在一起。
 * @throws {PluginConfigError} 清單本身讀不了。
 * @throws 組裝點起不來，或組得起來卻收不乾淨（同 serve 試組）。
 */
export async function trialMount(
  sources: PluginConfigSources,
  options: TrialOptions,
): Promise<TrialFailure[]> {
  const { env, workspace, cwd } = options;
  const audit = { live: false };
  const contained = resolveWorkspaceRoot(workspace, cwd) !== undefined;
  const root = createCordisRoot({
    channel: entryApprovalChannel(undefined),
    ...(contained && { contained }),
  });
  const mcpPool = new McpConnectionPool({
    log: () => {},
    error: () => {},
    firstAcquireWaitMs: FIRST_CONNECT_WAIT_MS,
  });
  try {
    const loaded = await loadPluginConfig(sources, { tree: root.tree });
    const declarationOf = (id: string) => {
      const entry = loaded.entries.find((candidate) => candidate.id === id);
      return entry === undefined ? undefined : { name: entry.name, config: entry.config };
    };
    const required = requiredIds(audit);
    const failures: TrialFailure[] = loaded.dropped.map((drop) => ({
      id: drop.id,
      stage: drop.stage,
      message: drop.message,
      required: required.has(drop.id),
      // 讀清單這一步掉在 `requires` 的只有樹上的列：相容層的列到組裝時才檢查。
      pending: drop.stage === 'requires',
      ...(declarationOf(drop.id) !== undefined && { declaration: declarationOf(drop.id) }),
    }));
    const assembled = (drops: readonly StartupDrop[], fatal: ReadonlySet<string>) =>
      drops.map((drop) => ({
        id: drop.id,
        stage: drop.stage,
        message: drop.message,
        required: required.has(drop.id) || fatal.has(drop.id),
        pending: false,
        ...(declarationOf(drop.id) !== undefined && { declaration: declarationOf(drop.id) }),
      }));

    const assembly = await root.boot('serve', { plugins: loaded.plugins, cwd });
    const credentials = createCredentialService({
      home: resolveHarnessHome(env),
      launchEnv: processLaunchEnv(),
      store: true,
    });
    let trial;
    try {
      trial = await assembly.create(
        {
          live: false,
          ...(workspace !== undefined && { workspace }),
          credentials,
          optionalEntries: optionalEntriesOf(loaded, audit),
        },
        { session: { mcpPool } },
      );
    } catch (error) {
      if (!(error instanceof AssemblyDropError)) throw error;
      const fatal = new Set(
        error.dropped
          .filter(({ entry }) => error.fatal.has(entry))
          .map(({ drop }) => drop.origin.id),
      );
      return [...failures, ...assembled(assemblyDropsOf(loaded, error.dropped), fatal)];
    }
    await trial.dispose();
    return [...failures, ...assembled(assemblyDropsOf(loaded, trial.dropped), new Set())];
  } finally {
    await mcpPool.close();
    await root.dispose();
  }
}
