/**
 * `build-version` 預設探針起的 git：清洗過的環境與逾時（[#1620](https://github.com/DemianLi/nexus-agent/issues/1620)）。
 *
 * `PATH` 最前面放一支假的 `git`，跑的是真的 `readGitProvenance()`（預設探針）：量的是我們交給子行程的東西，
 * 不是注入的探針。
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GIT_PROBE_TIMEOUT_MS, readGitProvenance } from './build-version.js';

let bin: string;

beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), 'nexus-1620-git-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(bin, { recursive: true, force: true });
});

/** 在 `bin` 放一支假 `git`，並把 `bin` 排到 `PATH` 最前面。 */
function fakeGit(script: string): void {
  const path = join(bin, 'git');
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  vi.stubEnv('PATH', `${bin}${delimiter}${process.env['PATH'] ?? ''}`);
}

describe.skipIf(process.platform === 'win32')('預設探針起的 git', () => {
  it('環境是清洗過的：名字像憑證的與 NEXUS_* 都不交出去，帶上 GIT_OPTIONAL_LOCKS=0', () => {
    const seen = join(bin, 'env.txt');
    fakeGit(`env > '${seen}'\nexit 1`);
    vi.stubEnv('FAKE_1620_API_KEY', 'fake-value');
    vi.stubEnv('NEXUS_1620_MARKER', 'marker');

    expect(readGitProvenance()).toEqual({ commit: null, dirty: null });
    const env = readFileSync(seen, 'utf8');
    // 前提：跑的真的是這支假 git，而且 PATH 照留。
    expect(env).toContain(`PATH=${bin}${delimiter}`);
    expect(env).not.toContain('FAKE_1620_API_KEY');
    expect(env).not.toContain('NEXUS_1620_MARKER');
    expect(env).toMatch(/^GIT_OPTIONAL_LOCKS=0$/mu);
    expect(env).toMatch(/^GIT_TERMINAL_PROMPT=0$/mu);
    expect(env).toMatch(/^GIT_CONFIG_COUNT=0$/mu);
  });

  it('卡住的 git 到逾時就被殺（忽略 SIGTERM 的也一樣），記 null；不早於逾時，也不拖到它自己結束', () => {
    // 只讓 `rev-parse` 卡住、`status` 立刻失敗，總耗時壓在一次逾時左右。`exec` 讓被殺的就是 sleep 本身，不留孫行程。
    fakeGit('case "$1" in rev-parse) trap "" TERM; exec sleep 20;; esac\nexit 1');
    const started = performance.now();
    const provenance = readGitProvenance();
    const elapsed = performance.now() - started;

    expect(provenance).toEqual({ commit: null, dirty: null });
    expect(elapsed).toBeGreaterThanOrEqual(GIT_PROBE_TIMEOUT_MS);
    expect(elapsed).toBeLessThan(GIT_PROBE_TIMEOUT_MS + 3_000);
  }, 30_000);
});
