/**
 * PROTOTYPE #375 — 設計語言原型。丟棄分支 `prototype/375-design-language`，不合進 develop。
 *
 * 一條路由、三個獨立開關（`?approval=card|takeover&motion=pkg|css&theme=dark|light`）
 * 外加 `?button=new|old`，都在右上角的琥珀色切換列上。假資料，不連 harness。
 *
 * 跟 prototype 技能預設不同的兩處，是 demian 在這張卡的 Q2 拍板的：
 * - 不是「N 個結構完全不同的版本」，是卡片定義的三個切換軸（2×2×2）。
 * - 切換列放**右上角、header 底下**：底部是輸入框與核准面板，放底部會蓋住要看的東西。
 *
 * 元件來源照「每個 P0 元件各從哪裡拿」的結論：shadcn 當外殼與基礎件，不用 AI Elements
 * 的程式碼；markdown 那張卡決定自建，原型只顯示純文字。
 */

import {
  ArrowUp,
  Check,
  ChevronDown,
  Hand,
  Moon,
  Plus,
  RotateCcw,
  Square,
  Sun,
  X,
} from 'lucide-react';
import { useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react';
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

import {
  AgentOrb,
  Beam,
  OPTIONS,
  PButton,
  SettingsContext,
  Swap,
  useSettings,
  useViewportWidth,
  type Settings,
} from './kit';
import { JUMPS, useScenario, type Answer, type ProtoState } from './scenario';

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

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-proto-375', '');
    root.classList.toggle('dark', settings.theme === 'dark');
  }, [settings.theme]);

  return (
    <SettingsContext.Provider value={settings}>
      <SidebarProvider className="h-svh">
        <ThreadSidebar onJump={scenario.jump} />
        <SidebarInset className="bg-background flex h-svh min-w-0 flex-col">
          <Header state={scenario.state} settings={settings} update={update} />
          {scenario.state.entries.length === 0 ? (
            <Hero onStart={scenario.replay} />
          ) : (
            <Transcript scenario={scenario} settings={settings} />
          )}
          <ComposerZone scenario={scenario} settings={settings} />
        </SidebarInset>
      </SidebarProvider>
      <Switcher settings={settings} update={update} scenario={scenario} />
      <Toaster theme={settings.theme} position="top-center" />
    </SettingsContext.Provider>
  );
}

function ThreadSidebar({ onJump }: { onJump: Scenario['jump'] }) {
  return (
    <Sidebar>
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
      <PButton
        variant="ghost"
        size="icon"
        className="size-11 rounded-full lg:size-9"
        aria-label={settings.theme === 'dark' ? '換成亮色' : '換成暗色'}
        onClick={() => update({ theme: settings.theme === 'dark' ? 'light' : 'dark' })}
      >
        {settings.theme === 'dark' ? <Sun /> : <Moon />}
      </PButton>
    </header>
  );
}

function StatusLine({ state }: { state: ProtoState }) {
  const { motion } = useContext(SettingsContext);
  const approvals = state.pendings.flatMap((pending) =>
    pending.kind === 'approval' ? pending.actions.map((action) => action.name) : [],
  );
  const questions = state.pendings.filter((pending) => pending.kind === 'question').length;

  let label: ReactNode;
  let orb: ReactNode = null;
  if (state.status === 'running') {
    label = <span className={motion === 'css' ? 'proto-shimmer' : undefined}>執行中…</span>;
    orb = <AgentOrb state="working" size={20} label="執行中" />;
  } else if (state.status === 'awaiting-input') {
    label = [
      approvals.length > 0 ? `等待核准：${approvals.join('、')}` : undefined,
      questions > 0 ? `等你回答 ${questions} 組問題` : undefined,
    ]
      .filter(Boolean)
      .join('；');
    orb = <span className="size-2 rounded-full bg-(--brand)" />;
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
    <div className="proto-enter flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
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

function Transcript({ scenario, settings }: { scenario: Scenario; settings: Settings }) {
  const { entries, pendings } = scenario.state;
  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-4 px-4 pt-6 pb-10">
            {entries.map((entry) => (
              <MessageScrollerItem key={entry.id} messageId={entry.id} className="proto-enter">
                <EntryView entry={entry} />
              </MessageScrollerItem>
            ))}
            {settings.approval === 'card' &&
              pendings.map((pending) => (
                <MessageScrollerItem
                  key={pending.interruptId}
                  messageId={pending.interruptId}
                  // registry 的 item 帶 content-visibility:auto＝paint containment，會把卡片的光暈切成直角方塊
                  className="proto-enter [contain:none] [content-visibility:visible]"
                >
                  <PendingView pending={pending} scenario={scenario} />
                </MessageScrollerItem>
              ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton className="rounded-full" />
      </MessageScroller>
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
              <BubbleContent className="rounded-3xl px-4 py-2.5 text-[15px] leading-6">
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
      <span className="text-muted-foreground rounded-full bg-(--chip) px-3 py-1 text-xs">
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
          <BubbleContent className="text-[15px] leading-7 whitespace-pre-wrap">
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
      <AgentOrb state={entry.name === 'grep' ? 'searching' : 'working'} size={20} label="執行中" />
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
      className="bg-card rounded-2xl p-1 shadow-(--material-shadow)"
      data-status={entry.status}
    >
      <CollapsibleTrigger className="group flex min-h-11 w-full min-w-0 items-center gap-2.5 rounded-xl px-3 py-2 text-left transition-colors duration-(--duration-quick) hover:bg-(--chip)">
        <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
        <span className="shrink-0 font-mono text-[13px]">{entry.name}</span>
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
        <ChevronDown className="text-muted-foreground size-4 shrink-0 transition-transform duration-(--duration-fast) ease-(--ease-smooth-out) group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="proto-collapsible overflow-hidden">
        <div className="m-1 mt-0 flex flex-col gap-2 rounded-xl border bg-(--stage) p-3 font-mono text-xs">
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

function ComposerZone({ scenario, settings }: { scenario: Scenario; settings: Settings }) {
  const pending = scenario.state.pendings[0];
  const takeover = settings.approval === 'takeover' && pending !== undefined;
  return (
    <div className="mx-auto w-full max-w-3xl shrink-0 px-3 pt-1 pb-[max(env(safe-area-inset-bottom),12px)]">
      <Swap swapKey={takeover ? pending.interruptId : 'composer'}>
        {takeover ? (
          <PendingView pending={pending} scenario={scenario} takeover />
        ) : (
          <Composer scenario={scenario} settings={settings} />
        )}
      </Swap>
    </div>
  );
}

function Composer({ scenario, settings }: { scenario: Scenario; settings: Settings }) {
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
      <InputGroup className="bg-card dark:bg-card rounded-3xl border-transparent shadow-(--material-shadow)">
        <InputGroupTextarea
          aria-label="要說的話"
          rows={1}
          className="max-h-48 min-h-12 px-4 text-[15px]"
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

function PendingView({
  pending,
  scenario,
  takeover = false,
}: {
  pending: PendingInput;
  scenario: Scenario;
  takeover?: boolean;
}) {
  return (
    <Beam kind="pending" active radius={24}>
      <section
        className="bg-card flex flex-col rounded-3xl p-1 shadow-(--material-shadow)"
        aria-label={pending.kind === 'approval' ? '核准請求' : '問答請求'}
      >
        <div className="text-muted-foreground flex items-center gap-2 px-3 pt-2 pb-2 text-xs">
          <span className="size-1.5 rounded-full bg-(--brand)" />
          {pending.kind === 'approval'
            ? '等待核准'
            : `要繼續得先問你 ${pending.questions.length} 件事`}
          {takeover && <span className="ml-auto">輸入框暫時換成這張</span>}
        </div>
        {pending.kind === 'approval' ? (
          <ApprovalBody pending={pending} onDecide={scenario.decide} takeover={takeover} />
        ) : (
          <QuestionBody pending={pending} onAnswer={scenario.answer} takeover={takeover} />
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
      <div
        className={`flex flex-col gap-2 overflow-auto rounded-[20px] border bg-(--stage) p-3 ${takeover ? 'max-h-[40svh]' : ''}`}
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
      className={`overflow-auto rounded-[20px] border bg-(--stage) p-4 ${takeover ? 'max-h-[55svh]' : ''}`}
    >
      <Questionnaire onSubmit={submit}>
        <div className="flex items-center justify-between gap-2">
          <QuestionnaireProgress />
          {/* 放棄整組：questionnaire 沒有這顆，#374 決定自補；Actions 的三欄已滿，放在進度旁 */}
          <PButton
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground h-11 rounded-full lg:h-8"
            onClick={() => onAnswer('cancel')}
          >
            <RotateCcw />
            放棄整組
          </PButton>
        </div>
        {pending.questions.map((question) => (
          <QuestionnaireItem
            key={question.id}
            name={question.id}
            multiple={question.multiSelect === true}
          >
            <QuestionnaireTitle>{question.question}</QuestionnaireTitle>
            {question.header !== undefined && (
              <QuestionnaireDescription>{question.header}</QuestionnaireDescription>
            )}
            {question.options === undefined ? (
              <QuestionnaireInput type="number" placeholder="例如 500" />
            ) : (
              <QuestionnaireChoices>
                {question.options.map((option) => (
                  <QuestionnaireChoice key={option.label} value={option.label}>
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
          </QuestionnaireItem>
        ))}
        <QuestionnaireActions>
          <QuestionnairePrevious>上一題</QuestionnairePrevious>
          <QuestionnaireSkip>跳過</QuestionnaireSkip>
          <QuestionnaireNext>下一題</QuestionnaireNext>
          <QuestionnaireSubmit>送出答案</QuestionnaireSubmit>
        </QuestionnaireActions>
      </Questionnaire>
    </div>
  );
}

/** 切換列：刻意做得不像設計的一部分（琥珀色、粗框）。 */
function Switcher({
  settings,
  update,
  scenario,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  scenario: Scenario;
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
                  { approval: '核准與提問', motion: '動效', theme: '主題', button: 'button.tsx' }[
                    key
                  ]
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
