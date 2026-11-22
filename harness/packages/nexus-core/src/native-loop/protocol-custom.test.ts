/**
 * `ProtocolEmitter.custom` 的命名空間（[#2504](https://github.com/DemianLi/nexus-agent/issues/2504)）：
 * root 寫的 `custom` 是 `[]`，前景子代理寫的帶叫起它的那顆 `task` 呼叫的命名空間，消費端靠它分得出是誰寫的。
 */

import { describe, expect, it } from 'vitest';

import { ProtocolEmitter } from './protocol.js';
import type { NativeProtocolEvent } from './protocol.js';

function collect(): { events: NativeProtocolEvent[]; emitter: ProtocolEmitter } {
  const events: NativeProtocolEvent[] = [];
  return { events, emitter: new ProtocolEmitter((event) => events.push(event)) };
}

const customOf = (events: readonly NativeProtocolEvent[]): NativeProtocolEvent[] =>
  events.filter((event) => event.method === 'custom');

describe('ProtocolEmitter.custom 的命名空間', () => {
  it('不給命名空間：root 的，`[]`', () => {
    const { events, emitter } = collect();
    emitter.custom({ name: 'x', value: 1 });
    expect(customOf(events).map((event) => event.params.namespace)).toEqual([[]]);
  });

  it('給了命名空間：事件帶它，內容的包法不變', () => {
    const { events, emitter } = collect();
    emitter.custom({ name: 'x', value: 1 }, ['tools:abc']);
    emitter.custom('plain', ['tools:abc', 'tools:def']);
    const sent = customOf(events);
    expect(sent.map((event) => event.params.namespace)).toEqual([
      ['tools:abc'],
      ['tools:abc', 'tools:def'],
    ]);
    expect(sent.map((event) => event.params.data)).toEqual([
      { name: 'x', value: 1 },
      { payload: 'plain' },
    ]);
  });

  it('命名空間前綴還沒開過就補 `started`（子層的 `custom` 先到時）', () => {
    const { events, emitter } = collect();
    emitter.custom({ name: 'x' }, ['tools:abc', 'tools:def']);
    expect(
      events.filter((event) => event.method === 'lifecycle').map((event) => event.params.namespace),
    ).toEqual([['tools:abc'], ['tools:abc', 'tools:def']]);
  });
});
