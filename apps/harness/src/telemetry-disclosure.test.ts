/**
 * 遙測披露的規矩：**只有一個後端都沒掛才渲染未配置**，掛了就必須說出策略。
 *
 * 這一檔跟 [`tracing.test.ts`](./tracing.test.ts) 是兩件事，不是同一道 seam ——
 * 那邊驗的是 LangSmith 那道，這邊驗的是我們自己掛的後端。
 */

import { describe, expect, it } from 'vitest';

import { formatTelemetryDisclosure } from './telemetry-disclosure.js';

describe('遙測披露', () => {
  it('一個都沒掛時才說「未配置」，而且是肯定句、不留白', () => {
    const lines = formatTelemetryDisclosure(undefined);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('未配置');
    expect(lines[0]).toContain('不會離開這個 process');
  });

  it('掛了但策略是關閉，跟「未配置」是兩回事', () => {
    const lines = formatTelemetryDisclosure('disabled');
    // 這一條是這個模組存在的理由之一：掛著一個關掉的後端跟根本沒掛，畫面上要分得出來。
    expect(lines.join('\n')).toContain('已掛後端');
    expect(lines.join('\n')).not.toContain('未配置');
  });

  it('full 說得出送的是什麼，而且不承諾投遞', () => {
    const text = formatTelemetryDisclosure('full').join('\n');
    expect(text).toContain('開啟');
    expect(text).toContain('脫敏規則');
    // 只陳述策略、不承諾投遞——dsh 的共享披露同一條。
    expect(text).toContain('不保證送得到');
  });

  it('feedback-only 也渲染得出來——字彙歸 seam，不歸某個後端', () => {
    const text = formatTelemetryDisclosure('feedback-only').join('\n');
    expect(text).toContain('回饋');
    expect(text).toContain('不保證送得到');
  });

  it('每一種都至少一行，沒有任何一種是留白', () => {
    for (const sharing of [undefined, 'disabled', 'feedback-only', 'full'] as const) {
      expect(formatTelemetryDisclosure(sharing).length).toBeGreaterThan(0);
    }
  });
});
