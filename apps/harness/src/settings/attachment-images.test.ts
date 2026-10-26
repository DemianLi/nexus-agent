/**
 * `#settings/attachment-images` 那一列走到 serve 的附件儲存（#2033）：出貨清單 → patch → `startupSetting` →
 * `AttachmentStore` 的限流器。起動日誌那一行讀的是限流器，拿掉 `serve.ts` 交值的那一格，這一檔會紅。
 *
 * **零憑證、零外部連線**：模型是腳本。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { bodyLog } from '../fixtures.js';
import { startScriptedServe } from '../scripted-serve.js';
import type { ScriptedServe } from '../scripted-serve.js';
import { attachmentImagesConfigSchema } from './attachment-images.js';

let serve: ScriptedServe | undefined;

afterEach(async () => {
  await serve?.close();
  serve = undefined;
});

const TURNS = [{ content: '好' }] as const;

async function startupLines(extraRows = ''): Promise<string[]> {
  const lines: string[] = [];
  serve = await startScriptedServe(TURNS, { extraRows, log: bodyLog(lines) });
  return lines.filter((line) => line.startsWith('圖片轉碼併發：'));
}

describe('圖片轉碼併發的設定列', () => {
  it('出廠是 2', async () => {
    expect(await startupLines()).toEqual(['圖片轉碼併發：2 張（超過的排隊）']);
  });

  it('patch 改成 3，serve 的附件儲存就是 3', async () => {
    expect(
      await startupLines(
        '- id: attachment-images\n  config:\n    imageCompressionConcurrency: 3\n',
      ),
    ).toEqual(['圖片轉碼併發：3 張（超過的排隊）']);
  });

  it('範圍是 1 到 8 的整數', () => {
    for (const ok of [1, 8]) {
      expect(attachmentImagesConfigSchema.parse({ imageCompressionConcurrency: ok })).toEqual({
        imageCompressionConcurrency: ok,
      });
    }
    for (const bad of [0, 9, 2.5]) {
      expect(
        attachmentImagesConfigSchema.safeParse({ imageCompressionConcurrency: bad }).success,
      ).toBe(false);
    }
  });
});
