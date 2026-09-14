/**
 * 續接時把對話灌回模型（[#306](https://github.com/DemianLi/nexus-agent/issues/306)）。
 *
 * 照 dsh：日誌是對話的真相，模型歷史由日誌推出來（推的規則在 `@nexus/core` 的
 * {@link replayConversation}），**不是把 checkpointer 落盤**——所以門 B 照舊不開
 * （`session-resume-doors.test.ts` 的 `THE_ONLY_SAVER`）。#251 反對門 B 的理由是兩份耐久來源的寫入順序會
 * 分岔；這條路只有一份耐久來源，graph state 是從它推的。
 *
 * ## 時刻
 *
 * 建好 agent 之後、第一輪之前，用 `updateState` 寫進 `messages`——pump 已經這樣寫過兩次（`#withdraw` 的
 * ToolMessage、`#keepInterruptedReply` 的半段回覆）。一條沒有 checkpoint 的 thread 也寫得進去，之後的第一輪
 * 照常接在後面（實測）。兩個入口各叫一次：serve 碰到以前寫過的 thread（`serve.ts`），CLI 的 `--resume`
 * （`cli.ts`）。
 *
 * **只寫 `messages`，不碰 `_summarizationEvent`。** 壓縮過的會話灌回去的是「摘要＋之後的」，那一串就是新
 * state 的原始訊息串；帶著舊的切點進去，基座下一次壓縮會拿它當 `previousCutoffIndex`，切到別的地方去。
 *
 * **寫不進去就讓這條 thread 起不來**：推的一側把「續接時灌回去的那一串」當成之後壓縮切點的座標
 * （`conversation-replay.ts` 的 end-seed 那一段），灌失敗了還接著跑，下一次續接就會拿錯的座標切。
 *
 * ## 回不來的
 *
 * 虛擬檔案系統（沒給 `--workspace` 時的檔案）、工具結果暫存（[#170](https://github.com/DemianLi/nexus-agent/issues/170)）
 * 與停在核准點還沒答的那張卡都在 graph state 裡，而那一軸（`stateSchema`＋checkpointer）是我們偏離 dsh 的產物
 * （[#155](https://github.com/DemianLi/nexus-agent/issues/155)），日誌上沒有它們。沒答的那張卡推回來是一則補上的
 * 錯誤結果（dsh 的 `repair.ts`），見 `conversation-replay.ts`。
 */

import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { replayConversation } from '@nexus/core';
import type { ConversationReplay, SessionEvent, UnreplayableReason } from '@nexus/core';
import { context } from 'langchain';

import { TOOL_RESULT_STASH_PREFIX } from './agent-factory.js';

/** 灌得進去的 agent 那一面。 */
export interface RestorableAgent {
  updateState(
    config: { readonly configurable: { readonly thread_id: string } },
    values: Record<string, unknown>,
  ): Promise<unknown>;
}

/* -------------------------------------------------------------------------- */
/* 過大的工具結果：模型看到的是基座換過的預覽                                   */
/* -------------------------------------------------------------------------- */
//
// 日誌記的是工具的輸出（`session-log.ts` 的 `tool/result`），模型看到的是基座 `FilesystemMiddleware` 換過的
// 那則：超過 80,000 字元的，換成一句「存在這個路徑、用 read_file 自己讀」加上頭尾預覽。推回去的要是模型看到的
// 那則，所以照同一條規則重算。**下面這幾樣逐字抄自基座**（`deepagents@1.13.1`，
// `dist/langsmith-zm0ILQsV.js` 的 `processToolMessage`、`createContentPreview`、`formatContentWithLineNumbers`、
// `TOO_LARGE_TOOL_MSG`），基座沒有匯出它們。`conversation-restore.test.ts` 拿真的基座換出來的那則逐字比對，
// 升級基座時字變了就紅在那裡。
//
// 預覽裡指的路徑**續接之後讀不到**：暫存在 graph state 裡（`agent-factory.ts` 的 `withToolResultStash`），
// 沒有跟著回來。重算的仍然是模型當時看到的字——續接前後模型看到同一則，讀不到那個檔是暫存回不來的後果，
// 另外披露。

/** 基座的 `toolTokenLimitBeforeEvict` 預設 `2e4`，乘 4 是字元數。組裝點沒改它。 */
const EVICTION_THRESHOLD_CHARS = 2e4 * 4;

/** 基座不搬的那幾顆：`FILESYSTEM_TOOL_NAMES` 去掉 `execute`。 */
const TOOLS_EXCLUDED_FROM_EVICTION: readonly string[] = [
  'ls',
  'read_file',
  'write_file',
  'edit_file',
  'delete',
  'glob',
  'grep',
];

/** 基座的 `MAX_LINE_LENGTH`。 */
const MAX_LINE_LENGTH = 5e3;

const TOO_LARGE_TOOL_MSG = context`
  Tool result too large, the result of this tool call {tool_call_id} was saved in the filesystem at this path: {file_path}
  You can read the result from the filesystem by using the read_file tool, but make sure to only read part of the result at a time.
  You can do this by specifying an offset and limit in the read_file tool call.
  For example, to read the first ${100} lines, you can use the read_file tool with offset=0 and limit=${100}.

  Here is a preview showing the head and tail of the result (lines of the form
  ... [N lines truncated] ...
  indicate omitted lines in the middle of the content):

  {content_sample}
`;

function stringifyToolContent(content: ToolMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block: unknown) =>
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'text' &&
        'text' in block &&
        typeof block.text === 'string'
          ? block.text
          : JSON.stringify(block),
      )
      .join('\n');
  }
  return String(content);
}

function sanitizeToolCallId(toolCallId: string): string {
  return toolCallId.replace(/\./g, '_').replace(/\//g, '_').replace(/\\/g, '_');
}

function formatContentWithLineNumbers(content: readonly string[], startLine: number): string {
  const resultLines: string[] = [];
  for (const [index, line] of content.entries()) {
    const lineNum = index + startLine;
    if (line.length <= MAX_LINE_LENGTH) {
      resultLines.push(`${lineNum.toString().padStart(6)}\t${line}`);
      continue;
    }
    const numChunks = Math.ceil(line.length / MAX_LINE_LENGTH);
    for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx += 1) {
      const start = chunkIdx * MAX_LINE_LENGTH;
      const chunk = line.substring(start, Math.min(start + MAX_LINE_LENGTH, line.length));
      const marker = chunkIdx === 0 ? lineNum.toString() : `${lineNum}.${chunkIdx}`;
      resultLines.push(`${marker.padStart(6)}\t${chunk}`);
    }
  }
  return resultLines.join('\n');
}

function createContentPreview(contentStr: string, headLines = 5, tailLines = 5): string {
  const lines = contentStr.split('\n');
  // 基座兩支都傳陣列進去，所以結尾的空行照留（它的字串版才會去掉）。
  if (lines.length <= headLines + tailLines) {
    return formatContentWithLineNumbers(
      lines.map((line) => line.substring(0, 1e3)),
      1,
    );
  }
  const head = lines.slice(0, headLines).map((line) => line.substring(0, 1e3));
  const tail = lines.slice(-tailLines).map((line) => line.substring(0, 1e3));
  const truncationNotice = `\n... [${lines.length - headLines - tailLines} lines truncated] ...\n`;
  return (
    formatContentWithLineNumbers(head, 1) +
    truncationNotice +
    formatContentWithLineNumbers(tail, lines.length - tailLines + 1)
  );
}

/**
 * 一則工具結果在模型那一格長什麼樣：照基座的規則，過大的換成預覽。
 *
 * @param message - 日誌裡記的那則（工具的輸出）。
 * @returns 沒過門檻或基座不搬的原樣；過了的換成基座那則。
 */
export function toolResultAsSeen(message: ToolMessage): ToolMessage {
  if (message.name !== undefined && TOOLS_EXCLUDED_FROM_EVICTION.includes(message.name)) {
    return message;
  }
  const text = stringifyToolContent(message.content);
  if (text.length <= EVICTION_THRESHOLD_CHARS) return message;
  const filePath = `${TOOL_RESULT_STASH_PREFIX}/${sanitizeToolCallId(message.tool_call_id)}.txt`;
  return new ToolMessage({
    content: TOO_LARGE_TOOL_MSG.replace('{tool_call_id}', message.tool_call_id)
      .replace('{file_path}', filePath)
      .replace('{content_sample}', createContentPreview(text)),
    tool_call_id: message.tool_call_id,
    name: message.name,
    id: message.id,
    artifact: message.artifact,
    status: message.status,
    metadata: message.metadata,
    additional_kwargs: message.additional_kwargs,
    response_metadata: message.response_metadata,
  });
}

/* -------------------------------------------------------------------------- */
/* 灌回去                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 從日誌推出對話、灌回這條 thread 的 graph state。推不出來就不灌（#306 拍板 2），模型從空的開始。
 *
 * @param agent - 剛建好、還沒跑過任何一輪的 agent。
 * @param threadId - checkpointer 認的那個 id。
 * @param events - 續接讀回來的 root 日誌。
 * @returns 推的結果，給入口披露用。
 * @throws `updateState` 拋錯——見檔頭「寫不進去就讓這條 thread 起不來」。
 */
export async function restoreConversation(
  agent: RestorableAgent,
  threadId: string,
  events: readonly SessionEvent[],
): Promise<ConversationReplay> {
  const replay = replayConversation(events, { toolResultAsSeen });
  if (replay.kind === 'replayed' && replay.messages.length > 0) {
    await agent.updateState(
      { configurable: { thread_id: threadId } },
      { messages: [...replay.messages] as BaseMessage[] },
    );
  }
  return replay;
}

const UNREPLAYABLE_TEXT: Readonly<Record<UnreplayableReason, string>> = {
  'reply-missing': '日誌裡少了模型的回覆（格式 9 以前寫的日誌不記回覆）',
  'result-missing': '日誌裡少了工具結果的內容（格式 9 以前寫的日誌不記內容）',
  'summary-missing': '日誌裡少了壓縮的摘要（格式 9 以前寫的日誌不記摘要）',
  'compaction-misaligned': '壓縮的切點對不上推出來的對話，灌回去會切錯地方',
};

/**
 * 續接時「對話回來了沒有」那半句。
 *
 * @param replay - {@link restoreConversation} 的結果。
 * @returns 接在入口的續接披露裡。
 */
export function formatConversationRestore(replay: ConversationReplay): string {
  if (replay.kind === 'unreplayable') {
    return `對話從空的開始：${UNREPLAYABLE_TEXT[replay.reason]}`;
  }
  return replay.messages.length === 0
    ? '日誌裡還沒有對話'
    : `對話照日誌推回模型（${replay.messages.length} 則）`;
}
