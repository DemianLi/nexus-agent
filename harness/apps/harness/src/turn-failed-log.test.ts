/**
 * `[回合]` 那一行與 JSON 欄位的形狀（[#1536](https://github.com/DemianLi/nexus-agent/issues/1536)）。
 *
 * 重點是「日誌第 N 筆」指的是哪一份日誌：thread 自己的，還是背景子代理自己的（id 是 `<thread>/<runId>`）。
 * 兩者的 `seq` 各自從 0 數，指錯檔就讀到別的事件。
 */
import { describe, expect, it } from 'vitest';

import { turnFailedFields, turnFailedMessage } from './turn-failed-log.js';

describe('turnFailedMessage／turnFailedFields', () => {
  it('thread 自己的日誌：寫「日誌第 N 筆」，沒有 session_id', () => {
    const report = {
      threadId: 't1',
      runId: 'r1',
      seq: 7,
      code: 'SERVER',
      status: 502,
      requestId: 'gw-1',
    };
    expect(turnFailedMessage(report)).toBe(
      '[回合] thread "t1" run "r1" 失敗（日誌第 7 筆）：SERVER status=502 request_id=gw-1',
    );
    expect(turnFailedFields(report)).toEqual({
      thread_id: 't1',
      run_id: 'r1',
      seq: 7,
      code: 'SERVER',
      status: 502,
      provider_request_id: 'gw-1',
    });
  });

  it('背景子代理：點名子代理自己那份日誌的 id，JSON 多一個 session_id', () => {
    const report = {
      threadId: 't1',
      runId: 'bg-1',
      sessionId: 't1/bg-1',
      seq: 3,
      code: 'SERVER',
    };
    expect(turnFailedMessage(report)).toBe(
      '[回合] thread "t1" run "bg-1" 失敗（子代理日誌 "t1/bg-1" 第 3 筆）：SERVER',
    );
    expect(turnFailedFields(report)).toEqual({
      thread_id: 't1',
      run_id: 'bg-1',
      session_id: 't1/bg-1',
      seq: 3,
      code: 'SERVER',
    });
  });
});
