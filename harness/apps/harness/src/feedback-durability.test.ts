/**
 * 評分要等落盤才回 ok（[#1606](https://github.com/DemianLi/nexus-agent/issues/1606)）：驗收 A、B、C 與「沒掛落盤」那一格，量的是樹上那條鏈——
 * 真的 `createCordisRoot`、真的 `loadDefaultPlugins`（帶樹，出廠清單掛著落盤，所以 `session-durability` 那一列在）、真的 JSONL store
 * （`bindDurableStore`，同 serve 與 CLI 的入口）、真的 `attachSessionPersistence`，評分服務從樹上取。
 *
 * **不拿「put 回來時檔案裡已經有那顆」當證據**：背景寫入的窗口只有 10 ms（`DEFAULT_PERSISTENCE_WINDOW_MS`），put 不等落盤也多半看得到。
 * 改用排空者自己記帳（B）、讓排空者拒（A）、讓排空者參與卻不寫（C）——三格各自只有在「put 真的叫了落盤確認、確認真的讀回比對」時才過。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FeedbackDurabilityUnavailableError,
  SessionRegistry,
  attachSessionPersistence,
} from '@nexus/core';
import type { FeedbackService, LoggedMessage, SessionLog, SessionStore } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createCordisRoot } from './cordis-root.js';
import type { CordisRoot } from './cordis-root.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { openJsonlSessionStore } from './jsonl-session-store.js';
import { loadDefaultPlugins } from './plugin-config.js';

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-feedback-durable-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const warnNothing = (): void => {};

/** 一棵掛著出廠清單的樹；`bind` 為 false 時不交 store（入口沒開落盤目錄的形狀）。 */
async function tree(options: { bind?: boolean; patches?: string[] } = {}) {
  const dir = scratch();
  const root: CordisRoot = createCordisRoot();
  cleanups.push(() => root.dispose().catch(() => {}));
  await loadDefaultPlugins(
    {
      env: { [HARNESS_HOME_ENV]: join(dir, 'home') },
      warn: warnNothing,
      ...(options.patches && { patches: options.patches }),
    },
    { tree: root.tree },
  );
  const store = openJsonlSessionStore({ directory: join(dir, 'sessions'), warn: warnNothing });
  if (options.bind !== false) root.tree.bindDurableStore(store);
  const ctx = await root.tree.context();
  const feedback = ctx.get('messageFeedback') as FeedbackService | undefined;
  if (feedback === undefined) throw new Error('樹上沒有評分服務');
  return { root, store, feedback, durability: ctx.get('sessionDurability') };
}

function ai(text: string, id: string): LoggedMessage {
  return { type: 'ai', data: { content: text, id } } as LoggedMessage;
}

/** 一輪問答，回覆的訊息 id 是 `m1`。 */
function seed(log: SessionLog): void {
  log.append('turn/start', { kind: 'message', text: '問。' });
  log.append('assistant/message', { message: ai('答。', 'm1') });
  log.append('turn/end', {});
}

/**
 * 一條活著的 thread：註冊表登記進樹（同 `attachSession`），`persist` 時接上真的落盤（同入口）。
 */
function thread(root: CordisRoot, store: SessionStore, id: string, persist = true) {
  const sessions = new SessionRegistry(id);
  const persistence = persist ? attachSessionPersistence(sessions, store) : undefined;
  const undo = root.tree.threadSessions.register(sessions);
  cleanups.push(async () => {
    undo();
    await persistence?.dispose();
  });
  seed(sessions.root);
  return { sessions, log: sessions.root };
}

const RATE = { messageId: 'm1', rating: 'positive', ifVersion: null } as const;

describe('落盤開著：評分等落盤確認', () => {
  it('put 回 ok，讀回的存檔裡就是那一顆評分事件', async () => {
    const { root, store, feedback } = await tree();
    const { log } = thread(root, store, 't-ok');
    const put = await feedback.put(log, RATE);
    expect(put.ok).toBe(true);
    const events = await (await store.open('t-ok', 'read')).read();
    expect(events.at(-1)).toEqual(log.events.at(-1));
    expect(events.at(-1)?.type).toBe('feedback/message-put');
  });

  it('A：排空者拒（磁碟寫不進去）→ put 拋原錯，不回 ok', async () => {
    const { root, store, feedback } = await tree();
    const { sessions, log } = thread(root, store, 't-refuse');
    sessions.onFlush(() => Promise.reject(new Error('磁碟滿了')));
    await expect(feedback.put(log, RATE)).rejects.toThrow('磁碟滿了');
  });

  it('A：delete 也一樣等落盤', async () => {
    const { root, store, feedback } = await tree();
    const { sessions, log } = thread(root, store, 't-refuse-delete');
    const put = await feedback.put(log, RATE);
    if (!put.ok) throw new Error('評不上');
    sessions.onFlush(() => Promise.reject(new Error('磁碟滿了')));
    await expect(
      feedback.delete(log, { messageId: 'm1', ifVersion: put.value.version }),
    ).rejects.toThrow('磁碟滿了');
  });

  it('B：內容一樣的 put 也排空一次（照 dsh `:183`），每次 put／delete 各一次', async () => {
    const { root, store, feedback } = await tree();
    const { sessions, log } = thread(root, store, 't-count');
    const flushed: SessionLog[] = [];
    sessions.onFlush((flushedLog) => {
      flushed.push(flushedLog);
      return Promise.resolve();
    });
    const first = await feedback.put(log, RATE);
    if (!first.ok) throw new Error('評不上');
    const same = await feedback.put(log, { ...RATE, ifVersion: first.value.version });
    expect(same.ok).toBe(true);
    if (!same.ok) return;
    expect(flushed).toEqual([log, log]);
    expect(
      (await feedback.delete(log, { messageId: 'm1', ifVersion: same.value.version })).ok,
    ).toBe(true);
    expect(flushed).toEqual([log, log, log]);
  });

  it('C：排空者參與了、這一份卻不歸它寫（存檔少最後一顆）→ 讀回比對拒', async () => {
    const { root, store, feedback } = await tree();
    // 先有一份真的存檔（前三顆），再換一份**同 id、沒接落盤**的註冊表登記上去：它有排空者（什麼都不寫），所以「有人參與」那一關過得去，
    // 擋下它的只能是讀回比對。
    const earlier = new SessionRegistry('t-orphan');
    const persistence = attachSessionPersistence(earlier, store);
    seed(earlier.root);
    await persistence.flush();
    await persistence.dispose();
    const { sessions, log } = thread(root, store, 't-orphan', false);
    sessions.onFlush(() => Promise.resolve());
    await expect(feedback.put(log, RATE)).rejects.toThrow(
      `讀回的第 ${String(log.events.length - 1)} 顆對不上，不是耐久的`,
    );
  });

  it('不是這棵樹上登記的 thread root：拒（排空別條的註冊表證明不了這一份）', async () => {
    const { root, store, feedback } = await tree();
    const { sessions } = thread(root, store, 't-child');
    const stray = new SessionRegistry('t-stray').root;
    seed(stray);
    await expect(feedback.put(stray, RATE)).rejects.toThrow(
      '不是這個行程裡一條活著的 thread 的 root',
    );
    // 同一個 id、不是同一份日誌（例如子代理那幾份）也拒。
    const twin = new SessionRegistry('t-child').root;
    seed(twin);
    expect(twin).not.toBe(sessions.root);
    await expect(feedback.put(twin, RATE)).rejects.toThrow(
      '不是這個行程裡一條活著的 thread 的 root',
    );
  });

  it('入口沒交 store：拒，不是靜靜放行', async () => {
    const { root, store, feedback } = await tree({ bind: false });
    const { log } = thread(root, store, 't-nostore');
    await expect(feedback.put(log, RATE)).rejects.toThrow('沒有落盤的 store，不是耐久的');
  });
});

describe('清單把落盤關掉', () => {
  it('樹上沒有 session-durability；評分三個方法拋「存不住」，評語照常', async () => {
    const off = new URL('./settings/persistence-off.patch.yml', import.meta.url).pathname;
    const { root, store, feedback, durability } = await tree({ patches: [off] });
    expect(durability).toBeUndefined();
    const { log } = thread(root, store, 't-off', false);
    await expect(feedback.put(log, RATE)).rejects.toThrow(FeedbackDurabilityUnavailableError);
    await expect(feedback.list(log)).rejects.toThrow('這個組裝沒有掛落盤，評分存不住');
    await expect(feedback.delete(log, { messageId: 'm1', ifVersion: 'v' })).rejects.toThrow(
      FeedbackDurabilityUnavailableError,
    );
    expect((await feedback.record(log, { text: '還行' })).ok).toBe(true);
  });
});
