import { ToolMessage } from '@langchain/core/messages';
import {
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
  ToolExecution,
} from '@nexus/core';
import { describe, expect, it } from 'vitest';
import {
  createPlanModePlugin,
  EXIT_PLAN_MODE_TOOL_NAME,
  NOT_IN_PLAN_MODE_MESSAGE,
  PLAN_ALREADY_ACTIVE_MESSAGE,
  PLAN_ALREADY_INACTIVE_MESSAGE,
  PLAN_ARGS_ERROR_MESSAGE,
  PLAN_COMMAND_HINT,
  PLAN_COMMAND_NAME,
  PLAN_ENTERED_MESSAGE,
  PLAN_LEFT_MESSAGE,
  PLAN_MODE_CAPABILITY,
  PLAN_MODE_MIDDLEWARE_NAME,
  PLAN_NOT_ATTACHED_MESSAGE,
  PLAN_NOT_ATTACHED_TOOL_MESSAGE,
  planAmbiguousMessage,
  recordedPlanMode,
} from './index.js';
import type { PlanModePluginOptions } from './index.js';

/** 直接跑 `/plan` 的 handler。REPL 那一層歸 `apps/harness` 的測試。 */
async function runPlan(
  commands: Pick<CommandRegistrationPoint, 'find'>,
  rawInput: string,
): Promise<CommandResult> {
  const definition = commands.find(PLAN_COMMAND_NAME);
  if (definition === undefined) throw new Error('沒有註冊 /plan');
  return definition.handler({
    commandId: 'cmd-test',
    rawInput,
    signal: new AbortController().signal,
  });
}

/**
 * 把這次組裝接上一份 root 日誌，同組裝點的 `attachSession` 對參與者做的那一半。
 *
 * **warn 一律當失敗**：參與者壞掉只換來一行 warn（日誌自己的圍堵），不當失敗的話，一個
 * 折疊拋出來的實作在這裡會是綠的。
 */
function attach(registry: PluginRegistry, log: SessionLog): () => void {
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
 * root 上模式外的那條由 middleware 擋，驗收在 `apps/harness/src/plan-mode.test.ts`。這兩條
 * 在真的組裝裡到不了：沒接日誌就沒有日誌可記，subagent 那一份又會先撞上核准閘門。
 */
describe('exit_plan_mode 沒有生效時', () => {
  const CALL = {
    name: EXIT_PLAN_MODE_TOOL_NAME,
    args: { plan: '# 計劃' },
    id: 'call-1',
    type: 'tool_call',
  };

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

  it('沒接日誌、在 subagent 裡：都是錯誤、不帶碼、文字不變', async () => {
    const { registry } = await loadPlugins([createPlanModePlugin()]);
    const exit = registry.tools.effective().get(EXIT_PLAN_MODE_TOOL_NAME)?.value;
    const notAttached = await exit?.invoke(
      CALL as never,
      { configurable: { checkpoint_ns: 'tools:call-1' } } as never,
    );
    expect(verdictOf(notAttached)).toEqual({
      text: PLAN_NOT_ATTACHED_TOOL_MESSAGE,
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
      text: NOT_IN_PLAN_MODE_MESSAGE,
      status: 'error',
      error: undefined,
      id: 'call-1',
    });
  });
});

/**
 * 薄測試，只斷言「`apply` 真的往那幾個註冊點放了東西」，加上兩條**順序**的斷言。
 *
 * 計劃模式**真的有沒有作用**的驗收在組裝點（`apps/harness` 的 `plan-mode.test.ts`）
 * ——那裡看的是模型收到的 prompt 與跑完之後的日誌，這裡看的是 registry 的內容與 `/plan`。
 */
describe('createPlanModePlugin', () => {
  it('六個註冊點都放了東西', async () => {
    const { registry } = await loadPlugins([createPlanModePlugin()]);

    expect(registry.capabilities.has(PLAN_MODE_CAPABILITY)).toBe(true);
    expect(registry.sessions.installers()).toHaveLength(1);
    expect([...registry.tools.effective().keys()]).toContain(EXIT_PLAN_MODE_TOOL_NAME);
    expect(registry.middleware.list().map((entry) => entry.value.middleware.name)).toEqual([
      PLAN_MODE_MIDDLEWARE_NAME,
    ]);
    expect(registry.approvals.listeners()).toHaveLength(1);
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

  /**
   * **提示字串要跟真的收得下的東西一致。** dsh 是 `[off|message]`，那個 `message` 靠
   * `agent.steer()`，我們沒有——寫了收不下的東西等於在騙打字的人。
   */
  it('提示是 [off]，不是 dsh 的 [off|message]', async () => {
    const { registry } = await loadPlugins([createPlanModePlugin()]);

    expect(registry.commands.list()[0]?.input?.hint).toBe(PLAN_COMMAND_HINT);
    expect(PLAN_COMMAND_HINT).toBe('[off]');
  });

  /**
   * **`prepend` 不是偏好。** 沒有它，`fold` 會把這個 middleware 排到核准閘門**之後**，
   * 於是一次模式外的 `exit_plan_mode` 會先撞上閘門——headless 入口回的是「沒有人被
   * 問到」，而真正的原因是「你不在計劃模式」。順序決定模型看到哪一句。
   */
  it('middleware 是 prepend 的', async () => {
    const { registry } = await loadPlugins([createPlanModePlugin()]);

    expect(registry.middleware.list()[0]?.value.prepend).toBe(true);
  });

  /** 閘門只認自己那一個工具名，其餘一律往下傳——不呼叫 `next()` 就會把別人短路掉。 */
  it('閘門只對 exit_plan_mode 要核准，別的工具原樣往下傳', async () => {
    const { registry } = await loadPlugins([createPlanModePlugin()]);
    const listener = registry.approvals.listeners()[0]?.value;
    if (listener === undefined) throw new Error('沒有掛上 listener');

    const exec = (name: string): ToolExecution => ({ name, args: {}, callId: 'c1' });
    const fellThrough = { kind: 'allow' } as const;

    // listener 對自己那個工具是**同步**回答的（沒有 `next()` 要等），所以兩邊都先
    // `Promise.resolve` 包一層——`.resolves` 收不了裸物件。
    const decide = async (name: string): Promise<unknown> =>
      Promise.resolve(listener(exec(name), () => Promise.resolve(fellThrough)));

    expect(await decide(EXIT_PLAN_MODE_TOOL_NAME)).toMatchObject({ kind: 'ask' });
    expect(await decide('echo')).toEqual(fellThrough);
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

  /**
   * **不認得的參數回 error，不是「當成進入」。** 安靜吞掉打錯的參數，會讓 `/plan of`
   * 看起來成功了而其實做了相反的事。這條關係也是這個套件配套入口檢的那一條。
   */
  it('收不下的參數回 error，而且沒有改到模式', async () => {
    const { registry, log } = await assemble();

    expect(await runPlan(registry.commands, ' of')).toEqual({
      kind: 'error',
      text: PLAN_ARGS_ERROR_MESSAGE,
    });
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

  /** 參數先判：打錯的參數不管有沒有接上，都落定成 `error`，配套入口那條才站得住。 */
  it('沒接會話日誌時，打錯的參數仍然回參數的錯', async () => {
    const { registry } = await loadPlugins([createPlanModePlugin()]);

    expect(await runPlan(registry.commands, 'of')).toEqual({
      kind: 'error',
      text: PLAN_ARGS_ERROR_MESSAGE,
    });
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
