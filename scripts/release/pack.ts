/**
 * 把 `@nexus/harness` 的完整正式閉包打成一份 tar.gz，旁邊放 `.sha256`（[#1502](https://github.com/DemianLi/nexus-agent/issues/1502) 刀 2，C047）。
 *
 * 流程：`build:lib` → web 的 `vite build` → `pnpm deploy --legacy --prod` 出閉包到暫存目錄 → 拿掉沒有連結指進去的 `.pnpm` 項目 →
 * 寫建置戳記 → 放 `LICENSE`、`THIRD_PARTY_NOTICES.md`、`licenses/` 的 LGPL／GPL 全文、SBOM（#1545）→ 三道靜態檢查（`payload.ts` 的內容檢查與
 * 出貨清單閉包，加上 `sbom.ts` 的閉包授權檢查；相依圖走訪只在 `verify-packed-install` 跑）→ `tar -czf` → `.sha256`。產物名 `nexus-agent-<版本>-<平台>.tar.gz`，解開是同名的一個資料夾。
 * SBOM 另外複製一份到產物目錄（`<產物名>.cdx.json`，旁邊一份 `.sha256`），Release 一起附上。
 * 主機預裝 Node（22.19 以上的 22.x，或 24 以上（23 已 EOL，不支援），以 `package.json` 的 `engines` 為準）；產物不帶 node、不帶 pnpm、不需要安裝步驟（Q1 (a)，只出 linux-x64，Q2 (a)）。
 *
 * **偏離 dsh，理由 1（基座表達不出來）——`pnpm deploy` 的旗標。** dsh `scripts/build-exe-for-python-sdk.ts:280-300` 用
 * `--legacy --prod --config.node-linker=hoisted --config.auto-install-peers=false --config.link-workspace-packages=true
 * --config.hoist-workspace-packages=false`（pnpm 11）。在本專案的 pnpm 10.34.5 實測，只要帶 `node-linker=hoisted`，legacy deploy
 * 就不讀 lockfile（`The current configuration prohibits to read or write a lockfile`），相依改由 registry 重新解析：
 * `@langchain/core` 從 lockfile 的 1.2.9 漂到 1.2.18，帶 `auto-install-peers=false` 還會因缺 peer 直接失敗。不可重現、
 * 而且要連網，兩者都不能接受（理由 2 的內網前提）。所以只用 `--legacy --prod`：讀 lockfile、產物的版本與 CI 測過的一致。
 * 代價：佈局是 isolated（`node_modules/.pnpm` 加相對符號連結），不是 hoisted 的平面樹；dsh 的 `materializeStagedLinks`
 * 把連結實體化是為了 SEA 單檔不能帶連結，tar 保留相對連結沒有這個限制，改由 {@link collectPayloadViolations} 守「連結都是相對的、
 * 解得開、不跑出產物外」。每個 workspace 套件在 `.pnpm` 裡只有一份（`@nexus/core` 等不會有兩份單例）。撤除條件：pnpm 的
 * hoisted deploy 能讀 lockfile 時回頭照 dsh。
 *
 * **戳記只在這一步寫**：`build-stamp.json` 放在產物根（`lib/` 的上一層，`build-version.ts` 的 `BUILD_STAMP_PATH`），
 * 內容 `{ "commit": "<sha>", "dirty": false }`。`build:lib` 不寫它。
 *
 * **沙箱 spawner**（#1946）：Linux 的產物要帶它。這一步不編 Rust，從 `--spawner <目錄>` 拿 CI 的 Rust job 打好的 bundle
 *（`.github/actions/sandbox-spawner`：執行檔加上連進去的 Rust 程式碼的授權全文，形狀見 `spawner.ts`），原樣放進產物根。
 * Linux 上沒給就停；其他平台不收。
 *
 * 用法：`pnpm run release:pack [--out <目錄>] [--skip-build] [--spawner <目錄>]`。本機跑完會用 `pnpm install --offline --frozen-lockfile`
 * 把開發相依還原（legacy deploy 會動到本機 `node_modules`）；CI（`CI=true`）是用過即丟的 checkout，不還原。
 *
 * @module
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

import { ROOT } from '../workspace-packages.js';
import { releaseMembers, sharedVersion } from './members.js';
import {
  BUNDLED_LICENSE_TEXTS,
  SBOM_FILE,
  collectClosureViolations,
  collectPayloadViolations,
  pruneThirdPartyMaps,
  pruneUnlinkedStoreEntries,
  removeSelfLink,
} from './payload.js';
import { buildSbom, licenseProblems, renderSbom } from './sbom.js';

/** 產物名（不含副檔名）。 */
export function productName(version: string, platform: string): string {
  return `nexus-agent-${version}-${platform}`;
}

/** `sha256sum -c` 讀得懂的一行：`<hash>  <檔名>`（兩個空白）。 */
export function sha256Line(hash: string, fileName: string): string {
  return `${hash}  ${fileName}\n`;
}

/** 對檔案算 sha256。 */
export function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function run(command: string, args: readonly string[], cwd: string = ROOT, timeout?: number): void {
  const result = spawnSync(command, [...args], {
    cwd,
    stdio: 'inherit',
    ...(timeout === undefined ? {} : { timeout }),
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} 失敗（exit ${String(result.status)}）`);
  }
}

/**
 * 打包。
 *
 * @param options - `out` 產物目錄、`skipBuild` 跳過 build、`commit` 寫進戳記的 commit（省略即 `git rev-parse HEAD`）、
 *   `spawner` 沙箱 spawner 的 bundle 目錄（Linux 必給，其他平台不收）。
 * @returns tarball、SBOM 與兩份 `.sha256` 的路徑、版本、平台。
 */
export function pack(options: {
  out: string;
  skipBuild?: boolean;
  commit?: string;
  spawner?: string;
}): {
  tarball: string;
  checksum: string;
  sbom: string;
  version: string;
  platform: string;
} {
  const platform = `${process.platform}-${process.arch}`;
  const version = sharedVersion(releaseMembers());
  const name = productName(version, platform);
  if (process.platform === 'linux' && options.spawner === undefined) {
    throw new Error('Linux 的產物要帶沙箱 spawner：用 --spawner 給 CI 打好的 bundle 目錄');
  }
  if (process.platform !== 'linux' && options.spawner !== undefined) {
    throw new Error(`沙箱 spawner 只在 Linux 上跑，${platform} 的產物不收 --spawner`);
  }
  const commit =
    options.commit ??
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const dirty =
    execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim() !== '';

  if (options.skipBuild !== true) {
    run('pnpm', ['run', 'build:lib']);
    run('pnpm', ['--filter', '@nexus/web', 'run', 'build']);
  }

  const scratch = mkdtempSync(join(tmpdir(), 'nexus-pack-'));
  try {
    const staging = join(scratch, name);
    try {
      run('pnpm', ['--filter', '@nexus/harness', 'deploy', '--legacy', '--prod', staging]);
    } finally {
      if (process.env.CI !== 'true') {
        run('pnpm', [
          'install',
          '--offline',
          '--frozen-lockfile',
          '--prod=false',
          '--ignore-scripts',
        ]);
      }
    }
    pruneThirdPartyMaps(staging);
    removeSelfLink(staging);
    const unlinked = pruneUnlinkedStoreEntries(staging);
    if (unlinked.length > 0) {
      process.stdout.write(`release:pack：拿掉沒有連結指進去的 ${unlinked.join('、')}\n`);
    }
    writeFileSync(
      join(staging, 'build-stamp.json'),
      `${JSON.stringify({ commit, dirty }, null, 2)}\n`,
    );
    // 授權檔照 dsh `scripts/build-python-release.py` 的三件事（`payload.ts` 的 REQUIRED_FILES 有全文）：這裡是「複製」
    // （`:180`、`:183`）；「宣告」（`:185-195`）偏離理由 1，退到 manifest 的 `license`；「驗證」（`:256-259`、`:260-265`）在 payload。
    for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', ...BUNDLED_LICENSE_TEXTS]) {
      mkdirSync(dirname(join(staging, file)), { recursive: true });
      copyFileSync(join(ROOT, file), join(staging, file));
    }
    if (options.spawner !== undefined) cpSync(options.spawner, staging, { recursive: true });
    const bom = buildSbom(staging);
    const sbomText = renderSbom(bom);
    writeFileSync(join(staging, SBOM_FILE), sbomText);

    const violations = [
      ...collectPayloadViolations(staging, { nativeSuffix: platform }),
      ...collectClosureViolations(staging),
      ...licenseProblems(bom).map((message) => ({ path: SBOM_FILE, message })),
    ];
    if (violations.length > 0) {
      throw new Error(
        `產物沒通過靜態檢查（${String(violations.length)} 條）：\n${violations
          .map((violation) => `  ${violation.path}：${violation.message}`)
          .join('\n')}`,
      );
    }

    mkdirSync(options.out, { recursive: true });
    const tarball = join(options.out, `${name}.tar.gz`);
    const checksum = `${tarball}.sha256`;
    run('tar', ['-czf', tarball, '-C', scratch, name], ROOT, 300_000);
    writeFileSync(checksum, sha256Line(fileSha256(tarball), `${name}.tar.gz`));
    const sbom = join(options.out, `${name}.cdx.json`);
    writeFileSync(sbom, sbomText);
    writeFileSync(`${sbom}.sha256`, sha256Line(fileSha256(sbom), `${name}.cdx.json`));
    return { tarball, checksum, sbom, version, platform };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: join(ROOT, '.release-out') },
      'skip-build': { type: 'boolean', default: false },
      spawner: { type: 'string' },
    },
  });
  const result = pack({
    out: values.out,
    skipBuild: values['skip-build'],
    ...(values.spawner === undefined ? {} : { spawner: values.spawner }),
  });
  console.log(
    `release:pack：${result.tarball}（${result.version}，${result.platform}）\n  ${result.checksum}\n  ${result.sbom}`,
  );
}
