/**
 * 組請求的投影直接看換完的 `content`（[#1566](https://github.com/DemianLi/nexus-agent/issues/1566) N0038）。
 *
 * `attachment-chat-openai.test.ts` 與 wire 那幾條看的是送上線的 HTTP body，中間隔著 `@langchain/openai` 的請求轉換：它會把
 * 內容區塊用 `flatMap` 攤平一層，所以投影就算回了巢狀陣列，線上照樣是平的。這裡不經轉換，巢狀、少一塊、順序錯都看得到。
 */

import { HumanMessage } from '@langchain/core/messages';
import {
  attachmentBlock,
  fileHandleText,
  fileModelPath,
  offloadedImageText,
  requestImageHandleText,
  textOnlyImageText,
  unavailableImageText,
} from '@nexus/core';
import { describe, expect, it } from 'vitest';

import { projectAttachments } from './attachment-projection.js';
import type { AttachmentSource } from './attachment-projection.js';
import { PNG_7X5 } from './image-fixtures.js';

const IMAGE = {
  attachmentId: `sha256:${'d'.repeat(64)}`,
  mediaType: 'image/png' as const,
  bytes: 75,
  width: 7,
  height: 5,
  name: 'shot.png',
};
const FILE = { attachmentId: `sha256:${'e'.repeat(64)}`, name: 'a.txt', bytes: 3 };
const VERSION = {
  data: new Uint8Array(Buffer.from(PNG_7X5, 'base64')),
  mediaType: 'image/png' as const,
  width: 7,
  height: 5,
};

function source(overrides: Partial<AttachmentSource> = {}): AttachmentSource {
  return { hasFile: async () => true, readRequestImage: async () => VERSION, ...overrides };
}

const message = (...blocks: readonly object[]) =>
  new HumanMessage({ content: [...blocks, { type: 'text', text: '請看' }] as never });

async function contentOf(
  blocks: readonly object[],
  src: AttachmentSource = source(),
  imageSupport: 'accepts' | 'rejects' | 'undeclared' = 'accepts',
): Promise<unknown> {
  const [projected] = await projectAttachments([message(...blocks)], src, imageSupport);
  return projected!.content;
}

describe('送出的圖：把手在前、圖在後，攤平在原位', () => {
  it('收圖的模型：[檔案那一行, 把手, image_url, 文字]，把手逐字等於 requestImageHandleText', async () => {
    const content = await contentOf([
      attachmentBlock({ type: 'file', ...FILE }),
      attachmentBlock({ type: 'image', ...IMAGE }),
    ]);
    expect(content).toEqual([
      { type: 'text', text: fileHandleText(FILE, fileModelPath(FILE)) },
      { type: 'text', text: requestImageHandleText(IMAGE) },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_7X5}` } },
      { type: 'text', text: '請看' },
    ]);
    expect(requestImageHandleText(IMAGE)).toBe(
      `Image "shot.png" (sha256:${'d'.repeat(64)}); request preview 7x5px. It may be resized or re-encoded; source dimensions, format, and byte size may differ.`,
    );
  });

  it('沒宣告收不收圖：同樣送把手與圖', async () => {
    const content = await contentOf(
      [attachmentBlock({ type: 'image', ...IMAGE })],
      source(),
      'undeclared',
    );
    expect((content as { type: string }[]).map((block) => block.type)).toEqual([
      'text',
      'image_url',
      'text',
    ]);
  });

  it('兩張圖：各自一組「把手、圖」，順序照原本', async () => {
    const second = { ...IMAGE, attachmentId: `sha256:${'f'.repeat(64)}`, name: 'b.png' };
    const content = (await contentOf([
      attachmentBlock({ type: 'image', ...IMAGE }),
      attachmentBlock({ type: 'image', ...second }),
    ])) as { type: string; text?: string }[];
    expect(content.map((block) => block.type)).toEqual([
      'text',
      'image_url',
      'text',
      'image_url',
      'text',
    ]);
    expect(content[0]!.text).toBe(requestImageHandleText(IMAGE));
    expect(content[2]!.text).toBe(requestImageHandleText(second));
  });

  it('送的是送模型那一份：媒體類型與把手的寬高都是它的，不是參照記的', async () => {
    const sent = {
      data: new Uint8Array([1, 2, 3]),
      mediaType: 'image/jpeg' as const,
      width: 4,
      height: 3,
    };
    const big = { ...IMAGE, width: 4000, height: 3000 };
    const content = await contentOf(
      [attachmentBlock({ type: 'image', ...big })],
      source({ readRequestImage: async () => sent }),
    );
    expect(content).toEqual([
      { type: 'text', text: requestImageHandleText(big, sent) },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AQID' } },
      { type: 'text', text: '請看' },
    ]);
    expect(requestImageHandleText(big, sent)).toContain('request preview 4x3px.');
  });
});

describe('沒送圖的三種：只有一行佔位字，沒有把手', () => {
  it('純文字模型', async () => {
    expect(
      await contentOf([attachmentBlock({ type: 'image', ...IMAGE })], source(), 'rejects'),
    ).toEqual([
      { type: 'text', text: textOnlyImageText(IMAGE) },
      { type: 'text', text: '請看' },
    ]);
  });

  it('被圖片額度省略的', async () => {
    expect(
      await contentOf([{ ...attachmentBlock({ type: 'image', ...IMAGE }), offloaded: true }]),
    ).toEqual([
      { type: 'text', text: offloadedImageText(IMAGE) },
      { type: 'text', text: '請看' },
    ]);
  });

  it('位元組讀不到（含檔頭對不上參照）', async () => {
    const unreadable = source({
      readRequestImage: async () => {
        throw new Error('圖片的檔頭對不上參照');
      },
    });
    expect(await contentOf([attachmentBlock({ type: 'image', ...IMAGE })], unreadable)).toEqual([
      { type: 'text', text: unavailableImageText(IMAGE) },
      { type: 'text', text: '請看' },
    ]);
  });
});
