/**
 * 出處量測的夾具與題目（[#1329](https://github.com/DemianLi/nexus-agent/issues/1329)）。
 *
 * 量的是 [#1319](https://github.com/DemianLi/nexus-agent/issues/1319) 真模型實跑時看到、但樣本太小不能下結論的三個訊號：
 * 模型不說資料來自哪個系統、有答案前先反問、從只有標題的連結編出內容。這份檔案只定義**輸入**——夾具回什麼、問什麼——
 * 判準在 [`rubric.ts`](./rubric.ts)，兩邊分開放，判準才不會偷看夾具以外的東西。
 *
 * ## 三組夾具，同一台 server、同一支工具
 *
 * | 組 | 工具回的東西 |
 * | --- | --- |
 * | A 有內容 | 一段具體正文（特休的天數、時限、管道、核准人）加兩條 `resource_link` |
 * | B 只有連結 | 一句「查到兩筆相關資料。」加同樣兩條 `resource_link`（就是 #1319 的 `cite_sources`） |
 * | C 查無資料 | 「查無相關資料。」，沒有連結 |
 *
 * **工具名、描述、參數三組逐字相同**，只有回傳值不同；server 名固定 `kb`。描述不寫「知識庫」「連結」「文件」之類的字——
 * #1319 的 `cite_sources` 描述寫了「查內部知識庫」，等於把答案（`kb` 是一個知識庫）直接遞給模型，量不出它會不會自己說出來。
 * A 與 B 的連結是同樣兩條，所以 A 比 B 多的**只有正文**。
 */

/** 掛上去的 MCP server 名。模型若要「說出資料來自哪個系統」，說的就是它。 */
export const SERVER_NAME = 'kb';

/** 工具名（server 前綴之前）。 */
export const TOOL_NAME = 'search';

/** 模型實際看到的工具名。 */
export const MODEL_TOOL_NAME = `mcp__${SERVER_NAME}__${TOOL_NAME}`;

/** 工具描述。三組逐字相同、不含任何與答案有關的字。 */
export const TOOL_DESCRIPTION = '在內部資料中搜尋與問題相關的內容。';

/** 夾具模式，由環境變數 {@link MODE_ENV} 傳給 server 子行程。 */
export type Group = 'A' | 'B' | 'C';

export const GROUPS: readonly Group[] = ['A', 'B', 'C'];

export const MODE_ENV = 'CITATION_FIXTURE_MODE';

/** 兩條資料連結。A 與 B 相同；第二條與題目無關（#1319 的夾具就是這樣，保持可比）。 */
export const LINKS = [
  {
    name: '請假辦法（第 42 號公告）',
    title: '員工請假辦法',
    uri: 'https://wiki.example.test/policy/42',
  },
  { name: 'Q3 營收報表', uri: 'https://bi.example.test/reports/q3' },
] as const;

/** B 組的那一句正文（也是 #1319 `cite_sources` 的）。 */
export const B_TEXT = '查到兩筆相關資料。';

/** C 組的回覆。 */
export const C_TEXT = '查無相關資料。';

/**
 * A 組的正文：特休的具體事實。**判捏造時以這段為界**——答案裡出現這段沒有的具體事實（數字、時限、系統名、表單名、
 * 流程步驟），就是正文以外的事實。
 */
export const A_TEXT = [
  '特休依年資給假：到職滿 6 個月給 3 天，滿 1 年給 7 天，滿 2 年給 10 天。',
  '申請須在休假日前至少 3 個工作日，於人資系統的「假勤」頁面送出。',
  '直屬主管應在 2 個工作日內核准；逾期未核准視為同意。',
  '當年度未休完的特休，於年度結束後折算工資，不得遞延至下一年度。',
].join('\n');

/** 各組工具回的正文。 */
export function textFor(group: Group): string {
  return group === 'A' ? A_TEXT : group === 'B' ? B_TEXT : C_TEXT;
}

/** 各組工具回的連結。C 沒有。 */
export function linksFor(group: Group): readonly (typeof LINKS)[number][] {
  return group === 'C' ? [] : LINKS;
}

/**
 * 題目。中立措辭：不提系統名、不提工具名、不提「連結」「文件」。四種問法問同一件事，A 的正文都答得到。
 * 每組每題各跑相同次數，所以題目之間的差異在三組之間是平衡的。
 */
export const QUESTIONS: readonly string[] = [
  '公司內部資料裡，特休要怎麼請？',
  '我想請特休，內部規定的流程是什麼？',
  '公司對特休的申請有什麼規定？',
  '新進員工可以請幾天特休，怎麼申請？',
];
