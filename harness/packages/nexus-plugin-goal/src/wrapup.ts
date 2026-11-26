/**
 * 目標被收掉之後的**模型面文字**：`renderWrapupContext` 是它唯一的來源。
 *
 * 照抄 dsh 的 `packages/goal/tool-goal/src/wrapup.ts`（對讀版本
 * `d347e703908d0406b7a7ef80e3a0e594d86b2215`，2026-09-04）。
 *
 * ## 我們要它的理由跟 dsh 不一樣，這件事得寫下來
 *
 * dsh 的檔頭說它「replacing the former hard turn stop」——它原本會硬停一輪，這段文字是
 * 為了讓模型在停之前還講得了一句話。**我們沒有那個硬停**：LangGraph 的迴圈本來就會讓
 * 模型再講一句。所以這段文字對我們的價值不在「有機會說話」，在**「不要再叫工具了」**。
 *
 * 順帶把一個未來會被翻出來的問題釘死：`ToolRunContext` 上那顆 `concludeTurn()` 在 dsh
 * **整個 `packages/goal/` 底下零使用**。這段文字完全取代了它，**不需要**再去找一個硬停
 * 的等價物。
 *
 * ## 一處形狀差異
 *
 * **回一個 `string`，不是 `ContentBlock[]`。** 同 `prompt.ts` 那一筆：dsh 的訊息內容是
 * 區塊陣列，而 `HumanMessage` 吃字串。窄一格，表達力相同。
 *
 * @module
 */

/**
 * 兩段文字共用的那一句。
 *
 * 它要求模型只講這個會話真的立得住的東西——收尾訊息是**整段自主執行唯一交付給人**的
 * 東西，而一個剛跑完十輪的模型最容易在這裡把「我大概做了什麼」講成「我做了什麼」。
 */
const GROUNDING =
  'Report only what earlier rounds and tool results in this session actually establish; ' +
  'when a detail is not in the session, say so instead of inventing it. ';

/**
 * 一顆自主輪次把目標收掉之後，緊接著注入給模型的那一段話。
 *
 * **它只在續行輪次的授權下注入**（見 `tools.ts` 的 `authority.kind === 'goal-round'`）：
 * 人自己打的 `complete` 不需要被告知自己剛做了什麼，而且那一輪本來就該由人決定下一步。
 *
 * @param objective - 被收掉那個目標的內容，照抄進文字裡讓模型對得上。
 * @param blockedReason - `blocked` 時模型自己報的那句話；`complete` 時不給。
 * @returns 完整的一段收尾指示。
 */
export function renderWrapupContext(objective: string, blockedReason?: string): string {
  const heading = `Objective: ${JSON.stringify(objective)}\n`;
  return blockedReason === undefined
    ? '<goal_complete>\n' +
        heading +
        'The goal is marked complete and this autonomous run is ending. Write the closing ' +
        'message to the user now: state the outcome, summarize what was done and how it was ' +
        'verified, and point to the concrete results (files, commits, or other artifacts). ' +
        GROUNDING +
        'Note anything the user should review or do next. Address the user directly. Do not ' +
        "call any more tools in this run; further work waits for the user's next instruction.\n" +
        '</goal_complete>'
    : '<goal_blocked>\n' +
        heading +
        `Blocked: ${JSON.stringify(blockedReason)}\n` +
        'The goal is marked blocked and this autonomous run is ending. Write the closing ' +
        'message to the user now: state what has been completed so far, describe the concrete ' +
        'blocking condition and what you tried, and say exactly what you need from the user to ' +
        'continue. ' +
        GROUNDING +
        'Address the user directly. Do not call any more tools in this run; further work ' +
        "waits for the user's next instruction.\n" +
        '</goal_blocked>';
}
