/**
 * **模型讀得到這個 session 的核准政策**——[#1986](https://github.com/DemianLi/nexus-agent/issues/1986) 的驗收。
 *
 * 句子由閘門用的同一組事實推（`@nexus/core` 的 `approvalPolicySentence`），這裡量的是組裝出來的結果：
 *
 * 1. **出廠兩格**（serve 的出貨清單、`read-only`／`workspace-write`、有人在）講「會問」那句；
 * 2. **部署方加回的全開**（`--patch` 疊 `danger-full-access`，起始政策 `never`）講「一律自動回絕」那句；
 * 3. **CLI**（`HEADLESS_APPROVALS`，管道 `policy-never`）講回絕那句，旋鈕仍是 `ask` 也一樣；
 * 4. 句子接在沙箱政策句之後；
 * 5. **執行中切換**：同一個組裝，切到 `never` 之後下一次模型呼叫就是新的那一句；
 * 6. **背景子代理**（`compileSubagent` 那張圖）講回絕那句，同一個組裝的 root 講「會問」。
 *
 * 每一條都斷言另一句**不在**：一個永遠兩句都講的實作過不了。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import {
  APPROVAL_POLICY_ASK_SENTENCE,
  APPROVAL_POLICY_NEVER_SENTENCE,
  ApprovalPolicyController,
  createHostServicesPlugin,
} from '@nexus/core';
import type { PluginEntry } from '@nexus/core';
import { sandboxPolicySentence } from '@nexus/plugin-sandbox-policy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNexusAgent, HEADLESS_APPROVALS } from './agent-factory.js';
import { createCliAgent } from './assembly-root.js';
import type { SandboxMode } from './contained-backend.js';
import {
  shippedPlugins,
  shippedPluginsWithFullAccess,
  shippedServePlugins,
  withScriptedModel,
} from './fixtures.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nexus-approval-prompt-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 一輪 prompt 裡的 system 文字。 */
function systemOf(prompt: readonly BaseMessage[] | undefined): string {
  return (prompt ?? [])
    .filter((message) => message.getType() === 'system')
    .map((message) => message.text)
    .join('\n');
}

/** 走產品組裝（`createCliAgent`）跑一輪，回模型收到的 system 文字。 */
async function productPrompt(
  plugins: readonly PluginEntry[],
  sandbox: SandboxMode,
  session: { readonly headless?: boolean } = {},
): Promise<string> {
  const built = await createCliAgent(
    { live: false, workspace: root, sandbox },
    withScriptedModel(plugins, [{ content: '好。' }]),
    root,
    session.headless === true ? { approvals: HEADLESS_APPROVALS } : {},
  );
  try {
    await built.agent.invoke(toAgentInvocation('嗨。'), {
      configurable: { thread_id: 'approval-prompt' },
    });
    return systemOf((built.model as ScriptedChatModel).prompts.at(-1));
  } finally {
    await built.dispose();
  }
}

describe('產品組裝講的核准政策句', () => {
  it.each(['read-only', 'workspace-write'] as const)(
    'serve 出廠的 %s：有人在、政策 ask，講「會問」那句，接在沙箱政策句之後',
    async (mode) => {
      const text = await productPrompt(await shippedServePlugins(), mode);
      expect(text).toContain(APPROVAL_POLICY_ASK_SENTENCE);
      expect(text).not.toContain(APPROVAL_POLICY_NEVER_SENTENCE);
      const sandbox = text.indexOf(sandboxPolicySentence(mode).slice(0, 20));
      expect(sandbox).toBeGreaterThanOrEqual(0);
      expect(text.indexOf(APPROVAL_POLICY_ASK_SENTENCE)).toBeGreaterThan(sandbox);
    },
  );

  it('部署方加回的全開：起始政策 never，講「一律自動回絕」那句', async () => {
    const text = await productPrompt(
      await shippedPluginsWithFullAccess({ serve: true }),
      'danger-full-access',
    );
    expect(text).toContain(APPROVAL_POLICY_NEVER_SENTENCE);
    expect(text).not.toContain(APPROVAL_POLICY_ASK_SENTENCE);
  });

  it('CLI：入口沒有人在（HEADLESS_APPROVALS），旋鈕是 ask 也講回絕那句', async () => {
    const text = await productPrompt(await shippedPlugins(), 'workspace-write', {
      headless: true,
    });
    expect(text).toContain(APPROVAL_POLICY_NEVER_SENTENCE);
    expect(text).not.toContain(APPROVAL_POLICY_ASK_SENTENCE);
  });
});

describe('同一個組裝裡句子跟著事實走', () => {
  const worker: PluginEntry = {
    plugin: {
      name: 'worker-host',
      apply(registry) {
        registry.subagents.register({
          name: 'worker',
          description: '幹活的。',
          systemPrompt: '你是 worker。',
        });
      },
    },
  };

  async function assemble(turns: number) {
    const controller = new ApprovalPolicyController('ask');
    const model = new ScriptedChatModel({
      turns: Array.from({ length: turns }, () => ({ content: '好。' })),
    });
    const built = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      plugins: [createHostServicesPlugin({ approvalPolicy: controller }), worker],
      approvals: { policy: controller.source },
    });
    return { controller, model, built };
  }

  it('切到 never 之後，下一次模型呼叫就是新的那一句', async () => {
    const { controller, model, built } = await assemble(2);
    try {
      const config = { configurable: { thread_id: 'switch' } };
      await built.agent.invoke(toAgentInvocation('一'), config);
      expect(controller.switchTo('never')).toMatchObject({ kind: 'switched' });
      await built.agent.invoke(toAgentInvocation('二'), config);
      const [first, second] = model.prompts.map(systemOf);
      expect(first).toContain(APPROVAL_POLICY_ASK_SENTENCE);
      expect(first).not.toContain(APPROVAL_POLICY_NEVER_SENTENCE);
      expect(second).toContain(APPROVAL_POLICY_NEVER_SENTENCE);
      expect(second).not.toContain(APPROVAL_POLICY_ASK_SENTENCE);
    } finally {
      await built.dispose();
    }
  });

  it('背景子代理的圖講回絕那句；同一個組裝的 root 講「會問」', async () => {
    const { model, built } = await assemble(2);
    try {
      await built.agent.invoke(toAgentInvocation('根'), {
        configurable: { thread_id: 'root' },
      });
      const background = built.compileSubagent('worker', new MemorySaver());
      await background.invoke(toAgentInvocation('背景'), {
        configurable: { thread_id: 'background' },
      });
      const [rootText, backgroundText] = model.prompts.map(systemOf);
      expect(rootText).toContain(APPROVAL_POLICY_ASK_SENTENCE);
      expect(rootText).not.toContain(APPROVAL_POLICY_NEVER_SENTENCE);
      expect(backgroundText).toContain('你是 worker。');
      expect(backgroundText).toContain(APPROVAL_POLICY_NEVER_SENTENCE);
      expect(backgroundText).not.toContain(APPROVAL_POLICY_ASK_SENTENCE);
    } finally {
      await built.dispose();
    }
  });
});
