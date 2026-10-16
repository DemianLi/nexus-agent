/**
 * **一顆沒改過的插件，這一格抓得到真的串台**（[#1418](https://github.com/DemianLi/nexus-agent/issues/1418) 驗收 E）。
 *
 * `checkSharedAcrossThreads` 在 SDK 的測試裡用自己造的 `notebook` 驗過比對邏輯，在 ask-user 與 present 的
 * 套件裡驗過試點改完會過、改回去會紅。這一檔補最後一塊：**拿一顆還沒改寫的真插件跑，斷言它會紅**，而且訊息指名
 * 第幾步、哪條 thread。證明這一格量的是真插件的行為，不只是量得到測試裡的替身。
 *
 * 放在 `apps/harness`：harness 本來就相依所有插件，所以「沒列的插件一行不改」仍然成立。
 *
 * ## 為什麼選 sandbox-policy
 *
 * 它是 C 類（在 `apply` 當下就把逐條 thread 的值抓死）：`apply` 讀 `sandboxPolicy` 服務的控制器，把它的 `source` 閉包進 middleware，
 * 之後每次模型呼叫都問那一顆控制器。今天每條 thread 各組裝一次，沒事；一份服務兩條 thread 時，宿主只能交一顆控制器，**第二條 thread
 * 的提示詞會講著第一條的檔案政策**。這是結構上必然會紅的一顆，不靠哪個測試造的時序。
 *
 * ## 這是「尚未改寫」的釘子，而且 system-prompt 是已經翻過去的那一顆（#1477）
 *
 * 前一顆釘的是 system-prompt。它遷上樹之後，共用的東西是**快照**（`assemble()` 回的各段原文與變數名，純資料），逐條 thread 的值
 * （`model`、`cwd`）在每條 thread 自己那顆 `nexusSystemPrompt` middleware 建立時才代入——所以這一格對它是綠的，下面第二條釘住「翻成綠」。
 * 日後 sandbox-policy 遷移、改成在每次模型呼叫當下依 thread 取控制器時，第一條要翻成 `toEqual([])`，**並換另一顆還沒改寫的插件**
 * （`permission-presets` 同屬 C 類）接著釘。翻掉的那天看到這條紅，是遷移成功的訊號，不是壞了。
 */

import { loadPlugins } from '@nexus/core';
import * as systemPromptModule from '@nexus/plugin-system-prompt';
import {
  CONTAINED_FILESYSTEM,
  createSandboxPolicyPlugin,
  SandboxModeController,
} from '@nexus/plugin-sandbox-policy';
import { checkSharedAcrossThreads } from '@nexus/sdk';
import type { ThreadStep } from '@nexus/sdk';
import type { SystemPromptAssembly } from '@nexus/system-prompt';
import { describe, expect, it } from 'vitest';

import { mountDetached } from './plugin-tree.js';
import { createSystemPromptMiddleware } from './system-prompt-middleware.js';

/** 兩條 thread 各自的工作目錄：提示詞裡 `{{cwd}}` 該代入的值。 */
const CWD_OF: Readonly<Record<string, string>> = { a: '/work/alpha', b: '/work/beta' };

/** 兩條 thread 各自的檔案政策。 */
const MODE_OF = { a: 'read-only', b: 'workspace-write' } as const;

/** 交錯：a, b, a, b。 */
const STEPS: readonly ThreadStep<string>[] = [
  { thread: 'a', input: '第一輪' },
  { thread: 'b', input: '第一輪' },
  { thread: 'a', input: '第二輪' },
  { thread: 'b', input: '第二輪' },
];

type Wrap = (
  request: Record<string, unknown>,
  handler: (request: Record<string, unknown>) => unknown,
) => unknown;

/** 把一個空請求交給 wrapModelCall，回傳它往下傳的 `systemPrompt`。 */
async function systemPromptOf(wrap: Wrap): Promise<{ systemPrompt: unknown }> {
  let seen: Record<string, unknown> | undefined;
  await wrap({ systemPrompt: '' }, (next) => {
    seen = next;
    return undefined;
  });
  return { systemPrompt: seen?.['systemPrompt'] };
}

/** 掛一份 sandbox-policy，控制器由宿主交進來——**一份掛載只能交一顆**，這正是共用時的處境。 */
async function mountSandboxPolicy(mode: 'read-only' | 'workspace-write'): Promise<Wrap> {
  const { registry } = await loadPlugins([
    {
      plugin: {
        name: 'sandbox-host',
        apply(host) {
          host.services.provide('fsContainment', CONTAINED_FILESYSTEM);
          host.services.provide('sandboxPolicy', {
            controller: new SandboxModeController(mode),
            rootDir: '/tmp/unused',
          });
        },
      },
    },
    createSandboxPolicyPlugin(),
  ]);
  const entry = registry.middleware
    .list()
    .find((item) => (item.value.middleware as { name?: string }).name === 'nexusSandboxPolicy');
  if (entry === undefined) throw new Error('sandbox-policy 沒有掛上 middleware');
  return (entry.value.middleware as unknown as { wrapModelCall: Wrap }).wrapModelCall;
}

describe('沒改過的 C 類插件在這一格會紅（#1418 驗收 E）', () => {
  it('sandbox-policy：共用一份時第二條 thread 的提示詞講著第一條的檔案政策，訊息指名第幾步與哪條 thread', async () => {
    const failures = await checkSharedAcrossThreads<Wrap, string>({
      name: 'sandbox-policy',
      steps: STEPS,
      // 各自一份：綁一條就拿那一條的政策。共用一份：宿主只能交一顆控制器，只好是第一條的。
      mount: (threads) => mountSandboxPolicy(MODE_OF[(threads[0] ?? 'a') as 'a' | 'b']),
      call: (wrap) => systemPromptOf(wrap),
    });

    // 紅，而且紅的是 b（a 剛好跟共用的那顆控制器同值）；兩次 b 的步驟（第 2、4 步）都要指名。
    expect(failures.map((f) => f.check)).toEqual(['parity', 'parity']);
    for (const [i, failure] of failures.entries()) {
      expect(failure.message).toContain('sandbox-policy');
      expect(failure.message).toContain(`第 ${String(i === 0 ? 2 : 4)} 步`);
      expect(failure.message).toContain('thread b');
      // 兩邊各回了什麼也在訊息裡：共用的那一份是 read-only，各自一份時是 workspace-write。
      expect(failure.message).toContain('read-only');
      expect(failure.message).toContain('workspace-write');
    }
  });
});

describe('system-prompt 這一格是綠的（#1477：翻成 toEqual([])）', () => {
  it('共用的是快照：兩條 thread 各建自己那顆 nexusSystemPrompt，{{cwd}} 各是各的；量的是宿主那一顆，不是 registry.middleware.list()[0]', async () => {
    const failures = await checkSharedAcrossThreads<SystemPromptAssembly, string>({
      name: 'system-prompt',
      steps: STEPS,
      // 掛載：真的把 system-prompt 那一列單獨掛一次，取快照。共用時兩條 thread 用的是同一份快照物件。
      mount: async () => {
        const contributions = await mountDetached({
          id: 'system-prompt',
          module: systemPromptModule,
          provides: ['systemPrompt'],
          config: {
            includeHarnessIdentity: false,
            personaPrefix: '你在 {{cwd}} 工作。',
          },
        });
        if (contributions.systemPrompt === undefined) throw new Error('system-prompt 沒有取到快照');
        return contributions.systemPrompt;
      },
      // 呼叫：這條 thread 自己的預設值（`cwd`）建自己的 middleware——跟 `registerFolded` 逐條 thread 做的是同一件事。
      call: async (snapshot, thread) => {
        const middleware = createSystemPromptMiddleware(snapshot, {
          model: 'gpt-x',
          cwd: CWD_OF[thread] ?? '/',
        });
        if (middleware === undefined) throw new Error('不該是不掛');
        return systemPromptOf((middleware as unknown as { wrapModelCall: Wrap }).wrapModelCall);
      },
    });
    expect(failures).toEqual([]);
  });
});
