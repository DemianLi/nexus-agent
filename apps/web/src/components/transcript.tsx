/**
 * 對話的呈現。
 *
 * 四種東西：使用者說的、模型說的、工具跑的、人在核准點上按的。**最後那一種只有
 * 本地記得**——下行不回聲決定，被拒絕掉的那一批在線上連一顆 frame 都沒有，所以
 * 這一則就是它存在過的唯一證據（見 `@nexus/wire` 的 `appendDecision`）。
 *
 * 模型與工具都可能來自 subagent，
 * 而**歸屬是折疊器 join 出來的**——線上沒有 subagent 的名字，只有 namespace 樹
 * （見 `@nexus/wire` 的 `conversation.ts`）。join 不起來的時候它說「未歸屬」，
 * 這裡就照樣顯示未歸屬：**寧可說不知道，不要說錯**。
 */

import type {
  AnswerEntry,
  Attribution,
  ConversationEntry,
  ConversationState,
  ToolEntry,
} from '@nexus/wire';

function AttributionBadge({ attribution }: { attribution: Attribution }) {
  if (attribution.kind === 'root') {
    return null;
  }
  const label = attribution.kind === 'subagent' ? `子代理 ${attribution.name}` : '未歸屬的子代理';
  return (
    <span className="bg-secondary text-secondary-foreground rounded px-1.5 py-0.5 text-xs">
      {label}
    </span>
  );
}

const TOOL_STATUS_LABEL = {
  running: '執行中',
  // **不是「執行中」也不是「失敗」**：這顆呼叫停在那裡等一個人。講「執行中」會讓人以為
  // 只要等就好，講「失敗」是說謊（[#239](https://github.com/DemianLi/nexus-agent/issues/239)）。
  suspended: '等你回答',
  done: '完成',
  failed: '失敗',
} as const satisfies Record<ToolEntry['status'], string>;

function ToolBadge({ status }: { status: ToolEntry['status'] }) {
  return <span className="text-muted-foreground text-xs">{TOOL_STATUS_LABEL[status]}</span>;
}

/**
 * 一則問答紀錄在畫面上的那一行。
 *
 * **三格，不是「已回答：」加一個 join。** 原本一律寫「已回答：」再把 `answers` 攤開接起來，
 * 於是「放棄整組」——它的 `answers` 是空的——長出「已回答：」後面一片空白
 * （[#239](https://github.com/DemianLi/nexus-agent/issues/239) 在真瀏覽器裡量到的三處說謊
 * 之一）。而**放棄不是一種回答**：全跳過仍然是一份答案、工具正常回傳，放棄則讓工具收到
 * 錯誤，模型知道人不打算走這條路（見 `@nexus/wire` 的 `AnswerEntry.cancelled`）。畫成同
 * 一句話，就是把這兩件事在畫面上抹平。
 *
 * **第三格是防它從別的入口長回來。** 空的 `answers` 而且沒有 `cancelled` today 走不到
 * UI（問答卡送得出去的只有「逐題有交代」與「放棄整組」兩種），但 `appendAnswers` 收任何
 * 一份 `answers`、包含空陣列，型別上那條路開著。留一句說得出口的話，比留一片空白誠實。
 */
function answerSummary(entry: AnswerEntry): string {
  if (entry.cancelled === true) {
    return '放棄了這組問題——一題都沒有回答。';
  }
  if (entry.answers.length === 0) {
    return '已回答：（這一則沒有帶任何一題）';
  }
  const body = entry.answers
    .map((answer) => {
      const picked = [...answer.selected, ...(answer.custom === undefined ? [] : [answer.custom])];
      // 空的 `selected` 且沒有 `custom` ＝ 那一題被跳過（照抄 dsh 的編碼）。
      return `${answer.id}＝${picked.length === 0 ? '（跳過）' : picked.join('、')}`;
    })
    .join('，');
  return `已回答：${body}`;
}

function Entry({ entry }: { entry: ConversationEntry }) {
  if (entry.kind === 'human') {
    return (
      <li className="flex justify-end">
        <p className="bg-primary text-primary-foreground max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap">
          {entry.text}
        </p>
      </li>
    );
  }

  if (entry.kind === 'decision') {
    const approved = entry.decision === 'approve';
    return (
      <li className="text-muted-foreground text-xs" data-testid="decision-entry">
        {approved ? '已核准' : entry.decision === 'reject' ? '已拒絕' : entry.decision}：
        {entry.actions.join('、')}
        {!approved && '（沒有執行）'}
      </li>
    );
  }

  if (entry.kind === 'answer') {
    return (
      <li className="text-muted-foreground text-xs" data-testid="answer-entry">
        {answerSummary(entry)}
      </li>
    );
  }

  if (entry.kind === 'tool') {
    return (
      <li className="flex flex-col gap-1" data-testid="tool-entry">
        <div className="flex items-center gap-2">
          <AttributionBadge attribution={entry.attribution} />
          <code className="text-sm font-medium">{entry.name}</code>
          <ToolBadge status={entry.status} />
        </div>
        <pre className="text-muted-foreground overflow-x-auto text-xs">{entry.input}</pre>
        {entry.error !== undefined && <p className="text-destructive text-xs">{entry.error}</p>}
      </li>
    );
  }

  const indented = entry.attribution.kind !== 'root';
  return (
    <li
      className={indented ? 'border-border ml-4 border-l pl-3' : undefined}
      data-testid="ai-entry"
    >
      <div className="flex items-center gap-2">
        <AttributionBadge attribution={entry.attribution} />
        {entry.streaming && (
          <span className="text-muted-foreground text-xs" role="status">
            輸入中…
          </span>
        )}
      </div>
      <p className="text-sm whitespace-pre-wrap">{entry.text}</p>
      {entry.error !== undefined && <p className="text-destructive text-xs">{entry.error}</p>}
    </li>
  );
}

export function Transcript({ state }: { state: ConversationState }) {
  if (state.entries.length === 0) {
    return <p className="text-muted-foreground text-sm">還沒有訊息。</p>;
  }
  return (
    <ul className="flex flex-col gap-4">
      {state.entries.map((entry) => (
        <Entry key={entry.id} entry={entry} />
      ))}
    </ul>
  );
}
