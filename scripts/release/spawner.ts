/**
 * 沙箱 spawner（`native/sandbox-spawner/`，[#1946](https://github.com/DemianLi/nexus-agent/issues/1946)）在產物裡的樣子。
 *
 * spawner 只在 CI 的 Rust job 編（`.github/actions/sandbox-spawner`），編好的執行檔與它連進去的 Rust 程式碼的授權全文打成一份
 * bundle 交給 `pack.ts --spawner`。這裡定 bundle 與產物裡的位置、連進執行檔的 crate 清單，以及對執行檔本身的檢查。
 *
 * @module
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from '../workspace-packages.js';

/** 執行檔在產物（與 bundle）裡的位置。 */
export const SPAWNER_PATH = 'native/nexus-sandbox-spawner';

/** 連進執行檔的 Rust 程式碼的授權全文：每個 crate 一個 `<名>-<版本>/`，標準函式庫一個 `rust-std/`。 */
export const SPAWNER_LICENSES_DIR = 'licenses/sandbox-spawner';

/** 標準函式庫的版權說明（工具鏈的 `share/doc/rust/COPYRIGHT-library.html`，列出它自己內附的第三方程式碼與全文）。 */
export const RUST_STD_COPYRIGHT = `${SPAWNER_LICENSES_DIR}/rust-std/COPYRIGHT-library.html`;

/** `Cargo.lock` 的位置。 */
export const SPAWNER_LOCK = 'native/sandbox-spawner/Cargo.lock';

/** 一個 crate：`runtime` 為真的連進執行檔，假的只在編譯期跑（proc-macro 與它的相依）。 */
export interface SpawnerCrate {
  readonly name: string;
  readonly license: string;
  readonly repo: string;
  readonly runtime: boolean;
}

/**
 * `Cargo.lock` 裡每一個外部 crate。`Cargo.lock` 不帶授權，所以授權與 repository 寫在這裡（取自各 crate 的 `Cargo.toml`），
 * `Cargo.lock` 多一個或少一個都由 {@link spawnerCrateProblems} 擋。`runtime` 要跟 CI 的
 * `cargo tree -e normal,no-proc-macro` 收到的一致，產物裡的授權目錄由 {@link spawnerProblems} 對。
 */
export const SPAWNER_CRATES: readonly SpawnerCrate[] = [
  {
    name: 'enumflags2',
    license: 'MIT OR Apache-2.0',
    repo: 'https://github.com/meithecatte/enumflags2',
    runtime: true,
  },
  {
    name: 'enumflags2_derive',
    license: 'MIT OR Apache-2.0',
    repo: 'https://github.com/meithecatte/enumflags2',
    runtime: false,
  },
  {
    name: 'landlock',
    license: 'MIT OR Apache-2.0',
    repo: 'https://github.com/landlock-lsm/rust-landlock',
    runtime: true,
  },
  {
    name: 'libc',
    license: 'MIT OR Apache-2.0',
    repo: 'https://github.com/rust-lang/libc',
    runtime: true,
  },
  {
    name: 'proc-macro2',
    license: 'MIT OR Apache-2.0',
    repo: 'https://github.com/dtolnay/proc-macro2',
    runtime: false,
  },
  {
    name: 'quote',
    license: 'MIT OR Apache-2.0',
    repo: 'https://github.com/dtolnay/quote',
    runtime: false,
  },
  {
    name: 'syn',
    license: 'MIT OR Apache-2.0',
    repo: 'https://github.com/dtolnay/syn',
    runtime: false,
  },
  {
    name: 'thiserror',
    license: 'MIT OR Apache-2.0',
    repo: 'https://github.com/dtolnay/thiserror',
    runtime: true,
  },
  {
    name: 'thiserror-impl',
    license: 'MIT OR Apache-2.0',
    repo: 'https://github.com/dtolnay/thiserror',
    runtime: false,
  },
  {
    name: 'unicode-ident',
    license: '(MIT OR Apache-2.0) AND Unicode-3.0',
    repo: 'https://github.com/dtolnay/unicode-ident',
    runtime: false,
  },
];

/** spawner 自己在 `Cargo.lock` 裡的名字，不算外部 crate。 */
const SELF = 'nexus-sandbox-spawner';

/**
 * `Cargo.lock` 的 `[[package]]`：名字與版本，同名多版本各一列。
 *
 * @param text - `Cargo.lock` 全文。
 * @returns 依出現順序。
 */
export function lockedCrates(text: string): { name: string; version: string }[] {
  const crates: { name: string; version: string }[] = [];
  for (const block of text.split(/^\[\[package\]\]$/mu).slice(1)) {
    const name = /^name = "([^"]+)"$/mu.exec(block)?.[1];
    const version = /^version = "([^"]+)"$/mu.exec(block)?.[1];
    if (name === undefined || version === undefined) {
      throw new Error(`Cargo.lock 有一個 [[package]] 讀不出 name 或 version：${block.trim()}`);
    }
    crates.push({ name, version });
  }
  return crates;
}

/**
 * {@link SPAWNER_CRATES} 跟 `Cargo.lock` 兩個方向都要對上。
 *
 * @param lockText - `Cargo.lock` 全文。
 * @returns 問題清單；空代表對上。
 */
export function spawnerCrateProblems(lockText: string): string[] {
  const locked = new Set(
    lockedCrates(lockText)
      .map((entry) => entry.name)
      .filter((name) => name !== SELF),
  );
  const listed = new Set(SPAWNER_CRATES.map((entry) => entry.name));
  return [
    ...[...locked]
      .filter((name) => !listed.has(name))
      .map(
        (name) =>
          `${SPAWNER_LOCK} 有 ${name}，SPAWNER_CRATES 沒有：補上它的授權、repository 與是不是連進執行檔`,
      ),
    ...[...listed]
      .filter((name) => !locked.has(name))
      .map((name) => `SPAWNER_CRATES 有 ${name}，${SPAWNER_LOCK} 沒有：拿掉這一列`),
  ];
}

/** 連進執行檔的 crate 在 bundle 裡的授權目錄名（`<名>-<版本>`），版本取自 `Cargo.lock`。 */
export function runtimeLicenseDirs(lockText: string): string[] {
  const runtime = new Set(
    SPAWNER_CRATES.filter((entry) => entry.runtime).map((entry) => entry.name),
  );
  return lockedCrates(lockText)
    .filter((entry) => runtime.has(entry.name))
    .map((entry) => `${entry.name}-${entry.version}`)
    .sort();
}

/** ELF 的 `e_machine`，鍵是 `process.arch`。 */
const ELF_MACHINE: Readonly<Record<string, number>> = { x64: 62, arm64: 183 };

/**
 * 主機 glibc 的下限，跟 `docs/operations.md`〈用 systemd 常駐〉寫的一致：spawner 若是動態連 glibc，用到的符號版本不能超過它。
 */
export const GLIBC_FLOOR = [2, 28] as const;

const PT_INTERP = 3;

/**
 * 對執行檔本身的檢查：64 位元小端的 ELF、可執行或 PIE、架構對、靜態連結或用到的 glibc 符號版本不超過 {@link GLIBC_FLOOR}。
 *
 * @param bytes - 執行檔內容。
 * @param arch - 目標的 `process.arch`。
 * @returns 問題清單；空代表通過。
 */
export function elfProblems(bytes: Buffer, arch: string): string[] {
  if (bytes.length < 64 || bytes.readUInt32BE(0) !== 0x7f454c46) return ['不是 ELF'];
  if (bytes[4] !== 2 || bytes[5] !== 1) return ['不是 64 位元小端的 ELF'];
  const problems: string[] = [];
  const type = bytes.readUInt16LE(16);
  if (type !== 2 && type !== 3) problems.push(`ELF 型別是 ${String(type)}，不是執行檔`);
  const machine = bytes.readUInt16LE(18);
  const expected = ELF_MACHINE[arch];
  if (expected === undefined) problems.push(`不認得目標架構 ${arch}`);
  else if (machine !== expected) {
    problems.push(`ELF 的架構是 ${String(machine)}，${arch} 應為 ${String(expected)}`);
  }
  const phoff = Number(bytes.readBigUInt64LE(32));
  const phentsize = bytes.readUInt16LE(54);
  const phnum = bytes.readUInt16LE(56);
  let dynamic = false;
  for (let index = 0; index < phnum; index += 1) {
    const at = phoff + index * phentsize;
    if (at + 4 > bytes.length) return [...problems, 'program header 超出檔案'];
    if (bytes.readUInt32LE(at) === PT_INTERP) dynamic = true;
  }
  if (dynamic) {
    const [floorMajor, floorMinor] = GLIBC_FLOOR;
    const over = new Set<string>();
    for (const match of bytes.toString('latin1').matchAll(/GLIBC_(\d+)\.(\d+)/gu)) {
      const major = Number(match[1]);
      const minor = Number(match[2]);
      if (major > floorMajor || (major === floorMajor && minor > floorMinor)) over.add(match[0]);
    }
    if (over.size > 0) {
      problems.push(
        `動態連 glibc，用到 ${[...over].sort().join('、')}，超過主機下限 glibc ${GLIBC_FLOOR.join('.')}`,
      );
    }
  }
  return problems;
}

/**
 * 產物（或 bundle）裡的 spawner：執行檔在、有執行權限、{@link elfProblems} 通過，連進去的每個 crate 與標準函式庫都附了授權全文，
 * 而且授權目錄不多不少。
 *
 * @param root - 產物根或 bundle 根。
 * @param arch - 目標的 `process.arch`。
 * @param lockText - `Cargo.lock` 全文；省略即讀 repo 的。
 * @returns 問題清單，路徑相對於 `root`。
 */
export function spawnerProblems(
  root: string,
  arch: string,
  lockText: string = readFileSync(join(ROOT, SPAWNER_LOCK), 'utf8'),
): { path: string; message: string }[] {
  const problems: { path: string; message: string }[] = [];
  const binary = join(root, SPAWNER_PATH);
  if (!existsSync(binary)) {
    problems.push({ path: SPAWNER_PATH, message: '沙箱 spawner 的執行檔不在' });
  } else {
    if ((statSync(binary).mode & 0o111) === 0) {
      problems.push({ path: SPAWNER_PATH, message: '沙箱 spawner 沒有執行權限' });
    }
    for (const message of elfProblems(readFileSync(binary), arch)) {
      problems.push({ path: SPAWNER_PATH, message: `沙箱 spawner ${message}` });
    }
  }
  if (!existsSync(join(root, RUST_STD_COPYRIGHT))) {
    problems.push({ path: RUST_STD_COPYRIGHT, message: '缺 Rust 標準函式庫的版權說明' });
  }
  const expected = runtimeLicenseDirs(lockText);
  const dir = join(root, SPAWNER_LICENSES_DIR);
  const present = existsSync(dir) ? readdirSync(dir).filter((name) => name !== 'rust-std') : [];
  for (const name of expected) {
    const path = join(dir, name);
    if (!existsSync(path) || readdirSync(path).length === 0) {
      problems.push({
        path: `${SPAWNER_LICENSES_DIR}/${name}`,
        message: '連進執行檔的 crate 缺授權全文',
      });
    }
  }
  for (const name of present.filter((entry) => !expected.includes(entry))) {
    problems.push({
      path: `${SPAWNER_LICENSES_DIR}/${name}`,
      message: 'SPAWNER_CRATES 沒把它標成連進執行檔（或 Cargo.lock 的版本不同）',
    });
  }
  return problems;
}
