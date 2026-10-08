/**
 * 附件參照與檔案的那一行字（[#732](https://github.com/DemianLi/nexus-agent/issues/732)）。
 * 檔案那一行逐字照 dsh `fileHandleText`（`packages/llm/llm/src/content.ts`，`5badb150`）；這裡把兩支措辭釘死。
 */

import { describe, expect, it } from 'vitest';

import {
  attachmentBlock,
  fileHandleText,
  fileModelPath,
  isAttachmentRef,
  isFileBlock,
  isImageBlock,
} from './attachment-ref.js';
import type { FileAttachmentRef, ImageAttachmentRef } from './attachment-ref.js';

const DIGEST = 'ab'.repeat(32);
const FILE: FileAttachmentRef = {
  attachmentId: `sha256:${DIGEST}`,
  name: '說明 文件.txt',
  bytes: 12,
};
const IMAGE: ImageAttachmentRef = {
  attachmentId: `sha256:${'cd'.repeat(32)}`,
  mediaType: 'image/png',
  bytes: 8378,
  width: 640,
  height: 220,
  name: 'shot.png',
};

describe('檔案給模型的那一行', () => {
  it('讀得到：檔名、位元組、雜湊前八碼、路徑，和 dsh 同一句', () => {
    const path = fileModelPath(FILE)!;
    expect(path).toBe(`/attachments/ab/${DIGEST}/說明 文件.txt`);
    expect(fileHandleText(FILE, path)).toBe(
      `[File "說明 文件.txt" (12 bytes, sha256:abababab): verbatim read-only copy saved at ${JSON.stringify(path)}. Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it. When delegating file work, include this saved path in the delegation prompt; only subagents sharing this execution environment can read it.]`,
    );
  });

  it('讀不到：改說無法存取，不准聲稱讀過', () => {
    expect(fileHandleText(FILE, undefined)).toBe(
      '[File "說明 文件.txt" (12 bytes, sha256:abababab) was uploaded, but the current execution environment cannot access a readable path. Report that limitation if its contents are needed; do not claim to have read it.]',
    );
  });

  it('檔名裡的引號與換行被 JSON 跳脫，一行就是一行', () => {
    const text = fileHandleText({ ...FILE, name: 'a"b\nc' }, undefined);
    expect(text).toContain('"a\\"b\\nc"');
    expect(text).not.toContain('\n');
  });
});

describe('區塊與參照的形狀', () => {
  it('參照包成區塊再認得回來；型別名不撞 LangChain 標準的 file／image', () => {
    const file = attachmentBlock({ type: 'file', ...FILE });
    const image = attachmentBlock({ type: 'image', ...IMAGE });
    expect(file).toEqual({ type: 'nexus-file', attachment: FILE });
    expect(image).toEqual({ type: 'nexus-image', attachment: IMAGE });
    expect(isFileBlock(file) && !isImageBlock(file)).toBe(true);
    expect(isImageBlock(image) && !isFileBlock(image)).toBe(true);
    expect(isFileBlock({ type: 'file', attachment: FILE })).toBe(false);
  });

  it('形狀不合格的一律不認：雜湊、位元組數、媒體類型', () => {
    expect(isAttachmentRef({ type: 'file', ...FILE })).toBe(true);
    expect(isAttachmentRef({ type: 'file', ...FILE, attachmentId: 'sha256:zz' })).toBe(false);
    expect(isAttachmentRef({ type: 'file', ...FILE, bytes: -1 })).toBe(false);
    expect(isAttachmentRef({ type: 'file', ...FILE, name: '' })).toBe(false);
    expect(isAttachmentRef({ type: 'image', ...IMAGE })).toBe(true);
    expect(isAttachmentRef({ type: 'image', ...IMAGE, mediaType: 'image/bmp' })).toBe(false);
    expect(isAttachmentRef({ type: 'image', ...IMAGE, width: 1.5 })).toBe(false);
    expect(isAttachmentRef({ type: 'other', ...FILE })).toBe(false);
    expect(isAttachmentRef(null)).toBe(false);
    expect(fileModelPath({ ...FILE, attachmentId: 'nope' })).toBeUndefined();
  });
});
