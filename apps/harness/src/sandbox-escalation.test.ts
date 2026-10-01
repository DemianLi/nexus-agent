/**
 * 升級那一刀的驗收：[#238](https://github.com/DemianLi/nexus-agent/issues/238) 第 2 項的四條，
 * 外加卡上釘在最前面的那個前提。
 *
 * ## 前提先釘死
 *
 * 第 0 項定案是 `workspace-write` ＋ 有人可問，**根內寫入直接放行**——所以升級這條路只有兩種跑
 * 會走到：切到 `read-only`，或目標在可寫根外。每一條會發 grant 的驗收都**先斷言那次呼叫真的被
 * fence 擋下來**（拒絕訊息，不是「有跑」），再驗升級。少了這一步，一份測試可以從頭到尾沒碰到
 * 升級而全綠。
 *
 * ## 每一條都是一對
 *
 * 「不加寬的不問人」配「加寬的會問」；「核准之後過得去」配「第二顆又被擋」；「指引在」配
 * 「沒掛升級的 fence 不講」。單獨一邊都綠得了一個錯的實作：永遠拒、永遠放、永遠講。
 *
 * ## 「只蓋一次」那條走真的中斷
 *
 * 不預先塞 grant：resume 的時候 tools node 會整個重跑，閘門也跟著再跑一次，一顆被發兩次的
 * grant 只有在真的 `interrupt → Command({ resume })` 之下才看得到。斷言釘在**第二顆**上。
 */

import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BaseMessage } from '@langchain/core/messages';
import { Command, MemorySaver } from '@langchain/langgraph';

import { createSubmitRecordPlugin } from '@nexus/plugin-submit-record';

import { createNexusAgent } from './agent-factory.js';
import { createCliAgent } from './assembly-root.js';
import { ContainedFilesystemBackend, GRANT_MISMATCH_NOTE } from './contained-backend.js';
import type { SandboxMode } from './contained-backend.js';
import { toAgentInvocation } from './messages.js';
import {
  BLANK_JUSTIFICATION_REFUSAL,
  createSandboxPolicyPlugin,
  escalationReason,
  MISSING_TARGET_REFUSAL,
  nonWideningRefusal,
  rejectedRefusal,
  SANDBOX_ESCALATION_HINT,
  SANDBOX_ESCALATION_TOOL_NAME,
  SandboxModeController,
  unaskedRefusal,
} from '@nexus/plugin-sandbox-policy';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedToolCall, ScriptedTurn } from './scripted-model.js';
import { shippedPlugins } from './fixtures.js';
import { createHostServicesPlugin, deriveApprovalChannel } from '@nexus/core';
import type { PluginEntry } from '@nexus/core';

const shipped = await shippedPlugins();

/** 把一則訊息的 `content` 攤成字串，同 `sandbox-policy.test.ts`。 */
function flatten(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(flatten).join('\n');
  if (content !== null && typeof content === 'object') {
    const text = (content as { text?: unknown }).text;
    return typeof text === 'string' ? text : JSON.stringify(content);
  }
  return String(content);
}

/** 這條 thread 到目前為止每一則工具結果的文字，依出現順序。 */
function toolTexts(result: { messages: unknown }): string[] {
  return (result.messages as BaseMessage[])
    .filter((message) => message.getType() === 'tool')
    .map((message) => flatten(message.content));
}

/** 掛著的那一張核准卡；沒有中斷時為 `undefined`。 */
function pendingCard(
  result: unknown,
): { name?: string; args?: Record<string, unknown>; description?: string } | undefined {
  const interrupts = (result as { __interrupt__?: unknown }).__interrupt__ as
    | {
        value?: {
          actionRequests?: {
            name?: string;
            args?: Record<string, unknown>;
            description?: string;
          }[];
        };
      }[]
    | undefined;
  return interrupts?.[0]?.value?.actionRequests?.[0];
}

const write = (filePath: string, content: string): ScriptedTurn => ({
  content: '',
  toolCalls: [{ name: 'write_file', args: { file_path: filePath, content } }],
});

const escalate = (args: ScriptedToolCall['args']): ScriptedTurn => ({
  content: '',
  toolCalls: [{ name: SANDBOX_ESCALATION_TOOL_NAME, args }],
});

/**
 * 一顆回 `{ kind: 'allow' }` 而**不呼叫 `next()`** 的閘門，同 `approval-gate-order.test.ts` 那顆。
 * 寫成 factory：plugin 物件會被載入路徑登記身分，每次組裝各建一份。
 */
function permissiveGate(): PluginEntry {
  return {
    plugin: {
      name: 'probe-permissive',
      apply(registry) {
        registry.approvals.gate(() => ({ kind: 'allow' }));
      },
    },
  };
}

const APPROVE = new Command({ resume: { decisions: [{ type: 'approve' }] } }) as never;
const REJECT = new Command({ resume: { decisions: [{ type: 'reject' }] } }) as never;

describe('升級', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nexus-escalation-root-'));
    outside = await mkdtemp(join(tmpdir(), 'nexus-escalation-outside-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  /**
   * 照 `cli.ts` 的接法組起來：**fence、提示句、升級工具讀同一顆控制器**。
   *
   * @param mode - 起始那一格。
   * @param turns - 腳本。
   * @param options - `plugin: false` 組一個 fence 有 ledger、但沒掛升級的組裝；
   *   `checkpointer: false` 是沒有核准管道；`approvals` 原樣轉給組裝點；`submitRecord` 照
   *   `cli.ts` 掛上 `submit_record`，拿同一份 backend。`channel: false` 是組裝點沒提供
   *   核准管道那個服務；省略就照 `assembly-root.ts` 從同一組選項算一次再提供。
   *   `permissive: true` 在升級之前疊一顆回 `allow`、不呼叫 `next()` 的閘門——照
   *   `assembly-root.ts` 的順序，出貨清單與 patch 的 plugin 都排在 sandbox-policy 前面。
   */
  async function assemble(
    mode: SandboxMode,
    turns: readonly ScriptedTurn[],
    options: {
      plugin?: boolean;
      checkpointer?: boolean;
      approvalsEnabled?: boolean;
      submitRecord?: boolean;
      channel?: false;
      permissive?: boolean;
    } = {},
  ) {
    const controller = new SandboxModeController(mode);
    const model = new ScriptedChatModel({ turns });
    const backend = new ContainedFilesystemBackend({
      rootDir: root,
      mode: controller.source,
      grants: controller,
    });
    const { agent, dispose } = await createNexusAgent({
      model,
      backend,
      plugins: [
        createHostServicesPlugin({
          backend,
          ...(options.channel !== false && {
            channel: deriveApprovalChannel({
              ...(options.approvalsEnabled !== undefined && {
                approvalsEnabled: options.approvalsEnabled,
              }),
              hasCheckpointer: options.checkpointer !== false,
            }),
          }),
          ...(options.plugin === false ? {} : { sandboxPolicy: { controller, rootDir: root } }),
        }),
        ...(options.permissive === true ? [permissiveGate()] : []),
        ...(options.plugin === false ? [] : [createSandboxPolicyPlugin()]),
        ...(options.submitRecord === true ? [createSubmitRecordPlugin()] : []),
      ],
      ...(options.checkpointer !== false && { checkpointer: new MemorySaver() }),
      ...(options.approvalsEnabled !== undefined && {
        approvals: { enabled: options.approvalsEnabled },
      }),
    });
    return { agent, dispose, controller };
  }

  async function exists(path: string): Promise<boolean> {
    try {
      await readFile(path);
      return true;
    } catch {
      return false;
    }
  }

  describe('前提：升級只在 fence 真的擋下來時走得到', () => {
    it('read-only 之下 write_file 真的被擋，而且拒絕後面接著升級指引', async () => {
      const { agent, dispose } = await assemble('read-only', [
        write('/a.txt', '一'),
        { content: '停。' },
      ]);
      try {
        const result = await agent.invoke(toAgentInvocation('寫一個檔。'), {
          configurable: { thread_id: 'pre-denied' },
        });
        const [denied] = toolTexts(result);
        expect(denied).toContain('這個 backend 是唯讀的');
        expect(denied).toContain(SANDBOX_ESCALATION_HINT);
        expect(await exists(join(root, 'a.txt'))).toBe(false);
      } finally {
        await dispose();
      }
    });

    it('反例：fence 有 ledger 但組裝沒掛升級工具時，拒絕後面不講「可以升級」', async () => {
      const { agent, dispose } = await assemble(
        'read-only',
        [write('/a.txt', '一'), { content: '停。' }],
        { plugin: false },
      );
      try {
        const [denied] = toolTexts(
          await agent.invoke(toAgentInvocation('寫一個檔。'), {
            configurable: { thread_id: 'pre-no-plugin' },
          }),
        );
        expect(denied).toContain('這個 backend 是唯讀的');
        expect(denied).not.toContain(SANDBOX_ESCALATION_TOOL_NAME);
      } finally {
        await dispose();
      }
    });

    it('反例：workspace-write 之下根內寫入直接放行，升級這條路根本走不到', async () => {
      const { agent, dispose } = await assemble('workspace-write', [
        write('/a.txt', '一'),
        { content: '好了。' },
      ]);
      try {
        const [wrote] = toolTexts(
          await agent.invoke(toAgentInvocation('寫一個檔。'), {
            configurable: { thread_id: 'pre-inside' },
          }),
        );
        expect(wrote).not.toContain('[containment]');
        expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('一');
      } finally {
        await dispose();
      }
    });
  });

  describe('不加寬的請求不問人', () => {
    it.each([
      ['danger-full-access', 'workspace-write'],
      ['workspace-write', 'workspace-write'],
      ['danger-full-access', 'danger-full-access'],
    ] as const)('%s 之下要 %s：當場擋掉，核准卡一張都不掛', async (current, requested) => {
      const { agent, dispose, controller } = await assemble(current, [
        escalate({ file_path: '/a.txt', sandbox_permissions: requested, justification: '要寫檔' }),
        { content: '好。' },
      ]);
      try {
        const result = await agent.invoke(toAgentInvocation('升級。'), {
          configurable: { thread_id: `no-widen-${current}` },
        });
        expect(pendingCard(result)).toBeUndefined();
        expect(toolTexts(result)).toEqual([`Error: ${nonWideningRefusal(requested, current)}`]);
        expect(controller.peekGrant()).toBeUndefined();
      } finally {
        await dispose();
      }
    });

    /**
     * **enum 外的值走不到本體**（#700）：以前閘門排在 zod 之前，`read-only` 在閘門上拿到不加寬那句；
     * 問人搬進本體之後，schema 的封閉詞彙先擋，同 dsh 的 schema-pinned。斷言的是結局，不抄基座的措辭。
     */
    it('enum 外的值（read-only）在 schema 那一關就被擋：核准卡一張都不掛、grant 沒發', async () => {
      const { agent, dispose, controller } = await assemble('read-only', [
        escalate({
          file_path: '/a.txt',
          sandbox_permissions: 'read-only',
          justification: '要寫檔',
        }),
        { content: '好。' },
      ]);
      try {
        const result = await agent.invoke(toAgentInvocation('升級。'), {
          configurable: { thread_id: 'no-widen-schema' },
        });
        expect(pendingCard(result)).toBeUndefined();
        const [refused] = toolTexts(result);
        expect(refused).toMatch(/^Error: /);
        expect(refused).toContain('sandbox_permissions');
        expect(controller.peekGrant()).toBeUndefined();
      } finally {
        await dispose();
      }
    });

    it('反例：真的加寬的請求會掛出核准卡，人看得到是哪一個檔與理由', async () => {
      const { agent, dispose, controller } = await assemble('read-only', [
        escalate({
          file_path: '/a.txt',
          sandbox_permissions: 'workspace-write',
          justification: '要寫檔',
        }),
      ]);
      try {
        const result = await agent.invoke(toAgentInvocation('升級。'), {
          configurable: { thread_id: 'widen' },
        });
        const card = pendingCard(result);
        expect(card?.name).toBe(SANDBOX_ESCALATION_TOOL_NAME);
        expect(card?.args?.file_path).toBe('/a.txt');
        expect(card?.description).toBe(escalationReason('/a.txt', 'workspace-write', '要寫檔'));
        // 還沒人按——grant 不能先發出去。
        expect(controller.peekGrant()).toBeUndefined();
      } finally {
        await dispose();
      }
    });

    it.each([
      [
        { file_path: '/a.txt', sandbox_permissions: 'workspace-write', justification: '  ' },
        BLANK_JUSTIFICATION_REFUSAL,
        'read-only',
      ],
      [
        { file_path: '', sandbox_permissions: 'workspace-write', justification: '要寫檔' },
        MISSING_TARGET_REFUSAL,
        'read-only',
      ],
      // **欄位先判，加寬後判**（照 dsh 的 `validateEscalationArgs` 在 `approveEscalation` 之前）：
      // 既不加寬、理由又空白的這一筆，拿到的是欄位那句。少了它，兩條判斷對調也全綠。
      [
        { file_path: '/a.txt', sandbox_permissions: 'workspace-write', justification: '' },
        BLANK_JUSTIFICATION_REFUSAL,
        'workspace-write',
      ],
    ] as const)('欄位不齊（%o）也不問人', async (args, refusal, mode) => {
      const { agent, dispose } = await assemble(mode, [escalate(args), { content: '好。' }]);
      try {
        const result = await agent.invoke(toAgentInvocation('升級。'), {
          configurable: { thread_id: 'malformed' },
        });
        expect(pendingCard(result)).toBeUndefined();
        expect(toolTexts(result)).toEqual([`Error: ${refusal}`]);
      } finally {
        await dispose();
      }
    });
  });

  /**
   * [#700](https://github.com/DemianLi/nexus-agent/issues/700)：**問人放在工具本體裡**，照 dsh 的
   * `approveEscalation`。以前「有人看過」只靠一顆只認這個名字的閘門，排在它前面的一顆寬鬆閘門
   * 不呼叫 `next()` 就把它整個短路掉——工具回「核准了」，畫面上一張卡都沒有。
   */
  describe('核准在工具本體裡，閘門怎麼排都跳不過', () => {
    it('寬鬆閘門排在前面：照樣停在升級的核准上，grant 還沒發', async () => {
      const { agent, dispose, controller } = await assemble(
        'read-only',
        [
          write('/a.txt', '一'),
          escalate({
            file_path: '/a.txt',
            sandbox_permissions: 'danger-full-access',
            justification: '使用者要這個檔',
          }),
          { content: '好。' },
        ],
        { permissive: true },
      );
      try {
        const result = await agent.invoke(toAgentInvocation('寫 a.txt。'), {
          configurable: { thread_id: 'permissive-first' },
        });
        // 前提：第一顆真的被 fence 擋下來了——寬鬆閘門放行的是工具，不是 fence。
        expect(toolTexts(result)[0]).toContain('這個 backend 是唯讀的');
        expect(toolTexts(result).slice(1)).toEqual([]);
        expect(pendingCard(result)?.name).toBe(SANDBOX_ESCALATION_TOOL_NAME);
        expect(pendingCard(result)?.description).toBe(
          escalationReason('/a.txt', 'danger-full-access', '使用者要這個檔'),
        );
        expect(controller.peekGrant()).toBeUndefined();
      } finally {
        await dispose();
      }
    });
  });

  describe('一次核准只蓋一次呼叫', () => {
    it('read-only：被擋 → 升級 → 核准 → 第一顆過得去、第二顆又被擋，session 的模式沒動', async () => {
      const { agent, dispose, controller } = await assemble('read-only', [
        write('/a.txt', '一'),
        escalate({
          file_path: '/a.txt',
          sandbox_permissions: 'workspace-write',
          justification: '使用者要這個檔',
        }),
        // 重試與第三顆都**原樣**：grant 綁住被擋下的那一次，內容不同的話擋下它的會是另一條。
        write('/a.txt', '一'),
        write('/a.txt', '一'),
        { content: '完成。' },
      ]);
      const config = { configurable: { thread_id: 'once' } };
      try {
        const paused = await agent.invoke(toAgentInvocation('寫 a.txt。'), config);
        // 前提：第一顆真的被 fence 擋下來了。
        expect(toolTexts(paused)[0]).toContain('這個 backend 是唯讀的');
        expect(pendingCard(paused)?.name).toBe(SANDBOX_ESCALATION_TOOL_NAME);

        const after = await agent.invoke(APPROVE, config);
        const [, granted, retried, again] = toolTexts(after);
        expect(granted).toContain('核准了');
        expect(retried).not.toContain('[containment]');
        // **承重的是這一條**：grant 沒被消費掉的實作會讓它過。
        expect(again).toContain('這個 backend 是唯讀的');
        // 而且擋下它的是「用掉了」，不是「對不上」：它跟被擋下的那一次一模一樣。
        expect(again).not.toContain(GRANT_MISMATCH_NOTE);
        expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('一');
        expect(controller.peekGrant()).toBeUndefined();
        // 一次性 grant 不是切換 session 模式：人沒切，這一格就沒動。
        expect(controller.current).toBe('read-only');
      } finally {
        await dispose();
      }
    });

    it('grant 只蓋指名的那個檔：別的檔照樣被擋，而且沒把 grant 吃掉', async () => {
      const { agent, dispose } = await assemble('read-only', [
        write('/a.txt', '一'),
        escalate({
          file_path: '/a.txt',
          sandbox_permissions: 'workspace-write',
          justification: '使用者要這個檔',
        }),
        write('/b.txt', '別的'),
        write('/a.txt', '一'),
        { content: '完成。' },
      ]);
      const config = { configurable: { thread_id: 'bound' } };
      try {
        const paused = await agent.invoke(toAgentInvocation('寫 a.txt。'), config);
        expect(toolTexts(paused)[0]).toContain('這個 backend 是唯讀的');

        const [, , other, retried] = toolTexts(await agent.invoke(APPROVE, config));
        expect(other).toContain('這個 backend 是唯讀的');
        // 別的檔**不是**「對不上」：它根本不是這顆 grant 的目標，話照舊。
        expect(other).not.toContain(GRANT_MISMATCH_NOTE);
        expect(retried).not.toContain('[containment]');
        expect(await exists(join(root, 'b.txt'))).toBe(false);
        expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('一');
      } finally {
        await dispose();
      }
    });

    it('workspace-write：經 symlink 寫到根外 → 升到 danger-full-access 一次；寫法不同也對得上', async () => {
      await symlink(outside, join(root, 'out'));
      const { agent, dispose } = await assemble('workspace-write', [
        write('/out/x.txt', '一'),
        // 故意不帶前置斜線：比對的是 canonical 位置，不是字串。
        escalate({
          file_path: 'out/x.txt',
          sandbox_permissions: 'danger-full-access',
          justification: '要寫到工作區外面',
        }),
        write('/out/x.txt', '一'),
        write('/out/x.txt', '一'),
        { content: '完成。' },
      ]);
      const config = { configurable: { thread_id: 'outside' } };
      try {
        const paused = await agent.invoke(toAgentInvocation('寫到外面。'), config);
        const [denied] = toolTexts(paused);
        expect(denied).toContain('落在可寫根之外');
        expect(denied).toContain(SANDBOX_ESCALATION_HINT);

        const [, , retried, again] = toolTexts(await agent.invoke(APPROVE, config));
        expect(retried).not.toContain('[containment]');
        expect(again).toContain('落在可寫根之外');
        expect(await readFile(join(outside, 'x.txt'), 'utf8')).toBe('一');
      } finally {
        await dispose();
      }
    });
  });

  /**
   * [#254](https://github.com/DemianLi/nexus-agent/issues/254)：grant 綁住被擋下的那一次。
   * 每一條都是「對不上的被擋」配「原樣的過得去」——只驗前一半的話，一個永遠不認領的實作也綠。
   */
  describe('一次核准只蓋被擋下的那一次操作', () => {
    it('write_file：重試改了內容 → 被擋、grant 沒被吃掉；原樣再來一次 → 過得去', async () => {
      const { agent, dispose, controller } = await assemble('read-only', [
        write('/a.txt', '一'),
        escalate({
          file_path: '/a.txt',
          sandbox_permissions: 'workspace-write',
          justification: '使用者要這個檔',
        }),
        write('/a.txt', '對不起，寫不進去'),
        write('/a.txt', '一'),
        { content: '完成。' },
      ]);
      const config = { configurable: { thread_id: 'content-write' } };
      try {
        const paused = await agent.invoke(toAgentInvocation('寫 a.txt。'), config);
        expect(toolTexts(paused)[0]).toContain('這個 backend 是唯讀的');

        const [, , changed, exact] = toolTexts(await agent.invoke(APPROVE, config));
        expect(changed).toContain(GRANT_MISMATCH_NOTE);
        // 對不上時照樣接升級指引：模型要的是「原樣重試，或重新升級」。
        expect(changed).toContain(SANDBOX_ESCALATION_HINT);
        expect(exact).not.toContain('[containment]');
        expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('一');
        expect(controller.peekGrant()).toBeUndefined();
      } finally {
        await dispose();
      }
    });

    it('edit_file：新字串不同 → 被擋；原樣 → 過得去', async () => {
      await writeFile(join(root, 'a.txt'), '舊的一行');
      const edit = (newString: string): ScriptedTurn => ({
        content: '',
        toolCalls: [
          {
            name: 'edit_file',
            args: { file_path: '/a.txt', old_string: '舊的', new_string: newString },
          },
        ],
      });
      const { agent, dispose } = await assemble('read-only', [
        // 先讀：`edit_file` 有「沒讀過不准改」的護欄，不讀的話擋下它的是那一條、不是 fence。
        { content: '', toolCalls: [{ name: 'read_file', args: { file_path: '/a.txt' } }] },
        edit('新的'),
        escalate({
          file_path: '/a.txt',
          sandbox_permissions: 'workspace-write',
          justification: '使用者要改這一行',
        }),
        edit('別的'),
        edit('新的'),
        { content: '完成。' },
      ]);
      const config = { configurable: { thread_id: 'content-edit' } };
      try {
        const paused = await agent.invoke(toAgentInvocation('改 a.txt。'), config);
        expect(toolTexts(paused)[1]).toContain('這個 backend 是唯讀的');

        const [, , , changed, exact] = toolTexts(await agent.invoke(APPROVE, config));
        expect(changed).toContain(GRANT_MISMATCH_NOTE);
        expect(exact).not.toContain('[containment]');
        expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('新的一行');
      } finally {
        await dispose();
      }
    });

    it('fence 本身：操作不同也不算，沒被擋過就發的 grant 什麼都認領不到', async () => {
      const controller = new SandboxModeController('read-only');
      controller.enableEscalation(SANDBOX_ESCALATION_HINT);
      const backend = new ContainedFilesystemBackend({
        rootDir: root,
        mode: controller.source,
        grants: controller,
      });

      // 被擋的是 write，拿 delete 來認領：對不上、不消費。
      expect((await backend.write('/b.txt', '二')).error).toContain('這個 backend 是唯讀的');
      const bound = {
        mode: 'workspace-write',
        target: '/b.txt',
        denied: controller.lastDenial,
      } as const;
      controller.grant(bound);
      expect((await backend.delete('/b.txt')).error).toContain(GRANT_MISMATCH_NOTE);
      expect(controller.peekGrant()).toBe(bound);
      // 反例：原樣的 write 認領得到。
      expect((await backend.write('/b.txt', '二')).error).toBeUndefined();
      expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('二');

      // 沒綁任何一次的 grant：連原樣都認領不到，而且留著不消費。
      const unbound = { mode: 'workspace-write', target: '/c.txt', denied: undefined } as const;
      controller.grant(unbound);
      expect((await backend.write('/c.txt', '三')).error).toContain(GRANT_MISMATCH_NOTE);
      expect(controller.peekGrant()).toBe(unbound);
      expect(await exists(join(root, 'c.txt'))).toBe(false);
    });

    it('兩個檔都被擋、只升級其中一個：綁到的是後擋下的那一次，拿它的內容寫這個檔也不算', async () => {
      const controller = new SandboxModeController('read-only');
      controller.enableEscalation(SANDBOX_ESCALATION_HINT);
      const backend = new ContainedFilesystemBackend({
        rootDir: root,
        mode: controller.source,
        grants: controller,
      });

      expect((await backend.write('/d.txt', '四')).error).toContain('這個 backend 是唯讀的');
      expect((await backend.write('/e.txt', '五')).error).toContain('這個 backend 是唯讀的');
      // 升級指名 d.txt，綁到的卻是 e.txt 被擋的那一次（一次只留一顆）。
      const crossed = {
        mode: 'workspace-write',
        target: '/d.txt',
        denied: controller.lastDenial,
      } as const;
      controller.grant(crossed);

      // 操作一樣、內容也跟綁住的那次一樣——只差在那次打的是別的檔。
      expect((await backend.write('/d.txt', '五')).error).toContain(GRANT_MISMATCH_NOTE);
      expect(controller.peekGrant()).toBe(crossed);
      expect(await exists(join(root, 'd.txt'))).toBe(false);
    });

    it('submit_record（ro-7 那一筆）：升級之後重試把欄位改掉 → 人按了核准也寫不進去', async () => {
      const submit = (company: string): ScriptedTurn => ({
        content: '',
        toolCalls: [
          {
            name: 'submit_record',
            args: { file_path: '/a.csv', record: { 名字: '阿明', 公司: company } },
          },
        ],
      });
      const { agent, dispose } = await assemble(
        'read-only',
        [
          submit('遠見科技'),
          escalate({
            file_path: '/a.csv',
            sandbox_permissions: 'workspace-write',
            justification: '使用者要送出這一筆',
          }),
          submit('對不起，無法寫入遠見科技'),
          submit('遠見科技'),
          { content: '完成。' },
        ],
        { submitRecord: true },
      );
      const config = { configurable: { thread_id: 'content-submit' } };
      try {
        // 四張卡依序是：送出、升級、改過的送出、原樣的送出。探針照樣全按核准——
        // 擋下改過那筆的**不是人**，是 grant 綁住的那一次。
        const cards: (string | undefined)[] = [];
        let result = await agent.invoke(toAgentInvocation('送出這一筆。'), config);
        for (let turn = 0; turn < 4; turn += 1) {
          cards.push(pendingCard(result)?.name);
          result = await agent.invoke(APPROVE, config);
        }
        expect(cards).toEqual([
          'submit_record',
          SANDBOX_ESCALATION_TOOL_NAME,
          'submit_record',
          'submit_record',
        ]);
        const [denied, , changed, exact] = toolTexts(result);
        expect(denied).toContain('這個 backend 是唯讀的');
        expect(changed).toContain(GRANT_MISMATCH_NOTE);
        expect(exact).not.toContain('[containment]');
        const written = await readFile(join(root, 'a.csv'), 'utf8');
        expect(written).toContain('阿明,遠見科技');
        expect(written).not.toContain('對不起');
      } finally {
        await dispose();
      }
    });
  });

  describe('fail-closed 的每個出口各有各的話', () => {
    const request = escalate({
      file_path: '/a.txt',
      sandbox_permissions: 'workspace-write',
      justification: '使用者要這個檔',
    });

    it('被拒：不發 grant，同一個檔下一顆照樣被擋', async () => {
      const { agent, dispose, controller } = await assemble('read-only', [
        write('/a.txt', '一'),
        request,
        write('/a.txt', '二'),
        { content: '好。' },
      ]);
      const config = { configurable: { thread_id: 'rejected' } };
      try {
        const paused = await agent.invoke(toAgentInvocation('寫 a.txt。'), config);
        expect(toolTexts(paused)[0]).toContain('這個 backend 是唯讀的');

        const [, refused, again] = toolTexts(await agent.invoke(REJECT, config));
        expect(refused).toContain('拒絕了');
        expect(again).toContain('這個 backend 是唯讀的');
        expect(controller.peekGrant()).toBeUndefined();
      } finally {
        await dispose();
      }
    });

    it('五條出口的話兩兩不同：不加寬／被拒／關掉了人工核准／沒有 checkpointer／沒提供核准管道', async () => {
      const texts: string[] = [];

      const narrow = await assemble('workspace-write', [
        escalate({
          file_path: '/a.txt',
          sandbox_permissions: 'workspace-write',
          justification: '要寫檔',
        }),
        { content: '好。' },
      ]);
      try {
        texts.push(
          ...toolTexts(
            await narrow.agent.invoke(toAgentInvocation('升級。'), {
              configurable: { thread_id: 'exit-narrow' },
            }),
          ),
        );
      } finally {
        await narrow.dispose();
      }

      const rejected = await assemble('read-only', [request, { content: '好。' }]);
      const config = { configurable: { thread_id: 'exit-rejected' } };
      try {
        await rejected.agent.invoke(toAgentInvocation('升級。'), config);
        texts.push(...toolTexts(await rejected.agent.invoke(REJECT, config)));
      } finally {
        await rejected.dispose();
      }

      const never = await assemble('read-only', [request, { content: '好。' }], {
        approvalsEnabled: false,
      });
      try {
        const result = await never.agent.invoke(toAgentInvocation('升級。'), {
          configurable: { thread_id: 'exit-never' },
        });
        expect(pendingCard(result)).toBeUndefined();
        expect(never.controller.peekGrant()).toBeUndefined();
        texts.push(...toolTexts(result));
      } finally {
        await never.dispose();
      }

      const noChannel = await assemble('read-only', [request, { content: '好。' }], {
        checkpointer: false,
      });
      try {
        const result = await noChannel.agent.invoke(toAgentInvocation('升級。'));
        expect(noChannel.controller.peekGrant()).toBeUndefined();
        texts.push(...toolTexts(result));
      } finally {
        await noChannel.dispose();
      }

      // **組裝點沒提供核准管道**：fail-closed，不退到「有人在」（#700）。退到「有人在」的話，這裡會
      // 掛出一張核准卡——下面那兩條斷言就是在擋它。
      const noService = await assemble('read-only', [request, { content: '好。' }], {
        channel: false,
      });
      try {
        const result = await noService.agent.invoke(toAgentInvocation('升級。'), {
          configurable: { thread_id: 'exit-no-service' },
        });
        expect(pendingCard(result)).toBeUndefined();
        expect(noService.controller.peekGrant()).toBeUndefined();
        texts.push(...toolTexts(result));
      } finally {
        await noService.dispose();
      }

      expect(texts).toHaveLength(5);
      expect(texts[0]).toBe(`Error: ${nonWideningRefusal('workspace-write', 'workspace-write')}`);
      expect(texts[1]).toBe(`Error: ${rejectedRefusal('/a.txt', 'workspace-write')}`);
      expect(texts[2]).toBe(`Error: ${unaskedRefusal('policy-never', 'workspace-write')}`);
      expect(texts[3]).toBe(`Error: ${unaskedRefusal('no-channel', 'workspace-write')}`);
      expect(texts[4]).toBe(`Error: ${unaskedRefusal('no-service', 'workspace-write')}`);
      // 分得出「沒有人被問到」與「有人拒絕了」的那一段，各自在場。
      expect(texts[1]).toContain('拒絕了');
      expect(texts[2]).toContain('關掉了人工核准');
      expect(texts[3]).toContain('沒有 checkpointer');
      expect(new Set(texts).size).toBe(5);
    });
  });

  /**
   * **兩種廣告是兩件事**：「沒掛升級的 fence 不講指引」只蓋到拒絕那一行，蓋不到工具清單。
   * 有人哪天把升級從政策 plugin 搬進預設清單，提示句那條負面測試照樣綠，而沒有 fence 的
   * 組裝就會對模型公告一顆升級工具——那正是政策 plugin 註解要防的「對模型說謊」。所以
   * 這裡走**產品路徑**（`createCliAgent`），量模型實際拿到的工具清單。
   */
  it('產品路徑：沒有 --workspace 的組裝，模型的工具清單裡沒有升級工具；有的話才有', async () => {
    const bare = await createCliAgent({ live: false }, shipped, root);
    try {
      await bare.agent.invoke(toAgentInvocation('看一下。'), {
        configurable: { thread_id: 'bare' },
      });
      const names = (bare.model as ScriptedChatModel).boundToolNames;
      // 前提：真的綁過工具。空清單也「不含」升級工具。
      expect(names).toContain('write_file');
      expect(names).not.toContain(SANDBOX_ESCALATION_TOOL_NAME);
    } finally {
      await bare.dispose();
    }

    const fenced = await createCliAgent({ live: false, workspace: root }, shipped, root);
    try {
      await fenced.agent.invoke(toAgentInvocation('看一下。'), {
        configurable: { thread_id: 'fenced' },
      });
      expect((fenced.model as ScriptedChatModel).boundToolNames).toContain(
        SANDBOX_ESCALATION_TOOL_NAME,
      );
    } finally {
      await fenced.dispose();
    }
  });
});
