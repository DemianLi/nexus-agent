// @vitest-environment node
/** 瀏覽器護欄（#1512）：狀態列、增刪行數與 diff、對話流、計劃、觀測、成本、右側欄、會話清單。量具在 `harness.ts`。 */
import { type Page } from 'playwright-core';
import { describe, expect, test } from 'vitest';
import { PLAN_CHIP_RUNNING_HINT } from '../src/lib/plan-chip';

import {
  DIFF_VIEW,
  DIFF_VIEW_KINDS,
  MODES,
  NON_TEXT_MIN,
  PLAN_EXIT,
  REF_LINK,
  REF_PLAIN,
  STATUS_RUNNING,
  TEXT_MIN,
  THREAD_CLOCK,
  TRACE_LOADING,
  TRACE_PILL,
  TRACE_PULL,
  TRACE_ROW,
  TRACE_STEP,
  TRACE_TONES,
  TURN_ELAPSED,
  TURN_GLYPH,
  TURN_LABEL,
  type Theme,
  collectFocus,
  collectTexts,
  diffStatsMarks,
  diffViewMarks,
  expectFocus,
  expectTexts,
  failPlanExit,
  loadTraceGroup,
  markDiffViewLines,
  openDiffReview,
  openOverlay,
  openTraceSteps,
  openingPoseIn,
  planMarks,
  readLabel,
  readPose,
  readRadii,
  readTraceLoading,
  report,
  revealTraceGroups,
  round,
  setActivity,
  settle,
  tracePillMarks,
  traceTurn,
  transcriptRefsMarks,
  transcriptRowMarks,
  worstOn,
} from './harness';

describe.each(
  MODES.flatMap((mode) => (['light', 'dark'] as const).map((theme) => [mode, theme] as const)),
)('瀏覽器量狀態列（#1684）：%s、%s', (mode, theme) => {
  test('平常：label 是 SG 的 status-shimmer（sg-status-shimmer 2.4s），三個色標對底色都過 4.5；經過時間過 4.5', async () => {
    const page = await openOverlay('turn-status', theme, {
      mode,
      marks: { [TURN_LABEL]: {}, [TURN_ELAPSED]: { 'data-guard-text': 'turn-elapsed' } },
    });
    try {
      const label = await readLabel(page);
      const stops = [...label.image.matchAll(/(?:oklch|oklab|rgba?)\([^)]*\)/g)].map((m) => m[0]);
      const ratios = stops.map((stop) => ({ stop, ...worstOn(stop, label.chain) }));
      report[`turn-status:${mode}:${theme}:shimmer`] = {
        ...label,
        chain: undefined,
        stops: ratios.map((r) => `${r.stop} ${round(r.ratio)}（${r.on}）`),
      };
      // 量具自檢：字真的是透明的、顏色來自三個色標的漸層、動畫在跑。
      expect(label).toMatchObject({
        name: '執行中…',
        color: 'rgba(0, 0, 0, 0)',
        clip: 'text',
        animation: 'sg-status-shimmer 2.4s',
      });
      expect(stops).toHaveLength(3);
      expect(
        ratios
          .filter((r) => !(r.ratio >= TEXT_MIN))
          .map((r) => `${r.stop} ${round(r.ratio)}（${r.on}）`),
      ).toEqual([]);
      const elapsed = (await collectTexts(page)).filter((t) => t.name === 'turn-elapsed');
      expect(elapsed).toHaveLength(1);
      expectTexts(elapsed, ['turn-elapsed'], `turn-status:${mode}:${theme}`);
    } finally {
      await page.close();
    }
  });

  test('減少動態：shimmer 停住、沒有漸層，字色等於 --muted-foreground、過 4.5', async () => {
    const page = await openOverlay('turn-status', theme, {
      mode,
      reducedMotion: true,
      marks: { [TURN_LABEL]: {} },
    });
    try {
      const label = await readLabel(page);
      const contrast = worstOn(label.color, label.chain);
      report[`turn-status:${mode}:${theme}:shimmer-reduced`] = {
        ...label,
        chain: undefined,
        ratio: round(contrast.ratio),
      };
      expect(label).toMatchObject({ name: '執行中…', image: 'none', animation: 'none 0s' });
      expect(label.color).toBe(label.mutedColor);
      expect(contrast.ratio).toBeGreaterThanOrEqual(TEXT_MIN);
    } finally {
      await page.close();
    }
  });
});

describe('瀏覽器量狀態列的行為（#1684）', () => {
  const onlyRunning = (page: Page) =>
    page.goto(`${page.url()}&only=running`).then(() => page.waitForSelector(TURN_GLYPH));

  test('live region 不變動：glyph 照常在動，[role="status"] 3 秒內沒有 childList／characterData 的變動', async () => {
    const page = await openOverlay('turn-status', 'light', { marks: { [TURN_GLYPH]: {} } });
    try {
      const result = await page.evaluate(
        (selector) =>
          new Promise<{ mutations: number; poses: number }>((resolve) => {
            const region = document.querySelector(`${selector} [role="status"]`)!;
            let mutations = 0;
            const observer = new MutationObserver((records) => {
              mutations += records.filter(
                (r) => r.type === 'childList' || r.type === 'characterData',
              ).length;
            });
            observer.observe(region, { childList: true, characterData: true, subtree: true });
            const poses = new Set<string>();
            const timer = setInterval(() => {
              poses.add(
                [...region.querySelectorAll('circle')]
                  .map((c) => ['cx', 'cy', 'r', 'opacity'].map((a) => c.getAttribute(a)).join(','))
                  .join(' '),
              );
            }, 250);
            setTimeout(() => {
              clearInterval(timer);
              observer.disconnect();
              resolve({ mutations, poses: poses.size });
            }, 3000);
          }),
        STATUS_RUNNING,
      );
      report['turn-status:live-region-mutations'] = result;
      // 量具自檢：這段期間 glyph 真的在動（不然「0 筆變動」是因為什麼都沒在跑）。
      expect(result.poses).toBeGreaterThan(1);
      expect(result.mutations).toBe(0);
    } finally {
      await page.close();
    }
  });

  test('AX 樹：只有一個 status 節點，讀得到的字只有「執行中…」，沒有數字；glyph 不在樹裡', async () => {
    const page = await openOverlay('turn-status', 'light', { marks: { [TURN_GLYPH]: {} } });
    try {
      await onlyRunning(page);
      await settle(page);
      const cdp = await page.context().newCDPSession(page);
      const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as {
        nodes: { ignored: boolean; role?: { value: string }; name?: { value: string } }[];
      };
      const visible = nodes.filter((n) => !n.ignored);
      const result = {
        status: visible.filter((n) => n.role?.value === 'status').length,
        texts: visible
          .filter((n) => n.role?.value === 'StaticText')
          .map((n) => n.name?.value ?? ''),
        graphics: visible
          .map((n) => n.role?.value ?? '')
          .filter((role) => /svg|graphics|image|img/i.test(role)),
      };
      report['turn-status:ax'] = result;
      // 量具自檢：經過時間真的畫出來了（aria-hidden，不在樹裡）。
      expect(await page.$eval(TURN_ELAPSED, (el) => el.textContent)).toMatch(/秒/);
      expect(result).toEqual({ status: 1, texts: ['執行中…'], graphics: [] });
    } finally {
      await page.close();
    }
  });

  test('glyph：平常在動；減少動態停在起始姿勢、1 秒內不動；換 activity 立刻跳到新的起始姿勢', async () => {
    const page = await openOverlay('turn-status', 'light', { marks: { [TURN_GLYPH]: {} } });
    try {
      const a = await readPose(page);
      await page.waitForTimeout(300);
      const b = await readPose(page);
      report['turn-status:glyph-normal'] = { a, b };
      expect(b).not.toEqual(a);
    } finally {
      await page.close();
    }
    const reduced = await openOverlay('turn-status', 'light', {
      reducedMotion: true,
      marks: { [TURN_GLYPH]: {} },
    });
    try {
      const a = await readPose(reduced);
      await reduced.waitForTimeout(1000);
      const b = await readPose(reduced);
      const thinking = await openingPoseIn(reduced, 'thinking');
      await setActivity(reduced, 'running');
      await reduced.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
      const running = await readPose(reduced);
      const expected = await openingPoseIn(reduced, 'running');
      report['turn-status:glyph-reduced'] = { a, b, thinking, running, expected };
      expect(thinking).not.toEqual(expected);
      expect([a, b]).toEqual([thinking, thinking]);
      expect(running).toEqual(expected);
    } finally {
      await reduced.close();
    }
  });

  test.each([375, 1280])(
    '高度不跳：%dpx 寬，就緒、執行中、等你回答三種狀態列一樣高',
    async (width) => {
      const page = await openOverlay('turn-status', 'light', {
        viewport: { width, height: 800 },
        marks: { '[data-guard-status]': {} },
      });
      try {
        const heights = await page.$$eval('[data-guard-status]', (els) =>
          els.map((el) => [
            el.getAttribute('data-guard-status'),
            Math.round(el.firstElementChild!.getBoundingClientRect().height * 100) / 100,
          ]),
        );
        report[`turn-status:${width}:heights`] = heights;
        expect(heights.map(([name]) => name)).toEqual(['idle', 'running', 'awaiting']);
        expect(new Set(heights.map(([, h]) => h)).size).toBe(1);
      } finally {
        await page.close();
      }
    },
  );

  test('375 寬：狀態列加經過時間不撐破欄寬、label 一行、整頁沒有橫向捲動', async () => {
    const page = await openOverlay('turn-status', 'light', {
      viewport: { width: 375, height: 800 },
      marks: { [TURN_ELAPSED]: {} },
    });
    try {
      const box = await page.evaluate(
        ({ row, label, elapsed }) => {
          const column = document.querySelector(row)!.getBoundingClientRect();
          const l = document.querySelector(label)!.getBoundingClientRect();
          const e = document.querySelector(elapsed)!.getBoundingClientRect();
          return {
            columnRight: column.right,
            elapsedRight: e.right,
            labelHeight: l.height,
            // TurnStatus 那一列是 `h-5`；label 折行就會比它高。
            rowHeight: document.querySelector(label)!.parentElement!.getBoundingClientRect().height,
            pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
          };
        },
        { row: STATUS_RUNNING, label: TURN_LABEL, elapsed: TURN_ELAPSED },
      );
      report['turn-status:375'] = box;
      expect(box.elapsedRight).toBeLessThanOrEqual(box.columnRight);
      expect(box.labelHeight).toBeLessThanOrEqual(box.rowHeight);
      expect(box.pageOverflow).toBeLessThanOrEqual(0);
    } finally {
      await page.close();
    }
  });
});

describe.each(
  MODES.flatMap((mode) => (['light', 'dark'] as const).map((theme) => [mode, theme] as const)),
)('瀏覽器量增刪行數（#1685 PR A）：%s、%s', (mode, theme) => {
  test('頁面、清單、改動卡、審查頁上的 +／− 過 4.5，顏色是 success／destructive', async () => {
    const page = await openOverlay('diff-stats', theme, {
      mode,
      marks: diffStatsMarks,
      prepare: openDiffReview,
    });
    try {
      const texts = await collectTexts(page);
      const names = [
        'diff-page',
        'diff-group',
        'diff-panel',
        'diff-changes',
        'diff-review',
        'diff-review-picker',
      ];
      // 量具自檢：頁面上 1 顆、段收著那一列的合計 1 顆、段裡寫檔那張 1 顆、改動卡標頭 1 顆加兩列（二進位那列寫字）、
      // 審查頁標頭的合計與這個檔各 1 顆、選檔器兩列；每顆兩個 span。
      expect(
        Object.fromEntries(
          names.map((name) => [name, texts.filter((t) => t.name === name).length]),
        ),
      ).toEqual({
        'diff-page': 2,
        'diff-group': 2,
        'diff-panel': 2,
        'diff-changes': 6,
        'diff-review': 4,
        'diff-review-picker': 4,
      });
      expectTexts(texts, names, `diff-stats:${mode}:${theme}`);
      // 覆寫檔第 75 條：`+` 是 `--success`、`−` 是 `--destructive`（拿一個 inline style 的探針讀 token 算出來的顏色）。
      const colors = await page.evaluate(() => {
        const probe = (token: string) => {
          const el = document.createElement('span');
          el.style.color = `var(${token})`;
          document.body.append(el);
          const color = getComputedStyle(el).color;
          el.remove();
          return color;
        };
        const success = probe('--success');
        const destructive = probe('--destructive');
        const wrong = [...document.querySelectorAll('[data-slot="diff-stats"]')].flatMap(
          (stats) => {
            const [plus, minus] = [...stats.querySelectorAll(':scope > span')];
            const pairs: [Element | undefined, string, string][] = [
              [plus, success, '+'],
              [minus, destructive, '−'],
            ];
            return pairs
              .filter(([el, want]) => el === undefined || getComputedStyle(el).color !== want)
              .map(
                ([el, want, sign]) =>
                  `${sign} ${el === undefined ? '沒有' : getComputedStyle(el).color} ≠ ${want}`,
              );
          },
        );
        return {
          success,
          destructive,
          count: document.querySelectorAll('[data-slot="diff-stats"]').length,
          wrong,
        };
      });
      report[`diff-stats:${mode}:${theme}:colors`] = colors;
      expect(colors.count).toBe(10);
      expect(colors.wrong).toEqual([]);
    } finally {
      await page.close();
    }
  });
});

test('第 76 條：375 寬時包裝層不被擠，寬度跟 vendor 那顆單獨放著一樣（#1685 PR A）', async () => {
  const page = await openOverlay('diff-stats', 'light', {
    viewport: { width: 375, height: 812 },
    marks: diffStatsMarks,
    prepare: openDiffReview,
  });
  try {
    const measured = await page.evaluate(() =>
      [...document.querySelectorAll('[data-slot="diff-stats"]')].map((stats) => {
        // 包裝層：`aria-hidden` 那層的外面（`components/ui/diff-view.tsx`）。
        const wrapper = stats.parentElement!.parentElement!;
        const alone = stats.cloneNode(true) as HTMLElement;
        const holder = document.createElement('div');
        holder.style.cssText = 'position:absolute;left:0;top:0;width:max-content;visibility:hidden';
        holder.append(alone);
        document.body.append(holder);
        const natural = alone.getBoundingClientRect().width;
        holder.remove();
        return {
          where:
            stats.closest('[data-guard-diffstats]')?.getAttribute('data-guard-diffstats') ??
            (stats.closest('[data-slot="popover-content"]') !== null ? 'picker' : 'review'),
          text: stats.textContent,
          wrapper: wrapper.getBoundingClientRect().width,
          inner: stats.getBoundingClientRect().width,
          natural,
        };
      }),
    );
    report['diff-stats:375-width'] = measured;
    // 量具自檢：十顆都量到了，而且單獨放著的寬度不是 0。
    expect(measured).toHaveLength(10);
    expect(measured.every((m) => m.natural > 0)).toBe(true);
    expect(
      measured
        .filter((m) => Math.abs(m.wrapper - m.natural) > 0.5 || Math.abs(m.inner - m.natural) > 0.5)
        .map(
          (m) =>
            `${m.where} ${m.text}：包裝層 ${round(m.wrapper)}、裡面 ${round(m.inner)}、單獨 ${round(m.natural)}`,
        ),
    ).toEqual([]);
  } finally {
    await page.close();
  }
});

describe.each(
  MODES.flatMap((mode) => (['light', 'dark'] as const).map((theme) => [mode, theme] as const)),
)('瀏覽器量工具卡的 diff（#1685 PR B）：%s、%s', (mode, theme) => {
  test('每一種行在清單裡與單獨放在頁面上都過 4.5', async () => {
    const page = await openOverlay('diff-view', theme, {
      mode,
      marks: diffViewMarks,
      prepare: markDiffViewLines,
    });
    try {
      const texts = await collectTexts(page);
      const names = (['group', 'standalone'] as const).flatMap((where) =>
        DIFF_VIEW_KINDS.map((kind) => `diffview-${where}-${kind}`),
      );
      // 量具自檢：兩處各兩張卡（改檔、寫檔），六種行都量到（`expectTexts` 檢查每個名字都在）。
      expect(await page.$$eval(DIFF_VIEW, (els) => els.length)).toBe(4);
      expectTexts(
        texts.filter((t) => t.name.startsWith('diffview-')),
        names,
        `diff-view:${mode}:${theme}`,
      );
    } finally {
      await page.close();
    }
  });
});

describe('瀏覽器量工具卡的 diff 的覆寫與焦點（#1685 PR B）', () => {
  test('第 65 條：疊在清單裡的 DiffView 沒有 backdrop-filter；單獨放的照 SG 有', async () => {
    const page = await openOverlay('diff-view', 'light', { marks: diffViewMarks });
    try {
      const filter = (selector: string) =>
        page.$$eval(selector, (els) => els.map((el) => getComputedStyle(el).backdropFilter));
      const measured = {
        nested: await filter(
          '[data-guard-diffview="group"] [data-slot="step-list"] [data-slot="diff-view"]',
        ),
        standalone: await filter('[data-guard-diffview="standalone"] [data-slot="diff-view"]'),
      };
      report['diff-view:backdrop'] = measured;
      expect(measured.nested).toEqual(['none', 'none']);
      expect(measured.standalone).toHaveLength(2);
      for (const f of measured.standalone) expect(f).toMatch(/blur\(/);
    } finally {
      await page.close();
    }
  });

  test.each(['light', 'dark'] as const)(
    'patch 0024（%s）：DiffView 停得上焦點、2px 外框沒被祖先切掉、方向鍵捲得動',
    async (theme) => {
      const page = await openOverlay('diff-view', theme, {
        marks: { ...diffViewMarks, [DIFF_VIEW]: { 'data-guard-focus': 'diff-view' } },
      });
      try {
        const focus = await collectFocus(page);
        expect(focus).toHaveLength(4);
        expectFocus(focus, `diff-view:${theme}`);
        const clipped = await page.$$eval(DIFF_VIEW, (els) =>
          els.flatMap((el, i) => {
            (el as HTMLElement).focus();
            const style = getComputedStyle(el);
            const reach = parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth);
            const rect = el.getBoundingClientRect();
            const out = [];
            for (let node = el.parentElement; node !== null; node = node.parentElement) {
              const s = getComputedStyle(node);
              if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
              const box = node.getBoundingClientRect();
              const left = box.left + parseFloat(s.borderLeftWidth);
              const right = box.right - parseFloat(s.borderRightWidth);
              const top = box.top + parseFloat(s.borderTopWidth);
              const bottom = box.bottom - parseFloat(s.borderBottomWidth);
              const sides = [
                rect.left - reach < left - 0.5 && s.overflowX !== 'visible' ? '左' : '',
                rect.right + reach > right + 0.5 && s.overflowX !== 'visible' ? '右' : '',
                rect.top - reach < top - 0.5 && s.overflowY !== 'visible' ? '上' : '',
                rect.bottom + reach > bottom + 0.5 && s.overflowY !== 'visible' ? '下' : '',
              ].join('');
              if (sides !== '')
                out.push(
                  `#${i} 被 ${node.tagName}[${node.getAttribute('data-slot') ?? ''}] 切掉（${sides}）`,
                );
            }
            return out;
          }),
        );
        report[`diff-view:${theme}:clipped`] = clipped;
        expect(clipped).toEqual([]);

        // 寫檔那張的行很寬、行數超過 max-h-80：鍵盤聚焦後方向鍵橫向與直向都捲得動。
        const wide = page
          .locator('[data-guard-diffview="standalone"] [data-slot="diff-view"]')
          .nth(1);
        await wide.focus();
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowDown');
        await page.waitForFunction(
          (el) => el !== null && el.scrollLeft > 0 && el.scrollTop > 0,
          await wide.elementHandle(),
        );
        const scrolled = await wide.evaluate((el) => ({ left: el.scrollLeft, top: el.scrollTop }));
        report[`diff-view:${theme}:scrolled`] = scrolled;
      } finally {
        await page.close();
      }
    },
  );
});

describe.each<Theme>(['light', 'dark'])('瀏覽器量對話流裡的列（#1695 PR A）：%s', (theme) => {
  test('字過 4.5，往前翻的鈕（含讀取中，#2009）聚焦時是 2px 外框', async () => {
    const page = await openOverlay('transcript-rows', theme, { marks: transcriptRowMarks });
    try {
      expectTexts(
        await collectTexts(page),
        [
          'retry-text',
          'pager-idle',
          'pager-loading',
          'pager-fail',
          'pager-error',
          'empty-title',
          'empty-description',
        ],
        `transcript-rows:${theme}`,
      );
      const focus = await collectFocus(page);
      expect(focus.map((f) => f.name)).toEqual(['pager-idle-0', 'pager-loading-0', 'pager-fail-0']);
      expectFocus(focus, `transcript-rows:${theme}`);
    } finally {
      await page.close();
    }
  });

  test.each([false, true])(
    'DotLoader 的點：3px、status-running 色；減少動態 %s 時停在全亮',
    async (reducedMotion) => {
      const page = await openOverlay('transcript-rows', theme, {
        reducedMotion,
        marks: transcriptRowMarks,
      });
      try {
        const dots = await page.evaluate(() => {
          const probe = document.createElement('span');
          probe.style.backgroundColor = 'var(--status-running)';
          document.body.append(probe);
          const running = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return [...document.querySelectorAll('.animate-dot-flash')].map((dot) => {
            const style = getComputedStyle(dot);
            const box = dot.getBoundingClientRect();
            return {
              where: dot
                .closest('[data-guard-rows], [data-guard-pager]')
                ?.getAttribute(
                  dot.closest('[data-guard-rows]') === null
                    ? 'data-guard-pager'
                    : 'data-guard-rows',
                ),
              width: box.width,
              height: box.height,
              color: style.backgroundColor,
              running,
              animationName: style.animationName,
              opacity: style.opacity,
            };
          });
        });
        report[`transcript-rows:${theme}:dots:${reducedMotion ? 'reduced' : 'normal'}`] = dots;
        // 量具自檢：重試提示三個、往前翻讀取中三個。
        expect(dots.map((d) => d.where)).toEqual([
          'retry',
          'retry',
          'retry',
          'loading',
          'loading',
          'loading',
        ]);
        expect(
          dots.filter((d) => d.width !== 3 || d.height !== 3 || d.color !== d.running),
        ).toEqual([]);
        if (reducedMotion)
          expect(dots.filter((d) => d.animationName !== 'none' || d.opacity !== '1')).toEqual([]);
        else expect(dots.filter((d) => d.animationName !== 'sg-dot-flash')).toEqual([]);
      } finally {
        await page.close();
      }
    },
  );
});

test.each([375, 1280])(
  '往前翻：寬 %ipx 時待命與讀取中一樣高、頁面不橫向溢出（#1695 X4-B）',
  async (width) => {
    const page = await openOverlay('transcript-rows', 'light', {
      viewport: { width, height: 1000 },
      marks: transcriptRowMarks,
    });
    try {
      const heights = await page.evaluate(() =>
        Object.fromEntries(
          [...document.querySelectorAll('[data-guard-pager]')].map((el) => [
            el.getAttribute('data-guard-pager'),
            el.getBoundingClientRect().height,
          ]),
        ),
      );
      report[`transcript-rows:pager-heights:${width}`] = heights;
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBe(0);
      expect(heights.idle).toBeGreaterThan(0);
      expect(heights.loading).toBe(heights.idle);
      expect(heights.live).toBe(heights.idle);
    } finally {
      await page.close();
    }
  },
);

describe.each<Theme>(['light', 'dark'])('瀏覽器量會話引用與圓角（#1695 PR B）：%s', (theme) => {
  test('引用：能點的帶 brand 底線、過 3；兩種引用與 chip 的字過 4.5；引用與「立刻重連」的焦點外框', async () => {
    const page = await openOverlay('transcript-refs', theme, { marks: transcriptRefsMarks });
    try {
      expectTexts(
        await collectTexts(page),
        ['ref-link', 'ref-plain', 'decision-chip'],
        `transcript-refs:${theme}`,
      );
      const refs = await page.evaluate(
        ([link, plain]) => {
          const probe = document.createElement('span');
          probe.style.color = 'var(--brand)';
          document.body.append(probe);
          const brand = getComputedStyle(probe).color;
          probe.remove();
          const read = (el: Element) => {
            const chain = [];
            for (let node: Element | null = el; node !== null; node = node.parentElement) {
              const style = getComputedStyle(node);
              chain.push({
                backgroundColor: style.backgroundColor,
                backgroundImage: style.backgroundImage,
                opacity: style.opacity,
              });
            }
            const style = getComputedStyle(el);
            return {
              line: style.textDecorationLine,
              color: style.textDecorationColor,
              thickness: style.textDecorationThickness,
              chain,
            };
          };
          return {
            brand,
            link: [...document.querySelectorAll(link!)].map(read),
            plain: [...document.querySelectorAll(plain!)].map(read),
          };
        },
        [REF_LINK, REF_PLAIN],
      );
      // 量具自檢：能點、不能點各一顆。
      expect([refs.link.length, refs.plain.length]).toEqual([1, 1]);
      const link = refs.link[0]!;
      const underline = worstOn(link.color, link.chain);
      report[`transcript-refs:${theme}:underline`] = {
        line: link.line,
        color: link.color,
        brand: refs.brand,
        thickness: link.thickness,
        ratio: round(underline.ratio),
        on: underline.on,
        plain: refs.plain[0]!.line,
      };
      expect([link.line, link.color, link.thickness]).toEqual(['underline', refs.brand, '2px']);
      expect(underline.ratio).toBeGreaterThanOrEqual(NON_TEXT_MIN);
      expect(refs.plain[0]!.line).toBe('none');
      const focus = await collectFocus(page);
      expect(focus.map((f) => f.name)).toEqual(['ref-link-0', 'reconnect-0']);
      expectFocus(focus, `transcript-refs:${theme}`);
    } finally {
      await page.close();
    }
  });

  test('G2：決定紀錄的 chip 是 Badge 的圓角，捲到底的鈕與「立刻重連」是 Button 的圓角', async () => {
    const page = await openOverlay('transcript-refs', theme, { marks: transcriptRefsMarks });
    try {
      const { probe, radii } = await readRadii(page, {
        chip: '[data-testid="decision-entry"]',
        scroll: '[data-slot="message-scroller-button"]',
        reconnect: '[data-guard-rows="status"] button',
      });
      report[`transcript-refs:${theme}:radii`] = { probe, radii };
      expect(radii).toEqual({ chip: [probe.capsule], scroll: [probe.sm], reconnect: [probe.sm] });
    } finally {
      await page.close();
    }
  });
});

describe.each<Theme>(['light', 'dark'])('瀏覽器量計劃與目標（#1692）：%s', (theme) => {
  test('Badge 不在 Tab 順序裡；跑著時「退出」停用並寫原因；字過 4.5、鈕有焦點外框', async () => {
    const page = await openOverlay('plan', theme, { marks: planMarks, prepare: failPlanExit });
    try {
      // 真的按 Tab 走（不看 tabIndex）：Badge 不在順序裡、停用的「退出」被跳過，都要從焦點實際停在哪看出來。
      await page.mouse.click(2, 2);
      const stops: string[] = [];
      for (let i = 0; i < 7; i += 1) {
        await page.keyboard.press('Tab');
        stops.push(
          await page.evaluate(() => {
            const el = document.activeElement!;
            const block = el.closest('[data-guard-plan]')?.getAttribute('data-guard-plan') ?? '';
            return `${block}:${el.getAttribute('data-slot') ?? el.tagName}:${el.textContent ?? ''}`;
          }),
        );
      }
      report[`plan:${theme}:tab`] = stops;
      expect(stops).toEqual([
        'chip:button:退出',
        'chip-failed:button:退出',
        'review:button:查看全文',
        'review:button:要求修改',
        'review:button:同意執行',
        'card:button:查看全文',
        'goal:BUTTON:',
      ]);
      // 停用的「退出」要滑鼠移得上去，`title` 的原因才跳得出來；移上去底色不變。
      const runningExit = page.locator(`[data-guard-plan="chip-running"] ${PLAN_EXIT}`);
      const readRunning = () =>
        runningExit.evaluate((el) => ({
          disabled: (el as HTMLButtonElement).disabled,
          title: el.getAttribute('title'),
          text: el.textContent,
          pointerEvents: getComputedStyle(el).pointerEvents,
          hovered: el.matches(':hover'),
          background: getComputedStyle(el).backgroundColor,
        }));
      const idle = await readRunning();
      await runningExit.hover();
      await settle(page);
      const hovered = await readRunning();
      await page.mouse.move(0, 0);
      report[`plan:${theme}:running`] = { idle, hovered };
      expect(hovered).toEqual({
        disabled: true,
        title: PLAN_CHIP_RUNNING_HINT,
        text: '退出',
        pointerEvents: 'auto',
        hovered: true,
        background: idle.background,
      });
      expectTexts(
        await collectTexts(page),
        ['plan-badge', 'plan-exit', 'plan-failure', 'plan-revise', 'plan-approve', 'plan-outcome'],
        `plan:${theme}`,
      );
      const focus = await collectFocus(page);
      expect(focus.map((f) => f.name)).toEqual([
        'plan-exit-0',
        'plan-exit-failed-0',
        'plan-open-0',
        'plan-revise-0',
        'plan-approve-0',
        'plan-open-1',
        'goal-pause-0',
      ]);
      expectFocus(focus, `plan:${theme}`);
    } finally {
      await page.close();
    }
  });

  test('375 寬：「退出」至少 44px 寬，「退出」、「查看全文」、審核兩顆都是 44px 高，頁面不橫向溢出', async () => {
    const page = await openOverlay('plan', theme, {
      marks: planMarks,
      viewport: { width: 375, height: 900 },
    });
    try {
      const sizes = await page.evaluate(() => {
        const heights = (selector: string) =>
          [...document.querySelectorAll(selector)].map((el) => el.getBoundingClientRect().height);
        return {
          exitWidth: Math.min(
            ...[
              ...document.querySelectorAll(
                '[data-guard-plan^="chip"] button[aria-label="退出計劃模式"]',
              ),
            ].map((el) => el.getBoundingClientRect().width),
          ),
          exit: heights('[data-guard-plan^="chip"] button[aria-label="退出計劃模式"]'),
          open: heights('[data-guard-plan] button[aria-label^="查看全文"]'),
          review: heights(
            '[data-guard-plan="review"] [data-testid="plan-review-panel"] > div:last-child > button',
          ),
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      report[`plan:${theme}:375`] = sizes;
      expect(sizes.exitWidth).toBeGreaterThanOrEqual(44);
      expect(sizes).toEqual({
        exitWidth: sizes.exitWidth,
        exit: [44, 44, 44],
        open: [44, 44],
        review: [44, 44],
        overflow: 0,
      });
    } finally {
      await page.close();
    }
  });

  test('G2（#1827）：Badge 與結果 chip 是 rounded-4xl，「退出」與「查看全文」是 rounded-sm，審核兩顆與暫停鈕是 rounded-md', async () => {
    const page = await openOverlay('plan', theme, { marks: planMarks });
    try {
      const { probe, radii } = await readRadii(page, {
        badge: '[data-guard-plan="chip"] [data-slot="badge"]',
        exit: '[data-guard-plan="chip"] button[aria-label="退出計劃模式"]',
        open: '[data-guard-plan] button[aria-label^="查看全文"]',
        review:
          '[data-guard-plan="review"] [data-testid="plan-review-panel"] > div:last-child > button',
        outcome: '[data-guard-plan="card"] [data-testid="plan-outcome"]',
        pause: '[data-guard-plan="goal"] [data-testid="goal-pause"]',
      });
      report[`plan:${theme}:radii`] = { probe, radii };
      expect(radii).toEqual({
        badge: [probe.capsule],
        exit: [probe.sm],
        open: [probe.sm, probe.sm],
        review: [probe.md, probe.md],
        outcome: [probe.capsule],
        pause: [probe.md],
      });
    } finally {
      await page.close();
    }
  });
});

describe.each<Theme>(['light', 'dark'])('瀏覽器量觀測分頁（#1690 PR A）：%s', (theme) => {
  test('T8：狀態膠囊九種收法的色調、字過 4.5、圓角是 rounded-4xl；完成與停在中斷點的圓點過 3，只有進行中帶 DotLoader', async () => {
    const page = await openOverlay('trace-heads', theme, { marks: tracePillMarks });
    try {
      expectTexts(
        await collectTexts(page),
        Object.keys(TRACE_TONES).map((name) => `pill-${name}`),
        `trace-heads:${theme}`,
      );
      const pills = await page.evaluate(
        (pill) =>
          Object.fromEntries(
            [...document.querySelectorAll('[data-guard-head]')].map((head) => {
              const el = head.querySelector(pill)!;
              return [
                head.getAttribute('data-guard-head'),
                `${el.getAttribute('data-tone')}:${el.querySelectorAll('.animate-dot-flash').length}`,
              ];
            }),
          ),
        TRACE_PILL,
      );
      expect(pills).toEqual(
        Object.fromEntries(
          Object.entries(TRACE_TONES).map(([name, tone]) => [
            name,
            `${tone}:${name === 'running' ? 3 : 0}`,
          ]),
        ),
      );
      // 色調畫在圓點上：點對膠囊底過非文字的門檻。
      const dots = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="trace-head-dot"]')].map((el) => {
          const chain = [];
          for (let node = el.parentElement; node !== null; node = node.parentElement) {
            const style = getComputedStyle(node);
            chain.push({
              backgroundColor: style.backgroundColor,
              backgroundImage: style.backgroundImage,
              opacity: style.opacity,
            });
          }
          return {
            head: el.closest('[data-guard-head]')!.getAttribute('data-guard-head') ?? '',
            color: getComputedStyle(el).backgroundColor,
            chain,
          };
        }),
      );
      const ratios = Object.fromEntries<number>(
        dots.map((dot) => [dot.head, round(worstOn(dot.color, dot.chain).ratio)]),
      );
      report[`trace-heads:${theme}:dots`] = ratios;
      expect(Object.keys(ratios)).toEqual(['done', 'waiting', 'question']);
      expect(Object.values(ratios).filter((ratio) => ratio < NON_TEXT_MIN)).toEqual([]);
      const { probe, radii } = await readRadii(page, { pill: TRACE_PILL });
      report[`trace-heads:${theme}:radii`] = { probe, radii };
      expect(radii.pill).toEqual(Object.keys(TRACE_TONES).map(() => probe.capsule));
    } finally {
      await page.close();
    }
  });

  test('T1：空狀態的標題與說明過 4.5', async () => {
    const page = await openOverlay('trace-empty', theme, {
      marks: {
        '[data-slot="empty-title"]': { 'data-guard-text': 'empty-title' },
        '[data-slot="empty-description"]': { 'data-guard-text': 'empty-hint' },
      },
    });
    try {
      expectTexts(await collectTexts(page), ['empty-title', 'empty-hint'], `trace-empty:${theme}`);
    } finally {
      await page.close();
    }
  });

  test('G2：計劃那一列的結果 chip 是 rounded-4xl、定位鈕是 rounded-md，定位鈕有焦點外框', async () => {
    const page = await openOverlay('trace-plan', theme, {
      marks: {
        '[data-testid="trace-plan-outcome"]': { 'data-guard-text': 'plan-outcome' },
        '[data-testid="trace-locate"]': { 'data-guard-focus': 'locate' },
      },
    });
    try {
      expectTexts(await collectTexts(page), ['plan-outcome'], `trace-plan:${theme}`);
      const focus = await collectFocus(page);
      expect(focus.map((f) => f.name)).toEqual(['locate-0', 'locate-1']);
      expectFocus(focus, `trace-plan:${theme}`);
      const { probe, radii } = await readRadii(page, {
        outcome: '[data-testid="trace-plan-outcome"]',
        locate: '[data-testid="trace-locate"]',
      });
      report[`trace-plan:${theme}:radii`] = { probe, radii };
      expect(radii).toEqual({ outcome: [probe.capsule], locate: [probe.md, probe.md] });
    } finally {
      await page.close();
    }
  });

  test('T6：載入細節的鈕與失敗原因過 4.5、鈕是 rounded-sm 並有焦點外框，失敗原因掛在重試鈕上', async () => {
    const page = await openOverlay('trace-groups', theme, {
      marks: { '[data-guard-reveal]': {} },
      prepare: revealTraceGroups,
    });
    try {
      expectTexts(
        await collectTexts(page),
        ['pull-idle', 'pull-retry', 'pull-failure'],
        `trace-groups:${theme}`,
      );
      const focus = await collectFocus(page);
      expect(focus.map((f) => f.name)).toEqual(['pull-retry', 'pull-idle']);
      expectFocus(focus, `trace-groups:${theme}`);
      const described = await page.evaluate(() => {
        const retry = document.querySelector('[data-guard-focus="pull-retry"]')!;
        const id = retry.getAttribute('aria-describedby') ?? '';
        return document.getElementById(id)?.getAttribute('data-testid') ?? null;
      });
      expect(described).toBe('trace-pull-failed');
      const { probe, radii } = await readRadii(page, { pull: `${TRACE_PULL} button` });
      report[`trace-groups:${theme}:radii`] = { probe, radii };
      expect(radii.pull).toEqual([probe.sm, probe.sm]);
    } finally {
      await page.close();
    }
  });

  test('T6：讀取中是一顆停用的鈕、字是待命那一句、名稱就是那句字，畫成 DotLoader 加字（只有摘要的組、更早的摘要、子代理），分頁只有一格 role=status', async () => {
    const expected = {
      buttons: 1,
      disabled: 'true',
      ariaLabel: null,
      dots: 3,
      text: '載入這一輪的細節',
    };
    const group = await openOverlay('trace-groups', theme, {
      marks: { '[data-guard-reveal]': {} },
      prepare: async (page) => {
        await loadTraceGroup(page);
        await page
          .locator(TRACE_LOADING)
          .locator('button')
          .evaluate((el) => el.setAttribute('data-guard-text', 'pull-loading'));
      },
    });
    try {
      expectTexts(await collectTexts(group), ['pull-loading'], `trace-groups-loading:${theme}`);
      const loading = await readTraceLoading(group);
      report[`trace-groups:${theme}:loading`] = loading;
      expect(loading).toEqual({ rows: [expected], status: 1 });
    } finally {
      await group.close();
    }
    const digests = await openOverlay('trace-digests', theme, {
      marks: { 'button[aria-expanded="false"]': {} },
      prepare: async (page) => {
        await page.getByRole('button', { name: /更早的/ }).click();
        await page.locator(TRACE_LOADING).nth(1).waitFor();
      },
    });
    try {
      const loading = await readTraceLoading(digests);
      report[`trace-digests:${theme}:loading`] = loading;
      expect(loading).toEqual({ rows: [expected, expected], status: 1 });
    } finally {
      await digests.close();
    }
    const subagent = await openOverlay('trace-subagent', theme, {
      marks: { '[data-testid="trace-row"]': {} },
      prepare: async (page) => {
        // 子代理的呼叫結構在派它的那顆工具列底下，展開工具列、再展開「子代理的呼叫結構」才拉。
        await page
          .locator('[data-testid="trace-row"] button[aria-expanded="false"]', {
            hasText: '委派子代理',
          })
          .click();
        await page.click('[data-testid="trace-subagent-block"] button[aria-expanded="false"]');
        await page.locator(TRACE_LOADING).waitFor();
      },
    });
    try {
      const loading = await readTraceLoading(subagent);
      report[`trace-subagent:${theme}:loading`] = loading;
      expect(loading).toEqual({ rows: [expected], status: 1 });
    } finally {
      await subagent.close();
    }
  });

  test('T6：375 寬時重試鈕與讀取中那一行都是 44px 高，頁面不橫向溢出', async () => {
    const page = await openOverlay('trace-groups', theme, {
      viewport: { width: 375, height: 812 },
      marks: { '[data-guard-reveal]': {} },
      prepare: async (page) => {
        // 「看第 1 輪」（`revealTurn`）自己會打開右側欄。
        await page.click('[data-guard-reveal]');
        await page.locator(`${traceTurn(300)} ${TRACE_PULL} button`).click();
        await page.locator(`${traceTurn(200)} ${TRACE_PULL}[data-status="failed"]`).waitFor();
        await page.locator(`${traceTurn(300)} ${TRACE_LOADING}`).waitFor();
      },
    });
    try {
      const sizes = await page.evaluate(
        ([turn200, turn300, pull]) => {
          const height = (selector: string) =>
            Math.round(document.querySelector(selector)!.getBoundingClientRect().height);
          return {
            retry: height(`${turn200} ${pull} button`),
            loading: height(`${turn300} ${pull} button`),
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          };
        },
        [traceTurn(200), traceTurn(300), TRACE_PULL],
      );
      report[`trace-groups:${theme}:375`] = sizes;
      expect(sizes).toEqual({ retry: 44, loading: 44, overflow: 0 });
    } finally {
      await page.close();
    }
  });
});

describe.each<Theme>(['light', 'dark'])('瀏覽器量觀測分頁的列（#1690 PR B）：%s', (theme) => {
  test('T3／T5／T7：列、時刻、數字格、欄位表、結果框、子代理計數的字過 4.5；列、計數、結果框有焦點外框；只有一格 role=status', async () => {
    const page = await openOverlay('trace-steps', theme, {
      marks: { [TRACE_ROW]: {} },
      prepare: openTraceSteps,
    });
    try {
      expectTexts(
        await collectTexts(page),
        [
          'step-row',
          'step-time',
          'static-row',
          'step-failed',
          'tile-term',
          'tile-value',
          'field-term',
          'field-value',
          'output',
          'group',
        ],
        `trace-steps:${theme}`,
      );
      const focus = await collectFocus(page);
      expect(focus.map((f) => f.name)).toEqual(['step-row', 'output', 'group']);
      expectFocus(focus, `trace-steps:${theme}`);
      expect(await page.locator('[role="status"]').count()).toBe(1);
    } finally {
      await page.close();
    }
  });

  test('375 寬：列 44px 高；失敗那一列的標題沒被截、後面那段不壓到箭頭與定位鈕；頁面不橫向溢出', async () => {
    const page = await openOverlay('trace-steps', theme, {
      viewport: { width: 375, height: 900 },
      marks: { 'button[aria-label="打開右側欄"]': {} },
      prepare: async (page) => {
        await page.click('button[aria-label="打開右側欄"]');
        await page.locator(`${TRACE_ROW}[data-kind="retry"]`).waitFor();
      },
    });
    try {
      const sizes = await page.evaluate(
        ([row, step]) => {
          const height = (selector: string) =>
            Math.round(document.querySelector(selector)!.getBoundingClientRect().height);
          return {
            step: height(`${row}[data-kind="input"] ${step}`),
            static: height(`${row}[data-kind="retry"] p`),
            ...(() => {
              // 失敗那一列的 trailing 最長（狀態、失敗碼、核准政策那句）。
              const failed = [...document.querySelectorAll(`${row}[data-kind="tool"]`)].find((el) =>
                el.querySelector('[data-testid="trace-error-code"]'),
              )!;
              const title = failed.querySelector(`${step} > span:first-child`)!;
              // 量標題後面那一段裡每個元素的右緣（字溢出時外層的框不會變），對箭頭；箭頭再對定位鈕。
              const button = failed.querySelector(step)!;
              const right = Math.max(
                ...[...button.querySelectorAll(':scope > span:nth-child(2) *')].map(
                  (el) => el.getBoundingClientRect().right,
                ),
              );
              const chevron = button.querySelector(':scope > svg')!.getBoundingClientRect();
              const locate = failed
                .querySelector('[data-testid="trace-locate"]')!
                .getBoundingClientRect();
              return {
                titleClipped: title.scrollWidth > title.clientWidth,
                overlapsChevron: right > chevron.left,
                overlapsLocate: chevron.right > locate.left,
              };
            })(),
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          };
        },
        [TRACE_ROW, TRACE_STEP] as const,
      );
      report[`trace-steps:${theme}:375`] = sizes;
      expect(sizes).toEqual({
        step: 44,
        static: 44,
        titleClipped: false,
        overlapsChevron: false,
        overlapsLocate: false,
        overflow: 0,
      });
    } finally {
      await page.close();
    }
  });

  test('1280 寬：列的字與右邊的定位鈕對齊（中心差 1px 以內）', async () => {
    const page = await openOverlay('trace-steps', theme, { marks: { [TRACE_ROW]: {} } });
    try {
      const offsets = await page.evaluate(
        ([row, step]) => {
          const center = (el: Element) => {
            const box = el.getBoundingClientRect();
            return box.top + box.height / 2;
          };
          return [...document.querySelectorAll(row)].flatMap((el) => {
            const locate = el.querySelector('[data-testid="trace-locate"]');
            const line = el.querySelector(`${step}, p`);
            if (locate === null || line === null) return [];
            return [
              {
                kind: el.getAttribute('data-kind'),
                offset: Math.round(center(line) - center(locate)),
              },
            ];
          });
        },
        [TRACE_ROW, TRACE_STEP] as const,
      );
      report[`trace-steps:${theme}:1280`] = offsets;
      // 量具自檢：能展開的（輸入、工具、模型呼叫、回覆）都量到了。
      expect(offsets.map((o) => o.kind)).toEqual(
        expect.arrayContaining(['input', 'tool', 'call', 'reply']),
      );
      expect(offsets.filter((o) => Math.abs(o.offset) > 1)).toEqual([]);
    } finally {
      await page.close();
    }
  });
});

describe.each<Theme>(['light', 'dark'])('瀏覽器量成本分頁與用量鈕（#1691）：%s', (theme) => {
  test('G2（#1691）：頂列的用量鈕跟 SG Badge 一樣是 rounded-4xl、字過 4.5、有焦點外框；成本分頁的總計與子代理列的字過 4.5', async () => {
    const page = await openOverlay('cost', theme, {
      marks: {
        '[data-guard-cost="usage"] [data-testid="session-usage"]': {
          'data-guard-text': 'usage',
          'data-guard-focus': 'usage',
        },
        '[data-testid="cost-totals"] dt': { 'data-guard-text': 'totals-term' },
        '[data-testid="cost-totals"] dd': { 'data-guard-text': 'totals-value' },
        '[data-testid="cost-subagent"] dd': { 'data-guard-text': 'subagent-value' },
      },
    });
    try {
      expectTexts(
        await collectTexts(page),
        ['usage', 'totals-term', 'totals-value', 'subagent-value'],
        `cost:${theme}`,
      );
      const focus = await collectFocus(page);
      expect(focus.map((f) => f.name)).toEqual(['usage-0']);
      expectFocus(focus, `cost:${theme}`);
      const { probe, radii } = await readRadii(page, {
        usage: '[data-guard-cost="usage"] [data-testid="session-usage"]',
      });
      report[`cost:${theme}:radii`] = { probe, radii };
      expect(radii).toEqual({ usage: [probe.capsule] });
    } finally {
      await page.close();
    }
  });
});

describe.each<Theme>(['light', 'dark'])('瀏覽器量沒有分頁的右側欄（#1696）：%s', (theme) => {
  test('G2（#1696）：收起鈕與「打開某面板」的鈕跟 SG Button 一樣是 rounded-md、有焦點外框；說明與鈕上的字過 4.5', async () => {
    const page = await openOverlay('right-empty', theme, {
      marks: {
        '[aria-label="右側欄"] [aria-label="收起右側欄"]': { 'data-guard-focus': 'collapse' },
        '[data-testid^="right-sidebar-open-"]': {
          'data-guard-text': 'open',
          'data-guard-focus': 'open',
        },
        '[data-testid="right-sidebar-empty"]': { 'data-guard-text': 'empty' },
      },
    });
    try {
      expectTexts(await collectTexts(page), ['empty', 'open'], `right-empty:${theme}`);
      const focus = await collectFocus(page);
      expect(focus.map((f) => f.name)).toEqual(['collapse-0', 'open-0', 'open-1']);
      expectFocus(focus, `right-empty:${theme}`);
      const { probe, radii } = await readRadii(page, {
        collapse: '[aria-label="右側欄"] [aria-label="收起右側欄"]',
        open: '[data-testid^="right-sidebar-open-"]',
      });
      report[`right-empty:${theme}:radii`] = { probe, radii };
      expect(radii).toEqual({ collapse: [probe.md], open: [probe.md, probe.md] });
    } finally {
      await page.close();
    }
  });
});

describe.each<Theme>(['light', 'dark'])('瀏覽器量會話清單的狀態（#1696 S1-C）：%s', (theme) => {
  const ROW = '[data-slot="sidebar-menu-item"] > [data-slot="sidebar-menu-button"]';
  const BAR_TOKEN: Record<string, string> = {
    approval: '--status-interrupted',
    question: '--status-interrupted',
    'plan-review': '--status-interrupted',
    running: '--brand',
    completed: '--success',
  };

  test.each([
    { width: 375, height: 812 },
    { width: 1024, height: 900 },
  ])(
    'S1（#1696）：$width 寬時字過 4.5、色條是狀態的顏色、報讀只唸一次狀態、標題沒被擠掉',
    async (viewport) => {
      const page = await openOverlay('thread-statuses', theme, {
        viewport,
        clock: THREAD_CLOCK,
        marks: {
          // 目前這條是 disabled（整列 opacity 0.5），對比門檻不管停用的元件，只量能點的列。
          [`${ROW}:not([disabled]) [data-testid="thread-title-text"]`]: {
            'data-guard-text': 'title',
          },
          [`${ROW}:not([disabled]) [data-testid="thread-status"]`]: { 'data-guard-text': 'status' },
          [`${ROW}:not([disabled])`]: { 'data-guard-focus': 'row' },
        },
      });
      const key = `thread-statuses:${theme}:${viewport.width}`;
      try {
        expectTexts(await collectTexts(page), ['title', 'status'], key);
        const focus = await collectFocus(page);
        expect(focus.map((f) => f.name)).toEqual([
          'row-0',
          'row-1',
          'row-2',
          'row-3',
          'row-4',
          'row-5',
        ]);
        expectFocus(focus, key);

        const rows = await page.$$eval(
          ROW,
          (buttons, tokens) => {
            const probe = document.createElement('span');
            document.body.append(probe);
            const colorOf = (token: string) => {
              probe.style.backgroundColor = `var(${token})`;
              return getComputedStyle(probe).backgroundColor;
            };
            const out = buttons.map((button) => {
              const bar = button.querySelector<HTMLElement>('[data-testid="thread-status-bar"]')!;
              const title = button.querySelector<HTMLElement>('[data-testid="thread-title-text"]')!;
              const status = button.querySelector('[data-testid="thread-status"]');
              const kind = status?.getAttribute('data-status') ?? null;
              const line = title.nextElementSibling as HTMLElement | null;
              const titleBox = title.getBoundingClientRect();
              return {
                title: title.textContent,
                kind,
                barWidth: bar.getBoundingClientRect().width,
                barColor: getComputedStyle(bar).backgroundColor,
                want: kind === null ? 'rgba(0, 0, 0, 0)' : colorOf(tokens[kind]!),
                titleWidth: Math.round(titleBox.width),
                // 標題獨佔一行：第二行在標題下面，不跟它並排。
                ownLine: line === null || line.getBoundingClientRect().top >= titleBox.bottom - 1,
                lineOverflow: line === null ? 0 : line.scrollWidth - line.clientWidth,
              };
            });
            probe.remove();
            return out;
          },
          BAR_TOKEN,
        );
        report[`${key}:rows`] = rows;
        expect(rows).toHaveLength(7);
        for (const row of rows) {
          expect(row.barWidth).toBe(3);
          expect(row.barColor).toBe(row.want);
          expect(row.titleWidth).toBeGreaterThanOrEqual(150);
          expect(row.ownLine).toBe(true);
        }
        // 第二行放不下就截（帶省略號）。在 THREAD_CLOCK 那個時刻只有目前這條會截，其餘每列都放得下。
        expect(rows.filter((row) => row.lineOverflow > 0).map((row) => row.title)).toEqual([
          '部署腳本除錯',
        ]);

        // 報讀名稱用瀏覽器算的（ariaSnapshot）：狀態字只出現一次。
        const buttons = page.locator(ROW);
        for (let i = 0; i < rows.length; i += 1) {
          const { kind } = rows[i]!;
          if (kind === null) continue;
          const label = await buttons.nth(i).locator('[data-testid="thread-status"]').textContent();
          const snapshot = await buttons.nth(i).ariaSnapshot();
          expect(snapshot.split(label!).length - 1, `${rows[i]!.title}：${snapshot}`).toBe(1);
        }
      } finally {
        await page.close();
      }
    },
  );
});
