/**
 * `referencedImage`（[#733](https://github.com/DemianLi/nexus-agent/issues/733)）：讀圖路由的授權依據，逐種事件認得參照出現的地方。
 * 端到端（真的 handler 與 client）在 `attachment-wire.test.ts` 的「讀圖路由」。
 */

import type { SessionEvent } from '@nexus/core';
import { describe, expect, it } from 'vitest';

import { referencedImage } from './attachment-reference.js';

const sha = (c: string) => `sha256:${c.repeat(64)}`;
const image = (c: string) =>
  ({
    type: 'image',
    attachmentId: sha(c),
    mediaType: 'image/png',
    bytes: 3,
    width: 1,
    height: 1,
  }) as const;
const { type: _t, ...bare } = image('a');

const event = (type: string, data: unknown): SessionEvent =>
  ({ type, seq: 0, time: 0, data }) as unknown as SessionEvent;
const message = (content: unknown) => ({ type: 'human', data: { content } });
const block = (c: string) => ({
  type: 'nexus-image',
  attachment: { ...image(c), type: undefined },
});

describe('referencedImage', () => {
  it('turn/start（kind message）的 attachments：回不含 type 的參照；檔案參照與別的 id 不算', () => {
    const events = [
      event('turn/start', {
        kind: 'message',
        text: 't',
        attachments: [
          { type: 'file', attachmentId: sha('a'), name: 'a.txt', bytes: 1 },
          image('b'),
          image('a'),
        ],
      }),
    ];
    expect(referencedImage(events, sha('a'))).toEqual(bare);
    expect(referencedImage(events, sha('c'))).toBeUndefined();
    // 同一個 id 只以檔案出現：不是圖。
    expect(
      referencedImage(
        [
          event('turn/start', {
            kind: 'message',
            text: 't',
            attachments: [{ type: 'file', attachmentId: sha('f'), name: 'a.txt', bytes: 1 }],
          }),
        ],
        sha('f'),
      ),
    ).toBeUndefined();
  });

  it('inbox/spliced 排著的件（被取消的也算：人確實送過它）', () => {
    const events = [
      event('inbox/spliced', {
        target: 'next-turn',
        start: 0,
        inserted: [{ id: 'q', text: '', source: { kind: 'user' }, attachments: [image('a')] }],
      }),
    ];
    expect(referencedImage(events, sha('a'))).toEqual(bare);
  });

  it('user/message、tool/result、assistant/message 的 nexus-image 區塊', () => {
    for (const [type, data] of [
      ['user/message', { message: message([block('a')]) }],
      ['tool/result', { callId: 'c', isError: false, message: message([block('a')]) }],
      ['assistant/message', { message: message([{ type: 'text', text: 'x' }, block('a')]) }],
    ] as const) {
      expect(referencedImage([event(type, data)], sha('a')), type).toMatchObject({
        attachmentId: sha('a'),
      });
      expect(referencedImage([event(type, data)], sha('b')), type).toBeUndefined();
    }
  });

  it('沒有引用、其他種事件、內容是字串、沒有 message 的 tool/result：undefined，不拋', () => {
    expect(referencedImage([], sha('a'))).toBeUndefined();
    expect(
      referencedImage(
        [
          event('turn/start', { kind: 'resume' }),
          event('user/message', { message: message('純字串') }),
          event('tool/result', { callId: 'c', isError: true }),
          event('compaction/summary', { summary: 'x' }),
        ],
        sha('a'),
      ),
    ).toBeUndefined();
  });
});
