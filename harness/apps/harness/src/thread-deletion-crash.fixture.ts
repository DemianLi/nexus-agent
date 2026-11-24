/**
 * 刪除會話的當機探針（[#2957](https://github.com/DemianLi/nexus-agent/issues/2957)）：`thread-deletion-crash.test.ts` 用子行程跑它。
 *
 *   node --import tsx src/thread-deletion-crash.fixture.ts
 *
 * 環境變數：
 *
 * - `THREAD_DELETION_MODE`：`delete-after-copy`（同磁碟改名一律丟 `EXDEV`，逼出複製路徑；複製完、刪來源之前寫標記後停住）、
 *   `delete-before-move`（寫入方放手那一步寫標記後停住）、`recover`（啟動恢復，跑完就結束）。
 * - `THREAD_DELETION_HOME` / `THREAD_DELETION_SESSIONS` / `THREAD_DELETION_DELETED` / `THREAD_DELETION_PROJECT` /
 *   `THREAD_DELETION_THREAD`：路徑與對象。
 * - `THREAD_DELETION_MARKER`：標記檔，寫進「到了停住的那一點」。
 *
 * 這些掛鉤只給測試用，是注入進 {@link ThreadDeletions} 的；產品路徑沒有任何設定會打開它們。
 * 停住用一個永不兌現的 promise，等父行程 SIGKILL。
 */

import { appendFileSync } from 'node:fs';

import { ThreadDeletions } from './thread-deletion.js';

const env = process.env;
const mode = env['THREAD_DELETION_MODE'];
const marker = env['THREAD_DELETION_MARKER'];
const home = env['THREAD_DELETION_HOME'];
const sessionsRoot = env['THREAD_DELETION_SESSIONS'];
const deletedRoot = env['THREAD_DELETION_DELETED'];
const project = env['THREAD_DELETION_PROJECT'];
const thread = env['THREAD_DELETION_THREAD'];

if (
  mode === undefined ||
  marker === undefined ||
  home === undefined ||
  sessionsRoot === undefined ||
  deletedRoot === undefined ||
  project === undefined ||
  thread === undefined
) {
  throw new Error('thread-deletion-crash.fixture：缺少環境變數');
}

const exdev = (): Promise<void> =>
  Promise.reject(
    Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' }),
  );

// 永不兌現的 promise 本身不擋事件圈：沒有計時器的話行程會自己正常結束，那就不是「停住」了。
const hang = (): Promise<never> =>
  new Promise<never>(() => {
    setInterval(() => undefined, 1 << 30);
  });

const deletions = new ThreadDeletions({
  home,
  sessionsRoot,
  deletedRoot,
  graceMs: 30 * 86_400_000,
  now: () => Date.now(),
  ...(mode === 'delete-after-copy' && {
    fs: { moveTree: exdev },
    hooks: {
      afterCopy: async () => {
        appendFileSync(marker, 'copied\n');
        await hang();
      },
    },
  }),
  ...(mode === 'delete-before-move' && {
    releaseWriter: async () => {
      appendFileSync(marker, 'released\n');
      await hang();
    },
  }),
});

if (mode === 'recover') {
  await deletions.recover();
  process.exit(0);
} else if (mode === 'delete-after-copy' || mode === 'delete-before-move') {
  await deletions.delete({ threadId: thread, projectKey: project, actor: { kind: 'owner' } });
  process.exit(0);
} else {
  throw new Error(`thread-deletion-crash.fixture：不認得的模式 ${mode}`);
}
