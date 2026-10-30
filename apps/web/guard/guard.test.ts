// @vitest-environment node
import { type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { parseColor, shadowLayers } from '../src/styles/color-math';

import {
  CHIP_STATES,
  CHIP_STATUS,
  type ChipSample,
  type ChoiceSample,
  type FieldSample,
  type FocusSample,
  type HoverSample,
  MODES,
  OVERLAYS,
  OVERLAY_SHADOW_LIMITS,
  PRESS_STATES,
  type PressSample,
  REQUIRED_TEXTS,
  SHADOWED,
  SHADOW_LIMITS,
  STATUS_MIN,
  type ShadowSample,
  TEXT_MIN,
  type TextSample,
  type Theme,
  collectBackdrops,
  collectChips,
  collectChoices,
  collectFields,
  collectFocus,
  collectHovers,
  collectPresses,
  collectShadows,
  collectSurfaces,
  collectTexts,
  expectFocus,
  expectTexts,
  open,
  openOverlay,
  report,
  round,
  worstContrast,
  worstOn,
} from './harness';

test('量具自檢：往上任一層的 opacity 不是 1 就判不合格，全是 1 才照常算', () => {
  const layer = (backgroundColor: string, opacity = '1') => ({
    backgroundColor,
    backgroundImage: 'none',
    opacity,
  });
  expect(worstOn('rgb(0, 0, 0)', [layer('rgb(255, 255, 255)')]).ratio).toBe(21);
  expect(
    worstOn('rgb(0, 0, 0)', [layer('rgba(0, 0, 0, 0)'), layer('rgb(255, 255, 255)', '0.5')]),
  ).toEqual({ ratio: 0, on: '往上第 1 層的 opacity 是 0.5，量具不算整組透明度' });
});

describe.each<Theme>(['light', 'dark'])('瀏覽器量出貨的 CSS：%s', (theme) => {
  let page: Page;
  let texts: TextSample[];
  let focus: FocusSample[];
  let fields: FieldSample[];
  let docked: { borderTopWidth: string; boxShadow: string }[];
  let located: { borderTopLeftRadius: string; backgroundColor: string }[];
  let shadows: ShadowSample[];
  let chips: ChipSample[];
  let choices: ChoiceSample[];
  let hovers: HoverSample[];
  let presses: PressSample[];
  let glass: { name: string; backdropFilter: string }[];
  let expanded: Record<
    string,
    { backgroundColor: string; ariaExpanded: string | null; popupOpen: boolean }
  >;
  let groups: Record<string, { opacity: string; backgroundColor: string }>;

  beforeAll(async () => {
    page = await open(theme);
    texts = await collectTexts(page);
    shadows = await collectShadows(page);
    chips = await collectChips(page);
    choices = await collectChoices(page);
    hovers = await collectHovers(page);
    presses = await collectPresses(page);
    glass = await page.$$eval('[data-guard-glass]', (els) =>
      els.map((el) => ({
        name: el.getAttribute('data-guard-glass') ?? '',
        backdropFilter: getComputedStyle(el).backdropFilter,
      })),
    );
    expanded = Object.fromEntries(
      await page.$$eval('[data-guard-expanded]', (els) =>
        els.map((el) => [
          el.getAttribute('data-guard-expanded') ?? '',
          {
            backgroundColor: getComputedStyle(el).backgroundColor,
            ariaExpanded: el.getAttribute('aria-expanded'),
            popupOpen: el.hasAttribute('data-popup-open'),
          },
        ]),
      ),
    );
    groups = Object.fromEntries(
      await page.$$eval('[data-guard-opacity]', (els) =>
        els.map((el) => {
          const style = getComputedStyle(el);
          return [
            el.getAttribute('data-guard-opacity') ?? '',
            { opacity: style.opacity, backgroundColor: style.backgroundColor },
          ];
        }),
      ),
    );
    focus = await collectFocus(page);
    fields = await collectFields(page);
    docked = await page.$$eval('[data-guard-docked]', (els) =>
      els.map((el) => {
        const style = getComputedStyle(el);
        return { borderTopWidth: style.borderTopWidth, boxShadow: style.boxShadow };
      }),
    );
    located = await page.$$eval('[data-guard-located]', (els) =>
      els.map((el) => {
        const style = getComputedStyle(el);
        return {
          borderTopLeftRadius: style.borderTopLeftRadius,
          backgroundColor: style.backgroundColor,
        };
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await page?.close();
  });

  test('量具有抓到東西：每個標了的元素都量到', () => {
    expect(texts.map((t) => t.name)).toEqual(expect.arrayContaining(REQUIRED_TEXTS));
    expect(focus.map((f) => f.name)).toEqual(
      expect.arrayContaining([
        'button-default',
        'input-group',
        'sidebar-menu-button',
        'sidebar-menu-action',
        'sidebar-trigger',
      ]),
    );
    expect(shadows.length).toBeGreaterThan(0);
  });

  test('每個字對它實際的底色過門檻（往上疊到不透明為止、漸層取最差的停點）', () => {
    const measured = texts.map((t) => ({ name: t.name, min: t.min, ...worstContrast(t) }));
    report[`${theme}:contrast`] = measured.map((m) => ({ ...m, ratio: round(m.ratio) }));
    expect(
      measured
        .filter((m) => !(m.ratio >= m.min))
        .map((m) => `${m.name} ${round(m.ratio)} < ${m.min}（${m.on}）`),
    ).toEqual([]);
  });

  test('鍵盤焦點：box-shadow 不帶 ring（跟沒聚焦時一樣），外框是 2px 實線、頁面的字色', () => {
    expectFocus(focus, theme);
  });

  test('欄位聚焦：邊框四邊都換成頁面的字色', () => {
    report[`${theme}:fields`] = fields;
    // 量具自檢：四種欄位都量到、真的在 `:focus-visible`，而且聚焦前後邊框有變（量到的是聚焦的樣子，不是平常的邊框）。
    expect(fields.map((f) => f.name).sort()).toEqual([
      'input',
      'input-group',
      'sidebar-input',
      'textarea',
    ]);
    expect(fields.filter((f) => !f.focusVisible).map((f) => f.name)).toEqual([]);
    expect(
      fields
        .filter((f) => JSON.stringify(f.borderBefore) === JSON.stringify(f.borderAfter))
        .map((f) => f.name),
    ).toEqual([]);
    expect(
      fields
        .filter((f) => f.borderAfter.some((c) => c !== f.pageColor))
        .map((f) => `${f.name}：${f.borderAfter.join(' ')}（字色 ${f.pageColor}）`),
    ).toEqual([]);
  });

  test('輸入框底列的 Pick 平常、滑鼠移上去、清單開著，12px 的次要字過 4.5；「全開」平常與移上去是警示色、清單開著換回字色（#1591）', () => {
    const measured = chips.map((c) => ({
      key: `${c.name}:${c.state}`,
      ...c,
      min: CHIP_STATUS.has(`${c.name}:${c.state}`) ? STATUS_MIN : TEXT_MIN,
      ...worstOn(c.color, c.chain),
    }));
    report[`${theme}:chips`] = measured.map((m) => ({
      key: m.key,
      min: m.min,
      color: m.color,
      backgroundColor: m.backgroundColor,
      on: m.on,
      ratio: Math.round(m.ratio * 10000) / 10000,
    }));
    // 量具自檢：兩顆 Pick 都量到三種狀態、真的在那個狀態。
    expect(measured.map((m) => m.key)).toEqual(
      ['pick', 'pick-danger'].flatMap((name) => CHIP_STATES.map((state) => `${name}:${state}`)),
    );
    expect(measured.filter((m) => !m.inState).map((m) => m.key)).toEqual([]);
    // 一般的 Pick 移上去換成字色（vendor 的 `hover:text-foreground`，量具自檢：量到的確實是 hover）；「全開」那顆平常與移上去
    // 是同一個警示色，跟一般那顆的次要色、字色都不同（拿掉覆寫檔第 35 條，它會跟一般那顆一樣）；開著時跟一般那顆一樣是字色。
    const color = (key: string) => measured.find((m) => m.key === key)?.color;
    expect(color('pick:hover')).not.toBe(color('pick:rest'));
    expect(color('pick-danger:hover')).toBe(color('pick-danger:rest'));
    expect(color('pick-danger:rest')).not.toBe(color('pick:rest'));
    expect(color('pick-danger:rest')).not.toBe(color('pick:hover'));
    expect(color('pick-danger:open')).toBe(color('pick:open'));
    expect(
      measured
        .filter((m) => !(m.ratio >= m.min))
        .map((m) => `${m.key} ${m.ratio.toFixed(4)} < ${m.min}（${m.on}）`),
    ).toEqual([]);
  });

  test('頂列用量鈕：平常的次要字、移上去與按著的 foreground（SG 的 --hover，按著跟移上去同一階）都過 4.5', () => {
    const measured = presses.map((p) => ({
      key: `${p.name}:${p.state}`,
      ...p,
      ...worstOn(p.color, p.chain),
    }));
    report[`${theme}:presses`] = measured.map((m) => ({
      key: m.key,
      color: m.color,
      backgroundColor: m.backgroundColor,
      on: m.on,
      ratio: Math.round(m.ratio * 10000) / 10000,
    }));
    // 量具自檢：三種狀態都量到、真的在那個狀態；移上去真的換了底（`bg-card` 之類蓋掉的話會跟平常一樣），按著跟移上去同一階。
    expect(measured.map((m) => m.key)).toEqual(
      PRESS_STATES.map((state) => `session-usage:${state}`),
    );
    expect(measured.filter((m) => !m.inState).map((m) => m.key)).toEqual([]);
    const by = Object.fromEntries(measured.map((m) => [m.state, m]));
    expect(by.hover!.backgroundColor).not.toBe(by.rest!.backgroundColor);
    expect(by.pressed!.backgroundColor).toBe(by.hover!.backgroundColor);
    // 移上去與按著的字是 foreground（跟平常的次要字不同色）。
    expect(by.hover!.color).not.toBe(by.rest!.color);
    expect(by.pressed!.color).toBe(by.hover!.color);
    expect(
      measured
        .filter((m) => !(m.ratio >= TEXT_MIN))
        .map((m) => `${m.key} ${m.ratio.toFixed(4)} < ${TEXT_MIN}（${m.on}）`),
    ).toEqual([]);
  });

  test('問答的選項：勾選的底蓋得過卡片、移上去不變，勾選框只填勾選的那個，停用的半透明、點不到（shadcn 的 data-* variant，#1523）', () => {
    report[`${theme}:choices`] = choices;
    const by = Object.fromEntries(choices.map((c) => [c.name, c]));
    const { checked, unchecked, disabled } = by;
    expect(Object.keys(by).sort()).toEqual(['checked', 'disabled', 'unchecked']);
    // 量具自檢：真的移上去了。
    expect([checked!.hovered, unchecked!.hovered]).toEqual([true, true]);
    // 勾選的底跟沒勾選的不一樣（data-checked 要蓋得過 SG 的 `.bg-card`），移上去也不變。
    // 沒勾選的移上去不是這裡要守的行為，不斷言。
    expect(checked!.rest).not.toBe(unchecked!.rest);
    expect(checked!.hover).toBe(checked!.rest);
    // group-data-checked：勾選框只有勾選的那一個填上 primary。
    expect(checked!.indicator).not.toBe(unchecked!.indicator);
    expect([disabled!.opacity, disabled!.pointerEvents, disabled!.cursor]).toEqual([
      '0.5',
      'none',
      'not-allowed',
    ]);
    expect([unchecked!.opacity, unchecked!.pointerEvents]).toEqual(['1', 'auto']);
  });

  test('destructive 按鈕：平常與 hover 的字對底色都過 4.5（hover 底由覆寫檔調淡，#1523 第 17 條）', () => {
    const measured = hovers.map((h) => ({
      key: `${h.name}:${h.state}`,
      ...h,
      ...worstOn(h.color, h.chain),
    }));
    report[`${theme}:hovers`] = measured.map((m) => ({
      key: m.key,
      backgroundColor: m.backgroundColor,
      on: m.on,
      ratio: round(m.ratio),
    }));
    // 量具自檢：兩顆都量到兩種狀態、真的在那個狀態，hover 的底跟平常不一樣（量到的是 hover 那一層）。
    expect(measured.map((m) => m.key)).toEqual(
      ['button-destructive', 'button-destructive-card'].flatMap((n) => [`${n}:rest`, `${n}:hover`]),
    );
    expect(measured.filter((m) => !m.inState).map((m) => m.key)).toEqual([]);
    for (const name of ['button-destructive', 'button-destructive-card'])
      expect(
        new Set(measured.filter((m) => m.name === name).map((m) => m.backgroundColor)).size,
      ).toBe(2);
    expect(
      measured
        .filter((m) => !(m.ratio >= TEXT_MIN))
        .map((m) => `${m.key} ${round(m.ratio)} < ${TEXT_MIN}（${m.on}）`),
    ).toEqual([]);
  });

  test('SG 的玻璃按鈕吃到 SG 的規則：outline、secondary、glass 都有 backdrop-filter（data-variant 命中 solid-glass.css:642-679，#1523）', () => {
    report[`${theme}:glass`] = glass;
    expect(glass.map((g) => g.name).sort()).toEqual(['glass', 'outline', 'secondary']);
    expect(glass.filter((g) => g.backdropFilter === 'none').map((g) => g.name)).toEqual([]);
  });

  test('浮層 Trigger（render 接 Base UI 的 Button）開著時掛 data-popup-open 與 aria-expanded，SG 換成按下去的底色（#1523、#1583）', () => {
    report[`${theme}:expanded`] = expanded;
    expect(expanded.trigger?.ariaExpanded).toBe('true');
    expect(expanded.trigger?.popupOpen).toBe(true);
    expect(expanded.reference?.ariaExpanded).toBeNull();
    expect(expanded.reference?.popupOpen).toBe(false);
    expect(expanded.trigger?.backgroundColor).not.toBe(expanded.reference?.backgroundColor);
  });

  test('輸入框群組只在欄位停用時變淡：只有送出鈕停用的不透明、底色跟一般的一樣，欄位停用的是 0.5（#1523 第 18 條）', () => {
    report[`${theme}:input-group-opacity`] = groups;
    expect(Object.keys(groups).sort()).toEqual(['control-disabled', 'reference', 'send-disabled']);
    expect(groups['send-disabled']).toEqual(groups.reference);
    expect(groups.reference!.opacity).toBe('1');
    expect(groups['control-disabled']!.opacity).toBe('0.5');
  });

  test('對話裡被定位的那一則：圓角真的畫出來（--radius-3xl 有宣告），底色有畫出來', () => {
    report[`${theme}:located`] = located;
    expect(located).toHaveLength(1);
    const [only] = located;
    // 量具自檢：規則真的套上了（底色不是透明），圓角是 0 才算數，不是整條規則沒中。
    expect(parseColor(only!.backgroundColor).alpha).toBeGreaterThan(0);
    expect(Number.parseFloat(only!.borderTopLeftRadius)).toBeGreaterThan(0);
  });

  test('貼在輸入框上方的卡片是平的：邊 1px、沒有投影', () => {
    report[`${theme}:docked`] = docked;
    expect(docked).toEqual([{ borderTopWidth: '1px', boxShadow: 'none' }]);
  });

  // 只有亮色有上限：暗底上投影要更濃才看得到（同 `shadow-alpha.test.ts`）。暗色不定義這條，不是跳過。
  if (theme === 'light')
    test('亮色陰影：每層投影的透明度不超過該元素的上限（邊緣那一層、inset 的高光與凹槽不算）', () => {
      const layers = shadows.flatMap((s) =>
        shadowLayers(s.boxShadow)
          .filter((l) => !l.edge && !l.inset && l.color !== undefined)
          .map((l) => ({ name: s.name, alpha: parseColor(l.color ?? '').alpha })),
      );
      report[`${theme}:shadow`] = layers;
      // 量具自檢：Tailwind 清掉的層是全透明的（alpha 0），不算數；看得見的投影要正好落在這幾個元素上，
      // 投影整個消失或搬到別的元素上都紅，不讓「沒量到」看起來像「全部達標」。
      expect(new Set(layers.filter((l) => l.alpha > 0).map((l) => l.name))).toEqual(
        new Set(SHADOWED),
      );
      expect(
        layers
          .filter((l) => !(l.alpha <= (SHADOW_LIMITS[l.name] ?? 0)))
          .map((l) => `${l.name} ${l.alpha} > ${SHADOW_LIMITS[l.name]}`),
      ).toEqual([]);
    });
});

/** 不透明的兩種退路：面真的不透明、字一樣過門檻。 */
describe.each(
  MODES.filter((m) => m !== 'translucent').flatMap((mode) =>
    (['light', 'dark'] as const).map((theme) => [mode, theme] as const),
  ),
)('瀏覽器量出貨的 CSS：%s、%s', (mode, theme) => {
  let page: Page;
  let texts: TextSample[];
  let surfaces: { name: string; backgroundColor: string; backdropFilter: string }[];

  beforeAll(async () => {
    page = await open(theme, mode);
    texts = await collectTexts(page);
    surfaces = await page.$$eval('[data-guard-surface]', (els) =>
      els.map((el) => {
        const style = getComputedStyle(el);
        return {
          name: el.getAttribute('data-guard-surface') ?? '',
          backgroundColor: style.backgroundColor,
          backdropFilter: style.backdropFilter,
        };
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await page?.close();
  });

  test('面是不透明的、沒有 blur', () => {
    report[`${mode}:${theme}:surfaces`] = surfaces;
    expect(surfaces.map((s) => s.name).sort()).toEqual(['card', 'popover', 'sidebar', 'tooltip']);
    expect(
      surfaces
        .filter((s) => parseColor(s.backgroundColor).alpha !== 1 || s.backdropFilter !== 'none')
        .map((s) => `${s.name}：${s.backgroundColor}、backdrop-filter ${s.backdropFilter}`),
    ).toEqual([]);
  });

  test('每個字對它實際的底色過門檻', () => {
    // 量具自檢：不透明的頁面也真的量到字，不然下面那條在空陣列上會綠。
    expect(texts.map((t) => t.name)).toEqual(expect.arrayContaining(REQUIRED_TEXTS));
    const measured = texts.map((t) => ({ name: t.name, min: t.min, ...worstContrast(t) }));
    report[`${mode}:${theme}:contrast`] = measured.map((m) => ({ ...m, ratio: round(m.ratio) }));
    expect(
      measured
        .filter((m) => !(m.ratio >= m.min))
        .map((m) => `${m.name} ${round(m.ratio)} < ${m.min}（${m.on}）`),
    ).toEqual([]);
  });
});

describe.each(
  OVERLAYS.flatMap((overlay) =>
    (['light', 'dark'] as const).map((theme) => [overlay.name, theme, overlay] as const),
  ),
)('瀏覽器量 modal 浮層（#1583）：%s、%s', (_name, theme, overlay) => {
  const key = `${overlay.name}:${theme}`;
  let page: Page;
  let texts: TextSample[];
  let focus: FocusSample[];
  let shadows: ShadowSample[];
  let backdrops: { name: string; backdropFilter: string }[];
  let borders: { name: string; widths: string[] }[];
  let rows: { name: string; backgroundColor: string; highlighted: boolean; selected: boolean }[];
  let shown: Record<string, string>;
  let checks: { name: string; visible: string[]; hidden: number }[];

  beforeAll(async () => {
    page = await openOverlay(overlay.name, theme, {
      ...(overlay.viewport === undefined ? {} : { viewport: overlay.viewport }),
      marks: overlay.marks,
      ...(overlay.prepare === undefined ? {} : { prepare: overlay.prepare }),
    });
    texts = await collectTexts(page);
    rows = await page.$$eval(
      '[data-guard-text^="dropdown-item"], [data-guard-text^="command-item"]',
      (els) =>
        els.map((el) => ({
          name: el.getAttribute('data-guard-text') ?? '',
          backgroundColor: getComputedStyle(el).backgroundColor,
          highlighted: el.hasAttribute('data-highlighted'),
          selected: el.getAttribute('data-selected') === 'true',
        })),
    );
    shown = Object.fromEntries(
      await page.$$eval('[data-guard-shown]', (els) =>
        els.map((el) => [el.getAttribute('data-guard-shown') ?? '', getComputedStyle(el).opacity]),
      ),
    );
    checks = await page.$$eval('[data-guard-checks]', (els) =>
      els.map((el) => {
        const svgs = [...el.querySelectorAll('svg')];
        const isVisible = (svg: Element) => {
          const box = svg.getBoundingClientRect();
          return getComputedStyle(svg).display !== 'none' && box.width > 0 && box.height > 0;
        };
        return {
          name: el.getAttribute('data-guard-checks') ?? '',
          visible: svgs.filter(isVisible).map((svg) => svg.getAttribute('aria-label') ?? ''),
          hidden: svgs.filter((svg) => !isVisible(svg)).length,
        };
      }),
    );
    shadows = await collectShadows(page);
    backdrops = await collectBackdrops(page);
    borders = await page.$$eval('[data-guard-border]', (els) =>
      els.map((el) => {
        const style = getComputedStyle(el);
        return {
          name: el.getAttribute('data-guard-border') ?? '',
          widths: [
            style.borderTopWidth,
            style.borderRightWidth,
            style.borderBottomWidth,
            style.borderLeftWidth,
          ],
        };
      }),
    );
    focus = await collectFocus(page);
  }, 60_000);

  afterAll(async () => {
    await page?.close();
  });

  test('字對它實際的底色過門檻', () => {
    expectTexts(texts, overlay.texts, key);
  });

  if (overlay.focus.length > 0)
    test('鍵盤焦點（關閉鈕、確認框的按鈕、搜尋框）：不帶 ring，外框是 2px 實線、頁面的字色', () => {
      expect(focus.map((f) => f.name).sort()).toEqual([...overlay.focus].sort());
      expectFocus(focus, key);
    });

  if (overlay.backdrops.length > 0)
    test('遮罩照 SG 有 blur（量具自檢：不透明的退路那邊量到 none 才算數）', () => {
      report[`${key}:backdrops`] = backdrops;
      expect(backdrops.map((b) => b.name)).toEqual(overlay.backdrops);
      expect(backdrops.filter((b) => b.backdropFilter === 'none').map((b) => b.name)).toEqual([]);
    });

  if (overlay.name === 'dropdown') {
    test('滑鼠移上去的選項掛 data-highlighted、底色跟平常的不同（量具自檢：上面量的確實是兩種狀態）', () => {
      report[`${key}:rows`] = rows;
      expect(rows.map((r) => [r.name, r.highlighted])).toEqual([
        ['dropdown-item', false],
        ['dropdown-item-highlighted', true],
      ]);
      expect(rows[0]!.backgroundColor).not.toBe(rows[1]!.backgroundColor);
    });

    test('「⋯」選單開著時看得見（Trigger 開著掛 aria-expanded，vendor 的 SidebarMenuAction 認它）', () => {
      report[`${key}:shown`] = shown;
      // 量具自檢：lg 寬度下沒開的「⋯」照樣藏著（滑過那一列才現身）。
      expect(shown).toEqual({ open: '1', closed: '0' });
    });
  }

  if (overlay.name === 'command') {
    test('選中與沒選中的選項底色不同（量具自檢：上面量的確實是兩種狀態）', () => {
      report[`${key}:rows`] = rows;
      const selected = rows.filter((r) => r.selected);
      expect(selected.map((r) => r.name)).toEqual(['command-item-selected']);
      expect(rows.filter((r) => !r.selected).length).toBeGreaterThan(0);
      expect(
        rows.filter((r) => !r.selected && r.backgroundColor === selected[0]!.backgroundColor),
      ).toEqual([]);
    });

    test('勾選的那一列只有一顆看得見的勾，報讀名稱是「目前選的」（vendor 附的那顆藏掉，本地修改第 27 條）', () => {
      report[`${key}:checks`] = checks;
      // 量具自檢：vendor 那顆確實在 DOM 裡、只是看不見。
      expect(checks).toEqual([{ name: 'checked', visible: ['目前選的'], hidden: 1 }]);
    });
  }

  if (overlay.name === 'mobile-sidebar')
    test('手機側欄的抽屜只留陰影、四邊都沒有邊（本地修改第 21 條）', () => {
      report[`${key}:borders`] = borders;
      expect(borders).toEqual([{ name: 'mobile-sidebar', widths: ['0px', '0px', '0px', '0px'] }]);
    });

  if (theme === 'light' && overlay.name in OVERLAY_SHADOW_LIMITS)
    test('亮色陰影：每層投影的透明度不超過上限', () => {
      const layers = shadows.flatMap((s) =>
        shadowLayers(s.boxShadow)
          .filter((l) => !l.edge && !l.inset && l.color !== undefined)
          .map((l) => ({ name: s.name, alpha: parseColor(l.color ?? '').alpha })),
      );
      report[`${key}:shadow`] = layers;
      // 量具自檢：這個浮層真的有看得見的投影。
      expect(new Set(layers.filter((l) => l.alpha > 0).map((l) => l.name))).toEqual(
        new Set([overlay.name]),
      );
      expect(
        layers
          .filter((l) => !(l.alpha <= (OVERLAY_SHADOW_LIMITS[l.name] ?? 0)))
          .map((l) => `${l.name} ${l.alpha} > ${OVERLAY_SHADOW_LIMITS[l.name]}`),
      ).toEqual([]);
    });
});

/** modal 浮層在不透明的兩種退路下：面不透明、面與遮罩都沒有 blur（本地修改第 22 條）、字照樣過門檻。 */
describe.each(
  MODES.filter((m) => m !== 'translucent').flatMap((mode) =>
    OVERLAYS.flatMap((overlay) =>
      (['light', 'dark'] as const).map((theme) => [mode, overlay.name, theme, overlay] as const),
    ),
  ),
)('瀏覽器量 modal 浮層（#1583）：%s、%s、%s', (mode, _name, theme, overlay) => {
  const key = `${mode}:${overlay.name}:${theme}`;
  let page: Page;
  let texts: TextSample[];
  let surfaces: { name: string; backgroundColor: string; backdropFilter: string }[];
  let backdrops: { name: string; backdropFilter: string }[];

  beforeAll(async () => {
    page = await openOverlay(overlay.name, theme, {
      mode,
      ...(overlay.viewport === undefined ? {} : { viewport: overlay.viewport }),
      marks: overlay.marks,
      ...(overlay.prepare === undefined ? {} : { prepare: overlay.prepare }),
    });
    texts = await collectTexts(page);
    surfaces = await collectSurfaces(page);
    backdrops = await collectBackdrops(page);
  }, 60_000);

  afterAll(async () => {
    await page?.close();
  });

  test('面不透明、面與遮罩都沒有 blur', () => {
    report[`${key}:surfaces`] = surfaces;
    report[`${key}:backdrops`] = backdrops;
    expect(surfaces.map((s) => s.name)).toEqual(overlay.surfaces);
    expect(backdrops.map((b) => b.name)).toEqual(overlay.backdrops);
    expect(
      surfaces
        .filter((s) => parseColor(s.backgroundColor).alpha !== 1 || s.backdropFilter !== 'none')
        .map((s) => `${s.name}：${s.backgroundColor}、backdrop-filter ${s.backdropFilter}`),
    ).toEqual([]);
    expect(backdrops.filter((b) => b.backdropFilter !== 'none').map((b) => b.name)).toEqual([]);
  });

  test('字對它實際的底色過門檻', () => {
    expectTexts(texts, overlay.texts, key);
  });
});
