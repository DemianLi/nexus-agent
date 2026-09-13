import { createRegistry, loadPlugins, SessionLog, SessionRegistry } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import {
  createFeedbackPlugin,
  createFeedbackService,
  currentFeedbackItems,
  FEEDBACK_USAGE,
} from './index.js';

const service = createFeedbackService({ maxNoteBytes: 16 });

/** 一份有兩輪的日誌：第一輪停在核准點又續接，第二輪是 goal 排的。回傳兩輪起頭的 `seq`。 */
function logWithTurns(): { log: SessionLog; first: number; resume: number; second: number } {
  const log = new SessionLog('feedback-test');
  const first = log.append('turn/start', { kind: 'message', text: '跑。' }).seq;
  log.append('interrupt/raised', { interruptId: 'i1' });
  log.append('turn/end', {});
  const resume = log.append('turn/start', { kind: 'resume' }).seq;
  log.append('turn/end', {});
  const second = log.append('turn/start', {
    kind: 'goal',
    text: '續。',
    goalId: 'g1' as never,
    revision: 1,
    round: 1,
  }).seq;
  log.append('turn/end', {});
  return { log, first, resume, second };
}

function feedbackEvents(log: SessionLog): SessionEvent[] {
  return log.events.filter((event) => event.type.startsWith('feedback/'));
}

describe('評分', () => {
  it('新建要 ifVersion: null，寫一顆 feedback/message-put，turn 是起頭那顆', () => {
    const { log, first } = logWithTurns();
    const result = service.put(log, {
      turn: first,
      rating: 'negative',
      category: 'task-result',
      ifVersion: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      turn: first,
      rating: 'negative',
      category: 'task-result',
    });
    expect(result.value.createdAt).toBe(result.value.updatedAt);
    const events = feedbackEvents(log);
    expect(events.map((event) => event.type)).toEqual(['feedback/message-put']);
    expect(events[0]!.data).toEqual({ item: result.value });
  });

  it('resume 那顆與不存在的 seq 都是 target-not-found，日誌不動', () => {
    const { log, resume } = logWithTurns();
    for (const turn of [resume, 999, -1]) {
      expect(service.put(log, { turn, rating: 'positive', ifVersion: null })).toEqual({
        ok: false,
        error: { code: 'target-not-found', turn },
      });
    }
    expect(feedbackEvents(log)).toEqual([]);
  });

  it('goal 排的那一輪也評得到', () => {
    const { log, second } = logWithTurns();
    expect(service.put(log, { turn: second, rating: 'positive', ifVersion: null }).ok).toBe(true);
  });

  it('版本對不上回 version-conflict 並附目前那筆；已有評分時再送 null 也衝突', () => {
    const { log, first } = logWithTurns();
    const created = service.put(log, { turn: first, rating: 'positive', ifVersion: null });
    if (!created.ok) throw new Error('建不起來');
    expect(service.put(log, { turn: first, rating: 'negative', ifVersion: null })).toEqual({
      ok: false,
      error: { code: 'version-conflict', current: created.value },
    });
    expect(service.put(log, { turn: first, rating: 'negative', ifVersion: 'stale' })).toEqual({
      ok: false,
      error: { code: 'version-conflict', current: created.value },
    });
    expect(feedbackEvents(log)).toHaveLength(1);
  });

  it('內容一樣就不記、版本不換；改了才記、換版本、保留建立時間', () => {
    const { log, first } = logWithTurns();
    const created = service.put(log, {
      turn: first,
      rating: 'negative',
      note: '慢',
      ifVersion: null,
    });
    if (!created.ok) throw new Error('建不起來');
    const same = service.put(log, {
      turn: first,
      rating: 'negative',
      note: '慢',
      ifVersion: created.value.version,
    });
    expect(same).toEqual(created);
    expect(feedbackEvents(log)).toHaveLength(1);

    const changed = service.put(log, {
      turn: first,
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
    const { log, first } = logWithTurns();
    expect(
      service.put(log, { turn: first, rating: 'negative', note: '  \n', ifVersion: null }),
    ).toEqual({
      ok: false,
      error: { code: 'note-blank' },
    });
    // 六個中文字＝18 個 UTF-8 位元組，上限 16。
    expect(
      service.put(log, { turn: first, rating: 'negative', note: '一二三四五六', ifVersion: null }),
    ).toEqual({
      ok: false,
      error: { code: 'note-too-large', maxBytes: 16, actualBytes: 18 },
    });
    // 剛好 16 個位元組收得下。
    expect(
      service.put(log, { turn: first, rating: 'negative', note: '一二三四五x', ifVersion: null })
        .ok,
    ).toBe(true);
  });

  it('收回：寫一顆 message-delete；不存在的成功但不記；版本不對衝突', () => {
    const { log, first } = logWithTurns();
    expect(service.delete(log, { turn: first, ifVersion: 'whatever' })).toEqual({
      ok: true,
      value: { absent: true },
    });
    expect(feedbackEvents(log)).toEqual([]);

    const created = service.put(log, { turn: first, rating: 'negative', ifVersion: null });
    if (!created.ok) throw new Error('建不起來');
    expect(service.delete(log, { turn: first, ifVersion: 'stale' })).toEqual({
      ok: false,
      error: { code: 'version-conflict', current: created.value },
    });
    expect(service.delete(log, { turn: first, ifVersion: created.value.version }).ok).toBe(true);
    expect(feedbackEvents(log).map((event) => event.type)).toEqual([
      'feedback/message-put',
      'feedback/message-delete',
    ]);
    expect(currentFeedbackItems(log.events).size).toBe(0);
    // 收回之後重新評要當成新建。
    expect(service.put(log, { turn: first, rating: 'positive', ifVersion: null }).ok).toBe(true);
  });

  it('maxNoteBytes 不是正的安全整數就拒絕', () => {
    for (const maxNoteBytes of [0, -1, 1.5, Number.NaN]) {
      expect(() => createFeedbackService({ maxNoteBytes })).toThrow(TypeError);
    }
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
