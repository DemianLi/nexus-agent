/**
 * 用**寫這份夾具的那一版自己的**讀方，把每一條會話推回模型的對話歷史，印出則數與角色序列（JSON）。格式 9 起才有
 * `replayConversation`，所以只在 9 以後的 tag 跑；更舊的那幾版沒有對話內容，`expected.json` 照實寫不適用。
 *
 * 事件直接從日誌逐行 `JSON.parse`，不經任何一版的 store：要比的是「那一版的推法」，不是「那一版的讀檔」。
 *
 * 由 `scripts/session-format-fixtures/generate.ts` 複製進那個 rev 的 `apps/harness/src/` 再跑，**不在今天的樹裡編**。
 * 用法：tsx __session-format-expect-own.ts <夾具目錄> <會話 id>...
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { replayConversation } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';

const [directory, ...ids] = process.argv.slice(2);
if (directory === undefined || ids.length === 0) throw new Error('要給夾具目錄與會話 id。');

const out: Record<string, unknown> = {};
for (const id of ids) {
  const body = await readFile(join(directory, `${id}.jsonl`), 'utf8');
  const events = body
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
  const replay = replayConversation(events);
  out[id] =
    replay.kind === 'replayed'
      ? { kind: 'replayed', roles: replay.messages.map((message) => message.getType()) }
      : { kind: 'unreplayable', reason: replay.reason };
}
console.log(JSON.stringify(out));
