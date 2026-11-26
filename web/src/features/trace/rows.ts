/**
 * 條目 → 列：每則對話條目各自長出的列（第 0 版與結構化模式共用，內文永遠從條目來，不看投影）。
 *
 * @module
 */

import type {
  AnswerEntry,
  Attribution,
  ConversationEntry,
  ConversationState,
  ToolEntry,
} from '@nexus/wire';
import { decisionText } from '@/features/approval';
import {
  MAX_TOKENS_NOTICE,
  agentMessageCaption,
  dialogToolSummary,
  subagentLabel,
  subagentNames,
  firstLine,
  toolSummary,
  toolTitle,
} from '@/features/tool';
import { planOutcomeOf } from '@/features/plan';
import type { PlanOutcome } from '@/features/plan';
import { submittedPlanOf } from '@/shared/connection/plan-document';
import { pairAnswers } from '@/features/question';
import { settledNoticeText } from '@/features/queue';
import { mentionDisplayText } from '@/shared/lib/session-mention';
import { stoppedByTurnClock } from '@/shared/lib/stop-cause';
import { startsTurn } from '@/shared/lib/turn-start';
import { ENDING_LABEL } from '@/features/trace/model';
import type { EndingReason, TraceRow } from '@/features/trace/model';

/** 第一個有字的那一行。人的話與回覆常以空行開頭；`firstLine` 自己會把過長的行收在 500 字元。 */
function leadLine(text: string): string {
  return firstLine(text.trimStart()).trim();
}

function attributed(attribution: Attribution): { readonly attribution?: Attribution } {
  return attribution.kind === 'root' ? {} : { attribution };
}

function toolRowText(
  entry: ToolEntry,
  answer: AnswerEntry | undefined,
): { readonly summary: string; readonly outcome?: PlanOutcome } {
  const outcome = planOutcomeOf(entry);
  // 提問與待辦的摘要由 tool 切片回答；計劃是這裡的事。提問、計劃、待辦三種工具名互斥，先後不影響結果。
  const dialog = dialogToolSummary(entry, answer);
  if (dialog !== undefined) {
    return {
      summary: dialog.extra > 0 ? `${dialog.text}（另有 ${dialog.extra} 項進行中）` : dialog.text,
    };
  }
  const plan = submittedPlanOf(entry);
  if (plan !== undefined) {
    return { summary: plan.title, ...(outcome === undefined ? {} : { outcome }) };
  }
  return { summary: toolSummary(entry.name, entry.input) };
}

function endingRow(
  id: string,
  reason: EndingReason,
  summary: string,
  base: { readonly target: string; readonly attribution?: Attribution },
): TraceRow {
  return { kind: 'ending', key: `${id}:${reason}`, reason, summary, ...base };
}

/** 一則條目長出來的列（可能是零列），與它是不是開輪的條目。 */
export interface Item {
  readonly entry: ConversationEntry;
  readonly opens: boolean;
  readonly rows: TraceRow[];
}

/** 每則條目各自長出的列。**不看投影**：第 0 版與結構化模式共用，內文永遠從條目來。 */
export function itemsOf(state: ConversationState): Item[] {
  const { entries } = state;
  const answers = pairAnswers(entries);
  const consumed = new Set<AnswerEntry>(answers.values());
  const names = subagentNames(entries);
  return entries.map((entry): Item => {
    const rows: TraceRow[] = [];
    if (entry.kind === 'human') {
      rows.push({
        kind: 'input',
        key: entry.id,
        target: entry.id,
        entry,
        summary: leadLine(mentionDisplayText(entry.text)),
      });
      // 被準入閘門擋下（封存的會話，#633）：這一輪開了又立刻收，沒有模型呼叫，軌跡上就只有這句話和這一列收尾。
      if (entry.blocked === true) {
        rows.push(endingRow(entry.id, 'blocked', ENDING_LABEL.blocked, { target: entry.id }));
      }
    } else if (entry.kind === 'notice') {
      rows.push({
        kind: 'notice',
        key: entry.id,
        target: entry.id,
        entry,
        summary: settledNoticeText(entry.reason, entry.stopCause),
      });
    } else if (entry.kind === 'agent-message') {
      rows.push({
        kind: 'agent-message',
        key: entry.id,
        target: entry.id,
        entry,
        caption: agentMessageCaption(subagentLabel(names, entry.runId)),
        summary: leadLine(entry.text),
      });
    } else if (entry.kind === 'ai') {
      const base = { target: entry.id, ...attributed(entry.attribution) };
      const thinking = entry.reasoning;
      if (thinking !== undefined && thinking.trim() !== '') {
        rows.push({
          kind: 'thinking',
          key: `${entry.id}:thinking`,
          entry,
          text: thinking,
          ...base,
        });
      }
      if (entry.text.trim() !== '') {
        rows.push({
          kind: 'reply',
          key: `${entry.id}:reply`,
          entry,
          summary: leadLine(entry.text),
          ...base,
        });
      }
      if (entry.stopped === true) {
        const reason = stoppedByTurnClock(entry.stopCause) ? 'timed-out' : 'stopped';
        rows.push(endingRow(entry.id, reason, ENDING_LABEL[reason], base));
      }
      if (entry.maxTokens === true) {
        rows.push(endingRow(entry.id, 'max-tokens', MAX_TOKENS_NOTICE, base));
      }
      if (entry.error !== undefined) {
        rows.push(endingRow(entry.id, 'failed', entry.error, base));
      }
    } else if (entry.kind === 'tool') {
      const answer = answers.get(entry.id);
      const { summary, outcome } = toolRowText(entry, answer);
      rows.push({
        kind: 'tool',
        key: entry.id,
        target: entry.id,
        entry,
        title: toolTitle(entry.name),
        summary,
        ...(outcome === undefined ? {} : { outcome }),
        ...(answer === undefined ? {} : { answer }),
        ...attributed(entry.attribution),
      });
    } else if (entry.kind === 'decision') {
      rows.push({
        kind: 'decision',
        key: entry.id,
        target: entry.id,
        entry,
        summary: decisionText(entry),
      });
    } else if (entry.kind === 'answer') {
      if (!consumed.has(entry)) {
        rows.push({
          kind: 'answer',
          key: entry.id,
          target: undefined,
          entry,
          summary:
            entry.declined === true
              ? '拒絕回答這些問題'
              : entry.cancelled === true
                ? '放棄回答這些問題'
                : `已回答 ${entry.answers.length} 題`,
        });
      }
    } else if (entry.kind === 'compaction') {
      rows.push({ kind: 'compaction', key: entry.id, target: entry.id, entry });
    }
    // `deliverables`、`workspace-changes`：不長列，見檔頭的表。
    return { entry, opens: startsTurn(entry), rows };
  });
}
