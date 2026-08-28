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

import type { Attribution, ConversationEntry, ConversationState } from '@nexus/wire';

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

function ToolBadge({ status }: { status: 'running' | 'done' | 'failed' }) {
  const label = status === 'running' ? '執行中' : status === 'done' ? '完成' : '失敗';
  return <span className="text-muted-foreground text-xs">{label}</span>;
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
