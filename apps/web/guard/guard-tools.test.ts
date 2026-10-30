// @vitest-environment node
/** 瀏覽器護欄（#1512）：問答與附件、tool-steps 與工具卡、推理列。量具在 `harness.ts`。 */
import { type Page } from 'playwright-core';
import { describe, expect, test } from 'vitest';

import {
  ATTACHMENT_BUTTONS,
  CARDS,
  MODES,
  QUESTIONNAIRE_INPUT,
  REASONING_BODY,
  REASONING_HEAD,
  REASONING_ROWS,
  TEXT_MIN,
  TOOL_GROUP,
  TOOL_STANDALONE,
  type TextSample,
  collectFocus,
  collectTexts,
  expectFocus,
  expectTexts,
  markReasoningBody,
  openOverlay,
  openReasoningRows,
  reasoningIn,
  reasoningMarks,
  report,
  round,
  sameShadow,
  settle,
  toolCardsMarks,
  toolStepsMarks,
  worstOn,
} from './harness';

describe.each(['light', 'dark'] as const)('瀏覽器量問答與附件（#1638 PR C）：%s', (theme) => {
  test('問答選項聚焦：外框 2px、offset 2px 畫在選項上（本地修改第 46 條；外框顏色、box-shadow 不變由 guard.test.ts 的 modal 浮層那組量）', async () => {
    const page = await openOverlay('questionnaire', theme, {
      marks: { [QUESTIONNAIRE_INPUT]: {} },
    });
    try {
      await page.keyboard.press('Tab');
      const input = page.locator(QUESTIONNAIRE_INPUT).first();
      await input.focus();
      await settle(page);
      const sample = await input.evaluate((el) => {
        const host = getComputedStyle(el.parentElement!);
        return {
          focusVisible: el.matches(':focus-visible'),
          hostSlot: el.parentElement!.getAttribute('data-slot'),
          outline: `${host.outlineStyle} ${host.outlineWidth}`,
          offset: host.outlineOffset,
        };
      });
      report[`questionnaire:${theme}:choice-outline`] = sample;
      expect(sample).toEqual({
        focusVisible: true,
        hostSlot: 'questionnaire-choice',
        outline: 'solid 2px',
        offset: '2px',
      });
    } finally {
      await page.close();
    }
  });

  test('附件的按鈕不管鍵盤或滑鼠聚焦，外殼都不出 ring（vendor 的 `focus-within:ring-1` 被 SG 的玻璃規則蓋掉；偏離 Q7 字面、PM 同意）', async () => {
    const page = await openOverlay('attachments', theme, { marks: { [ATTACHMENT_BUTTONS]: {} } });
    try {
      const buttons = page.locator(ATTACHMENT_BUTTONS);
      const count = await buttons.count();
      const read = (i: number) =>
        buttons.nth(i).evaluate((el) => {
          const shell = el.closest('[data-slot="attachment"]')!;
          return {
            name: el.getAttribute('aria-label') ?? '',
            shadow: getComputedStyle(shell).boxShadow,
            focusWithin: shell.matches(':focus-within'),
            focusVisible: el.matches(':focus-visible'),
          };
        });
      const samples = [];
      for (let i = 0; i < count; i++) {
        const button = buttons.nth(i);
        await button.evaluate((el) => (el as HTMLElement).blur());
        await page.mouse.move(0, 0);
        await settle(page);
        const rest = await read(i);
        await page.keyboard.press('Shift');
        await button.focus();
        await settle(page);
        const keyboard = await read(i);
        await button.evaluate((el) => (el as HTMLElement).blur());
        // 滑鼠：按下就聚焦；移開再放開，不觸發 click（看原圖會開 modal）。
        await button.hover({ force: true });
        await page.mouse.down();
        await settle(page);
        const mouse = await read(i);
        await page.mouse.move(0, 0);
        await page.mouse.up();
        samples.push({ name: rest.name, rest, keyboard, mouse });
      }
      report[`attachments:${theme}:shell-ring`] = samples;
      // 量具自檢：六顆都量到，鍵盤那次是 :focus-visible、滑鼠那次不是，兩次外殼都是 :focus-within。
      expect(samples).toHaveLength(6);
      expect(
        samples.filter(
          (s) =>
            !s.keyboard.focusVisible ||
            s.mouse.focusVisible ||
            !s.keyboard.focusWithin ||
            !s.mouse.focusWithin,
        ),
      ).toEqual([]);
      expect(
        samples
          .filter(
            (s) =>
              !sameShadow(s.rest.shadow, s.keyboard.shadow) ||
              !sameShadow(s.rest.shadow, s.mouse.shadow),
          )
          .map((s) => `${s.name}：${s.rest.shadow} → ${s.keyboard.shadow}／${s.mouse.shadow}`),
      ).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test('一排附件左右淡出：放得下時兩邊都不淡；放不下時捲在頭只淡尾、捲到尾只淡頭（Q8 照 SG；退路見本地修改第 47 條）', async () => {
    const page = await openOverlay('attachments', theme, { marks: { '[data-guard-rail]': {} } });
    try {
      const fade = (rail: string, to: 'start' | 'end') =>
        page.$eval(
          `[data-guard-rail="${rail}"] [data-slot="attachment-group"]`,
          async (el, end) => {
            const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
            el.scrollLeft = end ? el.scrollWidth : 0;
            for (let i = 0; i < 10; i++) await frame();
            // 計算值是 `calc(…)` 字串，放進一個跟它一樣寬的盒子裡解成像素。
            const style = getComputedStyle(el);
            const box = document.createElement('div');
            box.style.cssText = `position:absolute;visibility:hidden;width:${el.clientWidth}px`;
            const probe = document.createElement('div');
            box.append(probe);
            document.body.append(box);
            const px = (value: string) => {
              probe.style.width = value;
              return probe.getBoundingClientRect().width;
            };
            const result = {
              overflows: el.scrollWidth > el.clientWidth,
              start: px(style.getPropertyValue('--scroll-fade-s')),
              end: px(style.getPropertyValue('--scroll-fade-e')),
            };
            box.remove();
            return result;
          },
          to === 'end',
        );
      const fits = await fade('fits', 'start');
      const head = await fade('overflows', 'start');
      const tail = await fade('overflows', 'end');
      report[`attachments:${theme}:scroll-fade`] = { fits, head, tail };
      expect(fits).toEqual({ overflows: false, start: 0, end: 0 });
      expect(head).toMatchObject({ overflows: true, start: 0 });
      expect(head.end).toBeGreaterThan(0);
      expect(tail).toMatchObject({ overflows: true, end: 0 });
      expect(tail.start).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });

  test('上傳中的標題 shimmer：漸層每個色標對底色都過 4.5（亮色由本地修改第 48 條換掉亮面）', async () => {
    const page = await openOverlay('attachments', theme, {
      marks: { '[data-slot="attachment"][data-state="uploading"]': {} },
    });
    try {
      const titles = await page.$$eval(
        '[data-slot="attachment"][data-state="uploading"] [data-slot="attachment-title"]',
        (els) =>
          els.map((el) => {
            const own = getComputedStyle(el);
            // 漸層畫在標題自己身上、只透過字露出來：底色從上一層開始疊；自己那層只帶 opacity。
            const chain = [
              {
                backgroundColor: 'rgba(0, 0, 0, 0)',
                backgroundImage: 'none',
                opacity: own.opacity,
              },
            ];
            for (let node = el.parentElement; node !== null; node = node.parentElement) {
              const style = getComputedStyle(node);
              chain.push({
                backgroundColor: style.backgroundColor,
                backgroundImage: style.backgroundImage,
                opacity: style.opacity,
              });
            }
            return {
              name: el.textContent ?? '',
              fill: own.webkitTextFillColor,
              animation: own.animationName,
              image: own.backgroundImage,
              chain,
            };
          }),
      );
      const measured = titles.map((t) => {
        const stops = [...t.image.matchAll(/(?:oklch|oklab|rgba?)\([^)]*\)/g)].map((m) => m[0]);
        const ratios = stops.map((stop) => ({ stop, ...worstOn(stop, t.chain) }));
        const worst = ratios.reduce((a, b) => (b.ratio < a.ratio ? b : a));
        return {
          name: t.name,
          fill: t.fill,
          animation: t.animation,
          stops: ratios.map((r) => `${r.stop} ${round(r.ratio)}`),
          worst: round(worst.ratio),
          on: worst.on,
        };
      });
      report[`attachments:${theme}:shimmer`] = measured;
      // 量具自檢：兩張上傳中的卡都量到，字真的是透明的、顏色來自五個色標的漸層、動畫在跑。
      expect(measured.map((m) => m.name)).toEqual(['上傳中.csv', '不知道大小.txt']);
      for (const m of measured) {
        expect(m).toMatchObject({ fill: 'rgba(0, 0, 0, 0)', animation: 'tw-shimmer' });
        expect(m.stops).toHaveLength(5);
      }
      expect(
        measured
          .filter((m) => !(m.worst >= TEXT_MIN))
          .map((m) => `${m.name} ${m.worst}（${m.on}）`),
      ).toEqual([]);
    } finally {
      await page.close();
    }
  });
});

describe.each(['light', 'dark'] as const)('瀏覽器量 tool-steps（#1682）：%s', (theme) => {
  test('列與群組的字、結果框的標題與內文過 4.5；結果框聚焦時外框畫在外層（第 62 條）', async () => {
    const page = await openOverlay('tool-steps', theme, { marks: toolStepsMarks });
    try {
      const texts = await collectTexts(page);
      const focus = await collectFocus(page);
      const offsets = await page.$$eval('[data-guard-tool] [data-slot="output-block"]', (els) =>
        els.map((el) => {
          (el.querySelector('pre') as HTMLElement).focus();
          return getComputedStyle(el).outlineOffset;
        }),
      );
      report[`tool-steps:${theme}:outline-offset`] = offsets;
      // 量具自檢：群組裡三列、群組那一列、展開的結果框（群組裡完成的參數與結果、失敗的錯誤，單獨那列的參數與結果）都量到。
      expect(texts.filter((t) => t.name === 'tool-step-label')).toHaveLength(3);
      expect(texts.filter((t) => t.name === 'tool-group-label')).toHaveLength(1);
      expect(texts.filter((t) => t.name === 'tool-output-text')).toHaveLength(5);
      expect(focus).toHaveLength(5);
      expectTexts(
        texts,
        ['tool-step-label', 'tool-group-label', 'tool-output-label', 'tool-output-text'],
        `tool-steps:${theme}`,
      );
      expectFocus(focus, `tool-steps:${theme}`);
      expect(offsets).toEqual(Array(5).fill('2px'));
    } finally {
      await page.close();
    }
  });
});

describe('瀏覽器量 tool-steps 的覆寫（#1682，第 61、63、64、65 條）', () => {
  test('第 61 條：執行中那一列掛著 vendor 的 animate-pulse，但 animation-name 是 none', async () => {
    const page = await openOverlay('tool-steps', 'light', { marks: { [TOOL_GROUP]: {} } });
    try {
      const rows = await page.$$eval(`${TOOL_GROUP} [data-slot="step-row"] > button`, (els) =>
        els.map((el) => ({
          pulse: el.classList.contains('animate-pulse'),
          animation: getComputedStyle(el).animationName,
        })),
      );
      report['tool-steps:pulse'] = rows;
      // 量具自檢：真的有一列帶 vendor 的 class（執行中那一列）。
      expect(rows.filter((r) => r.pulse)).toHaveLength(1);
      expect(rows.map((r) => r.animation)).toEqual(['none', 'none', 'none']);
    } finally {
      await page.close();
    }
  });

  test.each([
    [375, true],
    [1280, false],
  ] as const)('第 63 條：%i 寬時列與群組那一列的按鈕至少 44px：%s', async (width, touch) => {
    const page = await openOverlay('tool-steps', 'light', {
      viewport: { width, height: 900 },
      marks: { [TOOL_GROUP]: {} },
    });
    try {
      const heights = await page.$$eval(
        `${TOOL_GROUP} :is([data-slot="step-row"], [data-slot="step-group"]) > button`,
        (els) => els.map((el) => el.getBoundingClientRect().height),
      );
      report[`tool-steps:height:${width}`] = heights;
      expect(heights).toHaveLength(4);
      // 1280 寬照 SG（一行字高）：量具自檢，44px 不是本來就有的。
      for (const h of heights) expect(h >= 44).toBe(touch);
    } finally {
      await page.close();
    }
  });

  test.each([
    [true, '0s'],
    [false, 'not-0s'],
  ] as const)('第 64 條：減少動態（%s）時箭頭的轉場時長', async (reducedMotion, expected) => {
    const page = await openOverlay('tool-steps', 'light', {
      reducedMotion,
      marks: { [TOOL_GROUP]: {} },
    });
    try {
      const durations = await page.$$eval(
        `${TOOL_GROUP} :is([data-slot="step-row"], [data-slot="step-group"]) > button > svg`,
        (els) => els.map((el) => getComputedStyle(el).transitionDuration),
      );
      report[`tool-steps:chevron:${reducedMotion ? 'reduce' : 'normal'}`] = durations;
      expect(durations).toHaveLength(4);
      for (const d of durations) expect(d === '0s' ? '0s' : 'not-0s').toBe(expected);
    } finally {
      await page.close();
    }
  });

  test('第 65 條：疊在清單裡的結果框沒有 backdrop-filter；清單本身與單獨放的結果框照 SG 有', async () => {
    const page = await openOverlay('tool-steps', 'light', {
      marks: { [TOOL_GROUP]: {}, [TOOL_STANDALONE]: {} },
    });
    try {
      const filter = (selector: string) =>
        page.$$eval(selector, (els) => els.map((el) => getComputedStyle(el).backdropFilter));
      const measured = {
        nested: await filter(`${TOOL_GROUP} [data-slot="step-list"] [data-slot="output-block"]`),
        list: await filter(`${TOOL_GROUP} [data-slot="step-list"]`),
        standalone: await filter(`${TOOL_STANDALONE} [data-slot="output-block"]`),
      };
      report['tool-steps:backdrop'] = measured;
      expect(measured.nested).toEqual(['none', 'none', 'none']);
      expect(measured.list).toHaveLength(1);
      expect(measured.standalone).toHaveLength(2);
      for (const f of [...measured.list, ...measured.standalone]) expect(f).toMatch(/blur\(/);
    } finally {
      await page.close();
    }
  });
});

describe.each(
  MODES.flatMap((mode) => (['light', 'dark'] as const).map((theme) => [mode, theme] as const)),
)('瀏覽器量產品的工具卡（#1682 PR B）：%s、%s', (mode, theme) => {
  test('頁面、清單、結果框三種底上的字與 Badge 過 4.5；錯誤框的紅字也過；列、群組、結果框的焦點', async () => {
    const page = await openOverlay('tool-cards', theme, { mode, marks: toolCardsMarks });
    try {
      const texts = await collectTexts(page);
      const focus = await collectFocus(page);
      const count = (name: string) => texts.filter((t) => t.name === name).length;
      // 量具自檢：單獨的卡 8 張、段裡 2 張、群組 1 列；Badge 10 顆；結果框（段裡展開那張的參數與結果、完成那張的參數與結果、
      // 失敗那張的參數與錯誤、撞到上限那張的參數）7 個，其中錯誤框 1 個；背景子代理的「跑著」1 個、撞到上限那段紅字說明 1 段
      // （#1682 審查：它直接疊在頁面底色上）。
      const names = [
        'card-label-page',
        'card-label-panel',
        'run-label',
        'card-badge',
        'card-output-text',
        'card-code',
        'card-attribution',
        'card-subagent-state',
        'card-max-tokens',
      ];
      expect(Object.fromEntries(names.map((name) => [name, count(name)]))).toEqual({
        'card-label-page': 8,
        'card-label-panel': 2,
        'run-label': 1,
        'card-badge': 10,
        'card-output-text': 7,
        'card-code': 10,
        'card-attribution': 1,
        'card-subagent-state': 1,
        'card-max-tokens': 1,
      });
      const error = await page.$$eval(
        `${CARDS} [data-slot="output-block"] > pre`,
        (els) => els.filter((el) => el.className.includes('text-destructive')).length,
      );
      expect(error).toBe(1);
      expectTexts(
        texts,
        [
          'card-label-page',
          'card-label-panel',
          'run-label',
          'card-badge',
          'card-output-label',
          'card-output-text',
          'card-code',
          'card-attribution',
          'card-subagent-state',
          'card-max-tokens',
        ],
        `tool-cards:${mode}:${theme}`,
      );
      expect(focus.filter((f) => f.name.startsWith('card-button'))).toHaveLength(11);
      expectFocus(focus, `tool-cards:${mode}:${theme}`);
    } finally {
      await page.close();
    }
  });
});

test('0019：結果框的 pre 鍵盤聚焦後，方向鍵捲得動（#1682 PR B）', async () => {
  const page = await openOverlay('tool-steps', 'light', { marks: { [TOOL_STANDALONE]: {} } });
  try {
    const pre = page.locator(`${TOOL_STANDALONE} [data-slot="output-block"]:last-child > pre`);
    // 鍵盤操作過，聚焦才算 `:focus-visible`；Tab 走到那一格。
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      if (await pre.evaluate((el) => el === document.activeElement)) break;
    }
    const before = await pre.evaluate((el) => ({
      focused: el === document.activeElement,
      scrollTop: el.scrollTop,
      overflow: el.scrollHeight > el.clientHeight,
    }));
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
    // 鍵盤捲動是平滑捲動，等它停下來。
    await page
      .waitForFunction((el) => el !== null && el.scrollTop > 0, await pre.elementHandle(), {
        timeout: 2000,
      })
      .catch(() => undefined);
    const after = await pre.evaluate((el) => el.scrollTop);
    report['tool-steps:arrow-scroll'] = { ...before, after };
    // 量具自檢：真的超出框高、真的停在那一格上。
    expect(before).toEqual({ focused: true, scrollTop: 0, overflow: true });
    expect(after).toBeGreaterThan(0);
  } finally {
    await page.close();
  }
});

test('第 66 條：工具段裡空的那一則不留空格，清單頂端就是第一張卡（#1682 PR B）', async () => {
  const page = await openOverlay('tool-cards', 'light', {
    marks: { [`${CARDS} [data-slot="step-list"]`]: {} },
  });
  try {
    const measured = await page.$eval(`${CARDS} [data-slot="step-list"]`, (list) => {
      const top = list.getBoundingClientRect().top;
      const cells = [...list.children].map((cell) => ({
        display: getComputedStyle(cell).display,
        card: cell.querySelector('[data-slot="step-row"]') !== null,
        empty: cell.querySelector('[data-slot="message-scroller-item"]:empty') !== null,
      }));
      const card = list.querySelector('[data-slot="step-row"]');
      return { cells, gap: card === null ? -1 : card.getBoundingClientRect().top - top };
    });
    report['tool-cards:empty-cell'] = measured;
    // 量具自檢：段首真的有一格空的（guard 頁放了只有思考的那一步）。
    expect(measured.cells).toEqual([
      { display: 'none', card: false, empty: true },
      { display: 'block', card: true, empty: false },
      { display: 'block', card: true, empty: false },
    ]);
    // 第一張卡離清單頂端只有它自己那格的上 padding（`py-1.5`）加邊線，空格在的時候多一整格。
    expect(measured.gap).toBeGreaterThan(0);
    expect(measured.gap).toBeLessThanOrEqual(8);
  } finally {
    await page.close();
  }
});

describe.each(
  MODES.flatMap((mode) => (['light', 'dark'] as const).map((theme) => [mode, theme] as const)),
)('瀏覽器量推理列（#1683）：%s、%s', (mode, theme) => {
  test('頁面與 --panel 兩種底上的標題、「·」、摘要、內文（段落、清單、粗體、連結、行內 code）過 4.5；summary 的焦點（外框 offset 2px）', async () => {
    const page = await openOverlay('reasoning', theme, { mode, marks: reasoningMarks });
    try {
      const head = (await collectTexts(page)).filter((t) =>
        REASONING_HEAD.some((part) => t.name.startsWith(`reasoning-${part}-`)),
      );
      const focus = await collectFocus(page);
      // 外框離 summary 2px（覆寫檔 base layer 那條 `:focus-visible` 的 offset；collectFocus 不量 offset）。
      const offsets = await page.$$eval(
        `${REASONING_ROWS} [data-slot="reasoning"] > summary`,
        (els) =>
          els.map((el) => {
            (el as HTMLElement).focus();
            return {
              focusVisible: el.matches(':focus-visible'),
              offset: getComputedStyle(el).outlineOffset,
            };
          }),
      );
      report[`reasoning:${mode}:${theme}:outline-offset`] = offsets;
      expect(offsets).toEqual(Array(3).fill({ focusVisible: true, offset: '2px' }));
      await openReasoningRows(page, ['done', 'panel']);
      await settle(page);
      await markReasoningBody(page);
      const body = (await collectTexts(page)).filter((t) =>
        REASONING_BODY.some((part) => t.name.startsWith(`reasoning-${part}-`)),
      );
      const count = (texts: TextSample[]) =>
        Object.fromEntries(
          [...new Set(texts.map((t) => t.name))].map((name) => [
            name,
            texts.filter((t) => t.name === name).length,
          ]),
        );
      // 量具自檢：收著時兩種底上的標題、三列的「·」與摘要；打開後兩種底上的兩段、兩項清單、粗體、連結、行內 code 都量到。
      expect(count(head)).toEqual({
        'reasoning-title-page': 1,
        'reasoning-title-panel': 1,
        'reasoning-dot-page': 2,
        'reasoning-dot-panel': 1,
        'reasoning-trailing-page': 2,
        'reasoning-trailing-panel': 1,
      });
      expect(count(body)).toEqual(
        Object.fromEntries(
          ['page', 'panel'].flatMap((on) => [
            [`reasoning-body-${on}`, 2],
            [`reasoning-li-${on}`, 2],
            [`reasoning-strong-${on}`, 1],
            [`reasoning-link-${on}`, 1],
            [`reasoning-code-${on}`, 1],
          ]),
        ),
      );
      expectTexts(
        [...head, ...body],
        Object.keys(count([...head, ...body])),
        `reasoning:${mode}:${theme}`,
      );
      expect(focus.map((f) => f.name)).toEqual([
        'reasoning-summary-done-0',
        'reasoning-summary-running-0',
        'reasoning-summary-panel-0',
      ]);
      expectFocus(focus, `reasoning:${mode}:${theme}`);
    } finally {
      await page.close();
    }
  });
});

describe.each(['light', 'dark'] as const)('瀏覽器量推理列的「思考中」（#1683）：%s', (theme) => {
  const TITLE = `${reasoningIn('running')} > summary > span:first-child`;
  const readTitle = (page: Page) =>
    page.$eval(TITLE, (el) => {
      const own = getComputedStyle(el);
      // 漸層畫在標題自己身上、只透過字露出來：底色從上一層開始疊；自己那層只帶 opacity。
      const chain = [
        { backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none', opacity: own.opacity },
      ];
      for (let node = el.parentElement; node !== null; node = node.parentElement) {
        const style = getComputedStyle(node);
        chain.push({
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          opacity: style.opacity,
        });
      }
      return {
        name: el.textContent ?? '',
        shimmer: el.classList.contains('status-shimmer'),
        color: own.color,
        clip: own.backgroundClip,
        image: own.backgroundImage,
        animation: `${own.animationName} ${own.animationDuration}`,
        chain,
      };
    });

  test('平常：SG 的 status-shimmer（sg-status-shimmer 2.4s），漸層每個色標對底色都過 4.5', async () => {
    const page = await openOverlay('reasoning', theme, { marks: { [TITLE]: {} } });
    try {
      const title = await readTitle(page);
      const stops = [...title.image.matchAll(/(?:oklch|oklab|rgba?)\([^)]*\)/g)].map((m) => m[0]);
      const ratios = stops.map((stop) => ({ stop, ...worstOn(stop, title.chain) }));
      report[`reasoning:${theme}:shimmer`] = {
        ...title,
        chain: undefined,
        stops: ratios.map((r) => `${r.stop} ${round(r.ratio)}（${r.on}）`),
      };
      // 量具自檢：字真的是透明的、顏色來自三個色標的漸層、動畫在跑。
      expect(title).toMatchObject({
        name: '思考中',
        shimmer: true,
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
    } finally {
      await page.close();
    }
  });

  test('減少動態：停住、沒有漸層，字色照常過 4.5', async () => {
    const page = await openOverlay('reasoning', theme, {
      reducedMotion: true,
      marks: { [TITLE]: {} },
    });
    try {
      const title = await readTitle(page);
      const contrast = worstOn(title.color, title.chain);
      report[`reasoning:${theme}:shimmer-reduced`] = {
        ...title,
        chain: undefined,
        ratio: round(contrast.ratio),
      };
      expect(title).toMatchObject({
        name: '思考中',
        shimmer: true,
        image: 'none',
        animation: 'none 0s',
      });
      expect(contrast.ratio).toBeGreaterThanOrEqual(TEXT_MIN);
    } finally {
      await page.close();
    }
  });
});

describe('瀏覽器量推理列的行為與覆寫（#1683）', () => {
  const marks = { [REASONING_ROWS]: {} };

  test('AX 樹：三個 summary 是可展開的，名稱只有「思考過程」或「思考中」（摘要 aria-hidden 不進名稱），打開後報 expanded', async () => {
    const page = await openOverlay('reasoning', 'light', { marks });
    try {
      const cdp = await page.context().newCDPSession(page);
      const read = async () => {
        const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as {
          nodes: {
            ignored: boolean;
            role?: { value: string };
            name?: { value: string };
            properties?: { name: string; value: { value: unknown } }[];
          }[];
        };
        return nodes
          .filter((n) => !n.ignored && n.role?.value === 'DisclosureTriangle')
          .map((n) => ({
            name: n.name?.value,
            expanded: n.properties?.find((p) => p.name === 'expanded')?.value.value,
          }));
      };
      const closed = await read();
      await openReasoningRows(page, ['done', 'running', 'panel']);
      await settle(page);
      const opened = await read();
      report['reasoning:ax'] = { closed, opened };
      expect(closed).toEqual([
        { name: '思考過程', expanded: false },
        { name: '思考中', expanded: false },
        { name: '思考過程', expanded: false },
      ]);
      expect(opened.map((n) => n.expanded)).toEqual([true, true, true]);
    } finally {
      await page.close();
    }
  });

  test('推理列裡沒有 live region：推理不進 polite 區唸', async () => {
    const page = await openOverlay('reasoning', 'light', { marks });
    try {
      const live = await page.$$eval(
        `${REASONING_ROWS} [data-slot="reasoning"] :is([aria-live], [role="status"], [role="log"], [role="alert"])`,
        (els) => els.length,
      );
      const rows = await page.$$eval(
        `${REASONING_ROWS} [data-slot="reasoning"]`,
        (els) => els.length,
      );
      // 量具自檢：三列都在。
      expect(rows).toBe(3);
      expect(live).toBe(0);
    } finally {
      await page.close();
    }
  });

  test('內文的 .markdown 是 white-space: normal（轉接層那層 whitespace-normal 擋掉 SG 的 pre-wrap）', async () => {
    const page = await openOverlay('reasoning', 'light', { marks });
    try {
      const measured = await page.$eval(reasoningIn('done'), (row) => ({
        frame: getComputedStyle(row.querySelector(':scope > div')!).whiteSpace,
        markdown: getComputedStyle(row.querySelector('.markdown')!).whiteSpace,
      }));
      report['reasoning:white-space'] = measured;
      // 量具自檢：SG 的內文框真的是 pre-wrap。
      expect(measured).toEqual({ frame: 'pre-wrap', markdown: 'normal' });
    } finally {
      await page.close();
    }
  });

  test('打開後只有箭頭轉：沒有高度動效、沒有其他動畫（#1683 決定題 2）', async () => {
    const page = await openOverlay('reasoning', 'light', { marks });
    try {
      await openReasoningRows(page, ['done']);
      const animations = await page.$eval(reasoningIn('done'), (row) =>
        row.getAnimations({ subtree: true }).map((a) => ({
          kind: a.constructor.name,
          what:
            a instanceof CSSTransition
              ? a.transitionProperty
              : a instanceof CSSAnimation
                ? a.animationName
                : '',
          target: ((a.effect as KeyframeEffect | null)?.target?.tagName ?? '').toLowerCase(),
        })),
      );
      const open = await page.$eval(reasoningIn('done'), (row) => (row as HTMLDetailsElement).open);
      report['reasoning:animations'] = animations;
      expect(open).toBe(true);
      // 量具自檢：箭頭那條轉場量得到，代表打開的當下就在讀。
      expect(animations).toEqual([{ kind: 'CSSTransition', what: 'rotate', target: 'svg' }]);
    } finally {
      await page.close();
    }
  });

  test.each([
    [375, true],
    [1280, false],
  ] as const)('第 63 條（擴充）：%i 寬時 summary 至少 44px：%s', async (width, touch) => {
    const page = await openOverlay('reasoning', 'light', {
      viewport: { width, height: 900 },
      marks,
    });
    try {
      const heights = await page.$$eval(
        `${REASONING_ROWS} [data-slot="reasoning"] > summary`,
        (els) => els.map((el) => el.getBoundingClientRect().height),
      );
      report[`reasoning:height:${width}`] = heights;
      expect(heights).toHaveLength(3);
      // 1280 寬照 SG（一行字高）：量具自檢，44px 不是本來就有的。
      for (const h of heights) expect(h >= 44).toBe(touch);
    } finally {
      await page.close();
    }
  });

  test.each([
    [true, '0s'],
    [false, 'not-0s'],
  ] as const)(
    '第 64 條（擴充）：減少動態（%s）時 summary 箭頭的轉場時長',
    async (reducedMotion, expected) => {
      const page = await openOverlay('reasoning', 'light', { reducedMotion, marks });
      try {
        const durations = await page.$$eval(
          `${REASONING_ROWS} [data-slot="reasoning"] > summary > svg`,
          (els) => els.map((el) => getComputedStyle(el).transitionDuration),
        );
        report[`reasoning:chevron:${reducedMotion ? 'reduce' : 'normal'}`] = durations;
        expect(durations).toHaveLength(3);
        for (const d of durations) expect(d === '0s' ? '0s' : 'not-0s').toBe(expected);
      } finally {
        await page.close();
      }
    },
  );

  test('375 寬、還在想、摘要很長：第 70 條：summary 不超出欄寬、標題不折行，摘要往左裁、留著最新的字', async () => {
    const page = await openOverlay('reasoning', 'light', {
      viewport: { width: 375, height: 812 },
      marks,
    });
    try {
      const measured = await page.$eval('[data-guard-reasoning="running"]', (block) => {
        const summary = block.querySelector('summary')!;
        const title = summary.querySelector('span')!;
        const outer = block.querySelector('[data-testid="reasoning-summary"]')!;
        const inner = outer.firstElementChild!;
        const box = (el: Element) => el.getBoundingClientRect();
        return {
          summaryRight: box(summary).right,
          summaryHeight: box(summary).height,
          columnRight: box(block).right,
          titleHeight: box(title).height,
          titleLine: parseFloat(getComputedStyle(title).lineHeight),
          innerLeft: box(inner).left,
          outerLeft: box(outer).left,
          innerRight: box(inner).right,
          outerRight: box(outer).right,
          pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        };
      });
      report['reasoning:375-running'] = measured;
      expect(measured.summaryRight).toBeLessThanOrEqual(measured.columnRight + 0.5);
      // 第 70 條的第二個選擇器：標題不跟著摘要縮，只有一行、summary 仍是第 63 條的 44px。
      expect(measured.titleHeight).toBeLessThan(measured.titleLine * 1.5);
      expect(measured.summaryHeight).toBe(44);
      // 量具自檢：摘要真的放不下（裡面那層比外面寬、左邊被裁）。
      expect(measured.innerLeft).toBeLessThan(measured.outerLeft);
      expect(Math.abs(measured.innerRight - measured.outerRight)).toBeLessThanOrEqual(0.5);
      expect(measured.pageOverflow).toBe(false);
    } finally {
      await page.close();
    }
  });
});
