import { loadPlugins } from '@nexus/core';
import type { CommandRegistrationPoint, CommandResult, ToolExecution } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import {
  createPlanModePlugin,
  EXIT_PLAN_MODE_TOOL_NAME,
  PLAN_MODE_STATE_KEY,
  PLAN_ALREADY_ACTIVE_MESSAGE,
  PLAN_ALREADY_INACTIVE_MESSAGE,
  PLAN_ARGS_ERROR_MESSAGE,
  PLAN_COMMAND_HINT,
  PLAN_COMMAND_NAME,
  PLAN_ENTER_CANCELLED_MESSAGE,
  PLAN_ENTERED_MESSAGE,
  PLAN_LEAVE_CANCELLED_MESSAGE,
  PLAN_LEFT_MESSAGE,
  PLAN_MODE_CAPABILITY,
  PLAN_MODE_MIDDLEWARE_NAME,
} from './index.js';

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

/** agent state 的一個快照，只有這個 middleware 認得的那一格。 */
type StateShot = Record<string, unknown>;

/**
 * 把 middleware 的兩個邊界 hook 拉出來。
 *
 * **型別上要轉一層**：`AgentMiddleware` 是泛的，而 `beforeAgent` / `afterAgent` 的
 * 參數型別由 `stateSchema` 靜態推出來，registry 那側看不到。我們的兩個 hook 都不看
 * 第二個參數（runtime），所以餵一個空物件就夠。
 */
function boundaryHooks(middleware: unknown): {
  beforeAgent: (state: StateShot) => unknown;
  afterAgent: (state: StateShot) => unknown;
} {
  const hooks = middleware as {
    beforeAgent?: (state: StateShot, runtime: unknown) => unknown;
    afterAgent?: (state: StateShot, runtime: unknown) => unknown;
  };
  const { beforeAgent, afterAgent } = hooks;
  if (beforeAgent === undefined || afterAgent === undefined) {
    throw new Error('middleware 沒有掛上邊界 hook');
  }
  return {
    beforeAgent: (state) => beforeAgent(state, {}),
    afterAgent: (state) => afterAgent(state, {}),
  };
}

/** 建一個掛好的計劃模式，並把命令面與邊界 hook 一起交出去。 */
async function assemble(options?: { startActive: boolean }): Promise<{
  commands: Pick<CommandRegistrationPoint, 'find'>;
  beforeAgent: (state: StateShot) => unknown;
  afterAgent: (state: StateShot) => unknown;
}> {
  const { registry } = await loadPlugins([createPlanModePlugin(options)]);
  const entry = registry.middleware.list()[0]?.value.middleware;
  return { commands: registry.commands, ...boundaryHooks(entry) };
}

/**
 * 薄測試，只斷言「`apply` 真的往那四個註冊點放了東西」，加上兩條**順序**的斷言。
 *
 * 計劃模式**真的有沒有作用**的驗收在組裝點（`apps/harness` 的 `plan-mode.test.ts`）
 * ——那裡看的是模型收到的 prompt 與跑完之後的 state，這裡看的是 registry 的內容。
 */
describe('createPlanModePlugin', () => {
  it('五個註冊點都放了東西', async () => {
    const { registry } = await loadPlugins([createPlanModePlugin()]);

    expect(registry.capabilities.has(PLAN_MODE_CAPABILITY)).toBe(true);
    expect([...registry.tools.effective().keys()]).toContain(EXIT_PLAN_MODE_TOOL_NAME);
    expect(registry.middleware.list().map((entry) => entry.value.middleware.name)).toEqual([
      PLAN_MODE_MIDDLEWARE_NAME,
    ]);
    expect(registry.approvals.listeners()).toHaveLength(1);
    expect(registry.commands.list().map((entry) => entry.name)).toEqual([PLAN_COMMAND_NAME]);
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
 * `/plan` 的三個結果，**三個都要到得了**。
 *
 * `queued` 不在裡面是刻意的（見 `index.ts` 檔頭）：它要「輪還開著」才成立，而命令
 * 永遠跑在兩輪之間。這一組同時證明另外三個不是裝飾——`cancelled` 需要兩次相反的
 * 選擇之間**沒有一輪**，那正是我們唯一到得了它的路。
 */
describe('/plan 的結果', () => {
  /**
   * **中間隔著一輪才有 `committed` 的第二次。** 沒有那一輪的話，`/plan` 之後的
   * `/plan off` 是 `cancelled`——選擇還沒交出去，收回來就好。所以這一條在兩次命令
   * 之間真的跑一次邊界：`beforeAgent` 交出 update，`afterAgent` 收下落地後的 state。
   */
  it('進、跑一輪、退、再退：committed → committed → noop', async () => {
    const { commands, beforeAgent, afterAgent } = await assemble();

    expect(await runPlan(commands, '')).toEqual({
      kind: 'success',
      text: PLAN_ENTERED_MESSAGE,
    });
    expect(beforeAgent({ [PLAN_MODE_STATE_KEY]: false })).toEqual({
      [PLAN_MODE_STATE_KEY]: true,
    });
    afterAgent({ [PLAN_MODE_STATE_KEY]: true });

    expect(await runPlan(commands, ' off')).toEqual({
      kind: 'success',
      text: PLAN_LEFT_MESSAGE,
    });
    expect(await runPlan(commands, ' off')).toEqual({
      kind: 'success',
      text: PLAN_ALREADY_INACTIVE_MESSAGE,
    });
  });

  /**
   * **選擇是落地之後才清的，不是送出的當下。** 照 dsh 的
   * 「Delete only after append succeeds」：`beforeAgent` 交出去而那一輪沒把它寫進
   * state 時，下一次邊界要再交一次，而不是把人的選擇靜靜丟掉。
   */
  it('交出去而沒落地時，下一次邊界再交一次', async () => {
    const { commands, beforeAgent } = await assemble();

    await runPlan(commands, '');
    expect(beforeAgent({ [PLAN_MODE_STATE_KEY]: false })).toEqual({
      [PLAN_MODE_STATE_KEY]: true,
    });
    // state 還是 false——那一輪沒把 update 寫進去。
    expect(beforeAgent({ [PLAN_MODE_STATE_KEY]: false })).toEqual({
      [PLAN_MODE_STATE_KEY]: true,
    });
    // 落地之後才不再重送。
    expect(beforeAgent({ [PLAN_MODE_STATE_KEY]: true })).toBeUndefined();
  });

  /**
   * **`exit_plan_mode` 在輪中途把模式關掉，那一格要知道。** 少了 `afterAgent` 的同步，
   * 下一句 `/plan off` 會回「關了」——而它其實早就關了。措辭說謊比沒有措辭更糟。
   */
  it('輪中途被 exit_plan_mode 關掉之後，/plan off 是 noop', async () => {
    const { commands, beforeAgent, afterAgent } = await assemble({ startActive: true });

    beforeAgent({ [PLAN_MODE_STATE_KEY]: true });
    // 這一輪裡 `exit_plan_mode` 用 `Command` 把它改成了 false。
    afterAgent({ [PLAN_MODE_STATE_KEY]: false });

    expect(await runPlan(commands, 'off')).toEqual({
      kind: 'success',
      text: PLAN_ALREADY_INACTIVE_MESSAGE,
    });
  });

  it('同一個方向按第二次是 noop', async () => {
    const { registry } = await loadPlugins([createPlanModePlugin({ startActive: true })]);

    expect(await runPlan(registry.commands, '')).toEqual({
      kind: 'success',
      text: PLAN_ALREADY_ACTIVE_MESSAGE,
    });
  });

  /**
   * **`cancelled` 的兩個方向。** 中間沒有一輪，所以上一次的選擇還在那一格裡沒交出去；
   * 選回原本的狀態就是把它收回來，而不是「又改了一次」。
   */
  it('中間沒有一輪時，選回原狀態是 cancelled', async () => {
    const off = await loadPlugins([createPlanModePlugin()]);
    await runPlan(off.registry.commands, '');
    expect(await runPlan(off.registry.commands, 'off')).toEqual({
      kind: 'success',
      text: PLAN_ENTER_CANCELLED_MESSAGE,
    });

    const on = await loadPlugins([createPlanModePlugin({ startActive: true })]);
    await runPlan(on.registry.commands, 'off');
    expect(await runPlan(on.registry.commands, '')).toEqual({
      kind: 'success',
      text: PLAN_LEAVE_CANCELLED_MESSAGE,
    });
  });

  /**
   * **不認得的參數回 error，不是「當成進入」。** 安靜吞掉打錯的參數，會讓 `/plan of`
   * 看起來成功了而其實做了相反的事。這條關係也是這個套件配套入口檢的那一條。
   */
  it('收不下的參數回 error，而且沒有改到模式', async () => {
    const { registry } = await loadPlugins([createPlanModePlugin()]);

    expect(await runPlan(registry.commands, ' of')).toEqual({
      kind: 'error',
      text: PLAN_ARGS_ERROR_MESSAGE,
    });
    // 沒改到模式：下一次 `/plan` 仍然是「開了」而不是「已經在裡面」。
    expect(await runPlan(registry.commands, '')).toEqual({
      kind: 'success',
      text: PLAN_ENTERED_MESSAGE,
    });
  });
});

/**
 * **那一格必須是一組裝一格。**
 *
 * 它放在 `apply()` 裡而不是 `createPlanModePlugin()` 的閉包裡，因為 `load.ts` 一次組裝
 * 呼叫一次 `plugin.apply(tracked)`。放錯地方**不會拋任何東西**——兩次組裝共用一格，
 * 症狀只是第二個 agent 的 `/plan` 莫名其妙回「已經在計劃模式裡了」。所以要有人釘著。
 */
describe('模式那一格的作用範圍', () => {
  it('同一個 plugin 物件組兩次，兩邊的模式互不相干', async () => {
    const plugin = createPlanModePlugin();
    const first = await loadPlugins([plugin]);
    const second = await loadPlugins([plugin]);

    expect(await runPlan(first.registry.commands, '')).toEqual({
      kind: 'success',
      text: PLAN_ENTERED_MESSAGE,
    });
    // 串台的話這裡會是 `PLAN_ALREADY_ACTIVE_MESSAGE`。
    expect(await runPlan(second.registry.commands, '')).toEqual({
      kind: 'success',
      text: PLAN_ENTERED_MESSAGE,
    });
  });
});
