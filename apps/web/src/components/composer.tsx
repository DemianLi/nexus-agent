/**
 * 輸入框（規格 §4.2 列 26、27，#407）：shadcn `input-group`＋`textarea`，打 `/` 跳 shadcn `command` 選單。
 *
 * **草稿不住在這裡**：由呼叫端持有（`draft`／`onDraftChange`）。⑧ 會用 `hidden`＋`inert` 把輸入框換成面板（§4.3），
 * 就算哪天改成卸載，草稿也不會跟著丟。這裡只留游標與選單這種換掉也無妨的狀態。
 *
 * **選單的行為照 dsh**（觸發、排序、選了之後做什麼，見 `lib/slash-trigger.ts`）：焦點一直留在輸入框，
 * 方向鍵換選項，Enter／Tab 選，Esc 與 Shift＋Tab 收起，收起後同一個片段不再自己跳出來。
 * 選單沒開時 Enter 送出、Shift＋Enter 換行；打注音、拼音時的 Enter 是選字，不送出。
 *
 * **外觀與動效是 nexus 的**：浮層 250／150、縮放 .97／.99（§7，在 `ui/popover.tsx`）；送出鍵是實心主按鈕，
 * 按壓 .96（`styles/motion.css`）。
 */

import { ArrowUp, Square } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import type { SlashDescriptor } from '@nexus/wire';

import { Button } from '@/components/ui/button';
import { Command, CommandItem, CommandList } from '@/components/ui/command';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupText,
  InputGroupTextarea,
} from '@/components/ui/input-group';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { applySlashPick, detectSlash, slashCandidates } from '@/lib/slash-trigger';
import type { SlashHit } from '@/lib/slash-trigger';

/** 收起的是哪一個片段：同一個 `/`、同樣的字才算同一個。 */
function sameHit(left: SlashHit | null, right: SlashHit | null): boolean {
  return (
    left !== null &&
    right !== null &&
    left.start === right.start &&
    left.end === right.end &&
    left.query === right.query
  );
}

export function Composer({
  draft,
  onDraftChange,
  placeholder,
  canSend,
  onSubmit,
  commands,
  onRunCommand,
  decorated,
  stoppable,
  stopDisabled,
  onStop,
  textareaRef,
  meter,
}: {
  readonly draft: string;
  readonly onDraftChange: (draft: string) => void;
  readonly placeholder: string;
  /** 現在這份草稿送不送得出去。 */
  readonly canSend: boolean;
  /** 送出現在這份草稿（`canSend` 為真時才會叫）。 */
  readonly onSubmit: () => void;
  readonly commands: readonly SlashDescriptor[];
  /** 從選單直接執行一行命令；現在不能執行就回 false，那一行改留在草稿裡。 */
  readonly onRunCommand: (line: string) => boolean;
  /** 光打名字就另有動作的命令：從選單選到時直接執行，不等參數。 */
  readonly decorated?: ReadonlySet<string>;
  /** 有東西可停（一輪在跑，或停在核准點）。 */
  readonly stoppable: boolean;
  readonly stopDisabled: boolean;
  readonly onStop: () => void;
  readonly textareaRef?: RefObject<HTMLTextAreaElement | null>;
  /** 底列「Enter 送出」旁邊的用量表（#528）；資料由呼叫端接，這裡只管放哪。 */
  readonly meter?: ReactNode;
}) {
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const textarea = textareaRef ?? ownRef;
  const [caret, setCaret] = useState(draft.length);
  const [dismissed, setDismissed] = useState<SlashHit | null>(null);
  const [highlight, setHighlight] = useState(0);
  // 選了之後要把游標放回去的位置：草稿由呼叫端更新，要等它畫出來才放得進去。
  const pendingCaret = useRef<number | null>(null);

  const hit = detectSlash(draft, Math.min(caret, draft.length));
  // 照 dsh `InputTriggerController.track`：片段不見了、或換成別的片段，收起的記錄就作廢——刪光重打 `/` 要再跳出來。
  if (dismissed !== null && !sameHit(hit, dismissed)) setDismissed(null);
  const candidates = hit === null ? [] : slashCandidates(commands, hit);
  const open = hit !== null && candidates.length > 0 && !sameHit(hit, dismissed);
  const active = open ? candidates[Math.min(highlight, candidates.length - 1)] : undefined;

  // cmdk 自己產生選項與清單的 id（傳進去的會被蓋掉），選中哪一項也是它在自己的 effect 裡更新。所以盯著清單的
  // `aria-selected`，讀回來給輸入框的 `aria-controls`／`aria-activedescendant`。
  const [list, setList] = useState<HTMLDivElement | null>(null);
  const [ids, setIds] = useState<{ list?: string; option?: string }>({});
  useEffect(() => {
    if (list === null) {
      setIds({});
      return;
    }
    const read = () => {
      const option = list.querySelector<HTMLElement>('[cmdk-item][aria-selected="true"]')?.id;
      setIds((previous) =>
        previous.list === list.id && previous.option === option
          ? previous
          : { list: list.id, ...(option === undefined ? {} : { option }) },
      );
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(list, { subtree: true, childList: true, attributeFilter: ['aria-selected'] });
    return () => observer.disconnect();
  }, [list]);

  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    const at = pendingCaret.current;
    pendingCaret.current = null;
    textarea.current?.setSelectionRange(at, at);
    setCaret(at);
  }, [draft, textarea]);

  function edit(next: string, at: number) {
    onDraftChange(next);
    setCaret(at);
    setHighlight(0);
  }

  function pick(command: SlashDescriptor) {
    if (hit === null) return;
    const result = applySlashPick(draft, hit, command, decorated);
    if (result.run !== undefined && !onRunCommand(result.run)) {
      // 現在不能執行（例如這一輪還在跑）：那一行留在草稿裡，看得到為什麼送不出去。
      const kept = `${draft.slice(0, hit.start)}${result.run}${draft.slice(hit.end)}`;
      const at = hit.start + result.run.length;
      pendingCaret.current = at;
      setDismissed(detectSlash(kept, at));
      edit(kept, at);
      return;
    }
    pendingCaret.current = result.caret;
    edit(result.draft, result.caret);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (open && active !== undefined) {
      switch (event.key) {
        case 'ArrowDown':
        case 'ArrowUp': {
          event.preventDefault();
          const step = event.key === 'ArrowDown' ? 1 : -1;
          const index = candidates.indexOf(active);
          setHighlight((index + step + candidates.length) % candidates.length);
          return;
        }
        case 'Enter':
          if (event.shiftKey) break;
          event.preventDefault();
          pick(active);
          return;
        case 'Tab':
          event.preventDefault();
          if (event.shiftKey) setDismissed(hit);
          else pick(active);
          return;
        case 'Escape':
          event.preventDefault();
          setDismissed(hit);
          return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (canSend) onSubmit();
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) setDismissed(hit);
      }}
    >
      {/* anchor 自己包一層：`asChild` 會把 InputGroup 的 `data-slot` 蓋掉。 */}
      <PopoverAnchor ref={anchorRef}>
        <InputGroup className="rounded-3xl">
          <label className="sr-only" htmlFor="prompt">
            要說的話
          </label>
          <InputGroupTextarea
            ref={textarea}
            id="prompt"
            rows={1}
            className="text-body max-h-48 min-h-12 px-4"
            value={draft}
            placeholder={placeholder}
            aria-controls={open ? ids.list : undefined}
            aria-activedescendant={open ? ids.option : undefined}
            onChange={(event) => {
              edit(event.target.value, event.target.selectionStart);
            }}
            onSelect={(event) => {
              setCaret(event.currentTarget.selectionStart);
            }}
            onKeyDown={onKeyDown}
          />
          <InputGroupAddon align="block-end" className="px-2 pb-2">
            <InputGroupText className="pl-2 text-xs">Enter 送出</InputGroupText>
            {meter}
            <div className="ml-auto flex items-center gap-2">
              {stoppable && (
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  className="size-11 rounded-full lg:size-9"
                  aria-label="停止"
                  disabled={stopDisabled}
                  onClick={onStop}
                >
                  <Square className="fill-current" />
                </Button>
              )}
              <Button
                type="button"
                size="icon"
                className="size-11 rounded-full lg:size-9"
                aria-label="送出"
                disabled={!canSend}
                onClick={onSubmit}
              >
                <ArrowUp />
              </Button>
            </div>
          </InputGroupAddon>
        </InputGroup>
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="start"
        className="w-(--radix-popover-trigger-width) p-1"
        aria-label="命令選單"
        // 焦點一直留在輸入框：打開、關掉都不搬；點輸入框本身不算點外面。**底列另一顆浮層的按鈕算外面**（用量表，
        // #528）：它也在輸入框裡，不收的話兩個浮層疊在同一個位置（真 Chrome 量過）。
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          const target = event.target;
          if (
            target instanceof Element &&
            anchorRef.current?.contains(target) &&
            target.closest('[data-slot="popover-trigger"]') === null
          ) {
            event.preventDefault();
          }
        }}
      >
        <Command
          shouldFilter={false}
          value={active?.name ?? ''}
          onValueChange={(name) => {
            const index = candidates.findIndex((command) => command.name === name);
            if (index !== -1) setHighlight(index);
          }}
          className="bg-transparent"
        >
          <CommandList
            ref={setList}
            label="命令"
            // 點選項時焦點不離開輸入框。
            onMouseDown={(event) => event.preventDefault()}
          >
            {candidates.map((command) => (
              <CommandItem
                key={command.name}
                value={command.name}
                onSelect={() => pick(command)}
                className="flex-col items-start gap-0.5 rounded-lg px-3 py-2"
              >
                <span className="font-mono text-sm">
                  /{command.name}
                  {command.input === undefined ? '' : ` ${command.input.hint}`}
                </span>
                <span className="text-muted-foreground text-xs">{command.description}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
