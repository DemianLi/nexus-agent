/**
 * 格式 53 起的夾具觸發：用**那一版自己的**註冊表與 `attachSessionPersistence` 寫一條嵌入版開的會話。header 帶 `profile: 'embed'`，
 * 一輪開頭那句的 `turn/start`、排著的與插話的佇列項都帶 `context`，插話送進模型的那則人話接著畫面情境的區塊。這些只有
 * `/embed/threads/…` 的 `run.start` 帶得進來，CLI 一輪碰不到，所以由這支補寫。
 *
 * 由 `scripts/session-format-fixtures/generate.ts` 複製進那一版的 `apps/harness/src/` 再跑，**不在今天的樹裡編**。
 * 用法：tsx __session-format-trigger-embed-profile.ts <run 目錄>
 */

import { attachSessionPersistence, pageContextBlock, SessionRegistry } from '@nexus/core';
import { openJsonlSessionStore } from './jsonl-session-store.js';

const directory = process.argv[2];
if (directory === undefined) throw new Error('要給 run 目錄。');

const sessions = new SessionRegistry('embed-profile');
const persistence = attachSessionPersistence(sessions, openJsonlSessionStore({ directory }), {
  cwd: process.cwd(),
  rootProfile: 'embed',
});
const root = sessions.root;
const first = { label: 'PUMP-07' };
const queued = { label: 'PUMP-08' };
const steer = { label: 'PUMP-09' };
/** 每一次模型呼叫都要有回覆：少了它，那一次推不回對話歷史（`reply-missing`）。 */
const reply = (id: string, content: string) => ({
  message: {
    type: 'ai' as const,
    data: {
      content,
      tool_calls: [],
      invalid_tool_calls: [],
      additional_kwargs: {},
      response_metadata: {},
      id,
    },
  },
});

root.append('turn/start', { kind: 'message', text: '它的溫度正常嗎', context: first });
root.append('model/start', {});
// 跑著的時候排進下一輪的那句。
root.append('inbox/spliced', {
  target: 'next-turn',
  start: 0,
  inserted: [{ id: 'run-queued', text: '它排第二', source: { kind: 'user' }, context: queued }],
});
// 插話：排進下一步，下一步領走，送進模型的那則人話接著情境的區塊。
root.append('inbox/spliced', {
  target: 'next-step',
  start: 0,
  inserted: [{ id: 'run-steer', text: '順便看它', source: { kind: 'user' }, context: steer }],
});
root.append('assistant/message', reply('fixture-reply-1', '我看一下 PUMP-07。'));
root.append('model/end', {});
root.append('inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] });
root.append('user/message', {
  message: {
    type: 'human',
    data: {
      content: [{ type: 'text', text: '順便看它' }, pageContextBlock(steer)],
      additional_kwargs: {},
      response_metadata: {},
      id: 'fixture-steer',
    },
  },
  source: { kind: 'user' },
});
root.append('model/start', {});
root.append('assistant/message', reply('fixture-reply-2', 'PUMP-09 也正常。'));
root.append('model/end', {});
root.append('turn/end', {});
// 排著的那句輪到了。
root.append('inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
root.append('turn/start', { kind: 'message', text: '它排第二', context: queued });
root.append('model/start', {});
root.append('assistant/message', reply('fixture-reply-3', 'PUMP-08 正常。'));
root.append('model/end', {});
root.append('turn/end', {});
await persistence.dispose();
console.log(`寫了 ${root.sessionId}。`);
