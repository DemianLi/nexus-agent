/**
 * **核准政策 `ask`／`never` 這顆旋鈕真的搬得動閘門**——[#437](https://github.com/DemianLi/nexus-agent/issues/437) 的驗收。
 *
 * 真的 `createNexusAgent`＋`createWireHandler`＋JSONL 落盤；旋鈕由組裝點的 `ApprovalPolicyController` 提供，
 * `approval-gate` 那一列把它接上日誌（`approvalGatePlugin`）。量：
 *
 * 1. **`never` 從頭到尾**：要核准的工具回絕、不發中斷（沒有 `input.requested`、沒有 `interrupt/raised`），日誌是一對
 *    `approval/asked`＋`approval/decided(rejected)`，`tool/result` 帶 `APPROVAL_POLICY_NEVER`。
 * 2. **執行中切換**，而且**驗到第二輪**：第一輪 `ask` 停在核准點（人答了核准），切到 `never` 之後第二輪的同一個工具被回絕。
 *    第一輪綠不能代表機制成立——閘門若在組裝時就把值扣進閉包，第一輪照樣綠。
 * 3. **拆旗標**：`never` 只管核准，`ask_user_question` 照常發中斷；「入口沒有人在」（`approvals.enabled: false`）仍讓提問拒絕。
 * 4. **日誌**：起始值與每次切換各一顆 `approval/policy`，淨變化為零不寫。
 *
 * 突變（量過，見 PR 內文）：閘門不讀來源（固定 ask）→ 1、2 紅；來源在組裝時取值 → 2 紅；提問讀政策來源 → 3 紅；
 * 控制器不寫事件 → 4 紅。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import {
  APPROVAL_POLICY_NEVER,
  ApprovalPolicyController,
  approvalGatePlugin,
  attachSessionPersistence,
  createHostServicesPlugin,
} from '@nexus/core';
import type { ApprovalPolicyValue, PluginEntry, SessionEvent, SessionRegistry } from '@nexus/core';
import { ASK_USER_QUESTION_TOOL_NAME, createAskUserPlugin } from '@nexus/plugin-ask-user';
import {
  appendDecision,
  createWireClient,
  emptyConversation,
  reduceConversation,
  uniformDecisions,
} from '@nexus/wire';
import type { ConversationState, Event, WireClient } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import {
  approvalAt,
  emptyCommandPoint,
  humanChannelPlugin,
  loopbackRequest,
  TEST_BROWSER_AUTH,
} from './fixtures.js';
import { createJsonlSessionStore } from './jsonl-session-store.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { composeAttachSessions } from './session-attach.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { WireHandler } from './wire-handler.js';

const GATED = 'alpha';
const BASE_URL = 'http://approval-policy.test';

let dir: string;
let ran: string[] = [];
const opened: WireHandler[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-approval-policy-'));
  ran = [];
});
afterEach(async () => {
  for (const handler of opened.splice(0)) await handler.close();
  await rm(dir, { recursive: true, force: true });
});

/** 一個會記下自己有沒有被執行的工具，加一條「要人看過」的閘門規則。 */
const gatedToolPlugin: PluginEntry = {
  plugin: {
    name: 'gated-tool',
    apply(registry) {
      registry.tools.register(
        tool(
          () => {
            ran.push(GATED);
            return `${GATED} 跑過了`;
          },
          { name: GATED, description: `間諜 ${GATED}`, schema: z.object({}) },
        ),
      );
      registry.approvals.gate((exec, next) =>
        exec.name === GATED ? { kind: 'ask', reason: `${GATED} 要人看過` } : next(),
      );
    },
  },
};

interface Session {
  readonly client: WireClient;
  readonly events: AsyncGenerator<Event, void, undefined>;
  readonly frames: Event[];
  readonly controller: ApprovalPolicyController;
  readonly sessions: () => SessionRegistry;
  readonly threadId: string;
  state: ConversationState;
}

async function open(
  threadId: string,
  turns: readonly ScriptedTurn[],
  options: {
    readonly policy?: ApprovalPolicyValue;
    readonly approvalsEnabled?: boolean;
    readonly plugins?: readonly PluginEntry[];
  } = {},
): Promise<Session> {
  const store = createJsonlSessionStore({ rootDir: join(dir, 'logs') });
  const controller = new ApprovalPolicyController(options.policy);
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns }),
    checkpointer: new MemorySaver(),
    plugins: [
      // 組裝點的協作者排最前面；`approval-gate` 那一列在產品路徑是出貨清單上的一列。
      createHostServicesPlugin({ approvalPolicy: controller }),
      { plugin: approvalGatePlugin },
      gatedToolPlugin,
      ...(options.plugins ?? []),
    ],
    approvals: {
      ...(options.approvalsEnabled === undefined ? {} : { enabled: options.approvalsEnabled }),
      policy: controller.source,
    },
  });
  let registry: SessionRegistry | undefined;
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: async () => ({
      agent: built.agent as unknown as PumpAgent,
      commands: emptyCommandPoint(),
      projections: built.projections,
      dispose: () => built.dispose(),
      attachSessions: composeAttachSessions(built),
      attachPersistence: (sessions) => {
        registry = sessions;
        return attachSessionPersistence(sessions, store);
      },
    }),
  });
  opened.push(handler);
  const client = createWireClient({
    baseUrl: BASE_URL,
    fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
  });
  const events = await client.openEvents(threadId);
  const session: Session = {
    client,
    events,
    frames: [],
    controller,
    sessions: () => {
      if (registry === undefined) throw new Error('日誌還沒接上');
      return registry;
    },
    threadId,
    state: emptyConversation(),
  };
  await client.runStart(threadId, '動手');
  return session;
}

async function until(session: Session, done: (session: Session) => boolean): Promise<void> {
  while (!done(session)) {
    const next = await session.events.next();
    if (next.done === true) break;
    session.frames.push(next.value);
    session.state = reduceConversation(session.state, next.value);
  }
}

const requested = (session: Session): boolean =>
  session.frames.some((frame) => frame.method === 'input.requested');

/** 這一輪收完了：模型講完 `turns` 輪話。 */
const settled =
  (turns: number) =>
  (session: Session): boolean =>
    session.state.status === 'idle' &&
    session.state.entries.filter((entry) => entry.kind === 'ai' && !entry.streaming).length >=
      turns;

async function approve(session: Session): Promise<void> {
  const pending = approvalAt(session.state.pendings);
  await session.client.inputRespond(session.threadId, {
    namespace: [...pending.namespace],
    interrupt_id: pending.interruptId,
    response: uniformDecisions(pending, 'approve'),
  });
  session.state = appendDecision(session.state, pending.interruptId, 'approve');
}

/** root 日誌的事件，只留 `types` 這幾種，照 seq 排。 */
function rootEvents(session: Session, types: readonly string[]): SessionEvent[] {
  const root = session
    .sessions()
    .list()
    .find((each) => each.address.kind === 'root');
  if (root === undefined) throw new Error('沒有 root 日誌');
  return root.log.events.filter((event) => types.includes(event.type));
}

const CALL_ALPHA = (id: string): ScriptedTurn => ({
  content: `動 ${GATED}。`,
  toolCalls: [{ name: GATED, id, args: {} }],
});

describe('政策 never：要核准的工具回絕，不發中斷', () => {
  it('從頭 never：沒有 input.requested、沒有 interrupt/raised，日誌是一對 asked＋decided(rejected)，碼是 APPROVAL_POLICY_NEVER', async () => {
    const session = await open('n1', [CALL_ALPHA('call-n1'), { content: '收工。' }], {
      policy: 'never',
    });
    await until(session, settled(2));

    // 前提：工具確實沒有跑，而且整輪走完，不是卡在某個地方。
    expect(ran).toEqual([]);
    expect(requested(session)).toBe(false);
    expect(rootEvents(session, ['interrupt/raised'])).toEqual([]);

    const result = rootEvents(session, ['tool/result'])[0];
    expect(result?.data).toMatchObject({
      callId: 'call-n1',
      isError: true,
      error: { code: APPROVAL_POLICY_NEVER },
    });
    const [asked, decided] = rootEvents(session, ['approval/asked', 'approval/decided']);
    expect(asked?.data).toMatchObject({ toolName: GATED, callId: 'call-n1' });
    expect(decided?.data).toEqual({ id: (asked?.data as { id: string }).id, outcome: 'rejected' });
    // 模型看到的字說的是「政策是不問」，不是「入口沒有人在」。
    expect(JSON.stringify(result?.data)).toContain('核准政策是不問');
  });

  it('對照：政策 ask → 同一個工具停在核准點，核准之後才跑', async () => {
    const session = await open('n2', [CALL_ALPHA('call-n2'), { content: '收工。' }], {
      policy: 'ask',
    });
    await until(session, requested);
    expect(ran).toEqual([]);
    await approve(session);
    await until(session, settled(2));
    expect(ran).toEqual([GATED]);
  });
});

describe('執行中切換，驗到第二輪', () => {
  it('第一輪 ask（人核准、工具跑）→ 切到 never → 第二輪同一個工具被回絕、不再發中斷', async () => {
    const session = await open(
      's1',
      [
        CALL_ALPHA('call-1'),
        { content: '第一輪收工。' },
        CALL_ALPHA('call-2'),
        { content: '第二輪收工。' },
      ],
      { policy: 'ask' },
    );
    await until(session, requested);
    await approve(session);
    await until(session, settled(2));
    expect(ran).toEqual([GATED]);
    const interruptsAfterFirst = rootEvents(session, ['interrupt/raised']).length;
    expect(interruptsAfterFirst).toBe(1);

    expect(session.controller.switchTo('never').kind).toBe('switched');
    await session.client.runStart('s1', '再來一次');
    await until(session, settled(4));

    // 第二輪：沒有再多一顆中斷，工具沒有再跑，回絕帶碼。
    expect(rootEvents(session, ['interrupt/raised'])).toHaveLength(interruptsAfterFirst);
    expect(ran).toEqual([GATED]);
    const results = rootEvents(session, ['tool/result']);
    expect(results.at(-1)?.data).toMatchObject({
      callId: 'call-2',
      isError: true,
      error: { code: APPROVAL_POLICY_NEVER },
    });
    // 日誌上：起始 ask、切換 never，各一顆，順序對。
    expect(rootEvents(session, ['approval/policy']).map((event) => event.data)).toEqual([
      { policy: 'ask' },
      { policy: 'never' },
    ]);
  });
});

describe('拆旗標：never 只管核准，提問照常；入口沒有人在才讓提問拒絕', () => {
  const ASK: ScriptedTurn = {
    content: '我先問。',
    toolCalls: [
      {
        name: ASK_USER_QUESTION_TOOL_NAME,
        id: 'ask-1',
        args: { questions: [{ id: 'day', question: '哪一天？', options: [{ label: '週一' }] }] },
      },
    ],
  };

  it('政策 never、有人在：ask_user_question 照常發中斷', async () => {
    const session = await open('q1', [ASK, { content: '收工。' }], {
      policy: 'never',
      plugins: [humanChannelPlugin(), createAskUserPlugin()],
    });
    await until(session, requested);
    expect(rootEvents(session, ['interrupt/raised'])).toHaveLength(1);
    // 是問答的中斷，不是核准：沒有核准事件。
    expect(rootEvents(session, ['approval/asked', 'approval/decided'])).toEqual([]);
  });

  it('反例：入口沒有人在（approvals.enabled: false）、政策 ask：ask_user_question 拒絕，不發中斷', async () => {
    const session = await open('q2', [ASK, { content: '收工。' }], {
      policy: 'ask',
      approvalsEnabled: false,
      plugins: [createAskUserPlugin()],
    });
    await until(session, settled(2));
    expect(requested(session)).toBe(false);
    expect(rootEvents(session, ['interrupt/raised'])).toEqual([]);
  });
});

describe('日誌：起始值與切換', () => {
  it('接上日誌釘起始值；淨變化為零不寫；切換各寫一顆', async () => {
    const session = await open('l1', [{ content: '收工。' }], { policy: 'ask' });
    await until(session, settled(1));
    expect(rootEvents(session, ['approval/policy']).map((event) => event.data)).toEqual([
      { policy: 'ask' },
    ]);
    session.controller.switchTo('ask');
    expect(rootEvents(session, ['approval/policy'])).toHaveLength(1);
    session.controller.switchTo('never');
    session.controller.switchTo('never');
    expect(rootEvents(session, ['approval/policy']).map((event) => event.data)).toEqual([
      { policy: 'ask' },
      { policy: 'never' },
    ]);
  });
});
