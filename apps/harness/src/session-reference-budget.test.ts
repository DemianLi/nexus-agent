/**
 * 引用別的會話的每條來源預算（[#1573](https://github.com/DemianLi/nexus-agent/issues/1573) N0862）：公式、窗口取自哪個路由、出廠比例夠不夠中文用。
 *
 * - **公式**（驗收 A、B、F 的算術那一半）：`max(65536, floor(窗口 × 4 × 比例))`，`maxReferenceBytes` 原樣蓋過，取不到窗口用 64 KiB。
 * - **窗口取自 `next()`**（驗收 G）：算預算不能留快照，不然 `beforeModel` 被跳過的下一步會吃到舊路由。
 * - **出廠比例**（驗收 H）：三條上限大小的純中文來源加出廠 system prompt，量出來不超過摘要門檻。
 *
 * 接線（換了模型之後下一次引用跟著走）在 `session-reference-budget-wiring.test.ts`。
 */

import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { estimateRequestTokens, SessionLog, windowThreshold } from '@nexus/core';
import { HARNESS_IDENTITY_SENTENCE } from '@nexus/plugin-system-prompt';
import { describe, expect, it } from 'vitest';

import { liveModelConfigSchema } from './settings/live-model.js';
import { createModelSelectionHost } from './model-selection-host.js';
import { composeEntries } from './plugin-config.js';
import { DEFAULT_MAX_REFERENCE_BYTES } from './session-reference.js';
import { referenceBudgetBytes } from './session-reference-budget.js';
import { sessionReferenceConfigSchema } from './settings/session-reference.js';

const WINDOW = 700_045;

describe('公式，同 dsh `referenceBudget`（index.ts:378-394，1517a4db）', () => {
  it('窗口 700,045、比例 0.2：560,036 位元組（約 547 KiB），就是卡面的算式', () => {
    expect(referenceBudgetBytes({ referenceContextFraction: 0.2, contextWindow: WINDOW })).toBe(
      560_036,
    );
  });

  it('比例 0.1：280,018', () => {
    expect(referenceBudgetBytes({ referenceContextFraction: 0.1, contextWindow: WINDOW })).toBe(
      280_018,
    );
  });

  it('算出來比 64 KiB 小就墊到 64 KiB（下限）', () => {
    expect(referenceBudgetBytes({ referenceContextFraction: 0.1, contextWindow: 100_000 })).toBe(
      DEFAULT_MAX_REFERENCE_BYTES,
    );
    expect(referenceBudgetBytes({ referenceContextFraction: 0, contextWindow: WINDOW })).toBe(
      DEFAULT_MAX_REFERENCE_BYTES,
    );
  });

  it('取不到窗口（沒有選擇控制器、腳本模型）用 64 KiB，對到 dsh 沒有容量資訊的那一格', () => {
    expect(referenceBudgetBytes({ referenceContextFraction: 0.2, contextWindow: undefined })).toBe(
      DEFAULT_MAX_REFERENCE_BYTES,
    );
  });

  it('給了 maxReferenceBytes 就原樣蓋過：比自動預算小或大都照給的', () => {
    expect(
      referenceBudgetBytes({
        maxReferenceBytes: 1_000,
        referenceContextFraction: 0.2,
        contextWindow: WINDOW,
      }),
    ).toBe(1_000);
    expect(
      referenceBudgetBytes({
        maxReferenceBytes: 9_999_999,
        referenceContextFraction: 0.2,
        contextWindow: 100_000,
      }),
    ).toBe(9_999_999);
    // 沒有窗口時也照給的。
    expect(
      referenceBudgetBytes({
        maxReferenceBytes: 1_000,
        referenceContextFraction: 0.2,
        contextWindow: undefined,
      }),
    ).toBe(1_000);
  });
});

/** 兩顆：預設那顆窗口小（預算落在 64 KiB 的下限），另一顆是出廠那顆的窗口。 */
function hostWith(modelId: 'small' | 'big') {
  const live = liveModelConfigSchema.parse({
    baseUrl: 'http://127.0.0.1:1/v1',
    modelId,
    models: [
      { id: 'small', contextWindow: 100_000, maxTokens: 1_000 },
      { id: 'big', contextWindow: WINDOW, maxTokens: 16_384 },
    ],
  });
  const host = createModelSelectionHost({ liveModel: live, credentials: undefined });
  const log = new SessionLog('t');
  host.controller.attach(log);
  return { host, log };
}

describe('窗口取自 `next()`：使用者最後選的 → 最近一次請求走的 → 部署預設（驗收 G 與接線紅燈的單元那一半）', () => {
  it('沒選過、沒請求過：部署預設那顆的窗口', () => {
    const { host } = hostWith('small');
    expect(host.nextContextWindow()).toBe(100_000);
  });

  it('選過就是選的那顆', () => {
    const { host } = hostWith('small');
    host.controller.select({ model: 'big' });
    expect(host.nextContextWindow()).toBe(WINDOW);
  });

  it('沒選過、只有最近一次請求走過別顆（續接的會話）：走的那顆，不是部署預設——不能照 `imageSupport()` 寫成 `selected ?? defaultRoute`', () => {
    const { host, log } = hostWith('small');
    log.append('model/start', { route: { model: 'big' } });
    expect(host.nextContextWindow()).toBe(WINDOW);
  });

  it('選的比請求走的新：以選的為準', () => {
    const { host, log } = hostWith('small');
    log.append('model/start', { route: { model: 'big' } });
    host.controller.select({ model: 'small' });
    expect(host.nextContextWindow()).toBe(100_000);
  });

  it('型錄沒有那一顆（選過、後來被拿掉）：`undefined`，預算退回 64 KiB', () => {
    const { host } = hostWith('small');
    host.controller.select({ model: 'ghost' });
    expect(host.nextContextWindow()).toBeUndefined();
  });

  /**
   * 驗收 G：算預算不能留快照。`assembleStep()` 會寫 `#assembled`，`takeStepRoute()` 下一次就吃那一份；
   * 領走在 `beforeModel`（第一顆）、`assembleStep()` 在後面那顆 `beforeModel`，所以領走時叫它的話，
   * `beforeModel` 被跳過的下一步會用上收下那句話當時的舊路由。
   */
  it('先算預算、再選別顆、`beforeModel` 沒跑：下一步的路由是新選的，不是算預算時留下的快照', () => {
    const { host } = hostWith('small');
    host.controller.select({ model: 'small' });
    expect(host.nextContextWindow()).toBe(100_000);
    host.controller.select({ model: 'big' });
    expect(host.controller.takeStepRoute().model).toBe('big');
  });

  it('同一步先算預算、再跑 `beforeModel`：`takeStepRoute()` 拿到的是 `beforeModel` 快照的那一份', () => {
    const { host } = hostWith('small');
    host.controller.select({ model: 'small' });
    host.nextContextWindow();
    expect(host.controller.assembleStep().model).toBe('small');
    host.controller.select({ model: 'big' });
    // 快照之後才選的，這一步不換（下一步才換）。
    expect(host.controller.takeStepRoute().model).toBe('small');
    expect(host.controller.takeStepRoute().model).toBe('big');
  });
});

describe('出廠比例夠中文用嗎（驗收 H）', () => {
  /**
   * 一段中文散文（混有標點、少量英文與數字，像會話內容）。重複到預算大小，量 nexus 自己的估算器（o200k）。
   * 這一段只是素材：下面第一條斷言它的 token／位元組落在中文的合理範圍，免得換了一段罕見字的素材讓整組數字失真。
   */
  const PROSE =
    '各部門第三季度的預算執行情況已經彙整完畢，其中研發費用比預期低了百分之八，主要原因是兩個專案的採購順延到第四季度。' +
    '請財務同事在週五之前核對一次差異明細，並把需要追加的項目列成清單，送給負責人簽核。會議結論如下：第一，維持原定的人力計畫；' +
    '第二，伺服器擴容改為分兩批採購，先買 8 台，視負載再決定後續；第三，對外的報價單統一用新版模板。' +
    '如果發現數字對不上，先檢查匯率與發票日期，再回頭看是不是有重複入帳。下次例會訂在十一月三日上午十點。';

  /** 中文的真實 token 數 ÷ o200k 估算，`packages/nexus-core/src/token-estimate.ts:41` 錄下產品 body 送真端點量到的值（沒有匯出成常數）。 */
  const CHINESE_REAL_OVER_O200K = 1.1;

  function repeatTo(text: string, bytes: number): string {
    let out = '';
    let size = 0;
    for (;;) {
      for (const ch of text) {
        const next = Buffer.byteLength(ch);
        if (size + next > bytes) return out;
        out += ch;
        size += next;
      }
    }
  }

  const tokensOf = (text: string): number =>
    estimateRequestTokens({ messages: [new HumanMessage(text)] });

  // 出貨的列，不是測試自己寫一份：拿掉那一列的 config、或把比例改回 0.2，下面就紅。
  const shipped = new Map(composeEntries().map((entry) => [entry.id, entry.config]));
  const reference = sessionReferenceConfigSchema.parse(shipped.get('session-reference'));
  const live = liveModelConfigSchema.parse(shipped.get('live-model'));
  const entry = live.models.find((model) => model.id === live.modelId)!;
  const threshold = windowThreshold({
    contextWindow: entry.contextWindow,
    maxOutputTokens: entry.maxTokens,
  });
  // 出廠 system prompt：身分句加部署的前後綴（`cordis.yml` 的 `system-prompt` 那一列）。
  const systemPrompt = [
    String((shipped.get('system-prompt') as { personaPrefix?: string }).personaPrefix),
    HARNESS_IDENTITY_SENTENCE,
    String((shipped.get('system-prompt') as { personaSuffix?: string }).personaSuffix),
  ].join('\n');

  /** 三條上限大小的純中文來源加 system prompt，占摘要門檻的幾倍（`calibration` 是校正係數）。 */
  function loadAgainstThreshold(fraction: number, calibration: number) {
    const perSource = referenceBudgetBytes({
      referenceContextFraction: fraction,
      contextWindow: entry.contextWindow,
    });
    const source = repeatTo(PROSE, perSource);
    const sources = 3 * tokensOf(source);
    const system = estimateRequestTokens({ systemMessage: new SystemMessage(systemPrompt) });
    return {
      perSource,
      sourceBytesPerToken: tokensOf(source) / Buffer.byteLength(source),
      total: Math.round((sources + system) * calibration),
      ratio: ((sources + system) * calibration) / threshold,
    };
  }

  it('素材合理：中文約 0.3 token／位元組（量 AGENTS.md 等四份文件是 0.310–0.311）', () => {
    const { sourceBytesPerToken } = loadAgainstThreshold(0.1, 1);
    expect(sourceBytesPerToken).toBeGreaterThan(0.27);
    expect(sourceBytesPerToken).toBeLessThan(0.36);
  });

  it('出貨的比例不是 schema 的預設 0.2（Q4 (b)）', () => {
    expect(reference.referenceContextFraction).toBeLessThan(0.2);
  });

  /**
   * 兩道判準，出處不同：
   * - 不超過摘要門檻：卡面 H 的字面。
   * - 占門檻不到六成：Q4 (b) 的原話是「三條約占門檻一半」，留給 system prompt、工具定義、歷史與這一輪的輸出。
   *   快照是請求裡最新的一則 `user/message`，摘要器壓的是舊歷史，救不了它。
   * 只有第二道對素材不敏感：下面的對照說明 0.2 在這個量法下只差幾個百分點才超過門檻。
   */
  it('出貨那一列：三條上限大小的中文來源加 system prompt，乘上實測的 1.10 之後不超過摘要門檻，而且占不到六成', () => {
    const { ratio } = loadAgainstThreshold(reference.referenceContextFraction, CHINESE_REAL_OVER_O200K);
    expect(ratio).toBeLessThanOrEqual(1);
    expect(ratio).toBeLessThan(0.6);
  });

  /**
   * **對照：dsh 的 0.2 在這個量法下會紅，這條測試才有牙；也說清楚字面的「不超過門檻」為什麼不夠。**
   * 沒校正時 0.2 只占門檻的 91%–95%（量 `AGENTS.md` 等四份文件是 94%–95%，這段素材較低），乘上 1.10 之後在 100% 上下，
   * 超不超過看素材（四份文件是 103%–105%，這段素材 99.7%）。所以「拿掉 config 吃 0.2」要靠「占不到六成」那一道才穩穩地紅。
   */
  it('對照：0.2 沒校正時已占九成以上，校正後約一整個門檻，離「占不到六成」很遠', () => {
    const raw = loadAgainstThreshold(0.2, 1).ratio;
    const calibrated = loadAgainstThreshold(0.2, CHINESE_REAL_OVER_O200K).ratio;
    expect(raw).toBeGreaterThan(0.85);
    expect(raw).toBeLessThan(1);
    expect(calibrated).toBeGreaterThan(0.95);
    expect(calibrated).toBeGreaterThan(0.6);
  });
});
