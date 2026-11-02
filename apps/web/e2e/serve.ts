import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * e2e 用的 serve（#1602 N1570）：子行程起真的 `apps/harness/src/serve.ts`，模型換成腳本提供者，網頁是 serve 自己供應的
 * 出貨 `dist/`（跟產品同源，cookie 照登入網址換）。
 *
 * - **子行程，不 import harness**：`@nexus/harness` 依賴 `@nexus/web`，反過來就成環；同行程起 serve 也要搬 harness 那一整套
 *   測試設定（模組解析、工具子行程與檔案鎖的 mock）。
 * - **腳本走 `--patch`**：形狀照 `apps/harness/src/settings/scripted-model.ts` 檔頭寫給部署方的那一份，跟 harness 的
 *   `scriptedPatchText` 同一個約定。
 * - **零憑證、零外部連線**：子行程的環境只有 `PATH` 與暫存的 `HOME`、`NEXUS_AGENT_HOME`，不繼承呼叫端的環境，key 進不來。
 */

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const SERVE = join(ROOT, 'apps', 'harness', 'src', 'serve.ts');
const TSCONFIG = join(ROOT, 'tsconfig.runtime.json');

/** 起動日誌裡帶登入 token 的那個網址。 */
const AUTHENTICATED_URL = /http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/;

/** 腳本的一輪，欄位照 `ScriptedTurn`（只列這裡用到的）。 */
export interface ScriptTurn {
  readonly content: string;
  readonly toolCalls?: readonly { readonly name: string; readonly args: Record<string, unknown> }[];
  readonly tokenDelayMs?: number;
}

export interface E2eServe {
  /** 帶登入 token 的網址，瀏覽器開它換到會話 cookie。 */
  readonly url: string;
  /** 收掉子行程與暫存目錄。 */
  close(): Promise<void>;
}

function patchText(turns: readonly ScriptTurn[]): string {
  return `- insert:
    - id: e2e-script
      name: '#settings/scripted-model'
      config: ${JSON.stringify({ turns })}
- id: agent-default-model
  config:
    provider: e2e-script
`;
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
 * @returns 登入網址與收尾函式。起不來（逾時或先結束）就拋，錯誤訊息帶起動日誌。
 */
export async function startE2eServe(turns: readonly ScriptTurn[]): Promise<E2eServe> {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-web-e2e-'));
  const patch = join(dir, 'script.patch.yml');
  await writeFile(patch, patchText(turns), 'utf8');
  const home = join(dir, 'home');
  const child = spawn(TSX, ['--tsconfig', TSCONFIG, SERVE, '--port', '0', '--patch', patch], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', HOME: home, NEXUS_AGENT_HOME: join(home, 'harness-home') },
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
        if (found !== null) {
          clearTimeout(timer);
          resolve(found[0]);
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`serve 起動中結束（exit ${String(code)}）：\n${log}`));
      });
    });
    return { url, close };
  } catch (error) {
    await close();
    throw error;
  }
}
