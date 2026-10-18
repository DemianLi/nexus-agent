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
 * 6. 起一次 `lib/serve.js --port 0`：印出網址、首頁 200 且是網頁 index、安裝樹裡沒有 pnpm／tsx 行程、`SIGTERM` 後 exit 0。
 *
 * 子行程環境清掉 `NODE_OPTIONS`、`NODE_PATH`、`TSX_TSCONFIG_PATH`，`NEXUS_AGENT_HOME`／`HOME` 指進暫存目錄，`cwd` 在 repo 外。
 * 不論成敗，暫存目錄一律收掉。放 `/var/tmp`（不放 `os.tmpdir()`：那裡有暫存目錄規則會干擾，見 smoke-built-bin）。
 *
 * 用法：`pnpm run release:verify-packed-install <tarball>`。
 *
 * @module
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
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
function cleanEnv(home: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'TSX_TSCONFIG_PATH', 'NVIDIA_API_KEY']) {
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

/** 目前有哪些行程的命令列帶著這個目錄且是 pnpm／tsx。 */
function strayProcesses(dir: string): string[] {
  const out = spawnSync('ps', ['-A', '-o', 'command='], { encoding: 'utf8' }).stdout;
  return out
    .split('\n')
    .filter((line) => line.includes(dir) && /(^|[\s/])(pnpm|tsx)([\s/]|$)/u.test(line));
}

/**
 * 驗一份 tarball。
 *
 * @param tarball - tarball 路徑，旁邊要有 `.sha256`。
 * @param options - `expectCommit`：打包的 commit（CI 給 `GITHUB_SHA`）。給了，header 的 `build.commit` 就要等於它，
 *   而不只是等於產物自己的戳記——戳記被拿掉時兩邊同時不見，只比戳記會漏。
 * @returns 失敗訊息；空陣列代表通過。
 */
export async function verifyPackedInstall(
  tarball: string,
  options: { expectCommit?: string } = {},
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
    execFileSync('tar', ['-xzf', tarball, '-C', extract]);
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
      ? (JSON.parse(readFileSync(stampPath, 'utf8')) as { commit?: string })
      : undefined;

    // 3. --version
    const version = spawnSync(process.execPath, [join(root, 'lib/serve.js'), '--version'], {
      cwd: work,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (version.status !== 0 || version.stdout.trim() !== manifest.version) {
      problems.push(
        `--version 要印 ${manifest.version}：exit ${String(version.status)}，stdout ${JSON.stringify(version.stdout)}，stderr ${JSON.stringify(version.stderr)}`,
      );
    } else if (version.stderr !== '') {
      problems.push(`--version 的 stderr 不是空的：${JSON.stringify(version.stderr)}`);
    }

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
    if (native.status !== 0 || native.stdout.trim() !== 'locked') {
      problems.push(`目標平台的 flock 原生二進位拿不到鎖：${native.stderr.slice(-400)}`);
    }

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
    if (cli.status !== 0) {
      problems.push(
        `lib/cli.js 假模型跑一輪失敗（exit ${String(cli.status)}）：${cli.stderr.slice(-400)}`,
      );
    } else {
      const [run] = existsSync(logs) ? readdirSync(logs) : [];
      const headerPath = run === undefined ? undefined : join(logs, run, 'cli.header.json');
      if (headerPath === undefined || !existsSync(headerPath)) {
        problems.push('cli 跑完沒有 cli.header.json');
      } else {
        const header = JSON.parse(readFileSync(headerPath, 'utf8')) as {
          build?: { commit?: string | null };
        };
        const actual = header.build?.commit;
        const wanted = options.expectCommit ?? stamp?.commit;
        if (wanted === undefined) {
          problems.push('產物沒有戳記，也沒給 --expect-commit：header 的 build.commit 無從比對');
        } else if (actual !== wanted) {
          problems.push(
            `會話 header 的 build.commit 是 ${JSON.stringify(actual)}，要等於 ${options.expectCommit === undefined ? '戳記' : '打包的 commit'}的 ${wanted}`,
          );
        }
        if (stamp?.commit !== undefined && actual !== stamp.commit) {
          problems.push(
            `會話 header 的 build.commit（${JSON.stringify(actual)}）不等於戳記的 ${stamp.commit}`,
          );
        }
      }
    }

    // 6. serve
    problems.push(...(await smokeInstalledServe(root, work, env, scratch)));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return problems;
}

/** 起 `lib/serve.js --port 0`，等網址、打首頁、查行程、送 SIGTERM。 */
async function smokeInstalledServe(
  root: string,
  work: string,
  env: NodeJS.ProcessEnv,
  scratch: string,
): Promise<string[]> {
  const problems: string[] = [];
  const child = spawn(process.execPath, [join(root, 'lib/serve.js'), '--port', '0'], {
    cwd: work,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', () => resolve(null));
  });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && child.exitCode === null) {
    if (/nexus-agent 在 http:\/\/\S+/u.test(output) && /plugin：/u.test(output)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const url = /nexus-agent 在 (http:\/\/\S+)/u.exec(output)?.[1];
  if (url === undefined) {
    problems.push(`serve 沒印出網址（或逾時）：${JSON.stringify(output.slice(-800))}`);
  } else {
    try {
      // 啟動印的網址帶登入 token：先換 cookie（303＋set-cookie），再帶 cookie 打首頁（同 fixtures.ts 的 exchangeServeToken）。
      const exchange = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      });
      const cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0];
      if (exchange.status !== 303 || cookie === undefined) {
        problems.push(`token 交換失敗：${String(exchange.status)}`);
      } else {
        const home = await fetch(new URL('/', url), {
          headers: { cookie },
          signal: AbortSignal.timeout(30_000),
        });
        const body = await home.text();
        if (home.status !== 200) problems.push(`首頁回 ${String(home.status)}，要 200`);
        else if (!/<div id="root"|<script[^>]+type="module"/u.test(body)) {
          problems.push(`首頁 200 但不像網頁 index：${JSON.stringify(body.slice(0, 200))}`);
        }
      }
    } catch (error) {
      problems.push(`打首頁失敗：${(error as Error).message}`);
    }
  }
  const unloadable = output.split('\n').filter((line) => line.includes('載不起來'));
  if (unloadable.length > 0)
    problems.push(`有插件載不進來：${JSON.stringify(unloadable.slice(0, 3))}`);
  const stray = strayProcesses(scratch);
  if (stray.length > 0)
    problems.push(`安裝樹裡有 pnpm／tsx 行程：${JSON.stringify(stray.slice(0, 3))}`);
  if (child.exitCode === null) child.kill('SIGTERM');
  const killer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  const code = await exited;
  clearTimeout(killer);
  if (code !== 0)
    problems.push(`SIGTERM 後 exit ${String(code)}，要 0：${JSON.stringify(output.slice(-600))}`);
  return problems;
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { 'expect-commit': { type: 'string' } },
  });
  const [tarball] = positionals;
  if (tarball === undefined) {
    console.error('用法：pnpm run release:verify-packed-install <tarball> [--expect-commit <sha>]');
    process.exit(2);
  }
  const expectCommit = values['expect-commit'];
  const problems = await verifyPackedInstall(
    tarball,
    expectCommit === undefined ? {} : { expectCommit },
  );
  if (problems.length > 0) {
    for (const problem of problems) console.error(`verify-packed-install：${problem}`);
    process.exitCode = 1;
  } else {
    console.log(
      `verify-packed-install：${basename(tarball)} 解開即用——sha256 對上、靜態檢查過、--version、原生二進位、header 戳記、serve 起得來、SIGTERM exit 0。`,
    );
  }
}
