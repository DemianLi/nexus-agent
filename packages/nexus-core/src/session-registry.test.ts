/**
 * 會話註冊表：**它就是「三個消費者不用有人記得重接」那件事本身**。
 *
 * 所以這一檔驗的重點不是 Map 的行為，是三件會讓消費者漏掉一份會話的事：訂閱當下有沒有
 * 補歷史、新開的那份有沒有**在 `open()` 回傳前**就通知出去、退訂之後會不會還在收。
 */

import { describe, expect, it } from 'vitest';
import { SessionRegistry } from './session-registry.js';
import type { SessionEntry } from './session-registry.js';
import type { SessionAddress } from './session-address.js';

const WORKER: SessionAddress = { kind: 'subagent', runId: 'tools:worker-1' };
const OTHER: SessionAddress = { kind: 'subagent', runId: 'tools:worker-2' };

/** 只收身分，斷言讀起來短一點。 */
function kindsOf(seen: readonly SessionEntry[]): string[] {
  return seen.map((entry) =>
    entry.address.kind === 'root' ? 'root' : `subagent:${entry.address.runId}`,
  );
}

describe('SessionRegistry', () => {
  it('建構完就有 root——「一份會話都沒有」不是一個表達得出來的狀態', () => {
    const sessions = new SessionRegistry('thread-1');
    expect(sessions.list()).toHaveLength(1);
    expect(sessions.root.sessionId).toBe('thread-1');
  });

  it('同一個身分開兩次是同一份', () => {
    const sessions = new SessionRegistry('thread-1');
    expect(sessions.open(WORKER)).toBe(sessions.open(WORKER));
    expect(sessions.list()).toHaveLength(2);
  });

  it('subagent 的 id 掛在 root 底下——血緣讀得出來', () => {
    const sessions = new SessionRegistry('thread-1');
    expect(sessions.open(WORKER).sessionId).toBe('thread-1/tools:worker-1');
  });

  it('`get` 不會順手開一份', () => {
    const sessions = new SessionRegistry('thread-1');
    expect(sessions.get(WORKER)).toBeUndefined();
    expect(sessions.list()).toHaveLength(1);
  });

  it('訂閱當下先補歷史，再收後續，而且不重送', () => {
    const sessions = new SessionRegistry('thread-1');
    sessions.open(WORKER);
    const seen: SessionEntry[] = [];
    sessions.observe((entry) => seen.push(entry));
    expect(kindsOf(seen)).toEqual(['root', 'subagent:tools:worker-1']);
    sessions.open(OTHER);
    expect(kindsOf(seen)).toEqual(['root', 'subagent:tools:worker-1', 'subagent:tools:worker-2']);
  });

  /**
   * **這一條是三個消費者能不能信任這張表的關鍵。**
   *
   * 呼叫 `open()` 的人（模型工具）拿到日誌的下一件事就是往裡面寫。通知要是排到下一個
   * tick，那一筆會落在每一位訂閱者掛上之前——不變量檢查漏掉它、遙測漏掉它、參與者的折疊
   * 從第二筆才開始。**三種都是靜默的。**
   */
  it('新開的那份在 `open()` 回傳之前就通知出去了', () => {
    const sessions = new SessionRegistry('thread-1');
    const seen: SessionEntry[] = [];
    sessions.observe((entry) => seen.push(entry));
    seen.length = 0;
    const log = sessions.open(WORKER);
    // 同步：這一行在 `open()` 回來之後、任何 await 之前。
    expect(seen).toHaveLength(1);
    expect(seen[0]?.log).toBe(log);
  });

  it('退訂之後不再收，而且退訂是冪等的', () => {
    const sessions = new SessionRegistry('thread-1');
    const seen: SessionEntry[] = [];
    const stop = sessions.observe((entry) => seen.push(entry));
    seen.length = 0;
    stop();
    stop();
    sessions.open(WORKER);
    expect(seen).toEqual([]);
  });

  it('兩位訂閱者都收得到，順序照掛上去的順序', () => {
    const sessions = new SessionRegistry('thread-1');
    const order: string[] = [];
    sessions.observe(() => order.push('first'));
    sessions.observe(() => order.push('second'));
    order.length = 0;
    sessions.open(WORKER);
    expect(order).toEqual(['first', 'second']);
  });

  /**
   * **訂閱者拋錯不吞。**
   *
   * 它跑在 `open()` 的呼叫堆疊上，而那多半是某顆工具的第一次寫入。吞掉的話，「這份會話
   * 沒有被任何人接上」會變成一個沒有徵兆的狀態——正是這張表要消滅的東西。接住它是各
   * 消費者自己的事（三個 runner 都各自圍堵參與者）。
   */
  it('訂閱者拋錯往外拋，不變成一行 warn', () => {
    const sessions = new SessionRegistry('thread-1');
    // 掃歷史那一趟先放行，要驗的是**後來開的那一份**。
    let armed = false;
    sessions.observe(() => {
      if (armed) throw new Error('接不上');
    });
    armed = true;
    expect(() => sessions.open(WORKER)).toThrow(/接不上/u);
  });
});

describe('耐久檢查點的入口（#599）', () => {
  it('一位排空者都沒有：立刻 resolve，回 false', async () => {
    const sessions = new SessionRegistry('root-1');
    expect(await sessions.flush(sessions.root)).toBe(false);
  });

  it('每一位排空者都被問到同一份，全部排完才 resolve', async () => {
    const sessions = new SessionRegistry('root-1');
    const worker = sessions.open(WORKER);
    const asked: string[] = [];
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    sessions.onFlush(async (log) => {
      asked.push(`a:${log.sessionId}`);
      await slow;
    });
    sessions.onFlush((log) => {
      asked.push(`b:${log.sessionId}`);
      return Promise.resolve();
    });
    let settled = false;
    const pending = sessions.flush(worker).then((participated) => {
      settled = true;
      return participated;
    });
    await Promise.resolve();
    expect(asked).toEqual(['a:root-1/tools:worker-1', 'b:root-1/tools:worker-1']);
    expect(settled).toBe(false);
    release();
    expect(await pending).toBe(true);
  });

  it('排空者拒絕就往外拋，不接', async () => {
    const sessions = new SessionRegistry('root-1');
    sessions.onFlush(() => Promise.reject(new Error('磁碟滿了')));
    await expect(sessions.flush(sessions.root)).rejects.toThrow('磁碟滿了');
  });

  it('退訂之後不再被問，退訂冪等', async () => {
    const sessions = new SessionRegistry('root-1');
    let asked = 0;
    const off = sessions.onFlush(() => {
      asked += 1;
      return Promise.resolve();
    });
    off();
    off();
    expect(await sessions.flush(sessions.root)).toBe(false);
    expect(asked).toBe(0);
  });
});
