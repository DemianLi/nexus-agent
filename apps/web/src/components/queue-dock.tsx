import type { ConversationStatus, QueueUpdateAction, WireQueuedInput } from '@nexus/wire';
import { Check, ChevronDown, ListEnd, Pencil, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Textarea } from '@/components/ui/textarea';
import type { QueueUpdateRejected } from '@/hooks/use-conversation';
import { useSettledQueue } from '@/hooks/use-settled-queue';
import type { QueueRow } from '@/hooks/use-settled-queue';
import {
  isQueueParked,
  QUEUE_GONE_TEXT,
  QUEUE_PARKED_TEXT,
  queueHeading,
  queuePreview,
} from '@/lib/queue-view';

/** 無障礙名稱裡帶多少字的預覽：同一個佇列裡的「編輯」「刪除」要分得出是哪一則。 */
const LABEL_PREVIEW_CHARS = 24;

/** 某一列的某顆鈕。逐列比對屬性，不把 id 拼進選擇器（id 由伺服器給，不擔保是合法的選擇器字元）。 */
function rowAction(
  root: HTMLElement | null,
  id: string,
  action: 'edit' | 'remove',
): HTMLElement | null {
  const row = [...(root?.querySelectorAll<HTMLElement>('[data-queue-item]') ?? [])].find(
    (candidate) => candidate.getAttribute('data-queue-item') === id,
  );
  return row?.querySelector<HTMLElement>(`[data-queue-action="${action}"]`) ?? null;
}

function labelPreview(text: string): string {
  const chars = [...queuePreview(text)];
  return chars.length > LABEL_PREVIEW_CHARS
    ? `${chars.slice(0, LABEL_PREVIEW_CHARS).join('')}…`
    : chars.join('');
}

export interface QueueDockProps {
  readonly items: readonly WireQueuedInput[];
  readonly status: ConversationStatus;
  /** 線斷了就什麼都送不出去。 */
  readonly connected: boolean;
  onUpdate(itemId: string, action: QueueUpdateAction): Promise<QueueUpdateRejected | undefined>;
  /** 焦點原本在佇列裡、而它要去的那一列不在了：交給輸入框（看得到的話）。 */
  onFocusFallback(): void;
}

/**
 * 輸入框上方的送出佇列（[#645](https://github.com/DemianLi/nexus-agent/issues/645)）：人送出、還沒開跑的那幾句。
 * 資料是 harness 的投影 `ConversationState.inbox`（#637），所以別的分頁或 CLI 排的也在這裡，重新整理後照樣回來。
 * 行為照 dsh `QueueDock`（`packages/client/ui-conversation/src/client/queue/QueueDock.tsx`，`477b4f4`），外觀照我們的。
 *
 * - **位置**：待辦面板下面、換手區外面（Q7）。停在核准點時輸入框被面板換掉，佇列照樣看得到、改得到。
 * - **空的不畫**；一件直接畫；兩件以上預設收合，表頭寫件數，清單自己捲。有一列在編輯或送出中時強制展開。
 * - **停住**（Q6）：表頭多一行 {@link QUEUE_PARKED_TEXT}，判斷在 {@link isQueueParked}。
 * - **每一列**：攤成一行的預覽，加上編輯與刪除。沒有插話（#637 Q3 另開）。
 * - **就地編輯**：Enter 存、Shift+Enter 換行、Esc 取消；組字中不存；空白不能存。
 * - **改、刪失敗用 toast**，不進頂端紅字。那一件已經不在隊裡時講 {@link QUEUE_GONE_TEXT}：編輯中的那件被領走時
 *   編輯器自己收掉，跟伺服器回「不在隊裡」是同一件事，只講一次。
 * - **焦點不掉到 body**：收掉編輯器、刪掉一列、佇列整個消失時，焦點原本在佇列裡的話，交給旁邊那一列，沒有就交給
 *   {@link QueueDockProps.onFocusFallback}。
 */
export function QueueDock({ items, status, connected, onUpdate, onFocusFallback }: QueueDockProps) {
  const rows = useSettledQueue(items);
  const live = rows.filter((row) => !row.leaving);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<{ readonly id: string; readonly text: string }>();
  const [busy, setBusy] = useState<string>();
  const root = useRef<HTMLElement>(null);
  /** 已經講過「不在隊裡」的那幾件，同一件不講第二次。 */
  const toldGone = useRef(new Set<string>());

  const present = new Set(items.map((item) => item.id));
  const goneEditing = editing !== undefined && !present.has(editing.id) ? editing.id : undefined;

  // 編輯中的那一件不在了（開跑或被別的分頁刪了）：收掉編輯器，說一次。焦點由下面那個 effect 接手。
  useEffect(() => {
    if (goneEditing === undefined) return;
    setEditing(undefined);
    if (!toldGone.current.has(goneEditing)) {
      toldGone.current.add(goneEditing);
      toast(QUEUE_GONE_TEXT);
    }
  }, [goneEditing]);

  // 清空之後，下一次出現回到收合（照 dsh）。
  useEffect(() => {
    if (rows.length === 0) setOpen(false);
  }, [rows.length]);

  // **焦點所在的那一列開始淡出**（刪掉了、開跑了、別的分頁刪的）：交給旁邊還在的那一列，沒有就交出去。
  // 不等它真的卸載：卸載那一刻焦點已經掉到 body 了。
  useEffect(() => {
    const active = document.activeElement;
    const row = active instanceof HTMLElement ? active.closest('[data-queue-item]') : null;
    if (row === null || !(root.current?.contains(row) ?? false)) return;
    if (!row.hasAttribute('data-leaving')) return;
    const id = row.getAttribute('data-queue-item');
    const index = rows.findIndex((candidate) => candidate.item.id === id);
    const after = rows.slice(index + 1).find((candidate) => !candidate.leaving);
    const before = rows
      .slice(0, Math.max(index, 0))
      .reverse()
      .find((candidate) => !candidate.leaving);
    const neighbour = after ?? before;
    const target =
      neighbour === undefined ? null : rowAction(root.current, neighbour.item.id, 'remove');
    if (target) target.focus();
    else onFocusFallback();
  }, [rows, onFocusFallback]);

  if (rows.length === 0) return null;

  const locked = !connected || busy !== undefined || editing !== undefined;
  const parked = isQueueParked(status, live.length);

  const update = async (id: string, action: QueueUpdateAction): Promise<boolean> => {
    setBusy(id);
    const rejected = await onUpdate(id, action);
    setBusy(undefined);
    if (rejected === undefined) return true;
    if (rejected.gone) {
      if (!toldGone.current.has(id)) {
        toldGone.current.add(id);
        toast(QUEUE_GONE_TEXT);
      }
    } else {
      toast.error(action.kind === 'edit' ? '改不了這一則' : '刪不掉這一則', {
        description: rejected.message,
      });
    }
    return false;
  };

  const save = async () => {
    if (editing === undefined || editing.text.trim() === '') return;
    const { id, text } = editing;
    if (await update(id, { kind: 'edit', text })) {
      setEditing(undefined);
      requestAnimationFrame(() => rowAction(root.current, id, 'edit')?.focus());
    }
  };

  const cancelEdit = (id: string) => {
    setEditing(undefined);
    requestAnimationFrame(() => rowAction(root.current, id, 'edit')?.focus());
  };

  const onEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>, id: string) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      // 只收這個編輯器：不讓 Esc 往外冒到換手區或頁面上別的監聽。
      event.preventDefault();
      event.stopPropagation();
      cancelEdit(id);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void save();
    }
  };

  const renderRow = (row: QueueRow) => {
    const { item, leaving } = row;
    const isEditing = editing?.id === item.id && !leaving;
    const preview = queuePreview(item.text);
    const label = labelPreview(item.text);
    return (
      <li
        key={item.id}
        data-queue-item={item.id}
        data-leaving={leaving || undefined}
        aria-hidden={leaving || undefined}
        className="animate-in fade-in-0 flex min-w-0 items-start gap-2 rounded-[20px] px-3 py-1 text-sm transition-opacity duration-(--duration-quick) motion-reduce:animate-none motion-reduce:transition-none data-[leaving]:opacity-0 motion-reduce:data-[leaving]:hidden"
      >
        {isEditing ? (
          <>
            <Textarea
              autoFocus
              aria-label="改這一則排著的訊息"
              value={editing.text}
              onChange={(event) => setEditing({ id: item.id, text: event.target.value })}
              onKeyDown={(event) => onEditorKeyDown(event, item.id)}
              disabled={busy === item.id}
              className="max-h-32 min-h-9 flex-1 resize-none overflow-y-auto rounded-2xl py-1.5"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11 shrink-0 lg:size-8"
              aria-label="存下改過的這一則"
              title="存下（Enter）"
              disabled={!connected || busy !== undefined || editing.text.trim() === ''}
              onClick={() => void save()}
            >
              <Check />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11 shrink-0 lg:size-8"
              aria-label="取消編輯"
              title="取消（Esc）"
              disabled={busy !== undefined}
              onClick={() => cancelEdit(item.id)}
            >
              <X />
            </Button>
          </>
        ) : (
          <>
            {live.length === 1 && (
              <ListEnd
                aria-hidden
                className="text-muted-foreground mt-2.5 size-4 shrink-0 lg:mt-2"
              />
            )}
            <span
              className="min-h-11 min-w-0 flex-1 truncate py-2.5 lg:min-h-8 lg:py-1.5"
              title={preview}
            >
              {preview}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11 shrink-0 lg:size-8"
              data-queue-action="edit"
              aria-label={`編輯：${label}`}
              title="編輯"
              disabled={locked || leaving}
              onClick={() => setEditing({ id: item.id, text: item.text })}
            >
              <Pencil />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11 shrink-0 lg:size-8"
              data-queue-action="remove"
              aria-label={`刪除：${label}`}
              title="刪除"
              disabled={locked || leaving}
              onClick={() => void update(item.id, { kind: 'remove' })}
            >
              <Trash2 />
            </Button>
          </>
        )}
      </li>
    );
  };

  const hint = parked && (
    <p className="text-muted-foreground px-3 pt-1 text-xs" data-testid="queue-parked">
      {QUEUE_PARKED_TEXT}
    </p>
  );
  const list = (
    <ul className="max-h-45 overflow-y-auto" aria-label="排著的訊息">
      {rows.map(renderRow)}
    </ul>
  );

  return (
    <section
      ref={root}
      aria-label="送出佇列"
      data-testid="queue-dock"
      className="bg-card mb-2 rounded-3xl border p-1"
    >
      {live.length <= 1 && rows.length <= 1 ? (
        <>
          {hint}
          {list}
        </>
      ) : (
        <Collapsible
          open={open || editing !== undefined || busy !== undefined}
          onOpenChange={setOpen}
        >
          <CollapsibleTrigger
            disabled={editing !== undefined || busy !== undefined}
            className="group text-muted-foreground hover:bg-chip-hover active:bg-chip-pressed flex min-h-11 w-full min-w-0 items-center gap-2 rounded-[20px] px-3 text-left text-xs transition-colors duration-(--duration-quick) disabled:cursor-default lg:min-h-9"
          >
            <ListEnd aria-hidden className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{queueHeading(live.length)}</span>
            <ChevronDown
              aria-hidden
              className="size-4 shrink-0 transition-transform duration-(--duration-fast) ease-(--ease-smooth-out) group-data-[state=open]:rotate-180"
            />
          </CollapsibleTrigger>
          {hint}
          <CollapsibleContent className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden">
            {list}
          </CollapsibleContent>
        </Collapsible>
      )}
    </section>
  );
}
