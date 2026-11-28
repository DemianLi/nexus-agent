import { describe, expect, it } from 'vitest';

import { fakeBackgroundAgent, fakePumpAgent } from './fake-agent.fixture.js';

describe('假 agent 工廠', () => {
  it('沒給的必要成員一被呼叫就拋錯，訊息寫出是哪個成員', () => {
    const agent = fakePumpAgent({});
    expect(() => agent.getState({ configurable: { thread_id: 't' } })).toThrow(
      '假 agent 沒給成員 getState，卻被呼叫了',
    );
    expect(() => (agent.streamEvents as () => unknown)()).toThrow(
      '假 agent 沒給成員 streamEvents，卻被呼叫了',
    );
    expect(() => (fakeBackgroundAgent().streamEvents as () => unknown)()).toThrow(
      '假 agent 沒給成員 streamEvents，卻被呼叫了',
    );
  });

  it('給的成員照常運作', async () => {
    const agent = fakePumpAgent({ getState: async () => ({ values: { ok: 1 } }) });
    await expect(agent.getState({ configurable: { thread_id: 't' } })).resolves.toEqual({
      values: { ok: 1 },
    });
  });

  it('收回、接上日誌的訊息、懸著的呼叫三個成員有預設：什麼都不做', async () => {
    const agent = fakePumpAgent({});
    const config = { configurable: { thread_id: 't' } };
    expect(agent.discardSuspended(config)).toBeUndefined();
    await expect(agent.appendLoggedMessages(config, [])).resolves.toBeUndefined();
    await expect(agent.danglingCalls(config, [])).resolves.toEqual([]);
    expect(() => (agent.seedThread as () => unknown)()).toThrow(
      '假 agent 沒給成員 seedThread，卻被呼叫了',
    );
    expect(
      fakeBackgroundAgent().discardSuspended({ configurable: { thread_id: 't' } }),
    ).toBeUndefined();
  });
});
