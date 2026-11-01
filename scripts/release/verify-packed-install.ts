/**
 * 在 repo 外解開打好的 tarball，用純 `node` 驗它「解開即用」（[#1502](https://github.com/DemianLi/nexus-agent/issues/1502) 刀 3，C083）。
 *
 * 照 dsh `scripts/release/verify-packed-install.ts` 的形狀，但依卡上 Q1：**安裝時不連 registry**（理由 2：完全內網）。
 * dsh 的安裝驗證會為外部相依連 registry（`verify-packed-install.ts:6-7`）；這裡產物是 `pnpm deploy --prod` 的完整閉包，
 * 解開之後**不再跑任何 install**，所以整個流程沒有一步會連 registry——缺的東西只會在下面幾件事裡現形：
 *
 * 1. `.sha256` 與 tarball 對得上（等同 `sha256sum -c`）；
 * 2. 解開的樹過靜態檢查（`payload.ts` 的三道：拒收 `src/`／`.map`、出貨清單每列解析得到、相依圖完整）；SBOM 與實際裝了的
 *    閉包雙向相同（`sbom.ts` 的 `sbomProblems`，#1545 驗收 6），SBOM 列的每一顆授權都是寬鬆授權或審過的例外（`installedLicenseProblems`），Release 要附的那份 SBOM 與產物裡的位元組相同、對得上自己的 `.sha256`；
 * 3. `lib/serve.js --version` 等於產物版本，stderr 是空的；
 * 4. Linux 上打包裡的 spawner `--flock` 真的鎖得住（第二個搶不到、持有者 SIGKILL 之後拿得到；產品走這條路由步驟 6 的第二台 serve 驗）；內附的 ripgrep 在 `PATH` 上沒有 rg
 *    的環境下照樣跑得起來（#1502 刀 4：grep 只用內附那一支，沒有退路）；sharp 與目標平台的 libvips 載得起來，真的縮一張圖
 *    （[#2033](https://github.com/DemianLi/nexus-agent/issues/2033)）；Linux 上產物裡的沙箱 spawner 起得來、送 `Ready`，
 *    經它起得了主機上的 git（#1946，`spawner-probe.ts`）；
 * 5. 假模型跑一輪 `lib/cli.js`：會話 header 的 `build.commit` 等於戳記——已安裝的樹沒有 git，戳記是唯一的來源（PM 補驗收）；
 *    戳記本身也查：`commit` 是非空字串、`dirty` 是 `false`（本機驗沒 commit 的改動加 `--allow-dirty`，CI 不加）；
 * 6. 起一次 `lib/serve.js --port 0`：印出網址、啟動日誌講的 grep 用的 ripgrep 在**安裝樹裡**（不是宿主 `PATH` 上的）、
 *    首頁 200 且是網頁 index、Linux 上第二台 serve 被 home 鎖拒絕、安裝樹裡沒有 pnpm／tsx 行程、`SIGTERM` 後 exit 0。
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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { parseArgs } from 'node:util';

import {
  parseGenerationLogFilename,
  sessionDirectoryName,
} from '../../packages/nexus-core/src/session-filename.js';
import { serverLogBody } from '../../apps/harness/src/server-log-line.js';
import { fileSha256 } from './pack.js';
import {
  SBOM_FILE,
  collectClosureViolations,
  collectPayloadViolations,
  walkInstalledGraph,
} from './payload.js';
import { installedLicenseProblems, sbomProblems } from './sbom.js';
import { SPAWNER_PATH } from './spawner.js';
import {
  probeInstalledSpawner,
  spawnerProbeProblems,
  spawnerProbeSummary,
} from './spawner-probe.js';

/**
 * CLI 那一輪 root 會話的世代檔：`<run 目錄>/<sessionDirectoryName('cli')>/` 裡數字最大的 `session.v<N>.jsonl`，header 在第一行
 * （#1594 ③）。檔名照 `@nexus/core` 的那一份（#1857）；import 的是葉模組本身，不經 `@nexus/core` 的入口：發版腳本不拉整包
 * core 進來，同上面的 `server-log-line`。
 *
 * @param runDirectory - CLI 這一輪的 run 目錄。
 * @returns 世代檔的路徑；會話目錄不在或裡面沒有世代檔就是 `undefined`。
 */
export function cliSessionLog(runDirectory: string): string | undefined {
  const sessionDirectory = join(runDirectory, sessionDirectoryName('cli'));
  if (!existsSync(sessionDirectory)) return undefined;
  let latest: { readonly name: string; readonly version: number } | undefined;
  for (const name of readdirSync(sessionDirectory)) {
    const version = parseGenerationLogFilename(name);
    if (version !== undefined && (latest === undefined || version > latest.version)) {
      latest = { name, version };
    }
  }
  return latest === undefined ? undefined : join(sessionDirectory, latest.name);
}

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

/**
 * 步驟 2b：Release 要附的 SBOM（tarball 旁邊的 `<產物名>.cdx.json`）在、對得上自己的 `.sha256`，而且與產物裡那份位元組相同
 * （#1545 步驟 4）。產物裡那份對不對閉包由 `sbomProblems` 管。
 *
 * @param tarball - tarball 路徑。
 * @param root - 解開後的產物根。
 */
export function attachedSbomProblems(tarball: string, root: string): string[] {
  const attached = tarball.replace(/\.tar\.gz$/u, '.cdx.json');
  if (!existsSync(attached)) return [`缺 ${basename(attached)}（Release 要附的 SBOM）`];
  const problems = checksumProblems(attached);
  const inner = join(root, SBOM_FILE);
  if (existsSync(inner) && !readFileSync(inner).equals(readFileSync(attached))) {
    problems.push(`${basename(attached)} 與產物裡的 ${SBOM_FILE} 不同`);
  }
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

/** 步驟 4：打包裡的 spawner 真的拿得到鎖、擋得住第二個，持有者死了放得掉。 */
export function spawnerLockProblems(run: CommandOutcome): string[] {
  if (run.status !== 0 || run.stdout.trim() !== 'locked') {
    return [`打包裡的 spawner 鎖不住：${run.stdout.slice(-200)}${run.stderr.slice(-400)}`];
  }
  return [];
}

/**
 * 步驟 4 的探針：對 `binary --flock` 走完「持有者拿到、第二個被擋（結束碼 10）、持有者 SIGKILL 後拿得到」。
 * `lib/` 是打包過的，內部模組沒有自己的檔，所以直接驗出貨的執行檔。
 */
export function spawnerLockProbe(binary: string, lockFile: string): string {
  const lock =
    "import { openSync } from 'node:fs';\n" +
    "import { spawnSync } from 'node:child_process';\n" +
    `const lock = () => spawnSync(${JSON.stringify(binary)}, ['--flock'], { stdio: ['ignore', 'ignore', 'ignore', openSync(${JSON.stringify(lockFile)}, 'w', 0o600)] }).status;\n`;
  const holder = `${lock}console.log(lock() === 0 ? 'held' : 'failed'); setInterval(() => {}, 1000);`;
  return (
    lock +
    "import { spawn } from 'node:child_process';\n" +
    "import { once } from 'node:events';\n" +
    `const holder = spawn(process.execPath, ['--input-type=module', '--eval', ${JSON.stringify(holder)}], { stdio: ['ignore', 'pipe', 'inherit'] });\n` +
    "process.on('exit', () => holder.kill('SIGKILL'));\n" +
    "const [first] = await once(holder.stdout, 'data');\n" +
    "if (String(first).trim() !== 'held') throw new Error('持有者沒拿到鎖：' + first);\n" +
    'const second = lock();\n' +
    "if (second !== 10) throw new Error('第二個沒被擋下：' + second);\n" +
    "holder.kill('SIGKILL'); await once(holder, 'exit');\n" +
    'const third = lock();\n' +
    "if (third !== 0) throw new Error('持有者死了還拿不到：' + third);\n" +
    "console.log('locked');"
  );
}

/** 步驟 6 的一環：同一個 home 已有 serve 活著，第二台要被 home 鎖拒絕；鎖退到 `unavailable` 時第二台不會被拒，這條就紅。 */
export function secondServeProblems(run: CommandOutcome): string[] {
  if (run.status !== 1 || !run.stderr.includes('已經有另一個 serve 在用')) {
    return [
      `第二台 serve 沒被 home 鎖擋下：exit ${String(run.status)}，stderr ${JSON.stringify(run.stderr.slice(-400))}`,
    ];
  }
  return [];
}

/** 步驟 4b：內附的 ripgrep 在乾淨環境（`PATH` 上沒有 rg）裡跑得起來，印出自己的版本。 */
export function bundledRgProblems(run: CommandOutcome): string[] {
  if (run.status !== 0 || !run.stdout.startsWith('ripgrep ')) {
    return [
      `內附的 ripgrep 在 PATH 上沒有 rg 的環境裡跑不起來：exit ${String(run.status)}，stdout ${JSON.stringify(run.stdout.slice(0, 200))}，stderr ${JSON.stringify(run.stderr.slice(-400))}`,
    ];
  }
  return [];
}

/** 步驟 4d 的探針圖：比 {@link SHARP_PROBE_LIMIT} 大，縮完長邊要剛好等於上限。 */
export const SHARP_PROBE_SOURCE = { width: 3000, height: 2000 } as const;
/** 步驟 4d 探針自己的長邊上限，只用來確認真的縮了；跟產品的圖片處理沒有綁在一起。 */
export const SHARP_PROBE_LIMIT = 2048;

/** 步驟 4d 的探針：從 `cwd` 解析 `sharp`，產一張探針圖、依 EXIF 轉正、轉 sRGB、縮進上限、編 JPEG，印出結果的寬高、色彩空間與格式。 */
export const SHARP_PROBE =
  "import sharp from 'sharp';\n" +
  `const source = await sharp({ create: { width: ${String(SHARP_PROBE_SOURCE.width)}, height: ${String(SHARP_PROBE_SOURCE.height)}, channels: 3, background: '#c03030' } }).png().toBuffer();\n` +
  `const out = await sharp(source).rotate().toColourspace('srgb').resize(${String(SHARP_PROBE_LIMIT)}, ${String(SHARP_PROBE_LIMIT)}, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer();\n` +
  'const meta = await sharp(out).metadata();\n' +
  'process.stdout.write(JSON.stringify({ width: meta.width, height: meta.height, space: meta.space, format: meta.format }));';

/** 步驟 4d：sharp 從產物根載得起來，把探針圖轉成 sRGB、縮進上限、編成 JPEG；子行程印一行 JSON。 */
export function sharpProblems(run: CommandOutcome): string[] {
  let result: { width?: unknown; height?: unknown; space?: unknown; format?: unknown } | undefined;
  try {
    result = run.status === 0 ? (JSON.parse(run.stdout) as typeof result) : undefined;
  } catch {
    // stdout 不是 JSON：result 留 undefined，由下面同一個判斷報。
  }
  if (
    result === undefined ||
    typeof result.width !== 'number' ||
    typeof result.height !== 'number' ||
    Math.max(result.width, result.height) !== SHARP_PROBE_LIMIT ||
    result.space !== 'srgb' ||
    result.format !== 'jpeg'
  ) {
    return [
      `sharp 在產物裡縮不了圖：exit ${String(run.status)}，stdout ${JSON.stringify(run.stdout.slice(0, 200))}，stderr ${JSON.stringify(run.stderr.slice(-400))}`,
    ];
  }
  return [];
}

/** 步驟 4c 的檔案內容與命中：工作區的檔名與那一行要出現在 grep 的工具結果裡。 */
export const GREP_PROBE_FILE = 'a.txt';
export const GREP_PROBE_NEEDLE = 'needle-1502';

/**
 * 步驟 4c：**安裝樹裡真的跑一次 grep**——假模型（腳本提供者）叫 `grep`，`PATH` 是空目錄，所以命中只可能來自內附的 rg。
 * 只看啟動那一行（`ripgrepDisclosureProblems`）驗不到「已安裝的 serve 搜尋走內附 rg」（#1502 驗收 6）。
 *
 * @param run - `lib/cli.js` 這一輪的結果。
 * @param sessionLog - 這一輪的會話日誌（{@link cliSessionLog}）原文；沒有就傳 `undefined`。
 */
export function installedGrepProblems(
  run: CommandOutcome,
  sessionLog: string | undefined,
): string[] {
  if (run.status !== 0) {
    return [
      `安裝樹裡跑 grep 的那一輪失敗（exit ${String(run.status)}）：${run.stderr.slice(-400)}`,
    ];
  }
  if (sessionLog === undefined) return ['安裝樹裡跑 grep 的那一輪沒有會話日誌'];
  if (!sessionLog.includes('"name":"grep"')) return ['會話日誌裡沒有 grep 的工具結果'];
  if (!sessionLog.includes(`${GREP_PROBE_NEEDLE} here`) || !sessionLog.includes(GREP_PROBE_FILE)) {
    return [
      `安裝樹裡的 grep 沒有命中工作區的 ${GREP_PROBE_FILE}（要有「${GREP_PROBE_NEEDLE} here」）：${sessionLog.slice(-400)}`,
    ];
  }
  return [];
}

/**
 * 步驟 6d：serve 啟動日誌裡 grep 的那一行（`搜尋（grep）：…`，`apps/harness/src/rg-path.ts` 的 `formatRipgrepDisclosure`）。
 *
 * - 沒有這一行：啟動路徑少了披露（#1502 驗收 6 要的就是它）。
 * - 說「不可用」：內附的 rg 在安裝樹裡缺了或沒有執行權限。
 * - 路徑不在安裝樹底下：grep 用的是宿主別的 rg，不是產物內附的。
 *
 * @param output - serve 的 stdout＋stderr（每行可帶伺服器日誌的前綴）。
 * @param root - 安裝樹根。
 */
export function ripgrepDisclosureProblems(output: string, root: string): string[] {
  // serve 的日誌每行帶「時間 [等級] 名字 」前綴（#1534）：先剝掉再比開頭。剝法與測試共用 `serverLogBody`，不另寫一份解析器。
  const line = output
    .split('\n')
    .map(serverLogBody)
    .find((entry) => entry.startsWith('搜尋（grep）：'));
  if (line === undefined)
    return ['serve 啟動日誌沒有 grep 用哪一支 ripgrep 的那一行（搜尋（grep）：…）'];
  const prefix = '搜尋（grep）：內附 ripgrep ';
  if (!line.startsWith(prefix)) return [`內附的 ripgrep 在安裝樹裡不可用：${line}`];
  const path = line.slice(prefix.length).trim();
  // `require.resolve` 回的是 realpath（macOS 上 `/var/tmp` 是 `/private/var/tmp`），安裝樹根兩種寫法都認。
  const roots = [root, ...(existsSync(root) ? [realpathSync(root)] : [])];
  if (!roots.some((candidate) => path.startsWith(candidate + sep))) {
    return [`grep 用的 ripgrep 不在安裝樹（${root}）底下：${path}`];
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
 * @param header - 世代檔第一行（header 行）解開的內容；檔不在傳 `undefined`。
 * @param stamp - 產物的戳記。
 * @param expectCommit - 打包的 commit（CI 給 `GITHUB_SHA`）。給了，header 就要等於它，
 *   而不只是等於產物自己的戳記——戳記被拿掉時兩邊同時不見，只比戳記會漏。
 */
export function headerProblems(
  header: { build?: { commit?: string | null } } | undefined,
  stamp: BuildStampShape | undefined,
  expectCommit?: string,
): string[] {
  if (header === undefined) return ['cli 跑完沒有會話的世代檔'];
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
    problems.push(...sbomProblems(root));
    problems.push(...installedLicenseProblems(root));
    problems.push(...attachedSbomProblems(tarball, root));

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

    // 4. 打包裡的 spawner 鎖得住。spawner 只在 Linux 出貨。
    if (process.platform === 'linux') {
      const lockProbe = spawnerLockProbe(join(root, SPAWNER_PATH), join(scratch, 'probe.lock'));
      const lockRun = spawnSync(process.execPath, ['--input-type=module', '--eval', lockProbe], {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 60_000,
      });
      problems.push(...spawnerLockProblems(lockRun));
    }

    // 4b. 內附的 ripgrep：PATH 換成一個空目錄（宿主有沒有 rg 都不能替它補洞），從產物根解析 `@vscode/ripgrep` 並跑 `--version`。
    const emptyBin = join(scratch, 'empty-bin');
    mkdirSync(emptyBin, { recursive: true });
    const rgProbe =
      "import { rgPath } from '@vscode/ripgrep';\n" +
      "import { spawnSync } from 'node:child_process';\n" +
      "const run = spawnSync(rgPath, ['--version'], { encoding: 'utf8' });\n" +
      'process.stdout.write(run.status === 0 ? run.stdout : `FAIL ${run.error?.message ?? run.status}`);';
    const bundledRg = spawnSync(process.execPath, ['--input-type=module', '--eval', rgProbe], {
      cwd: root,
      env: { ...env, PATH: emptyBin },
      encoding: 'utf8',
      timeout: 60_000,
    });
    problems.push(...bundledRgProblems(bundledRg));

    // 4d. sharp：從產物根解析，原生的 sharp 與 libvips 都要載得起來（import 就會載 .so；真的轉一次，才確認建圖、色彩轉換、縮放與 JPEG 編碼都能跑）。
    const sharpRun = spawnSync(process.execPath, ['--input-type=module', '--eval', SHARP_PROBE], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    problems.push(...sharpProblems(sharpRun));

    // 4e. 沙箱 spawner（只有 Linux 的產物帶）：起產物裡那一支、等 Ready，再經它起一次主機的 git。
    if (process.platform === 'linux') {
      const spawnerProbe = await probeInstalledSpawner(root, scratch);
      console.log(spawnerProbeSummary(spawnerProbe));
      problems.push(...spawnerProbeProblems(spawnerProbe));
    }

    // 4c. 安裝樹裡真的跑一次 grep：腳本模型叫 grep，PATH 是空目錄（同 4b），命中只可能來自內附的 rg。
    const grepWork = join(scratch, 'grep-ws');
    mkdirSync(grepWork, { recursive: true });
    writeFileSync(join(grepWork, GREP_PROBE_FILE), `hello\n${GREP_PROBE_NEEDLE} here\n`);
    const grepPatch = join(scratch, 'grep.patch.yml');
    writeFileSync(
      grepPatch,
      [
        '- insert:',
        '    - id: grep-probe',
        "      name: '#settings/scripted-model'",
        '      config:',
        '        turns:',
        "          - content: ''",
        '            toolCalls:',
        '              - name: grep',
        `                args: { pattern: '${GREP_PROBE_NEEDLE}', path: '/', output_mode: content }`,
        "          - content: 'done'",
        '- id: agent-default-model',
        '  config: { provider: grep-probe }',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    const grepLogs = join(scratch, 'grep-sessions');
    const grepRun = spawnSync(
      process.execPath,
      [
        join(root, 'lib/cli.js'),
        '--workspace',
        grepWork,
        '--patch',
        grepPatch,
        '--session-log',
        grepLogs,
        'grep',
      ],
      { cwd: work, env: { ...env, PATH: emptyBin }, encoding: 'utf8', timeout: 120_000 },
    );
    const [grepRunDir] = existsSync(grepLogs) ? readdirSync(grepLogs) : [];
    const grepLogFile =
      grepRunDir === undefined ? undefined : cliSessionLog(join(grepLogs, grepRunDir));
    problems.push(
      ...installedGrepProblems(
        grepRun,
        grepLogFile === undefined ? undefined : readFileSync(grepLogFile, 'utf8'),
      ),
    );

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
      const logFile = run === undefined ? undefined : cliSessionLog(join(logs, run));
      const header =
        logFile === undefined
          ? undefined
          : (JSON.parse(readFileSync(logFile, 'utf8').split('\n', 1)[0]!) as {
              build?: { commit?: string | null };
            });
      problems.push(...headerProblems(header, stamp, options.expectCommit));
    }

    // 6. serve
    // spawner 只在 Linux 出貨，其他平台拿不到 home 鎖，第二台擋不下來。
    const whileServing = (): string[] =>
      process.platform === 'linux'
        ? secondServeProblems(
            spawnSync(process.execPath, [join(root, 'lib/serve.js'), '--port', '0'], {
              cwd: work,
              env,
              encoding: 'utf8',
              timeout: 60_000,
            }),
          )
        : [];
    problems.push(...(await smokeInstalledServe(root, work, env, scratch, {}, whileServing)));
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
 * 起 `lib/serve.js --port 0`，等網址、打首頁、跑 `whileServing`、查行程、送 SIGTERM。
 *
 * serve 以 `detached: true` 起成自己的行程群組：逾時要 `SIGKILL` 時送給整個群組（`process.kill(-pid)`），
 * serve 自己起的子行程（MCP server、git）不會變孤兒。一般的 `SIGTERM` 只送 serve 本身，
 * 因為要驗的是它自己的收尾。
 *
 * 離開行程群組也讓終端機的 Ctrl-C 與 CI 取消的訊號到不了 serve，所以執行期間掛著 `SIGINT`／`SIGTERM` 的處理：
 * 收到就 `SIGKILL` 整個群組、收掉暫存目錄、再用同一個訊號結束自己（不留孤兒，退出狀態也還是被訊號中斷）。
 */
export async function smokeInstalledServe(
  root: string,
  work: string,
  env: NodeJS.ProcessEnv,
  scratch: string,
  timeouts: ServeSmokeTimeouts = {},
  whileServing: () => string[] = () => [],
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
  // serve 在自己的行程群組（上面 `detached`），終端機的 Ctrl-C 與 CI 取消送給 verify 的訊號到不了它。
  // 沒有這一段的話 verify 照預設動作直接結束，`finally` 不會跑，serve 與它的子行程就留成孤兒。
  let interrupted: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    interrupted ??= signal;
    signalGroup(child, 'SIGKILL');
  };
  const onInt = (): void => onSignal('SIGINT');
  const onTerm = (): void => onSignal('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  try {
    const deadline = Date.now() + (timeouts.startupMs ?? 90_000);
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      if (/nexus-agent 在 http:\/\/\S+/u.test(output) && /plugin：/u.test(output)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const url = /nexus-agent 在 (http:\/\/\S+)/u.exec(output)?.[1];
    problems.push(...serveOutputProblems(output, url));
    if (url !== undefined) {
      // 啟動日誌是一行一行印的，grep 那一行排在網址與 plugin 之後：寬限一下，不是等到逾時。
      const grace = Date.now() + 2_000;
      while (!/搜尋（grep）：/u.test(output) && Date.now() < grace && child.exitCode === null) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      problems.push(...ripgrepDisclosureProblems(output, root));
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
      problems.push(...whileServing());
    }
    const stray = strayProcesses(scratch);
    if (stray.problem !== undefined) problems.push(stray.problem);
    if (stray.lines.length > 0)
      problems.push(`安裝樹裡有 pnpm／tsx 行程：${JSON.stringify(stray.lines.slice(0, 3))}`);
  } catch (error) {
    problems.push(`serve 驗證中途拋錯：${(error as Error).message}`);
  } finally {
    // 不論上面怎麼結束（含拋錯），serve 子行程一定要收掉並等到結束，不留孤兒。
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const killer = setTimeout(() => signalGroup(child, 'SIGKILL'), timeouts.terminateMs ?? 30_000);
    const code = await exited;
    clearTimeout(killer);
    problems.push(...shutdownProblems(code, output));
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    if (interrupted !== undefined) {
      // 收完 serve 之後照原本的訊號結束（shell 看到 130／143），暫存目錄也收掉——呼叫端的 finally 不會有機會跑。
      rmSync(scratch, { recursive: true, force: true });
      process.kill(process.pid, interrupted);
    }
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
      `verify-packed-install：${basename(tarball)} 解開即用——sha256 對上、靜態檢查過、SBOM 與閉包相同、授權、--version、spawner 的鎖、sharp 與內附 ripgrep、header 戳記、serve 起得來、SIGTERM exit 0。`,
    );
  }
}
