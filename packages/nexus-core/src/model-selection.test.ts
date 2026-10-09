/**
 * **每會話模型選擇的機制**——[#723](https://github.com/DemianLi/nexus-agent/issues/723) 在 core 這一側的規則：
 * 下一步用哪條路由、什麼時候附換模型通知、換模型的 middleware 換什麼。
 * 走完產品路徑之後線上看得到什麼，在 `apps/harness/src/model-selection.test.ts`。
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { describe, expect, it } from 'vitest';

import { fromLoggedMessage } from './logged-message.js';
import { messageSourceOf } from './message-source.js';
import {
  normalizeRoute,
  routeOfModel,
  sameModel,
  sameRoute,
  tagModelRoute,
} from './model-route.js';
import {
  createModelSwapMiddleware,
  createSubagentModelFollowMiddleware,
  ModelSelectionController,
  SUBAGENT_MODEL_FOLLOW_MIDDLEWARE_NAME,
  modelSwitchNoticeText,
  pendingNotice,
  recordedRoute,
  recordedSelection,
} from './model-selection.js';
import { SessionLog } from './session-log.js';
import { effectiveTrigger, windowThreshold } from './summarization.js';

const DEFAULT = { model: 'default-model' };

function controller(instances: Record<string, object> = {}) {
  const made: string[] = [];
  const subject = new ModelSelectionController({
    defaultRoute: DEFAULT,
    instanceFor: (route) => {
      made.push(`${route.model}/${route.effort ?? ''}`);
      return instances[route.model] as BaseChatModel | undefined;
    },
  });
  const log = new SessionLog('selection');
  subject.attach(log);
  return { subject, log, made };
}

const started = (log: SessionLog, route: { model: string; effort?: string }) =>
  log.append('model/start', { route });

describe('路由的正規化', () => {
  it("'default' 與缺席是同一件事，兩邊比起來相等", () => {
    expect(normalizeRoute({ model: 'a', effort: 'default' })).toEqual({ model: 'a' });
    expect(sameRoute({ model: 'a', effort: 'default' }, { model: 'a' })).toBe(true);
    expect(sameRoute({ model: 'a', effort: 'off' }, { model: 'a' })).toBe(false);
  });

  it('換通知只比模型，不比強度', () => {
    expect(sameModel({ model: 'a', effort: 'off' }, { model: 'a' })).toBe(true);
    expect(sameModel({ model: 'a' }, { model: 'b' })).toBe(false);
  });

  it('標籤優先；沒標籤退回實例自己報的名字；再沒有是 undefined', () => {
    const tagged = tagModelRoute({ model: 'reported' }, { model: 'tagged', effort: 'off' });
    expect(routeOfModel(tagged)).toEqual({ model: 'tagged', effort: 'off' });
    expect(routeOfModel({ model: 'reported' })).toEqual({ model: 'reported' });
    expect(routeOfModel({})).toBeUndefined();
    expect(routeOfModel(undefined)).toBeUndefined();
  });
});

describe('下一步用哪條路由', () => {
  it('順序是：使用者選的 → 最近一次請求走的 → 部署預設', () => {
    const { subject, log } = controller();
    expect(subject.next()).toEqual(DEFAULT);

    started(log, { model: 'used' });
    expect(subject.next()).toEqual({ model: 'used' });

    subject.select({ model: 'chosen', effort: 'off' });
    expect(subject.next()).toEqual({ model: 'chosen', effort: 'off' });
  });

  it('選擇不會被「消耗」：之後又有請求走了別顆，選擇仍然是這條會話的選擇', () => {
    const { subject, log } = controller();
    started(log, { model: 'old' });
    subject.select({ model: 'chosen' });
    // 一步開頭快照之後、請求之前才選的，`model/selection` 會落在舊路由的 `model/start` 前面——
    // 所以不能拿「日誌上哪一顆比較新」判斷。
    started(log, { model: 'old' });
    expect(subject.next()).toEqual({ model: 'chosen' });
  });

  it('選擇記進日誌（model/selection），且「default」強度被正規化掉', () => {
    const { subject, log } = controller();
    subject.select({ model: 'chosen', effort: 'default' });
    const [event] = log.events;
    expect(event).toMatchObject({ type: 'model/selection', data: { modelId: 'chosen' } });
    expect(event?.data).not.toHaveProperty('reasoningEffort');
    expect(recordedSelection(log.events)).toEqual({ model: 'chosen' });
  });

  it('還沒接上日誌就選：拋錯，不靜靜吞掉', () => {
    const subject = new ModelSelectionController({
      defaultRoute: DEFAULT,
      instanceFor: () => undefined,
    });
    expect(() => subject.select({ model: 'x' })).toThrow('還沒接上會話日誌');
  });

  it('接上已有選擇的日誌（續接）：現況從日誌讀回來', () => {
    const log = new SessionLog('resumed');
    log.append('model/selection', { modelId: 'chosen', reasoningEffort: 'off' });
    log.append('model/start', { route: { model: 'old' } });
    const subject = new ModelSelectionController({
      defaultRoute: DEFAULT,
      instanceFor: () => undefined,
    });
    subject.attach(log);
    expect(subject.state()).toEqual({
      lastUsed: { model: 'old' },
      selected: { model: 'chosen', effort: 'off' },
    });
    expect(subject.next()).toEqual({ model: 'chosen', effort: 'off' });
  });
});

describe('換模型通知', () => {
  it('第一次請求沒有「最近一次」，不附', () => {
    const { subject, log } = controller();
    subject.select({ model: 'chosen' });
    expect(subject.noticeFor(log)).toEqual([]);
  });

  it('模型變了才附：user 角色、文字逐字照 dsh、來源標非 user，也記進日誌', () => {
    const { subject, log } = controller();
    started(log, { model: 'a' });
    subject.select({ model: 'b' });

    const [notice, ...rest] = subject.noticeFor(log);
    expect(rest).toEqual([]);
    expect(notice?.getType()).toBe('human');
    expect(notice?.content).toEqual([
      {
        type: 'text',
        text: '[model changed: assistant turns above this point were generated by a; the session continues with b]',
      },
    ]);
    expect(modelSwitchNoticeText('a', 'b')).toBe(
      '[model changed: assistant turns above this point were generated by a; the session continues with b]',
    );
    expect(messageSourceOf(notice!)).toEqual({
      kind: 'model-selection',
      form: 'notice',
      from: 'a',
      to: 'b',
    });

    const logged = log.events.filter((event) => event.type === 'user/message');
    expect(logged).toHaveLength(1);
    expect(logged[0]?.data).toMatchObject({
      source: { kind: 'plugin', plugin: 'model-selection' },
    });
    const message = logged[0]?.type === 'user/message' ? logged[0].data.message : undefined;
    expect(messageSourceOf(fromLoggedMessage(message!))).toMatchObject({ to: 'b' });
  });

  it('只換強度不附', () => {
    const { subject, log } = controller();
    started(log, { model: 'a' });
    subject.select({ model: 'a', effort: 'off' });
    expect(subject.noticeFor(log)).toEqual([]);
    expect(log.events.map((event) => event.type)).not.toContain('user/message');
  });

  it('附過、還沒有請求用過它：下一步不再附第二則（通知先進 state，之後的請求都看得到）', () => {
    const { subject, log } = controller();
    started(log, { model: 'a' });
    subject.select({ model: 'b' });
    expect(subject.noticeFor(log)).toHaveLength(1);
    expect(pendingNotice(log.events, 'b')).toBe(true);
    expect(subject.noticeFor(log)).toEqual([]);

    // 請求走了 b 之後，這則通知已被看過；再切回 a 又切到 b 是新的一次。
    started(log, { model: 'b' });
    expect(pendingNotice(log.events, 'b')).toBe(false);
    expect(subject.noticeFor(log)).toEqual([]);
    subject.select({ model: 'a' });
    expect(subject.noticeFor(log)).toHaveLength(1);
  });

  it('沒選過的會話不會附通知', () => {
    const { subject, log } = controller();
    started(log, { model: 'a' });
    expect(subject.noticeFor(log)).toEqual([]);
  });

  it('recordedRoute 取最後一顆有路由的 model/start；舊日誌（沒有 route）是 undefined', () => {
    const log = new SessionLog('old');
    log.append('model/start', {});
    expect(recordedRoute(log.events)).toBeUndefined();
    started(log, { model: 'x', effort: 'default' });
    expect(recordedRoute(log.events)).toEqual({ model: 'x' });
  });
});

describe('換模型的 middleware', () => {
  const hook = (subject: ModelSelectionController) => {
    const found = (createModelSwapMiddleware(subject) as { wrapModelCall?: unknown }).wrapModelCall;
    return found as (
      request: { model: unknown },
      handler: (request: { model: unknown }) => unknown,
    ) => unknown;
  };

  it('沒選過：什麼都不換，handler 收到同一個 request 物件', () => {
    const { subject } = controller();
    const request = { model: { name: 'default-instance' } };
    let seen: unknown;
    hook(subject)(request, (given) => (seen = given));
    expect(seen).toBe(request);
  });

  it('選了別顆：這一步的 request.model 換成那顆的實例', () => {
    const other = { name: 'other-instance' };
    const { subject } = controller({ other });
    subject.select({ model: 'other' });
    const request = { model: { name: 'default-instance' }, extra: 1 };
    let seen: { model: unknown; extra?: number } | undefined;
    hook(subject)(request, (given) => (seen = given as typeof seen));
    expect(seen?.model).toBe(other);
    expect(seen?.extra).toBe(1);
  });

  it('跑著的一步不換：快照在步的開頭，之後才選的從下一步生效', () => {
    const second = { name: 'second' };
    const { subject, log } = controller({ second });
    started(log, { model: 'default-model' });
    subject.noticeFor(log); // 步的開頭（beforeModel）快照
    subject.select({ model: 'second' }); // 步跑到一半才選
    const request = { model: { name: 'default-instance' } };
    let seen: { model: unknown } | undefined;
    hook(subject)(request, (given) => (seen = given as typeof seen));
    expect(seen).toBe(request);

    // 下一步：快照已清掉、現算，換成新選的。
    hook(subject)(request, (given) => (seen = given as typeof seen));
    expect(seen?.model).toBe(second);
  });

  it('快照用過就清掉：beforeModel 被跳過的下一步不會用上一步的舊快照', () => {
    const { subject, log } = controller();
    started(log, { model: 'x' });
    subject.select({ model: 'a' });
    subject.noticeFor(log);
    expect(subject.takeStepRoute()).toEqual({ model: 'a' });
    subject.select({ model: 'b' });
    expect(subject.takeStepRoute()).toEqual({ model: 'b' });
  });
});

describe('子代理跟隨的 middleware（#328 第 3 項）', () => {
  const hook = (
    subject: ModelSelectionController,
    pin: Parameters<typeof createSubagentModelFollowMiddleware>[1],
  ) => {
    const middleware = createSubagentModelFollowMiddleware(subject, pin);
    expect(middleware.name).toBe(SUBAGENT_MODEL_FOLLOW_MIDDLEWARE_NAME);
    return (middleware as { wrapModelCall?: unknown }).wrapModelCall as (
      request: { model: unknown },
      handler: (request: { model: unknown }) => unknown,
    ) => unknown;
  };
  const run = (call: ReturnType<typeof hook>, model: unknown = { name: 'built-in' }) => {
    const request = { model };
    let seen: { model: unknown } | undefined;
    call(request, (given) => (seen = given as typeof seen));
    return { request, seen: seen! };
  };

  it('沒選過、沒釘：什麼都不換，handler 收到同一個 request 物件', () => {
    const { subject } = controller();
    const { request, seen } = run(hook(subject, {}));
    expect(seen).toBe(request);
  });

  it('沒釘：跟父代理此刻的選擇，之後再換也跟——每次叫模型現算，不快照', () => {
    const first = { name: 'first' };
    const second = { name: 'second' };
    const { subject } = controller({ first, second });
    const call = hook(subject, {});
    subject.select({ model: 'first' });
    expect(run(call).seen.model).toBe(first);
    subject.select({ model: 'second' });
    expect(run(call).seen.model).toBe(second);
  });

  it('不碰 root 那一步的快照：子代理叫模型不會消耗 takeStepRoute', () => {
    const other = { name: 'other' };
    const { subject, log } = controller({ other });
    started(log, { model: 'default-model' });
    subject.select({ model: 'other' });
    subject.noticeFor(log); // root 這一步的開頭快照 = other
    run(hook(subject, {}));
    run(hook(subject, {}));
    expect(subject.takeStepRoute()).toEqual({ model: 'other' });
  });

  it('釘了模型：用釘的，不管父代理選了什麼', () => {
    const pinned = { name: 'pinned' };
    const chosen = { name: 'chosen' };
    const { subject, made } = controller({ pinned, chosen });
    subject.select({ model: 'chosen' });
    expect(run(hook(subject, { model: 'pinned' })).seen.model).toBe(pinned);
    expect(made).toContain('pinned/');
    expect(made).not.toContain('chosen/');
  });

  it('釘了模型與強度：路由帶強度；只釘強度：父代理當下的模型換這個強度', () => {
    const { subject, made } = controller({ x: {}, y: {} });
    run(hook(subject, { model: 'x', reasoningEffort: 'off' }));
    expect(made.at(-1)).toBe('x/off');
    subject.select({ model: 'y', effort: 'default' });
    run(hook(subject, { reasoningEffort: 'off' }));
    expect(made.at(-1)).toBe('y/off');
  });

  it('解出來是預設實例（instanceFor 回 undefined）：不換', () => {
    const { subject } = controller({});
    const { request, seen } = run(hook(subject, { model: 'default-model' }));
    expect(seen).toBe(request);
  });
});

describe('摘要門檻逐步夾在當步模型的窗口內', () => {
  const trigger = [{ type: 'tokens', value: 100_000 }] as const;

  it('窗口夠大：原樣回同一個陣列（預設模型與 131k 級的門檻不變）', () => {
    expect(effectiveTrigger(trigger, { contextWindow: 700_000, maxOutputTokens: 32_000 })).toBe(
      trigger,
    );
    expect(effectiveTrigger(trigger, { contextWindow: 131_007, maxOutputTokens: 4_096 })).toBe(
      trigger,
    );
  });

  it('窗口更小：往下夾到 min(窗口×0.8, 窗口−輸出上限)', () => {
    const limits = { contextWindow: 64_000, maxOutputTokens: 16_000 };
    const ceiling = windowThreshold(limits);
    expect(ceiling).toBe(Math.floor(Math.min(64_000 * 0.8, 64_000 - 16_000)));
    expect(effectiveTrigger(trigger, limits)).toEqual([{ type: 'tokens', value: ceiling }]);
  });

  it('messages 門檻不動；不知道窗口就原樣回', () => {
    const mixed = [{ type: 'messages', value: 500 }] as const;
    expect(effectiveTrigger(mixed, { contextWindow: 10_000, maxOutputTokens: 1_000 })).toBe(mixed);
    expect(effectiveTrigger(trigger, undefined)).toBe(trigger);
  });
});
