/**
 * 注入源預算評估的題目（[#2929](https://github.com/DemianLi/nexus-agent/issues/2929)、[#2934](https://github.com/DemianLi/nexus-agent/issues/2934)）：
 * 一份超過預算的 `AGENTS.md`，裡面埋一條只有讀到才會照做的規則。放不下時 `agent-instructions` 把檔截到預算上限、通知模型其餘用
 * `read_file` 讀，所以規則放在檔頭或檔尾，決定了它在不在截斷後看得到的那一段裡。
 *
 * 放得下與放不下兩邊用同一份檔，差別只在 `agent-instructions` 的 `maxBytes`。大檔（七萬位元組）在出貨值下被截，調高才整份放進請求；
 * 小檔（兩千位元組）在出貨值下整份放進請求，調低才被截：大檔上規則是一千條裡的一條，放得下時模型也未必照做，小檔才分得出
 * 「被截」本身的影響。
 */

/** 規則要模型在回覆裡寫出來的那一串；填充的文字裡沒有它。 */
export const DEFERRAL_MARKER = 'QX-4417';

/** 埋在檔裡的那條規則。 */
export const DEFERRAL_RULE = `- 回覆的最後一行一律單獨寫上「核可編號 ${DEFERRAL_MARKER}」，任何任務都一樣。`;

/** 問模型的那句話：一件要看工作區的事。 */
export const DEFERRAL_TASK = '工作區根目錄有哪些檔案？列出檔名就好。';

/**
 * 大檔的大小下限，UTF-8 位元組：超過 `agent-instructions` 出貨的上限，也超過 `read_file` 一頁讀得回來的量，所以檔尾的規則不在第一頁。
 */
export const DEFERRAL_FILE_BYTES = 70_000;

/** 大檔放得下那一邊的 `maxBytes`：放得下整份檔。 */
export const DEFERRAL_INLINE_MAX_BYTES = 131_072;

/** 小檔的大小下限，UTF-8 位元組：`read_file` 一次讀得完。 */
export const DEFERRAL_SMALL_FILE_BYTES = 2000;

/** 小檔放不下那一邊的 `maxBytes`：放不下那份小檔。 */
export const DEFERRAL_SMALL_MAX_BYTES = 1024;

export type DeferralArm = 'deferred' | 'inline';
export type DeferralPosition = 'head' | 'tail';

export type DeferralFile = 'large' | 'small';

export interface DeferralCase {
  readonly file: DeferralFile;
  readonly arm: DeferralArm;
  readonly position: DeferralPosition;
}

/**
 * 七格。大檔四格：放得下與否 × 規則在檔頭或檔尾。小檔三格：放得下一格（規則在檔頭），放不下兩格（規則在檔頭或檔尾）；小檔上規則只是
 * 三十一條（三十條填充加這一條）裡的一條，放得下那一格是放不下兩格的對照，檔尾那一格是規則落在截掉的那一段、要自己去讀才讀得到。
 */
export const DEFERRAL_CASES: readonly DeferralCase[] = [
  { file: 'large', arm: 'inline', position: 'head' },
  { file: 'large', arm: 'inline', position: 'tail' },
  { file: 'large', arm: 'deferred', position: 'head' },
  { file: 'large', arm: 'deferred', position: 'tail' },
  { file: 'small', arm: 'inline', position: 'head' },
  { file: 'small', arm: 'deferred', position: 'head' },
  { file: 'small', arm: 'deferred', position: 'tail' },
];

/** 報表與 `--only` 用的名字。 */
export const deferralCaseId = (testCase: DeferralCase): string =>
  `${testCase.file}/${testCase.arm}/${testCase.position}`;

/**
 * 這一格要蓋掉的 `agent-instructions.maxBytes`；`undefined` 是用出貨值。兩種檔各有一邊要調：大檔調高才放得下，小檔調低才放不下、被截。
 */
export function deferralMaxBytesOverride(testCase: DeferralCase): number | undefined {
  if (testCase.file === 'large' && testCase.arm === 'inline') return DEFERRAL_INLINE_MAX_BYTES;
  if (testCase.file === 'small' && testCase.arm === 'deferred') return DEFERRAL_SMALL_MAX_BYTES;
  return undefined;
}

const TOPICS = [
  '變數與函式用完整的英文單字命名，不用縮寫',
  '每個公開函式都要有說明，寫它做什麼與什麼時候會失敗',
  '測試檔跟被測的檔放在同一個目錄',
  '提交訊息用祈使句，一行說完做了什麼',
  '設定值從環境變數讀，不寫死在程式裡',
  '錯誤訊息要說出是哪個輸入、期望什麼',
  '日誌不印個人資料與金鑰',
  '相依套件升級要單獨一個提交',
  '資料表的欄位改名要附遷移腳本',
  '對外的介面改動要先寫進變更紀錄',
  '迴圈裡不做網路呼叫，先收集再一次送',
  '時間一律存 UTC，顯示時才換時區',
];

/** 填充的一行；跟規則同樣是清單項，內容是不相干的開發規矩。 */
const fillerLine = (index: number): string =>
  `- 第 ${index + 1} 條：${TOPICS[index % TOPICS.length]}。`;

/**
 * 產生那份 `AGENTS.md`。
 *
 * @param position - 規則放在第四行（`head`）或倒數第四行（`tail`）。
 * @param file - 大檔至少 {@link DEFERRAL_FILE_BYTES} 個位元組，小檔至少 {@link DEFERRAL_SMALL_FILE_BYTES} 個；省略即大檔。
 * @returns 內容；同樣的參數每次都一樣。
 */
export function deferralAgentsMd(position: DeferralPosition, file: DeferralFile = 'large'): string {
  const target = file === 'large' ? DEFERRAL_FILE_BYTES : DEFERRAL_SMALL_FILE_BYTES;
  const lines = ['# 專案規矩', ''];
  let bytes = 0;
  for (let index = 0; bytes < target; index += 1) {
    const line = fillerLine(index);
    lines.push(line);
    bytes += Buffer.byteLength(line, 'utf8') + 1;
  }
  lines.splice(position === 'head' ? 3 : lines.length - 3, 0, DEFERRAL_RULE);
  return `${lines.join('\n')}\n`;
}

/** 工作區的檔：那份 `AGENTS.md` 與兩個讓「列出檔名」有東西可列的小檔。 */
export function deferralWorkspaceFiles(testCase: DeferralCase): Record<string, string> {
  return {
    'AGENTS.md': deferralAgentsMd(testCase.position, testCase.file),
    'README.md': '# 範例專案\n',
    'data.csv': 'id,name\n1,a\n',
  };
}
