import { ToolMessage } from '@langchain/core/messages';
import {
  createHostServicesPlugin,
  createSessionRunner,
  loadPlugins,
  SessionLog,
  SessionRegistry,
  toolErrorOf,
} from '@nexus/core';
import type {
  CommandRegistrationPoint,
  CommandResult,
  PluginRegistry,
  SessionEvent,
} from '@nexus/core';
import { interrupt } from '@langchain/langgraph';
import { describe, expect, it, vi } from 'vitest';
import {
  createPlanModePlugin,
  DEFAULT_PLAN_GUIDANCE,
  planModeConfigSchema,
  planModePlugin,
  EXIT_PLAN_MODE_TOOL_NAME,
  NOT_IN_PLAN_MODE_MESSAGE,
  PLAN_ALREADY_ACTIVE_MESSAGE,
  PLAN_APPROVE_LABEL,
  PLAN_APPROVED_MESSAGE,
  PLAN_REVIEW_QUESTION_ID,
  PLAN_ALREADY_INACTIVE_MESSAGE,
  PLAN_COMMAND_HINT,
  PLAN_COMMAND_NAME,
  PLAN_ENTERED_MESSAGE,
  PLAN_HEADING_REQUIRED_MESSAGE,
  PLAN_LEFT_MESSAGE,
  PLAN_MODE_MIDDLEWARE_NAME,
  PLAN_NO_REVIEWER_MESSAGE,
  PLAN_NOT_ATTACHED_MESSAGE,
  PLAN_NOT_ATTACHED_TOOL_MESSAGE,
  planAmbiguousMessage,
  recordedPlanMode,
} from './index.js';
import type { PlanModePluginOptions } from './index.js';

// `exit_plan_mode` 在本體裡呼叫 `interrupt()`，圖外呼叫會拋。這個檔只有「待關」那一組會走到它，
// 用替身直接回人的答案；真的中斷與 resume 在 `apps/harness` 的 `plan-mode.test.ts` 與 `plan-review-wire.test.ts`。
vi.mock('@langchain/langgraph', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@langchain/langgraph')>()),
  interrupt: vi.fn(),
}));

/**
 * 每個註冊表接上的第一份 root 日誌。命令的 `sessionLog` 由執行器交給 handler（#688），
 * 這裡用它當「執行器手上那一份」；一份都沒接的註冊表交一份沒人接的。
 */
const firstLogOf = new WeakMap<object, SessionLog>();

/** 直接跑 `/plan` 的 handler。REPL 那一層歸 `apps/harness` 的測試。 */
async function runPlan(
  commands: Pick<CommandRegistrationPoint, 'find'>,
  rawInput: string,
  steer: (text: string) => void = () => undefined,
): Promise<CommandResult> {
  const definition = commands.find(PLAN_COMMAND_NAME);
  if (definition === undefined) throw new Error('沒有註冊 /plan');
  return definition.handler({
    commandId: 'cmd-test',
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
    sessionLog: firstLogOf.get(commands) ?? new SessionLog('unattached'),
    steer,
  });
}

/**
 * 把這次組裝接上一份 root 日誌，同組裝點的 `attachSession` 對參與者做的那一半。
 *
 * **warn 一律當失敗**：參與者壞掉只換來一行 warn（日誌自己的圍堵），不當失敗的話，一個
 * 折疊拋出來的實作在這裡會是綠的。
 */
function attach(registry: PluginRegistry, log: SessionLog): () => void {
  if (!firstLogOf.has(registry.commands)) firstLogOf.set(registry.commands, log);
  return createSessionRunner({
    address: { kind: 'root' },
    log,
    installers: registry.sessions.installers(),
    warn: (message) => {
      throw new Error(`不該有 warn：${message}`);
    },
  });
}

/** 建一個掛好、接上一份 root 日誌的計劃模式。`seed` 給了就是一份續接回來的日誌。 */
async function assemble(
  options?: PlanModePluginOptions,
  seed?: readonly SessionEvent[],
): Promise<{ registry: PluginRegistry; log: SessionLog }> {
  const { registry } = await loadPlugins([createPlanModePlugin(options)]);
  const log = new SessionLog('plan', seed === undefined ? {} : { seed });
  attach(registry, log);
  return { registry, log };
}

/** 日誌上每一顆 `plan/mode` 的值，依序。 */
function modes(log: SessionLog): boolean[] {
  return log.events.flatMap((event) => (event.type === 'plan/mode' ? [event.data.active] : []));
}

/** 上一個行程留下的日誌：開過一次計劃模式。 */
function earlierEvents(active: boolean): readonly SessionEvent[] {
  const earlier = new SessionLog('plan');
  earlier.append('plan/mode', { active });
  return earlier.events;
}

/**
 * **`exit_plan_mode` 工具本體那兩條沒生效的出口**（[#273](https://github.com/DemianLi/nexus-agent/issues/273)）。
 *
 * root 上模式外的那條由 `tools/pre-execute` 的監聽者擋（#1272），驗收在 `apps/harness/src/plan-mode.test.ts`。頭兩條
 * 在真的組裝裡到不了：沒接日誌就沒有日誌可記，subagent 那一份又會先被那位監聽者擋掉。
 * 後兩條（#652）在問人之前就擋，所以不用真的圖也量得到。
 */
describe('exit_plan_mode 沒有生效時', () => {
  const CALL = {
    name: EXIT_PLAN_MODE_TOOL_NAME,
    args: { plan: '# 計劃' },
    id: 'call-1',
    type: 'tool_call',
  };

  it('沒接日誌、在 subagent 裡：都是錯誤、不帶碼、文字是 `Error: ` 加原句', async () => {
    const { registry } = await loadPlugins([createPlanModePlugin()]);
    const exit = registry.tools.effective().get(EXIT_PLAN_MODE_TOOL_NAME)?.value;
    const notAttached = await exit?.invoke(
      CALL as never,
      { configurable: { checkpoint_ns: 'tools:call-1' } } as never,
    );
    expect(verdictOf(notAttached)).toEqual({
      text: `Error: ${PLAN_NOT_ATTACHED_TOOL_MESSAGE}`,
      status: 'error',
      error: undefined,
      id: 'call-1',
    });

    registry.sessions.bind(new SessionRegistry('plan'));
    const notRoot = await exit?.invoke(
      CALL as never,
      { configurable: { checkpoint_ns: 'tools:spawn-1|tools:call-1' } } as never,
    );
    expect(verdictOf(notRoot)).toEqual({
      text: `Error: ${NOT_IN_PLAN_MODE_MESSAGE}`,
      status: 'error',
      error: undefined,
      id: 'call-1',
    });
  });

  /** 照 dsh 的先後：先看計劃是不是以 `#` 標題開頭，再看有沒有人可以回答。兩條都不寫日誌。 */
  it('計劃不是以 # 標題開頭、或沒有人可以回答：都在問人之前擋，模式不動', async () => {
    const { registry } = await loadPlugins([
      createHostServicesPlugin({ channel: { kind: 'policy-never' } }),
      createPlanModePlugin({ startActive: true }),
    ]);
    const sessions = new SessionRegistry('plan');
    registry.sessions.bind(sessions);
    attach(registry, sessions.root);
    const exit = registry.tools.effective().get(EXIT_PLAN_MODE_TOOL_NAME)?.value;
    const root = { configurable: { checkpoint_ns: 'tools:call-1' } } as never;

    for (const plan of ['計劃', '  ', '#計劃', '# ']) {
      const refused = await exit?.invoke({ ...CALL, args: { plan } } as never, root);
      expect(verdictOf(refused)).toMatchObject({
        text: `Error: ${PLAN_HEADING_REQUIRED_MESSAGE}`,
        error: undefined,
      });
    }
    // 開頭的空白照 dsh 先修掉再判。
    const noReviewer = await exit?.invoke(
      { ...CALL, args: { plan: '\n  # 計劃\n\n先看再改。' } } as never,
      root,
    );
    expect(verdictOf(noReviewer)).toEqual({
      text: `Error: ${PLAN_NO_REVIEWER_MESSAGE}`,
      status: 'error',
      error: undefined,
      id: 'call-1',
    });
    expect(sessions.root.events.filter((event) => event.type === 'plan/mode')).toEqual([]);
  });
});

/**
 * 薄測試，只斷言「`apply` 真的往那幾個註冊點放了東西」，加上兩條**順序**的斷言。
 *
 * 計劃模式**真的有沒有作用**的驗收在組裝點（`apps/harness` 的 `plan-mode.test.ts`）
 * ——那裡看的是模型收到的 prompt 與跑完之後的日誌，這裡看的是 registry 的內容與 `/plan`。
 */
describe('createPlanModePlugin', () => {
  it('四個註冊點都放了東西，核准閘門一位都沒有', async () => {
    const { registry } = await loadPlugins([createPlanModePlugin()]);

    expect(registry.sessions.installers()).toHaveLength(1);
    expect([...registry.tools.effective().keys()]).toContain(EXIT_PLAN_MODE_TOOL_NAME);
    // `middleware` 可能是 `undefined`——那是 `useWithBackend()` 註冊的那一種（#388）。
    // **這裡不補 `?.`就好**：計劃模式走的是直接給實例那條，拿不到名字就是註冊方式變了。
    expect(registry.middleware.list().map((entry) => entry.value.middleware?.name)).toEqual([
      PLAN_MODE_MIDDLEWARE_NAME,
    ]);
    // **翻過來的絆索**（#652）：以前這裡是 1，`exit_plan_mode` 走核准。它改走提問通道之後，
    // 這個 plugin 不該再有任何一位閘門——有的話，計劃又會變成一張核准卡。
    expect(registry.approvals.listeners()).toEqual([]);
    expect(registry.commands.list().map((entry) => entry.name)).toEqual([PLAN_COMMAND_NAME]);
  });

  /**
   * **模式不再住在 graph state 裡。** middleware 上還有 `stateSchema` 的話，就有兩份真相——
   * checkpointer 那一份與日誌那一份，而續接只帶得回其中一份。
   */
  it('middleware 沒有 stateSchema，也沒有邊界 hook', async () => {
    const { registry } = await loadPlugins([createPlanModePlugin()]);
    const middleware = registry.middleware.list()[0]?.value.middleware as unknown as Record<
      string,
      unknown
    >;

    expect(middleware.stateSchema).toBeUndefined();
    expect(middleware.beforeAgent).toBeUndefined();
    expect(middleware.afterAgent).toBeUndefined();
  });

  /** 收得下自由訊息之後，提示字串跟 dsh 一樣（#776）。 */
  it('提示是 [off|message]，同 dsh', async () => {
    const { registry } = await loadPlugins([createPlanModePlugin()]);

    expect(registry.commands.list()[0]?.input?.hint).toBe(PLAN_COMMAND_HINT);
    expect(PLAN_COMMAND_HINT).toBe('[off|message]');
  });

  /**
   * **`prepend` 的理由換了**（[#1272](https://github.com/DemianLi/nexus-agent/issues/1272)）。以前它是模式外拒絕擋在核准閘門
   * 前面的唯一手段；現在那一層是 `tools/pre-execute` 的監聽者，位置由 `fold.ts` 決定。`prepend` 剩下的用處是
   * 指引站在記憶 plugin 外面（`concat` 之後記憶才接上去）。行為不變，所以斷言不變。
   */
  it('middleware 是 prepend 的', async () => {
    const { registry } = await loadPlugins([createPlanModePlugin()]);

    expect(registry.middleware.list()[0]?.value.prepend).toBe(true);
  });

  /** 模式外拒絕搬到事件匯流排之後，middleware 只剩模型呼叫那一件。 */
  it('middleware 沒有 wrapToolCall；模式外拒絕是 tools/pre-execute 上恰好一位監聽者', async () => {
    const { registry } = await loadPlugins([createPlanModePlugin()]);
    const middleware = registry.middleware.list()[0]?.value.middleware as unknown as Record<
      string,
      unknown
    >;

    expect(middleware.wrapToolCall).toBeUndefined();
    expect(typeof middleware.wrapModelCall).toBe('function');
    expect(
      registry.events
        .listeners()
        .filter((listener) => listener.name === 'tools/pre-execute')
        .map((listener) => listener.origin?.name),
    ).toEqual(['plan-mode']);
  });
});

/**
 * 監聽者本身（S1b）：直接派發 `tools/pre-execute`，不經 agent。**逐位元組等價**的證據在
 * `apps/harness` 的 `plan-mode-refusal-differential.test.ts`；這裡看的是三個分岔各給什麼決定。
 */
describe('tools/pre-execute 監聽者', () => {
  const exec = (
    name: string,
    agent: { kind: 'root' } | { kind: 'subagent'; runId: string } | undefined,
  ) => ({
    callId: 'call-1',
    name,
    args: Object.freeze({}),
    agent,
  });
  const allow = () => Promise.resolve({ kind: 'allow' as const });

  async function mount(startActive: boolean, bind: boolean) {
    const { registry } = await loadPlugins([createPlanModePlugin({ startActive })]);
    if (bind) registry.sessions.bind(new SessionRegistry('plan'));
    return registry;
  }

  it('別的工具：放行，不查模式', async () => {
    const registry = await mount(false, true);

    expect(
      await registry.dispatch.waterfall('tools/pre-execute', exec('echo', { kind: 'root' }), allow),
    ).toEqual({ kind: 'allow' });
  });

  it('exit_plan_mode：root 在模式外 → 拒絕，理由就是 NOT_IN_PLAN_MODE_MESSAGE', async () => {
    const registry = await mount(false, true);

    expect(
      await registry.dispatch.waterfall(
        'tools/pre-execute',
        exec(EXIT_PLAN_MODE_TOOL_NAME, { kind: 'root' }),
        allow,
      ),
    ).toEqual({ kind: 'deny', reason: NOT_IN_PLAN_MODE_MESSAGE });
  });

  it('exit_plan_mode：子代理 → 拒絕（它的 session 從沒進過計劃模式）', async () => {
    const registry = await mount(true, true);

    expect(
      await registry.dispatch.waterfall(
        'tools/pre-execute',
        exec(EXIT_PLAN_MODE_TOOL_NAME, { kind: 'subagent', runId: 'tools:spawn-1' }),
        allow,
      ),
    ).toEqual({ kind: 'deny', reason: NOT_IN_PLAN_MODE_MESSAGE });
  });

  it('exit_plan_mode：沒接日誌、認不出身分 → 退回 startActive（開放行、關拒絕）', async () => {
    const on = await mount(true, false);
    const off = await mount(false, false);

    expect(
      await on.dispatch.waterfall(
        'tools/pre-execute',
        exec(EXIT_PLAN_MODE_TOOL_NAME, undefined),
        allow,
      ),
    ).toEqual({ kind: 'allow' });
    expect(
      await off.dispatch.waterfall(
        'tools/pre-execute',
        exec(EXIT_PLAN_MODE_TOOL_NAME, undefined),
        allow,
      ),
    ).toEqual({ kind: 'deny', reason: NOT_IN_PLAN_MODE_MESSAGE });
  });
});

/** 模型看到的字、狀態、碼與 id。 */
function verdictOf(result: unknown): Record<string, unknown> {
  if (!ToolMessage.isInstance(result)) throw new Error(`回的不是一則工具訊息：${String(result)}`);
  return {
    text: String(result.content),
    status: result.status,
    error: toolErrorOf(result),
    id: result.tool_call_id,
  };
}

/**
 * **同意之後模式在下一個模型步驟之前才關**（#652，照 dsh 的 `pendingIntents`）。
 *
 * 真的圖上「工具結果之後、下一次回覆之前」那條順序在 `apps/harness` 的 `plan-mode.test.ts` 量；這裡量真的圖
 * 很難排出來的兩格：子代理的模型呼叫交不出 root 的待關，以及同意之後、下一步之前人打的 `/plan` 把待關丟掉
 * （產品路徑上是「同意之後那一輪被停掉」）。
 */
describe('同意之後的待關', () => {
  const CALL = {
    name: EXIT_PLAN_MODE_TOOL_NAME,
    args: { plan: '# 計劃' },
    id: 'call-1',
    type: 'tool_call',
  };

  /** 掛好、接上、停在計劃模式裡，替身讓 `exit_plan_mode` 拿到「同意」。 */
  async function approved(): Promise<{
    registry: PluginRegistry;
    log: SessionLog;
    modelStep: (checkpointNs: string) => Promise<string>;
  }> {
    vi.mocked(interrupt).mockReturnValue({
      answers: [{ id: PLAN_REVIEW_QUESTION_ID, selected: [PLAN_APPROVE_LABEL] }],
    });
    const { registry } = await loadPlugins([createPlanModePlugin({ startActive: true })]);
    const sessions = new SessionRegistry('plan');
    registry.sessions.bind(sessions);
    attach(registry, sessions.root);
    const exit = registry.tools.effective().get(EXIT_PLAN_MODE_TOOL_NAME)?.value;
    const result = await exit?.invoke(
      CALL as never,
      { configurable: { checkpoint_ns: 'tools:call-1' } } as never,
    );
    expect(verdictOf(result)).toMatchObject({ text: PLAN_APPROVED_MESSAGE, status: 'success' });
    const middleware = registry.middleware.list()[0]?.value.middleware as unknown as {
      wrapModelCall: (request: unknown, handler: (request: unknown) => unknown) => unknown;
    };
    // 一次模型呼叫：回傳這一步的 system prompt（指引在不在）。
    const modelStep = async (checkpointNs: string): Promise<string> => {
      const seen = (await middleware.wrapModelCall(
        { runtime: { configurable: { checkpoint_ns: checkpointNs } }, systemPrompt: '' },
        (request) => request,
      )) as { systemPrompt?: string };
      return seen.systemPrompt ?? '';
    };
    return { registry, log: sessions.root, modelStep };
  }

  it('工具回成功時模式還開著；子代理的步驟交不出它；root 的下一步交出去，只交一次', async () => {
    const { log, modelStep } = await approved();
    expect(modes(log)).toEqual([]);

    expect(await modelStep('tools:spawn-1|model_request:a')).toBe('');
    expect(modes(log)).toEqual([]);

    expect(await modelStep('model_request:b')).not.toContain(DEFAULT_PLAN_GUIDANCE);
    expect(modes(log)).toEqual([false]);
    await modelStep('model_request:c');
    expect(modes(log)).toEqual([false]);
  });

  it('同意之後、下一步之前打 /plan：待關被丟掉，模式留著，下一步照樣有指引', async () => {
    const { registry, log, modelStep } = await approved();

    expect(await runPlan(registry.commands, '')).toEqual({
      kind: 'success',
      text: PLAN_ALREADY_ACTIVE_MESSAGE,
    });
    expect(await modelStep('model_request:b')).toContain(DEFAULT_PLAN_GUIDANCE);
    expect(modes(log)).toEqual([]);
  });

  it('同意之後、下一步之前打 /plan off：照常關，下一步不會再寫第二顆', async () => {
    const { registry, log, modelStep } = await approved();

    expect(await runPlan(registry.commands, 'off')).toEqual({
      kind: 'success',
      text: PLAN_LEFT_MESSAGE,
    });
    await modelStep('model_request:b');
    expect(modes(log)).toEqual([false]);
  });
});

/**
 * `/plan` 的兩個結果，**兩個都要到得了**，而且 `committed` **當場就在日誌上**。
 *
 * `queued` 與 `cancelled` 不在裡面是刻意的（見 `index.ts` 檔頭）：兩個都要「輪還開著、
 * 選擇排著還沒提交」才成立，而命令永遠跑在兩輪之間、選擇當場提交。
 */
describe('/plan 的結果', () => {
  it('進、退、再退：committed → committed → noop，日誌上剛好兩顆', async () => {
    const { registry, log } = await assemble();

    expect(await runPlan(registry.commands, '')).toEqual({
      kind: 'success',
      text: PLAN_ENTERED_MESSAGE,
    });
    expect(modes(log)).toEqual([true]);
    expect(await runPlan(registry.commands, ' off')).toEqual({
      kind: 'success',
      text: PLAN_LEFT_MESSAGE,
    });
    expect(await runPlan(registry.commands, ' off')).toEqual({
      kind: 'success',
      text: PLAN_ALREADY_INACTIVE_MESSAGE,
    });
    expect(modes(log)).toEqual([true, false]);
  });

  /**
   * **上一版在這裡回 `cancelled`。** 那時選擇要等下一次 `beforeAgent` 才交出去，中間沒有
   * 一輪的話第二次是「收回來」。現在選擇當場寫進日誌，沒有東西排著可以收——兩次都是真的。
   */
  it('/plan 之後緊接著 /plan off 是兩次 committed，不是 cancelled', async () => {
    const { registry, log } = await assemble();

    await runPlan(registry.commands, '');
    expect(await runPlan(registry.commands, 'off')).toEqual({
      kind: 'success',
      text: PLAN_LEFT_MESSAGE,
    });
    expect(modes(log)).toEqual([true, false]);
  });

  it('同一個方向按第二次是 noop，而且不寫日誌', async () => {
    const { registry, log } = await assemble({ startActive: true });

    expect(await runPlan(registry.commands, '')).toEqual({
      kind: 'success',
      text: PLAN_ALREADY_ACTIVE_MESSAGE,
    });
    expect(modes(log)).toEqual([]);
  });
});

/**
 * `/plan <message>`（[#776](https://github.com/DemianLi/nexus-agent/issues/776)）：`off` 以外都是進入，
 * 非空的部分交給宿主的 `steer`，同 dsh。
 */
describe('/plan <message>', () => {
  it('進入並 steer 那句話（去掉頭尾空白），回的還是「開了」', async () => {
    const { registry, log } = await assemble();
    const steered: string[] = [];

    expect(
      await runPlan(registry.commands, '  幫我規劃遷移  ', (text) => steered.push(text)),
    ).toEqual({ kind: 'success', text: PLAN_ENTERED_MESSAGE });
    expect(steered).toEqual(['幫我規劃遷移']);
    expect(modes(log)).toEqual([true]);
  });

  it('本來就在計劃模式：話照送，回「已經在裡面」，不多寫一顆 plan/mode', async () => {
    const { registry, log } = await assemble();
    await runPlan(registry.commands, '');
    const steered: string[] = [];

    expect(await runPlan(registry.commands, '換個方向', (text) => steered.push(text))).toEqual({
      kind: 'success',
      text: PLAN_ALREADY_ACTIVE_MESSAGE,
    });
    expect(steered).toEqual(['換個方向']);
    expect(modes(log)).toEqual([true]);
  });

  it('不帶話、`off` 都不 steer', async () => {
    const { registry } = await assemble();
    const steered: string[] = [];
    const steer = (text: string): void => void steered.push(text);

    await runPlan(registry.commands, '', steer);
    await runPlan(registry.commands, '   ', steer);
    await runPlan(registry.commands, ' off ', steer);
    expect(steered).toEqual([]);
  });

  /**
   * **`off` 以外都是訊息，同 dsh。** `/plan of`（打錯的 `off`）與 `/plan off 再說`
   * 都是進計劃模式並把整句送出去——以前 `of` 回 error，那條翻過面了。
   */
  it('`of`、`off 再說` 是訊息，不是離開', async () => {
    const { registry, log } = await assemble();
    const steered: string[] = [];
    const steer = (text: string): void => void steered.push(text);

    await runPlan(registry.commands, ' of', steer);
    await runPlan(registry.commands, 'off 再說', steer);
    expect(steered).toEqual(['of', 'off 再說']);
    expect(modes(log)).toEqual([true]);
  });

  /**
   * **宿主拒收就什麼都不改。** steer 排在動任何東西之前，所以被拒收的命令沒有寫 `plan/mode`，
   * 也沒有丟掉 `exit_plan_mode` 排著的待關（那是命令成功才做的事）。
   */
  it('宿主拒收那句話：例外冒出去，模式沒動', async () => {
    const { registry, log } = await assemble();
    const refuse = (): void => {
      throw new Error('這句話不收');
    };

    await expect(runPlan(registry.commands, '幫我', refuse)).rejects.toThrow('這句話不收');
    expect(modes(log)).toEqual([]);
    // 沒改到模式：下一次 `/plan` 仍然是「開了」而不是「已經在裡面」。
    expect(await runPlan(registry.commands, '')).toEqual({
      kind: 'success',
      text: PLAN_ENTERED_MESSAGE,
    });
  });
});

/**
 * **沒有日誌的組裝寫不動模式，而它要說出來。** 命令在接線之前就註冊好了，所以這條路
 * 走得到——回「開了」而什麼都沒發生，比回一句錯更糟。
 */
describe('沒接、或接了不只一份', () => {
  it('沒接會話日誌：/plan 說得出原因', async () => {
    const { registry } = await loadPlugins([createPlanModePlugin()]);

    expect(await runPlan(registry.commands, '')).toEqual({
      kind: 'error',
      text: PLAN_NOT_ATTACHED_MESSAGE,
    });
  });

  /** 沒接上的命令不能開輪：話留在原地，沒有東西被送出去。 */
  it('沒接會話日誌時，帶話的 /plan 不 steer', async () => {
    const { registry } = await loadPlugins([createPlanModePlugin()]);
    const steered: string[] = [];

    expect(await runPlan(registry.commands, '幫我', (text) => steered.push(text))).toEqual({
      kind: 'error',
      text: PLAN_NOT_ATTACHED_MESSAGE,
    });
    expect(steered).toEqual([]);
  });

  it('接了兩份：挑不出來，兩份都不動', async () => {
    const { registry } = await loadPlugins([createPlanModePlugin()]);
    const first = new SessionLog('plan-a');
    const second = new SessionLog('plan-b');
    attach(registry, first);
    attach(registry, second);

    expect(await runPlan(registry.commands, '')).toEqual({
      kind: 'error',
      text: planAmbiguousMessage(2),
    });
    expect(modes(first)).toEqual([]);
    expect(modes(second)).toEqual([]);
  });

  it('收掉接線之後回到沒接的樣子', async () => {
    const { registry } = await loadPlugins([createPlanModePlugin()]);
    const detach = attach(registry, new SessionLog('plan'));
    detach();

    expect(await runPlan(registry.commands, '')).toEqual({
      kind: 'error',
      text: PLAN_NOT_ATTACHED_MESSAGE,
    });
  });
});

/**
 * **續接回來的日誌折得出上一次的模式——而且要熬過 `session/end-seed`。**
 *
 * 別的配套入口都在那顆標記上重設開關，所以「在 end-seed 歸零」是這一帶最順手寫錯的那一種。
 * seed 開出來的日誌結尾一定有一顆 end-seed，這一組的每一條都跨過它。
 */
describe('續接回來的日誌', () => {
  it('上一次開著：接回來還開著，/plan 是 noop', async () => {
    const { registry, log } = await assemble({}, earlierEvents(true));

    expect(log.events.at(-1)?.type).toBe('session/end-seed');
    expect(await runPlan(registry.commands, '')).toEqual({
      kind: 'success',
      text: PLAN_ALREADY_ACTIVE_MESSAGE,
    });
  });

  /** `startActive` 只是初值：日誌上有過 `plan/mode`，就由最後那一顆說了算。 */
  it('上一次關掉了：startActive 開著也管不到', async () => {
    const { registry } = await assemble({ startActive: true }, earlierEvents(false));

    expect(await runPlan(registry.commands, 'off')).toEqual({
      kind: 'success',
      text: PLAN_ALREADY_INACTIVE_MESSAGE,
    });
  });

  it('一顆 plan/mode 都沒有的舊日誌：從 startActive 起算', async () => {
    const earlier = new SessionLog('plan');
    earlier.append('turn/start', { kind: 'message', text: '一' });
    earlier.append('turn/end', {});
    const { registry } = await assemble({ startActive: true }, earlier.events);

    expect(await runPlan(registry.commands, '')).toEqual({
      kind: 'success',
      text: PLAN_ALREADY_ACTIVE_MESSAGE,
    });
  });
});

describe('recordedPlanMode', () => {
  it('最後一顆說了算，跨得過 end-seed；一顆都沒有是 undefined', () => {
    const log = new SessionLog('plan', { seed: earlierEvents(true) });
    expect(recordedPlanMode(log.events)).toBe(true);
    log.append('plan/mode', { active: false });
    expect(recordedPlanMode(log.events)).toBe(false);
    expect(recordedPlanMode([])).toBeUndefined();
  });
});

/**
 * **那兩格必須是一組裝一份。**
 *
 * 它們放在 `apply()` 裡而不是 `createPlanModePlugin()` 的閉包裡，因為 `load.ts` 一次組裝
 * 呼叫一次 `plugin.apply(tracked)`。放錯地方**不會拋任何東西**——兩次組裝共用一份，
 * 症狀是 `/plan` 回「接了兩份」，或一個 thread 的模式開到另一個 thread 上。所以要有人釘著。
 */
describe('模式的作用範圍', () => {
  it('同一個 plugin 物件組兩次，兩邊的模式互不相干', async () => {
    const plugin = createPlanModePlugin();
    const first = await loadPlugins([plugin]);
    const second = await loadPlugins([plugin]);
    const firstLog = new SessionLog('plan-a');
    const secondLog = new SessionLog('plan-b');
    attach(first.registry, firstLog);
    attach(second.registry, secondLog);

    expect(await runPlan(first.registry.commands, '')).toEqual({
      kind: 'success',
      text: PLAN_ENTERED_MESSAGE,
    });
    // 串台的話這裡會是 `planAmbiguousMessage(2)` 或 `PLAN_ALREADY_ACTIVE_MESSAGE`。
    expect(await runPlan(second.registry.commands, '')).toEqual({
      kind: 'success',
      text: PLAN_ENTERED_MESSAGE,
    });
    expect(modes(firstLog)).toEqual([true]);
    expect(modes(secondLog)).toEqual([true]);
  });
});

describe('設定（#453）', () => {
  it('省略時由 schema 補上預設值——指引是套件的那一份，模式從關的開始', () => {
    expect(planModeConfigSchema.parse({})).toEqual({
      guidance: DEFAULT_PLAN_GUIDANCE,
      startActive: false,
    });
  });

  it('合法的覆寫會生效——夾進 prompt 的是部署給的那份原樣文本', async () => {
    const guidance = '這一台只准先講清楚要做什麼。';
    const { registry } = await assemble({ guidance, startActive: true });
    const entry = registry.middleware
      .list()
      .find((one) => one.value.middleware?.name === PLAN_MODE_MIDDLEWARE_NAME);
    const middleware = entry!.value.middleware as unknown as {
      wrapModelCall: (
        request: unknown,
        handler: (request: { systemPrompt?: string }) => unknown,
      ) => unknown;
    };
    let seen: string | undefined;
    middleware.wrapModelCall({}, (request) => {
      seen = request.systemPrompt;
      return undefined;
    });

    expect(seen).toBe(guidance);
    expect(seen).not.toBe(DEFAULT_PLAN_GUIDANCE);
  });

  it('型別錯就讓載入失敗，訊息帶 `<id> (<name>)` 與欄位路徑', async () => {
    const bad = [{ plugin: planModePlugin, config: { startActive: 'yes' } }];
    await expect(loadPlugins(bad)).rejects.toThrow('plan-mode#0 (plan-mode)');
    await expect(loadPlugins(bad)).rejects.toThrow('startActive');
  });

  it('未知欄位讓載入失敗（登記的偏離：dsh 放行）', async () => {
    await expect(
      loadPlugins([{ plugin: planModePlugin, config: { guidence: '講清楚' } }]),
    ).rejects.toThrow(/guidence/);
  });
});
