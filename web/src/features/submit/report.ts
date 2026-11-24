/**
 * 送出沒成時講什麼。兩個組裝點（獨立頁面的 toast、嵌入版輸入框底下那一行）各自決定怎麼畫，字只在這裡留一份：
 * 標題、原因前的提示都是常數，兩種畫法各自把它們組起來。
 *
 * @module
 */

/**
 * 一句話沒送成的三種結果：
 *
 * - `rejected`：沒送出去（伺服器沒收下、附件上傳失敗、等不到命令清單）。草稿已放回。
 * - `uncertain`：斷在網路層，可能其實到了（#1335）。原樣重送帶同一個請求編號，不會重複。
 * - `cancelled`：人按了取消上傳。附件還在。
 */
export interface SubmitReport {
  readonly kind: 'rejected' | 'uncertain' | 'cancelled';
  /** 原因，原樣取自伺服器或上傳那一端。 */
  readonly message: string;
}

const TITLES: Readonly<Record<SubmitReport['kind'], string>> = {
  rejected: '這一句沒送出去',
  uncertain: '不確定這一句有沒有送到',
  cancelled: '已取消上傳',
};

/** 原樣重送的提示拆成兩段：兩種畫法在中間的標點不同。 */
const RETRY_HEAD = '原樣再按一次送出';
const RETRY_TAIL = '不會重複';

/** 標題。 */
export function reportTitle(report: SubmitReport): string {
  return TITLES[report.kind];
}

/** 標題底下的說明（獨立頁面 toast 的 `description`）。 */
export function reportDetail(report: SubmitReport): string {
  return report.kind === 'uncertain'
    ? `${RETRY_HEAD}，${RETRY_TAIL}。（${report.message}）`
    : report.message;
}

/** 併成一句（嵌入版輸入框底下那一行）。 */
export function reportLine(report: SubmitReport): string {
  switch (report.kind) {
    case 'uncertain':
      return `${TITLES.uncertain}，${RETRY_HEAD}${RETRY_TAIL}。（${report.message}）`;
    case 'rejected':
      return `${TITLES.rejected}：${report.message}`;
    case 'cancelled':
      return `${TITLES.cancelled}：${report.message}`;
  }
}
