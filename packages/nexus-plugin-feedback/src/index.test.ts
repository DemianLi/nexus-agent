import { readFileSync } from 'node:fs';

import { createCommandsProvider } from '@nexus/commands/provider';
import { createSessionDurabilityProvider } from '@nexus/session/provider';
import { SessionLog } from '@nexus/core';
import type { LoggedMessage, SessionEvent } from '@nexus/core';
import { Context } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';
import {
  FeedbackDurabilityUnavailableError,
  FeedbackLogCorruptionError,
  feedbackToken,
} from '@nexus/feedback';
import type { FeedbackService } from '@nexus/feedback';
import { checkConformance } from '@nexus/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import * as feedback from './index.js';
import { createFeedbackService, currentFeedbackItems, FEEDBACK_USAGE } from './index.js';

/** 每一次落盤確認拿到的那一份日誌。這一檔不碰磁碟：確認本身的行為在 `apps/harness` 走真的 store 驗（#1606 驗收 A–D）。 */
const checkpoints: SessionLog[] = [];
/** 下一次落盤確認要拋的錯；`undefined` 就放行。 */
let refuse: Error | undefined;
const durability = {
  checkpoint: (log: SessionLog) => {
    checkpoints.push(log);
    return refuse === undefined ? Promise.resolve() : Promise.reject(refuse);
  },
};
/** 這個組裝掛不掛落盤：`false` 就是宿主沒提供 `sessionDurability`。 */
let durable = true;
const service = createFeedbackService({ maxNoteBytes: 16 }, () =>
  durable ? durability : undefined,
);

afterEach(() => {
  checkpoints.length = 0;
  refuse = undefined;
  durable = true;
});

/** 舊格式評分的版本記號：真的日誌裡是 `randomUUID()`（`fixtures/session-format/v8`、`v9`）。 */
const V_OLD = '4fa49e88-3aef-43f7-abaa-bd862a1fe08a';
const V_GOAL = 'e4d291e3-5e23-4d3f-b4ce-a4a1ad405f50';

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
  it('新建要 ifVersion: null，寫一顆 feedback/message-put，目標是那則回覆的訊息 id', async () => {
    const { log } = logWithTurns();
    const result = await service.put(log, {
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

  it('講到一半被停下來的那則帶著 id 也不能評（#1044：id 只用來對補送與歷史）', async () => {
    const { log } = logWithTurns();
    log.append('assistant/message', { message: ai('半段', 'm-stopped'), interrupted: true });
    expect(
      await service.put(log, { messageId: 'm-stopped', rating: 'positive', ifVersion: null }),
    ).toEqual({
      ok: false,
      error: { code: 'target-not-found', messageId: 'm-stopped' },
    });
  });

  it('不是 assistant/message 記的 id 都是 target-not-found，日誌不動', async () => {
    const { log } = logWithTurns();
    // 外掛注入的 user/message 帶了 id 也不算：目標只認 assistant 訊息（同 dsh）。
    log.append('user/message', {
      message: { ...ai('提醒', 'm-user'), type: 'human' } as LoggedMessage,
      source: { kind: 'plugin', plugin: 'x' },
    });
    for (const messageId of ['m-user', 'nope', 'history-0', '']) {
      expect(await service.put(log, { messageId, rating: 'positive', ifVersion: null })).toEqual({
        ok: false,
        error: { code: 'target-not-found', messageId },
      });
    }
    expect(feedbackEvents(log)).toEqual([]);
  });

  it('goal 排的那一輪的回覆也評得到', async () => {
    const { log } = logWithTurns();
    expect(
      (await service.put(log, { messageId: 'm-goal', rating: 'positive', ifVersion: null })).ok,
    ).toBe(true);
  });

  it('版本對不上回 version-conflict 並附目前那筆；已有評分時再送 null 也衝突', async () => {
    const { log } = logWithTurns();
    const target = { messageId: 'm-first' };
    const created = await service.put(log, { ...target, rating: 'positive', ifVersion: null });
    if (!created.ok) throw new Error('建不起來');
    expect(await service.put(log, { ...target, rating: 'negative', ifVersion: null })).toEqual({
      ok: false,
      error: { code: 'version-conflict', current: created.value },
    });
    expect(await service.put(log, { ...target, rating: 'negative', ifVersion: 'stale' })).toEqual({
      ok: false,
      error: { code: 'version-conflict', current: created.value },
    });
    expect(feedbackEvents(log)).toHaveLength(1);
  });

  it('內容一樣就不記、版本不換；改了才記、換版本、保留建立時間', async () => {
    const { log } = logWithTurns();
    const target = { messageId: 'm-first' };
    const created = await service.put(log, {
      ...target,
      rating: 'negative',
      note: '慢',
      ifVersion: null,
    });
    if (!created.ok) throw new Error('建不起來');
    const same = await service.put(log, {
      ...target,
      rating: 'negative',
      note: '慢',
      ifVersion: created.value.version,
    });
    expect(same).toEqual(created);
    expect(feedbackEvents(log)).toHaveLength(1);

    const changed = await service.put(log, {
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

  it('備註全是空白回 note-blank；超過位元組上限回 note-too-large（多位元組照位元組算）', async () => {
    const { log } = logWithTurns();
    const target = { messageId: 'm-first' };
    expect(
      await service.put(log, { ...target, rating: 'negative', note: '  \n', ifVersion: null }),
    ).toEqual({
      ok: false,
      error: { code: 'note-blank' },
    });
    // 六個中文字＝18 個 UTF-8 位元組，上限 16。
    expect(
      await service.put(log, {
        ...target,
        rating: 'negative',
        note: '一二三四五六',
        ifVersion: null,
      }),
    ).toEqual({
      ok: false,
      error: { code: 'note-too-large', maxBytes: 16, actualBytes: 18 },
    });
    // 剛好 16 個位元組收得下。
    expect(
      (
        await service.put(log, {
          ...target,
          rating: 'negative',
          note: '一二三四五x',
          ifVersion: null,
        })
      ).ok,
    ).toBe(true);
  });

  it('收回：寫一顆 message-delete；不存在的成功但不記；版本不對衝突', async () => {
    const { log } = logWithTurns();
    const target = { messageId: 'm-first' };
    expect(await service.delete(log, { ...target, ifVersion: 'whatever' })).toEqual({
      ok: true,
      value: { absent: true },
    });
    expect(feedbackEvents(log)).toEqual([]);

    const created = await service.put(log, { ...target, rating: 'negative', ifVersion: null });
    if (!created.ok) throw new Error('建不起來');
    expect(await service.delete(log, { ...target, ifVersion: 'stale' })).toEqual({
      ok: false,
      error: { code: 'version-conflict', current: created.value },
    });
    expect((await service.delete(log, { ...target, ifVersion: created.value.version })).ok).toBe(
      true,
    );
    expect(feedbackEvents(log).map((event) => event.type)).toEqual([
      'feedback/message-put',
      'feedback/message-delete',
    ]);
    expect(feedbackEvents(log)[1]!.data).toEqual(target);
    expect(currentFeedbackItems(log.events).size).toBe(0);
    // 收回之後重新評要當成新建。
    expect((await service.put(log, { ...target, rating: 'positive', ifVersion: null })).ok).toBe(
      true,
    );
  });

  it('list：目前的評分，依第一次評的先後；收回的不在裡面', async () => {
    const { log } = logWithTurns();
    expect(await service.list(log)).toEqual({ ok: true, value: { items: [] } });
    const goal = await service.put(log, {
      messageId: 'm-goal',
      rating: 'positive',
      ifVersion: null,
    });
    const first = await service.put(log, {
      messageId: 'm-first',
      rating: 'negative',
      ifVersion: null,
    });
    if (!goal.ok || !first.ok) throw new Error('建不起來');
    const changed = await service.put(log, {
      messageId: 'm-goal',
      rating: 'negative',
      ifVersion: goal.value.version,
    });
    if (!changed.ok) throw new Error('改不動');
    expect(await service.list(log)).toEqual({
      ok: true,
      value: { items: [changed.value, first.value] },
    });
    await service.delete(log, { messageId: 'm-goal', ifVersion: changed.value.version });
    expect(await service.list(log)).toEqual({ ok: true, value: { items: [first.value] } });
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

  it('對到那一輪最後一則有文字的回覆：續接之後那則，不是只叫工具的那則', async () => {
    const { log, first } = logWithTurns();
    log.append('feedback/message-put', { item: legacy(first, V_OLD) });
    expect(await service.list(log)).toEqual({
      ok: true,
      value: {
        items: [
          {
            messageId: 'm-first',
            rating: 'negative',
            version: V_OLD,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    });
  });

  it('那一輪沒有對得到的回覆（格式 9 以前沒記回覆、或回覆沒記 id）就不列', async () => {
    const log = new SessionLog('feedback-legacy');
    const v8 = log.append('turn/start', { kind: 'message', text: '舊的。' }).seq;
    log.append('turn/end', {});
    const noId = log.append('turn/start', { kind: 'message', text: '沒 id。' }).seq;
    log.append('assistant/message', { message: ai('有字沒 id。') });
    log.append('turn/end', {});
    log.append('feedback/message-put', { item: legacy(v8, V_OLD) });
    log.append('feedback/message-put', { item: legacy(noId, V_GOAL) });
    expect(await service.list(log)).toEqual({ ok: true, value: { items: [] } });
  });

  it('同一則回覆的新評分接著舊的那筆改：版本要對、建立時間留著；舊格式的收回也收得掉', async () => {
    const { log, first, second } = logWithTurns();
    log.append('feedback/message-put', { item: legacy(first, V_OLD) });
    expect(
      await service.put(log, { messageId: 'm-first', rating: 'positive', ifVersion: null }),
    ).toMatchObject({ ok: false, error: { code: 'version-conflict' } });
    const changed = await service.put(log, {
      messageId: 'm-first',
      rating: 'positive',
      ifVersion: V_OLD,
    });
    if (!changed.ok) throw new Error('改不動');
    expect(changed.value).toMatchObject({ messageId: 'm-first', createdAt: 1 });
    expect(await service.list(log)).toEqual({ ok: true, value: { items: [changed.value] } });

    log.append('feedback/message-put', { item: legacy(second, V_GOAL) });
    log.append('feedback/message-delete', { turn: second });
    expect(await service.list(log)).toEqual({ ok: true, value: { items: [changed.value] } });
  });
});

describe('落盤確認（#1606）', () => {
  it('評分每一次寫入之後都確認一次，含內容一樣的 put 與收回不存在的 delete（照 dsh `:183`、`:214`）；評語與 list 不確認', async () => {
    const { log } = logWithTurns();
    const target = { messageId: 'm-first' };
    const created = await service.put(log, { ...target, rating: 'negative', ifVersion: null });
    if (!created.ok) throw new Error('建不起來');
    await service.put(log, { ...target, rating: 'negative', ifVersion: created.value.version });
    await service.delete(log, { messageId: 'm-goal', ifVersion: 'whatever' });
    await service.record(log, { text: '慢' });
    await service.list(log);
    // 評語照 dsh 不等落盤（`command-feedback/src/index.ts:4-7`）。
    expect(checkpoints).toEqual([log, log, log]);
    // 不記事件的那兩次沒有多寫東西。
    expect(feedbackEvents(log).map((event) => event.type)).toEqual([
      'feedback/message-put',
      'feedback/record',
    ]);
  });

  it('業務碼的拒絕不確認：沒有寫入，也就沒有要落盤的', async () => {
    const { log } = logWithTurns();
    await service.put(log, { messageId: 'nope', rating: 'positive', ifVersion: null });
    await service.put(log, { messageId: 'm-first', rating: 'positive', ifVersion: 'stale' });
    expect(checkpoints).toEqual([]);
  });

  it('確認被拒就往外拋，不回成功；評語不受影響', async () => {
    const { log } = logWithTurns();
    refuse = new Error('磁碟滿了');
    await expect(
      service.put(log, { messageId: 'm-first', rating: 'positive', ifVersion: null }),
    ).rejects.toThrow('磁碟滿了');
    // 收回不存在的也要確認（dsh `:214`），所以同樣被拒。
    await expect(service.delete(log, { messageId: 'm-goal', ifVersion: 'x' })).rejects.toThrow(
      '磁碟滿了',
    );
    expect(await service.record(log, { text: '慢' })).toEqual({
      ok: true,
      value: { recorded: true },
    });
  });

  it('沒掛落盤：list／put／delete 拋「評分存不住」、日誌不動；評語照常（#1606 題 2 (a)）', async () => {
    const { log } = logWithTurns();
    durable = false;
    const before = log.events.length;
    for (const call of [
      () => service.list(log),
      () => service.put(log, { messageId: 'm-first', rating: 'positive', ifVersion: null }),
      () => service.delete(log, { messageId: 'm-first', ifVersion: 'x' }),
    ]) {
      await expect(call()).rejects.toThrow(FeedbackDurabilityUnavailableError);
      await expect(call()).rejects.toThrow('這個組裝沒有掛落盤，評分存不住');
    }
    expect(log.events).toHaveLength(before);
    expect(await service.record(log, { text: '慢' })).toEqual({
      ok: true,
      value: { recorded: true },
    });
  });
});

describe('重放驗證（#1606）', () => {
  const good = {
    messageId: 'm-first',
    rating: 'positive',
    version: V_OLD,
    createdAt: 1,
    updatedAt: 2,
  };
  const corrupt: readonly [string, unknown][] = [
    ['評分不是兩種之一', { item: { ...good, rating: 'meh' } }],
    ['更新早於建立', { item: { ...good, createdAt: 3, updatedAt: 2 } }],
    ['備註全是空白', { item: { ...good, note: '  ' } }],
    ['分類不在七類內', { item: { ...good, category: 'mood' } }],
    ['版本不是 uuid', { item: { ...good, version: 'v1' } }],
    ['時間戳是負的', { item: { ...good, createdAt: -1 } }],
    ['沒有目標', { item: { rating: 'positive', version: V_OLD, createdAt: 1, updatedAt: 2 } }],
  ];

  for (const [name, data] of corrupt) {
    it(`put 事件${name}：list、put、delete 都拋，不折進畫面`, async () => {
      const { log } = logWithTurns();
      log.append('feedback/message-put', data as never);
      await expect(service.list(log)).rejects.toThrow(FeedbackLogCorruptionError);
      await expect(
        service.put(log, { messageId: 'm-goal', rating: 'positive', ifVersion: null }),
      ).rejects.toThrow(FeedbackLogCorruptionError);
      await expect(service.delete(log, { messageId: 'm-goal', ifVersion: 'any' })).rejects.toThrow(
        FeedbackLogCorruptionError,
      );
      expect(checkpoints).toEqual([]);
    });
  }

  it('delete 事件沒有目標也拋，訊息指名哪一顆', async () => {
    const { log } = logWithTurns();
    const seq = log.append('feedback/message-delete', { messageId: '' }).seq;
    await expect(service.list(log)).rejects.toThrow(`第 ${String(seq)} 顆 feedback/message-delete`);
  });

  it('合規的兩種格式都過：新的以回覆記、舊的以輪記（含舊格式的收回）', async () => {
    const { log, first, second } = logWithTurns();
    log.append('feedback/message-put', { item: { ...good, messageId: 'm-goal' } } as never);
    log.append('feedback/message-put', {
      item: { turn: first, rating: 'negative', version: V_GOAL, createdAt: 1, updatedAt: 1 },
    });
    log.append('feedback/message-delete', { turn: second });
    expect(await service.list(log)).toMatchObject({
      ok: true,
      value: { items: [{ messageId: 'm-first' }] },
    });
  });
});

describe('設定', () => {
  // **服務那一支自己留著執行期檢查**：它是一支獨立的 API（`apps/harness` 有測試直接叫它），
  // 而 schema 只守 plugin 那條路。兩條路都要擋得住。
  it('maxNoteBytes 不是正的安全整數就拒絕（服務那一支）', async () => {
    for (const maxNoteBytes of [0, -1, 1.5, Number.NaN]) {
      expect(() => createFeedbackService({ maxNoteBytes }, () => durability)).toThrow(TypeError);
    }
  });

  it('maxNoteBytes 不是正的安全整數就讓載入失敗（#453：驗在載入的時候）', async () => {
    for (const maxNoteBytes of [0, -1, 1.5, Number.NaN]) {
      expect(() => feedback.Config.parse({ maxNoteBytes })).toThrow();
    }
  });

  it('必填：一格都不給也是載入失敗，沒有預設值（照 dsh 的 `required()`）', async () => {
    expect(() => feedback.Config.parse({})).toThrow(/maxNoteBytes/);
  });

  it('未知欄位讓載入失敗（登記的偏離：dsh 放行）', async () => {
    expect(() => feedback.Config.parse({ maxNoteBytes: 8, maxNotBytes: 8 })).toThrow(/maxNotBytes/);
  });
});

/** 一棵只有命令登記處的樹，上面掛 feedback（設定可換）；回傳登記處的把手與樹上取得的服務。 */
async function mount(
  config: unknown = { maxNoteBytes: 8192 },
  row = 'feedback',
  withDurability = true,
) {
  const commands = createCommandsProvider();
  const root = new Context();
  await root.plugin(Loader);
  Object.assign(root.loader.builtins, {
    commands: commands.Provider,
    'session-durability': createSessionDurabilityProvider(durability.checkpoint),
    feedback,
  });
  await root.loader.create({ id: 'commands', name: 'cordis:commands' } as never, null);
  if (withDurability) {
    await root.loader.create(
      { id: 'session-durability', name: 'cordis:session-durability' } as never,
      null,
    );
  }
  await root.loader.create({ id: row, name: 'cordis:feedback', config } as never, null);
  await root.loader.await();
  return {
    root,
    commands,
    service: root.get(feedbackToken.name) as
      (FeedbackService & { provider: string; contractVersion: string }) | undefined,
    dispose: () => root.fiber.dispose(),
  };
}

describe('一致性套件：真的提供者、真的 Loader', () => {
  it('feedback 全格通過：manifest、匯出形式、載入→卸載後命令與服務都撤掉、缺 commands 停在 PENDING', async () => {
    let latest = createCommandsProvider();
    const failures = await checkConformance({
      row: 'feedback',
      module: feedback,
      config: { maxNoteBytes: 8192 },
      providers: {
        commands: () => {
          latest = createCommandsProvider();
          return latest.Provider;
        },
      },
      residue: () => latest.registrations(),
    });
    expect(failures).toEqual([]);
  });
});

describe('掛上之後', () => {
  it('提供 messageFeedback 服務，歸屬是這一列、契約版本是定義套件的；命令登記在登記處，登記者是這一列', async () => {
    const run = await mount({ maxNoteBytes: 8192 }, 'feedback-row');
    try {
      expect(run.service?.provider).toBe('feedback-row');
      expect(run.service?.contractVersion).toBe(feedbackToken.version);
      expect(run.commands.entries().map((entry) => [entry.definition.name, entry.source])).toEqual([
        ['feedback', 'feedback-row'],
      ]);
    } finally {
      await run.dispose();
    }
  });

  it('**一次掛載一份服務**：兩棵樹各掛一次，兩邊的上限各自算各自的', async () => {
    const small = await mount({ maxNoteBytes: 4 });
    const large = await mount({ maxNoteBytes: 4096 });
    try {
      expect(small.service).toBeDefined();
      expect(large.service).toBeDefined();
      const log = new SessionLog('限額');
      const note = 'x'.repeat(100);
      expect(
        await small.service!.put(log, {
          messageId: '無',
          rating: 'positive',
          note,
          ifVersion: null,
        }),
      ).toMatchObject({ ok: false, error: { code: 'note-too-large', maxBytes: 4 } });
      // 大的那一份走到下一關（目標訊息不存在），代表它沒有被小的那個上限擋下來。
      expect(
        await large.service!.put(log, {
          messageId: '無',
          rating: 'positive',
          note,
          ifVersion: null,
        }),
      ).toMatchObject({ ok: false, error: { code: 'target-not-found' } });
    } finally {
      await small.dispose();
      await large.dispose();
    }
  });

  it('宿主沒提供落盤確認：這一列照樣掛、/feedback 照樣登記；評分在呼叫當下拒（每次呼叫才讀）', async () => {
    const run = await mount({ maxNoteBytes: 8192 }, 'feedback', false);
    try {
      expect(run.service).toBeDefined();
      expect(run.commands.entries().map((entry) => entry.definition.name)).toEqual(['feedback']);
      const { log } = logWithTurns();
      await expect(
        run.service!.put(log, { messageId: 'm-first', rating: 'positive', ifVersion: null }),
      ).rejects.toThrow(FeedbackDurabilityUnavailableError);
      // 之後才提供：不重掛，下一次呼叫就讀得到。
      await run.root.loader.create(
        { id: 'session-durability', name: 'cordis:session-durability' } as never,
        null,
      );
      await run.root.loader.await();
      expect(
        (await run.service!.put(log, { messageId: 'm-first', rating: 'positive', ifVersion: null }))
          .ok,
      ).toBe(true);
      expect(checkpoints).toEqual([log]);
    } finally {
      await run.dispose();
    }
  });

  it('這一列卸載之後，宿主手上的快照照樣能評分，落盤確認照樣讀得到（檔頭「宿主取的是快照」）', async () => {
    const run = await mount();
    try {
      const snapshot = run.service!;
      await run.root.loader.remove('feedback');
      await run.root.loader.await();
      expect(run.root.get(feedbackToken.name)).toBeUndefined();
      const { log } = logWithTurns();
      expect(
        (await snapshot.put(log, { messageId: 'm-first', rating: 'positive', ifVersion: null })).ok,
      ).toBe(true);
      expect(checkpoints).toEqual([log]);
    } finally {
      await run.dispose();
    }
  });

  it('設定驗不過：那一列起不來，服務與命令都沒有登記', async () => {
    const run = await mount({ maxNoteBytes: 0 });
    try {
      expect(run.service).toBeUndefined();
      expect(run.commands.registrations()).toBe(0);
    } finally {
      await run.dispose();
    }
  });

  it('列卸下之後：服務與命令都撤掉，但卸下前取到的那份仍能呼叫（宿主的快照，不碰 this.ctx）', async () => {
    const run = await mount({ maxNoteBytes: 16 });
    try {
      const snapshot = run.service!;
      const entry = run.root.loader.resolve('feedback');
      await entry.update({ disabled: true } as never);
      await run.root.loader.await();
      expect(run.root.get(feedbackToken.name)).toBeUndefined();
      expect(run.commands.registrations()).toBe(0);
      const { log } = logWithTurns();
      expect(
        (await snapshot.put(log, { messageId: 'm-first', rating: 'positive', ifVersion: null })).ok,
      ).toBe(true);
      expect(await snapshot.list(log)).toMatchObject({
        ok: true,
        value: { items: [{ messageId: 'm-first' }] },
      });
    } finally {
      await run.dispose();
    }
  });
});

describe('/feedback', () => {
  async function command() {
    const run = await mount({ maxNoteBytes: 8192 });
    const found = run.commands.entries().find((entry) => entry.definition.name === 'feedback');
    if (found === undefined) throw new Error('沒登記 /feedback');
    return { run, definition: found.definition };
  }
  const invoke = (rawInput: string, sessionLog: SessionLog) => ({
    commandId: 'c1',
    rawInput,
    signal: new AbortController().signal,
    sessionLog,
    attachments: [],
    steer: () => undefined,
  });

  it('空字串回用法說明、不記；recordInput 是 false', async () => {
    const { run, definition } = await command();
    try {
      expect(definition.recordInput).toBe(false);
      const log = new SessionLog('feedback-root');
      expect(await definition.handler(invoke('   ', log))).toEqual({
        kind: 'error',
        text: FEEDBACK_USAGE,
      });
      expect(log.events.filter((event) => event.type === 'feedback/record')).toEqual([]);
    } finally {
      await run.dispose();
    }
  });

  it('記在執行器交來的那份日誌上（#688）', async () => {
    const { run, definition } = await command();
    try {
      const log = new SessionLog('feedback-root');
      expect(await definition.handler(invoke('回答錯了', log))).toEqual({
        kind: 'success',
        text: '已記下對這個會話的回饋（feedback-root）。',
      });
      expect(log.events.filter((event) => event.type === 'feedback/record')).toHaveLength(1);
    } finally {
      await run.dispose();
    }
  });
});

describe('相依關係', () => {
  it('src 不 import @nexus/core；沒有 default 匯出；相依只有 SDK、cordis、@nexus/commands、@nexus/feedback、@nexus/session', async () => {
    const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(read('./index.ts')).not.toMatch(/from '@nexus\/core'/u);
    expect('default' in feedback).toBe(false);
    const pkg = JSON.parse(read('../package.json')) as {
      dependencies?: Record<string, string>;
      peerDependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['zod']);
    expect(Object.keys(pkg.peerDependencies).sort()).toEqual(
      [
        '@nexus/commands',
        '@nexus/cordis',
        '@nexus/feedback',
        '@nexus/sdk',
        '@nexus/session',
      ].sort(),
    );
  });
});
