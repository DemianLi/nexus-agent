/**
 * 宿主頁工具量測的題目（[#2398](https://github.com/DemianLi/nexus-agent/issues/2398)，設計 `.docs/host-page-tools-2374-design-2026-11-03.md` Q8）。
 * 只定義**輸入**與期望的呼叫：宿主頁宣告的兩支工具、畫面上選了什麼、使用者問什麼。判準在 [`rubric.ts`](./rubric.ts)。
 *
 * 四類各兩題，每題都附畫面情境（選取的那台），選取的東西是設備編號加名稱，判分只認編號：
 *
 * | 類 | 問句 | 期望 |
 * | --- | --- | --- |
 * | `named` 指名設備 | 點名了另一台 | 叫對工具、對象是點名的那台 |
 * | `context` 指代不明 | 「這台」「它」 | 叫對工具、對象是選取的那台 |
 * | `unrelated` 跟畫面無關 | 跟設備無關 | 不叫宿主頁工具 |
 * | `two-step` 要兩步 | 一句話要兩次呼叫 | 兩次都叫到；有先後的照先後 |
 */

import type { HostToolDeclaration } from '@nexus/wire';

export type Category = 'named' | 'context' | 'unrelated' | 'two-step';

export const CATEGORIES: readonly Category[] = ['named', 'context', 'unrelated', 'two-step'];

const DEVICE_ID_PARAMETERS: HostToolDeclaration['parameters'] = {
  type: 'object',
  properties: { id: { type: 'string', description: '設備編號，例如 P-101' } },
  required: ['id'],
};

/** 宿主頁宣告的兩支工具，每題都帶這兩支。 */
export const HOST_TOOLS: readonly HostToolDeclaration[] = [
  {
    name: 'focus_device',
    description: '把 3D 畫面的鏡頭轉到指定的設備。',
    parameters: DEVICE_ID_PARAMETERS,
  },
  {
    name: 'highlight_device',
    description: '在 3D 畫面上把指定的設備標成高亮。',
    parameters: DEVICE_ID_PARAMETERS,
  },
];

/** 一次期望的呼叫：工具名（宣告時的名字）與 `id`。 */
export interface ExpectedCall {
  readonly name: string;
  readonly id: string;
}

export interface Question {
  readonly id: string;
  readonly category: Category;
  /** 宿主頁送的 `context.label`。 */
  readonly selected: string;
  readonly text: string;
  /** 期望的呼叫；`unrelated` 是空的。 */
  readonly expected: readonly ExpectedCall[];
  /** `expected` 要照順序叫（「先…再…」）。 */
  readonly ordered?: true;
}

export const QUESTIONS: readonly Question[] = [
  {
    id: 'n1',
    category: 'named',
    selected: 'P-101 冷卻水泵',
    text: '幫我把畫面轉到 P-204 進料泵。',
    expected: [{ name: 'focus_device', id: 'P-204' }],
  },
  {
    id: 'n2',
    category: 'named',
    selected: 'AHU-3 空調箱',
    text: '把 CH-1 冰水主機標出來給我看。',
    expected: [{ name: 'highlight_device', id: 'CH-1' }],
  },
  {
    id: 'c1',
    category: 'context',
    selected: 'P-101 冷卻水泵',
    text: '鏡頭轉過去這台。',
    expected: [{ name: 'focus_device', id: 'P-101' }],
  },
  {
    id: 'c2',
    category: 'context',
    selected: 'AHU-3 空調箱',
    text: '幫我把它高亮。',
    expected: [{ name: 'highlight_device', id: 'AHU-3' }],
  },
  {
    id: 'u1',
    category: 'unrelated',
    selected: 'P-101 冷卻水泵',
    text: '請假一般要提前幾天申請比較好？',
    expected: [],
  },
  {
    id: 'u2',
    category: 'unrelated',
    selected: 'T-12 儲槽',
    text: 'Excel 怎麼把兩欄合併成一欄？',
    expected: [],
  },
  {
    id: 'm1',
    category: 'two-step',
    selected: 'T-12 儲槽',
    text: '先把畫面轉到 V-7 安全閥，再把它高亮。',
    expected: [
      { name: 'focus_device', id: 'V-7' },
      { name: 'highlight_device', id: 'V-7' },
    ],
    ordered: true,
  },
  {
    id: 'm2',
    category: 'two-step',
    selected: 'P-101 冷卻水泵',
    text: '把 P-201 和 P-202 都標成高亮。',
    expected: [
      { name: 'highlight_device', id: 'P-201' },
      { name: 'highlight_device', id: 'P-202' },
    ],
  },
];
