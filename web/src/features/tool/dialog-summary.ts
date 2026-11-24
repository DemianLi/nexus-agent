/**
 * 提問與待辦這兩顆工具的一行摘要：其他分頁（觀測）只想問「這顆工具若是提問或待辦，它那一行字是什麼」，
 * 不該自己去比工具名、再各自接上 `question` 與待辦的摘要函式。工具名的比對收在這裡，由 `adapter.test.ts` 的例外清單釘住。
 *
 * @module
 */

import type { AnswerEntry, ToolEntry } from '@nexus/wire';

import {
  ASK_USER_QUESTION,
  answersOfText,
  questionsOf,
  questionSummary,
} from '@/features/question';
import { TODO_WRITE, todosOf, todoSummary } from '@/features/tool/todo-view';

/**
 * 這顆工具若是提問或待辦，回它收著時的那一行字。`extra` 是待辦另起的「+N」（同時進行的其餘幾項），提問一律是 0。
 * 參數解不開（串流中途的半截 JSON）、或不是這兩顆工具就是 `undefined`，由呼叫端退回別的摘要。
 *
 * 提問的答案優先讀工具結果文字（線上那一份，#439），`answer`（本地那一則）只是舊日誌的退路。
 */
export function dialogToolSummary(
  entry: ToolEntry,
  answer: AnswerEntry | undefined,
): { readonly text: string; readonly extra: number } | undefined {
  if (entry.name === ASK_USER_QUESTION) {
    const questions = questionsOf(entry.input);
    if (questions === undefined) return undefined;
    const given = answersOfText(entry.text) ?? answer?.answers;
    return { text: questionSummary(questions, entry.status === 'done', given), extra: 0 };
  }
  if (entry.name === TODO_WRITE) {
    const todos = todosOf(entry.input);
    return todos === undefined ? undefined : todoSummary(todos);
  }
  return undefined;
}
