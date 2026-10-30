/**
 * 軌跡的歸屬表（`@nexus/plugin-trajectory`）在產品的每條折疊路上值都一樣：
 * 歷史路由的最新一頁（`historyPage`）、子代理的值（`childProjectionData`）與即時逐顆推送（`createProjectionFold`）。
 * 日誌過了 2000 筆上限，尾巴兩顆遲到事件一顆還認得、一顆已被擠掉，表多留或少留一筆都會在這裡現形。
 */

import { createProjectionFold, SessionLog, toLoggedMessage } from '@nexus/core';
import type { ProjectionUnit, SessionEvent } from '@nexus/core';
import { trajectoryUnit } from '@nexus/plugin-trajectory';
import { AIMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import { historyPage } from './conversation-history.js';
import { childProjectionData } from './projection-children.js';

const units: readonly ProjectionUnit[] = [trajectoryUnit as unknown as ProjectionUnit];

function bigLog(): readonly SessionEvent[] {
  const log = new SessionLog('owners-paths');
  log.append('turn/start', { kind: 'message', text: 'x' });
  for (let n = 0; n < 2500; n += 1) {
    const start = log.append('model/start', {});
    log.append('assistant/message', {
      modelCall: start.seq,
      message: toLoggedMessage(
        new AIMessage({
          content: '',
          tool_calls: [{ id: `id_${n}`, name: 'read_file', args: {}, type: 'tool_call' }],
        }),
      ),
    });
  }
  for (const callId of ['id_0', 'id_2499', 'id_500', 'id_499']) {
    log.append('tool/call', { callId, name: 'read_file', arguments: '{}' });
  }
  return log.events;
}

function pushed(events: readonly SessionEvent[]): unknown {
  const live = createProjectionFold(units).session();
  for (const event of events) live.push(event);
  return live.current()[0]!.view;
}

describe('歸屬表走每條折疊路都同值', () => {
  const events = bigLog();
  const expected = pushed(events);

  // id_500 認得，但它那次呼叫已被單輪的呼叫上限摺掉，所以看的是它沒落到 looseTools。
  it('對照組確實分得出認得與擠掉：id_500 沒落到 looseTools、id_499 有', () => {
    const { turns } = expected as {
      turns: { calls: { tools: { callId: string }[] }[]; looseTools: { callId: string }[] }[];
    };
    const turn = turns.at(-1)!;
    const called = turn.calls.flatMap((call) => call.tools.map((tool) => tool.callId));
    const loose = turn.looseTools.map((tool) => tool.callId);
    expect(called).toContain('id_2499');
    expect(loose).toEqual(['id_0', 'id_499']);
  });

  it('歷史路由的最新一頁', () => {
    const page = historyPage(events, {}, undefined, undefined, undefined, undefined, units);
    const frame = page.events.find(
      (event) =>
        event.method === 'custom' &&
        (event.params.data as { name?: string } | null)?.name === 'projection',
    );
    const data = frame?.params.data as { payload: { view: unknown } };
    expect(data.payload.view).toEqual(expected);
  });

  it('子代理的值', () => {
    const [frame] = childProjectionData(units, new Map([['run-1', events]]));
    expect((frame!.payload as { session: string; view: unknown }).view).toEqual(expected);
    expect((frame!.payload as { session: string }).session).toBe('run-1');
  });
});
