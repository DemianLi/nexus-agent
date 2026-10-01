/**
 * **出貨清單上的每一列，在自己的 `apply` 當下讀的服務都由組裝點提供**——守 `apps/harness/cordis.yml`
 * 「順序不承載語意」的服務那一半（[#687](https://github.com/DemianLi/nexus-agent/issues/687) 第 2 步）。
 *
 * 載入是一趟到底的（`@nexus/core` 的 `ServiceRegistrationPoint` 偏離登記）：`apply` 當下讀一個由**另一列
 * plugin** 提供的服務，順序就變成承重的——排在提供者前面，`use` 當場拋、`get` 靜靜回 `undefined`。今天
 * 沒有這種相依，因為組裝點的 host-services 一律排在清單最前面；這一條把「今天沒有」釘住。真的出現的
 * 那天，偏離登記留著要決定的是拓撲排序還是照 dsh 做成惰性——**不是**把這裡的允許名單加一筆。
 *
 * 只加測試，不加執行期機制。量法：走產品組裝（`createCliAgent`，帶 `--workspace`，host-services 提供的
 * 服務最多的那一條），把出貨清單每一列的 `apply` 包一層，記下它在 `apply` 當下經 `services.get`／
 * `services.use` 讀的名字，以及**那一刻**是誰提供的。
 *
 * **包在原物件上，不換物件**：`createCliAgent` 靠 plugin 物件的身分從清單裡找設定列（`startupSetting`），
 * 換成新物件的話那幾列會找不到。
 *
 * 核准閘門那一半（順序由載入順序決定）不在這裡，守它的是 `approval-gate-order.test.ts`。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`，工作區是暫存目錄。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NexusPlugin, PluginEntry, PluginRegistry } from '@nexus/core';
import { GOALS_SERVICE } from '@nexus/plugin-goal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { shippedPlugins } from './fixtures.js';

const shipped = await shippedPlugins();

/**
 * 組裝點交協作者的那幾個條目的 plugin 名：`assembly-root.ts` 的 `host-services`，`agent-factory.ts` 的
 * `system-prompt-variables` 與 `fs`。改了名字這一條會紅（讀到的服務找不到認得的提供者）——那是安全的方向。
 */
const HOST_ENTRY_NAMES = new Set(['host-services', 'system-prompt-variables', 'fs']);

/** 一次 `apply` 當下的讀取：誰讀、讀哪個名字、那一刻誰提供。 */
interface ServiceRead {
  readonly reader: string;
  readonly service: string;
  readonly provider: string | undefined;
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nexus-shipped-service-reads-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

/**
 * 把一列的 `apply` 包一層：`apply` 跑的那段時間裡經 `services` 讀的名字記進 `reads`。`apply` 之後
 * （工具被叫時）的讀取不算，那時載入已經結束，順序管不到它。
 */
function watch(plugin: NexusPlugin<unknown>, reads: ServiceRead[]): void {
  // 清單上的 plugin 各有各的設定型別，這裡只轉手，所以退到 `unknown`。
  const target = plugin as unknown as {
    apply(registry: PluginRegistry, config: unknown): void | Promise<void>;
  };
  const original = target.apply.bind(target);
  vi.spyOn(target, 'apply').mockImplementation((registry: PluginRegistry, config: unknown) => {
    let applying = true;
    const record = (service: string) => {
      if (!applying) return;
      reads.push({
        reader: plugin.name,
        service,
        provider: registry.services.provider(service)?.name,
      });
    };
    const services: PluginRegistry['services'] = {
      ...registry.services,
      get: ((name: string) => {
        record(name);
        return registry.services.get(name);
      }) as PluginRegistry['services']['get'],
      use: ((name: string) => {
        record(name);
        return registry.services.use(name);
      }) as PluginRegistry['services']['use'],
    };
    const spied = new Proxy(registry, {
      get: (target, key) => (key === 'services' ? services : Reflect.get(target, key, target)),
    });
    try {
      return original(spied, config);
    } finally {
      applying = false;
    }
  });
}

/** 讀到的服務不是由組裝點的 host-services 提供的那幾筆（含沒人提供的）。 */
function straysOf(reads: readonly ServiceRead[]): ServiceRead[] {
  return reads.filter(
    (read) => read.provider === undefined || !HOST_ENTRY_NAMES.has(read.provider),
  );
}

/** 走一次產品組裝，回出貨清單每一列在 `apply` 當下的讀取。 */
async function readsOf(plugins: readonly PluginEntry[]): Promise<ServiceRead[]> {
  const reads: ServiceRead[] = [];
  for (const plugin of new Set(plugins.map((entry) => entry.plugin))) watch(plugin, reads);
  const built = await createCliAgent({ live: false, workspace: root }, plugins, root);
  await built.dispose();
  return reads;
}

describe('出貨清單在 apply 當下讀的服務', () => {
  it('每一個都由組裝點的 host-services 提供，沒有 plugin → plugin 的服務相依', async () => {
    const reads = await readsOf(shipped);
    // 前提：真的量到了讀取（`system-prompt` 那一列讀 `systemPromptVariables`，#720）。空陣列也「全部合格」。
    expect(reads.map((read) => read.service)).toContain('systemPromptVariables');
    expect(straysOf(reads)).toEqual([]);
  }, 20000);

  /**
   * 對照：一列在 `apply` 當下讀另一列 plugin 提供的服務（`goals` 由清單上的 goal 那一列提供），
   * 這一條要紅——排在 goal 前面讀到的是 `undefined`，排在後面讀到的提供者是 goal 自己，兩種都不是 host-services。
   */
  it.each([
    ['排在提供者前面', 'first'],
    ['排在提供者後面', 'last'],
  ] as const)(
    '對照：讀別列提供的服務（%s）會被抓出來',
    async (_label, where) => {
      const probe: NexusPlugin = {
        name: 'goals-reader',
        apply(registry) {
          registry.services.get(GOALS_SERVICE);
        },
      };
      const entry: PluginEntry = { plugin: probe };
      const reads = await readsOf(where === 'first' ? [entry, ...shipped] : [...shipped, entry]);
      expect(straysOf(reads)).toEqual([
        {
          reader: 'goals-reader',
          service: GOALS_SERVICE,
          provider: where === 'first' ? undefined : 'goal',
        },
      ]);
    },
    20000,
  );
});
