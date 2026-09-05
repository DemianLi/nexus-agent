/**
 * 待辦快照的配套入口：**形狀**與**歸屬**。
 *
 * 形狀那幾條擋的是「有別的生產者繞過工具往日誌寫東西」——工具那側 `toTodoList` 已經
 * 攔過同樣的東西，兩邊不是重複：一個回給模型、一個回給看終端機的人，而且**日誌是重放
 * 得回來的**，工具那次驗證不是。
 *
 * 歸屬那一組是這一檔的重點，理由見 `invariant.ts` 檔頭。
 */

import { describe, expect, it } from 'vitest';

import { createInvariantRunner, createRegistry, SessionLog } from '@nexus/core';
import type { InvariantError, TodoItem } from '@nexus/core';

import {
  createTodoInvariantPlugin,
  TODO_INVARIANT_PACKAGE,
  todoSnapshotInvariant,
} from './invariant.js';

/** 接上配套入口，回收到的違規。 */
function watch(log: SessionLog): InvariantError[] {
  const violations: InvariantError[] = [];
  createInvariantRunner({
    log,
    companions: [
      {
        packageName: TODO_INVARIANT_PACKAGE,
        installer: todoSnapshotInvariant,
        origin: { id: 'todo-invariant#0', name: 'todo-invariant' },
      },
    ],
    onViolation: (error) => violations.push(error),
    warn: (message) => {
      throw new Error(`不該有 warn：${message}`);
    },
  });
  return violations;
}

const ONE: TodoItem = { content: '把它做完', status: 'in_progress' };

/** 開一輪、寫一份清單、收工——root 那條路的完整形狀。 */
function inTurn(log: SessionLog, todos: readonly TodoItem[]): void {
  log.append('turn/start', { kind: 'message', text: '跑。' });
  log.append('todo/write', { todos });
  log.append('turn/end', {});
}

describe('形狀', () => {
  it('一份正常的清單不吭聲', () => {
    const log = new SessionLog('shape');
    const violations = watch(log);
    inTurn(log, [ONE, { content: '再做一件', status: 'pending' }]);
    expect(violations).toEqual([]);
  });

  it('空的清單也是合法的——清單清空是一次真的規劃', () => {
    const log = new SessionLog('empty');
    const violations = watch(log);
    inTurn(log, []);
    expect(violations).toEqual([]);
  });

  it.each([
    ['content 是空的', [{ content: '', status: 'pending' }], /content 必須非空/u],
    ['content 帶著空白', [{ content: ' 前面有空白', status: 'pending' }], /去過頭尾空白/u],
    [
      'content 重複',
      [
        { content: '同一句', status: 'pending' },
        { content: '同一句', status: 'completed' },
      ],
      /重複了 content/u,
    ],
    ['狀態不認得', [{ content: '一句', status: 'nope' }], /不認得的狀態/u],
    ['條目不是物件', ['一句'], /條目不是物件/u],
  ])('%s——報出來', (_label, todos, pattern) => {
    const log = new SessionLog('bad');
    const violations = watch(log);
    // 只有轉型騙得過型別；真流量上這是另一個生產者繞過工具才會發生的事。
    inTurn(log, todos as unknown as readonly TodoItem[]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(pattern);
    expect(violations[0]?.packageName).toBe(TODO_INVARIANT_PACKAGE);
  });

  it('todos 根本不是陣列——連這種也報', () => {
    const log = new SessionLog('not-array');
    const violations = watch(log);
    log.append('turn/start', { kind: 'message', text: '跑。' });
    log.append('todo/write', { todos: 'nope' } as unknown as { todos: readonly TodoItem[] });
    expect(violations[0]?.message).toMatch(/不是陣列/u);
  });

  /**
   * **這一條是絆索，釘的是「不變量不跟著部署政策走」。**
   *
   * `allowParallelInProgress: false` 的組裝下，工具會拒絕這一份；但一份在允許並行時
   * 寫下的日誌**必須回放得了**——把政策綁進不變量，等於讓歷史因為今天的設定而變成違規。
   * 這一條照 dsh 明說的那一段。
   */
  it('三條同時 in_progress——不變量不管，那是部署政策', () => {
    const log = new SessionLog('parallel');
    const violations = watch(log);
    inTurn(log, [
      { content: '甲', status: 'in_progress' },
      { content: '乙', status: 'in_progress' },
      { content: '丙', status: 'in_progress' },
    ]);
    expect(violations).toEqual([]);
  });
});

describe('歸屬', () => {
  it('落在輪之外——報出來', () => {
    const log = new SessionLog('outside');
    const violations = watch(log);
    log.append('turn/start', { kind: 'message', text: '跑。' });
    log.append('turn/end', {});
    log.append('todo/write', { todos: [ONE] });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/落在任何開著的輪之外/u);
  });

  it('turn/failed 也算收工，之後寫一樣報', () => {
    const log = new SessionLog('failed');
    const violations = watch(log);
    log.append('turn/start', { kind: 'message', text: '跑。' });
    log.append('turn/failed', { message: '炸了' });
    log.append('todo/write', { todos: [ONE] });
    expect(violations).toHaveLength(1);
  });

  /**
   * **這一條是這個配套入口與 dsh 唯一不同的那一筆，而它必須有測試。**
   *
   * subagent 的日誌上永遠不會有 `turn/start`（發 turn 事件的是進入點，subagent 不經過
   * 進入點——[#137](https://github.com/DemianLi/nexus-agent/issues/137) 釘下來的約定）。
   * dsh 那條無條件的規則照抄過來的話，**每一次 subagent 的 `todo_write` 都會變成違規**，
   * 而違規的去處是使用者的終端機。
   *
   * 端到端的那一半在 `apps/harness/src/todo-tool.test.ts`：真的跑一次委派，確認十三個
   * 配套入口一句話都不說。
   */
  it('一份從來沒有輪的日誌——規則對它沒有指涉對象，不報', () => {
    const log = new SessionLog('lineage/subagent');
    const violations = watch(log);
    log.append('todo/write', { todos: [ONE] });
    log.append('todo/write', { todos: [{ content: '換一份', status: 'completed' }] });
    expect(violations).toEqual([]);
  });

  /**
   * **翻面的那一半。** 上面那條靠「沒見過輪」放行，這一條確認它**不是無條件放行**：
   * 同一份日誌只要出現過一顆 `turn/start`，規則就開始生效。
   *
   * 這也是「哪天 subagent 真的長出輪，這條檢查會自己跟上」那句話的證據。
   */
  it('見過一次輪之後就開始守——後面落在輪外的照樣報', () => {
    const log = new SessionLog('later');
    const violations = watch(log);
    log.append('todo/write', { todos: [ONE] });
    expect(violations).toEqual([]);
    log.append('turn/start', { kind: 'message', text: '跑。' });
    log.append('turn/end', {});
    log.append('todo/write', { todos: [ONE] });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/落在任何開著的輪之外/u);
  });

  it('形狀壞掉時不看歸屬——一筆事件報一個理由', () => {
    const log = new SessionLog('both');
    const violations = watch(log);
    // 既沒開輪、content 也是空的。`fail` 會拋，所以停在形狀那一條。
    log.append('turn/start', { kind: 'message', text: '跑。' });
    log.append('turn/end', {});
    log.append('todo/write', {
      todos: [{ content: '', status: 'pending' }] as unknown as readonly TodoItem[],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/content 必須非空/u);
  });
});

describe('註冊', () => {
  it('掛上去就認領自己的包名', () => {
    const registry = createRegistry();
    const plugin = createTodoInvariantPlugin();
    const exit = registry.enter({ id: `${plugin.name}#0`, name: plugin.name });
    plugin.apply(registry);
    exit();

    expect(registry.invariants.companions().map((entry) => entry.packageName)).toEqual([
      TODO_INVARIANT_PACKAGE,
    ]);
  });
});
