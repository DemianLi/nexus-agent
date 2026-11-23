/**
 * 格式 54 的夾具觸發（[#2416](https://github.com/DemianLi/nexus-agent/issues/2416)）：用**那一版自己的** `SessionLog`、JSONL 後端與
 * 協調器，寫一條串流中途失敗、整次重打成功的會話 `retry-attempt`，讓今天讀盤的 `assistant/attempt` 位置規則（55 起）有 54 留下的
 * 嘗試可讀。CLI 的假模型不會中途失敗，碰不到這條路。
 *
 * 順序照同一版 `stream-retry.test.ts` 釘的（`:393-410`、`:485-489`）：失敗那次的 `model/end {outcome: 'error'}`、`llm/retry`、
 * 帶 `modelCall` 指回失敗那次的 `assistant/attempt`（`ignorable`，同那一版的 `thread-pump.ts`），再來第二次呼叫的起訖與回覆。
 * `llm/retry-started` 與 `context/measure` 不寫：今天的讀方不看它們決定歸屬。
 *
 * 由 `scripts/session-format-fixtures/generate.ts` 複製進那個 rev 的 `apps/harness/src/` 再跑，**不在今天的樹裡編**。
 * 用法：tsx __session-format-trigger-retry-attempt.ts <run 目錄>
 */

import { AIMessage } from '@langchain/core/messages';
import {
  SESSION_LOG_FORMAT_VERSION,
  SessionLog,
  SessionPersistenceCoordinator,
  toLoggedMessage,
} from '@nexus/core';
import { openJsonlSessionStore } from './jsonl-session-store.js';

const directory = process.argv[2];
if (directory === undefined) throw new Error('要給 run 目錄。');
const id = 'retry-attempt';
const log = new SessionLog(id);
const coordinator = new SessionPersistenceCoordinator({
  log,
  stored: openJsonlSessionStore({ directory }).create({
    version: SESSION_LOG_FORMAT_VERSION,
    id,
    createdAt: Date.now(),
    cwd: process.cwd(),
  }),
});
log.append('turn/start', { kind: 'message', text: '你好' });
const first = log.append('model/start', {}).seq as number;
log.append('model/end', { outcome: 'error', modelCall: first });
log.append('llm/retry', {
  retryId: 'fixture-retry',
  retry: 1,
  maxRetries: 2,
  failure: { message: '夾具：串流中途斷線', code: 'SERVER' },
  delayMs: 200,
  modelCall: first,
});
log.append(
  'assistant/attempt',
  { message: toLoggedMessage(new AIMessage({ content: '甲乙' })), modelCall: first },
  { ignorable: true },
);
const second = log.append('model/start', {}).seq as number;
log.append('assistant/message', {
  message: toLoggedMessage(new AIMessage({ content: '丙丁' })),
  modelCall: second,
});
log.append('model/end', { modelCall: second });
log.append('turn/end', {});
await coordinator.dispose();
console.log('寫了 retry-attempt。');
