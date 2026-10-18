/**
 * 編出來的入口，用純 `node` 起得來（[#1502](https://github.com/DemianLi/nexus-agent/issues/1502) 刀 1 驗收 1）。
 *
 * 照 dsh `docs/testing.md`「Test the real entry path」：「真正的入口」是發佈的產物——`bin` 跑 `lib/*.js`、純 `node`、
 * 沒有 tsx，才看得到 tsx 蓋住的失敗（模組解析、靜靜吞掉的載入失敗）。這支在 `pnpm run build:lib` 之後跑，量：
 *
 * 1. `node apps/harness/lib/<入口>.js --version` 印出 manifest 的版本；
 * 2. 經 `node_modules/.bin` 那種符號連結啟動，同樣印得出來（比路徑的入口檢查在這裡會靜靜以 0 結束、什麼都不印）。
 *
 * 子行程的環境清掉 `NODE_OPTIONS`、`NODE_PATH`（宿主的 `--import tsx` 不能替它補洞）。
 *
 * @module
 */

import { execFileSync } from 'node:child_process';
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
      let output: string;
      try {
        output = execFileSync(process.execPath, [path, '--version'], {
          env,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 60_000,
        }).trim();
      } catch (error) {
        failures.push(
          `${name}（${how}）：起不來——${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (output !== manifest.version) {
        failures.push(
          `${name}（${how}）：--version 印了 ${JSON.stringify(output)}，要是 ${JSON.stringify(manifest.version)}`,
        );
      }
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

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
    `smoke-built-bin：${Object.keys(manifest.bin).join('、')} 純 node 起得來，版本 ${manifest.version}。`,
  );
}
