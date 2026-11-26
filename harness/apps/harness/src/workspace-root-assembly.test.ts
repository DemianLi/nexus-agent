/**
 * 組裝點拿到的可寫根是入口交進來的那一個（[#1774](https://github.com/DemianLi/nexus-agent/issues/1774)）：`createCliAgent` 的 `workspaceRoot` 選填，
 * 有給就用給的、沒給才從 `--workspace` 算（所以手上只有 `--workspace` 的呼叫端與大量既有測試行為不變）。
 *
 * 這一檔量**組裝點內部的幾格**（産品入口的接線見 `workspace-root-per-thread.test.ts`，從 `runServe` 起量）：
 * host 服務 `workspaceRoot`、`sandboxPolicy.rootDir`、fs 把手的 `workspaceRoot()`（fold 當下填）與回傳值。
 *
 * 突變：`assembly-root.ts` 讀根那一行拿掉 `invocation.workspaceRoot ??` → 「有給就用給的」那一條紅，「沒給退回 --workspace」那一條仍綠。
 *
 * **零憑證、零外部連線**：假模型，目錄都在 `/var/tmp`。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { FsService, PluginEntry } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { shippedPlugins } from './fixtures.js';

const shipped = await shippedPlugins();
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join('/var/tmp', prefix));
  roots.push(dir);
  return dir;
}

interface Seen {
  workspaceRoot: unknown;
  sandboxPolicyRootDir: unknown;
  fs: FsService | undefined;
}

/** 一顆只讀不寫的探針：`apply` 當下把組裝點提供的 host 服務抄下來（host 服務插件排在最前面）。 */
function probe(): { entry: PluginEntry; seen: Seen } {
  const seen: Seen = { workspaceRoot: undefined, sandboxPolicyRootDir: undefined, fs: undefined };
  return {
    seen,
    entry: {
      plugin: {
        name: 'workspace-root-probe',
        apply(registry) {
          seen.workspaceRoot = registry.services.get('workspaceRoot');
          seen.sandboxPolicyRootDir = (
            registry.services.get('sandboxPolicy') as { rootDir?: unknown } | undefined
          )?.rootDir;
          seen.fs = registry.services.get('fs') as FsService | undefined;
        },
      },
    },
  };
}

describe('createCliAgent 的 workspaceRoot', () => {
  it('有給：host 服務 workspaceRoot、sandboxPolicy.rootDir、fs 把手與回傳值都是給的那一個，不是 --workspace 的', async () => {
    const launch = await scratch('nexus-root-assembly-d-');
    const given = await scratch('nexus-root-assembly-x-');
    const { entry, seen } = probe();
    const built = await createCliAgent(
      { live: false, workspace: launch, workspaceRoot: given },
      [...shipped, entry],
      launch,
    );
    try {
      expect(built.workspaceRoot).toBe(given);
      expect(seen.workspaceRoot).toBe(given);
      expect(seen.sandboxPolicyRootDir).toBe(given);
      expect(seen.fs?.workspaceRoot()).toBe(given);
    } finally {
      await built.dispose();
    }
  });

  it('沒給：退回 --workspace 解析出來的根（手上只有 --workspace 的呼叫端行為不變）', async () => {
    const launch = await scratch('nexus-root-assembly-d-');
    const { entry, seen } = probe();
    const built = await createCliAgent(
      { live: false, workspace: launch },
      [...shipped, entry],
      launch,
    );
    try {
      expect(built.workspaceRoot).toBe(launch);
      expect(seen.workspaceRoot).toBe(launch);
      expect(seen.sandboxPolicyRootDir).toBe(launch);
      expect(seen.fs?.workspaceRoot()).toBe(launch);
    } finally {
      await built.dispose();
    }
  });

  it('沒有 --workspace 也沒給根：沒有圍堵，fs 把手的根是 undefined', async () => {
    const cwd = await scratch('nexus-root-assembly-cwd-');
    const { entry, seen } = probe();
    const built = await createCliAgent({ live: false }, [...shipped, entry], cwd);
    try {
      expect(built.workspaceRoot).toBeUndefined();
      expect(seen.workspaceRoot).toBeUndefined();
      expect(seen.fs?.workspaceRoot()).toBeUndefined();
    } finally {
      await built.dispose();
    }
  });
});
