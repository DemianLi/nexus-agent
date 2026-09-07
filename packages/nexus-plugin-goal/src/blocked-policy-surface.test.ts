/**
 * 模型被告知的 blocked 政策：**兩個模型面各自還說著哪幾句**。
 *
 * 這是 [#187](https://github.com/DemianLi/nexus-agent/issues/187) 的第二半，配著
 * `tools.ts` 檔頭那段賭注一起讀（先落地的是那段散文，見
 * [#208](https://github.com/DemianLi/nexus-agent/pull/208)）。
 *
 * ## 為什麼這幾句話是承重的
 *
 * 閘門只數輪數——`roundsStarted < blockedAfterConsecutiveRounds`，一個純粹的計數器。
 * 「同一件事持續」那一半 dsh 明著交給模型（`index.ts:237-238`，對讀版本
 * `d347e703908d0406b7a7ef80e3a0e594d86b2215`），**任何地方都沒有機械檢查**。我們是忠實
 * 的 port，所以那個缺口也是照抄進來的。
 *
 * 撐住被交出去那一半的東西只有一件：**模型被告知了規則**。所以這幾句話一旦靜靜消失，
 * 壞掉的不是一條測試——是 #187 那份賭注的前提。屆時我們仍然會拿到 `blocked_reason`、
 * 仍然會落庫、`tools.test.ts` 仍然全綠，而模型從來沒有被告知「難不算 blocked」。
 * **這種壞法沒有任何現存的東西看得見**，那就是這個檔案存在的理由。
 *
 * ## 期望字串是**算出來的**，不是寫死的
 *
 * 門檻由 {@link THRESHOLD} 灌進去，而且**刻意不用預設的 3**：用預設值的話，「數字真的
 * 流得過去」與「有人把 3 寫死在句子裡」這兩件事長得一模一樣。換成 5 之後，寫死的那個
 * 實作當場紅。
 *
 * ## 哪幾件**不**在這裡，以及為什麼
 *
 * - **模型有沒有照做，不在這裡。** 那是 #187 剩下的那一半，要 live 證據，而且判準寫在
 *   卡上（理由指的是具體外部條件還是「難」；第 3 輪的理由跟第 1 輪是不是同一件事）。
 *   這一份只證明**規則有送到模型手上**，不證明它被遵守。
 * - **`blocked_reason` 必填與 `model-reported` 落庫不在這裡**——`tools.test.ts` 已經有
 *   （「blocked 帶理由就擋得住，理由用 model-reported 落庫」與「blocked 沒帶理由被擋」）。
 *   那兩件是**紀錄**機制，這一份管的是**告知**機制。
 * - **整段說明文字不釘。** 釘全文的話，每一次措辭調整都要來改這個檔案，而它擋不到任何
 *   真的會發生的壞法。釘的是承重的那幾個子句。
 * - **事後那句不重複排除條款，這一份不表態。** `goalToolBlockTooSoonMessage` 說了「撞到
 *   同一件事」而沒說「難不算」。要不要補是措辭選擇，不是這條賭注的前提，所以這裡既不
 *   要求它有、也不要求它沒有。
 */

import { describe, expect, it } from 'vitest';

import { createRegistry } from '@nexus/core';
import type { NamedEntry } from '@nexus/core';
import type { StructuredTool } from '@langchain/core/tools';

import { createGoalPlugin } from './index.js';
import { GOAL_UPDATE_TOOL_NAME, goalToolBlockTooSoonMessage } from './tools.js';

/**
 * 這一份用的門檻。**刻意不是預設的 3**——見檔頭。
 *
 * 下面每一個帶數字的期望字串都由它算出來，所以「把門檻寫死在句子裡」這個實作紅得掉。
 */
const THRESHOLD = 5;

/** 這一輪是第幾輪，用來組事後那句話。任何小於 {@link THRESHOLD} 的值都成立。 */
const CURRENT_ROUND = 2;

/**
 * 自己組一次，不借 `tools.test.ts` 的 `bench()`。
 *
 * **讀的是註冊表交出來的那顆工具**，不是 `tools.ts` 裡那個私有 `updateDescription()`
 * 的回傳值：模型讀到的是前者。一個「算對了字串但沒接上工具」的實作要紅在這裡。
 *
 * 名字刻意跟那個私有函式**分開**——這一份的整個重點就是那兩者不是同一個東西。
 */
function registeredDescription(): string {
  const registry = createRegistry();
  const exit = registry.enter({ id: 'goal#0', name: 'goal' });
  createGoalPlugin({ blockedAfterConsecutiveRounds: THRESHOLD }).apply(registry);
  exit();
  const tools: Map<string, NamedEntry<StructuredTool>> = registry.tools.effective(undefined);
  const found = tools.get(GOAL_UPDATE_TOOL_NAME);
  if (found === undefined) {
    throw new Error(
      `註冊表交不出 ${GOAL_UPDATE_TOOL_NAME}。` +
        '模型面的政策文字全部住在這顆工具的 description 裡（我們沒有提示詞通道，' +
        '見 tools.ts 檔頭那筆載體偏離），工具不在就等於整份政策沒送出去。',
    );
  }
  return found.value.description;
}

/** 事前那一面必須說出來的子句。`phrase` 是算出來的，不是寫死的字。 */
const CLAUSES: readonly { readonly what: string; readonly phrase: string }[] = [
  {
    what: '排除條款——難、不確定、還有活要做，都不算 blocked',
    phrase: 'difficulty, uncertainty, or useful remaining work is not blocked',
  },
  {
    what: '理由必須是一個具體的阻塞條件，而且要寫進 blocked_reason',
    phrase: 'concrete blocking condition you report in blocked_reason',
  },
  {
    what: '持續性要求——同一件事，連續 N 輪',
    phrase: `the same blocking condition has persisted for at least ${THRESHOLD} consecutive rounds`,
  },
];

const DESTINATION =
  '這幾句是 #187 那份賭注的前提：閘門只數輪數，「同一件事」那一半交給模型，' +
  '而撐住它的只有「模型被告知了規則」這一件。\n' +
  '要改的話先去讀 packages/nexus-plugin-goal/src/tools.ts 檔頭「門檻只數輪數」那一段，' +
  '以及 dsh 的 packages/goal/tool-goal/src/index.ts:119-121（guidance）與 :237-238（委派）。\n' +
  '**真的要拿掉這幾句，就要一起去把 #187 的賭注改掉**——不然那張卡的判準會在量一條' +
  '模型從來沒被告知過的規則。';

describe('blocked 政策的模型面', () => {
  it.each(CLAUSES)('事前那一面還說著：$what', ({ phrase }) => {
    expect(
      registeredDescription(),
      `update_goal 的說明裡找不到「${phrase}」。\n${DESTINATION}`,
    ).toContain(phrase);
  });

  /**
   * **門檻是流過去的，不是巧合。** 上面第三條已經帶了數字，這一條從反面再釘一次：
   * 預設值 3 不准出現在一個門檻是 5 的組裝裡。
   */
  it('事前那一面帶的是這一次的門檻，不是預設值', () => {
    const description = registeredDescription();
    expect(
      description,
      `門檻是 ${THRESHOLD}，說明裡卻還留著預設的 3。\n${DESTINATION}`,
    ).not.toContain('at least 3 consecutive rounds');
  });

  /**
   * **事後那一面。** 模型是在被擋下來的那一刻讀到這句話的，而它要能從這句話裡讀出兩件
   * 事：門檻是幾、以及要求的是「同一件事」。少了後者，模型會以為熬滿輪數就好。
   */
  it('事後那一句說得出門檻與「同一件事」', () => {
    const message = goalToolBlockTooSoonMessage(THRESHOLD, CURRENT_ROUND);
    for (const phrase of [`連續 ${THRESHOLD} 輪`, '撞到同一件事', `第 ${CURRENT_ROUND} 輪`]) {
      expect(message, `被擋時回的那句話裡找不到「${phrase}」。\n${DESTINATION}`).toContain(phrase);
    }
  });
});
