/**
 * 抽字的規則與上限（[#439](https://github.com/DemianLi/nexus-agent/issues/439)）。
 *
 * 產品路徑上這兩件事的效果在 `tool-card-from-log.test.ts`（即時與重播同一串）與
 * `conversation-history.test.ts`（重播那一側）驗；這一份釘的是規則本身。
 */

import { ToolMessage } from '@langchain/core/messages';
import { toLoggedMessage } from '@nexus/core';
import type { LoggedMessage } from '@nexus/core';
import { describe, expect, it } from 'vitest';

import { DEFAULT_TOOL_TEXT_MAX_BYTES } from './settings/tool-text.js';
import { capToolText, toolResultText } from './tool-result-text.js';

/**
 * 這一組釘的是**規則**，不是那個數字，所以每一條都明著傳預設值
 * （[#538](https://github.com/DemianLi/nexus-agent/issues/538) 之後上限是參數）。
 * 「上限真的照傳進來的走」由本檔最後那一條驗。
 */
const CAP = DEFAULT_TOOL_TEXT_MAX_BYTES;

const logged = (content: unknown): LoggedMessage =>
  ({
    ...toLoggedMessage(new ToolMessage({ content: '佔位', tool_call_id: 'c1' })),
    data: { content },
  }) as LoggedMessage;

describe('抽字的規則', () => {
  it('內容是字串就原樣給', () => {
    expect(toolResultText(logged('寫好了'), CAP)).toBe('寫好了');
  });

  it('剛好一塊文字：取那一塊', () => {
    expect(toolResultText(logged([{ type: 'text', text: '寫好了' }]), CAP)).toBe('寫好了');
  });

  /**
   * **不自己把幾塊接起來**，照 dsh 的 `singleResultText`
   * （`packages/client/ui-tool/src/client/tool/models/raw-tool-call.ts:46-50`，`ddefc45`）：
   * 接出來的那串字是我們發明的，dsh 的卡在同樣的輸入下什麼都不顯示。
   */
  it('多塊就不給——不是把它們接起來', () => {
    expect(
      toolResultText(
        logged([
          { type: 'text', text: '第一塊' },
          { type: 'text', text: '第二塊' },
        ]),
        CAP,
      ),
    ).toBeUndefined();
  });

  it('那一塊不是文字（圖片、檔案）也不給', () => {
    expect(toolResultText(logged([{ type: 'image', source: {} }]), CAP)).toBeUndefined();
  });

  it('沒有訊息（格式 9 以前的日誌）就不給', () => {
    expect(toolResultText(undefined, CAP)).toBeUndefined();
  });

  it('空字串照樣是一段文字，不會被當成沒有', () => {
    expect(toolResultText(logged(''), CAP)).toBe('');
  });
});

describe('上限', () => {
  const HALF = '甲'.repeat(20_000); // 每個 3 bytes

  it('沒超過就一個字都不動', () => {
    const text = '短的';
    expect(capToolText(text, CAP)).toBe(text);
  });

  it('剛好等於上限也不動', () => {
    const text = 'a'.repeat(CAP);
    expect(capToolText(text, CAP)).toBe(text);
  });

  it('超過就取頭尾各半，中間放一行說明；**總長不超過上限**', () => {
    const text = `${HALF}藍鯨${HALF}`;
    const capped = capToolText(text, CAP);
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(CAP);
    expect(capped.startsWith('甲甲甲')).toBe(true);
    expect(capped.endsWith('甲甲甲')).toBe(true);
    expect(capped).toContain('沒有送出來');
    // 正中間那一段真的被拿掉了——不是只在尾巴接一行字。（暗號要挑通知本身不會用到的字。）
    expect(capped).not.toContain('藍鯨');
  });

  /**
   * **不切斷字元**：頭尾都取到「再多一個字就超過」為止。切一半的話，那個位元組在 JSON
   * 上就是一個替換字元，web 拿去 `JSON.parse` 的工具（提問卡）會整個解不開。
   */
  it('多位元組的字不會被切成半個', () => {
    const capped = capToolText(`${HALF}藍鯨${HALF}`, CAP);
    expect(capped).not.toContain('�');
    expect([...capped].every((char) => char.codePointAt(0) !== 0xfffd)).toBe(true);
  });

  /**
   * **上限是傳進來的那個數，不是模組裡的某個常數**（#538）。
   *
   * 沒有這一條的話，整組測試用的都是預設值——「參數其實被忽略、一律用 50000」這個缺陷
   * 一條都不會紅。所以這裡挑一個**離預設很遠**的小值，量截斷確實照它走。
   */
  it('換一個上限，截斷就照那個上限走', () => {
    const small = 500;
    const text = 'a'.repeat(10_000);
    const capped = capToolText(text, small);
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(small);
    // 而且它真的截了——不是因為輸入本來就短。
    expect(capped).toContain('沒有送出來');
    // 同一段文字在預設上限底下**不會**被截，兩臂的差別只可能來自那個參數。
    expect(capToolText(text, CAP)).toBe(text);
  });

  /**
   * **下限那個值仍然講得完一句話，而且還看得到原文**——`settings/tool-text.ts` 的 schema 把
   * `maxBytes` 的下限釘在 128，理由就是這一條量到的東西（2026-09-23）：64 的時候通知塞滿整段、
   * 一個原文字元都不剩；40 的時候連通知自己都被截斷。
   */
  it('設定容許的最小上限：通知完整，而且頭尾還留得下原文', () => {
    const capped = capToolText('x'.repeat(5_000), 128);
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(128);
    expect(capped).toContain('沒有送出來');
    expect(capped.startsWith('x')).toBe(true);
    expect(capped.endsWith('x')).toBe(true);
  });

  it('抽字時就套上限，兩條路拿到的都是截過的那一份', () => {
    const capped = toolResultText(logged(`${HALF}藍鯨${HALF}`), CAP);
    expect(capped).toBeDefined();
    expect(Buffer.byteLength(capped!, 'utf8')).toBeLessThanOrEqual(CAP);
  });
});
