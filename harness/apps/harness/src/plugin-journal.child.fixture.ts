/**
 * `plugin-journal.test.ts` 的子行程：對同一份紀錄檔追加 N 筆，id 以 `<tag>-<i>` 命名。
 *
 * 用法：`node --import tsx plugin-journal.child.fixture.ts <path> <tag> <count>`
 */

import { appendJournalRecord } from './plugin-journal.js';

const [path, tag, count] = process.argv.slice(2);
if (path === undefined || tag === undefined || count === undefined) {
  throw new Error('用法：<path> <tag> <count>');
}

for (let index = 0; index < Number(count); index += 1) {
  await appendJournalRecord(
    path,
    { actor: { kind: 'host-account', effective: tag, invoker: null, invokerSource: null } },
    () => ({
      op: 'config-set',
      id: `${tag}-${String(index)}`,
      name: 'm',
      before: null,
      after: { index },
    }),
  );
}
