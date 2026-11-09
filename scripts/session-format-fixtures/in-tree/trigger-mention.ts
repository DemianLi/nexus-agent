/**
 * 格式 56 的夾具觸發：用**那一版（55）自己的**註冊表與 `attachSessionPersistence` 寫一條點名子代理的會話。開頭那句的 `turn/start`、
 * 排著的佇列項帶 `mention`（55 沒有 `tool` 這一格），插話送進模型的那則人話由那一版自己的 `userContent` 接上提示區塊。點名只有
 * `run.start` 帶得進來，CLI 一輪碰不到，所以由這支補寫。
 *
 * 寫完之後用**那一版自己的** `replayConversation` 推回每一則人話的內容，寫進 run 目錄的 `mention.own-human.json`：那就是 55 送給
 * 模型的位元組，今天的讀方重放出來要跟它相同。
 *
 * 由 `scripts/session-format-fixtures/generate.ts` 複製進那一版的 `apps/harness/src/` 再跑，**不在今天的樹裡編**。
 * 用法：tsx __session-format-trigger-mention.ts <run 目錄>
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  attachSessionPersistence,
  replayConversation,
  SessionRegistry,
  userContent,
} from '@nexus/core';
import { openJsonlSessionStore } from './jsonl-session-store.js';

const directory = process.argv[2];
if (directory === undefined) throw new Error('要給 run 目錄。');

const sessions = new SessionRegistry('mention');
const persistence = attachSessionPersistence(sessions, openJsonlSessionStore({ directory }), {
  cwd: process.cwd(),
});
const root = sessions.root;
const first = { kind: 'subagent' as const, name: 'general-purpose' };
const steer = { kind: 'subagent' as const, name: 'reviewer' };
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

root.append('turn/start', { kind: 'message', text: '幫我登記阿明', mention: first });
root.append('model/start', {});
root.append('inbox/spliced', {
  target: 'next-step',
  start: 0,
  inserted: [{ id: 'run-steer', text: '順便看一下', source: { kind: 'user' }, mention: steer }],
});
root.append('assistant/message', reply('fixture-reply-1', '我派給 general-purpose。'));
root.append('model/end', {});
root.append('inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] });
root.append('user/message', {
  message: {
    type: 'human',
    data: {
      content: userContent('順便看一下', [], steer) as never,
      additional_kwargs: {},
      response_metadata: {},
      id: 'fixture-steer',
    },
  },
  source: { kind: 'user' },
});
root.append('model/start', {});
root.append('assistant/message', reply('fixture-reply-2', '也派給 reviewer 了。'));
root.append('model/end', {});
root.append('turn/end', {});

const replay = replayConversation(root.events);
if (replay.kind !== 'replayed') throw new Error(`推不回對話歷史：${replay.reason}`);
writeFileSync(
  join(directory, 'mention.own-human.json'),
  JSON.stringify(
    replay.messages
      .filter((message) => message.getType() === 'human')
      .map((message) => JSON.stringify(message.content)),
  ),
);
await persistence.dispose();
