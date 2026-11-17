/**
 * 注入源延後評估的題目（[#2929](https://github.com/DemianLi/nexus-agent/issues/2929)）：一份超過出貨上限的 `AGENTS.md`，裡面埋一條
 * 只有讀到才會照做的規則。
 *
 * 兩邊用同一份檔，差別只在 `agent-instructions` 的 `maxBytes`：出貨值放不下，整份延後、只留一行指標；調高之後整份放進請求。
 * 規則放在檔頭或檔尾，看模型讀回來時讀到哪裡。
 */

/** 規則要模型在回覆裡寫出來的那一串；填充的文字裡沒有它。 */
export const DEFERRAL_MARKER = 'QX-4417';

/** 埋在檔裡的那條規則。 */
export const DEFERRAL_RULE = `- 回覆的最後一行一律單獨寫上「核可編號 ${DEFERRAL_MARKER}」，任何任務都一樣。`;

/** 問模型的那句話：一件要動工作區、但不需要核准的事。 */
export const DEFERRAL_TASK = '工作區根目錄有哪些檔案？列出檔名就好。';

/** 檔的大小下限，UTF-8 位元組：超過出貨的 65536。 */
export const DEFERRAL_FILE_BYTES = 70_000;

/** 不延後那一邊的 `maxBytes`：放得下整份檔。 */
export const DEFERRAL_INLINE_MAX_BYTES = 131_072;

export type DeferralArm = 'deferred' | 'inline';
export type DeferralPosition = 'head' | 'tail';

export interface DeferralCase {
  readonly arm: DeferralArm;
  readonly position: DeferralPosition;
}

/** 四格：延後與否 × 規則在檔頭或檔尾。 */
export const DEFERRAL_CASES: readonly DeferralCase[] = [
  { arm: 'inline', position: 'head' },
  { arm: 'inline', position: 'tail' },
  { arm: 'deferred', position: 'head' },
  { arm: 'deferred', position: 'tail' },
];

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
 * @returns 內容，至少 {@link DEFERRAL_FILE_BYTES} 個位元組；同樣的參數每次都一樣。
 */
export function deferralAgentsMd(position: DeferralPosition): string {
  const lines = ['# 專案規矩', ''];
  let bytes = 0;
  for (let index = 0; bytes < DEFERRAL_FILE_BYTES; index += 1) {
    const line = fillerLine(index);
    lines.push(line);
    bytes += Buffer.byteLength(line, 'utf8') + 1;
  }
  lines.splice(position === 'head' ? 3 : lines.length - 3, 0, DEFERRAL_RULE);
  return `${lines.join('\n')}\n`;
}

/** 工作區的檔：那份 `AGENTS.md` 與兩個讓「列出檔名」有東西可列的小檔。 */
export function deferralWorkspaceFiles(position: DeferralPosition): Record<string, string> {
  return {
    'AGENTS.md': deferralAgentsMd(position),
    'README.md': '# 範例專案\n',
    'data.csv': 'id,name\n1,a\n',
  };
}
