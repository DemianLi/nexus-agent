import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * e2e 用的 serve（#1602）：子行程起真的 `apps/harness/src/serve.ts`，模型換成腳本提供者，網頁是 serve 自己供應的
 * 出貨 `dist/`（跟產品同源，cookie 照登入網址換）。
 *
 * - **子行程，不 import harness**：`@nexus/harness` 依賴 `@nexus/web`，反過來就成環；同行程起 serve 也要搬 harness 那一整套
 *   測試設定（模組解析、工具子行程與檔案鎖的 mock）。
 * - **腳本走 `--patch`**：`insert` 一列 `#settings/scripted-model`，再把 `agent-default-model` 指過去，跟
 *   `apps/harness/src/scripted-serve.ts` 的 `scriptedPatchText` 同一個約定（照上一條不 import 它）。腳本欄位見
 *   `apps/harness/src/settings/scripted-model.ts` 檔頭。呼叫方可在前面多接幾列（`extraRows`）。
 * - **零憑證**：子行程的環境只有 `PATH` 與暫存的 `HOME`、`NEXUS_AGENT_HOME`，不繼承呼叫端的環境；cwd 與 home 都是暫存目錄，
 *   讀不到任何 `.env`，key 進不來。模型是行程內的腳本，不打模型端點。
 * - **行程模型**：跑 e2e 的環境設了 `NEXUS_E2E_PROCESS_MODEL=per-thread` 就用 per-thread 起（#2341，只在 Linux
 *   起得來），監督行程的路徑由 `NEXUS_SUPERVISOR_BIN` 給。兩個都在這一端讀，不傳進子行程，見 {@link e2eServeInvocation}。
 */

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const SERVE = join(ROOT, 'apps', 'harness', 'src', 'serve.ts');
const TSCONFIG = join(ROOT, 'tsconfig.runtime.json');

/** 起動日誌裡帶登入 token 的那個網址。 */
const AUTHENTICATED_URL = /http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/;

/**
 * patch 的約定跟 harness 對不上時 serve 照樣起得來：找不到的列印一行跳過，模型退回出廠那份腳本（同樣是假模型）。
 * 起動日誌裡有這行就拋，紅在起服務這一步，不是後面等不到回覆的逾時。
 */
const SKIPPED_PATCH = /patch：找不到[^\n]*/;
/** 起動日誌裡說用哪顆模型的那一行。沒帶 `--live` 時一律是假模型，所以它只擋得住誤帶 `--live`；patch 的 id 對不上由 `SKIPPED_PATCH` 擋。 */
const MODEL_LINE = /模型：(\S+)/;
const SCRIPTED_MODEL = '假模型（ScriptedChatModel）';

/** 腳本的一輪，欄位照 `ScriptedTurn`（只列這裡用到的）。 */
export interface ScriptTurn {
  readonly content: string;
  readonly toolCalls?: readonly { readonly name: string; readonly args: Record<string, unknown> }[];
  readonly tokenDelayMs?: number;
}

export interface E2eServe {
  /** 帶登入 token 的網址，瀏覽器開它換到會話 cookie。 */
  readonly url: string;
  /** serve 的 home（`NEXUS_AGENT_HOME`），例如嵌入方的服務憑證檔建在這裡。 */
  readonly home: string;
  /** 收掉子行程與暫存目錄。 */
  close(): Promise<void>;
}

function scriptRows(turns: readonly ScriptTurn[]): string {
  return `- insert:
    - id: e2e-script
      name: '#settings/scripted-model'
      config: ${JSON.stringify({ turns })}
- id: agent-default-model
  config:
    provider: e2e-script
`;
}

/** 起 serve 的命令列參數（`tsx` 之後的部分）、patch 檔的內容，與起動之前要不要先建 home。 */
export interface E2eServeInvocation {
  readonly args: readonly string[];
  readonly patch: string;
  readonly createHome: boolean;
}

/**
 * 組出 {@link startE2eServe} 起 serve 用的東西，環境由呼叫端傳進來。
 *
 * - `NEXUS_E2E_PROCESS_MODEL` 沒設或是空字串：不加旗標、不動 `process-model` 那一列（出廠 `single`）；有 `prepareHome` 才先建 home。
 * - `per-thread`：加 `--process-model per-thread`，patch 最前面改 `process-model` 那一列，`supervisorBinary` 是 `NEXUS_SUPERVISOR_BIN`
 *   （旗標不收路徑）。沒給 `NEXUS_SUPERVISOR_BIN` 就拋，不退回 harness 的 `findSupervisorBinary`（`apps/harness/src/process-launcher.ts`）。home 一律先建（`0700`）。
 * - 其他值拋錯。
 */
export function e2eServeInvocation(options: {
  readonly turns: readonly ScriptTurn[];
  readonly extraRows: string;
  readonly prepareHome: boolean;
  readonly patchPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): E2eServeInvocation {
  const base = ['--tsconfig', TSCONFIG, SERVE, '--port', '0', '--patch', options.patchPath];
  const rows = `${options.extraRows}${scriptRows(options.turns)}`;
  const model = options.env.NEXUS_E2E_PROCESS_MODEL ?? '';
  if (model === '') return { args: base, patch: rows, createHome: options.prepareHome };
  if (model !== 'per-thread') {
    throw new Error(
      `NEXUS_E2E_PROCESS_MODEL 只認 per-thread（或不設），收到 ${JSON.stringify(model)}`,
    );
  }
  const supervisor = options.env.NEXUS_SUPERVISOR_BIN ?? '';
  if (supervisor === '') {
    throw new Error(
      'NEXUS_E2E_PROCESS_MODEL=per-thread 要同時設 NEXUS_SUPERVISOR_BIN（監督行程執行檔的絕對路徑）',
    );
  }
  return {
    args: [...base, '--process-model', 'per-thread'],
    patch: `- id: process-model
  config:
    mode: per-thread
    supervisorBinary: ${JSON.stringify(supervisor)}
${rows}`,
    createHome: true,
  };
}

function exited(child: ChildProcess): Promise<void> {
  return child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once('exit', () => resolve()));
}

/**
 * 起一台 serve，模型是這份腳本。腳本每條 thread 從第一輪開始吃。
 *
 * @param turns - 腳本。
 * @param extraRows - 接在腳本前面的 patch 列（YAML 頂層清單項目，換行結尾），例如改 `host-tools` 那一列。
 * @param prepareHome - serve 起動之前在它的 home 裡放檔，例如嵌入身分對應表。目錄已經建好。
 * @returns 登入網址、serve 的 home 與收尾函式。起不來（逾時或先結束）、patch 有列沒套上、或模型不是腳本就拋，錯誤訊息帶起動日誌。
 *   `NEXUS_E2E_PROCESS_MODEL` 不是 `per-thread`／空，或 per-thread 卻沒給 `NEXUS_SUPERVISOR_BIN`，也拋（見 {@link e2eServeInvocation}）。
 */
export async function startE2eServe(
  turns: readonly ScriptTurn[],
  extraRows = '',
  prepareHome?: (home: string) => Promise<void>,
): Promise<E2eServe> {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-web-e2e-'));
  const patch = join(dir, 'script.patch.yml');
  let invocation: E2eServeInvocation;
  try {
    invocation = e2eServeInvocation({
      turns,
      extraRows,
      prepareHome: prepareHome !== undefined,
      patchPath: patch,
      env: process.env,
    });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  await writeFile(patch, invocation.patch, 'utf8');
  const home = join(dir, 'home');
  const harnessHome = join(home, 'harness-home');
  if (invocation.createHome) await mkdir(harnessHome, { recursive: true, mode: 0o700 });
  await prepareHome?.(harnessHome);
  const child = spawn(TSX, invocation.args, {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', HOME: home, NEXUS_AGENT_HOME: harnessHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const close = async (): Promise<void> => {
    child.kill('SIGTERM');
    await exited(child);
    await rm(dir, { recursive: true, force: true });
  };
  let log = '';
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`serve 60 秒內沒起來：\n${log}`)), 60_000);
      const onData = (chunk: Buffer): void => {
        log += chunk.toString('utf8');
        const found = AUTHENTICATED_URL.exec(log);
        const model = MODEL_LINE.exec(log);
        if (found === null || model === null) return;
        clearTimeout(timer);
        const skipped = SKIPPED_PATCH.exec(log);
        if (skipped !== null) reject(new Error(`patch 有列沒套上（${skipped[0]}）：\n${log}`));
        else if (model[1] !== SCRIPTED_MODEL) {
          reject(new Error(`serve 起來了，模型卻不是腳本（${model[1]}）：\n${log}`));
        } else resolve(found[0]);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`serve 起動中結束（exit ${String(code)}）：\n${log}`));
      });
    });
    return { url, home: harnessHome, close };
  } catch (error) {
    await close();
    throw error;
  }
}
