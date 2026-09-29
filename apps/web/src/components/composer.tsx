/**
 * 輸入框（規格 §4.2 列 26、27，#407）：shadcn `input-group`＋`textarea`，打 `/` 跳 shadcn `command` 選單。
 *
 * **草稿不住在這裡**：由呼叫端持有（`draft`／`onDraftChange`）。⑧ 會用 `hidden`＋`inert` 把輸入框換成面板（§4.3），
 * 就算哪天改成卸載，草稿也不會跟著丟。這裡只留游標與選單這種換掉也無妨的狀態。
 *
 * **選單的行為照 dsh**（觸發、排序、選了之後做什麼，見 `lib/slash-trigger.ts`）：焦點一直留在輸入框，
 * 方向鍵換選項，Enter／Tab 選，Esc 與 Shift＋Tab 收起，收起後同一個片段不再自己跳出來。
 * 選單沒開時 Enter 送出、Shift＋Enter 換行；打注音、拼音時的 Enter 是選字，不送出。Cmd/Ctrl＋Enter 也送出，
 * 但標成加速的手勢，跑著時由呼叫端送成插話（#710）；草稿空白時它改成「把排著的全部改成插話」（`onSteerQueue`）。
 *
 * **打 `@` 跳檔案選單**（#653，規則見 `lib/file-mention.ts` 與 `lib/mention-menu.ts`）：跟 `/` 共用這一個浮層與
 * 同一套鍵盤，**先判 `@` 再判 `/`**。候選是非同步的：查詢一變就取消上一次，還沒回來時留著舊的列、那些列選不到，
 * Enter 與 Tab 在這時什麼都不做（dsh 的 `arbitrate`）；一列都還沒有時 Enter 照常送出——dsh 也是這樣，選單上沒有
 * 選中的那一列，Enter 就不歸選單管。資料夾按 Tab 往下鑽，Enter 是選定。沒給 `fileReferences`、或伺服器說沒有
 * 工作區時，`@` 就是普通字元。
 *
 * **同一個 `@` 選單也列會話與子代理**（#713，規則見 `lib/session-mention.ts`）：檔案、會話一起問、各回各的，分三段畫；
 * 選了會話就把伺服器編好的引用文字原樣插進草稿。`@/` 與 `@"` 開頭只問檔案。
 *
 * **外觀與動效是 nexus 的**：浮層 250／150、縮放 .97／.99（§7，在 `ui/popover.tsx`）；送出鍵是實心主按鈕，
 * 按壓 .96（`styles/motion.css`）。
 */

import { ArrowUp, Bot, ChevronRight, File, Folder, MessageSquare, Square } from 'lucide-react';
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import type {
  FileReferenceListOutcome,
  SessionReferenceListOutcome,
  SlashDescriptor,
} from '@nexus/wire';

import { Button } from '@/components/ui/button';
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupText,
  InputGroupTextarea,
} from '@/components/ui/input-group';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { applyMentionPick, detectMention } from '@/lib/file-mention';
import {
  MENTION_MENU_CLOSED,
  MENTION_SECTIONS,
  mentionMenuOpen,
  mentionPickable,
  mentionRowKey,
  reduceMentionMenu,
} from '@/lib/mention-menu';
import type { MentionRow, MentionSource } from '@/lib/mention-menu';
import { applySessionPick } from '@/lib/session-mention';
import { applySlashPick, detectSlash, slashCandidates } from '@/lib/slash-trigger';
import { isAcceleratedEnter } from '@/lib/submit-mode';
import type { SendHint, SubmitGesture } from '@/lib/submit-mode';

/** 一個片段：`/` 或 `@` 的位置、游標、中間的字。 */
interface Span {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

/** 收起的是哪一個片段：同一個位置、同樣的字才算同一個。 */
function sameHit(left: Span | null, right: Span | null): boolean {
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
  sendHint = { text: 'Enter 送出' },
  onSteerQueue,
  commands,
  onRunCommand,
  decorated,
  stoppable,
  stopDisabled,
  onStop,
  textareaRef,
  meter,
  fileReferences,
  sessionReferences,
}: {
  readonly draft: string;
  readonly onDraftChange: (draft: string) => void;
  readonly placeholder: string;
  /** 現在這份草稿送不送得出去。 */
  readonly canSend: boolean;
  /**
   * 送出現在這份草稿（`canSend` 為真時才會叫）。`gesture` 是 Enter（送出鈕同它）還是 Cmd/Ctrl+Enter，要排隊還是
   * 插話由呼叫端照 `lib/submit-mode.ts` 判（#710）。
   */
  readonly onSubmit: (gesture: SubmitGesture) => void;
  /** 底列左邊那句提示；跑著時呼叫端換成兩種送法各一句（#710）。 */
  readonly sendHint?: SendHint;
  /**
   * 草稿空白時按 Cmd/Ctrl+Enter：把排著的全部改成插話（#710，dsh 的 `canSteerQueue`）。**給了才生效**；呼叫端在
   * 現在沒東西可插時不要給，那個手勢就跟以前一樣什麼都不做。
   */
  readonly onSteerQueue?: () => void;
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
  /** `@` 的候選（#653）；要穩定，每換一次就重查一次。沒給就沒有 `@` 選單。 */
  readonly fileReferences?: (
    query: string,
    signal: AbortSignal,
  ) => Promise<FileReferenceListOutcome>;
  /**
   * `@` 的會話與子代理候選（#713）；同樣要穩定。沒給就只有檔案那一段。打 `@/` 或 `@"` 開頭時不問（那是檔案的路徑），
   * 其餘情況跟檔案一起問，每打一個字兩邊都取消上一次。
   */
  readonly sessionReferences?: (
    query: string,
    signal: AbortSignal,
  ) => Promise<SessionReferenceListOutcome>;
}) {
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const textarea = textareaRef ?? ownRef;
  const [caret, setCaret] = useState(draft.length);
  const [dismissed, setDismissed] = useState<Span | null>(null);
  const [highlight, setHighlight] = useState(0);
  // 選了之後要把游標放回去的位置：草稿由呼叫端更新，要等它畫出來才放得進去。
  const pendingCaret = useRef<number | null>(null);

  const at = Math.min(caret, draft.length);
  // 先判 `@` 再判 `/`（dsh `detectTrigger`）：`@/` 是一段路徑，不是命令。
  const mention = detectMention(draft, at);
  const hit = mention === null ? detectSlash(draft, at) : null;
  const span: Span | null = mention ?? hit;
  // 照 dsh `InputTriggerController.track`：片段不見了、或換成別的片段，收起的記錄就作廢——刪光重打 `/` 要再跳出來。
  if (dismissed !== null && !sameHit(span, dismissed)) setDismissed(null);
  const candidates = hit === null ? [] : slashCandidates(commands, hit);
  const open = hit !== null && candidates.length > 0 && !sameHit(hit, dismissed);
  const active = open ? candidates[Math.min(highlight, candidates.length - 1)] : undefined;

  const [menu, dispatchMenu] = useReducer(reduceMentionMenu, MENTION_MENU_CLOSED);
  const generation = useRef(0);
  const asking =
    mention !== null &&
    (fileReferences !== undefined || sessionReferences !== undefined) &&
    !sameHit(mention, dismissed);
  const mentionQuery = mention?.query;
  const mentionQuoted = mention?.quoted ?? false;
  const mentionStart = mention?.start;
  // 會話只在打普通的字時問：`@/…` 是路徑、`@"…` 是有空白的路徑（都只查檔案）。
  const wantSessions =
    sessionReferences !== undefined && !mentionQuoted && !(mentionQuery ?? '').startsWith('/');
  // 這一次想問的來源都確定不可用（伺服器說過沒有工作區、沒接落盤）：選單整個不開，也不再查。
  const mentionOff =
    (fileReferences === undefined || menu.availability.file === 'unavailable') &&
    (!wantSessions || menu.availability.session === 'unavailable');
  // 一個來源回來說不可用，不該讓另一個還在飛的請求重來：effect 只讀這一份，不把可用與否放進依賴。
  const availability = useRef(menu.availability);
  useLayoutEffect(() => {
    availability.current = menu.availability;
  });
  useEffect(() => {
    if (!asking || mentionQuery === undefined || mentionOff) {
      dispatchMenu({ type: 'close' });
      return;
    }
    generation.current += 1;
    const mine = generation.current;
    const controller = new AbortController();
    const sources: MentionSource[] = [];
    const askFiles = fileReferences !== undefined && availability.current.file !== 'unavailable';
    const askSessions = wantSessions && availability.current.session !== 'unavailable';
    if (askFiles) sources.push('file');
    if (askSessions) sources.push('session');
    dispatchMenu({ type: 'hit', generation: mine, sources });
    // 取消掉的那一次不用另外擋：取消之後不是緊接著新的一號，就是收起來，reducer 兩種都會丟掉它回來的東西。
    // 兩個來源各問各的：一個失敗、不可用或慢，都不拖累另一個。
    if (askFiles) {
      fileReferences(mentionQuery, controller.signal).then(
        (outcome) => {
          dispatchMenu({ type: 'settled', generation: mine, outcome, quoted: mentionQuoted });
        },
        () => {
          dispatchMenu({ type: 'failed', generation: mine, source: 'file' });
        },
      );
    }
    if (askSessions) {
      sessionReferences(mentionQuery, controller.signal).then(
        (outcome) => {
          dispatchMenu({ type: 'settled', generation: mine, source: 'session', outcome });
        },
        () => {
          dispatchMenu({ type: 'failed', generation: mine, source: 'session' });
        },
      );
    }
    return () => controller.abort();
  }, [
    asking,
    mentionQuery,
    mentionQuoted,
    mentionStart,
    mentionOff,
    wantSessions,
    fileReferences,
    sessionReferences,
  ]);
  const mentionOpen = asking && mentionMenuOpen(menu);

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

  function pickMention(row: MentionRow, action: 'pick' | 'drill') {
    if (mention === null) return;
    if (row.source !== 'file') {
      // 會話與子代理沒有往下鑽，Tab 也是選定；插進去的是伺服器編好的引用文字。
      const result = applySessionPick(draft, mention, row.candidate);
      pendingCaret.current = result.caret;
      edit(result.draft, result.caret);
      return;
    }
    const result = applyMentionPick(draft, mention, row.candidate, action);
    if (result === undefined) return;
    pendingCaret.current = result.caret;
    edit(result.draft, result.caret);
  }

  /** `@` 選單開著時這一鍵歸不歸它；歸它就回 true。 */
  function mentionKey(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    const pickable = mentionPickable(menu);
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault();
        dispatchMenu({ type: 'move', dir: event.key === 'ArrowDown' ? 1 : -1 });
        return true;
      case 'Escape':
        event.preventDefault();
        setDismissed(mention);
        return true;
      case 'Enter':
        if (event.shiftKey || menu.highlight === null) return false;
        event.preventDefault();
        // 還在查：留在畫面上的舊列選不到，也不送出。
        if (pickable !== undefined) pickMention(pickable, 'pick');
        return true;
      case 'Tab':
        if (event.shiftKey) {
          event.preventDefault();
          setDismissed(mention);
          return true;
        }
        if (menu.highlight === null) return false;
        event.preventDefault();
        if (pickable !== undefined) {
          pickMention(
            pickable,
            pickable.source === 'file' && pickable.candidate.kind === 'directory'
              ? 'drill'
              : 'pick',
          );
        }
        return true;
    }
    return false;
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (mentionOpen && mentionKey(event)) return;
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
      const accelerated = isAcceleratedEnter(event);
      if (accelerated && draft.trim() === '' && onSteerQueue !== undefined) {
        onSteerQueue();
        return;
      }
      if (canSend) onSubmit(accelerated ? 'accelerated' : 'enter');
    }
  }

  return (
    <Popover
      open={open || mentionOpen}
      onOpenChange={(next) => {
        if (!next) setDismissed(span);
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
            aria-controls={open || mentionOpen ? ids.list : undefined}
            aria-activedescendant={open || mentionOpen ? ids.option : undefined}
            onChange={(event) => {
              edit(event.target.value, event.target.selectionStart);
            }}
            onSelect={(event) => {
              setCaret(event.currentTarget.selectionStart);
            }}
            onKeyDown={onKeyDown}
          />
          <InputGroupAddon align="block-end" className="px-2 pb-2">
            {/* `gap-0`：外殼是 flex、預設 `gap-2`，寬螢幕那一段會被隔開一大截（實機截圖量到）。 */}
            <InputGroupText className="gap-0 pl-2 text-xs" data-testid="send-hint">
              {sendHint.text}
              {sendHint.wide !== undefined && (
                <span className="hidden sm:inline">{sendHint.wide}</span>
              )}
            </InputGroupText>
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
                onClick={() => onSubmit('enter')}
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
        aria-label={mentionOpen ? '@ 選單' : '命令選單'}
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
        {mentionOpen ? (
          <MentionList
            rows={menu.rows}
            highlight={menu.highlight}
            loading={menu.status === 'pending'}
            listRef={setList}
            onHover={(index) => dispatchMenu({ type: 'hover', index })}
            onPick={(row) => {
              // 還在查的時候點舊列不算（同 Enter）。
              if (menu.status === 'ready') pickMention(row, 'pick');
            }}
          />
        ) : (
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
        )}
      </PopoverContent>
    </Popover>
  );
}

/** 段的標題（Q4：檔案、會話、子代理）。 */
const SECTION_HEADINGS = { file: '檔案', session: '會話', subagent: '子代理' } as const;

/**
 * `@` 選單的列（#653、#713）：檔案寫名字加父目錄，資料夾右邊一個「Tab」提示與箭頭（按 Tab 往下鑽）；會話寫標題，
 * 別的專案後面加目錄名；子代理寫它屬於哪條會話。分段照檔案、會話、子代理，**只有檔案時不畫段標題**（跟原來一樣）。
 * 一列都還沒有時畫兩行骨架。高度上限 400px（dsh 的 `MenuView`）。
 */
function MentionList({
  rows,
  highlight,
  loading,
  listRef,
  onHover,
  onPick,
}: {
  readonly rows: readonly MentionRow[];
  readonly highlight: number | null;
  readonly loading: boolean;
  readonly listRef: (element: HTMLDivElement | null) => void;
  readonly onHover: (index: number) => void;
  readonly onPick: (row: MentionRow) => void;
}) {
  const active = highlight === null ? undefined : rows[highlight];
  const sectioned = rows.some((row) => row.source !== 'file');
  const item = (row: MentionRow) => {
    const key = mentionRowKey(row);
    if (row.source === 'file') {
      const directory = row.candidate.kind === 'directory';
      const Icon = directory ? Folder : File;
      return (
        <CommandItem
          key={key}
          value={key}
          onSelect={() => onPick(row)}
          className="gap-2 rounded-lg px-3 py-2"
        >
          <Icon aria-hidden className="text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">
            <span className="text-sm">{row.name}</span>
            {row.parent !== undefined && (
              <span className="text-muted-foreground ml-2 text-xs">{row.parent}</span>
            )}
          </span>
          {directory && (
            <span aria-hidden className="text-muted-foreground flex items-center gap-1 text-xs">
              Tab
              <ChevronRight className="size-3" />
            </span>
          )}
        </CommandItem>
      );
    }
    const Icon = row.source === 'subagent' ? Bot : MessageSquare;
    return (
      <CommandItem
        key={key}
        value={key}
        onSelect={() => onPick(row)}
        className="gap-2 rounded-lg px-3 py-2"
      >
        <Icon aria-hidden className="text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">
          <span className="text-sm">{row.name}</span>
          {row.hint !== undefined && (
            <span className="text-muted-foreground ml-2 text-xs">{row.hint}</span>
          )}
        </span>
      </CommandItem>
    );
  };
  return (
    <Command
      shouldFilter={false}
      value={active === undefined ? '' : mentionRowKey(active)}
      onValueChange={(key) => {
        const index = rows.findIndex((row) => mentionRowKey(row) === key);
        if (index !== -1) onHover(index);
      }}
      className="bg-transparent"
    >
      <CommandList
        ref={listRef}
        label="@ 引用"
        aria-busy={loading}
        className="max-h-100"
        onMouseDown={(event) => event.preventDefault()}
      >
        {rows.length === 0 && loading && (
          <div className="flex flex-col gap-2 px-3 py-2" data-testid="mention-skeleton">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        )}
        {sectioned
          ? MENTION_SECTIONS.map((section) => {
              const inSection = rows.filter((row) => row.source === section);
              return inSection.length === 0 ? null : (
                <CommandGroup key={section} heading={SECTION_HEADINGS[section]}>
                  {inSection.map(item)}
                </CommandGroup>
              );
            })
          : rows.map(item)}
      </CommandList>
    </Command>
  );
}
