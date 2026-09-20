import { createRegistry, loadPlugins, SessionLog, SessionRegistry } from '@nexus/core';
import type { LoggedMessage, SessionEvent } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import {
  createFeedbackPlugin,
  feedbackPlugin,
  createFeedbackService,
  currentFeedbackItems,
  FEEDBACK_USAGE,
} from './index.js';

const service = createFeedbackService({ maxNoteBytes: 16 });

/** 一則記進日誌的回覆。`id` 省略就是沒記 id 的那種。 */
function ai(text: string, id?: string): LoggedMessage {
  return {
    type: 'ai',
    data: { content: text, ...(id === undefined ? {} : { id }) },
  } as LoggedMessage;
}

/**
 * 一份有兩輪的日誌：第一輪先叫工具、停在核准點又續接，續接後才有文字回覆；第二輪是 goal 排的。
 * 回傳兩輪起頭的 `seq`。
 */
function logWithTurns(): { log: SessionLog; first: number; second: number } {
  const log = new SessionLog('feedback-test');
  const first = log.append('turn/start', { kind: 'message', text: '跑。' }).seq;
  log.append('assistant/message', { message: ai('', 'm-tool') });
  log.append('interrupt/raised', { interruptId: 'i1' });
  log.append('turn/end', {});
  log.append('turn/start', { kind: 'resume' });
  log.append('assistant/message', { message: ai('跑完了。', 'm-first') });
  log.append('turn/end', {});
  const second = log.append('turn/start', {
    kind: 'goal',
    text: '續。',
    goalId: 'g1' as never,
    revision: 1,
    round: 1,
  }).seq;
  log.append('assistant/message', { message: ai('續完了。', 'm-goal') });
  log.append('turn/end', {});
  return { log, first, second };
}

function feedbackEvents(log: SessionLog): SessionEvent[] {
  return log.events.filter((event) => event.type.startsWith('feedback/'));
}

describe('評分', () => {
  it('新建要 ifVersion: null，寫一顆 feedback/message-put，目標是那則回覆的訊息 id', () => {
    const { log } = logWithTurns();
    const result = service.put(log, {
      messageId: 'm-first',
      rating: 'negative',
      category: 'task-result',
      ifVersion: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      messageId: 'm-first',
      rating: 'negative',
      category: 'task-result',
    });
    expect(result.value.createdAt).toBe(result.value.updatedAt);
    const events = feedbackEvents(log);
    expect(events.map((event) => event.type)).toEqual(['feedback/message-put']);
    expect(events[0]!.data).toEqual({ item: result.value });
  });

  it('不是 assistant/message 記的 id 都是 target-not-found，日誌不動', () => {
    const { log } = logWithTurns();
    // 外掛注入的 user/message 帶了 id 也不算：目標只認 assistant 訊息（同 dsh）。
    log.append('user/message', {
      message: { ...ai('提醒', 'm-user'), type: 'human' } as LoggedMessage,
      source: { kind: 'plugin', plugin: 'x' },
    });
    for (const messageId of ['m-user', 'nope', 'history-0', '']) {
      expect(service.put(log, { messageId, rating: 'positive', ifVersion: null })).toEqual({
        ok: false,
        error: { code: 'target-not-found', messageId },
      });
    }
    expect(feedbackEvents(log)).toEqual([]);
  });

  it('goal 排的那一輪的回覆也評得到', () => {
    const { log } = logWithTurns();
    expect(service.put(log, { messageId: 'm-goal', rating: 'positive', ifVersion: null }).ok).toBe(
      true,
    );
  });

  it('版本對不上回 version-conflict 並附目前那筆；已有評分時再送 null 也衝突', () => {
    const { log } = logWithTurns();
    const target = { messageId: 'm-first' };
    const created = service.put(log, { ...target, rating: 'positive', ifVersion: null });
    if (!created.ok) throw new Error('建不起來');
    expect(service.put(log, { ...target, rating: 'negative', ifVersion: null })).toEqual({
      ok: false,
      error: { code: 'version-conflict', current: created.value },
    });
    expect(service.put(log, { ...target, rating: 'negative', ifVersion: 'stale' })).toEqual({
      ok: false,
      error: { code: 'version-conflict', current: created.value },
    });
    expect(feedbackEvents(log)).toHaveLength(1);
  });

  it('內容一樣就不記、版本不換；改了才記、換版本、保留建立時間', () => {
    const { log } = logWithTurns();
    const target = { messageId: 'm-first' };
    const created = service.put(log, {
      ...target,
      rating: 'negative',
      note: '慢',
      ifVersion: null,
    });
    if (!created.ok) throw new Error('建不起來');
    const same = service.put(log, {
      ...target,
      rating: 'negative',
      note: '慢',
      ifVersion: created.value.version,
    });
    expect(same).toEqual(created);
    expect(feedbackEvents(log)).toHaveLength(1);

    const changed = service.put(log, {
      ...target,
      rating: 'positive',
      ifVersion: created.value.version,
    });
    if (!changed.ok) throw new Error('改不動');
    expect(changed.value.version).not.toBe(created.value.version);
    expect(changed.value.createdAt).toBe(created.value.createdAt);
    expect(changed.value.note).toBeUndefined();
    expect(feedbackEvents(log)).toHaveLength(2);
  });

  it('備註全是空白回 note-blank；超過位元組上限回 note-too-large（多位元組照位元組算）', () => {
    const { log } = logWithTurns();
    const target = { messageId: 'm-first' };
    expect(
      service.put(log, { ...target, rating: 'negative', note: '  \n', ifVersion: null }),
    ).toEqual({
      ok: false,
      error: { code: 'note-blank' },
    });
    // 六個中文字＝18 個 UTF-8 位元組，上限 16。
    expect(
      service.put(log, { ...target, rating: 'negative', note: '一二三四五六', ifVersion: null }),
    ).toEqual({
      ok: false,
      error: { code: 'note-too-large', maxBytes: 16, actualBytes: 18 },
    });
    // 剛好 16 個位元組收得下。
    expect(
      service.put(log, { ...target, rating: 'negative', note: '一二三四五x', ifVersion: null }).ok,
    ).toBe(true);
  });

  it('收回：寫一顆 message-delete；不存在的成功但不記；版本不對衝突', () => {
    const { log } = logWithTurns();
    const target = { messageId: 'm-first' };
    expect(service.delete(log, { ...target, ifVersion: 'whatever' })).toEqual({
      ok: true,
      value: { absent: true },
    });
    expect(feedbackEvents(log)).toEqual([]);

    const created = service.put(log, { ...target, rating: 'negative', ifVersion: null });
    if (!created.ok) throw new Error('建不起來');
    expect(service.delete(log, { ...target, ifVersion: 'stale' })).toEqual({
      ok: false,
      error: { code: 'version-conflict', current: created.value },
    });
    expect(service.delete(log, { ...target, ifVersion: created.value.version }).ok).toBe(true);
    expect(feedbackEvents(log).map((event) => event.type)).toEqual([
      'feedback/message-put',
      'feedback/message-delete',
    ]);
    expect(feedbackEvents(log)[1]!.data).toEqual(target);
    expect(currentFeedbackItems(log.events).size).toBe(0);
    // 收回之後重新評要當成新建。
    expect(service.put(log, { ...target, rating: 'positive', ifVersion: null }).ok).toBe(true);
  });

  it('list：目前的評分，依第一次評的先後；收回的不在裡面', () => {
    const { log } = logWithTurns();
    expect(service.list(log)).toEqual({ ok: true, value: { items: [] } });
    const goal = service.put(log, { messageId: 'm-goal', rating: 'positive', ifVersion: null });
    const first = service.put(log, { messageId: 'm-first', rating: 'negative', ifVersion: null });
    if (!goal.ok || !first.ok) throw new Error('建不起來');
    const changed = service.put(log, {
      messageId: 'm-goal',
      rating: 'negative',
      ifVersion: goal.value.version,
    });
    if (!changed.ok) throw new Error('改不動');
    expect(service.list(log)).toEqual({ ok: true, value: { items: [changed.value, first.value] } });
    service.delete(log, { messageId: 'm-goal', ifVersion: changed.value.version });
    expect(service.list(log)).toEqual({ ok: true, value: { items: [first.value] } });
  });
});

describe('格式 10 以前以輪記的評分', () => {
  const legacy = (turn: number, version: string) => ({
    turn,
    rating: 'negative' as const,
    version,
    createdAt: 1,
    updatedAt: 1,
  });

  it('對到那一輪最後一則有文字的回覆：續接之後那則，不是只叫工具的那則', () => {
    const { log, first } = logWithTurns();
    log.append('feedback/message-put', { item: legacy(first, 'v-old') });
    expect(service.list(log)).toEqual({
      ok: true,
      value: {
        items: [
          {
            messageId: 'm-first',
            rating: 'negative',
            version: 'v-old',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    });
  });

  it('那一輪沒有對得到的回覆（格式 9 以前沒記回覆、或回覆沒記 id）就不列', () => {
    const log = new SessionLog('feedback-legacy');
    const v8 = log.append('turn/start', { kind: 'message', text: '舊的。' }).seq;
    log.append('turn/end', {});
    const noId = log.append('turn/start', { kind: 'message', text: '沒 id。' }).seq;
    log.append('assistant/message', { message: ai('有字沒 id。') });
    log.append('turn/end', {});
    log.append('feedback/message-put', { item: legacy(v8, 'v1') });
    log.append('feedback/message-put', { item: legacy(noId, 'v2') });
    expect(service.list(log)).toEqual({ ok: true, value: { items: [] } });
  });

  it('同一則回覆的新評分接著舊的那筆改：版本要對、建立時間留著；舊格式的收回也收得掉', () => {
    const { log, first, second } = logWithTurns();
    log.append('feedback/message-put', { item: legacy(first, 'v-old') });
    expect(
      service.put(log, { messageId: 'm-first', rating: 'positive', ifVersion: null }),
    ).toMatchObject({ ok: false, error: { code: 'version-conflict' } });
    const changed = service.put(log, {
      messageId: 'm-first',
      rating: 'positive',
      ifVersion: 'v-old',
    });
    if (!changed.ok) throw new Error('改不動');
    expect(changed.value).toMatchObject({ messageId: 'm-first', createdAt: 1 });
    expect(service.list(log)).toEqual({ ok: true, value: { items: [changed.value] } });

    log.append('feedback/message-put', { item: legacy(second, 'v-goal') });
    log.append('feedback/message-delete', { turn: second });
    expect(service.list(log)).toEqual({ ok: true, value: { items: [changed.value] } });
  });
});

describe('設定', () => {
  // **服務那一支自己留著執行期檢查**：它是一支獨立的 API（`apps/harness` 有測試直接叫它），
  // 而 schema 只守 plugin 那條路。兩條路都要擋得住。
  it('maxNoteBytes 不是正的安全整數就拒絕（服務那一支）', () => {
    for (const maxNoteBytes of [0, -1, 1.5, Number.NaN]) {
      expect(() => createFeedbackService({ maxNoteBytes })).toThrow(TypeError);
    }
  });

  it('maxNoteBytes 不是正的安全整數就讓載入失敗（#453：驗在載入的時候）', async () => {
    for (const maxNoteBytes of [0, -1, 1.5, Number.NaN]) {
      const bad = [createFeedbackPlugin({ maxNoteBytes })];
      await expect(loadPlugins(bad)).rejects.toThrow('feedback#0 (feedback)');
      await expect(loadPlugins(bad)).rejects.toThrow('maxNoteBytes');
    }
  });

  it('必填：一格都不給也是載入失敗，沒有預設值（照 dsh 的 `required()`）', async () => {
    await expect(loadPlugins([{ plugin: feedbackPlugin }])).rejects.toThrow('maxNoteBytes');
  });

  it('未知欄位讓載入失敗（登記的偏離：dsh 放行）', async () => {
    await expect(
      loadPlugins([{ plugin: feedbackPlugin, config: { maxNoteBytes: 8, maxNotBytes: 8 } }]),
    ).rejects.toThrow(/maxNotBytes/);
  });

  it('**一次組裝一份服務**：同一顆 plugin 掛兩次，兩邊的上限各自算各自的', async () => {
    // plugin 提到模組層級之後，這一條是「設定真的是每次掛載的」的絆索：服務建在 `apply`
    // 裡才會有兩份。建在模組層級的話兩次組裝共用同一個上限，而且不會拋。
    const small = await loadPlugins([createFeedbackPlugin({ maxNoteBytes: 4 })]);
    const large = await loadPlugins([createFeedbackPlugin({ maxNoteBytes: 4096 })]);
    const a = small.registry.feedback.service()!.value;
    const b = large.registry.feedback.service()!.value;

    expect(a).not.toBe(b);
    const log = new SessionRegistry('限額').root;
    const note = 'x'.repeat(100);
    expect(
      a.put(log, { messageId: '無', rating: 'positive', note, ifVersion: null }),
    ).toMatchObject({
      ok: false,
      error: { code: 'note-too-large', maxBytes: 4 },
    });
    // 大的那一份走到下一關（目標訊息不存在），代表它沒有被小的那個上限擋下來。
    expect(
      b.put(log, { messageId: '無', rating: 'positive', note, ifVersion: null }),
    ).toMatchObject({
      ok: false,
      error: { code: 'target-not-found' },
    });
  });
});

describe('/feedback', () => {
  async function assemble() {
    const { registry, dispose } = await loadPlugins([createFeedbackPlugin({ maxNoteBytes: 8192 })]);
    const sessions = new SessionRegistry('feedback-root');
    const detachers = registry.sessions.installers().map((entry) => entry.value);
    const unbind = registry.sessions.bind(sessions);
    return { registry, sessions, detachers, unbind, dispose };
  }

  it('空字串回用法說明、不記', async () => {
    const run = await assemble();
    try {
      const command = run.registry.commands.find('feedback');
      expect(command?.recordInput).toBe(false);
      expect(
        await command!.handler({
          commandId: 'c1',
          rawInput: '   ',
          signal: new AbortController().signal,
        }),
      ).toEqual({
        kind: 'error',
        text: FEEDBACK_USAGE,
      });
    } finally {
      run.unbind();
      await run.dispose();
    }
  });

  it('掛上 registry.feedback；沒掛時是 undefined', () => {
    expect(createRegistry().feedback.service()).toBeUndefined();
  });
});
