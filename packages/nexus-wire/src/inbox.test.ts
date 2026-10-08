/**
 * 送出佇列的 `custom` frame 怎麼折（[#637](https://github.com/DemianLi/nexus-agent/issues/637)）。
 *
 * 產出 frame 的那一半在 `apps/harness/src/send-queue.test.ts`；這裡只管折疊器：清單整份換掉、`claimed` 折出人的話
 * 而且不畫兩次、形狀不對整顆不收、往前翻頁不動它。
 */

import { describe, expect, it } from 'vitest';

import {
  emptyConversation,
  prependEntries,
  reduceAll,
  reduceConversation,
} from './conversation.js';
import { AGENT_MESSAGE, INBOX, SETTLE_NOTICE } from './inbox.js';
import type { Event } from './protocol.js';

let seq = 0;
function frame(method: string, data: unknown, namespace: readonly string[] = []): Event {
  const current = seq++;
  return {
    type: 'event',
    seq: current,
    event_id: `i:${current}`,
    method,
    params: { namespace, timestamp: 0, data },
  } as Event;
}

const inboxFrame = (payload: unknown): Event => frame('custom', { name: INBOX, payload });

const first = { id: 'run-a', text: '先讀設定', source: { kind: 'user' } } as const;
const second = { id: 'run-b', text: '再改程式', source: { kind: 'user' } } as const;

const fold = (...frames: Event[]) => reduceAll(emptyConversation(), frames);

describe('inbox', () => {
  it('一顆都沒有是空的', () => {
    expect(emptyConversation().inbox).toEqual([]);
  });

  it('清單整份換掉，只帶認得的欄位', () => {
    expect(fold(inboxFrame({ items: [first, second] })).inbox).toEqual([first, second]);
    expect(
      fold(inboxFrame({ items: [first, second] }), inboxFrame({ items: [second] })).inbox,
    ).toEqual([second]);
    expect(fold(inboxFrame({ items: [first] }), inboxFrame({ items: [] })).inbox).toEqual([]);
    expect(
      fold(inboxFrame({ items: [{ ...first, extra: 1, source: { kind: 'user', x: 2 } }] })).inbox,
    ).toEqual([first]);
  });

  it('沒帶 claimed 不畫人的話（歷史那一顆就是這樣）', () => {
    const state = fold(inboxFrame({ items: [first] }));
    expect(state.entries).toEqual([]);
    expect(state.status).toBe('idle');
  });

  it('帶 claimed 的那一顆折出一則人的話，文字用開跑用的那份，status 不動', () => {
    const state = fold(
      inboxFrame({ items: [first, second] }),
      inboxFrame({ items: [second], claimed: { id: first.id, text: '先讀設定（改過）' } }),
    );
    expect(state.inbox).toEqual([second]);
    expect(state.entries).toEqual([
      { kind: 'human', id: `inbox:${first.id}`, text: '先讀設定（改過）', inboxId: first.id },
    ]);
    expect(state.status).toBe('idle');
  });

  it('同一顆 claimed 再到一次不畫第二次；另一件開跑再畫一則', () => {
    const claimFirst = { items: [second], claimed: { id: first.id, text: first.text } };
    const state = fold(
      inboxFrame(claimFirst),
      inboxFrame(claimFirst),
      inboxFrame({ items: [], claimed: { id: second.id, text: second.text } }),
    );
    expect(state.entries.map((entry) => entry.id)).toEqual([
      `inbox:${first.id}`,
      `inbox:${second.id}`,
    ]);
    expect(state.inbox).toEqual([]);
  });

  it('形狀不對整顆不收：不換清單、不畫人的話', () => {
    const bad: unknown[] = [
      {},
      { items: 'x' },
      { items: [null] },
      { items: [{ ...first, text: 1 }] },
      { items: [{ id: 'run-c', text: '目標續行' }] },
      // 用另一件的 id：拿 `first` 改的話，正規化之後跟原本那份長得一樣，比不出有沒有收。
      { items: [{ ...second, source: { kind: 'goal' } }] },
      { items: [], claimed: null },
      { items: [], claimed: { id: first.id } },
      { items: [], claimed: { id: 1, text: first.text } },
    ];
    for (const payload of bad) {
      const state = fold(inboxFrame({ items: [first] }), inboxFrame(payload));
      expect(state.inbox).toEqual([first]);
      expect(state.entries).toEqual([]);
    }
  });

  it('開跑那一輪：人的話在回覆之前，收尾照常標在回覆上', () => {
    const state = fold(
      inboxFrame({ items: [], claimed: { id: first.id, text: first.text } }),
      frame('lifecycle', { event: 'running', graph_name: 'root' }),
      frame('messages', { event: 'message-start', id: 'run-r1', run_id: 'r1' }, [
        'model_request:1',
      ]),
      frame(
        'messages',
        {
          event: 'content-block-delta',
          index: 0,
          delta: { type: 'text-delta', text: '讀完了' },
          run_id: 'r1',
        },
        ['model_request:1'],
      ),
      frame('messages', { event: 'message-finish', reason: 'stop', run_id: 'r1' }, [
        'model_request:1',
      ]),
      frame('lifecycle', { event: 'completed', graph_name: 'root' }),
    );
    expect(state.entries.map((entry) => entry.kind)).toEqual(['human', 'ai']);
    expect(state.entries[1]).toMatchObject({ text: '讀完了', turnTail: true });
    expect(state.status).toBe('idle');
  });

  describe('一律接在最後，不認領前面的人話', () => {
    // 送出當下先畫一則、`claimed` 到了再認領它的那條過渡路已經收掉（#645 之後畫面不先畫）。這兩條守的是它沒有回來。
    const claim = (id: string, text: string) => inboxFrame({ items: [], claimed: { id, text } });

    it('前面有沒帶 inboxId 的人話（歷史重播的那種）：另畫一則，前面那則原樣', () => {
      const replayed = reduceAll(emptyConversation(), [
        frame('messages', { event: 'message-start', role: 'human', id: 'run-h', run_id: 'h' }),
      ]);
      const state = reduceConversation(replayed, claim(first.id, 'A'));
      expect(state.entries).toEqual([
        { kind: 'human', id: 'h', text: '' },
        { kind: 'human', id: `inbox:${first.id}`, text: 'A', inboxId: first.id },
      ]);
    });

    it('同一句話跑兩次是兩件：兩則都畫', () => {
      const state = fold(claim(first.id, '再跑一次'), claim(second.id, '再跑一次'));
      expect(state.entries.map((entry) => entry.id)).toEqual([
        `inbox:${first.id}`,
        `inbox:${second.id}`,
      ]);
    });
  });

  it('往前翻頁不動它：那是「現在」的事', () => {
    const now = fold(inboxFrame({ items: [first] }));
    const earlier = fold(inboxFrame({ items: [second] }));
    expect(prependEntries(now, earlier).inbox).toEqual([first]);
  });

  describe('插話那一條（#710）', () => {
    it('一顆都沒有是空的；nextStep 整份換掉，沒帶就是空的', () => {
      expect(emptyConversation().inboxNextStep).toEqual([]);
      const state = fold(inboxFrame({ items: [first], nextStep: [second] }));
      expect(state.inbox).toEqual([first]);
      expect(state.inboxNextStep).toEqual([second]);
      expect(
        fold(inboxFrame({ items: [], nextStep: [second] }), inboxFrame({ items: [] }))
          .inboxNextStep,
      ).toEqual([]);
    });

    it('claimedNextStep 照順序折出人的話，同一顆再到一次不畫第二次', () => {
      const claim = inboxFrame({
        items: [],
        nextStep: [],
        claimedNextStep: [
          { id: first.id, text: first.text },
          { id: second.id, text: second.text },
        ],
      });
      const state = fold(
        claim,
        inboxFrame({ items: [], claimedNextStep: [{ id: first.id, text: first.text }] }),
      );
      expect(state.entries).toEqual([
        { kind: 'human', id: `inbox:${first.id}`, text: first.text, inboxId: first.id },
        { kind: 'human', id: `inbox:${second.id}`, text: second.text, inboxId: second.id },
      ]);
    });

    it('引用別的會話的話帶 references（#713）：claimed 與 claimedNextStep 都折進人的話；沒有就不帶這一格', () => {
      const references = [{ sessionId: 'a', label: '甲' }];
      const state = fold(
        inboxFrame({
          items: [],
          claimed: { id: first.id, text: '看 @甲', references },
          claimedNextStep: [
            { id: second.id, text: '再看 @甲', references: [] },
            { id: 'run-c', text: '沒有引用' },
          ],
        }),
      );
      expect(state.entries).toEqual([
        { kind: 'human', id: `inbox:${first.id}`, text: '看 @甲', inboxId: first.id, references },
        // 空陣列與沒給是同一件事，不讓兩種長相並存。
        { kind: 'human', id: `inbox:${second.id}`, text: '再看 @甲', inboxId: second.id },
        { kind: 'human', id: 'inbox:run-c', text: '沒有引用', inboxId: 'run-c' },
      ]);
    });

    it('references 形狀不對：整顆不收，同其他欄位', () => {
      const before = fold(inboxFrame({ items: [first] }));
      for (const references of ['x', [{ sessionId: 'a' }], [{ label: '甲' }], [null]]) {
        const after = reduceConversation(
          before,
          inboxFrame({ items: [], claimed: { id: 'z', text: 't', references } }),
        );
        expect([after.inbox, after.entries]).toEqual([before.inbox, before.entries]);
      }
    });

    it('歷史重播的人話（message-start）帶 references 就掛上；壞的當沒有，人話照畫', () => {
      const start = (extra: object) =>
        frame('messages', { event: 'message-start', role: 'human', id: 'history-1', ...extra });
      const references = [{ sessionId: 'a', label: '甲' }];
      expect(fold(start({ references })).entries).toEqual([
        { kind: 'human', id: 'history-1', text: '', references },
      ]);
      expect(fold(start({})).entries).toEqual([{ kind: 'human', id: 'history-1', text: '' }]);
      expect(fold(start({ references: 'x' })).entries).toEqual([
        { kind: 'human', id: 'history-1', text: '' },
      ]);
    });

    describe('附件參照（#732）', () => {
      const sha = (c: string) => `sha256:${c.repeat(64)}`;
      const file = { type: 'file', attachmentId: sha('a'), name: 'notes.txt', bytes: 12 } as const;
      const image = {
        type: 'image',
        attachmentId: sha('b'),
        mediaType: 'image/png',
        bytes: 345,
        width: 10,
        height: 20,
        name: 'shot.png',
      } as const;
      const { name: _shot, ...unnamed } = image;

      it('claimed 與 claimedNextStep 的 attachments 折進人的話，照選取順序；空陣列與沒給一樣不帶這一格', () => {
        const state = fold(
          inboxFrame({
            items: [],
            claimed: { id: first.id, text: '', attachments: [image, file] },
            claimedNextStep: [
              { id: second.id, text: '再看', attachments: [] },
              { id: 'run-c', text: '沒附件' },
              { id: 'run-d', text: '只有圖', attachments: [unnamed] },
            ],
          }),
        );
        expect(state.entries).toEqual([
          {
            kind: 'human',
            id: `inbox:${first.id}`,
            text: '',
            inboxId: first.id,
            attachments: [image, file],
          },
          { kind: 'human', id: `inbox:${second.id}`, text: '再看', inboxId: second.id },
          { kind: 'human', id: 'inbox:run-c', text: '沒附件', inboxId: 'run-c' },
          {
            kind: 'human',
            id: 'inbox:run-d',
            text: '只有圖',
            inboxId: 'run-d',
            attachments: [unnamed],
          },
        ]);
      });

      it('只留認得的欄位，不把多出來的東西轉手', () => {
        const state = fold(
          inboxFrame({
            items: [],
            claimed: { id: first.id, text: 't', attachments: [{ ...file, secret: 'x' }] },
          }),
        );
        expect(state.entries).toEqual([
          {
            kind: 'human',
            id: `inbox:${first.id}`,
            text: 't',
            inboxId: first.id,
            attachments: [file],
          },
        ]);
      });

      it('排著的件（items／nextStep）的 attachments 帶進 state.inbox 與 state.inboxNextStep；空陣列不帶', () => {
        const state = fold(
          inboxFrame({
            items: [
              { ...first, attachments: [file, image] },
              { ...second, attachments: [] },
              { id: 'q-none', text: '沒附件', source: { kind: 'user' } },
            ],
            nextStep: [{ id: 'q-step', text: '', source: { kind: 'user' }, attachments: [image] }],
          }),
        );
        expect(state.inbox).toEqual([
          { id: first.id, text: first.text, source: { kind: 'user' }, attachments: [file, image] },
          { id: second.id, text: second.text, source: { kind: 'user' } },
          { id: 'q-none', text: '沒附件', source: { kind: 'user' } },
        ]);
        expect(state.inboxNextStep).toEqual([
          { id: 'q-step', text: '', source: { kind: 'user' }, attachments: [image] },
        ]);
      });

      it('排著的件 attachments 形狀不對：整顆不收（items 與 nextStep 都是）', () => {
        const before = fold(inboxFrame({ items: [first] }));
        for (const bad of ['x', [null], [{ ...file, bytes: -1 }]]) {
          for (const payload of [
            { items: [{ ...second, attachments: bad }] },
            { items: [], nextStep: [{ ...second, attachments: bad }] },
          ]) {
            const after = reduceConversation(before, inboxFrame(payload));
            expect([after.inbox, after.entries], JSON.stringify(payload)).toEqual([
              before.inbox,
              before.entries,
            ]);
          }
        }
      });

      it('形狀不對：整顆不收，同 references', () => {
        const before = fold(inboxFrame({ items: [first] }));
        for (const attachments of [
          'x',
          [null],
          [{ type: 'file', attachmentId: sha('a'), bytes: 1 }],
          [{ ...file, name: '' }],
          [{ ...file, bytes: -1 }],
          [{ ...file, bytes: 1.5 }],
          [{ ...file, attachmentId: '' }],
          [{ ...image, mediaType: 'image/bmp' }],
          [{ ...image, width: 'x' }],
          [{ ...image, name: 3 }],
          [{ ...file, type: 'audio' }],
          [file, { type: 'image' }],
        ]) {
          const after = reduceConversation(
            before,
            inboxFrame({ items: [], claimed: { id: 'z', text: 't', attachments } }),
          );
          expect([after.inbox, after.entries], JSON.stringify(attachments)).toEqual([
            before.inbox,
            before.entries,
          ]);
        }
      });

      it('歷史重播的人話（message-start）帶 attachments 就掛上；壞的當沒有，人話照畫', () => {
        const start = (extra: object) =>
          frame('messages', { event: 'message-start', role: 'human', id: 'history-1', ...extra });
        expect(fold(start({ attachments: [file, image] })).entries).toEqual([
          { kind: 'human', id: 'history-1', text: '', attachments: [file, image] },
        ]);
        expect(fold(start({ attachments: [] })).entries).toEqual([
          { kind: 'human', id: 'history-1', text: '' },
        ]);
        for (const attachments of ['x', [null], [{ ...file, bytes: 'x' }]]) {
          expect(fold(start({ attachments })).entries).toEqual([
            { kind: 'human', id: 'history-1', text: '' },
          ]);
        }
      });
    });

    it('形狀不對整顆不收', () => {
      const before = fold(inboxFrame({ items: [first], nextStep: [second] }));
      for (const payload of [
        { items: [], nextStep: 'x' },
        { items: [], nextStep: [{ id: 1 }] },
        { items: [], claimedNextStep: { id: 'a', text: 'b' } },
        { items: [], claimedNextStep: [{ id: 'a' }] },
      ]) {
        const after = reduceConversation(before, inboxFrame(payload));
        expect([after.inbox, after.inboxNextStep, after.entries]).toEqual([
          before.inbox,
          before.inboxNextStep,
          before.entries,
        ]);
      }
    });
  });
});

describe('inbox：背景子代理的結算通知不是人話（#840）', () => {
  const notice = {
    id: 'run-n',
    text: 'Background subagent bg-1 finished',
    source: { kind: 'subagent-settled' },
  } as const;

  it('排著的通知照收，來源的判別欄留著，畫面能分出它不是人送的', () => {
    const state = fold(inboxFrame({ items: [first, notice], nextStep: [notice] }));
    expect(state.inbox).toEqual([first, notice]);
    expect(state.inboxNextStep).toEqual([notice]);
  });

  it('領走的通知（claimed／claimedNextStep 帶 source）不畫人的泡泡，改長一格通知；沒帶 source 的照舊是人', () => {
    const claimedNotice = { id: 'run-n', text: '通知', source: { kind: 'subagent-settled' } };
    const notice = {
      kind: 'notice',
      id: 'inbox:run-n',
      source: 'subagent-settled',
      inboxId: 'run-n',
    };
    // 通知不帶文字：給模型的英文不上畫面。
    expect(fold(inboxFrame({ items: [], claimed: claimedNotice })).entries).toEqual([notice]);
    expect(
      fold(inboxFrame({ items: [], nextStep: [], claimedNextStep: [claimedNotice] })).entries,
    ).toEqual([notice]);
    const human = fold(inboxFrame({ items: [], claimed: { id: 'run-a', text: '嗨' } }));
    expect(human.entries.map((entry) => entry.kind)).toEqual(['human']);
  });

  it('同一顆裡人與通知並存：只畫人的', () => {
    const state = fold(
      inboxFrame({
        items: [],
        nextStep: [],
        claimedNextStep: [
          { id: 'run-a', text: '人的話' },
          { id: 'run-n', text: '通知', source: { kind: 'subagent-settled' } },
        ],
      }),
    );
    // 順序照領走的先後：人的話在前、通知在後。
    expect(
      state.entries.map((entry) => (entry.kind === 'human' ? entry.text : entry.kind)),
    ).toEqual(['人的話', 'notice']);
  });

  it('同一顆 claimed 再到一次不長第二格通知（靠 inboxId 去重）', () => {
    const claimedNotice = { id: 'run-n', text: '通知', source: { kind: 'subagent-settled' } };
    const once = fold(inboxFrame({ items: [], claimed: claimedNotice }));
    const twice = reduceConversation(once, inboxFrame({ items: [], claimed: claimedNotice }));
    expect(twice.entries.filter((entry) => entry.kind === 'notice')).toHaveLength(1);
  });

  it('歷史重播的 SETTLE_NOTICE：長同一種通知，id 就是給的 id；同一個 id 只長一格，壞形狀略過', () => {
    const frame = (payload: unknown) => ({
      type: 'event' as const,
      seq: 0,
      method: 'custom' as const,
      params: { namespace: [], timestamp: 0, data: { name: SETTLE_NOTICE, payload } },
    });
    const once = reduceConversation(emptyConversation(), frame({ id: 'history-7' }) as never);
    expect(once.entries).toEqual([{ kind: 'notice', id: 'history-7', source: 'subagent-settled' }]);
    const again = reduceConversation(once, frame({ id: 'history-7' }) as never);
    expect(again.entries).toHaveLength(1);
    for (const bad of [{}, { id: 7 }, { id: '' }]) {
      expect(reduceConversation(once, frame(bad) as never)).toBe(once);
    }
  });

  describe('子代理寫來的話（agent-message，#849、#863）', () => {
    const relay = { id: 'run-m', text: '三個檔案看過了', source: { kind: 'agent-message' } };
    const claimedRelay = {
      id: 'run-m',
      text: '三個檔案看過了',
      source: { kind: 'agent-message', senderSessionId: 'root/bg-1', runId: 'bg-1' },
    };

    it('排著照收；領走長一格「某某說」，不是人的泡泡', () => {
      const queued = fold(inboxFrame({ items: [first, relay], nextStep: [relay] }));
      expect(queued.inbox).toEqual([first, relay]);
      expect(queued.inboxNextStep).toEqual([relay]);
      const expected = {
        kind: 'agent-message',
        id: 'inbox:run-m',
        senderSessionId: 'root/bg-1',
        runId: 'bg-1',
        text: '三個檔案看過了',
        inboxId: 'run-m',
      };
      expect(fold(inboxFrame({ items: [], claimed: claimedRelay })).entries).toEqual([expected]);
      expect(
        fold(inboxFrame({ items: [], nextStep: [], claimedNextStep: [claimedRelay] })).entries,
      ).toEqual([expected]);
    });

    it('同一顆 claimed 再到一次不畫第二次', () => {
      const twice = fold(
        inboxFrame({ items: [], claimed: claimedRelay }),
        inboxFrame({ items: [], claimed: claimedRelay }),
      );
      expect(twice.entries).toHaveLength(1);
    });

    it('寄件人缺了整顆不收：不能悄悄畫成人話', () => {
      const before = fold(inboxFrame({ items: [first] }));
      for (const source of [
        { kind: 'agent-message' },
        { kind: 'agent-message', senderSessionId: 'root/bg-1' },
        { kind: 'agent-message', runId: 'bg-1' },
        { kind: 'agent-message', senderSessionId: 7, runId: 'bg-1' },
      ]) {
        const after = reduceConversation(
          before,
          inboxFrame({ items: [], claimed: { id: 'run-m', text: '嗨', source } }),
        );
        expect(after.entries).toEqual(before.entries);
        expect(after.inbox).toEqual(before.inbox);
      }
    });

    it('歷史重播的 AGENT_MESSAGE：長同一種項目，id 就是給的 id；同一個 id 只長一格，壞形狀略過', () => {
      const payload = {
        id: 'history-9',
        senderSessionId: 'root/bg-1',
        runId: 'bg-1',
        text: '三個檔案看過了',
      };
      const record = (data: unknown) => frame('custom', { name: AGENT_MESSAGE, payload: data });
      const once = fold(record(payload));
      expect(once.entries).toEqual([{ kind: 'agent-message', ...payload }]);
      expect(fold(record(payload), record(payload)).entries).toHaveLength(1);
      for (const bad of [
        {},
        { ...payload, id: '' },
        { ...payload, runId: undefined },
        { ...payload, senderSessionId: 3 },
        { ...payload, text: undefined },
      ]) {
        expect(reduceConversation(once, record(bad) as never).entries).toEqual(once.entries);
      }
    });
  });

  it('認不得的來源整顆不收', () => {
    const before = fold(inboxFrame({ items: [first] }));
    const after = reduceConversation(
      before,
      inboxFrame({ items: [{ ...first, source: { kind: 'someone-else' } }] }),
    );
    expect(after.inbox).toEqual(before.inbox);
  });
});
