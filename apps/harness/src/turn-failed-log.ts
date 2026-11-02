/**
 * 一輪失敗在伺服器日誌的那一行（[#1536](https://github.com/DemianLi/nexus-agent/issues/1536)）：**純函式**，serve 與測試共用。
 *
 * 管理者從使用者給的時間或 thread，在伺服器日誌找到這一行，用 `日誌第 N 筆` 回頭讀 `sessions/` 底下那份會話日誌，
 * 再用 `request_id` 去問模型閘道那一側「哪一次請求」。**只放編號與失敗碼，不放失敗訊息本文**：訊息可能帶路徑或使用者內容，
 * 那些留在會話日誌，誰能讀照會話日誌的規矩。
 *
 * ## 與 dsh 的偏離（理由 2：產品需求超出 dsh）
 *
 * dsh 的宿主不把回合失敗另外寫進行程日誌，失敗只在會話日誌與上線的 frame。nexus 是多人共用的 `serve`，管理者看的是一條行程日誌，
 * 需要一個能從時間或 thread 反查到會話日誌那一筆、再查到閘道那一次請求的入口（#1536）。所以多這一行，並且只放編號與失敗碼，不放訊息本文。
 * JSON 多出的鍵屬於 `settings/logger-console.ts` 偏離二（dsh 沒有 JSON）的延伸。
 *
 * @module
 */
import type { TurnFailedReport } from './thread-pump.js';

/** 供應商請求編號進文字行時最長幾個字元；進會話日誌的那一份不截。擋的是閘道亂送一個超長標頭灌滿日誌行。 */
export const MAX_REQUEST_ID_CHARS = 200;

/**
 * 文字模式的那一行本文（等級與名字的前綴由 logger 加）：
 * `[回合] thread "<id>" run "<run_id>" 失敗（日誌第 <seq> 筆）：<code> status=<n> request_id=<id>`。
 * 背景子代理的失敗，`seq` 是子代理自己那份日誌的，行裡改寫成 `失敗（子代理日誌 "<thread>/<run_id>" 第 <seq> 筆）`。
 * 沒有 run id（續答核准、直接叫 `submit` 的輪）就省略 `run "…"`；沒有 status／請求編號就省略那一段。
 */
export function turnFailedMessage(report: TurnFailedReport): string {
  const where = report.sessionId === undefined ? '日誌' : `子代理日誌 "${report.sessionId}" `;
  const run = report.runId === undefined ? '' : ` run "${report.runId}"`;
  const status = report.status === undefined ? '' : ` status=${String(report.status)}`;
  const requestId =
    report.requestId === undefined ? '' : ` request_id=${clipRequestId(report.requestId)}`;
  return `[回合] thread "${report.threadId}"${run} 失敗（${where}第 ${String(report.seq)} 筆）：${report.code}${status}${requestId}`;
}

/** JSON 模式多出的欄位（#1536）：文字行裡的每一格各一個鍵，不必再從文字拆。 */
export interface TurnFailedFields {
  readonly thread_id: string;
  readonly run_id?: string;
  readonly session_id?: string;
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
    ...(report.sessionId !== undefined && { session_id: report.sessionId }),
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
