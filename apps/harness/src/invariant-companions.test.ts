/**
 * 九個 package 的配套入口：**子路徑解析**與**包名歸屬**。
 *
 * 這個檔案住在 `@nexus/harness` 不是為了方便——**它是唯一同時相依九個套件的地方**，
 * 而這兩條都需要九個一起在場才驗得到。
 *
 * 兩條各擋一種缺陷，而且都不是形式：
 *
 * 1. **子路徑解析**：底下一律從 specifier（`@nexus/plugin-echo/invariant`）import，
 *    **不是相對路徑**。用相對路徑寫，`exports` 那格接錯了測試照樣綠——那就變成
 *    一條不驗它宣稱在驗的東西的測試。
 * 2. **包名歸屬**：八個檔案長得幾乎一樣，最可能的缺陷就是 `PACKAGE_NAME` 抄錯一個。
 *    九個一起掛上去，撞名會當場拋，名字錯了則會在下面的逐一比對裡露出來。
 *
 * 八個空 installer 為什麼是正確結果（subject 裡只有 `@nexus/core` 的日誌，別的包在裡面
 * 找不到屬於自己的關係），見任何一個 `packages/<name>/src/invariant.ts` 的檔頭。
 */

import { describe, expect, it } from 'vitest';

import { createRegistry, SessionLog } from '@nexus/core';
import type { NexusPlugin } from '@nexus/core';
import { createCoreInvariantPlugin, CORE_INVARIANT_PACKAGE } from '@nexus/core/invariant';
import { createEchoInvariantPlugin, ECHO_INVARIANT_PACKAGE } from '@nexus/plugin-echo/invariant';
import { createMcpInvariantPlugin, MCP_INVARIANT_PACKAGE } from '@nexus/plugin-mcp/invariant';
import {
  createMemoryInvariantPlugin,
  MEMORY_INVARIANT_PACKAGE,
} from '@nexus/plugin-memory/invariant';
import {
  createQuickJsInvariantPlugin,
  QUICKJS_INVARIANT_PACKAGE,
} from '@nexus/plugin-quickjs/invariant';
import {
  createSkillsInvariantPlugin,
  SKILLS_INVARIANT_PACKAGE,
} from '@nexus/plugin-skills/invariant';
import {
  createTelemetryOtelInvariantPlugin,
  TELEMETRY_OTEL_INVARIANT_PACKAGE,
} from '@nexus/plugin-telemetry-otel/invariant';
import {
  createValidationInvariantPlugin,
  VALIDATION_INVARIANT_PACKAGE,
} from '@nexus/plugin-validation/invariant';
import { createWireInvariantPlugin, WIRE_INVARIANT_PACKAGE } from '@nexus/wire/invariant';

/**
 * 九個配套入口，配上各自**應該**認領的包名。
 *
 * 右邊那一欄刻意寫死字串而不是引用左邊那個常數——常數抄錯了，拿常數自己比自己
 * 是驗不出來的。
 */
const COMPANIONS: readonly (readonly [() => NexusPlugin, string, string])[] = [
  [createCoreInvariantPlugin, CORE_INVARIANT_PACKAGE, '@nexus/core'],
  [createEchoInvariantPlugin, ECHO_INVARIANT_PACKAGE, '@nexus/plugin-echo'],
  [createMcpInvariantPlugin, MCP_INVARIANT_PACKAGE, '@nexus/plugin-mcp'],
  [createMemoryInvariantPlugin, MEMORY_INVARIANT_PACKAGE, '@nexus/plugin-memory'],
  [createQuickJsInvariantPlugin, QUICKJS_INVARIANT_PACKAGE, '@nexus/plugin-quickjs'],
  [createSkillsInvariantPlugin, SKILLS_INVARIANT_PACKAGE, '@nexus/plugin-skills'],
  [
    createTelemetryOtelInvariantPlugin,
    TELEMETRY_OTEL_INVARIANT_PACKAGE,
    '@nexus/plugin-telemetry-otel',
  ],
  [createValidationInvariantPlugin, VALIDATION_INVARIANT_PACKAGE, '@nexus/plugin-validation'],
  [createWireInvariantPlugin, WIRE_INVARIANT_PACKAGE, '@nexus/wire'],
];

describe('子路徑解析', () => {
  it('九個 `<pkg>/invariant` 都 import 得到，而且各自吐出一個 plugin', () => {
    for (const [factory] of COMPANIONS) {
      const plugin = factory();
      expect(typeof plugin.apply).toBe('function');
      expect(plugin.name).toMatch(/-invariant$/);
    }
  });

  it('包名常數與這個套件在 workspace 裡的真名一致', () => {
    for (const [, constant, literal] of COMPANIONS) {
      expect(constant).toBe(literal);
    }
  });
});

describe('包名歸屬', () => {
  it('九個一起掛上去，各自認領自己那個名字，一個都不撞', () => {
    const registry = createRegistry();
    for (const [index, [factory]] of COMPANIONS.entries()) {
      const plugin = factory();
      const exit = registry.enter({ index, name: plugin.name });
      plugin.apply(registry);
      exit();
    }

    const claimed = registry.invariants.companions().map((entry) => entry.packageName);
    expect([...claimed].sort()).toEqual([...COMPANIONS.map(([, , name]) => name)].sort());
    expect(new Set(claimed).size).toBe(COMPANIONS.length);
  });

  it('八個空 installer 一個檢查都不裝——掛滿九個只有 core 觀察得到東西', () => {
    const registry = createRegistry();
    for (const [index, [factory]] of COMPANIONS.entries()) {
      const plugin = factory();
      const exit = registry.enter({ index, name: plugin.name });
      plugin.apply(registry);
      exit();
    }

    // 每個 installer 都跑一次，數它掛了幾個觀察者。只有 `@nexus/core` 該掛出東西。
    const observerCount = new Map<string, number>();
    for (const companion of registry.invariants.companions()) {
      let count = 0;
      companion.installer(
        {
          // 給真的日誌，不是 `undefined as never`：型別上騙得過去，但空 installer
          // 有沒有偷碰 subject 就驗不到了。
          log: new SessionLog('invariant-companions'),
          observe: () => {
            count += 1;
          },
        },
        (message) => {
          throw new Error(`安裝期不該有違規：${message}`);
        },
      );
      observerCount.set(companion.packageName, count);
    }

    expect(observerCount.get('@nexus/core')).toBe(1);
    for (const [, , name] of COMPANIONS) {
      if (name === '@nexus/core') continue;
      expect(observerCount.get(name)).toBe(0);
    }
  });
});
