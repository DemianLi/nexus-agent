/**
 * PROTOTYPE #375 — 設計語言原型。丟棄分支 `prototype/375-design-language`，不合進 develop。
 *
 * 一條路由、幾個開關（`?approval=takeover|card&motion=system|full|reduce&theme=dark|light`）
 * 外加 `?button=new|old`，都在右上角的琥珀色切換列上。假資料，不連 harness。
 *
 * 動效照「動效策略」（#378）重寫：封閉的模式清單、reduced-motion 不是全關，
 * 切換列可以模擬減少動態，也有手動觸發面板換入換出與接續的按鈕。
 *
 * 跟 prototype 技能預設不同的兩處，是 demian 在這張卡的 Q2 拍板的：
 * - 不是「N 個結構完全不同的版本」，是卡片定義的三個切換軸（2×2×2）。
 * - 切換列放**右上角、header 底下**：底部是輸入框與核准面板，放底部會蓋住要看的東西。
 *
 * 元件來源照「每個 P0 元件各從哪裡拿」的結論：shadcn 當外殼與基礎件，不用 AI Elements
 * 的程式碼；markdown 那張卡決定自建，原型只顯示純文字。
 */

import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Hand,
  Moon,
  Plus,
  Square,
  Sun,
  X,
} from 'lucide-react';
import {
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { toast } from 'sonner';

import type {
  AiEntry,
  ConversationEntry,
  PendingApproval,
  PendingInput,
  PendingQuestion,
  ToolEntry,
} from '@nexus/wire';

import { Badge } from '@/components/ui/badge';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupText,
  InputGroupTextarea,
} from '@/components/ui/input-group';
import { Message, MessageContent, MessageFooter, MessageHeader } from '@/components/ui/message';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSkip,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from '@/components/ui/questionnaire';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

import {
  AgentOrb,
  AutoHeight,
  Beam,
  OPTIONS,
  PButton,
  SettingsContext,
  useReducedMotion,
  useSettings,
  useViewportWidth,
  type Settings,
} from './kit';
import { JUMPS, useScenario, type Answer, type Jump, type ProtoState } from './scenario';

// 字型全部打包進本地（#377 Q39：完全內網），中文按 unicode-range 切片、只載用到的
import '@fontsource-variable/google-sans-flex';
import '@fontsource-variable/google-sans-code';
import '@fontsource-variable/noto-sans-tc';

import './tokens.css';

type Scenario = ReturnType<typeof useScenario>;

const THREADS = [
  '拆掉主 chunk 裡的 mermaid',
  '核准卡為什麼寫執行中',
  '子代理自動拒絕核准',
  'Proteus 迴圈上限',
  '（空白對話）',
];

export function PrototypeApp() {
  const [settings, update] = useSettings();
  const scenario = useScenario();
  const reduce = useReducedMotion(settings.motion);
  // 跳到某個狀態＝載入歷史／切換對話：舊訊息直接出現，不走進場（#378 Q8）
  const [history, setHistory] = useState({ key: 0, jumped: true });
  const jump = (to: Jump) => {
    setHistory((current) => ({ key: current.key + 1, jumped: true }));
    scenario.jump(to);
  };
  const live =
    <T extends unknown[]>(action: (...args: T) => undefined) =>
    (...args: T): undefined => {
      setHistory((current) => (current.jumped ? { ...current, jumped: false } : current));
      action(...args);
    };
  const driven: Scenario = {
    ...scenario,
    jump,
    // 重播＝同一批 id 從頭再來一次：換 key 重新掛載，讓每則都當成新到的
    replay: () => {
      setHistory((current) => ({ key: current.key + 1, jumped: false }));
      scenario.replay();
    },
    send: live(scenario.send),
    decide: live(scenario.decide),
    answer: live(scenario.answer),
  };
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-proto-375', '');
    root.classList.toggle('dark', settings.theme === 'dark');
  }, [settings.theme]);

  return (
    <SettingsContext.Provider value={settings}>
      <TooltipProvider>
        <SidebarProvider className="h-svh">
          <ThreadSidebar onJump={jump} />
          <SidebarInset className="bg-background flex h-svh min-w-0 flex-col">
            <Header state={scenario.state} settings={settings} update={update} />
            {scenario.state.entries.length === 0 ? (
              <Hero onStart={driven.replay} />
            ) : (
              <Transcript
                key={history.key}
                scenario={driven}
                settings={settings}
                animateInitial={!history.jumped}
                reduce={reduce}
              />
            )}
            <ComposerZone scenario={driven} settings={settings} />
          </SidebarInset>
        </SidebarProvider>
        <Switcher
          settings={settings}
          update={update}
          scenario={driven}
          onOpenDialog={() => setDialogOpen(true)}
        />
        <FeedbackDialog open={dialogOpen} onOpenChange={setDialogOpen} />
        <Toaster theme={settings.theme} position="top-center" />
      </TooltipProvider>
    </SettingsContext.Provider>
  );
}

function ThreadSidebar({ onJump }: { onJump: Scenario['jump'] }) {
  return (
    // axe 的 region 規則：側欄的內容要在地標裡，不然算「不在任何地標內」（#384）
    <Sidebar aria-label="對話" role="navigation">
      <SidebarHeader className="gap-3 p-3">
        <span className="px-2 pt-1 text-sm font-semibold">nexus</span>
        <PButton
          variant="secondary"
          className="h-11 justify-start rounded-full lg:h-9"
          onClick={() => onJump('空白')}
        >
          <Plus />
          新對話
        </PButton>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>最近</SidebarGroupLabel>
          <SidebarMenu>
            {THREADS.map((title, index) => (
              <SidebarMenuItem key={title}>
                <SidebarMenuButton isActive={index === 0} className="h-11 rounded-xl lg:h-9">
                  <span className="truncate">{title}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}

function Header({
  state,
  settings,
  update,
}: {
  state: ProtoState;
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}) {
  return (
    <header className="border-border flex h-14 shrink-0 items-center gap-2 border-b px-2">
      <SidebarTrigger className="size-11 rounded-full lg:size-9" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">拆掉主 chunk 裡的 mermaid</span>
        <StatusLine state={state} />
      </div>
      {/* 主題切換：#374 拍板自建 */}
      <Tooltip>
        <TooltipTrigger asChild>
          <PButton
            variant="ghost"
            size="icon"
            className="size-11 rounded-full lg:size-9"
            aria-label={settings.theme === 'dark' ? '換成亮色' : '換成暗色'}
            onClick={() => update({ theme: settings.theme === 'dark' ? 'light' : 'dark' })}
          >
            {settings.theme === 'dark' ? <Sun /> : <Moon />}
          </PButton>
        </TooltipTrigger>
        {/* tooltip：只淡入淡出＋小 blur，開 150（延遲 50）、關 150 */}
        <TooltipContent>{settings.theme === 'dark' ? '換成亮色' : '換成暗色'}</TooltipContent>
      </Tooltip>
    </header>
  );
}

/**
 * 狀態列是全站唯一的 role=status（#384 Q11、Q12）：待決面板出現、串流開始、失敗都由它唸。
 * 旁邊的 orb 只是同一件事的圖像，設 aria-hidden，不然會唸兩次。
 */
function StatusLine({ state }: { state: ProtoState }) {
  const streaming = state.entries.some((entry) => entry.kind === 'ai' && entry.streaming === true);

  let label: ReactNode;
  let orb: ReactNode = null;
  if (state.status === 'running') {
    label = <span className="proto-shimmer">{streaming ? '回覆中…' : '執行中…'}</span>;
    orb = <AgentOrb state="working" size={20} decorative />;
  } else if (state.status === 'awaiting-input') {
    label = state.pendings
      .map((pending, index) => pendingLabel(pending, { index, total: state.pendings.length }))
      .join('；');
    orb = <span className="size-2 rounded-full bg-(--brand)" aria-hidden />;
  } else if (state.status === 'failed') {
    label = <span className="text-destructive">這一輪失敗了：{state.error}</span>;
  } else {
    label = state.status === 'stopped' ? '已停止' : '就緒';
  }

  return (
    <p
      role="status"
      className="text-muted-foreground flex h-5 min-w-0 items-center gap-1.5 truncate text-xs"
    >
      {orb}
      <span className="truncate">{label}</span>
    </p>
  );
}

function Hero({ onStart }: { onStart: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
      <AgentOrb state="breathing" size={64} label="待命" />
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">今天要做什麼？</h1>
        <p className="text-muted-foreground text-sm">原型用假資料。按一個建議會播完整一輪。</p>
      </div>
      <div className="flex max-w-md flex-wrap justify-center gap-2">
        {['看看 build 為什麼變大', '整理 vite 設定', '幫我找出沒用到的相依'].map((text) => (
          <PButton
            key={text}
            variant="secondary"
            className="h-11 rounded-full px-4 lg:h-9"
            onClick={onStart}
          >
            {text}
          </PButton>
        ))}
      </div>
    </div>
  );
}

/**
 * registry 的 item 帶 `content-visibility:auto`＝paint containment：卡片的外陰影與光暈會被切成直角
 * （手機上工具卡下緣露出灰色直角、待決卡片後面一塊方框）。原型一律關掉；實作要另想保留長列表效能的辦法。
 */
const ITEM_CLASS = '[contain:none] [content-visibility:visible]';

function Transcript({
  scenario,
  settings,
  animateInitial,
  reduce,
}: {
  scenario: Scenario;
  settings: Settings;
  animateInitial: boolean;
  reduce: boolean;
}) {
  const { entries, pendings } = scenario.state;
  // 每則只在第一次出現時決定要不要進場；載入歷史（掛載時已經在的）不動
  const seen = useRef<Map<string, boolean> | null>(null);
  if (seen.current === null) {
    seen.current = new Map(entries.map((entry) => [entry.id, animateInitial]));
  }
  const rise = (id: string) => {
    const map = seen.current!;
    if (!map.has(id)) map.set(id, true);
    return map.get(id) === true ? 'motion-rise-in' : '';
  };

  /**
   * 串流中不唸逐字（#384 Q12）：對話列表的 role=log 關掉 live，
   * 改在回覆結束時把全文丟進一個 polite 區唸一次。
   */
  const [announced, setAnnounced] = useState('');
  const doneIds = useRef(new Set<string>());
  useEffect(() => {
    for (const entry of entries) {
      if (entry.kind !== 'ai' || entry.streaming === true || entry.text === '') continue;
      if (doneIds.current.has(entry.id)) continue;
      doneIds.current.add(entry.id);
      setAnnounced(entry.text);
    }
  }, [entries]);

  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport aria-label="對話訊息">
          <MessageScrollerContent
            aria-live="off"
            className="mx-auto w-full max-w-3xl gap-4 px-4 pt-6 pb-10"
          >
            {entries.map((entry) => (
              <MessageScrollerItem
                key={entry.id}
                messageId={entry.id}
                className={`${ITEM_CLASS} ${rise(entry.id)}`}
              >
                <EntryView entry={entry} />
              </MessageScrollerItem>
            ))}
            {settings.approval === 'card' &&
              pendings.map((pending) => (
                <MessageScrollerItem
                  key={pending.interruptId}
                  messageId={pending.interruptId}
                  className={`${ITEM_CLASS} ${rise(pending.interruptId)}`}
                >
                  <PendingView pending={pending} scenario={scenario} />
                </MessageScrollerItem>
              ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton className="rounded-full" behavior={reduce ? 'auto' : 'smooth'}>
          <ArrowDown />
          <span className="sr-only">捲到最新的訊息</span>
        </MessageScrollerButton>
      </MessageScroller>
      <p aria-live="polite" className="sr-only">
        {announced}
      </p>
    </MessageScrollerProvider>
  );
}

function EntryView({ entry }: { entry: ConversationEntry }) {
  switch (entry.kind) {
    case 'human':
      return (
        <Message align="end">
          <MessageContent>
            <Bubble variant="secondary" align="end">
              <BubbleContent className="text-body rounded-3xl px-4 py-2.5">
                {entry.text}
              </BubbleContent>
            </Bubble>
          </MessageContent>
        </Message>
      );
    case 'ai':
      return <AiView entry={entry} />;
    case 'tool':
      return <ToolCard entry={entry} />;
    case 'decision':
      return (
        <Marker>
          {entry.decision === 'approve' ? '你核准了' : '你拒絕了'} {entry.actions.join('、')}
        </Marker>
      );
    case 'answer':
      return (
        <Marker>
          {entry.cancelled ? '你放棄了整組問題' : `你回答了 ${entry.answers.length} 題`}
        </Marker>
      );
  }
}

function Marker({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-center">
      <span className="text-muted-foreground bg-chip rounded-full px-3 py-1 text-xs">
        {children}
      </span>
    </div>
  );
}

function AiView({ entry }: { entry: AiEntry }) {
  return (
    <Message align="start">
      <MessageContent>
        {entry.attribution.kind === 'subagent' && (
          <MessageHeader className="px-0">
            <Badge variant="outline" className="rounded-full">
              子代理 · {entry.attribution.name}
            </Badge>
          </MessageHeader>
        )}
        <Bubble variant={entry.error === undefined ? 'ghost' : 'destructive'}>
          <BubbleContent className="text-body whitespace-pre-wrap">
            {entry.text}
            {entry.streaming && <span className="proto-caret" aria-hidden />}
          </BubbleContent>
        </Bubble>
        {entry.stopped && <MessageFooter className="px-0">已停止</MessageFooter>}
      </MessageContent>
    </Message>
  );
}

const TOOL_STATUS: Record<ToolEntry['status'], string> = {
  running: '執行中',
  suspended: '等待核准',
  done: '完成',
  failed: '失敗',
};

function summarize(input: string): string {
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed !== null && typeof parsed === 'object') {
      const first = Object.values(parsed).find((value) => typeof value === 'string');
      if (typeof first === 'string') return first;
    }
  } catch {
    // 壞 JSON 原樣顯示
  }
  return input;
}

function ToolCard({ entry }: { entry: ToolEntry }) {
  const [open, setOpen] = useState(false);
  const icon =
    entry.status === 'running' ? (
      <AgentOrb state="working" size={20} label="執行中" />
    ) : entry.status === 'suspended' ? (
      <Hand className="size-4 text-(--brand)" />
    ) : entry.status === 'done' ? (
      <Check className="text-muted-foreground size-4" />
    ) : (
      <X className="text-destructive size-4" />
    );

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="bg-card rounded-3xl p-1 shadow-material"
      data-status={entry.status}
    >
      <CollapsibleTrigger className="group flex min-h-11 w-full min-w-0 items-center gap-2.5 rounded-[20px] px-3 py-2 text-left transition-colors duration-(--duration-quick) hover:bg-chip-hover active:bg-chip-pressed">
        <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
        <span className="text-ui shrink-0 font-mono">{entry.name}</span>
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
          {summarize(entry.input)}
        </span>
        {entry.attribution.kind === 'subagent' && (
          <Badge variant="outline" className="hidden rounded-full sm:inline-flex">
            {entry.attribution.name}
          </Badge>
        )}
        <Badge
          variant={entry.status === 'failed' ? 'destructive' : 'secondary'}
          className="shrink-0 rounded-full"
        >
          {TOOL_STATUS[entry.status]}
        </Badge>
        <ChevronDown
          data-motion-rotate
          className="text-muted-foreground size-4 shrink-0 transition-transform duration-(--duration-fast) ease-(--ease-smooth-out) group-data-[state=open]:rotate-180"
        />
      </CollapsibleTrigger>
      {/* 展開收合：tw-animate 的 collapsible 高度＋透明度，開 250、關 150 */}
      <CollapsibleContent className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden">
        <div className="bg-stage shadow-stage m-1 mt-0 flex flex-col gap-2 rounded-xl p-3 font-mono text-xs">
          <pre className="text-muted-foreground whitespace-pre-wrap">
            {JSON.stringify(JSON.parse(entry.input), null, 2)}
          </pre>
          {entry.output !== undefined && (
            <pre className="whitespace-pre-wrap">{String(entry.output)}</pre>
          )}
          {entry.error !== undefined && (
            <pre className="text-destructive whitespace-pre-wrap">{entry.error}</pre>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * 輸入框與待決面板換手。#376：輸入框**隱藏不卸載**（草稿要留著），所以這裡不是換元件，
 * 是把沒在用的那一邊 `hidden` 起來，`inert` 讓它退出 Tab 順序。
 * 動效沿用「換內容」：舊的淡出 150、新的長出 250（#378）。
 */
function ComposerZone({ scenario, settings }: { scenario: Scenario; settings: Settings }) {
  const pendings = scenario.state.pendings;
  const pending = pendings[0];
  const takeover = settings.approval === 'takeover' && pending !== undefined;
  const target = takeover ? pending.interruptId : 'composer';
  const [shown, setShown] = useState(target);
  const leaving = target !== shown;

  // 淡出中還要畫舊的那一張，所以留最後一次的 pending
  const lastPending = useRef(pending);
  if (pending !== undefined) lastPending.current = pending;
  const shownPending = pendings.find((item) => item.interruptId === shown) ?? lastPending.current;
  const showComposer = shown === 'composer';

  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setShown(target), 150);
    return () => clearTimeout(timer);
  }, [leaving, target]);

  const zone = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(false);

  /**
   * 焦點只在「本來就會丟掉」時才搬（#384 Q4）：焦點在這一區裡（輸入框被藏起來、上一張面板被拿掉）
   * 或已經掉到 body 才搬；人在別處看工具卡就不搶，改由狀態列報讀。
   */
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const active = document.activeElement;
    const lost =
      active === null || active === document.body || (zone.current?.contains(active) ?? false);
    if (!lost) return;
    if (showComposer) {
      composer.current?.focus();
      return;
    }
    const panel = zone.current?.querySelector<HTMLElement>('[data-slot="pending-panel"]');
    // 提問面板落在當前題目的 fieldset（跟 questionnaire 換題時一致），核准面板落在面板本身
    const item = panel?.querySelector<HTMLElement>(
      '[data-slot="questionnaire-item"]:not([hidden])',
    );
    (item ?? panel)?.focus();
  }, [shown, showComposer]);

  return (
    <div
      ref={zone}
      className="mx-auto w-full max-w-3xl shrink-0 px-3 pt-1 pb-[max(env(safe-area-inset-bottom),12px)]"
    >
      <AutoHeight>
        <div className="motion-swap" data-phase={leaving ? 'out' : 'in'}>
          <div hidden={!showComposer} inert={!showComposer}>
            <Composer scenario={scenario} settings={settings} ref={composer} />
          </div>
          {!showComposer && shownPending !== undefined && (
            <PendingView
              pending={shownPending}
              scenario={scenario}
              takeover
              position={{
                index: Math.max(
                  0,
                  pendings.findIndex((item) => item.interruptId === shownPending.interruptId),
                ),
                total: Math.max(1, pendings.length),
              }}
            />
          )}
        </div>
      </AutoHeight>
    </div>
  );
}

function Composer({
  scenario,
  settings,
  ref,
}: {
  scenario: Scenario;
  settings: Settings;
  ref?: RefObject<HTMLTextAreaElement | null>;
}) {
  const [draft, setDraft] = useState('');
  const { status, pendings } = scenario.state;
  const busy = status === 'running' || status === 'awaiting-input';
  const blocked = settings.approval === 'card' && pendings.length > 0;

  const submit = () => {
    if (busy || draft.trim() === '') return;
    scenario.send(draft.trim());
    setDraft('');
  };

  return (
    <Beam kind="run" active={status === 'running'} radius={24}>
      <InputGroup className="rounded-3xl">
        <InputGroupTextarea
          ref={ref}
          aria-label="要說的話"
          rows={1}
          className="text-body max-h-48 min-h-12 px-4"
          placeholder={blocked ? '先處理上面那張卡' : busy ? '這一輪還在跑…' : '要做什麼？'}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <InputGroupAddon align="block-end" className="px-2 pb-2">
          <InputGroupText className="pl-2 text-xs">Enter 送出</InputGroupText>
          {busy ? (
            <PButton
              size="icon-sm"
              variant="secondary"
              className="ml-auto size-11 rounded-full lg:size-9"
              aria-label="停止"
              onClick={() => {
                scenario.stop();
                toast('已停止這一輪');
              }}
            >
              <Square className="fill-current" />
            </PButton>
          ) : (
            <PButton
              size="icon-sm"
              className="ml-auto size-11 rounded-full lg:size-9"
              aria-label="送出"
              disabled={draft.trim() === ''}
              onClick={submit}
            >
              <ArrowUp />
            </PButton>
          )}
        </InputGroupAddon>
      </InputGroup>
    </Beam>
  );
}

/**
 * 面板的名稱就是報讀的內容（#384 Q11）：出現時由狀態列唸，焦點搬進來時唸這個名稱。
 * 跨面板進度「（1／2）」也放進名稱裡。
 */
function pendingLabel(pending: PendingInput, position?: { index: number; total: number }): string {
  const base =
    pending.kind === 'approval'
      ? `等待核准：${pending.actions.map((action) => action.name).join('、')}`
      : `有 ${pending.questions.length} 個問題要你回答`;
  return position !== undefined && position.total > 1
    ? `${base}（${position.index + 1}／${position.total}）`
    : base;
}

function PendingView({
  pending,
  scenario,
  takeover = false,
  position,
}: {
  pending: PendingInput;
  scenario: Scenario;
  takeover?: boolean;
  position?: { index: number; total: number };
}) {
  // 提問面板可以收起（#376），核准面板不行
  const [open, setOpen] = useState(true);
  const question = pending.kind === 'question' ? pending : undefined;
  const label = pendingLabel(pending, position);
  const stop = () => {
    scenario.stop();
    toast('已停止這一輪。工具卡裡有題目，可以直接打字回覆。');
  };

  const head = (
    <div className="text-muted-foreground flex items-center gap-2 px-3 pt-2 pb-2 text-xs">
      <span className="size-1.5 shrink-0 rounded-full bg-(--brand)" aria-hidden />
      <span className="min-w-0 truncate">{label}</span>
      {question !== undefined && (
        <>
          <CollapsibleTrigger
            className="ml-auto flex size-8 shrink-0 items-center justify-center rounded-full transition-colors duration-(--duration-quick) hover:bg-chip-hover active:bg-chip-pressed"
            aria-label={open ? '收起這些問題' : '展開這些問題'}
          >
            <ChevronDown
              data-motion-rotate
              className={`size-4 transition-transform duration-(--duration-fast) ease-(--ease-smooth-out) ${open ? 'rotate-180' : ''}`}
            />
          </CollapsibleTrigger>
          <Tooltip>
            <TooltipTrigger asChild>
              <PButton
                variant="ghost"
                size="icon-sm"
                className="size-8 shrink-0 rounded-full"
                aria-label="停止這一輪，不回答這些問題"
                onClick={stop}
              >
                <X />
              </PButton>
            </TooltipTrigger>
            <TooltipContent>停止這一輪，不回答這些問題</TooltipContent>
          </Tooltip>
        </>
      )}
    </div>
  );

  const body =
    question === undefined ? (
      <ApprovalBody
        pending={pending as PendingApproval}
        onDecide={scenario.decide}
        takeover={takeover}
      />
    ) : (
      <QuestionBody
        key={pending.interruptId}
        pending={question}
        onAnswer={scenario.answer}
        takeover={takeover}
      />
    );

  return (
    <Beam kind="pending" active radius={24}>
      <section
        data-slot="pending-panel"
        tabIndex={-1}
        className="bg-card shadow-material flex flex-col rounded-3xl p-1"
        aria-label={label}
        onKeyDown={(event) => {
          // Esc＝收起，不是停止（#384 Q9）
          if (event.key !== 'Escape' || question === undefined || !open) return;
          event.preventDefault();
          setOpen(false);
          event.currentTarget
            .querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')
            ?.focus();
        }}
      >
        {question === undefined ? (
          <>
            {head}
            {body}
          </>
        ) : (
          <Collapsible open={open} onOpenChange={setOpen}>
            {head}
            <CollapsibleContent className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden">
              {body}
            </CollapsibleContent>
          </Collapsible>
        )}
      </section>
    </Beam>
  );
}

function ApprovalBody({
  pending,
  onDecide,
  takeover,
}: {
  pending: PendingApproval;
  onDecide: (decision: string) => void;
  takeover: boolean;
}) {
  return (
    <>
      {/* 可捲動 → 要能用鍵盤捲，所以進 Tab 順序並給名稱（#384 Q5） */}
      <div
        role="group"
        tabIndex={0}
        aria-label="要執行的內容"
        className={`bg-stage shadow-stage flex flex-col gap-2 overflow-auto rounded-xl p-3 ${takeover ? 'max-h-[40svh]' : ''}`}
      >
        {pending.actions.map((action, index) => (
          <div key={`${action.name}-${index}`} className="flex flex-col gap-1.5">
            <p className="text-sm font-medium">
              要執行 <code className="font-mono">{action.name}</code>
            </p>
            <pre className="text-muted-foreground font-mono text-xs whitespace-pre-wrap">
              {JSON.stringify(action.args, null, 2)}
            </pre>
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-2 p-2">
        {/* 照 dsh ApprovalPanel：拒絕在左、允許在右 */}
        {[...pending.allowedDecisions].reverse().map((decision) => (
          <PButton
            key={decision}
            variant={decision === 'approve' ? 'default' : 'outline'}
            className="h-11 rounded-full px-5 lg:h-9"
            onClick={() => onDecide(decision)}
          >
            {decision === 'approve' ? '全部核准' : '全部拒絕'}
          </PButton>
        ))}
      </div>
    </>
  );
}

function QuestionBody({
  pending,
  onAnswer,
  takeover,
}: {
  pending: PendingQuestion;
  onAnswer: (answers: readonly Answer[] | 'cancel') => void;
  takeover: boolean;
}) {
  const names = pending.questions.map((question) => question.id);
  const [item, setItem] = useState(names[0] ?? '');
  const [dir, setDir] = useState<'next' | 'prev'>();
  const advance = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(advance.current), []);

  // 上下題：方向決定從哪邊進來（#378 Q8）
  const go = (to: string) => {
    clearTimeout(advance.current);
    setDir(names.indexOf(to) > names.indexOf(item) ? 'next' : 'prev');
    setItem(to);
  };
  // 只有滑鼠／觸控（含 VoiceOver 點兩下）選的才自動跳；鍵盤改選取不跳，要按 Enter（#384 Q10）
  const pointerPicked = useRef(false);
  // 單選自動跳：先停 200 讓勾選看得到，再走下一題的過場
  const autoAdvance = (from: string) => {
    const next = names[names.indexOf(from) + 1];
    if (next === undefined) return;
    clearTimeout(advance.current);
    advance.current = setTimeout(() => go(next), 200);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const answers: Answer[] = pending.questions.map((question) => {
      const values = data
        .getAll(question.id)
        .map(String)
        .filter((value) => value !== '');
      return question.options === undefined
        ? { id: question.id, selected: [], ...(values[0] ? { custom: values[0] } : {}) }
        : { id: question.id, selected: values };
    });
    toast('FormData 轉回的答案', { description: JSON.stringify(answers) });
    onAnswer(answers);
  };

  return (
    <div
      className={`bg-stage shadow-stage overflow-auto rounded-xl p-4 ${takeover ? 'max-h-[55svh]' : ''}`}
    >
      <AutoHeight>
        <Questionnaire
          item={item}
          onItemChange={go}
          data-page-dir={dir}
          onSubmit={submit}
          shortcuts="numbers"
        >
          {/* 進度自己寫中文；aria-live 關掉，改由題目的 legend 一次唸（#384 Q11） */}
          <QuestionnaireProgress
            aria-live="off"
            aria-valuetext={`第 ${Math.max(0, names.indexOf(item)) + 1} 題，共 ${names.length} 題`}
          >
            {`第 ${Math.max(0, names.indexOf(item)) + 1} 題，共 ${names.length} 題`}
          </QuestionnaireProgress>
          {pending.questions.map((question) => (
            <QuestionnaireItem
              key={question.id}
              name={question.id}
              multiple={question.multiSelect === true}
            >
              <QuestionnaireTitle>
                {/* 焦點落到 fieldset 時一次唸「第 n 題，共 m 題：題目」（#384 Q11） */}
                <span className="sr-only">{`第 ${names.indexOf(question.id) + 1} 題，共 ${names.length} 題：`}</span>
                {question.question}
              </QuestionnaireTitle>
              <QuestionnaireDescription>
                {question.header !== undefined && <span>{question.header}</span>}
                {question.options !== undefined && question.multiSelect !== true && (
                  // WCAG 3.2.2「事先告知」：自動跳題之前要先講（#384 Q10）
                  <span className="sr-only">
                    選了會跳到下一題，可以按上一題回來改。也可以按數字鍵選。
                  </span>
                )}
              </QuestionnaireDescription>
              {question.options === undefined ? (
                <QuestionnaireInput type="number" placeholder="例如 500" />
              ) : (
                <QuestionnaireChoices>
                  {question.options.map((option) => (
                    <QuestionnaireChoice
                      key={option.label}
                      value={option.label}
                      onPointerDown={() => {
                        pointerPicked.current = true;
                      }}
                      onKeyDown={() => {
                        pointerPicked.current = false;
                      }}
                      onChange={() => {
                        if (question.multiSelect === true || !pointerPicked.current) return;
                        pointerPicked.current = false;
                        autoAdvance(question.id);
                      }}
                    >
                      {option.label}
                      {option.description !== undefined && (
                        <QuestionnaireChoiceDescription>
                          {option.description}
                        </QuestionnaireChoiceDescription>
                      )}
                    </QuestionnaireChoice>
                  ))}
                </QuestionnaireChoices>
              )}
              {/* registry 有這顆但原型之前沒渲染：被擋下來時只有 aria-invalid、沒有訊息（#384 Q14） */}
              <QuestionnaireError>還沒回答這一題，選一個或按跳過。</QuestionnaireError>
            </QuestionnaireItem>
          ))}
          <QuestionnaireActions>
            <QuestionnairePrevious>上一題</QuestionnairePrevious>
            <QuestionnaireSkip>跳過</QuestionnaireSkip>
            <QuestionnaireNext>下一題</QuestionnaireNext>
            <QuestionnaireSubmit>送出答案</QuestionnaireSubmit>
          </QuestionnaireActions>
        </Questionnaire>
      </AutoHeight>
    </div>
  );
}

/** 切換列：刻意做得不像設計的一部分（琥珀色、粗框）。 */
function Switcher({
  settings,
  update,
  scenario,
  onOpenDialog,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  scenario: Scenario;
  onOpenDialog: () => void;
}) {
  const [open, setOpen] = useState(false);
  const width = useViewportWidth();
  const { state } = scenario;

  return (
    <div className="fixed top-[60px] right-2 z-[100] flex flex-col items-end font-sans">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="rounded-full bg-amber-300 px-3 py-1.5 text-xs font-semibold whitespace-nowrap text-black shadow-lg ring-2 ring-black"
      >
        原型 #375 · {width}px · {width < 1024 ? '抽屜' : '側欄'} {open ? '▴' : '▾'}
      </button>
      {open && (
        <div className="mt-2 flex max-h-[80svh] w-[min(94vw,440px)] flex-col gap-3 overflow-auto rounded-2xl bg-zinc-950 p-3 text-xs text-zinc-100 shadow-2xl ring-2 ring-amber-300">
          {(Object.keys(OPTIONS) as (keyof Settings)[]).map((key) => (
            <div key={key} className="flex flex-col gap-1">
              <span className="text-zinc-400">
                {
                  {
                    approval: '核准與提問',
                    motion: '動效（#378）',
                    theme: '主題',
                    button: 'button.tsx',
                  }[key]
                }
              </span>
              <div className="flex gap-1">
                {OPTIONS[key].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => update({ [key]: value })}
                    className={`flex-1 rounded-lg px-2 py-2 ${settings[key] === value ? 'bg-amber-300 font-semibold text-black' : 'bg-zinc-800 hover:bg-zinc-700'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className="flex flex-col gap-1">
            <span className="text-zinc-400">劇本</span>
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                onClick={scenario.replay}
                className="rounded-lg bg-amber-300 px-3 py-2 font-semibold text-black"
              >
                ▶ 重播一輪
              </button>
              {JUMPS.map((jump) => (
                <button
                  key={jump}
                  type="button"
                  onClick={() => scenario.jump(jump)}
                  className="rounded-lg bg-zinc-800 px-3 py-2 hover:bg-zinc-700"
                >
                  {jump}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-zinc-400">動效手動觸發（#378）</span>
            <div className="flex flex-wrap gap-1">
              {(
                [
                  ['換入核准面板', () => scenario.jump('核准')],
                  ['換入提問面板', () => scenario.jump('提問')],
                  ['換回輸入框', () => scenario.jump('執行中')],
                  ['兩個待決', () => scenario.jump('兩個待決')],
                  ['處理掉第一個（接續）', scenario.dismissFirst],
                  ['開對話框', onOpenDialog],
                ] as const
              ).map(([label, action]) => (
                <button
                  key={label}
                  type="button"
                  onClick={action}
                  className="rounded-lg bg-zinc-800 px-3 py-2 hover:bg-zinc-700"
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="text-[11px] leading-4 text-zinc-400">
              上下題、單選自動跳在提問面板裡直接點；工具卡點標題展開；手機寬度點左上角開側欄。
            </span>
          </div>
          <ButtonSwatch />
          <pre className="rounded-lg bg-zinc-900 p-2 text-[11px] leading-4 text-zinc-300">
            {JSON.stringify(
              {
                ...settings,
                status: state.status,
                pendings: state.pendings.map((pending) => pending.kind),
                entries: state.entries.map((entry) =>
                  entry.kind === 'tool' ? `tool:${entry.name}:${entry.status}` : entry.kind,
                ),
              },
              null,
              1,
            )}
          </pre>
        </div>
      )}
    </div>
  );
}

/** 新舊 button 並排：少了 `shadow-xs` 這種差異，來回切是看不出來的。 */
function ButtonSwatch() {
  const settings = useContext(SettingsContext);
  const row = (flavor: Settings['button']) => (
    <SettingsContext.Provider value={{ ...settings, button: flavor }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-10 text-[11px] text-zinc-400">{flavor === 'new' ? '新版' : '舊版'}</span>
        <PButton size="sm">default</PButton>
        <PButton size="sm" variant="secondary">
          secondary
        </PButton>
        <PButton size="sm" variant="outline">
          outline
        </PButton>
        <PButton size="sm" variant="destructive">
          destructive
        </PButton>
      </div>
    </SettingsContext.Provider>
  );
  return (
    <div className="flex flex-col gap-1">
      <span className="text-zinc-400">button 新舊並排（用頁面的 token）</span>
      <div className="bg-background text-foreground flex flex-col gap-2 rounded-lg p-3">
        {row('new')}
        {row('old')}
      </div>
    </div>
  );
}

/** 對話框模式（#378 Q8）：開 250、關 150、scale .96，遮罩淡入 200。 */
function FeedbackDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={(event) => {
          // 受控開啟沒有 radix Trigger，radix 就不知道要還給誰（#384 Q13）
          event.preventDefault();
          document.querySelector<HTMLElement>('button.bg-amber-300')?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>這則回覆哪裡不好？</DialogTitle>
          <DialogDescription>原型：只看對話框的進出場，送出不會做任何事。</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <PButton
            variant="outline"
            className="h-11 rounded-full lg:h-9"
            onClick={() => onOpenChange(false)}
          >
            取消
          </PButton>
          <PButton className="h-11 rounded-full lg:h-9" onClick={() => onOpenChange(false)}>
            送出
          </PButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
