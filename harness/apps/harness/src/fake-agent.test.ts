import { describe, expect, it } from 'vitest';

import { fakeBackgroundAgent, fakePumpAgent } from './fake-agent.fixture.js';

describe('假 agent 工廠', () => {
  it('沒給的必要成員一被呼叫就拋錯，訊息寫出是哪個成員', () => {
    const agent = fakePumpAgent({});
    expect(() => agent.getState({ configurable: { thread_id: 't' } })).toThrow(/getState/);
    expect(() => (agent.streamEvents as () => unknown)()).toThrow(/streamEvents/);
    expect(() => (fakeBackgroundAgent().streamEvents as () => unknown)()).toThrow(/streamEvents/);
  });

  it('給的成員照常運作', async () => {
    const agent = fakePumpAgent({ getState: async () => ({ values: { ok: 1 } }) });
    await expect(agent.getState({ configurable: { thread_id: 't' } })).resolves.toEqual({
      values: { ok: 1 },
    });
  });

  it('選填成員沒給就不存在，產品碼靠它認 agent 是哪一種 loop', () => {
    const agent = fakePumpAgent({});
    expect(agent.updateState).toBeUndefined();
    expect(agent.appendLoggedMessages).toBeUndefined();
    expect(agent.discardSuspended).toBeUndefined();
    expect('updateState' in agent).toBe(false);
    expect(fakeBackgroundAgent().seedThread).toBeUndefined();
  });
});
