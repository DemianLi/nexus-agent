/**
 * `/名字` 與模型清單讀同一份技能來源（[#1919](https://github.com/DemianLi/nexus-agent/issues/1919)）。
 *
 * 模型清單用的是組 thread 時依**列序**折進去的來源；行程級的登記處依**登記順序**。兩列 skills 有同名技能、其中一列停用再啟用之後，
 * 登記順序跟列序反過來。`/名字` 與 `skill.list` 改讀 fold 填進這條 thread fs 把手的那一份（`FsService.skillSources()`），
 * 三條路挑的是同一份。量的是產品路徑：真的 `createCordisRoot`、真的 `loadDefaultPlugins`（帶樹）、真的寫入口 `changePlugin`、真的 `root.boot`。
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BaseMessage } from '@langchain/core/messages';
import { SessionRegistry } from '@nexus/core';
import { SKILL_INVOCATION_MARKER } from '@nexus/plugin-skills/invocation';
import { afterEach, describe, expect, it } from 'vitest';

import { createCordisRoot, entryApprovalChannel } from './cordis-root.js';
import type { CordisRoot } from './cordis-root.js';
import { withScriptedModel } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { toAgentInvocation } from './messages.js';
import { changePlugin } from './plugin-change.js';
import { loadDefaultPlugins } from './plugin-config.js';
import type { ScriptedChatModel } from './scripted-model.js';

const temporary: string[] = [];
const roots: CordisRoot[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await root.dispose().catch(() => {});
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  return dir;
}

/** 兩個來源目錄各放一份同名的 `deploy`，正文分得出是哪一列的。 */
function twinWorkspace(): string {
  const root = scratch('nexus-skill-thread-sources-ws-');
  for (const [dir, body] of [
    ['skills', '前面那一列。'],
    ['late', '後面那一列。'],
  ] as const) {
    mkdirSync(join(root, dir, 'deploy'), { recursive: true });
    writeFileSync(
      join(root, dir, 'deploy', 'SKILL.md'),
      `---\nname: deploy\ndescription: ${body}\n---\n\n${body}\n`,
    );
  }
  return root;
}

/** 出貨清單的 `skills`（`/skills/`）後面插一列 `late-skills`（`/late/`）。 */
const TWIN = `- insert:\n    - id: late-skills\n      name: '@nexus/plugin-skills'\n      config:\n        sources:\n          - '/late/'\n`;

describe('兩列有同名技能，前面那一列重載過', () => {
  it('/deploy 注入的跟模型清單列的是同一份：都是清單上靠後那一列的', async () => {
    const home = scratch('nexus-skill-thread-sources-home-');
    writeFileSync(join(home, 'cordis.patch.yml'), TWIN, { mode: 0o600 });
    const env = { [HARNESS_HOME_ENV]: home };
    const root = createCordisRoot({ channel: entryApprovalChannel(undefined), contained: true });
    roots.push(root);
    const load = () => loadDefaultPlugins({ env, warn: () => {} }, { tree: root.tree });

    // 停用再啟用前面那一列：它重新登記，登記順序變成 [/late/, /skills/]，列序仍是 [/skills/, /late/]。
    expect((await load()).dropped).toEqual([]);
    await changePlugin({ op: 'disable', id: 'skills' }, { env });
    await load();
    await changePlugin({ op: 'enable', id: 'skills' }, { env });
    const loaded = await load();
    expect(loaded.dropped).toEqual([]);

    const assembly = await root.boot('serve', { plugins: loaded.plugins });
    const built = await assembly.create(
      { live: false, workspace: twinWorkspace(), sandbox: 'workspace-write' as const },
      { plugins: withScriptedModel(loaded.plugins, [{ content: '好。' }]) },
    );
    const attachment = built.attachSessions(new SessionRegistry('t-twin'));
    try {
      await built.agent.invoke(toAgentInvocation('/deploy'), {
        configurable: { thread_id: 't-twin' },
      });
      const prompt = ((built.model as ScriptedChatModel).prompts[0] ?? []) as BaseMessage[];
      const system = prompt.filter((message) => message.getType() === 'system');
      const injected = prompt.filter(
        (message) => SKILL_INVOCATION_MARKER in message.additional_kwargs,
      );
      // 模型清單：列序折進去，後面那一列贏。
      expect(system.map((message) => message.text).join('\n')).toContain('/late/deploy/SKILL.md');
      // `/deploy`：跟模型清單同一份。
      expect(injected).toHaveLength(1);
      expect(injected[0]!.text).toContain('後面那一列。');
      expect(injected[0]!.text).not.toContain('前面那一列。');
    } finally {
      await attachment.detach();
      await built.dispose();
    }
  }, 90000);
});
