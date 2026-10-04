/**
 * 子代理目錄的讀法（#1023）：從一顆 `subagent/catalog` 往回找派它的那顆 `tool/call` 與那一輪。
 */

import { describe, expect, it } from 'vitest';

import { SessionLog } from './session-log.js';
import { appendSubagentCatalog, subagentLinkOf, subagentLinks } from './subagent-catalog.js';

function call(log: SessionLog, callId: string): void {
  log.append('tool/call', { callId, name: 'task', arguments: '{}' });
}

describe('subagentLinks', () => {
  it('解出那顆呼叫與那一輪起頭的 turn/start；兩輪各派一個時各指各的', () => {
    const log = new SessionLog('root');
    log.append('turn/start', { kind: 'message', text: '一' });
    call(log, 'a');
    appendSubagentCatalog(log, { childId: 'root/x', callId: 'a', mode: 'one-shot' });
    log.append('turn/end', {});
    log.append('turn/start', { kind: 'message', text: '二' });
    call(log, 'b');
    appendSubagentCatalog(log, { childId: 'root/y', callId: 'b', mode: 'continuable' });

    expect(subagentLinks(log.events)).toEqual([
      { childId: 'root/x', callId: 'a', mode: 'one-shot', catalogSeq: 2, callSeq: 1, turnSeq: 0 },
      {
        childId: 'root/y',
        callId: 'b',
        mode: 'continuable',
        catalogSeq: 6,
        callSeq: 5,
        turnSeq: 4,
      },
    ]);
    expect(subagentLinkOf(log.events, 'root/y')?.callSeq).toBe(5);
    expect(subagentLinkOf(log.events, 'root/z')).toBeUndefined();
  });

  it('同一步派兩個：各自配到自己 callId 的那顆呼叫，不靠先後', () => {
    const log = new SessionLog('root');
    log.append('turn/start', { kind: 'message', text: '一' });
    call(log, 'a');
    call(log, 'b');
    appendSubagentCatalog(log, { childId: 'root/y', callId: 'b', mode: 'one-shot' });
    appendSubagentCatalog(log, { childId: 'root/x', callId: 'a', mode: 'one-shot' });
    expect(subagentLinks(log.events).map((link) => [link.childId, link.callSeq])).toEqual([
      ['root/y', 2],
      ['root/x', 1],
    ]);
  });

  it('同一個 callId 記過兩顆（核准中斷後 resume）：配到最近的那一顆，不是檔頭那顆', () => {
    const log = new SessionLog('root');
    log.append('turn/start', { kind: 'message', text: '一' });
    call(log, 'a');
    log.append('turn/start', { kind: 'resume' });
    call(log, 'a');
    appendSubagentCatalog(log, { childId: 'root/x', callId: 'a', mode: 'one-shot' });
    expect(subagentLinkOf(log.events, 'root/x')).toMatchObject({ callSeq: 3, turnSeq: 2 });
  });

  it('沒有目錄（舊日誌、沒派過）就是空的；往回找不到的那一格就不給', () => {
    const old = new SessionLog('root');
    old.append('turn/start', { kind: 'message', text: '一' });
    call(old, 'a');
    expect(subagentLinks(old.events)).toEqual([]);

    // 日誌前段不在（只剩目錄那一顆）：callSeq 與 turnSeq 都沒有，不猜。
    const torn = new SessionLog('root');
    appendSubagentCatalog(torn, { childId: 'root/x', callId: 'a', mode: 'one-shot' });
    expect(subagentLinks(torn.events)).toEqual([
      { childId: 'root/x', callId: 'a', mode: 'one-shot', catalogSeq: 0 },
    ]);
  });
});

describe('appendSubagentCatalog', () => {
  it('寫不進去（日誌正在發佈）不拋，回 false', () => {
    const log = new SessionLog('root');
    const results: boolean[] = [];
    log.subscribe((event) => {
      if (event.type === 'turn/start') {
        results.push(
          appendSubagentCatalog(log, { childId: 'root/x', callId: 'a', mode: 'one-shot' }),
        );
      }
    });
    log.append('turn/start', { kind: 'message', text: '一' });
    expect(results).toEqual([false]);
    expect(log.events.map((event) => event.type)).toEqual(['turn/start']);
  });
});
