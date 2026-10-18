/**
 * 瀏覽器護欄的測試頁（#1512）：把關鍵元件原樣畫出來，`guard.test.ts` 用真的 Chrome 量它們在**出貨 CSS** 下的計算值。
 *
 * - 本頁**不寫任何 class**，版面只用 inline style：寫了 class 也不在出貨的 CSS 裡，量到的會是「沒有樣式」（`src/guard-page.test.ts` 擋）。
 * - 要量的元素掛 `data-guard-*`：
 *   - `data-guard-text`：量它的字色對它實際的底色（往上疊到不透明為止）；門檻預設 4.5，`data-guard-min` 另給。
 *   - `data-guard-texts`：同上，但量的是它底下每個 `[aria-hidden]` 的字（元件自己的 span 掛不了屬性）。
 *   - `data-guard-focus`：鍵盤聚焦後量焦點的樣子；外框畫在別的元素上時，那個元素掛 `data-guard-outline-host`。
 *   - `data-guard-field`：文字欄位，鍵盤聚焦後量邊框的顏色（邊框畫在群組上時同樣看 `data-guard-outline-host`）。
 *   - `data-guard-docked`：貼在輸入框上方的卡片（`Surface tone="docked"`），量它是不是平的（1px 邊、沒有投影）。
 *   - `data-guard-shadow`：亮色時量 `box-shadow` 每層投影的透明度。
 *   - `data-guard-surface`：不透明的退路（reduced-transparency、`data-glass="opaque"`）下，量這個面是不是真的不透明、沒有 blur。
 *   - `data-guard-chip`：裡面那顆按鈕平常、滑鼠移上去、清單開著三種狀態各量一次字色對底色（chip 三階，#1512；#1591 起量底列的 Pick）。
 *   - `data-guard-press`：平常、滑鼠移上去、按著（`:active`）三種狀態各量一次字色對底色：次要字疊在 `chip-hover`、`chip-pressed`
 *     上的真消費者。
 *   - `data-guard-located`：對話裡被定位的那一則（`[data-slot=message-scroller-item][data-located]`），量圓角真的畫出來。
 *   - `data-guard-glass`：SG 畫成玻璃的按鈕（outline、secondary、glass），量它真的有 `backdrop-filter`：`solid-glass.css:642-679`
 *     靠 vendor Button 輸出的 `data-variant` 命中（#1523）。
 *   - `data-guard-expanded`：浮層 Trigger（`render` 接 Base UI 的 Button）開著時（`trigger`）跟沒開的（`reference`）比底色：
 *     Trigger 開著時掛 `data-popup-open` 與 `aria-expanded="true"`，SG 用後者把它畫成按下去的樣子（#1523 混合期起量，#1583 換成 Base UI）。
 *   - `data-guard-hover`：平常與滑鼠移上去兩種狀態各量一次字對底色（destructive 按鈕，頁面上與卡片裡各一顆；hover 底是覆寫檔調淡的，#1523）。
 *   - `data-guard-opacity`：InputGroup 的 `opacity` 與底色（`reference` 一般的、`send-disabled` 只有按鈕停用、`control-disabled` 欄位停用），
 *     vendor 的 `has-disabled:opacity-50` 被按鈕停用觸發的那一半由覆寫檔擋掉（#1523 本地修改第 18 條）。
 *   - `data-guard-choice`：問答的選項（已勾選、沒勾選、停用），量平常與滑鼠移上去的底色、停用的樣子：shadcn 的 `data-*` custom variant
 *     （`vendor/solid-glass/shadcn/tailwind.css`，#1523）specificity 是 0，不能改掉這幾個 variant 原本的行為。
 *   - `data-guard-backdrop`：dialog／sheet 的遮罩，量 `backdrop-filter`（不透明的退路要拿掉 blur，#1583 本地修改第 22 條）。
 *   - `data-guard-border`：手機側欄的抽屜，量四邊的 border 寬（只留陰影、不畫邊，#1583 本地修改第 21 條）。
 *   - `data-guard-width`：呼叫端的寬度（回饋框、手機側欄的抽屜），量畫出來的寬度跟 develop 一樣（#1583 PM 決定第 4 點）。
 *   - `data-guard-motion`：sheet 與手機側欄的抽屜，在模擬 reduced-motion 下量 `translate` 與 `transition-duration`（#1583 本地修改第 23 條）。
 *   - `data-guard-height`：下拉選單的選項，量畫出來的高度（觸控高度：1024 以下 44px、以上 32px，#1583 本地修改第 25 條）。
 *   - `data-guard-shown`：側欄列的「⋯」，量 `opacity`（選單開著時要看得見：Trigger 開著掛 `data-popup-open`，#1583）。
 *   - `data-guard-checks`：command 勾選的那一列，量它看得見的勾有幾顆、報讀名稱是什麼（vendor 附的勾由覆寫檔藏掉，#1583 本地修改第 27 條）。
 *   vendor 元件自己畫的部分（關閉鈕、遮罩）掛不了屬性，由 `guard.test.ts` 開頁後補上，見 `OVERLAY_MARKS`。
 * - 亮暗由網址的 `?theme=dark` 決定，在第一次繪製前套好（同 `index.html`）。
 * - `?glass=opaque` 在 `<html>` 掛 `data-glass="opaque"`（#1468 Q7：效能不達標時退回的那條路），量不透明的面。
 * - `?overlay=<名字>` 換成只畫一個開著的 modal 浮層（#1583）：modal 會把頁面其他部分設成 inert，跟主頁的焦點量測放不到一起。
 *   `dialog`、`sheet`、`mobile-sidebar`（要用手機寬度開）、`feedback`（回饋框，量寬度）、`alert-dialog`、`dropdown`（側欄列的「⋯」選單）、
 *   `command`（開著的 command 清單，有搜尋框；#1591 之前是底列的選擇座位）、`dropdown-keyboard`（關著的選單，量鍵盤 Enter 打開與選取，#1583 驗收 D）。
 * - `?overlay=composer-<狀態>` 畫產品的輸入框（SG 的 `Composer`，#1591 驗收 D）：`idle`（閒著）、`draft`（有草稿）、`running`（跑著）、
 *   `running-draft`（跑著有草稿）、`menu`（`/` 選單開著）；底列的 `danger`、`locked`、`pick-open`、`tones`、`dormant` 見
 *   `ComposerPage`。輸入框貼在頁面底部，寬度跟產品一樣（左右各 16px、最寬 48rem）。
 * - `?overlay=collapsibles` 畫產品裡展開收合的元件（#1638 PR A），都關著：思考過程、摘要列、工具卡、待辦、提問面板。量展開途中的高度、
 *   reduced-motion 直接到位、箭頭轉向、思考過程展開後藏摘要（這幾件都靠真的 CSS 命中 Base UI 的屬性，jsdom 量不到）。
 * - `?overlay=messages` 畫產品的對話區（`Transcript`，#1638 PR B）：人與 AI 輪流十二則、最後一則 AI 被停止（帶表尾），高度固定、
 *   內容超出，量泡泡字與表尾的對比、捲到最新的按鈕（焦點、動效、reduced-motion）、每一則的 `content-visibility`、外殼的行高、底部淡出。
 * - `?overlay=questionnaire` 畫產品的提問面板（#1638 PR C），量選項的焦點外框（offset、不帶 ring）與字的對比。
 * - `?overlay=attachments` 畫輸入框底下的草稿附件兩排（放得下、放不下）與已送出的附件（#1638 PR C），量按鈕聚焦時外殼不出 ring、
 *   字的對比（上傳中的標題是 shimmer，另量漸層每個色標）、左右淡出跟著橫向捲動。
 */
import { emptyConversation } from '@nexus/wire';
import type {
  ConversationEntry,
  WireAttachmentRef,
  CompactionEntry,
  PendingQuestion,
  ToolEntry,
  WireContextPressure,
  WireTodoItem,
} from '@nexus/wire';
import { Check, MoreHorizontal } from 'lucide-react';
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { Counts } from '@/components/changes/counts';
import { CompactionRow } from '@/components/compaction-row';
import { SessionUsage } from '@/components/cost/session-usage';
import { Composer } from '@/components/composer';
import { ContextMeter } from '@/components/context-meter';
import { PendingSwap } from '@/components/pending-swap';
import { QuestionPanel } from '@/components/question-panel';
import { ReasoningRow } from '@/components/reasoning-row';
import { RetryNotice } from '@/components/retry-notice';
import { Surface } from '@/components/surface';
import { TodoPanel } from '@/components/todo/panel';
import { Transcript } from '@/components/transcript';
import { ToolCard } from '@/components/tool/card';
import { AttachmentRail } from '@/components/attachment-rail';
import { SentAttachments } from '@/components/sent-attachments';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ComposerPick } from '@/components/ui/composer';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea,
} from '@/components/ui/input-group';
import { FeedbackDialog } from '@/components/feedback-dialog';
import { ModelSeat } from '@/components/model-seat';
import { PermissionSeat } from '@/components/permission-seat';
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Questionnaire,
  QuestionnaireChoice,
  QuestionnaireChoices,
  QuestionnaireItem,
  QuestionnaireTitle,
} from '@/components/ui/questionnaire';
import { Textarea } from '@/components/ui/textarea';
import {
  Sidebar,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

const params = new URLSearchParams(window.location.search);
const dark = params.get('theme') === 'dark';
document.documentElement.classList.toggle('dark', dark);
document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
if (params.get('glass') === 'opaque') document.documentElement.setAttribute('data-glass', 'opaque');

const BUTTON_VARIANTS = [
  'default',
  'destructive',
  'outline',
  'secondary',
  'ghost',
  'link',
  'glass',
] as const;
/** SG 畫成玻璃的按鈕（`solid-glass.css:642-679` 靠 `data-variant` 命中；`glass` 走 `glass-control`）。 */
const GLASS_VARIANTS: readonly string[] = ['outline', 'secondary', 'glass'];
const BADGE_VARIANTS = ['default', 'secondary', 'destructive', 'outline', 'ghost', 'link'] as const;

const row = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 } as const;

/** 用量環的門檻 10 個 token：`approxTokens` 就是十分之一的百分比（5 是 50%、藍；7 是 70%、琥珀；9 是 90%、destructive）。 */
const METER = {
  approxTokens: 0,
  messageCount: 1,
  thresholds: [{ type: 'tokens', value: 10 }],
} as const;
const meter = (approxTokens: number): WireContextPressure => ({
  measure: { ...METER, approxTokens },
});
/** 型錄裡最長的那種模型名稱：量 375 寬放不放得下。 */
const LONG_MODEL = 'nvidia/nemotron-3-super-120b-a12b';
const PERMISSIONS = {
  options: [
    { value: 'read-only', name: '唯讀', description: '只能讀，改東西要問' },
    { value: 'workspace-write', name: '可寫工作區', description: '可以改工作區裡的檔案' },
    { value: 'danger-full-access', name: '全開' },
  ],
  defaultOptions: [{ value: 'workspace-write', name: '可寫工作區' }],
  defaultPreset: 'workspace-write',
};
const MODELS = {
  default: { modelId: LONG_MODEL },
  models: [
    {
      id: LONG_MODEL,
      name: LONG_MODEL,
      description: '預設的模型',
      reasoning: {
        efforts: [
          { id: 'low', name: '低' },
          { id: 'high', name: '高', description: '想得比較久' },
        ],
        defaultEffort: 'low',
      },
    },
    { id: 'small', name: 'small' },
  ],
};
const RETRY = {
  retryId: 'guard',
  retry: 1,
  maxRetries: 2,
  delayMs: 3000,
  code: 'TIMEOUT',
} as const;

function GuardPage() {
  return (
    <TooltipProvider>
      <main style={{ display: 'flex', flexDirection: 'column', gap: 24, padding: 24 }}>
        <p data-guard-text="body">頁面上的字</p>

        <div style={row}>
          {BUTTON_VARIANTS.map((variant) => (
            <Button
              key={variant}
              variant={variant}
              data-guard-text={`button-${variant}`}
              data-guard-focus={`button-${variant}`}
              data-guard-shadow={`button-${variant}`}
              data-guard-glass={GLASS_VARIANTS.includes(variant) ? variant : undefined}
              data-guard-hover={variant === 'destructive' ? 'button-destructive' : undefined}
            >
              按鈕 {variant}
            </Button>
          ))}
        </div>

        <div style={row}>
          {BADGE_VARIANTS.map((variant) => (
            <Badge key={variant} variant={variant} data-guard-text={`badge-${variant}`}>
              標籤 {variant}
            </Badge>
          ))}
        </div>

        <div style={{ width: 360 }}>
          <Card data-guard-shadow="card" data-guard-surface="card">
            <CardHeader>
              <CardTitle data-guard-text="card-title">卡片標題</CardTitle>
              <CardDescription data-guard-text="card-description">卡片說明</CardDescription>
            </CardHeader>
            <CardContent>
              <div data-guard-texts="card-counts">
                <Counts added={12} deleted={3} />
              </div>
              <Button variant="destructive" data-guard-hover="button-destructive-card">
                卡片裡的刪除
              </Button>
            </CardContent>
          </Card>
        </div>

        <div style={{ width: 360 }}>
          <InputGroup
            data-guard-outline-host="input-group"
            data-guard-shadow="input-group"
            data-guard-opacity="reference"
          >
            <InputGroupInput
              data-guard-focus="input-group"
              data-guard-field="input-group"
              aria-label="輸入框"
              placeholder="輸入"
            />
          </InputGroup>
        </div>

        {/* 群組只在欄位本身停用時變淡（#1523 本地修改第 18 條）：送出鈕停用的（輸入框沒字時就是這樣）要跟上面那個一樣
            不透明、提示字照常過 4.5；欄位停用的照 vendor 變淡（量具分得出來）。 */}
        <div style={{ width: 360, display: 'grid', gap: 12 }}>
          <InputGroup data-guard-opacity="send-disabled">
            <InputGroupTextarea aria-label="送出鈕停用的輸入框" placeholder="輸入" />
            <InputGroupAddon align="block-end">
              <InputGroupText data-guard-text="input-group-send-hint">Enter 送出</InputGroupText>
              <Button size="sm" disabled>
                送出
              </Button>
            </InputGroupAddon>
          </InputGroup>
          <InputGroup data-guard-opacity="control-disabled">
            <InputGroupInput aria-label="停用的欄位" placeholder="停用" disabled />
          </InputGroup>
        </div>

        <div style={{ ...row, width: 720 }}>
          <Input data-guard-field="input" aria-label="單行欄位" placeholder="單行" />
          <Textarea data-guard-field="textarea" aria-label="多行欄位" placeholder="多行" />
        </div>

        {/* 輸入框底列的 Pick（#1591 驗收 D）：平常、滑鼠移上去、按下去，12px 的次要字都過 4.5；權限「全開」換成警示色，
            三種狀態都留著（本地修改第 35 條）。底列在輸入框外面、直接疊在頁面的底上，所以放在頁面上量。重試那一行是平的
            chip 底加次要文字（#1512）。用量環（#1591 起沒有字）在 composer 頁量。 */}
        <div style={row}>
          <div data-guard-chip="pick">
            <ComposerPick
              label="模型"
              value="model"
              options={[{ value: 'model', label: LONG_MODEL }]}
              onValueChange={() => {}}
            />
          </div>
          <div data-guard-chip="pick-danger">
            <PermissionSeat
              seat={{ catalog: PERMISSIONS, currentValue: 'danger-full-access' }}
              locked={undefined}
              onSwitch={() => {}}
            />
          </div>
          {/* 頂列的用量鈕：`text-muted-foreground` 配 `hover:bg-chip-hover active:bg-chip-pressed`，底下沒有 `bg-card`，
              chip 的兩階真的畫得出來。 */}
          <div data-guard-press="session-usage">
            <SessionUsage
              tokenUsage={{ inputTokens: 412_380, outputTokens: 9_815 }}
              sessionStats={{ turns: 4, steps: 17, llmMs: 133_000, toolMs: 38_400 }}
            />
          </div>
          <div data-guard-texts="retry-notice" style={{ width: 360 }}>
            <RetryNotice retry={RETRY} />
          </div>
        </div>

        <div style={{ width: 360 }}>
          <Surface tone="docked" data-guard-docked="docked" data-guard-text="docked">
            貼在輸入框上方的卡片
          </Surface>
        </div>

        {/* 問答的選項（#1523）：勾選的底、勾選框、停用的樣子都跟 develop 一樣（shadcn 的 data-* custom variant 不能改掉它們）。 */}
        <div style={{ width: 360 }}>
          <Questionnaire item="guard-choice">
            <QuestionnaireItem name="guard-choice" multiple>
              <QuestionnaireTitle>選項</QuestionnaireTitle>
              <QuestionnaireChoices>
                <QuestionnaireChoice value="checked" defaultChecked data-guard-choice="checked">
                  已勾選
                </QuestionnaireChoice>
                <QuestionnaireChoice value="unchecked" data-guard-choice="unchecked">
                  沒勾選
                </QuestionnaireChoice>
                <QuestionnaireChoice value="disabled" disabled data-guard-choice="disabled">
                  停用
                </QuestionnaireChoice>
              </QuestionnaireChoices>
            </QuestionnaireItem>
          </Questionnaire>
        </div>

        <div
          data-slot="message-scroller-item"
          data-located=""
          data-guard-located="located"
          style={{ width: 360, padding: 12 }}
        >
          在對話裡被定位的那一則
        </div>

        {/* 側欄裡可以聚焦的四種都量（#1680 PR B 換成 vendor 版之後）：選單鈕、「⋯」、開關鈕量焦點外框，搜尋框量欄位邊框。 */}
        <div style={{ height: 220 }}>
          <SidebarProvider style={{ minHeight: 0, height: '100%' }}>
            <Sidebar collapsible="none" data-guard-text="sidebar" data-guard-surface="sidebar">
              側欄
              <SidebarTrigger data-guard-focus="sidebar-trigger" />
              <SidebarInput
                data-guard-field="sidebar-input"
                aria-label="側欄搜尋"
                placeholder="搜尋"
              />
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    data-guard-text="sidebar-menu-button"
                    data-guard-focus="sidebar-menu-button"
                  >
                    側欄選單
                  </SidebarMenuButton>
                  <SidebarMenuAction aria-label="選項" data-guard-focus="sidebar-menu-action">
                    ⋯
                  </SidebarMenuAction>
                </SidebarMenuItem>
              </SidebarMenu>
            </Sidebar>
          </SidebarProvider>
        </div>

        {/* 浮層的 Trigger 用 `render` 畫成 Base UI 的 Button（#1583 起 popover 也是 Base UI）。開著時 Trigger 掛 `data-popup-open`
            與 `aria-expanded="true"`，SG 的 `:667` 用它們把 outline 按鈕畫成按下去的玻璃。 */}
        <div style={{ ...row, gap: 240, paddingBottom: 120 }}>
          <Button variant="outline" data-guard-expanded="reference">
            沒開的按鈕
          </Button>
          <Popover open>
            <PopoverTrigger render={<Button variant="outline" data-guard-expanded="trigger" />}>
              開著的按鈕
            </PopoverTrigger>
            <PopoverContent side="right">按鈕開的浮層</PopoverContent>
          </Popover>
        </div>

        <div style={{ ...row, gap: 240, paddingBottom: 200 }}>
          <Popover open>
            <PopoverTrigger>開啟浮層</PopoverTrigger>
            <PopoverContent
              side="bottom"
              data-guard-text="popover"
              data-guard-shadow="popover"
              data-guard-surface="popover"
            >
              浮層內容
            </PopoverContent>
          </Popover>
          <Tooltip open>
            <TooltipTrigger>提示</TooltipTrigger>
            <TooltipContent side="bottom" data-guard-text="tooltip" data-guard-surface="tooltip">
              提示內容
            </TooltipContent>
          </Tooltip>
        </div>
      </main>
    </TooltipProvider>
  );
}

/** 手機側欄一開頁就打開（`openMobile` 是 SidebarProvider 裡的 state，沒有 prop 可以給）。 */
function OpenMobileSidebar() {
  const { isMobile, setOpenMobile } = useSidebar();
  useEffect(() => {
    if (isMobile) setOpenMobile(true);
  }, [isMobile, setOpenMobile]);
  return null;
}

const REASONING = '先讀需求。\n\n使用者要一張表，列出三個方案的成本與風險，再給建議。';
const COMPACTION: CompactionEntry = {
  kind: 'compaction',
  id: 'compaction:1',
  seq: 1,
  cutoff: 4,
  saved: true,
  summary: '前面談的是三個方案的成本估算與交付時程。',
};
const TOOL: ToolEntry = {
  kind: 'tool',
  id: 'tool-1',
  callId: 'call-1',
  name: 'read_file',
  input: '{"file_path":"docs/plan.md"}',
  text: '# 計畫\n\n三個方案的成本與風險。',
  status: 'done',
  attribution: { kind: 'root' },
};
const TODOS: readonly WireTodoItem[] = [
  { content: '讀需求', status: 'completed' },
  { content: '估算成本', status: 'in_progress' },
  { content: '寫建議', status: 'pending' },
];
const QUESTION: PendingQuestion = {
  kind: 'question',
  interruptId: 'q-1',
  namespace: [],
  questions: [
    { id: 'day', question: '哪一天？', options: [{ label: '週一' }, { label: '週二' }] },
    { id: 'name', question: '訪客姓名？' },
  ],
};

/** 展開收合的元件（#1638 PR A）：思考過程、摘要列、工具卡（Root 用 `render` 接 `Surface`）、待辦、提問面板（內容保持掛載）。都是關著畫出來的。 */
function CollapsiblesPage() {
  const composerRef = useRef<HTMLTextAreaElement>(null);
  return (
    <div
      style={{
        maxWidth: '48rem',
        margin: '0 auto',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      <ReasoningRow text={REASONING} running={false} />
      <CompactionRow entry={COMPACTION} />
      <ToolCard entry={TOOL} beam={false} />
      <TodoPanel todos={TODOS} status="idle" />
      <PendingSwap
        pendings={[QUESTION]}
        composerRef={composerRef}
        composer={<textarea ref={composerRef} aria-label="要說的話" />}
        renderPanel={(pending) =>
          pending.kind === 'question' && (
            <QuestionPanel pending={pending} busy={false} onAnswer={() => {}} />
          )
        }
      />
    </div>
  );
}

/** 對話區（#1638 PR B）：人與 AI 輪流，AI 的回覆夠長、總高度超出容器，捲到最新的按鈕才有機會出現；最後一則 AI 被停止，畫表尾。 */
const MESSAGES: ConversationEntry[] = Array.from({ length: 6 }, (_, i): ConversationEntry[] => [
  { kind: 'human', id: `h-${i}`, text: `第 ${i + 1} 個問題：這份報表的數字要怎麼看？` },
  {
    kind: 'ai',
    id: `a-${i}`,
    text: `第 ${i + 1} 則回覆。先看總表的合計列，再對照各月份的明細；如果兩邊對不上，通常是某一個月的資料還沒結帳。\n\n確認方式是打開那個月份的明細，看最後更新時間是不是在結帳日之後。`,
    streaming: false,
    attribution: { kind: 'root' },
    ...(i === 5 ? { stopped: true as const } : {}),
  },
]).flat();

function MessagesPage() {
  return (
    <div style={{ height: 600, display: 'flex', flexDirection: 'column' }}>
      <Transcript state={{ ...emptyConversation(), entries: MESSAGES }} isFresh={() => false} />
    </div>
  );
}

/**
 * 附件（#1638 PR C）：輸入框底下的草稿列兩排，與已送出的附件一排。
 * - `fits`：一張檔案卡、寬度放得下，不會溢出（量左右淡出不出現）。
 * - `overflows`：五張、寬度放不下（量頭尾的淡出），涵蓋圖的縮圖、可移除的檔案、上傳中（有進度與不確定長度兩種，標題 shimmer）、上傳失敗。
 * - `sent`：已送出的檔案卡（沒有按鈕）。
 * 元件內部的按鈕掛不了屬性，由 `guard.test.ts` 開頁後補標記。
 */
const PIXEL =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#8aa"/></svg>',
  );
const draft = (id: string, name: string, kind: 'image' | 'file' = 'file') => ({
  id,
  file: new File(['x'.repeat(12_345)], name, {
    type: kind === 'image' ? 'image/svg+xml' : 'application/octet-stream',
  }),
  kind,
  ...(kind === 'image' ? { previewUrl: PIXEL } : {}),
});
const RAIL_ITEMS = [
  draft('image', '螢幕截圖.svg', 'image'),
  draft('file', '季報.pdf'),
  draft('uploading', '上傳中.csv'),
  draft('indeterminate', '不知道大小.txt'),
  draft('failed', '失敗了.zip'),
];
const RAIL_UPLOADS = new Map([
  ['uploading', { kind: 'uploading' as const, loaded: 4_000, total: 12_345 }],
  ['indeterminate', { kind: 'uploading' as const, loaded: 4_000 }],
  ['failed', { kind: 'idle' as const, reason: 'failed' as const }],
]);
const SENT: WireAttachmentRef[] = [
  { type: 'file', attachmentId: 'sent-1', name: '已送出.pdf', bytes: 12_345 },
];

/** 問答（#1638 PR C）：產品的提問面板直接畫出來（不經換手層），第一題是複選、帶說明，量選項的焦點外框、字的對比。 */
const QUESTIONNAIRE: PendingQuestion = {
  kind: 'question',
  interruptId: 'q-guard',
  namespace: [],
  questions: [
    {
      id: 'days',
      question: '哪幾天可以來？',
      multiSelect: true,
      options: [
        { label: '週一', description: '上午九點以後' },
        { label: '週二' },
        { label: '週三' },
      ],
    },
    { id: 'name', question: '訪客姓名？' },
  ],
};

function QuestionnairePage() {
  return (
    <div style={{ maxWidth: '48rem', margin: '0 auto', padding: 16 }}>
      <QuestionPanel pending={QUESTIONNAIRE} busy={false} onAnswer={() => {}} />
    </div>
  );
}

function AttachmentsPage() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, padding: 16 }}>
      <div data-guard-rail="fits" style={{ width: 600 }}>
        <AttachmentRail items={[draft('alone', '只有一張.pdf')]} onRemove={() => {}} />
      </div>
      <div data-guard-rail="overflows" style={{ width: 360 }}>
        <AttachmentRail
          items={RAIL_ITEMS}
          uploads={RAIL_UPLOADS}
          onRemove={() => {}}
          onCancelUpload={() => {}}
        />
      </div>
      <div data-guard-rail="sent" style={{ width: 600 }}>
        <SentAttachments attachments={SENT} />
      </div>
    </div>
  );
}

function OverlayPage({ name }: { name: string }) {
  switch (name) {
    case 'dialog':
      return (
        <Dialog open>
          <DialogContent data-guard-shadow="dialog" data-guard-surface="dialog">
            <DialogHeader>
              <DialogTitle data-guard-text="dialog-title">對話框標題</DialogTitle>
              <DialogDescription data-guard-text="dialog-description">對話框說明</DialogDescription>
            </DialogHeader>
            <DialogFooter showCloseButton />
          </DialogContent>
        </Dialog>
      );
    case 'sheet':
      return (
        <Sheet open>
          <SheetContent
            side="right"
            data-guard-shadow="sheet"
            data-guard-surface="sheet"
            data-guard-motion="sheet"
          >
            <SheetHeader>
              <SheetTitle data-guard-text="sheet-title">抽屜標題</SheetTitle>
              <SheetDescription data-guard-text="sheet-description">抽屜說明</SheetDescription>
            </SheetHeader>
          </SheetContent>
        </Sheet>
      );
    case 'mobile-sidebar':
      return (
        <SidebarProvider>
          <OpenMobileSidebar />
          {/* 手機側欄把 props 交給 Sheet 的 Root（沒有 DOM），屬性掛不上抽屜：由 `guard.test.ts` 的 `OVERLAY_MARKS` 補。 */}
          <Sidebar>手機側欄</Sidebar>
        </SidebarProvider>
      );
    case 'feedback':
      return <FeedbackDialog open submitting={false} onSubmit={() => {}} onDismiss={() => {}} />;
    case 'alert-dialog':
      return (
        <AlertDialog open>
          <AlertDialogContent data-guard-shadow="alert-dialog" data-guard-surface="alert-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle data-guard-text="alert-dialog-title">確認框標題</AlertDialogTitle>
              <AlertDialogDescription data-guard-text="alert-dialog-description">
                確認框說明
              </AlertDialogDescription>
            </AlertDialogHeader>
            {/* footer 是 `bg-muted/50` 的底帶，兩顆按鈕的字疊在它上面量。 */}
            <AlertDialogFooter>
              <AlertDialogCancel
                data-guard-text="alert-dialog-cancel"
                data-guard-focus="alert-dialog-cancel"
              >
                取消
              </AlertDialogCancel>
              <AlertDialogAction
                data-guard-text="alert-dialog-action"
                data-guard-focus="alert-dialog-action"
              >
                確定
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      );
    case 'dropdown':
      // 跟產品一樣：側欄一列的「⋯」（`thread-row-menu.tsx`）。另一列的「⋯」沒開，量具自檢 lg 寬度下它是藏著的。
      return (
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton>開著選單的那一列</SidebarMenuButton>
                <DropdownMenu open>
                  <DropdownMenuTrigger
                    render={
                      <SidebarMenuAction showOnHover aria-label="選項" data-guard-shown="open" />
                    }
                  >
                    <MoreHorizontal aria-hidden />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    data-guard-shadow="dropdown"
                    data-guard-surface="dropdown"
                  >
                    <DropdownMenuItem
                      data-guard-text="dropdown-item"
                      data-guard-height="dropdown-item"
                    >
                      釘選
                    </DropdownMenuItem>
                    <DropdownMenuItem data-guard-text="dropdown-item-highlighted">
                      重新命名
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem>封存</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton>沒開選單的那一列</SidebarMenuButton>
                <SidebarMenuAction showOnHover aria-label="選項" data-guard-shown="closed">
                  <MoreHorizontal aria-hidden />
                </SidebarMenuAction>
              </SidebarMenuItem>
            </SidebarMenu>
          </Sidebar>
        </SidebarProvider>
      );
    case 'dropdown-keyboard':
      return <KeyboardMenu />;
    case 'command':
      return <OpenCommand />;
    case 'desktop-sidebar':
      // 桌面側欄（offcanvas，產品 `app-sidebar.tsx` 的形狀）：量收合的 transition（#1680 PR B）。
      return (
        <SidebarProvider>
          <Sidebar>桌面側欄</Sidebar>
          <SidebarInset>會話區</SidebarInset>
        </SidebarProvider>
      );
    case 'collapsibles':
      return <CollapsiblesPage />;
    case 'messages':
      return <MessagesPage />;
    case 'attachments':
      return <AttachmentsPage />;
    case 'questionnaire':
      return <QuestionnairePage />;
    case 'composer-idle':
    case 'composer-draft':
    case 'composer-running':
    case 'composer-running-draft':
    case 'composer-menu':
    case 'composer-danger':
    case 'composer-locked':
    case 'composer-pick-open':
    case 'composer-tones':
    case 'composer-dormant':
      return <ComposerPage state={name.slice('composer-'.length)} />;
    default:
      throw new Error(`沒有這個浮層：${name}`);
  }
}

/** 關著的選單：鍵盤 Enter 打開、選項上按 Enter 觸發 `onClick`，選了什麼寫在頁面上給 `guard.test.ts` 讀（#1583 驗收 D）。 */
function KeyboardMenu() {
  const [picked, setPicked] = useState('');
  return (
    <div style={{ padding: 40 }}>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" />}>開選單</DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => setPicked('釘選')}>釘選</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setPicked('重新命名')}>重新命名</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <output data-guard-picked={picked}>{picked}</output>
    </div>
  );
}

/**
 * 開著的 command 清單，有搜尋框；勾選的是第三列，跟 cmdk 預設選中的第一列分開。底列的選擇座位 #1591 換成 SG 的 Pick 之後，
 * command 還在用的是輸入框的 `@` 選單（`composer.tsx`，勾選那一列帶「目前選的」）與審查的找檔案（`changes/review.tsx`，
 * 有搜尋框）：這一頁照它們的形狀畫，量本地修改第 27 條（vendor 附的勾藏掉）與第 15 條的擴充（搜尋框的外框畫在群組上）。
 */
function OpenCommand() {
  const items = ['一', '二', '三', '四', '五', '六', '七'].map((label, i) => ({
    id: `item-${i}`,
    label: `選項${label}`,
    checked: i === 2,
  }));
  return (
    <div style={{ padding: '40px' }}>
      <Popover open>
        <PopoverTrigger render={<Button variant="outline" />}>選選項</PopoverTrigger>
        <PopoverContent side="bottom" align="start" aria-label="選選項">
          <Command>
            <CommandInput placeholder="找" />
            <CommandList>
              <CommandGroup>
                {items.map((item) => (
                  <CommandItem key={item.id} value={item.id} data-checked={item.checked}>
                    {item.label}
                    {item.checked && <Check aria-label="目前選的" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * 產品的輸入框（#1591 驗收 D）：貼在頁面底部，左右各 16px、最寬 48rem（同產品）。底列是產品的元件：左邊權限、右邊模型、
 * 推理強度與用量環；模型名稱用型錄裡最長的那種，量 375 寬放不放得下。底列的狀態：
 * - `danger`：權限是「全開」（警示色，本地修改第 35 條）。
 * - `locked`：權限鎖住（一輪在跑；`aria-disabled`，第 39 條）。
 * - `pick-open`：模型的清單開著（量選項的字與觸控高度）。
 * - `tones`：三個用量環，50%、70%、90%（量三個色階，第 37 條）。
 * - `dormant`：用量環有一道不會觸發的門檻（`guard.test.ts` 點開它量明細的字）。
 */
function ComposerPage({ state }: { state: string }) {
  const running = state.startsWith('running');
  const [draft, setDraft] = useState(
    state === 'draft' || state === 'running-draft'
      ? '幫我整理這週的會議紀錄'
      : state === 'menu'
        ? '/'
        : '',
  );
  const [modelOpen, setModelOpen] = useState(state === 'pick-open');
  const [selection, setSelection] = useState<{ modelId: string; reasoningEffort?: string }>({
    modelId: LONG_MODEL,
  });
  const pressure: WireContextPressure =
    state === 'dormant'
      ? {
          measure: {
            approxTokens: 5,
            messageCount: 12,
            messagesCompactable: false,
            thresholds: [
              { type: 'tokens', value: 10 },
              { type: 'messages', value: 60 },
            ],
          },
        }
      : meter(5);
  return (
    <div
      style={{
        minHeight: '100svh',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        padding: '0 16px 24px',
      }}
    >
      <div style={{ width: '100%', maxWidth: '48rem' }}>
        <Composer
          draft={draft}
          onDraftChange={setDraft}
          placeholder="說點什麼…"
          canSend={draft.trim() !== ''}
          onSubmit={() => {}}
          commands={[
            { name: 'plan', description: '進出計劃模式。' },
            { name: 'todo', description: '列出待辦。' },
          ]}
          onRunCommand={() => true}
          stoppable={running}
          stopDisabled={false}
          onStop={() => {}}
          attachments={{ items: [], onAdd: () => {}, onRemove: () => {} }}
          footerStart={
            <PermissionSeat
              seat={{
                catalog: PERMISSIONS,
                currentValue: state === 'danger' ? 'danger-full-access' : 'workspace-write',
              }}
              locked={state === 'locked' ? '這一輪結束後才能切換。' : undefined}
              onSwitch={() => {}}
            />
          }
          footerEnd={
            <>
              <ModelSeat
                seat={{
                  catalog: MODELS,
                  selection,
                  select: async (next) => {
                    setSelection(next);
                    return undefined;
                  },
                }}
                open={modelOpen}
                onOpenChange={setModelOpen}
              />
              {state === 'tones' ? (
                [5, 7, 9].map((tokens) => <ContextMeter key={tokens} pressure={meter(tokens)} />)
              ) : (
                <ContextMeter pressure={pressure} />
              )}
            </>
          }
        />
      </div>
    </div>
  );
}

const overlay = params.get('overlay');
const root = document.getElementById('root');
if (root === null) throw new Error('找不到 #root');
createRoot(root).render(
  <StrictMode>{overlay === null ? <GuardPage /> : <OverlayPage name={overlay} />}</StrictMode>,
);
