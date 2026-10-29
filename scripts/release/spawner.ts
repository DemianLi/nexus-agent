/**
 * 沙箱 spawner（`native/sandbox-spawner/`，[#1946](https://github.com/DemianLi/nexus-agent/issues/1946)）在產物裡的樣子。
 *
 * 產物裡的 spawner 只由 `.github/actions/sandbox-spawner` 編（ci.yml 與 release.yml 共用），目標是靜態連結 musl 的
 * `<arch>-unknown-linux-musl`。編好的執行檔與連進去的程式碼（crate、標準函式庫、musl、LLVM libunwind）的授權全文打成一份
 * bundle 交給 `pack.ts --spawner`。這裡定 bundle 與產物裡的位置、連進執行檔的 crate 與 C 函式庫清單，以及對執行檔本身的檢查。
 *
 * @module
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from '../workspace-packages.js';

/** 執行檔在產物（與 bundle）裡的位置。 */
export const SPAWNER_PATH = 'native/nexus-sandbox-spawner';

/**
 * 連進執行檔的程式碼的授權全文：每個 crate 與 {@link SPAWNER_NATIVE_LIBS} 各一個 `<名>-<版本>/`，標準函式庫一個 `rust-std/`。
 */
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

/** 工具鏈自帶、跟著標準函式庫連進執行檔的 C 函式庫。`Cargo.lock` 不列它們，版本跟著工具鏈，記在 {@link SPAWNER_NATIVE_LIBS}。 */
export interface SpawnerNativeLib {
  readonly name: string;
  readonly version: string;
  /** SPDX 運算式；SBOM 照抄，`licenseProblems` 的審過例外照字串比對。 */
  readonly license: string;
  /** 聲明檔表格裡的連結。 */
  readonly repo: string;
}

/**
 * Rust 的 musl target 自帶的 C 函式庫：musl 本身，以及標準函式庫的 unwind 用的 LLVM libunwind（`panic = "abort"` 也連）。
 * 授權原文放在 {@link NATIVE_LICENSES_SOURCE} 的 `<名>-<版本>/`，兩邊由測試對；LLVM 的版本另由 `bundle.sh` 對 `rustc -vV`。
 */
export const SPAWNER_NATIVE_LIBS: readonly SpawnerNativeLib[] = [
  {
    name: 'llvm-libunwind',
    version: '22.1.8',
    license: 'Apache-2.0 WITH LLVM-exception',
    repo: 'https://github.com/llvm/llvm-project',
  },
  { name: 'musl', version: '1.2.5', license: 'MIT', repo: 'https://musl.libc.org/' },
];

/** {@link SPAWNER_NATIVE_LIBS} 授權原文在 repo 裡的位置，`bundle.sh` 從這裡複製。 */
export const NATIVE_LICENSES_SOURCE = 'native/sandbox-spawner/licenses';

/** {@link SPAWNER_NATIVE_LIBS} 的授權目錄名（`<名>-<版本>`）。 */
export function nativeLicenseDirs(): string[] {
  return SPAWNER_NATIVE_LIBS.map((entry) => `${entry.name}-${entry.version}`).sort();
}

/** spawner 自己在 `Cargo.lock` 裡的名字，不算外部 crate。 */
const SELF = 'nexus-sandbox-spawner';

/** `Cargo.lock` 的一個 `[[package]]`。`checksum` 是 registry 上 `.crate` 檔的 SHA-256（十六進位），自己的 crate 沒有。 */
export interface LockedCrate {
  readonly name: string;
  readonly version: string;
  readonly checksum?: string;
}

/**
 * `Cargo.lock` 的 `[[package]]`，同名多版本各一列。
 *
 * @param text - `Cargo.lock` 全文。
 * @returns 依出現順序。
 */
export function lockedCrates(text: string): LockedCrate[] {
  const crates: LockedCrate[] = [];
  for (const block of text.split(/^\[\[package\]\]$/mu).slice(1)) {
    const name = /^name = "([^"]+)"$/mu.exec(block)?.[1];
    const version = /^version = "([^"]+)"$/mu.exec(block)?.[1];
    if (name === undefined || version === undefined) {
      throw new Error(`Cargo.lock 有一個 [[package]] 讀不出 name 或 version：${block.trim()}`);
    }
    const checksum = /^checksum = "([0-9a-f]{64})"$/mu.exec(block)?.[1];
    crates.push({ name, version, ...(checksum === undefined ? {} : { checksum }) });
  }
  return crates;
}

/**
 * 連進執行檔的 crate（{@link SPAWNER_CRATES} 標了 `runtime` 的），版本與 checksum 取自 `Cargo.lock`。
 *
 * @param lockText - `Cargo.lock` 全文。
 * @returns 依 `Cargo.lock` 的順序，同名多版本各一列。
 * @throws `Cargo.lock` 有讀不出 name 或 version 的 `[[package]]`。
 */
export function runtimeCrates(lockText: string): (LockedCrate & { license: string })[] {
  const runtime = new Map(
    SPAWNER_CRATES.filter((entry) => entry.runtime).map((entry) => [entry.name, entry.license]),
  );
  return lockedCrates(lockText).flatMap((entry) => {
    const license = runtime.get(entry.name);
    return license === undefined ? [] : [{ ...entry, license }];
  });
}

/**
 * 產物（或 bundle）裡附了授權全文的 crate：{@link SPAWNER_LICENSES_DIR} 底下除了 `rust-std/` 與 {@link SPAWNER_NATIVE_LIBS}
 * 之外的每個 `<名>-<版本>/`。跟 {@link runtimeCrates}
 * 是兩種獨立的列法：這一份來自 CI 的 `cargo tree`，那一份來自 {@link SPAWNER_CRATES} 與 `Cargo.lock`。
 *
 * @param root - 產物根。
 * @returns 依目錄名排序；目錄名拆不出版本的回 `version: ''`，讓核對報出來。
 */
export function bundledCrates(root: string): { name: string; version: string }[] {
  const dir = join(root, SPAWNER_LICENSES_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry !== 'rust-std' && !nativeLicenseDirs().includes(entry))
    .sort()
    .map((entry) => {
      const match = /^(.+)-(\d+\.\d+\.\d+\S*)$/u.exec(entry);
      return match === null
        ? { name: entry, version: '' }
        : { name: match[1] ?? entry, version: match[2] ?? '' };
    });
}

/**
 * 標準函式庫的版本：`rust-toolchain.toml` 釘住的 channel。
 *
 * @param text - `rust-toolchain.toml` 全文；省略即讀 repo 的。
 * @throws 讀不出 channel。
 */
export function rustChannel(
  text: string = readFileSync(join(ROOT, 'native/sandbox-spawner/rust-toolchain.toml'), 'utf8'),
): string {
  const channel = /^channel = "([^"]+)"$/mu.exec(text)?.[1];
  if (channel === undefined)
    throw new Error('native/sandbox-spawner/rust-toolchain.toml 讀不出 channel');
  return channel;
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

/**
 * 連進執行檔的 crate 在 bundle 裡的授權目錄名（`<名>-<版本>`），版本取自 `Cargo.lock`。
 *
 * @param lockText - `Cargo.lock` 全文。
 */
export function runtimeLicenseDirs(lockText: string): string[] {
  return runtimeCrates(lockText)
    .map((entry) => `${entry.name}-${entry.version}`)
    .sort();
}

/** ELF 的 `e_machine`，鍵是 `process.arch`。 */
const ELF_MACHINE: Readonly<Record<string, number>> = { x64: 62, arm64: 183 };

const ET_EXEC = 2;
const ET_DYN = 3;
const PT_INTERP = 3;

/**
 * 對執行檔本身的檢查：64 位元小端的 ELF、架構對、靜態連結（沒有 PT_INTERP，檔內也沒有 `GLIBC_<版本>` 字串），擋下動態連結的
 * gnu 版。x64 出貨，另外要是 static-pie（`ET_DYN`），位址才會隨機化；其他架構 `ET_EXEC` 與 `ET_DYN` 都收（aarch64 的 musl
 * target 不出 static-pie）。
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
  const types = arch === 'x64' ? [ET_DYN] : [ET_EXEC, ET_DYN];
  if (!types.includes(type)) {
    problems.push(
      arch === 'x64'
        ? `ELF 型別是 ${String(type)}，x64 要是 static-pie（${String(ET_DYN)}）`
        : `ELF 型別是 ${String(type)}，不是執行檔`,
    );
  }
  const machine = bytes.readUInt16LE(18);
  const expected = ELF_MACHINE[arch];
  if (expected === undefined) problems.push(`不認得目標架構 ${arch}`);
  else if (machine !== expected) {
    problems.push(`ELF 的架構是 ${String(machine)}，${arch} 應為 ${String(expected)}`);
  }
  const phoff = Number(bytes.readBigUInt64LE(32));
  const phentsize = bytes.readUInt16LE(54);
  const phnum = bytes.readUInt16LE(56);
  for (let index = 0; index < phnum; index += 1) {
    const at = phoff + index * phentsize;
    if (at + 4 > bytes.length) return [...problems, 'program header 超出檔案'];
    if (bytes.readUInt32LE(at) === PT_INTERP)
      problems.push('是動態連結（有 PT_INTERP），要靜態連結 musl');
  }
  const glibc = new Set(
    [...bytes.toString('latin1').matchAll(/GLIBC_[\d.]+/gu)].map((match) => match[0]),
  );
  if (glibc.size > 0)
    problems.push(`帶 glibc 的符號版本 ${[...glibc].sort().join('、')}，不是 musl 版`);
  return problems;
}

/**
 * 產物（或 bundle）裡的 spawner：執行檔在、有執行權限、{@link elfProblems} 通過，連進去的每個 crate、{@link SPAWNER_NATIVE_LIBS}
 * 與標準函式庫都附了授權全文，而且授權目錄不多不少。
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
  const crates = runtimeLicenseDirs(lockText);
  const expected = [...crates, ...nativeLicenseDirs()];
  const dir = join(root, SPAWNER_LICENSES_DIR);
  const present = existsSync(dir) ? readdirSync(dir).filter((name) => name !== 'rust-std') : [];
  for (const name of expected) {
    const path = join(dir, name);
    if (!existsSync(path) || readdirSync(path).length === 0) {
      problems.push({
        path: `${SPAWNER_LICENSES_DIR}/${name}`,
        message: crates.includes(name)
          ? '連進執行檔的 crate 缺授權全文'
          : '連進執行檔的 C 函式庫缺授權全文',
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
