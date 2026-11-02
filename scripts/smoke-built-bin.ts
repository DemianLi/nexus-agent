/**
 * 編出來的入口，用純 `node` 起得來（[#1502](https://github.com/DemianLi/nexus-agent/issues/1502) 刀 1 驗收 1）。
 *
 * 照 dsh `docs/testing.md`「Test the real entry path」：「真正的入口」是發佈的產物——`bin` 跑 `lib/*.js`、純 `node`、
 * 沒有 tsx，才看得到 tsx 蓋住的失敗（模組解析、靜靜吞掉的載入失敗）。這支在 `pnpm run build:lib` 之後跑，量：
 *
 * 1. `node apps/harness/lib/<入口>.js --version` 印出 manifest 的版本，**stderr 是空的**（照 dsh `apps/cli/tests/built-bin.e2e.ts:650`）；
 * 2. 經 `node_modules/.bin` 那種符號連結啟動，同樣印得出來（比路徑的入口檢查在這裡會靜靜以 0 結束、什麼都不印）；
 * 3. **真的把 `nexus-serve --port 0` 起起來**（卡上驗收 1「起得來，印出網址」）：`--version` 在載入設定與插件之前就返回了，
 *    `#settings/*`、插件裸名解析到 `lib`、`cordis.yml` 與 web dist 的相對路徑都量不到。這一條經符號連結、用假 key 與放在 `/var/tmp` 的暫存 home
 *    （不放 `os.tmpdir()`：那裡有暫存目錄規則會干擾），等印出網址與插件清單，送 `SIGTERM`，要 exit 0；有逾時上限，暫存目錄一律收掉。
 *
 * 子行程的環境清掉 `NODE_OPTIONS`、`NODE_PATH`、`TSX_TSCONFIG_PATH`（宿主的 `--import tsx` 不能替它補洞）。
 *
 * @module
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROOT } from './workspace-packages.js';

const HARNESS = join(ROOT, 'apps/harness');
const manifest = JSON.parse(readFileSync(join(HARNESS, 'package.json'), 'utf8')) as {
  version: string;
  bin: Record<string, string>;
};

const env = { ...process.env };
delete env.NODE_OPTIONS;
delete env.NODE_PATH;
delete env.TSX_TSCONFIG_PATH;

const scratch = mkdtempSync(join(tmpdir(), 'smoke-built-bin-'));
const failures: string[] = [];
try {
  const binDir = join(scratch, 'node_modules', '.bin');
  mkdirSync(binDir, { recursive: true });
  for (const [name, target] of Object.entries(manifest.bin)) {
    const entry = join(HARNESS, target);
    const link = join(binDir, name);
    symlinkSync(entry, link);
    for (const [how, path] of [
      ['直接', entry],
      ['經符號連結', link],
    ] as const) {
      const result = spawnSync(process.execPath, [path, '--version'], {
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      });
      if (result.error !== undefined || result.status !== 0) {
        failures.push(
          `${name}（${how}）：起不來——${result.error?.message ?? `exit ${String(result.status)}：${result.stderr}`}`,
        );
        continue;
      }
      const output = result.stdout.trim();
      if (output !== manifest.version) {
        failures.push(
          `${name}（${how}）：--version 印了 ${JSON.stringify(output)}，要是 ${JSON.stringify(manifest.version)}`,
        );
      }
      // 照 dsh `built-bin.e2e.ts:650`：--version 不該在 stderr 吐任何東西（棄用警告、載入警告都算）。
      if (result.stderr !== '') {
        failures.push(
          `${name}（${how}）：--version 的 stderr 不是空的：${JSON.stringify(result.stderr)}`,
        );
      }
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

/**
 * 經符號連結用純 node 起 `nexus-serve --port 0`，等到印出網址與插件清單，送 SIGTERM，要 exit 0。
 *
 * @returns 失敗訊息；空陣列代表通過。
 */
async function smokeServe(): Promise<string[]> {
  const problems: string[] = [];
  const scratch = mkdtempSync(join('/var/tmp', 'smoke-built-bin-serve-'));
  try {
    const home = join(scratch, 'home');
    mkdirSync(home);
    const binDir = join(scratch, 'node_modules', '.bin');
    mkdirSync(binDir, { recursive: true });
    const link = join(binDir, 'nexus-serve');
    symlinkSync(join(HARNESS, manifest.bin['nexus-serve'] ?? 'lib/serve.js'), link);
    const child = spawn(process.execPath, [link, '--port', '0'], {
      // 假 key：預設是假模型，但 serve 的載入路徑會讀憑證；home 放暫存，不碰真的 ~/.nexus-agent。
      env: { ...env, NEXUS_AGENT_HOME: home, NVIDIA_API_KEY: 'smoke-fake-key' },
      cwd: scratch,
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
    const printed = /nexus-agent 在 http:\/\/\S+/u.test(output);
    const plugins = /plugin：(.+)/u.exec(output)?.[1];
    if (!printed)
      problems.push(`nexus-serve 沒印出網址（或逾時）：${JSON.stringify(output.slice(-800))}`);
    else if (plugins === undefined || plugins === '（空）') {
      problems.push(`nexus-serve 起來了但插件清單是空的：${JSON.stringify(plugins)}`);
    }
    // 載不進來的插件列只會被丟掉並印一行警告、serve 照常起來，所以「印出網址」不代表每一列都載得進來。
    const unloadable = output.split('\n').filter((line) => line.includes('載不起來'));
    if (unloadable.length > 0) {
      problems.push(`nexus-serve 有插件載不進來：${JSON.stringify(unloadable.slice(0, 3))}`);
    }
    if (child.exitCode === null) child.kill('SIGTERM');
    const killer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    const code = await exited;
    clearTimeout(killer);
    if (code !== 0) {
      problems.push(
        `nexus-serve 收到 SIGTERM 後 exit ${String(code)}，要 0：${JSON.stringify(output.slice(-800))}`,
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return problems;
}

failures.push(...(await smokeServe()));

// 建置戳記只能出現在打包出來的產物（#1502 PM 判 A 的條件）：原始碼樹 build:lib 之後找不到戳記，
// `resolveBuildVersion` 回的仍是 git HEAD。戳記由刀 2 的 pack 寫，這裡只擋「build 順手寫了一個」。
const stamp = join(HARNESS, 'build-stamp.json');
if (existsSync(stamp))
  failures.push(`build:lib 之後原始碼樹裡出現了 ${stamp}：戳記只能由打包寫進產物`);
const stray = readdirSync(join(HARNESS, 'lib')).filter((name) => name.includes('build-stamp'));
if (stray.length > 0) failures.push(`apps/harness/lib 裡有戳記檔：${stray.join('、')}`);
const { resolveBuildVersion } = (await import('../apps/harness/src/build-version.ts')) as {
  resolveBuildVersion: () => { commit: string | null };
};
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
if (resolveBuildVersion().commit !== head) {
  failures.push(`原始碼樹 build:lib 之後 resolveBuildVersion 回的不是 git HEAD（${head}）`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`smoke-built-bin：${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `smoke-built-bin：${Object.keys(manifest.bin).join('、')} 純 node 起得來，版本 ${manifest.version}；nexus-serve 經符號連結起得來、印出網址、SIGTERM 後 exit 0。`,
  );
}
