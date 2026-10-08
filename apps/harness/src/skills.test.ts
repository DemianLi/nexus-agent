/**
 * skills 層的**行為**驗收（Phase 3 `feat/skills-plugin`）。
 *
 * 跟 [`memory.test.ts`](./memory.test.ts) 同樣的做法：看的是**送進模型的那份 system
 * prompt**，加上工具真的回了什麼。skills 這個擴充點的產物只有兩樣——prompt 裡多出來的
 * 那段清單，與模型照著清單去 `read_file` 時拿到的東西。斷言 registry 裡有幾筆來源證明
 * 不了任何事，那是 `@nexus/plugin-skills` 那邊薄測試的工作。
 *
 * 有幾條是**斷言缺陷**的（`看得到讀不到`、`custom subagent 沒有`、`不合規範的名字照樣進清單`）。
 * 跟 [`contained-backend.test.ts`](./contained-backend.test.ts) 那組升版絆索同樣的用意：這些是
 * `deepagents@1.13.1` 的實際形狀，寫成可執行的證據比寫在註解裡強，基座哪天改了它們會紅。
 *
 * **「空清單」那一組不是缺陷了**（[#440](https://github.com/DemianLi/nexus-agent/issues/440)）：基座對空清單照樣
 * 接約 2000 字、又每輪重掃，組裝點包了一層（`packages/nexus-core/src/skills-middleware.ts`）讓它整個隱形，
 * 最後一組 `沒有 skill 就一個字都不加` 走產品組裝（`createCliAgent` ＋ 出貨清單）量這件事。
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import type { PluginEntry } from '@nexus/core';
import { createSkillsPlugin } from '@nexus/plugin-skills';
import { describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { createCliAgent } from './assembly-root.js';
import { runTurn } from './cli.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { shippedPlugins, withScriptedModel } from './fixtures.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

/** 一輪 prompt 裡的 system 訊息。基座把 skill 清單併進 system prompt，不是併進對話。 */
function systemPrompt(messages: readonly BaseMessage[]): string {
  return messages
    .filter((message) => message.getType() === 'system')
    .map((message) => message.text)
    .join('\n');
}

/** 工具那幾則的內容。權限被拒是一則 tool 訊息，不是 throw。 */
function toolOutput(messages: readonly BaseMessage[]): string {
  return messages
    .filter((message) => message.getType() === 'tool')
    .map((message) => message.text)
    .join('\n');
}

/**
 * 建一個工作區：`{ '<來源目錄>': { '<skill 名>': '<description>' } }`。
 *
 * 每個 skill 是 `<來源目錄>/<名字>/SKILL.md`，frontmatter 的 `name` 與目錄名一致——
 * 這是基座 `validateSkillName` 要的形狀（不一致時它只 warn，見最後那一條測試）。
 */
async function workspace(layout: Record<string, Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-skills-'));
  for (const [dir, skills] of Object.entries(layout)) {
    await mkdir(join(root, dir), { recursive: true });
    for (const [name, description] of Object.entries(skills)) {
      await mkdir(join(root, dir, name), { recursive: true });
      await writeFile(
        join(root, dir, name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${description}\n---\n\n正文：${name} 的完整步驟。\n`,
      );
    }
  }
  return root;
}

describe('skills 進到 system prompt', () => {
  /**
   * **這個擴充點的預設失敗模式，而且它是斷言缺陷。**
   *
   * progressive disclosure 是純 prompt 不是機制：middleware 只把 name／description／path
   * 寫進 system prompt，然後用文字叫模型自己去 `read_file`。所以清單與正文走的是**兩條
   * 不同的路**——清單走 backend 方法（`listSkillsFromBackend` 的 `ls` / `downloadFiles`），
   * 正文走 `read_file` 工具。`checkPermission` 只活在七個工具工廠裡，**只有後者經過**。
   *
   * 淨結果：一條蓋到 skill 路徑的 deny 規則不會讓 skill 消失，它會讓 skill 好端端地列在
   * prompt 裡、然後模型每次去讀都被拒。這跟 `memory.test.ts` 那條「deny 擋不住記憶載入」
   * 是同一個根因（[#66](https://github.com/DemianLi/nexus-agent/issues/66)：規則表管工具，
   * 管不到 backend 方法），但**後果不同**：記憶那邊是整份內容照樣進 context，這邊只有
   * 名字與描述進去，正文擋住了。
   *
   * 順帶：我們的 `ContainedFilesystemBackend` 那道 fence 在這裡**完全不參與**——它只包
   * 寫入路徑，讀一律通過。擋人的自始至終只有 `permissions` 一層。
   */
  it('deny 蓋到 skill 路徑：清單照樣列出來，正文讀不到', async () => {
    const root = await workspace({ skills: { 'web-research': '上網查資料。' } });
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '',
          toolCalls: [{ name: 'read_file', args: { file_path: '/skills/web-research/SKILL.md' } }],
        },
        { content: '讀不到。' },
      ],
    });
    const guard: PluginEntry = {
      plugin: {
        name: 'guard',
        apply: (registry) => void registry.permissions.deny(['/skills/**']),
      },
    };

    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      plugins: [createSkillsPlugin({ sources: ['/skills/'] }), guard],
    });

    let output = '';
    try {
      const result = await agent.invoke(toAgentInvocation('去讀那個 skill。'));
      output = toolOutput(result.messages);
    } finally {
      await dispose();
    }

    // 看得到：清單、描述、路徑全都在 prompt 裡。
    const prompt = systemPrompt(model.prompts[0] ?? []);
    expect(prompt).toContain('web-research');
    expect(prompt).toContain('上網查資料。');
    expect(prompt).toContain('/skills/web-research/SKILL.md');
    // 讀不到：而且是一則 tool 訊息，不是 throw——模型看得到這句話。
    expect(output).toContain('permission denied');
    expect(output).not.toContain('完整步驟');
  });

  /**
   * **後面的來源覆蓋同名 skill 的內容，但不換它在清單裡的位置。**
   *
   * 基座是 `allSkills.set(skill.name, skill)` 依 `sources` 順序逐一覆蓋，而 `Map` 的迭代
   * 順序是**第一次**插入的順序。所以被覆蓋掉的那個 skill，位置仍然是第一個來源給的——
   * 只有內容（description 與 path）換成了後者。這一條是計劃「skills last-wins」那句話
   * 沒說完的另一半。
   */
  it('多來源 last-wins：換的是內容與路徑，不是位置', async () => {
    const root = await workspace({
      base: { alpha: '第一版 alpha。', beta: '只有 base 有 beta。' },
      proj: { alpha: '第二版 alpha。' },
    });
    const model = new ScriptedChatModel({ turns: [{ content: '好。' }] });

    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      plugins: [createSkillsPlugin({ sources: ['/base/', '/proj/'] })],
    });

    try {
      await agent.invoke(toAgentInvocation('嗨。'));
    } finally {
      await dispose();
    }

    const prompt = systemPrompt(model.lastPrompt);
    expect(prompt).toContain('第二版 alpha。');
    expect(prompt).not.toContain('第一版 alpha。');
    expect(prompt).toContain('/proj/alpha/SKILL.md');
    // 位置沒動：alpha 是 /base/ 先插進 Map 的，覆蓋不改迭代順序。
    expect(prompt.indexOf('**alpha**')).toBeLessThan(prompt.indexOf('**beta**'));
  });
});

/**
 * **skills 的快取：載到東西就凍住，載到空的也一樣。**
 *
 * `loadedSkills` 是 middleware 工廠的閉包變數，不是 state：
 * `if (loadedSkills.length > 0) return ...` 之後就永不重載，跨 thread 也一樣。
 *
 * **基座的空結果不算**：載入結果為空時 `loadedSkills.length > 0` 是 false，於是每一次
 * `beforeAgent` 都重掃整個來源。**這條絆索翻面了**（[#440](https://github.com/DemianLi/nexus-agent/issues/440)）：
 * 原本斷言「沒 skill」是兩次掃描，現在是一次——照 dsh，掃描結果連空的也進快取
 * （`packages/skill/skill/src/index.ts:540-541`）。改的是組裝點包的那一層，不是基座。
 */
describe('skills 的快取邊界', () => {
  it('載到 skill 就凍住，載到空的也凍住', async () => {
    for (const [label, source, expected] of [
      ['有 skill', '/skills/', 1],
      ['沒 skill', '/empty/', 1],
    ] as const) {
      const root = await workspace({ skills: { 'web-research': '上網查資料。' } });
      await mkdir(join(root, 'empty'), { recursive: true });

      let scans = 0;
      class CountingBackend extends ContainedFilesystemBackend {
        override async ls(
          path: string,
        ): Promise<Awaited<ReturnType<ContainedFilesystemBackend['ls']>>> {
          scans += 1;
          return super.ls(path);
        }
      }

      const model = new ScriptedChatModel({ turns: [{ content: '一。' }, { content: '二。' }] });
      const { agent, dispose } = await createNexusAgent({
        model,
        backend: new CountingBackend({ rootDir: root }),
        plugins: [createSkillsPlugin({ sources: [source] })],
      });

      try {
        // 快取的粒度是 per invoke（`beforeAgent`），不是 per model turn——所以要 invoke 兩次。
        await agent.invoke(toAgentInvocation('第一次。'));
        await agent.invoke(toAgentInvocation('第二次。'));
      } finally {
        await dispose();
      }

      expect(scans, label).toBe(expected);
    }
  });
});

/**
 * **skills 與 memory 的 subagent 繼承規則正好相反**——升版絆索。
 *
 * 基座的 `createSubagentDefaultMiddleware(input)` 有 `input.skills` 分支。基座自己補的
 * general-purpose 在 `normalizeSubagentSpec` 時被塞進了 root 的 `skills`；它現在改由
 * `foldRegistry` 註冊，那一格照抄——**第一條就是抄得忠不忠實的守衛**。自訂 subagent 沒有人幫它塞，`SubAgent` 要自己帶 `skills` 才有。
 * 基座註解把這件事寫得很明白：「Custom subagents do NOT inherit skills from the main
 * agent by default. Only the general-purpose subagent inherits the main agent's skills.」
 *
 * 對照 `memory.test.ts` 那條：memory 只有 `mode: 'fork'` 的 subagent 拿得到，
 * general-purpose **拿不到**。淨結果是同一組 subagent 上，兩個擴充點的繼承規則互為反面。
 * 這種事沒有辦法用記的。
 */
describe('subagent 的 skills 邊界', () => {
  /** 三輪：root 叫 subagent → subagent 回話 → root 收尾。第二輪是 subagent 的。 */
  function threeTurns(subagentType: string): ScriptedChatModel {
    return new ScriptedChatModel({
      turns: [
        {
          content: '',
          toolCalls: [
            { name: 'task', args: { description: '去做事', subagent_type: subagentType } },
          ],
        },
        { content: 'subagent 做完了。' },
        { content: '收工。' },
      ],
    });
  }

  it('general-purpose 那輪有 root 的 skills', async () => {
    const root = await workspace({ skills: { 'web-research': '上網查資料。' } });
    const model = threeTurns('general-purpose');

    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      plugins: [createSkillsPlugin({ sources: ['/skills/'] })],
    });

    try {
      await agent.invoke(toAgentInvocation('叫 general-purpose 去做事。'));
    } finally {
      await dispose();
    }

    const prompts = model.prompts.map(systemPrompt);
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain('## Skills System');
    expect(prompts[1]).toContain('web-research');
  });

  it('自訂 subagent 那輪什麼都沒有——連 Skills System 那段都不在', async () => {
    const root = await workspace({ skills: { 'web-research': '上網查資料。' } });
    const crew: PluginEntry = {
      plugin: {
        name: 'crew',
        apply: (registry) =>
          void registry.subagents.register({ name: 'writer', description: '負責寫東西。' }),
      },
    };
    const model = threeTurns('writer');

    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      plugins: [createSkillsPlugin({ sources: ['/skills/'] }), crew],
    });

    try {
      await agent.invoke(toAgentInvocation('叫 writer 去做事。'));
    } finally {
      await dispose();
    }

    const prompts = model.prompts.map(systemPrompt);
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).not.toContain('## Skills System');
    expect(prompts[0]).toContain('web-research');
    expect(prompts[2]).toContain('web-research');
  });
});

/**
 * **基座驗證 skill 的名字，但驗完不擋**——升版絆索。
 *
 * `validateSkillName` 檢查 kebab-case、長度、以及「`name` 必須等於目錄名」，任何一條
 * 不過都只是 `console.warn(...)`，**metadata 照樣被收進清單**。這跟 `@nexus/core` 那側
 * 「路徑格式在註冊期就擋」的做法是相反的哲學，也跟 dsh 相反——dsh 的
 * `skill-filesystem` 對調用策略欄位是 fail-closed（拼寫錯或非布林值就把整個 skill 從
 * 發現結果排除，理由是「忽略無效資料可能在已停用的介面上暴露 skill」）。
 *
 * 我們在 plugin 這側**表達不出來**：frontmatter 的解析整個關在
 * `parseSkillMetadataFromContent` 裡，碰不到。所以這裡只釘住事實。
 */
describe('基座驗證了但不擋的那些', () => {
  it('名字不合規範、又跟目錄名對不上的 skill，照樣進清單', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-skills-'));
    await mkdir(join(root, 'skills', 'web-research'), { recursive: true });
    await writeFile(
      join(root, 'skills', 'web-research', 'SKILL.md'),
      // 大寫駝峰（違反 kebab-case）而且 name !== 目錄名——兩條規則一起違反。
      '---\nname: WebResearch\ndescription: 名字兩條規則都不合。\n---\n\n正文。\n',
    );
    const model = new ScriptedChatModel({ turns: [{ content: '好。' }] });

    const { agent, dispose } = await createNexusAgent({
      model,
      backend: new ContainedFilesystemBackend({ rootDir: root }),
      plugins: [createSkillsPlugin({ sources: ['/skills/'] })],
    });

    try {
      await agent.invoke(toAgentInvocation('嗨。'));
    } finally {
      await dispose();
    }

    const prompt = systemPrompt(model.lastPrompt);
    expect(prompt).toContain('WebResearch');
    expect(prompt).not.toContain('No skills available');
  });
});

/**
 * **沒有 skill 就一個字都不加**（[#440](https://github.com/DemianLi/nexus-agent/issues/440)）——走產品組裝：
 * `createCliAgent` ＋ 出貨清單（`cordis.yml` 的 `skills` 那一列），不是 `createNexusAgent` 手掛 plugin。
 *
 * 基座的 skills middleware 對空清單照樣把約 2000 字的說明接到 system prompt 後面；組裝點包了一層讓它隱形。
 * **驗收是位元組相同**：同一份出貨清單，把 `skills` 那一列停用（＝沒掛 skills）對照啟用，送給模型的 system prompt
 * 逐字相同——包含「沒給 `--workspace`」「工作區沒有 `skills/`」「有 `skills/` 目錄但裡面是空的」三種空。
 */
describe('沒有 skill 就一個字都不加', () => {
  /** 出貨清單，`skills` 那一列照 `enabled` 啟用或停用（patch 寫 `disabled: true` 的效果）。 */
  async function rows(enabled: boolean): Promise<readonly PluginEntry[]> {
    const shipped = await shippedPlugins();
    expect(shipped.some((entry) => entry.id === 'skills')).toBe(true);
    return shipped.map((entry) =>
      entry.id === 'skills' && !enabled ? { ...entry, disabled: true as const } : entry,
    );
  }

  /** 產品組裝跑一輪，回傳每一次模型呼叫的 system prompt。 */
  async function promptsOf(
    enabled: boolean,
    workspaceRoot: string | undefined,
    turns: Parameters<typeof withScriptedModel>[1],
  ): Promise<string[]> {
    const built = await createCliAgent(
      workspaceRoot === undefined ? { live: false } : { live: false, workspace: workspaceRoot },
      withScriptedModel([...(await rows(enabled))], turns),
      workspaceRoot,
    );
    try {
      await runTurn(
        built.agent,
        '嗨。',
        { log: () => undefined, error: () => undefined },
        built.sessionLog,
      );
    } finally {
      await built.dispose();
    }
    return (built.model as unknown as { prompts: BaseMessage[][] }).prompts.map(systemPrompt);
  }

  it('沒給 --workspace、工作區沒有 skills/、skills/ 是空的：system prompt 與沒掛 skills 逐字相同', async () => {
    const cases: [string, string | undefined][] = [
      ['沒給 --workspace', undefined],
      ['工作區沒有 skills/', await workspace({})],
      ['skills/ 是空的', await workspace({ skills: {} })],
    ];
    for (const [label, root] of cases) {
      const without = await promptsOf(false, root, [{ content: '好。' }]);
      const withSkills = await promptsOf(true, root, [{ content: '好。' }]);
      expect(without.length, label).toBeGreaterThan(0);
      expect(withSkills, label).toEqual(without);
      expect(withSkills.join('\n'), label).not.toContain('Skills System');
      expect(withSkills.join('\n'), label).not.toContain('No skills available');
    }
  });

  it('有 skills/<name>/SKILL.md：模型看得到名字、描述與路徑（零設定的產品組裝找得到 skills）', async () => {
    const root = await workspace({ skills: { 'web-research': '上網查資料。' } });
    const [prompt] = await promptsOf(true, root, [{ content: '好。' }]);
    expect(prompt).toContain('## Skills System');
    expect(prompt).toContain('web-research');
    expect(prompt).toContain('上網查資料。');
    expect(prompt).toContain('/skills/web-research/SKILL.md');
    // 對照：停用那一列，清單就消失——證明上面看到的是這一列掛的，不是別處帶的。
    const [off] = await promptsOf(false, root, [{ content: '好。' }]);
    expect(off).not.toContain('web-research');
  });

  it('general-purpose 子代理在沒有 skill 的工作區也不多一個字', async () => {
    const root = await workspace({});
    const turns = [
      {
        content: '',
        toolCalls: [
          { name: 'task', args: { description: '去做事', subagent_type: 'general-purpose' } },
        ],
      },
      { content: 'subagent 做完了。' },
      { content: '收工。' },
    ];
    const without = await promptsOf(false, root, turns);
    const withSkills = await promptsOf(true, root, turns);
    expect(withSkills).toHaveLength(3);
    expect(withSkills).toEqual(without);
  });
});
