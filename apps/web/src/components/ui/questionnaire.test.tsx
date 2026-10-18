import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';

import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoices,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireSkip,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from '@/components/ui/questionnaire';

afterEach(cleanup);

/**
 * 選項掛的 `data-checked`／`data-disabled` 長什麼樣（#1523）。shadcn 的 `tailwind.css` 把 `data-checked:`、`data-disabled:` 重新定義成
 * `:where([data-checked]:not([data-checked="false"]), [data-state="checked"])` 這類：只認「有屬性且不是 `"false"`」。
 * primitive 輸出的是空字串、沒勾選就不掛，新舊兩種定義都命中同一批元素；哪天改成輸出 `"false"`，這裡先紅。
 * 畫出來的樣子在 `guard/`（問答的選項）量。
 */
test('勾選的掛 data-checked=""、沒勾選的不掛；停用的掛 data-disabled=""', () => {
  render(
    <Questionnaire item="q">
      <QuestionnaireItem name="q" multiple>
        <QuestionnaireTitle>選項</QuestionnaireTitle>
        <QuestionnaireChoices>
          <QuestionnaireChoice value="a" defaultChecked>
            已勾選
          </QuestionnaireChoice>
          <QuestionnaireChoice value="b">沒勾選</QuestionnaireChoice>
          <QuestionnaireChoice value="c" disabled>
            停用
          </QuestionnaireChoice>
        </QuestionnaireChoices>
      </QuestionnaireItem>
    </Questionnaire>,
  );
  const choice = (name: string) =>
    screen.getByText(name).closest('[data-slot=questionnaire-choice]');
  expect(choice('已勾選')?.getAttribute('data-checked')).toBe('');
  expect(choice('沒勾選')?.hasAttribute('data-checked')).toBe(false);
  expect(choice('停用')?.getAttribute('data-disabled')).toBe('');
  expect(choice('沒勾選')?.hasAttribute('data-disabled')).toBe(false);
  for (const name of ['已勾選', '沒勾選', '停用'])
    expect(choice(name)?.hasAttribute('data-state')).toBe(false);
});

/**
 * 第 45 條（#1638 PR C）：vendor 四顆按鈕的預設字是英文，包裝層補中文。`question-panel` 自己有給字，擋不住包裝層被拿掉；
 * 這裡刻意不給 children，吃的是預設值。
 */
test('上一題、跳過、下一題、送出答案：呼叫端沒給字時是中文', () => {
  const { container } = render(
    <Questionnaire item="q">
      <QuestionnaireItem name="q">
        <QuestionnaireTitle>題目</QuestionnaireTitle>
      </QuestionnaireItem>
      <QuestionnaireActions>
        <QuestionnairePrevious />
        <QuestionnaireSkip />
        <QuestionnaireNext />
        <QuestionnaireSubmit />
      </QuestionnaireActions>
    </Questionnaire>,
  );
  const text = (slot: string) =>
    container.querySelector(`[data-slot=questionnaire-${slot}]`)?.textContent;
  expect(text('previous')).toBe('上一題');
  expect(text('skip')).toBe('跳過');
  expect(text('next')).toBe('下一題');
  expect(text('submit')).toBe('送出答案');
  expect(container.textContent).not.toMatch(/Previous|Skip|Next|Submit/);
});

test('呼叫端給的字照用', () => {
  const { container } = render(
    <Questionnaire item="q">
      <QuestionnaireItem name="q">
        <QuestionnaireTitle>題目</QuestionnaireTitle>
      </QuestionnaireItem>
      <QuestionnaireActions>
        <QuestionnaireSubmit>交出去</QuestionnaireSubmit>
      </QuestionnaireActions>
    </Questionnaire>,
  );
  expect(container.querySelector('[data-slot=questionnaire-submit]')?.textContent).toBe('交出去');
});
