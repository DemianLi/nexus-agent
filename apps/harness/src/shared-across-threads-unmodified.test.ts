/**
 * **一顆沒改過的插件，這一格抓得到真的串台**（[#1418](https://github.com/DemianLi/nexus-agent/issues/1418) 驗收 E）。
 *
 * `checkSharedAcrossThreads` 在 SDK 的測試裡用自己造的 `notebook` 驗過比對邏輯，在 ask-user 與 present 的
 * 套件裡驗過試點改完會過、改回去會紅。這一檔補最後一塊：**拿一顆還沒改寫的真插件跑，斷言它會紅**，而且訊息指名
 * 第幾步、哪條 thread。證明這一格量的是真插件的行為，不只是量得到測試裡的替身。
 *
 * 放在 `apps/harness`：harness 本來就相依所有插件，所以「沒列的插件一行不改」仍然成立。
 *
 * ## 為什麼選 system-prompt
 *
 * 它是 C 類（在 `apply` 當下就把逐條 thread 的值抓死）：`{{cwd}}` 等變數在掛載時代入、算成一份前後段，之後每次
 * 模型呼叫都用那一份。今天每條 thread 各組裝一次，沒事；一份服務兩條 thread 時，宿主只能交一組變數，**第二條
 * thread 的提示詞會長著第一條的 cwd**。這是結構上必然會紅的一顆，不靠哪個測試造的時序。
 *
 * ## 這是「尚未改寫」的釘子
 *
 * 日後 system-prompt 遷移、改成在每次模型呼叫當下依 thread 取變數時，這條要翻成 `toEqual([])`，**並換另一顆
 * 還沒改寫的插件**（`sandbox-policy`、`permission-presets` 同屬 C 類）接著釘。翻掉的那天看到這條紅，
 * 是遷移成功的訊號，不是壞了。
 */

import { createHostServicesPlugin, loadPlugins } from '@nexus/core';
import { createSystemPromptPlugin } from '@nexus/plugin-system-prompt';
import { checkSharedAcrossThreads } from '@nexus/sdk';
import type { ThreadStep } from '@nexus/sdk';
import { describe, expect, it } from 'vitest';

/** 兩條 thread 各自的工作目錄：提示詞裡 `{{cwd}}` 該代入的值。 */
const CWD_OF: Readonly<Record<string, string>> = { a: '/work/alpha', b: '/work/beta' };

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

/** 掛一份 system-prompt，變數由宿主交進來——**一份掛載只能交一組**，這正是共用時的處境。 */
async function mountSystemPrompt(cwd: string): Promise<Wrap> {
  const { registry } = await loadPlugins([
    createHostServicesPlugin({ systemPromptVariables: { model: 'gpt-x', cwd } }),
    createSystemPromptPlugin({
      includeHarnessIdentity: false,
      personaPrefix: '你在 {{cwd}} 工作。',
    }),
  ]);
  const entry = registry.middleware.list()[0];
  if (entry === undefined) throw new Error('system-prompt 沒有掛上 middleware');
  return (entry.value.middleware as unknown as { wrapModelCall: Wrap }).wrapModelCall;
}

describe('沒改過的 C 類插件在這一格會紅（#1418 驗收 E）', () => {
  it('system-prompt：共用一份時第二條 thread 的提示詞長著第一條的 cwd，訊息指名第幾步與哪條 thread', async () => {
    const failures = await checkSharedAcrossThreads<Wrap, string>({
      name: 'system-prompt',
      steps: STEPS,
      // 各自一份：綁一條就拿那一條的 cwd。共用一份：宿主只能交一組變數，只好是第一條的。
      mount: (threads) => mountSystemPrompt(CWD_OF[threads[0] ?? 'a'] ?? '/'),
      call: async (wrap, _thread, _input) => {
        let seen: Record<string, unknown> | undefined;
        await wrap({ systemPrompt: '' }, (next) => {
          seen = next;
          return undefined;
        });
        return { systemPrompt: seen?.['systemPrompt'] };
      },
    });

    // 紅，而且紅的是 b（a 剛好跟共用的那組變數同值）；兩次 b 的步驟（第 2、4 步）都要指名。
    expect(failures.map((f) => f.check)).toEqual(['parity', 'parity']);
    for (const [i, failure] of failures.entries()) {
      expect(failure.message).toContain('system-prompt');
      expect(failure.message).toContain(`第 ${String(i === 0 ? 2 : 4)} 步`);
      expect(failure.message).toContain('thread b');
      // 兩邊各回了什麼也在訊息裡：共用的那一份是 alpha，各自一份時是 beta。
      expect(failure.message).toContain('/work/alpha');
      expect(failure.message).toContain('/work/beta');
    }
  });
});
