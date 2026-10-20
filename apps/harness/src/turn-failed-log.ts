/**
 * 一輪失敗在伺服器日誌的那一行（[#1536](https://github.com/DemianLi/nexus-agent/issues/1536)）：**純函式**，serve 與測試共用。
 *
 * 管理者從使用者給的時間或 thread，在伺服器日誌找到這一行，用 `日誌第 N 筆` 回頭讀 `sessions/` 底下那份會話日誌，
 * 再用 `request_id` 去問模型閘道那一側「哪一次請求」。**只放編號與失敗碼，不放失敗訊息本文**：訊息可能帶路徑或使用者內容，
 * 那些留在會話日誌，誰能讀照會話日誌的規矩。
 *
 * @module
 */
import type { TurnFailedReport } from './thread-pump.js';

/** 供應商請求編號進文字行時最長幾個字元；進會話日誌的那一份不截。擋的是閘道亂送一個超長標頭灌滿日誌行。 */
export const MAX_REQUEST_ID_CHARS = 200;

/**
 * 文字模式的那一行本文（等級與名字的前綴由 logger 加）：
 * `[回合] thread "<id>" run "<run_id>" 失敗（日誌第 <seq> 筆）：<code> status=<n> request_id=<id>`。
 * 沒有 run id（續答核准、直接叫 `submit` 的輪）就省略 `run "…"`；沒有 status／請求編號就省略那一段。
 */
export function turnFailedMessage(report: TurnFailedReport): string {
  const run = report.runId === undefined ? '' : ` run "${report.runId}"`;
  const status = report.status === undefined ? '' : ` status=${String(report.status)}`;
  const requestId =
    report.requestId === undefined ? '' : ` request_id=${clipRequestId(report.requestId)}`;
  return `[回合] thread "${report.threadId}"${run} 失敗（日誌第 ${String(report.seq)} 筆）：${report.code}${status}${requestId}`;
}

/** JSON 模式多出的欄位（#1536）：文字行裡的每一格各一個鍵，不必再從文字拆。 */
export interface TurnFailedFields {
  readonly thread_id: string;
  readonly run_id?: string;
  readonly seq: number;
  readonly code: string;
  readonly status?: number;
  readonly provider_request_id?: string;
}

/** 同一份資料的結構化欄位。 */
export function turnFailedFields(report: TurnFailedReport): TurnFailedFields {
  return {
    thread_id: report.threadId,
    ...(report.runId !== undefined && { run_id: report.runId }),
    seq: report.seq,
    code: report.code,
    ...(report.status !== undefined && { status: report.status }),
    ...(report.requestId !== undefined && {
      provider_request_id: clipRequestId(report.requestId),
    }),
  };
}

function clipRequestId(requestId: string): string {
  return requestId.length > MAX_REQUEST_ID_CHARS
    ? `${requestId.slice(0, MAX_REQUEST_ID_CHARS)}…`
    : requestId;
}
