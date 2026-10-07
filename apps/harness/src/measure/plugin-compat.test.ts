/**
 * 新版插件與執行中的 core 不相容時，今天會怎樣——[#1137](https://github.com/DemianLi/nexus-agent/issues/1137) 的實測。
 *
 * 「不相容」有三種形狀，各一個替身插件：**宣告要一個執行中的 core 沒有的能力**（`requires`）、**呼叫 registry 上不存在的方法**、
 * **什麼都不宣告、悄悄用了新語意**。前兩種走產品的 `loadPlugins`（整份失敗與逐列掉兩條路都量），第三種釘的是「今天沒有東西攔它」。
 * 最後一段是一個**原型**：dsh 的做法（插件 manifest 的 peer 範圍對執行中的版本，在 import 之前判）搬過來能不能做到，
 * 原型只住在這個測試裡，不是產品碼。
 *
 * 載入前置的量法：替身的 `apply` 與模組主體都會留記號，才分得出「在載入前被擋」與「apply 跑了才發現」。
 */

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tool } from '@langchain/core/tools';
import { loadPlugins } from '@nexus/core';
import type { NexusPlugin, PluginEntry } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { resolveEntryModule } from '../plugin-config.js';

const probeTool = (name: string, reply: string) =>
  tool(() => reply, { name, description: name, schema: z.object({}) });

interface Marks {
  applied: string[];
  disposed: string[];
}

/** 一顆正常的插件：註冊一個工具、登記一個關機清理。 */
function goodPlugin(name: string, marks: Marks): NexusPlugin {
  return {
    name,
    apply(registry) {
      marks.applied.push(name);
      registry.tools.register(probeTool(`${name}_tool`, `${name} 在`));
      registry.lifecycle.onDispose(() => {
        marks.disposed.push(name);
      });
    },
  };
}

/** 宣告要一個執行中的 core 沒有的能力（新版 core 才提供的那種）。 */
function needsNewCapability(marks: Marks): NexusPlugin {
  return {
    name: 'needs-new-capability',
    requires: ['core-v2-scheduler'],
    apply(registry) {
      marks.applied.push('needs-new-capability');
      registry.tools.register(probeTool('needs_new_tool', 'x'));
    },
  };
}

/** 呼叫 registry 上不存在的方法（新版 core 才有的註冊點）。 */
function callsMissingMethod(marks: Marks): NexusPlugin {
  return {
    name: 'calls-missing-method',
    apply(registry) {
      marks.applied.push('calls-missing-method');
      registry.tools.register(probeTool('half_registered_tool', 'x'));
      (registry as unknown as { schedulers: { register(x: unknown): void } }).schedulers.register(
        {},
      );
    },
  };
}

/** 載入應該失敗；成功了就是測試要紅。 */
async function failure(loading: ReturnType<typeof loadPlugins>): Promise<Error> {
  try {
    await (await loading).dispose();
  } catch (error) {
    return error as Error;
  }
  throw new Error('預期載入失敗，它卻成功了');
}

const entry = (plugin: NexusPlugin, id: string): PluginEntry => ({ plugin, id });
const marks = (): Marks => ({ applied: [], disposed: [] });

describe('不相容的插件今天怎麼失敗', () => {
  it('宣告要沒有的能力：整份載入失敗，訊息指名插件與缺的能力，但它的 apply 已經跑過', async () => {
    const m = marks();
    const error = await failure(
      loadPlugins([entry(goodPlugin('good', m), 'good'), entry(needsNewCapability(m), 'v2')]),
    );
    expect(error.message).toContain('v2 (needs-new-capability) 需要能力 "core-v2-scheduler"');
    // **不是載入前被擋**：要全部 apply 完才查 requires，不相容的那一顆自己的 apply 已經跑了。
    expect(m.applied).toEqual(['good', 'needs-new-capability']);
    // 失敗時先前成功的插件開的活資源有收。
    expect(m.disposed).toEqual(['good']);
    // 訊息裡沒有任何版本字樣——今天沒有版本可以講。
    expect(error.message).not.toMatch(/版本|version/iu);
  });

  it('逐列掉模式（serve 的選配路徑）：只掉那一列，其餘照樣掛上', async () => {
    const m = marks();
    const result = await loadPlugins(
      [entry(goodPlugin('good', m), 'good'), entry(needsNewCapability(m), 'v2')],
      undefined,
      { perEntry: true },
    );
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]).toMatchObject({ stage: 'requires', origin: { id: 'v2' } });
    expect(result.registry.tools.resolve('good_tool')).toBeDefined();
    expect(result.registry.tools.resolve('needs_new_tool')).toBeUndefined();
    await result.dispose();
  });

  it('呼叫不存在的方法：apply 拋 TypeError，訊息指名插件但講不出是版本問題；註冊的東西已撤乾淨', async () => {
    const m = marks();
    const error = await failure(
      loadPlugins([entry(goodPlugin('good', m), 'good'), entry(callsMissingMethod(m), 'v2')]),
    );
    expect(error.message).toContain('v2 (calls-missing-method) 的 apply 失敗');
    expect(error.message).toMatch(/Cannot read properties of undefined/u);
    expect(error.message).not.toMatch(/版本|version|core/iu);
    expect(m.disposed).toEqual(['good']);
  });

  it('什麼都不宣告、用了新版才認得的選項：照樣載入成功，選項被安靜吞掉，沒有任何東西攔', async () => {
    const quiet: NexusPlugin = {
      name: 'quiet-new-semantics',
      apply(registry) {
        // 假想新版 core 的 `register` 多了一個選項；舊 core 不認得，也不報。
        registry.tools.register(probeTool('quiet_tool', 'x'), { futureOption: true } as never);
      },
    };
    const result = await loadPlugins([entry(quiet, 'v2')]);
    expect(result.registry.tools.resolve('quiet_tool')).toBeDefined();
    await result.dispose();
  });

  it('載入失敗不碰已在跑的 thread：另一份 registry 的工具照常呼叫、清理照常留著', async () => {
    const running = marks();
    const thread = await loadPlugins([entry(goodPlugin('running', running), 'running')]);
    const failing = marks();
    await loadPlugins([entry(needsNewCapability(failing), 'v2')]).catch(() => undefined);
    const resolved = thread.registry.tools.resolve('running_tool');
    expect(resolved).toBeDefined();
    expect(await resolved!.value.invoke({})).toBe('running 在');
    expect(running.disposed).toEqual([]);
    await thread.dispose();
    expect(running.disposed).toEqual(['running']);
  });
});

/**
 * **原型（不是產品碼）**：照 dsh `packages/boot/app-boot/src/plugin-compatibility.ts` 的形狀——只讀插件 manifest 的
 * `peerDependencies['@nexus/core']`，對執行中的 core 版本，**在 import 之前**判。這裡的範圍只認 `>=X.Y.Z`，
 * 真要做得用 `semver`（dsh 就是；本 repo 目前只在傳遞相依裡有它）。
 */
async function checkPeerBeforeImport(
  packageDir: string,
  runtimeVersion: string,
): Promise<string | undefined> {
  const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    peerDependencies?: Record<string, string>;
  };
  const range = manifest.peerDependencies?.['@nexus/core'];
  if (range === undefined) return undefined;
  const min = /^>=(\d+)\.(\d+)\.(\d+)$/u.exec(range);
  if (min === null)
    return `${manifest.name}@${manifest.version} 的 peer 範圍 ${range} 這個原型不認得`;
  const need = [Number(min[1]), Number(min[2]), Number(min[3])];
  const have = runtimeVersion.split('.').map(Number);
  const ok =
    have[0]! > need[0]! ||
    (have[0] === need[0] && (have[1]! > need[1]! || (have[1] === need[1] && have[2]! >= need[2]!)));
  return ok
    ? undefined
    : `${manifest.name}@${manifest.version} 需要 @nexus/core ${range}，執行中的是 ${runtimeVersion}`;
}

describe('原型：照 dsh 在 import 之前判 peer 範圍', () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = undefined;
    delete (globalThis as { __compatProbeImported?: string[] }).__compatProbeImported;
  });

  async function pluginDir(version: string, peer: string): Promise<string> {
    root ??= await mkdtemp(join(await realpath('/var/tmp'), 'nexus-compat-'));
    const dir = join(root, version);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'demo-plugin',
        version,
        type: 'module',
        peerDependencies: { '@nexus/core': peer },
      }),
    );
    await writeFile(
      join(dir, 'index.mjs'),
      `(globalThis.__compatProbeImported ??= []).push(${JSON.stringify(version)});\n` +
        "export default { name: 'demo', apply() {} };\n",
    );
    return dir;
  }

  it('不相容：在 import 之前被擋，模組主體沒跑，訊息指名套件、版本、範圍與執行中的版本', async () => {
    const dir = await pluginDir('2.0.0', '>=2.0.0');
    const reason = await checkPeerBeforeImport(dir, '1.4.0');
    expect(reason).toBe('demo-plugin@2.0.0 需要 @nexus/core >=2.0.0，執行中的是 1.4.0');
    expect(
      (globalThis as { __compatProbeImported?: string[] }).__compatProbeImported,
    ).toBeUndefined();
  });

  it('相容：放行，之後才 import', async () => {
    const dir = await pluginDir('1.1.0', '>=1.2.0');
    expect(await checkPeerBeforeImport(dir, '1.4.0')).toBeUndefined();
    await resolveEntryModule({ name: pathToFileURL(join(dir, 'index.mjs')).href });
    expect((globalThis as { __compatProbeImported?: string[] }).__compatProbeImported).toEqual([
      '1.1.0',
    ]);
  });
});
