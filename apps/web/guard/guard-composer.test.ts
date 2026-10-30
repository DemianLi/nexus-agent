// @vitest-environment node
import { type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { parseColor } from '../src/styles/color-math';

import {
  COMPOSER_MAIN_ENABLED,
  COMPOSER_STATES,
  type FocusSample,
  MODES,
  NON_TEXT_MIN,
  OVERLAYS,
  RING,
  SCROLL_BUTTON,
  type TextSample,
  WIDTHS,
  WIDTH_MARKS,
  collectFocus,
  collectSurfaces,
  collectTexts,
  composerMarks,
  expectFocus,
  expectTexts,
  footerMarks,
  open,
  openOverlay,
  report,
  scrollMessages,
  settle,
} from './harness';

describe('瀏覽器量 modal 浮層的版面與動效（#1583）', () => {
  test.each(WIDTHS)(
    '呼叫端的寬度：$overlay 在 $viewport.width 寬是 $px px',
    async ({ overlay, viewport, mark, px }) => {
      const page = await openOverlay(overlay, 'light', { viewport, marks: WIDTH_MARKS[overlay]! });
      try {
        const width = await page.$eval(
          `[data-guard-width="${mark}"]`,
          (el) => el.getBoundingClientRect().width,
        );
        report[`width:${overlay}:${viewport.width}`] = width;
        expect(width).toBe(px);
      } finally {
        await page.close();
      }
    },
  );

  test.each(['sheet', 'mobile-sidebar'])(
    'reduced-motion 下 %s 的抽屜不位移、transition 時長 ≤ 150ms（本地修改第 23 條）',
    async (name) => {
      const overlay = OVERLAYS.find((o) => o.name === name)!;
      const marks =
        name === 'sheet'
          ? { ...overlay.marks, '[data-slot="sheet-content"]': { 'data-guard-motion': 'sheet' } }
          : overlay.marks;
      const read = async (reducedMotion: boolean) => {
        const page = await openOverlay(name, 'light', {
          ...(overlay.viewport === undefined ? {} : { viewport: overlay.viewport }),
          reducedMotion,
          marks,
        });
        try {
          // 位移只寫在 `data-ending-style`／`data-starting-style` 上（開好之後本來就是 none），掛上那個屬性再量才看得到；
          // 掛的當下 transition 才剛開始，計算值是起點，所以先把 transition 關掉再量目標位移。時長在關掉之前讀。
          return await page.$eval('[data-guard-motion]', (el) => {
            const target = el as HTMLElement;
            const transitionDuration = getComputedStyle(target).transitionDuration;
            target.style.transition = 'none';
            target.setAttribute('data-ending-style', '');
            const translate = getComputedStyle(target).translate;
            target.removeAttribute('data-ending-style');
            target.style.transition = '';
            return { translate, transitionDuration };
          });
        } finally {
          await page.close();
        }
      };
      const normal = await read(false);
      const reduced = await read(true);
      report[`motion:${name}`] = { normal, reduced };
      // 量具自檢：平常是 SG 的 200ms、離場時位移 2.5rem，量到的確實是那條 transition。
      expect(normal.transitionDuration).toBe('0.2s');
      expect(normal.translate).toBe(name === 'sheet' ? '40px' : '-40px');
      expect(reduced.translate).toBe('none');
      expect(Number.parseFloat(reduced.transitionDuration)).toBeLessThanOrEqual(0.15);
    },
  );

  /**
   * 進出場的時長照 SG（#1687 驗收 A1、A3）：vendor 的 dialog、alert-dialog（含遮罩）、popover 寫 `duration-100`，tooltip 沒寫、
   * 是 tw-animate 的預設 150。浮層一開頁就開著，進場已經跑完：計算值的 `animation-*` 還在，讀它；退場仿照上面抽屜那格，
   * 同一個 eval 裡把 `data-open` 換成 `data-closed` 再讀。分得出「`--animate-in` 只宣告在 `:root`、讀不到元素自己的
   * `--tw-duration`」的只有寫了 `duration-100` 的那幾格（那時量到 150）；tooltip 本來就是 150，只當對照。
   */
  const ENTER_EXIT = [
    { name: 'dialog', overlay: 'dialog', selector: '[data-slot="dialog-content"]', ms: 100 },
    {
      name: 'dialog-overlay',
      overlay: 'dialog',
      selector: '[data-slot="dialog-overlay"]',
      ms: 100,
    },
    {
      name: 'alert-dialog',
      overlay: 'alert-dialog',
      selector: '[data-slot="alert-dialog-content"]',
      ms: 100,
    },
    {
      name: 'alert-dialog-overlay',
      overlay: 'alert-dialog',
      selector: '[data-slot="alert-dialog-overlay"]',
      ms: 100,
    },
    { name: 'popover', overlay: undefined, selector: '[data-slot="popover-content"]', ms: 100 },
    { name: 'tooltip', overlay: undefined, selector: '[data-slot="tooltip-content"]', ms: 150 },
  ];

  async function readEnterExit(
    overlay: string | undefined,
    selector: string,
    reducedMotion: boolean,
  ) {
    const page =
      overlay === undefined
        ? await (async () => {
            const p = await open('light');
            if (reducedMotion) await p.emulateMedia({ reducedMotion: 'reduce' });
            return p;
          })()
        : await openOverlay(overlay, 'light', { reducedMotion, marks: { [selector]: {} } });
    try {
      return await page.$eval(selector, (el) => {
        const read = () => {
          const style = getComputedStyle(el);
          return {
            name: style.animationName,
            duration: style.animationDuration,
            easing: style.animationTimingFunction,
            fill: style.animationFillMode,
          };
        };
        /** 這個名字的 @keyframes 動到哪些屬性。 */
        const animated = (name: string) => {
          const props = new Set<string>();
          for (const sheet of document.styleSheets)
            for (const rule of sheet.cssRules)
              if (rule instanceof CSSKeyframesRule && rule.name === name)
                for (const frame of rule.cssRules)
                  for (const prop of (frame as CSSKeyframeRule).style) props.add(prop);
          return [...props].sort();
        };
        const enter = read();
        el.removeAttribute('data-open');
        el.setAttribute('data-closed', '');
        const exit = read();
        return {
          enter,
          exit,
          animates: { enter: animated(enter.name), exit: animated(exit.name) },
        };
      });
    } finally {
      await page.close();
    }
  }

  test.each(ENTER_EXIT)(
    '$name 的進出場照 SG：$ms ms、ease，fill-mode 是 backwards／both（#1687 A1）',
    async ({ name, overlay, selector, ms }) => {
      const measured = await readEnterExit(overlay, selector, false);
      report[`enter-exit:${name}`] = measured;
      expect(measured.enter).toEqual({
        name: 'enter',
        duration: `${ms / 1000}s`,
        easing: 'ease',
        fill: 'backwards',
      });
      expect(measured.exit).toEqual({
        name: 'exit',
        duration: `${ms / 1000}s`,
        easing: 'ease',
        fill: 'both',
      });
    },
  );

  test.each(ENTER_EXIT)(
    'reduced-motion 下 $name 只淡入淡出：≤ 150ms、只動 opacity（#1687 A3）',
    async ({ name, overlay, selector }) => {
      const measured = await readEnterExit(overlay, selector, true);
      report[`enter-exit-reduced:${name}`] = measured;
      expect(measured.enter).toMatchObject({ name: 'motion-fade-in', fill: 'backwards' });
      expect(measured.exit).toMatchObject({ name: 'motion-fade-out', fill: 'both' });
      for (const phase of [measured.enter, measured.exit])
        expect(Number.parseFloat(phase.duration)).toBeLessThanOrEqual(0.15);
      expect(measured.animates).toEqual({ enter: ['opacity'], exit: ['opacity'] });
    },
  );

  test.each([
    { width: 375, px: 44 },
    { width: 1280, px: 32 },
  ])(
    '下拉選單的選項在 $width 寬是 $px px 高（觸控高度，本地修改第 25 條）',
    async ({ width, px }) => {
      const page = await openOverlay('dropdown', 'light', {
        viewport: { width, height: 812 },
        marks: {},
      });
      try {
        const height = await page.$eval(
          '[data-guard-height="dropdown-item"]',
          (el) => el.getBoundingClientRect().height,
        );
        report[`height:dropdown-item:${width}`] = height;
        expect(height).toBe(px);
      } finally {
        await page.close();
      }
    },
  );

  test('鍵盤：Trigger 上按 Enter 打開選單，選項上按 Enter 觸發、選單收起（驗收 D）', async () => {
    const page = await openOverlay('dropdown-keyboard', 'light', { marks: {} });
    try {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('開選單');
      expect(await page.$('[role="menu"]')).toBeNull();
      await page.keyboard.press('Enter');
      await page.waitForSelector('[role="menu"]');
      // 鍵盤打開時 Base UI 把第一項設成 highlighted；往下一項再按 Enter。
      await page.keyboard.press('ArrowDown');
      const highlighted = await page.$eval(
        '[role="menuitem"][data-highlighted]',
        (el) => el.textContent,
      );
      await page.keyboard.press('Enter');
      await page.waitForSelector('[role="menu"]', { state: 'detached' });
      const picked = await page.$eval('[data-guard-picked]', (el) =>
        el.getAttribute('data-guard-picked'),
      );
      report['keyboard:dropdown'] = { highlighted, picked };
      expect(picked).toBe(highlighted);
      expect(picked).not.toBe('');
    } finally {
      await page.close();
    }
  });
});

describe.each(
  COMPOSER_STATES.flatMap((state) =>
    (['light', 'dark'] as const).map((theme) => [state, theme] as const),
  ),
)('瀏覽器量輸入框（#1591）：%s、%s', (state, theme) => {
  const key = `composer-${state}:${theme}`;
  let page: Page;
  let texts: TextSample[];
  let focus: FocusSample[];

  beforeAll(async () => {
    page = await openOverlay(`composer-${state}`, theme, { marks: composerMarks(state) });
    texts = await collectTexts(page);
    focus = await collectFocus(page);
  }, 60_000);

  afterAll(async () => {
    await page?.close();
  });

  test('鍵盤焦點：輸入框的外框畫在外殼上（本地修改第 30 條）、「＋」與主按鈕，都不帶 ring、2px 字色外框', () => {
    const expected = [
      'composer-add-0',
      'composer-input-0',
      ...(COMPOSER_MAIN_ENABLED.includes(state) ? ['composer-main-0'] : []),
    ];
    expect(focus.map((f) => f.name).sort()).toEqual(expected);
    expectFocus(focus, key);
  });

  test('主按鈕的圖示（非文字 3:1）與選單的字過門檻', () => {
    const required = [
      ...(COMPOSER_MAIN_ENABLED.includes(state) ? ['composer-main'] : []),
      ...(state === 'menu' ? ['composer-menu-item'] : []),
    ];
    if (required.length === 0) {
      expect(texts.filter((t) => t.name.startsWith('composer'))).toEqual([]);
      return;
    }
    expectTexts(
      texts.filter((t) => t.name.startsWith('composer')),
      required,
      key,
    );
  });
});

describe.each(
  MODES.filter((m) => m !== 'translucent').flatMap((mode) =>
    (['light', 'dark'] as const).map((theme) => [mode, theme] as const),
  ),
)('瀏覽器量輸入框（#1591）：%s、%s', (mode, theme) => {
  test('不透明的退路：輸入框的面不透明、沒有 blur', async () => {
    const page = await openOverlay('composer-draft', theme, {
      mode,
      marks: composerMarks('draft'),
    });
    try {
      const surfaces = await collectSurfaces(page);
      report[`${mode}:composer:${theme}:surfaces`] = surfaces;
      expect(surfaces.map((s) => s.name)).toEqual(['composer']);
      expect(
        surfaces
          .filter((s) => parseColor(s.backgroundColor).alpha !== 1 || s.backdropFilter !== 'none')
          .map((s) => `${s.name}：${s.backgroundColor}、backdrop-filter ${s.backdropFilter}`),
      ).toEqual([]);
    } finally {
      await page.close();
    }
  });
});

describe.each(['light', 'dark'] as const)('瀏覽器量輸入框的底列（#1591）：%s', (theme) => {
  test('鍵盤焦點：三顆 Pick 與用量環都不帶 ring、2px 字色外框；Pick 的 12px 次要字過 4.5', async () => {
    const page = await openOverlay('composer-idle', theme, { marks: footerMarks });
    try {
      const texts = await collectTexts(page);
      const focus = await collectFocus(page);
      expect(focus.map((f) => f.name).sort()).toEqual([
        'footer-pick-0',
        'footer-pick-1',
        'footer-pick-2',
        'footer-ring-0',
      ]);
      expectFocus(focus, `footer:${theme}`);
      // 量具自檢：三顆 Pick 都量到。
      expect(texts.filter((t) => t.name === 'footer-pick')).toHaveLength(3);
      expectTexts(texts, ['footer-pick'], `footer:${theme}`);
    } finally {
      await page.close();
    }
  });

  test('用量環的三個色階（50%、70%、90%）都是 status token、對底色過非文字 3:1（本地修改第 37 條）', async () => {
    const page = await openOverlay('composer-tones', theme, {
      marks: {
        [`${RING} svg`]: { 'data-guard-text': 'ring', 'data-guard-min': String(NON_TEXT_MIN) },
      },
    });
    try {
      const texts = (await collectTexts(page)).filter((t) => t.name === 'ring');
      const tokens = await page.evaluate(() =>
        ['--status-done', '--status-interrupted', '--destructive'].map((token) => {
          const probe = document.createElement('span');
          probe.style.color = `var(${token})`;
          document.body.append(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        }),
      );
      report[`footer:${theme}:ring-tones`] = { tokens, colors: texts.map((t) => t.color) };
      // 三個環依序是 status-done、status-interrupted、destructive（拿掉覆寫檔第 37 條，前兩個會是 Tailwind 色板的藍與琥珀）。
      expect(texts.map((t) => t.color)).toEqual(tokens);
      expect(new Set(tokens).size).toBe(3);
      expectTexts(texts, ['ring'], `footer:${theme}:ring`);
    } finally {
      await page.close();
    }
  });

  test('權限「全開」：Pick 是警示色，滑鼠移上去不變、清單開著換回字色；模型那顆照常是次要色（本地修改第 35 條）', async () => {
    const page = await openOverlay('composer-danger', theme, { marks: {} });
    try {
      const danger = page.locator(
        '[data-slot="permission-pick"] [data-slot="dropdown-menu-trigger"]',
      );
      const model = page.locator('[data-slot="model-pick"] [data-slot="dropdown-menu-trigger"]');
      const interrupted = await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--status-interrupted)';
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      const colorOf = (target: typeof danger) =>
        target.evaluate((el) => getComputedStyle(el).color);
      const rest = await colorOf(danger);
      await danger.hover();
      await settle(page);
      const hover = await colorOf(danger);
      await page.mouse.move(0, 0);
      await danger.click();
      await page.waitForSelector('[role="menu"]');
      await settle(page);
      const open = await colorOf(danger);
      await page.keyboard.press('Escape');
      await page.waitForSelector('[role="menu"]', { state: 'detached' });
      const others = await colorOf(model);
      report[`footer:${theme}:danger`] = { interrupted, rest, hover, open, others };
      expect([rest, hover]).toEqual([interrupted, interrupted]);
      expect(open).not.toBe(interrupted);
      expect(others).not.toBe(interrupted);
    } finally {
      await page.close();
    }
  });

  test('權限鎖住：Trigger 半透明、聚焦得到（名稱帶原因），點了清單不開（本地修改第 39 條）', async () => {
    const page = await openOverlay('composer-locked', theme, { marks: {} });
    try {
      const locked = page.locator(
        '[data-slot="permission-pick"] [data-slot="dropdown-menu-trigger"]',
      );
      const model = page.locator('[data-slot="model-pick"] [data-slot="dropdown-menu-trigger"]');
      const opacityOf = (target: typeof locked) =>
        target.evaluate((el) => getComputedStyle(el).opacity);
      await locked.focus();
      const state = await locked.evaluate((el) => ({
        focused: document.activeElement === el,
        disabled: el.hasAttribute('disabled'),
        ariaDisabled: el.getAttribute('aria-disabled'),
        name: el.getAttribute('aria-label'),
      }));
      // `force`：Playwright 把 `aria-disabled` 當成不能點、會一直等；這裡要的正是「點了也不開」。
      await locked.click({ force: true });
      await settle(page);
      const menus = await page.locator('[role="menu"]').count();
      const opacities = { locked: await opacityOf(locked), model: await opacityOf(model) };
      report[`footer:${theme}:locked`] = { ...state, menus, opacities };
      expect(state).toEqual({
        focused: true,
        disabled: false,
        ariaDisabled: 'true',
        name: '權限：可寫工作區，這一輪結束後才能切換',
      });
      expect(menus).toBe(0);
      // 量具自檢：沒鎖的那顆是 1。
      expect(opacities).toEqual({ locked: '0.5', model: '1' });
    } finally {
      await page.close();
    }
  });

  test('模型的清單開著：選項名稱、12px 的說明、11px 的標題都過 4.5，選項 32px 高（1024 以上）', async () => {
    const page = await openOverlay('composer-pick-open', theme, {
      marks: {
        '[role="menuitemradio"]': { 'data-guard-text': 'pick-item' },
        '[role="menuitemradio"] .text-muted-foreground': { 'data-guard-text': 'pick-hint' },
        '[data-slot="dropdown-menu-label"]': { 'data-guard-text': 'pick-label' },
      },
    });
    try {
      const texts = await collectTexts(page);
      const heights = await page.$$eval('[role="menuitemradio"]', (els) =>
        els.map((el) => el.getBoundingClientRect().height),
      );
      report[`footer:${theme}:pick-open:heights`] = heights;
      expectTexts(texts, ['pick-item', 'pick-hint', 'pick-label'], `footer:${theme}:pick-open`);
      expect(heights.length).toBeGreaterThan(1);
      expect(heights.filter((h) => h < 32)).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test('用量環點開：明細的標題、每一行（含不會觸發的那一行與它底下的小字）、說明都過 4.5', async () => {
    const page = await openOverlay('composer-dormant', theme, {
      marks: { [RING]: {} },
      prepare: async (p) => {
        await p.click(RING);
        await p.waitForSelector('[data-testid="context-meter-note"]');
        await settle(p);
        await p.evaluate(() => {
          const mark = (selector: string, name: string) =>
            document
              .querySelectorAll(selector)
              .forEach((el) => el.setAttribute('data-guard-text', name));
          mark('[data-slot="popover-title"]', 'ring-title');
          mark('[data-testid="context-meter-percent"]', 'ring-percent');
          mark('[data-testid="context-meter-row"]', 'ring-row');
          mark('[data-testid="context-meter-dormant"]', 'ring-dormant');
          mark('[data-testid="context-meter-note"]', 'ring-note');
        });
      },
    });
    try {
      const texts = await collectTexts(page);
      // 量具自檢：兩道門檻都量到，其中一道是不會觸發的。
      expect(texts.filter((t) => t.name === 'ring-row')).toHaveLength(2);
      expectTexts(
        texts,
        ['ring-title', 'ring-percent', 'ring-row', 'ring-dormant', 'ring-note'],
        `footer:${theme}:ring-open`,
      );
    } finally {
      await page.close();
    }
  });
});

describe.each(
  MODES.filter((m) => m !== 'translucent').flatMap((mode) =>
    (['light', 'dark'] as const).map((theme) => [mode, theme] as const),
  ),
)('瀏覽器量輸入框的底列（#1591）：%s、%s', (mode, theme) => {
  test('不透明的退路：Pick 的 12px 次要字過 4.5、用量環三個色階過 3:1', async () => {
    const pick = await openOverlay('composer-idle', theme, { mode, marks: footerMarks });
    const tones = await openOverlay('composer-tones', theme, {
      mode,
      marks: {
        [`${RING} svg`]: { 'data-guard-text': 'ring', 'data-guard-min': String(NON_TEXT_MIN) },
      },
    });
    try {
      const texts = [
        ...(await collectTexts(pick)).filter((t) => t.name === 'footer-pick'),
        ...(await collectTexts(tones)).filter((t) => t.name === 'ring'),
      ];
      // 量具自檢：三顆 Pick、三個環都量到。
      expect(texts.map((t) => t.name)).toEqual([
        ...Array(3).fill('footer-pick'),
        ...Array(3).fill('ring'),
      ]);
      expectTexts(texts, ['footer-pick', 'ring'], `${mode}:footer:${theme}`);
    } finally {
      await pick.close();
      await tones.close();
    }
  });
});

test('375 寬：模型清單的選項 44px 高（觸控高度，本地修改第 25 條擴充到 RadioItem）', async () => {
  const page = await openOverlay('composer-pick-open', 'light', {
    viewport: { width: 375, height: 812 },
    marks: { '[role="menuitemradio"]': {} },
  });
  try {
    const heights = await page.$$eval('[role="menuitemradio"]', (els) =>
      els.map((el) => el.getBoundingClientRect().height),
    );
    report['footer:pick-open:375:heights'] = heights;
    expect(heights.length).toBeGreaterThan(1);
    expect(heights.filter((h) => h < 44)).toEqual([]);
  } finally {
    await page.close();
  }
});

test('減少動態：用量環的弧長不走 transition（本地修改第 38 條）', async () => {
  const duration = async (reducedMotion: boolean) => {
    const page = await openOverlay('composer-idle', 'light', {
      reducedMotion,
      marks: { [RING]: {} },
    });
    try {
      return await page.$eval(
        `${RING} circle:last-child`,
        (el) => getComputedStyle(el).transitionDuration,
      );
    } finally {
      await page.close();
    }
  };
  const measured = { normal: await duration(false), reduced: await duration(true) };
  report['footer:ring-motion'] = measured;
  // 量具自檢：平常是 vendor 的 500ms（量到的確實是弧長那一圈）。
  expect(measured).toEqual({ normal: '0.5s', reduced: '0s' });
});

describe('瀏覽器量輸入框的版面（#1591）', () => {
  test.each([
    { width: 375, px: 44 },
    { width: 1280, px: 32 },
  ])(
    '$width 寬：底列不溢出、按鈕不重疊、主按鈕在框內；「＋」與主按鈕 $px px、單行的字跟它們置中（第 31 條）；底列的 Pick 與用量環 1024 以下 44px（第 36 條）',
    async ({ width, px }) => {
      const page = await openOverlay('composer-running-draft', 'light', {
        viewport: { width, height: 812 },
        marks: composerMarks('running-draft'),
      });
      try {
        const layout = await page.evaluate(() => {
          const box = (el: Element | null) => {
            if (el === null) throw new Error('量不到元素');
            const r = el.getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height };
          };
          const composer = document.querySelector('[data-slot="composer"]');
          const footer = document.querySelector('[data-slot="composer-footer"]');
          const main = document.querySelector(
            '[data-slot="composer"] textarea + [data-slot="button"]',
          );
          const add = document.querySelector('[data-slot="composer"] [aria-label="加入附件"]');
          const textarea = document.querySelector('[data-slot="composer"] textarea');
          return {
            viewport: window.innerWidth,
            composer: box(composer),
            footer: box(footer),
            footerOverflow: footer === null ? 0 : footer.scrollWidth - footer.clientWidth,
            footerChildren: [...(footer?.querySelectorAll('button') ?? [])].map(box),
            main: box(main),
            add: box(add),
            textarea: box(textarea),
          };
        });
        report[`layout:composer:${width}`] = layout;
        const { composer, footer, main } = layout;
        expect(layout.footerOverflow).toBeLessThanOrEqual(0);
        // 底列每顆按鈕都在畫面裡、不超出輸入框的左右（底列在框外，跟框同寬）。
        expect(
          layout.footerChildren.filter(
            (b) => b.left < composer.left - 0.5 || b.right > composer.right + 0.5,
          ),
        ).toEqual([]);
        expect(footer.right).toBeLessThanOrEqual(layout.viewport);
        expect(main.left).toBeGreaterThanOrEqual(composer.left);
        expect(main.right).toBeLessThanOrEqual(composer.right);
        expect(main.top).toBeGreaterThanOrEqual(composer.top);
        expect(main.bottom).toBeLessThanOrEqual(composer.bottom);
        expect([layout.add.height, main.height]).toEqual([px, px]);
        // 底列的按鈕依序排、不互相蓋住（窄的時候只有模型那顆縮，其餘的包裝層不縮，見 `model-seat.tsx`）。
        expect(
          layout.footerChildren.filter((b, i, all) => i > 0 && b.left < all[i - 1]!.right - 0.5),
        ).toEqual([]);
        // 底列的三顆 Pick 與用量環：1024 以下 44px（本地修改第 36 條），以上照 SG 是 24px。
        expect(layout.footerChildren.map((b) => b.height)).toEqual(
          Array(4).fill(px === 44 ? 44 : 24),
        );
        // 單行的草稿：字（textarea 的盒子）跟「＋」、主按鈕同高、同一條中線，不會沉在按鈕下緣。
        const middle = (b: { top: number; bottom: number }) => (b.top + b.bottom) / 2;
        expect(layout.textarea.height).toBe(px);
        expect(Math.abs(middle(layout.textarea) - middle(main))).toBeLessThanOrEqual(0.5);
        expect(Math.abs(middle(layout.textarea) - middle(layout.add))).toBeLessThanOrEqual(0.5);
      } finally {
        await page.close();
      }
    },
  );
});

describe('瀏覽器量桌面側欄的收合動效（#1680 PR B，`?overlay=desktop-sidebar`）', () => {
  // 收合照 SG 的 `duration-200 ease-linear`（#1468 Q8；規格 §7 的「桌面側欄收合」）；reduced-motion 下 `motion.css` 以
  // `data-slot` 命中 gap 與 container，transition 整個關掉。jsdom 不載 CSS，元件測試量不到。
  test('平常是 SG 的 200ms linear；reduced-motion 下 gap 與 container 都沒有 transition', async () => {
    const read = async (reducedMotion: boolean) => {
      const page = await openOverlay('desktop-sidebar', 'light', { reducedMotion, marks: {} });
      try {
        return await page.evaluate(() =>
          ['sidebar-gap', 'sidebar-container'].map((slot) => {
            const el = document.querySelector(`[data-slot="${slot}"]`);
            if (el === null) return { slot, missing: true };
            const style = getComputedStyle(el);
            return {
              slot,
              property: style.transitionProperty,
              duration: style.transitionDuration,
              easing: style.transitionTimingFunction,
            };
          }),
        );
      } finally {
        await page.close();
      }
    };
    const normal = await read(false);
    const reduced = await read(true);
    report['motion:desktop-sidebar'] = { normal, reduced };
    expect(normal).toEqual([
      { slot: 'sidebar-gap', property: 'width', duration: '0.2s', easing: 'linear' },
      {
        slot: 'sidebar-container',
        property: 'left, right, width',
        duration: '0.2s',
        easing: 'linear',
      },
    ]);
    for (const row of reduced) expect(row).toMatchObject({ property: 'none', duration: '0s' });
  });
});

describe('瀏覽器量展開收合（#1638 PR A，`?overlay=collapsibles`）', () => {
  // 這幾件都靠真的 CSS 命中 Base UI 的屬性（Panel 的 `data-open`、Trigger 的 `data-panel-open`），jsdom 不載 CSS，元件測試量不到。
  // 展開收合照 SG 沒有高度動效（#1687：SG 的 collapsible Panel 沒有任何 class；思考過程 #1683 起是原生 `<details>`）：
  // 量摘要列點開的第一幀就到位。思考過程只量箭頭與展開後藏「·」與摘要。
  const COMPACTION = '[data-testid="compaction-row"]';
  const REASONING = '[data-testid="reasoning-row"]';
  const TRIGGER = `${COMPACTION} [data-slot="collapsible-trigger"]`;
  const openRows = (reducedMotion: boolean) =>
    openOverlay('collapsibles', 'light', {
      reducedMotion,
      marks: { [COMPACTION]: {}, [REASONING]: {} },
    });

  /** 點開摘要列，回傳內容在展開動效 40% 時的高度、第一幀的高度與動效跑完的高度。 */
  async function expand(page: Page) {
    await page.click(TRIGGER);
    return page.evaluate(async (row) => {
      const panel = () =>
        document.querySelector<HTMLElement>(`${row} [data-slot="collapsible-content"]`);
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      while (panel() === null) await frame();
      const el = panel()!;
      const first = el.getBoundingClientRect().height;
      const grow = el
        .getAnimations()
        .find((a) => (a as CSSAnimation).animationName === 'collapsible-down');
      let mid: number | undefined;
      if (grow !== undefined) {
        grow.pause();
        grow.currentTime = Number(grow.effect?.getComputedTiming().duration) * 0.4;
        mid = el.getBoundingClientRect().height;
        grow.finish();
      }
      await Promise.all(el.getAnimations().map((a) => a.finished.catch(() => undefined)));
      return {
        animations: el.getAnimations().length,
        grows: grow !== undefined,
        first,
        mid,
        final: el.getBoundingClientRect().height,
        variable: el.style.getPropertyValue('--collapsible-panel-height'),
      };
    }, COMPACTION);
  }

  test.each([false, true])(
    '摘要列照 SG 沒有高度動效：點開的第一幀就到位、內容上沒有任何動畫（#1687 B1；reduced-motion %s）',
    async (reducedMotion) => {
      const page = await openRows(reducedMotion);
      try {
        const measured = await expand(page);
        report[`collapsible:expand${reducedMotion ? '-reduced' : ''}`] = measured;
        // 量具自檢：展開後有高度。
        expect(measured.final).toBeGreaterThan(0);
        expect(measured.grows).toBe(false);
        expect(measured.animations).toBe(0);
        expect(measured.first).toBe(measured.final);
      } finally {
        await page.close();
      }
    },
  );

  test.each([false, true])(
    '摘要列的箭頭照 SG：跟著 Trigger 開著時的 data-panel-open 轉 90 度，平常 150ms、減少動態不轉場（#1687 B4；reduced-motion %s）',
    async (reducedMotion) => {
      const page = await openRows(reducedMotion);
      try {
        const read = () =>
          page.$eval(TRIGGER, (trigger) => {
            const chevron = getComputedStyle(trigger.querySelector('svg[data-motion-rotate]')!);
            return {
              expanded: trigger.getAttribute('aria-expanded'),
              panelOpen: trigger.hasAttribute('data-panel-open'),
              // Tailwind v4 的 `rotate-90` 寫的是獨立的 `rotate` 屬性，不是 `transform`。
              chevron: chevron.rotate,
              transition: `${chevron.transitionProperty} ${chevron.transitionDuration}`,
            };
          });
        const closed = await read();
        await page.click(TRIGGER);
        await settle(page);
        const opened = await read();
        report[`collapsible:trigger${reducedMotion ? '-reduced' : ''}`] = { closed, opened };
        expect(closed).toMatchObject({ expanded: 'false', panelOpen: false, chevron: 'none' });
        expect(opened).toMatchObject({ expanded: 'true', panelOpen: true, chevron: '90deg' });
        expect(opened.transition).toBe(
          reducedMotion ? 'none 0s' : 'transform, translate, scale, rotate 0.15s',
        );
      } finally {
        await page.close();
      }
    },
  );

  test('思考過程的箭頭跟著 details[open] 轉 90 度，展開後藏「·」與摘要（#1638 Q2、#1683）', async () => {
    const page = await openRows(false);
    try {
      const read = () =>
        page.$eval(REASONING, (row) => {
          const summary = row.querySelector('details > summary')!;
          return {
            open: row.querySelector('details')!.open,
            chevron: getComputedStyle(summary.querySelector('svg')!).rotate,
            hidden: [...summary.querySelectorAll('span[aria-hidden]')]
              .filter((el) => el.textContent?.trim() !== '')
              .map((el) => getComputedStyle(el).display === 'none'),
          };
        });
      const closed = await read();
      await page.click(`${REASONING} details > summary`);
      await settle(page);
      const opened = await read();
      report['collapsible:reasoning'] = { closed, opened };
      expect(closed).toEqual({ open: false, chevron: 'none', hidden: [false, false] });
      // 量具自檢：「·」與摘要兩個都量到了。
      expect(opened).toEqual({ open: true, chevron: '90deg', hidden: [true, true] });
    } finally {
      await page.close();
    }
  });
});

describe('瀏覽器量對話區（#1638 PR B，`?overlay=messages`）', () => {
  const openMessages = (reducedMotion = false) =>
    openOverlay('messages', 'light', { reducedMotion, marks: { [SCROLL_BUTTON]: {} } });

  test('每一則的 content-visibility 是 visible：覆寫檔壓掉 vendor 的 auto（Q6，本地修改第 42 條）', async () => {
    const page = await openMessages();
    try {
      const items = await page.$$eval('[data-slot="message-scroller-item"]', (els) =>
        els.map((el) => {
          const style = getComputedStyle(el);
          return `${style.contentVisibility} ${style.containIntrinsicSize}`;
        }),
      );
      report['messages:content-visibility'] = items;
      // 量具自檢：十二則都量到了。
      expect(items).toHaveLength(12);
      expect(new Set(items)).toEqual(new Set(['visible none']));
    } finally {
      await page.close();
    }
  });

  test.each([false, true])(
    '捲到最新的按鈕照 vendor 原樣：藏著時往下位移一整個身高、縮 .95，出現 200ms、藏起來 400ms；reduced-motion 下沒有 transition（#1687 撤掉第 41 條；reduced-motion %s）',
    async (reducedMotion) => {
      const page = await openMessages(reducedMotion);
      try {
        const read = () =>
          page.$eval(SCROLL_BUTTON, (el) => {
            const style = getComputedStyle(el);
            return {
              active: el.getAttribute('data-active'),
              slot: el.getAttribute('data-slot'),
              translate: style.translate,
              scale: style.scale,
              transitionProperty: style.transitionProperty,
              transitionDuration: style.transitionDuration,
            };
          });
        const hidden = await read();
        await scrollMessages(page, 'top');
        const shown = await read();
        report[`messages:scroll-button:${reducedMotion ? 'reduced' : 'normal'}`] = {
          hidden,
          shown,
        };
        // 量具自檢：真的量到藏著與出現兩種狀態，元素是 reduced-motion 那條規則認得的 data-slot。
        expect([hidden.active, shown.active]).toEqual(['false', 'true']);
        expect(shown.slot).toBe('message-scroller-button');
        // 藏著時 vendor 的 `translate-y-full`（y 是身高的 100%）疊在置中用的 -50% 上；出現時只剩置中。
        expect(hidden.translate).toContain('100%');
        expect(shown.translate).toBe('-50%');
        expect([hidden.scale, shown.scale]).toEqual(['0.95', '1']);
        if (reducedMotion) {
          expect([hidden.transitionProperty, shown.transitionProperty]).toEqual(['none', 'none']);
        } else {
          expect(hidden).toMatchObject({
            transitionProperty: 'translate, scale, opacity',
            transitionDuration: '0.4s',
          });
          expect(shown).toMatchObject({
            transitionProperty: 'translate, scale, opacity',
            transitionDuration: '0.2s',
          });
        }
      } finally {
        await page.close();
      }
    },
  );

  /**
   * 浮鈕的避讓（`hooks/use-scroll-button-clearance.ts`，#1295）在浮鈕位移之後還對（#1687 驗收 C3）。浮鈕從藏著的位置
   * （往下一整個身高、縮 .95）過渡到出現的位置，hook 在過渡途中量到的是途中的框；它要在 `transitionend` 時重量，最後的
   * `data-obscuring` 才對得上終點的框。reduced-motion 下沒有過渡，靠捲動那次重量就量到終點：primitive 的 `data-active` 在 scroll
   * 事件之前就翻好（`@shadcn/react` 0.3.1 實測）；升 primitive 之後翻轉時機變了，reduced-motion 那一格會紅。
   *
   * 做法：先記下藏著與出現兩個框，在對話內容裡挑一個「壓得到出現的框、壓不到藏著的框」的元素標成要讓開的目標，
   * 再捲一次回頂端。平常的那一格先自檢：過渡暫停在 0 的框與 `finish()` 之後的框，用 `obscures()` 算出來的結論不同
   * （不然拿掉 `transitionend` 也不會紅）；再等兩幀讓 hook 的 rAF 跑完，讀 `data-obscuring`。
   */
  test.each([false, true])(
    '浮鈕過渡到終點之後，data-obscuring 照終點的框算（#1687 C3；reduced-motion %s）',
    async (reducedMotion) => {
      const page = await openMessages(reducedMotion);
      try {
        const hiddenBox = await page.$eval(SCROLL_BUTTON, (el) =>
          el.getBoundingClientRect().toJSON(),
        );
        await scrollMessages(page, 'top');
        // 挑目標：內容裡壓得到出現的框、壓不到藏著的框的元素（餘裕同 hook 的 4px）。
        const picked = await page.$eval(
          '[data-slot="message-scroller-viewport"]',
          (viewport, hidden) => {
            const button = viewport.parentElement!.querySelector(
              '[data-slot="message-scroller-button"]',
            )!;
            const shown = button.getBoundingClientRect();
            const hit = (a: DOMRect | typeof hidden, b: DOMRect) =>
              a.left < b.right + 4 &&
              b.left < a.right + 4 &&
              a.top < b.bottom + 4 &&
              b.top < a.bottom + 4;
            const target = [
              ...viewport.querySelectorAll<HTMLElement>('[data-slot="message-scroller-content"] *'),
            ]
              .reverse()
              .find((el) => {
                const box = el.getBoundingClientRect();
                return box.height > 0 && hit(shown, box) && !hit(hidden, box);
              });
            target?.setAttribute('data-scroll-button-avoid', '');
            return target !== undefined;
          },
          hiddenBox,
        );
        // 量具自檢：版面上挑得到這樣的目標。
        expect(picked).toBe(true);
        await scrollMessages(page, 'end');
        const measured = await page.$eval(
          '[data-slot="message-scroller-viewport"]',
          async (viewport, reduced) => {
            const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
            const button = viewport.parentElement!.querySelector<HTMLElement>(
              '[data-slot="message-scroller-button"]',
            )!;
            const target = viewport.querySelector('[data-scroll-button-avoid]')!;
            const hit = (a: DOMRect) => {
              const b = target.getBoundingClientRect();
              return (
                a.left < b.right + 4 &&
                b.left < a.right + 4 &&
                a.top < b.bottom + 4 &&
                b.top < a.bottom + 4
              );
            };
            viewport.scrollTop = 0;
            for (let i = 0; i < 120 && button.getAttribute('data-active') !== 'true'; i++)
              await frame();
            // 讓 hook 因捲動而排的那次重量先跑完（量到的是過渡剛開始的框），再把過渡推到終點：
            // 這樣終點要靠 `transitionend` 才量得到，拿掉它會紅。
            await frame();
            await frame();
            let start: boolean | undefined;
            if (!reduced) {
              const transitions = button.getAnimations();
              for (const t of transitions) {
                t.pause();
                t.currentTime = 0;
              }
              start = hit(button.getBoundingClientRect());
              for (const t of transitions) t.finish();
            }
            const end = hit(button.getBoundingClientRect());
            await frame();
            await frame();
            return {
              active: button.getAttribute('data-active'),
              start,
              end,
              obscuring: button.hasAttribute('data-obscuring'),
            };
          },
          reducedMotion,
        );
        report[`messages:clearance:${reducedMotion ? 'reduced' : 'normal'}`] = measured;
        expect(measured.active).toBe('true');
        expect(measured.end).toBe(true);
        // 自檢：過渡的起點與終點，壓不壓得到的結論不同。
        if (!reducedMotion) expect(measured.start).toBe(false);
        expect(measured.obscuring).toBe(measured.end);
      } finally {
        await page.close();
      }
    },
  );

  test('外殼的行高是 SG 的 text-sm（20px），泡泡由呼叫端維持 text-body（23px）', async () => {
    const page = await openMessages();
    try {
      const measured = await page.$eval('[data-testid="ai-entry"]', (el) => ({
        shell: getComputedStyle(el).lineHeight,
        bubble: getComputedStyle(el.querySelector('[data-slot="bubble-content"]')!).lineHeight,
      }));
      report['messages:line-height'] = measured;
      expect(measured).toEqual({ shell: '20px', bubble: '23px' });
    } finally {
      await page.close();
    }
  });

  test.each([false, true])(
    '底部淡出（scroll-fade-b，Q8 照 SG）捲到底時收成 0、往上捲才出現（reduced-motion %s）',
    async (reducedMotion) => {
      const page = await openMessages(reducedMotion);
      try {
        // 淡出的寬度由 scroll-driven 的 `scroll-fade-reveal-b` 帶：進度 1 是收成 0px，0 是整段（12%、最多 40px）。
        const read = () =>
          page.$eval('[data-slot="message-scroller-viewport"]', (el) => {
            const reveal = el
              .getAnimations()
              .find((a) => (a as CSSAnimation).animationName === 'scroll-fade-reveal-b');
            return {
              progress: reveal?.effect?.getComputedTiming().progress ?? null,
              value: getComputedStyle(el).getPropertyValue('--scroll-fade-b'),
            };
          });
        // 負載高時 primitive 的開頁定位會停在離最底 1px、不會自己補上（#2024），進度就讀不到 1：先自己捲到底再讀。
        await scrollMessages(page, 'end');
        const end = await read();
        await scrollMessages(page, 'top');
        const top = await read();
        report[`messages:scroll-fade:${reducedMotion ? 'reduced' : 'normal'}`] = { end, top };
        expect(end.progress).toBe(1);
        expect(top.progress).toBe(0);
      } finally {
        await page.close();
      }
    },
  );
});
