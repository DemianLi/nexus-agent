/**
 * 啟動環境：行程繼承的環境變數 > 目前資料夾的 `.env` > harness home 的 `.env`
 * （[#730](https://github.com/DemianLi/nexus-agent/issues/730)，整組照 dsh）。
 *
 * **逐條照 dsh** `packages/boot/app-boot/src/index.ts` 的 `loadLayeredEnv`（`477b4f4`）：
 *
 * - 兩份檔**都先讀、先檢查，都過了才套用**：一份被拒絕不能留下另一份已經套用的半套環境。
 * - 已經有值的名字不蓋（繼承的 > 目前資料夾 > home）；**還沒有值的名字會被寫進行程的環境變數**——
 *   不寫進去的只有之後的受管憑證檔（[#730](https://github.com/DemianLi/nexus-agent/issues/730) 的 B 段）。
 * - **會改變行程怎麼起、程式從哪裡載入、網路怎麼走的名字只准來自啟動環境**（{@link BOOTSTRAP_NAMES}）：
 *   出現在任一份 `.env` 就啟動失敗，訊息指名檔案與變數。一份 `.env` 會跟著複製下來的專案走，
 *   讓它改 `PATH` 或代理，等於讓一個專案決定你整個行程跑什麼、連到哪裡。
 *   代理那四個名字只有 harness home 那份可以設——那份是使用者自己的，不跟著專案走。
 * - 記下每個值來自哪一層（{@link LaunchEnvironment}），憑證服務要用。
 * - 讀 `.env` **不查權限**，同 dsh；要擋這件事的是之後的受管檔。
 *
 * ## 偏離 dsh（各一句）
 *
 * - dsh 擋 `DSH_` 開頭的名字，這裡換成 `NEXUS_AGENT_`（我們自己的變數，至少 `NEXUS_AGENT_HOME`）；
 *   `DEEPSEEK_BASE_URL` 那兩個是 dsh 自己的端點名，我們沒有，所以拿掉。
 * - dsh 的產品 CLI 一啟動就載入；這裡只在**真模型路徑**（`--live`、eval、spike）載入，
 *   因為沒接真模型的啟動以前就不讀任何 `.env`，靜靜開始讀會讓別的環境變數（追蹤那些）的行為跟著變。
 *
 * ## 舊位置
 *
 * 以前讀的是**程式碼資料夾根目錄**的 `.env`。`pnpm --filter` 起 `cli:live` 與 `serve:live` 時目前資料夾是
 * `apps/harness`，那個檔不會再被讀到。**不偷偷再讀舊位置當退路**（[docs/standards.md](../../../docs/standards.md)
 * 的「不得 fallback」）；也不能默默失效——舊檔還在、而需要的名字又沒有值時，直接失敗並指名搬去哪裡
 * （{@link LaunchEnvOptions.needs}）。
 *
 * @module
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

/** 一層的來源。 */
export type LaunchEnvSource = 'process' | 'project-env' | 'user-env';

/** 一層。`process` 沒有路徑。 */
export interface LaunchEnvLayer {
  readonly source: LaunchEnvSource;
  readonly path?: string;
  readonly values: Readonly<Record<string, string>>;
}

/** 一個名字的有效值與它來自哪一層。 */
export interface LaunchEnvEntry {
  readonly value: string;
  readonly source: LaunchEnvSource;
  readonly path?: string;
}

/** 這次啟動的環境快照：哪一層給了哪些值。**載入之後不再變**。 */
export interface LaunchEnvironment {
  /** 由高到低：繼承的、目前資料夾、home。 */
  readonly layers: readonly LaunchEnvLayer[];
  /**
   * 名字在允許的來源裡的有效值（先到先贏）。空字串算沒有，同 dsh 的憑證解析。
   *
   * @param name - 環境變數名。
   * @param sources - 只看這幾層；省略即全部。
   */
  get(name: string, sources?: readonly LaunchEnvSource[]): LaunchEnvEntry | undefined;
  /** 程式碼資料夾根目錄的舊 `.env`，還在的話。**沒有被讀**。 */
  readonly legacyEnvFile?: string;
}

/** 沒有任何 `.env` 可以設的名字。逐條照 dsh；`DEEPSEEK_*` 兩個換掉，見檔頭。 */
const BOOTSTRAP_NAMES = new Set([
  // 行程怎麼起、模組從哪裡載入。
  'PATH',
  'HOME',
  'USERPROFILE',
  'SHELL',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  // 直譯器啟動時的鉤子。
  'BASH_ENV',
  'ENV',
  'SHELLOPTS',
  'BASHOPTS',
  'PERL5OPT',
  'PERL5LIB',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'RUBYOPT',
  'RUBYLIB',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'PYTHONHOME',
  // 版本控制的鉤子、設定改道、環境裡用來選命令的名字。
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_EXTERNAL_DIFF',
  'GIT_PAGER',
  'GIT_EDITOR',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_COUNT',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'BROWSER',
  // 網路能到哪裡、信任誰。
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'NODE_TLS_REJECT_UNAUTHORIZED',
]);

/** 沒有任何 `.env` 可以設的名字前綴。dsh 的 `DSH_` 換成 `NEXUS_AGENT_`。 */
const BOOTSTRAP_PREFIXES = ['NEXUS_AGENT_', 'XDG_', 'DYLD_', 'BASH_FUNC_'];

/**
 * 只有 harness home 那份可以設的 bootstrap 名字。代理決定每個請求走哪條路，跟著專案複製下來的檔
 * 不該有這個權力；home 那份是使用者自己的，而 `NEXUS_AGENT_HOME` 本身是 bootstrap-only，
 * 所以沒有任何 `.env` 能搬動這個例外。CA 與 TLS 那幾個在兩份裡都照樣拒絕：它們改的是信任誰，不是往哪走。
 */
const HOME_LAYER_PROXY_NAMES = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']);

function isBootstrapOnly(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    BOOTSTRAP_NAMES.has(upper) || BOOTSTRAP_PREFIXES.some((prefix) => upper.startsWith(prefix))
  );
}

/** 程式碼資料夾根目錄的舊 `.env`。`import.meta.dirname` 是 `apps/harness/src`。 */
const LEGACY_ENV_FILE = resolve(import.meta.dirname, '../../../.env');

/** 讀一份 `.env` 但不套用。檔案不存在是正常的（回 `undefined`）；其他讀不了的原因走 `warn`。 */
function readEnvLayer(
  dir: string,
  isHome: boolean,
  home: string,
  warn: (line: string) => void,
): { readonly path: string; readonly values: Record<string, string> } | undefined {
  const path = resolve(dir, '.env');
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      warn(`launch-env: 讀不了 ${path}：${String(error)}\n`);
    }
    return undefined;
  }
  // 解析一次，檢查與套用用同一份條目。
  const values = parseEnv(content) as Record<string, string>;
  for (const name of Object.keys(values)) {
    if (!isBootstrapOnly(name)) continue;
    const proxyName = HOME_LAYER_PROXY_NAMES.has(name.toUpperCase());
    if (isHome && proxyName) continue;
    // 代理名字多一條出路，訊息要說。
    const remedy = proxyName
      ? `在啟動環境 export ${name}，或寫進 ${resolve(home, '.env')}（那份不會跟著專案複製）`
      : `請在啟動環境 export ${name}，不要寫進 .env`;
    throw new Error(
      `${path} 設了 "${name}"，這個名字只有啟動環境可以設` +
        '（它決定行程怎麼啟動、程式與指示從哪裡載入、或網路怎麼走）；' +
        remedy,
    );
  }
  return { path, values };
}

/** {@link loadLaunchEnv} 的參數。 */
export interface LaunchEnvOptions {
  /** 目前資料夾：它的 `.env` 是「專案」那一層。 */
  readonly cwd: string;
  /** 已解析的 harness home（`resolveHarnessHome`）：它的 `.env` 是「使用者」那一層。 */
  readonly home: string;
  /** 被套用的環境。省略即 `process.env`；測試傳自己的物件。 */
  readonly target?: NodeJS.ProcessEnv;
  /** 讀不了的檔往哪裡講。省略即 stderr。 */
  readonly warn?: (line: string) => void;
  /**
   * 這條路徑必須有值的名字。載入完仍然沒有值、而舊位置的 `.env` 還在時，**直接失敗**並指名搬去哪裡
   * ——不能默默失效，也不能偷偷再讀舊位置。
   */
  readonly needs?: string;
  /** 舊位置的檔案路徑。省略即程式碼資料夾根目錄的 `.env`；測試才傳。 */
  readonly legacyFile?: string;
}

/**
 * 載入兩層 `.env`，把還沒有值的名字寫進 `target`，回傳這次啟動的環境快照。
 *
 * @param options - 見 {@link LaunchEnvOptions}。
 * @throws 任一份 `.env` 設了只有啟動環境能設的名字；或需要的名字沒有值而舊位置還有檔。
 */
export function loadLaunchEnv(options: LaunchEnvOptions): LaunchEnvironment {
  const target = options.target ?? process.env;
  const warn = options.warn ?? ((line: string) => void process.stderr.write(line));
  const cwd = resolve(options.cwd);
  const home = resolve(options.home);
  const inherited = { ...target } as Record<string, string>;
  // 兩份都先讀、先檢查：被拒絕的不能留下另一份已經套用的半套。
  const project = readEnvLayer(cwd, cwd === home, home, warn);
  const user = cwd === home ? undefined : readEnvLayer(home, true, home, warn);
  for (const layer of [project, user]) {
    if (layer === undefined) continue;
    for (const [name, value] of Object.entries(layer.values)) {
      if (target[name] === undefined) target[name] = value;
    }
  }

  const layers: LaunchEnvLayer[] = [
    { source: 'process', values: inherited },
    ...(project === undefined ? [] : [{ source: 'project-env' as const, ...project }]),
    ...(user === undefined ? [] : [{ source: 'user-env' as const, ...user }]),
  ];
  const read = new Set([project?.path, user?.path]);
  const legacy = options.legacyFile ?? LEGACY_ENV_FILE;
  const legacyEnvFile = !read.has(legacy) && existsSync(legacy) ? legacy : undefined;
  const snapshot: LaunchEnvironment = Object.freeze({
    layers: Object.freeze(layers),
    ...(legacyEnvFile === undefined ? {} : { legacyEnvFile }),
    get(name: string, sources?: readonly LaunchEnvSource[]) {
      for (const layer of layers) {
        if (sources !== undefined && !sources.includes(layer.source)) continue;
        const value = layer.values[name];
        if (value !== undefined && value.length > 0) {
          return {
            value,
            source: layer.source,
            ...(layer.path === undefined ? {} : { path: layer.path }),
          };
        }
      }
      return undefined;
    },
  });

  const needs = options.needs;
  if (needs !== undefined && legacyEnvFile !== undefined && snapshot.get(needs) === undefined) {
    throw new Error(
      `缺少環境變數 ${needs}。舊位置 ${legacyEnvFile}（程式碼資料夾根目錄的 .env）已經不再讀取：` +
        `請把它搬到 ${resolve(home, '.env')}（使用者這一層，建議），` +
        `或目前資料夾的 ${resolve(cwd, '.env')}。`,
    );
  }
  return snapshot;
}
