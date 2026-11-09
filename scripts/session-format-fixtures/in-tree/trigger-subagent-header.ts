/**
 * 格式 51 以前的夾具觸發：用**那一版自己的**註冊表與 `attachSessionPersistence` 寫一對主會話與子代理會話。子代理的 header 由
 * 那一版的接線寫：有 `parentSession`，沒有 `origin`。那一版的假模型不派子代理，CLI 一輪碰不到，所以由這支補寫。
 *
 * 由 `scripts/session-format-fixtures/generate.ts` 複製進那個 tag 的 `apps/harness/src/` 再跑，**不在今天的樹裡編**。
 * 用法：tsx __session-format-trigger-subagent-header.ts <run 目錄>
 */

import { attachSessionPersistence, SessionRegistry } from '@nexus/core';
import { openJsonlSessionStore } from './jsonl-session-store.js';

const directory = process.argv[2];
if (directory === undefined) throw new Error('要給 run 目錄。');

const sessions = new SessionRegistry('dispatched');
const persistence = attachSessionPersistence(sessions, openJsonlSessionStore({ directory }), {
  cwd: process.cwd(),
});
sessions.root.append('turn/start', { kind: 'message', text: '派個子代理' });
const child = sessions.open({ kind: 'subagent', runId: 'fixture-run' });
child.append('model/start', {});
child.append('model/end', {});
sessions.root.append('turn/end', {});
await persistence.dispose();
console.log(`寫了 ${child.sessionId}。`);
