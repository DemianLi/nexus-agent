/**
 * 二十個 package 的配套入口：**子路徑解析**、**包名歸屬**，以及**這份表格有沒有漏人**。
 *
 * 這個檔案住在 `@nexus/harness` 不是為了方便——**它是唯一同時相依二十個套件的地方**，
 * 而前兩條都需要二十個一起在場才驗得到。
 *
 * 三條各擋一種缺陷，而且都不是形式：
 *
 * 1. **子路徑解析**：底下一律從 specifier（`@nexus/plugin-echo/invariant`）import，
 *    **不是相對路徑**。用相對路徑寫，`exports` 那格接錯了測試照樣綠——那就變成
 *    一條不驗它宣稱在驗的東西的測試。
 * 2. **包名歸屬**：二十個檔案長得幾乎一樣，最可能的缺陷就是 `PACKAGE_NAME` 抄錯一個。
 *    二十個一起掛上去，撞名會當場拋，名字錯了則會在下面的逐一比對裡露出來。
 * 3. **表格對得上磁碟**：`COMPANIONS` 是手維護的，而上面兩條**都是拿它自己比自己**——
 *    少列一個 package，兩條照樣綠。這不是假想：[#478](https://github.com/DemianLi/nexus-agent/issues/478)
 *    加進 `@nexus/plugin-sandbox-policy` 時這個檔案一聲都沒吭，發現時已經落後四個
 *    （`agent-instructions`、`present`、`sandbox-policy`、`workspace-changes`），
 *    其中兩個還是真的裝了觀察者的。所以第三條把表格釘到磁碟上：
 *    `packageInvariantOwners()` 掃出來的 owner 與這份表格不一致就紅。
 *
 * 十三個空 installer 為什麼是正確結果（subject 裡只有 `@nexus/core` 的日誌，別的包在裡面
 * 找不到屬於自己的關係），見任何一個 `packages/<name>/src/invariant.ts` 的檔頭。
 * **真的裝上觀察者的有七個**：`@nexus/core`（turn 配對）、`@nexus/plugin-commands`
 * （命令生命週期配對，[#118](https://github.com/DemianLi/nexus-agent/issues/118)）、
 * `@nexus/plugin-plan-mode`（`/plan` 的參數契約，
 * [#120](https://github.com/DemianLi/nexus-agent/issues/120)）、`@nexus/plugin-goal`
 * （耐久 goal 串，[#126](https://github.com/DemianLi/nexus-agent/issues/126)）、
 * `@nexus/plugin-todo`（耐久待辦快照，[#132](https://github.com/DemianLi/nexus-agent/issues/132)）、
 * `@nexus/plugin-present`（交付對得上一次成功的呼叫，
 * [#441](https://github.com/DemianLi/nexus-agent/issues/441)）與
 * `@nexus/plugin-workspace-changes`（事件落在跑過工具的那一輪，
 * [#443](https://github.com/DemianLi/nexus-agent/issues/443)）。
 *
 * 跟 [`package-invariants.test.ts`](./package-invariants.test.ts) 不重複：那邊守**結構**
 * （每個 package 有沒有 `src/invariant.ts`、`exports` 那格在不在、檔案長得對不對），讀的是
 * AST；這邊守結構看不到的兩件事——specifier 是不是真的解析得到（AST 讀不出 `exports` 有沒有
 * 接對），以及 installer 跑起來的行為（誰真的掛了觀察者）。第 3 條補的正是兩邊之間那道縫：
 * **那邊掃得到新 package，這邊卻可以不認得它**。
 */
import { describe, expect, it } from 'vitest';

import { createRegistry, SessionLog } from '@nexus/core';
import type { PluginEntry } from '@nexus/core';
import { createCoreInvariantPlugin, CORE_INVARIANT_PACKAGE } from '@nexus/core/invariant';
import { createEchoInvariantPlugin, ECHO_INVARIANT_PACKAGE } from '@nexus/plugin-echo/invariant';
import { createMcpInvariantPlugin, MCP_INVARIANT_PACKAGE } from '@nexus/plugin-mcp/invariant';
import {
  createMemoryInvariantPlugin,
  MEMORY_INVARIANT_PACKAGE,
} from '@nexus/plugin-memory/invariant';
import {
  createPlanModeInvariantPlugin,
  PLAN_MODE_INVARIANT_PACKAGE,
} from '@nexus/plugin-plan-mode/invariant';
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
import {
  createCommandsInvariantPlugin,
  COMMANDS_INVARIANT_PACKAGE,
} from '@nexus/plugin-commands/invariant';
import { createGoalInvariantPlugin, GOAL_INVARIANT_PACKAGE } from '@nexus/plugin-goal/invariant';
import { createTodoInvariantPlugin, TODO_INVARIANT_PACKAGE } from '@nexus/plugin-todo/invariant';
import {
  createAskUserInvariantPlugin,
  ASK_USER_INVARIANT_PACKAGE,
} from '@nexus/plugin-ask-user/invariant';
import {
  createSubmitRecordInvariantPlugin,
  SUBMIT_RECORD_INVARIANT_PACKAGE,
} from '@nexus/plugin-submit-record/invariant';
import {
  createFeedbackInvariantPlugin,
  FEEDBACK_INVARIANT_PACKAGE,
} from '@nexus/plugin-feedback/invariant';
import {
  createAgentInstructionsInvariantPlugin,
  AGENT_INSTRUCTIONS_INVARIANT_PACKAGE,
} from '@nexus/plugin-agent-instructions/invariant';
import {
  createPresentInvariantPlugin,
  PRESENT_INVARIANT_PACKAGE,
} from '@nexus/plugin-present/invariant';
import {
  createSandboxPolicyInvariantPlugin,
  SANDBOX_POLICY_INVARIANT_PACKAGE,
} from '@nexus/plugin-sandbox-policy/invariant';
import {
  createWorkspaceChangesInvariantPlugin,
  WORKSPACE_CHANGES_INVARIANT_PACKAGE,
} from '@nexus/plugin-workspace-changes/invariant';

import { packageInvariantOwners } from './package-invariants.js';

/**
 * 二十個配套入口，配上各自**應該**認領的包名。
 *
 * 右邊那一欄刻意寫死字串而不是引用左邊那個常數——常數抄錯了，拿常數自己比自己
 * 是驗不出來的。
 */
const COMPANIONS: readonly (readonly [() => PluginEntry, string, string])[] = [
  [createCoreInvariantPlugin, CORE_INVARIANT_PACKAGE, '@nexus/core'],
  [
    createAgentInstructionsInvariantPlugin,
    AGENT_INSTRUCTIONS_INVARIANT_PACKAGE,
    '@nexus/plugin-agent-instructions',
  ],
  [createAskUserInvariantPlugin, ASK_USER_INVARIANT_PACKAGE, '@nexus/plugin-ask-user'],
  [createCommandsInvariantPlugin, COMMANDS_INVARIANT_PACKAGE, '@nexus/plugin-commands'],
  [createEchoInvariantPlugin, ECHO_INVARIANT_PACKAGE, '@nexus/plugin-echo'],
  [createFeedbackInvariantPlugin, FEEDBACK_INVARIANT_PACKAGE, '@nexus/plugin-feedback'],
  [createGoalInvariantPlugin, GOAL_INVARIANT_PACKAGE, '@nexus/plugin-goal'],
  [createMcpInvariantPlugin, MCP_INVARIANT_PACKAGE, '@nexus/plugin-mcp'],
  [createMemoryInvariantPlugin, MEMORY_INVARIANT_PACKAGE, '@nexus/plugin-memory'],
  [createPlanModeInvariantPlugin, PLAN_MODE_INVARIANT_PACKAGE, '@nexus/plugin-plan-mode'],
  [createPresentInvariantPlugin, PRESENT_INVARIANT_PACKAGE, '@nexus/plugin-present'],
  [createQuickJsInvariantPlugin, QUICKJS_INVARIANT_PACKAGE, '@nexus/plugin-quickjs'],
  [
    createSandboxPolicyInvariantPlugin,
    SANDBOX_POLICY_INVARIANT_PACKAGE,
    '@nexus/plugin-sandbox-policy',
  ],
  [createSkillsInvariantPlugin, SKILLS_INVARIANT_PACKAGE, '@nexus/plugin-skills'],
  [
    createSubmitRecordInvariantPlugin,
    SUBMIT_RECORD_INVARIANT_PACKAGE,
    '@nexus/plugin-submit-record',
  ],
  [
    createTelemetryOtelInvariantPlugin,
    TELEMETRY_OTEL_INVARIANT_PACKAGE,
    '@nexus/plugin-telemetry-otel',
  ],
  [createTodoInvariantPlugin, TODO_INVARIANT_PACKAGE, '@nexus/plugin-todo'],
  [createValidationInvariantPlugin, VALIDATION_INVARIANT_PACKAGE, '@nexus/plugin-validation'],
  [
    createWorkspaceChangesInvariantPlugin,
    WORKSPACE_CHANGES_INVARIANT_PACKAGE,
    '@nexus/plugin-workspace-changes',
  ],
  [createWireInvariantPlugin, WIRE_INVARIANT_PACKAGE, '@nexus/wire'],
];

describe('表格對得上磁碟', () => {
  it('每一個 `packages/*` 的 owner 都在 COMPANIONS 裡，一個都不漏', () => {
    const owners = packageInvariantOwners().map((owner) => owner.packageName);

    // 先釘「真的掃到東西」：掃空的話下面那條會變成空陣列對空陣列，而 COMPANIONS 漏人
    // 的時候它也是「兩邊都少」——一個永遠綠的絆索比沒有絆索更糟。確切數目歸
    // `package-invariants.test.ts` 的 `EXPECTED_OWNERS`，這裡只擋掃空與倒退。
    expect(owners.length).toBeGreaterThanOrEqual(20);

    // 兩邊都排序再比：COMPANIONS 的順序是給人看的，不是被驗的東西。
    expect([...COMPANIONS.map(([, , name]) => name)].sort()).toEqual([...owners].sort());
  });
});

describe('子路徑解析', () => {
  it('二十個 `<pkg>/invariant` 都 import 得到，而且各自吐出一個 plugin', () => {
    for (const [factory] of COMPANIONS) {
      const plugin = factory();
      expect(typeof plugin.plugin.apply).toBe('function');
      expect(plugin.plugin.name).toMatch(/-invariant$/);
    }
  });

  it('包名常數與這個套件在 workspace 裡的真名一致', () => {
    for (const [, constant, literal] of COMPANIONS) {
      expect(constant).toBe(literal);
    }
  });
});

describe('包名歸屬', () => {
  it('二十個一起掛上去，各自認領自己那個名字，一個都不撞', () => {
    const registry = createRegistry();
    for (const [factory] of COMPANIONS) {
      const plugin = factory();
      // 二十個的 name 各不相同，所以 `resolveEntries` 補出來的就是 `<name>#0`。
      const exit = registry.enter({ id: `${plugin.plugin.name}#0`, name: plugin.plugin.name });
      plugin.plugin.apply(registry, undefined);
      exit();
    }

    const claimed = registry.invariants.companions().map((entry) => entry.packageName);
    expect([...claimed].sort()).toEqual([...COMPANIONS.map(([, , name]) => name)].sort());
    expect(new Set(claimed).size).toBe(COMPANIONS.length);
  });

  it('十三個空 installer 一個檢查都不裝——掛滿二十個只有七個觀察得到東西', () => {
    const registry = createRegistry();
    for (const [factory] of COMPANIONS) {
      const plugin = factory();
      // 二十個的 name 各不相同，所以 `resolveEntries` 補出來的就是 `<name>#0`。
      const exit = registry.enter({ id: `${plugin.plugin.name}#0`, name: plugin.plugin.name });
      plugin.plugin.apply(registry, undefined);
      exit();
    }

    // 每個 installer 都跑一次，數它掛了幾個觀察者。只有七個該掛出東西。
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

    const observing = new Set([
      '@nexus/core',
      '@nexus/plugin-commands',
      '@nexus/plugin-goal',
      '@nexus/plugin-plan-mode',
      '@nexus/plugin-present',
      '@nexus/plugin-todo',
      '@nexus/plugin-workspace-changes',
    ]);
    expect(observerCount.get('@nexus/core')).toBe(1);
    expect(observerCount.get('@nexus/plugin-commands')).toBe(1);
    expect(observerCount.get('@nexus/plugin-goal')).toBe(1);
    expect(observerCount.get('@nexus/plugin-plan-mode')).toBe(1);
    expect(observerCount.get('@nexus/plugin-present')).toBe(1);
    expect(observerCount.get('@nexus/plugin-todo')).toBe(1);
    expect(observerCount.get('@nexus/plugin-workspace-changes')).toBe(1);
    for (const [, , name] of COMPANIONS) {
      if (observing.has(name)) continue;
      expect(observerCount.get(name)).toBe(0);
    }
  });
});
