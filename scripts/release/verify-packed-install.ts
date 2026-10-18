/**
 * 在 repo 外解開打好的 tarball，用純 `node` 驗它「解開即用」（[#1502](https://github.com/DemianLi/nexus-agent/issues/1502) 刀 3，C083）。
 *
 * 照 dsh `scripts/release/verify-packed-install.ts` 的形狀，但依卡上 Q1：**安裝時不連 registry**（理由 2：完全內網）。
 * dsh 的安裝驗證會為外部相依連 registry（`verify-packed-install.ts:6-7`）；這裡產物是 `pnpm deploy --prod` 的完整閉包，
 * 解開之後**不再跑任何 install**，所以整個流程沒有一步會連 registry——缺的東西只會在下面幾件事裡現形：
 *
 * 1. `.sha256` 與 tarball 對得上（等同 `sha256sum -c`）；
 * 2. 解開的樹過靜態檢查（`payload.ts` 的三道：拒收 `src/`／`.map`、出貨清單每列解析得到、相依圖完整）；
 * 3. `lib/serve.js --version` 等於產物版本，stderr 是空的；
 * 4. 目標平台的 `node-addon-system` 載得起來（flock 的原生二進位，#1503／會話租約都靠它）；
 * 5. 假模型跑一輪 `lib/cli.js`：會話 header 的 `build.commit` 等於戳記——已安裝的樹沒有 git，戳記是唯一的來源（PM 補驗收）；
 *    戳記本身也查：`commit` 是非空字串、`dirty` 是 `false`（本機驗沒 commit 的改動加 `--allow-dirty`，CI 不加）；
 * 6. 起一次 `lib/serve.js --port 0`：印出網址、首頁 200 且是網頁 index、安裝樹裡沒有 pnpm／tsx 行程、`SIGTERM` 後 exit 0。
 *
 * 子行程環境清掉 `NODE_OPTIONS`、`NODE_PATH`、`TSX_TSCONFIG_PATH`，`NEXUS_AGENT_HOME`／`HOME` 指進暫存目錄，`cwd` 在 repo 外。
 * 不論成敗，暫存目錄一律收掉。放 `/var/tmp`（不放 `os.tmpdir()`：那裡有暫存目錄規則會干擾，見 smoke-built-bin）。
 *
 * 步驟 3 到 6 的判斷都是輸入子行程結果、輸出 problems 的純函式（`versionProblems` 等），單元測試在
 * `apps/harness/src/verify-packed-install.test.ts`（#1666）。serve 以自己的行程群組起，逾時 `SIGKILL` 送整個群組。
 *
 * 用法：`pnpm run release:verify-packed-install <tarball> [--expect-commit <sha>] [--allow-dirty]`。
 *
 * @module
 */

import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';

import { fileSha256 } from './pack.js';
import {
  collectClosureViolations,
  collectPayloadViolations,
  walkInstalledGraph,
} from './payload.js';

/** 乾淨的子行程環境：宿主的 tsx hook、NODE_PATH 都不能替產物補洞。 */
export function cleanEnv(home: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    'NODE_OPTIONS',
    'NODE_PATH',
    'TSX_TSCONFIG_PATH',
    'NVIDIA_API_KEY',
    // 遙測關掉：宿主上若設了，驗證用的假模型日誌會送出去。dsh 在同一個位置設 `DSH_TELEMETRY_DISABLED = '1'`
    // （`scripts/release/verify-packed-install.ts:44`）；我們的遙測只有這一個開關，沒有就是關，所以清掉它。
    'NEXUS_OTLP_LOGS_URL',
  ]) {
    delete env[key];
  }
  return {
    ...env,
    HOME: home,
    NEXUS_AGENT_HOME: join(home, '.nexus-agent'),
    NVIDIA_API_KEY: 'verify-fake-key',
  };
}

/** 核對 `.sha256`（`<hash>  <檔名>`）。 */
export function checksumProblems(tarball: string): string[] {
  const sumFile = `${tarball}.sha256`;
  if (!existsSync(sumFile)) return [`缺 ${basename(sumFile)}`];
  const [expected, name] = readFileSync(sumFile, 'utf8').trim().split(/\s+/u);
  const actual = fileSha256(tarball);
  const problems: string[] = [];
  if (name !== basename(tarball))
    problems.push(`.sha256 記的檔名是 ${String(name)}，tarball 是 ${basename(tarball)}`);
  if (expected !== actual)
    problems.push(`sha256 對不上：.sha256 寫 ${String(expected)}，實際 ${actual}`);
  return problems;
}

/** 一個子行程的結果：只留判斷要用的三格，好讓每一步的判斷能脫離真的子行程單獨測。 */
export interface CommandOutcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** 戳記（`build-stamp.json`）的形狀；欄位型別不信，由 {@link stampProblems} 查。 */
export interface BuildStampShape {
  readonly commit?: unknown;
  readonly dirty?: unknown;
}

/** 步驟 3：`lib/serve.js --version` 印出產物版本，stderr 是空的。 */
export function versionProblems(run: CommandOutcome, expected: string): string[] {
  if (run.status !== 0 || run.stdout.trim() !== expected) {
    return [
      `--version 要印 ${expected}：exit ${String(run.status)}，stdout ${JSON.stringify(run.stdout)}，stderr ${JSON.stringify(run.stderr)}`,
    ];
  }
  if (run.stderr !== '') return [`--version 的 stderr 不是空的：${JSON.stringify(run.stderr)}`];
  return [];
}

/** 步驟 4：目標平台的 flock 原生二進位載得起來、拿得到鎖。 */
export function nativeLockProblems(run: CommandOutcome): string[] {
  if (run.status !== 0 || run.stdout.trim() !== 'locked') {
    return [`目標平台的 flock 原生二進位拿不到鎖：${run.stderr.slice(-400)}`];
  }
  return [];
}

/**
 * 戳記本身：commit 是非空字串，`dirty` 是 `false`。
 *
 * 卡上的戳記是 `{ commit, dirty: false }`。CI 的 checkout 是乾淨的，所以 `dirty` 不是 `false`
 * 就代表打包流程弄髒了樹（或戳記被改過）。本機驗一份沒 commit 的改動時用 `allowDirty`。
 * 戳記檔不在由 `collectPayloadViolations` 報（`stamp` 為 `undefined` 時這裡不重複報）。
 */
export function stampProblems(
  stamp: BuildStampShape | undefined,
  options: { allowDirty?: boolean } = {},
): string[] {
  if (stamp === undefined) return [];
  const problems: string[] = [];
  if (typeof stamp.commit !== 'string' || stamp.commit === '') {
    problems.push(`戳記的 commit 要是非空字串：${JSON.stringify(stamp.commit)}`);
  }
  if (stamp.dirty === true && options.allowDirty === true) return problems;
  if (stamp.dirty !== false) {
    problems.push(
      `戳記的 dirty 要是 false，實際 ${JSON.stringify(stamp.dirty)}：打包時工作樹不乾淨（本機驗沒 commit 的改動請加 --allow-dirty）`,
    );
  }
  return problems;
}

/** 步驟 5a：假模型跑一輪 `lib/cli.js` 要成功。 */
export function cliRunProblems(run: CommandOutcome): string[] {
  if (run.status !== 0) {
    return [`lib/cli.js 假模型跑一輪失敗（exit ${String(run.status)}）：${run.stderr.slice(-400)}`];
  }
  return [];
}

/**
 * 步驟 5b：會話 header 的 `build.commit` 等於戳記（以及 CI 給的打包 commit）。
 *
 * @param header - `cli.header.json` 解開的內容；檔不在傳 `undefined`。
 * @param stamp - 產物的戳記。
 * @param expectCommit - 打包的 commit（CI 給 `GITHUB_SHA`）。給了，header 就要等於它，
 *   而不只是等於產物自己的戳記——戳記被拿掉時兩邊同時不見，只比戳記會漏。
 */
export function headerProblems(
  header: { build?: { commit?: string | null } } | undefined,
  stamp: BuildStampShape | undefined,
  expectCommit?: string,
): string[] {
  if (header === undefined) return ['cli 跑完沒有 cli.header.json'];
  const problems: string[] = [];
  const actual = header.build?.commit;
  const stampCommit = typeof stamp?.commit === 'string' ? stamp.commit : undefined;
  const wanted = expectCommit ?? stampCommit;
  if (wanted === undefined) {
    problems.push('產物沒有戳記，也沒給 --expect-commit：header 的 build.commit 無從比對');
  } else if (actual !== wanted) {
    problems.push(
      `會話 header 的 build.commit 是 ${JSON.stringify(actual)}，要等於 ${expectCommit === undefined ? '戳記' : '打包的 commit'}的 ${wanted}`,
    );
  }
  if (stampCommit !== undefined && actual !== stampCommit) {
    problems.push(
      `會話 header 的 build.commit（${JSON.stringify(actual)}）不等於戳記的 ${stampCommit}`,
    );
  }
  return problems;
}

/** 步驟 6a：serve 的輸出裡要有網址；有插件載不起來也算壞（serve 只印警告照常起）。 */
export function serveOutputProblems(output: string, url: string | undefined): string[] {
  const problems: string[] = [];
  if (url === undefined) {
    problems.push(`serve 沒印出網址（或逾時）：${JSON.stringify(output.slice(-800))}`);
  }
  const unloadable = output.split('\n').filter((line) => line.includes('載不起來'));
  if (unloadable.length > 0)
    problems.push(`有插件載不進來：${JSON.stringify(unloadable.slice(0, 3))}`);
  return problems;
}

/**
 * 步驟 6b：token 交換（303＋set-cookie）與帶 cookie 的首頁（200 且像網頁 index）。
 *
 * @param exchange - 第一次打網址的結果。
 * @param home - 帶 cookie 打首頁的結果；token 交換失敗時沒有。
 */
export function homepageProblems(
  exchange: { status: number; cookie: string | undefined },
  home: { status: number; body: string } | undefined,
): string[] {
  if (exchange.status !== 303 || exchange.cookie === undefined) {
    return [`token 交換失敗：${String(exchange.status)}`];
  }
  if (home === undefined) return ['token 交換成功但沒有打首頁'];
  if (home.status !== 200) return [`首頁回 ${String(home.status)}，要 200`];
  if (!/<div id="root"|<script[^>]+type="module"/u.test(home.body)) {
    return [`首頁 200 但不像網頁 index：${JSON.stringify(home.body.slice(0, 200))}`];
  }
  return [];
}

/** 步驟 6c：`SIGTERM` 之後 serve 要 exit 0。 */
export function shutdownProblems(code: number | null, output: string): string[] {
  if (code !== 0) {
    return [`SIGTERM 後 exit ${String(code)}，要 0：${JSON.stringify(output.slice(-600))}`];
  }
  return [];
}

/** 整個行程群組送訊號：serve 自己起的子行程跟著走，不留孤兒。群組已經不在（`ESRCH`）不算錯。 */
export function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/**
 * 目前有哪些行程的命令列帶著這個目錄且是 pnpm／tsx。
 *
 * `ps` 不存在、逾時或非 0 退出時回 `problem`，**不拋錯**：呼叫端把它記成一條失敗，serve 子行程照常被收掉。
 *
 * @param dir - 暫存目錄。
 * @returns 找到的行程命令列；或 `problem`（`ps` 本身沒跑成）。
 */
export function strayProcesses(dir: string): { lines: string[]; problem?: string } {
  const result = spawnSync('ps', ['-A', '-o', 'command='], { encoding: 'utf8', timeout: 10_000 });
  if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== 'string') {
    const reason = result.error?.message ?? `exit ${String(result.status)}`;
    return { lines: [], problem: `ps 沒跑成，無從查安裝樹裡有沒有 pnpm／tsx 行程：${reason}` };
  }
  return {
    lines: result.stdout
      .split('\n')
      .filter((line) => line.includes(dir) && /(^|[\s/])(pnpm|tsx)([\s/]|$)/u.test(line)),
  };
}

/**
 * 驗一份 tarball。
 *
 * @param tarball - tarball 路徑，旁邊要有 `.sha256`。
 * @param options - `expectCommit`：打包的 commit（CI 給 `GITHUB_SHA`）。給了，header 的 `build.commit` 就要等於它，
 *   而不只是等於產物自己的戳記——戳記被拿掉時兩邊同時不見，只比戳記會漏。`allowDirty`：戳記的 `dirty` 是 `true` 也放行，
 *   只給本機驗沒 commit 的改動用，CI 不給。
 * @returns 失敗訊息；空陣列代表通過。
 */
export async function verifyPackedInstall(
  tarball: string,
  options: { expectCommit?: string; allowDirty?: boolean } = {},
): Promise<string[]> {
  const problems: string[] = [];
  problems.push(...checksumProblems(tarball));
  if (problems.length > 0) return problems;

  const platform = `${process.platform}-${process.arch}`;
  const scratch = mkdtempSync(
    join(existsSync('/var/tmp') ? '/var/tmp' : tmpdir(), 'verify-packed-install-'),
  );
  try {
    const extract = join(scratch, 'extract');
    const home = join(scratch, 'home');
    const work = join(scratch, 'work');
    for (const dir of [extract, home, work]) mkdirSync(dir, { recursive: true });
    execFileSync('tar', ['-xzf', tarball, '-C', extract], { timeout: 300_000 });
    const [top] = readdirSync(extract);
    if (top === undefined) return ['tarball 解開是空的'];
    const root = join(extract, top);
    const env = cleanEnv(home);

    // 2. 靜態檢查（對解開後的樹再來一次，不是只信打包當下）。
    for (const violation of collectPayloadViolations(root, { nativeSuffix: platform })) {
      problems.push(`${violation.path}：${violation.message}`);
    }
    for (const violation of collectClosureViolations(root)) {
      problems.push(`${violation.path}：${violation.message}`);
    }
    const graph = walkInstalledGraph(root);
    problems.push(...graph.missing.map((chain) => `相依圖缺：${chain}`));

    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      version: string;
    };
    const stampPath = join(root, 'build-stamp.json');
    const stamp = existsSync(stampPath)
      ? (JSON.parse(readFileSync(stampPath, 'utf8')) as BuildStampShape)
      : undefined;
    problems.push(...stampProblems(stamp, options));

    // 3. --version
    const version = spawnSync(process.execPath, [join(root, 'lib/serve.js'), '--version'], {
      cwd: work,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    problems.push(...versionProblems(version, manifest.version));

    // 4. 原生二進位載得起來，而且真的拿得到鎖（`importing alone does not load it`：要呼叫一次才會載 .node）。
    const lockProbe =
      "import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock';\n" +
      "import { openSync, closeSync } from 'node:fs';\n" +
      `const fd = openSync(${JSON.stringify(join(scratch, 'probe.lock'))}, 'w');\n` +
      "await tryLockExclusive(fd); closeSync(fd); console.log('locked');";
    const native = spawnSync(process.execPath, ['--input-type=module', '--eval', lockProbe], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    problems.push(...nativeLockProblems(native));

    // 5. 會話 header 的 build.commit 等於戳記。
    const logs = join(scratch, 'sessions');
    const cli = spawnSync(
      process.execPath,
      [join(root, 'lib/cli.js'), '--session-log', logs, 'hi'],
      {
        cwd: work,
        env,
        encoding: 'utf8',
        timeout: 120_000,
      },
    );
    const cliProblems = cliRunProblems(cli);
    problems.push(...cliProblems);
    if (cliProblems.length === 0) {
      const [run] = existsSync(logs) ? readdirSync(logs) : [];
      const headerPath = run === undefined ? undefined : join(logs, run, 'cli.header.json');
      const header =
        headerPath !== undefined && existsSync(headerPath)
          ? (JSON.parse(readFileSync(headerPath, 'utf8')) as { build?: { commit?: string | null } })
          : undefined;
      problems.push(...headerProblems(header, stamp, options.expectCommit));
    }

    // 6. serve
    problems.push(...(await smokeInstalledServe(root, work, env, scratch)));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return problems;
}

/** {@link smokeInstalledServe} 的兩個期限，毫秒；測試換成短的，不必真的等 90 秒。 */
export interface ServeSmokeTimeouts {
  /** 等 serve 印出網址的上限。 */
  readonly startupMs?: number;
  /** `SIGTERM` 之後等它自己結束的上限，到了送 `SIGKILL` 給整個行程群組。 */
  readonly terminateMs?: number;
}

/**
 * 起 `lib/serve.js --port 0`，等網址、打首頁、查行程、送 SIGTERM。
 *
 * serve 以 `detached: true` 起成自己的行程群組：逾時要 `SIGKILL` 時送給整個群組（`process.kill(-pid)`），
 * serve 自己起的子行程（MCP server、git）不會變孤兒。一般的 `SIGTERM` 只送 serve 本身，
 * 因為要驗的是它自己的收尾。
 */
export async function smokeInstalledServe(
  root: string,
  work: string,
  env: NodeJS.ProcessEnv,
  scratch: string,
  timeouts: ServeSmokeTimeouts = {},
): Promise<string[]> {
  const problems: string[] = [];
  const child = spawn(process.execPath, [join(root, 'lib/serve.js'), '--port', '0'], {
    cwd: work,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', () => resolve(null));
  });
  try {
    const deadline = Date.now() + (timeouts.startupMs ?? 90_000);
    while (Date.now() < deadline && child.exitCode === null) {
      if (/nexus-agent 在 http:\/\/\S+/u.test(output) && /plugin：/u.test(output)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const url = /nexus-agent 在 (http:\/\/\S+)/u.exec(output)?.[1];
    problems.push(...serveOutputProblems(output, url));
    if (url !== undefined) {
      try {
        // 啟動印的網址帶登入 token：先換 cookie（303＋set-cookie），再帶 cookie 打首頁（同 fixtures.ts 的 exchangeServeToken）。
        const exchange = await fetch(url, {
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
        });
        const cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0];
        let home: { status: number; body: string } | undefined;
        if (exchange.status === 303 && cookie !== undefined) {
          const response = await fetch(new URL('/', url), {
            headers: { cookie },
            signal: AbortSignal.timeout(30_000),
          });
          home = { status: response.status, body: await response.text() };
        }
        problems.push(...homepageProblems({ status: exchange.status, cookie }, home));
      } catch (error) {
        problems.push(`打首頁失敗：${(error as Error).message}`);
      }
    }
    const stray = strayProcesses(scratch);
    if (stray.problem !== undefined) problems.push(stray.problem);
    if (stray.lines.length > 0)
      problems.push(`安裝樹裡有 pnpm／tsx 行程：${JSON.stringify(stray.lines.slice(0, 3))}`);
  } catch (error) {
    problems.push(`serve 驗證中途拋錯：${(error as Error).message}`);
  } finally {
    // 不論上面怎麼結束（含拋錯），serve 子行程一定要收掉並等到結束，不留孤兒。
    if (child.exitCode === null) child.kill('SIGTERM');
    const killer = setTimeout(() => signalGroup(child, 'SIGKILL'), timeouts.terminateMs ?? 30_000);
    const code = await exited;
    clearTimeout(killer);
    problems.push(...shutdownProblems(code, output));
  }
  return problems;
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'expect-commit': { type: 'string' },
      'allow-dirty': { type: 'boolean', default: false },
    },
  });
  const [tarball] = positionals;
  if (tarball === undefined) {
    console.error(
      '用法：pnpm run release:verify-packed-install <tarball> [--expect-commit <sha>] [--allow-dirty]',
    );
    process.exit(2);
  }
  const expectCommit = values['expect-commit'];
  const problems = await verifyPackedInstall(tarball, {
    ...(expectCommit === undefined ? {} : { expectCommit }),
    ...(values['allow-dirty'] ? { allowDirty: true } : {}),
  });
  if (problems.length > 0) {
    for (const problem of problems) console.error(`verify-packed-install：${problem}`);
    process.exitCode = 1;
  } else {
    console.log(
      `verify-packed-install：${basename(tarball)} 解開即用——sha256 對上、靜態檢查過、--version、原生二進位、header 戳記、serve 起得來、SIGTERM exit 0。`,
    );
  }
}
