/**
 * `referencedImage`（[#733](https://github.com/DemianLi/nexus-agent/issues/733)）：讀圖路由的授權依據，逐種事件認得參照出現的地方。
 * 端到端（真的 handler 與 client）在 `attachment-wire.test.ts` 的「讀圖路由」。
 */

import type { SessionEvent } from '@nexus/core';
import { describe, expect, it } from 'vitest';

import {
  referencedAttachments,
  referencedFilePaths,
  referencedImage,
  referencesAttachment,
} from './attachment-reference.js';

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

const file = (c: string, name = 'a.txt') =>
  ({ type: 'file', attachmentId: sha(c), name, bytes: 1 }) as const;
const fileBlock = (c: string, name = 'a.txt') => {
  const { type: _type, ...ref } = file(c, name);
  return { type: 'nexus-file', attachment: ref };
};

describe('referencedAttachments／referencesAttachment／referencedFilePaths（#1773）', () => {
  it('逐種事件列出檔案與圖兩種參照，依出現順序、不去重', () => {
    const events = [
      event('turn/start', { kind: 'message', text: 't', attachments: [file('a'), image('b')] }),
      event('inbox/spliced', {
        target: 'next-turn',
        start: 0,
        inserted: [{ id: 'q', text: '', source: { kind: 'user' }, attachments: [file('a')] }],
      }),
      event('user/message', { message: message([fileBlock('c'), block('d')]) }),
      event('tool/result', { callId: 'c', isError: false, message: message([fileBlock('e')]) }),
      event('assistant/message', { message: message([fileBlock('f')]) }),
    ];
    expect(
      [...referencedAttachments(events)].map(
        (found) => `${found.kind}:${found.ref.attachmentId[7]}`,
      ),
    ).toEqual(['file:a', 'image:b', 'file:a', 'file:c', 'image:d', 'file:e', 'file:f']);
  });

  it('檔案要 attachmentId 與檔名都對上；圖只比 attachmentId；種類不同不算', () => {
    const events = [
      event('turn/start', { kind: 'message', text: 't', attachments: [file('a'), image('b')] }),
    ];
    expect(
      referencesAttachment(events, { kind: 'file', attachmentId: sha('a'), name: 'a.txt' }),
    ).toBe(true);
    expect(
      referencesAttachment(events, { kind: 'file', attachmentId: sha('a'), name: 'b.txt' }),
    ).toBe(false);
    expect(
      referencesAttachment(events, { kind: 'file', attachmentId: sha('b'), name: 'a.txt' }),
    ).toBe(false);
    expect(referencesAttachment(events, { kind: 'image', attachmentId: sha('b') })).toBe(true);
    expect(referencesAttachment(events, { kind: 'image', attachmentId: sha('a') })).toBe(false);
    expect(referencesAttachment([], { kind: 'image', attachmentId: sha('b') })).toBe(false);
  });

  it('referencedFilePaths：檔案換成 /前兩碼/hex/檔名；圖、壞雜湊、空檔名略過；同位元組不同檔名各一條', () => {
    const events = [
      event('turn/start', {
        kind: 'message',
        text: 't',
        attachments: [
          file('a'),
          file('a', 'other.txt'),
          image('b'),
          { type: 'file', attachmentId: 'sha256:zz', name: 'bad.txt', bytes: 1 },
          { type: 'file', attachmentId: sha('c'), name: '', bytes: 1 },
          null,
        ],
      }),
    ];
    const hex = 'a'.repeat(64);
    expect([...referencedFilePaths(events)].sort()).toEqual([
      `/aa/${hex}/a.txt`,
      `/aa/${hex}/other.txt`,
    ]);
    expect(referencedFilePaths([]).size).toBe(0);
  });
});
