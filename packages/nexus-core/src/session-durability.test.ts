import { describe, expect, it } from 'vitest';

import { checkpointSession } from './session-durability.js';
import type { SessionEvent } from './session-log.js';
import { SessionRegistry } from './session-registry.js';
import type { ReadonlyStoredSession, StoredSessionHeader } from './session-store.js';

/** 一個只認一份存檔的唯讀 store：`events` 是叫 `read()` 當下讀到的那一份。 */
function storeOf(header: Partial<StoredSessionHeader>, events: () => readonly SessionEvent[]) {
  const opened: string[] = [];
  return {
    opened,
    open(id: string): Promise<ReadonlyStoredSession> {
      opened.push(id);
      return Promise.resolve({
        header: { version: 50, id, createdAt: 0, ...header },
        read: () => Promise.resolve(events()),
      });
    },
  };
}

describe('checkpointSession（#1606）', () => {
  it('排空、讀回、比對都過就放行', async () => {
    const sessions = new SessionRegistry('t1');
    sessions.onFlush(() => Promise.resolve());
    sessions.root.append('turn/start', { kind: 'message', text: '嗨' });
    const store = storeOf({}, () => sessions.root.events);
    await checkpointSession(sessions, store, sessions.root);
    expect(store.opened).toEqual(['t1']);
  });

  it('沒有任何排空者參與：拒，訊息寫明不是耐久的，也不去讀存檔（dsh `:240-244`）', async () => {
    const sessions = new SessionRegistry('t1');
    const store = storeOf({}, () => sessions.root.events);
    await expect(checkpointSession(sessions, store, sessions.root)).rejects.toThrow(
      '沒有任何落盤的排空者參與，不是耐久的',
    );
    expect(store.opened).toEqual([]);
  });

  it('排空者參與了、存檔裡卻沒有那一顆（不歸它寫）：讀回比對拒（dsh `:245`）', async () => {
    const sessions = new SessionRegistry('t1');
    sessions.onFlush(() => Promise.resolve());
    sessions.root.append('turn/start', { kind: 'message', text: '嗨' });
    await expect(
      checkpointSession(
        sessions,
        storeOf({}, () => []),
        sessions.root,
      ),
    ).rejects.toThrow('讀回的第 0 顆對不上，不是耐久的');
  });

  it('讀回的 header 是別的會話：拒', async () => {
    const sessions = new SessionRegistry('t1');
    sessions.onFlush(() => Promise.resolve());
    const store = {
      open: () =>
        Promise.resolve({
          header: { version: 50, id: 'other', createdAt: 0 },
          read: () => Promise.resolve([]),
        }),
    };
    await expect(checkpointSession(sessions, store, sessions.root)).rejects.toThrow(
      '讀回的存檔是 "other"',
    );
  });

  it('存檔打不開：拒，原因接在 cause 上', async () => {
    const sessions = new SessionRegistry('t1');
    sessions.onFlush(() => Promise.resolve());
    const missing = new Error('找不到');
    const store = { open: () => Promise.reject(missing) };
    const failure = await checkpointSession(sessions, store, sessions.root).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('在存檔裡打不開，不是耐久的');
    expect((failure as Error).cause).toBe(missing);
  });

  it('排空本身失敗：原樣往外拋', async () => {
    const sessions = new SessionRegistry('t1');
    sessions.onFlush(() => Promise.reject(new Error('磁碟滿了')));
    await expect(
      checkpointSession(
        sessions,
        storeOf({}, () => []),
        sessions.root,
      ),
    ).rejects.toThrow('磁碟滿了');
  });

  it('比的是叫的那一刻的最後一顆（按 seq 取），不是讀回時的檔尾（dsh `:239`、`:248`）', async () => {
    const sessions = new SessionRegistry('t1');
    const log = sessions.root;
    log.append('feedback/record', { text: '慢' });
    // 排空的當下模型又寫了一顆：存檔的尾巴已經不是評分那一顆，但評分那一顆在它的 seq 上。
    sessions.onFlush(() => {
      log.append('turn/start', { kind: 'message', text: '下一輪' });
      return Promise.resolve();
    });
    await checkpointSession(
      sessions,
      storeOf({}, () => log.events),
      log,
    );
    expect(log.events).toHaveLength(2);
  });
});
