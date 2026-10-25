/**
 * 瀏覽器護欄的測試頁（#1512）：把關鍵元件原樣畫出來，`guard.test.ts` 用真的 Chrome 量它們在**出貨 CSS** 下的計算值。
 *
 * - 本頁**不寫任何 class**，版面只用 inline style：寫了 class 也不在出貨的 CSS 裡，量到的會是「沒有樣式」（`src/guard-page.test.ts` 擋）。
 * - 要量的元素掛 `data-guard-*`：
 *   - `data-guard-text`：量它的字色對它實際的底色（往上疊到不透明為止）；門檻預設 4.5，`data-guard-min` 另給。
 *   - `data-guard-texts`：同上，但量的是它底下每個 `[aria-hidden]` 的字（元件自己的 span 掛不了屬性）；`DiffStats` 的包裝層不量，改量它
 *     裡面的 `+`／`−` 兩個 span（#1685：`aria-hidden` 在包裝層上，字色在裡面那兩個 span）。
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
 * - `?overlay=collapsibles` 畫產品裡展開收合的元件（#1638 PR A），都關著：思考過程、摘要列、工具卡、待辦、提問面板。量摘要列展開途中的
 *   高度、reduced-motion 直接到位、箭頭跟著 `data-panel-open` 轉（靠真的 CSS 命中 Base UI 的屬性，jsdom 量不到）；思考過程（#1683 起是
 *   SG 的原生 `<details>`）量箭頭跟著 `details[open]` 轉、展開後藏摘要。
 * - `?overlay=messages` 畫產品的對話區（`Transcript`，#1638 PR B）：人與 AI 輪流十二則、最後一則 AI 被停止（帶表尾），高度固定、
 *   內容超出，量泡泡字與表尾的對比、捲到最新的按鈕（焦點、動效、reduced-motion）、每一則的 `content-visibility`、外殼的行高、底部淡出。
 * - `?overlay=questionnaire` 畫產品的提問面板（#1638 PR C），量選項的焦點外框（offset、不帶 ring）與字的對比。
 * - `?overlay=tool-steps` 畫 SG 的 tool-steps（nexus 的包裝層，#1682 PR A）：一段展開的群組（執行中、完成、失敗各一列，完成與失敗的列展開）
 *   與一列單獨放在頁面上、展開的列。量執行中不閃、結果框聚焦的外框、1024 以下 44px、減少動態時箭頭不轉場、疊在清單裡的結果框不 blur
 *   （README 本地修改第 61–65 條）。兩塊各包一層 `data-guard-tool`（`group`、`standalone`）給 `guard.test.ts` 找。
 * - `?overlay=tool-cards` 畫產品的工具卡與工具段（#1682 PR B）：一段打開的工具段（兩張完成的卡，第一張展開）、單獨的卡（執行中、
 *   等你回答、完成展開、失敗展開、停止的提問、子代理歸屬、背景子代理、撞到輸出上限）。量三種底上的字（頁面、清單的 `--panel`、結果框）、
 *   Badge、背景子代理的狀態字、錯誤框與撞到上限那段說明的紅字，列、群組、結果框的焦點；`data-guard-cards` 包整頁。
 * - `?overlay=reasoning` 畫產品的推理列（SG 的 `Reasoning`，#1683）：講完的一列（內文有粗體、清單、行內 code、連結）、還在想的一列
 *   （摘要很長，量 375 寬往左裁）、夾在一段打開的工具段裡的一列（`StepList` 的 `--panel` 上）。量字的對比（頁面與 `--panel` 兩種底、
 *   「思考中」的漸層與減少動態時停住的那一格）、焦點、AX 樹、箭頭、44px、shimmer、`white-space`；三塊各包一層 `data-guard-reasoning`
 *   （`done`、`running`、`panel`）。
 * - `?overlay=turn-status` 畫產品的狀態列（`StatusLine`，#1684）：就緒、執行中、等你回答三種各一列，寬度與左右留白同 `App.tsx`
 *   （最寬 42rem、左右 24px）。執行中那一列是 SG 的 `TurnStatus`，帶經過時間（server 時鐘樣本在載入時補一次、這一輪 75 秒前開始）；
 *   三塊各包一層 `data-guard-status`（`idle`、`running`、`awaiting`）。`&only=running` 只畫執行中那一列（量 AX 樹、live region）。
 *   執行中那一列的 activity 由 `window.__setTurnActivity('thinking' | 'searching' | 'running' | 'writing')` 換；
 *   `window.__openingPose(activity)` 給那種 activity 的起始姿勢（`[[cx, cy, r, opacity], …]`）。
 * - `?overlay=diff-stats` 畫增刪行數（SG 的 `DiffStats`＋nexus 包裝層，#1685 PR A）：頁面上一顆、工具段裡寫檔那張卡、改動卡（讀假的
 *   fetch，路徑故意很長）；測試再點開審查頁與選檔器。量 `+`／`−` 在四種底上的對比、算出來的顏色是 `--success`／`--destructive`（第 75 條）、
 *   375 寬不被擠（第 76 條）；三塊各包一層 `data-guard-diffstats`（`page`、`panel`、`changes`）。
 * - `?overlay=transcript-rows` 畫對話流裡用到 SG `DotLoader`／`Empty` 的三種列（#1695 PR A）：輪尾的重試提示、往前翻的待命／讀取中／
 *   失敗三格（各包一層 `data-guard-pager`，寬度同 `App.tsx` 的對話欄，最寬 42rem），一格按得動的往前翻（`live`：按下去讀取
 *   300ms 再回到待命），以及空白畫面。量字的對比、焦點、點的大小與顏色、減少動態時停住，待命、讀取中與 `live` 一樣高。
 * - `?overlay=transcript-refs` 畫產品的 `Transcript`（#1695 PR B）：一則人話帶兩個會話引用（`@部署腳本除錯` 能點、`@月報` 不能點）、
 *   一則壓縮標記與一則決定紀錄（置中的 chip），前面墊幾輪對話讓它捲得動（捲到底的鈕）；底下一條斷線中的狀態列（「立刻重連」）
 *   與封存橫幅。
 *   量引用的底線、引用與 chip 的字、引用與「立刻重連」的焦點外框，以及兩顆鈕與 chip 的圓角。
 *   壓縮標記與封存橫幅不量，放著給 X2、X5 的前後截圖對照（#1695〈驗收〉）。
 * - `?overlay=handoff` 畫核准與換手這一組（#1694）：換手層裡的核准卡（有允許／不允許的、只剩「停止這一輪」的）、可收起的提問面板（收起鈕）、送出佇列、輸入框上方的委派
 *   chip 與對話裡的委派標記，以及展開的背景子代理卡兩張（跑著、閒著；各包一層 `data-guard-handoff`）。量子代理面板的字、焦點
 *   外框與幾顆鈕的圓角；核准卡的呼吸光一圈還是兩圈只記錄、不斷言，交給截圖（#1694〈要看稿確認〉）。
 * - `?overlay=plan` 畫計劃與目標這一組（#1692）：輸入框上方的計劃模式標籤三塊（能按、跑著停用、按過一次失敗；各包一層
 *   `data-guard-plan`）、計劃審核面板（有右側欄，帶「查看全文」）、帶結果 chip 的計劃卡，以及目標列（帶暫停鈕）。量 SG Badge 不在 Tab
 *   順序裡、「退出」鈕的名稱與停用、字與焦點外框、圓角（G2），375 寬時幾顆鈕 44px 高。
 * - `?overlay=attachments` 畫輸入框底下的草稿附件兩排（放得下、放不下）與已送出的附件（#1638 PR C），量按鈕聚焦時外殼不出 ring、
 *   字的對比（上傳中的標題是 shimmer，另量漸層每個色標）、左右淡出跟著橫向捲動。
 */
import { APPROVAL_PENDING_KIND, emptyConversation } from '@nexus/wire';
import type {
  ConversationEntry,
  PendingApproval,
  WireQueuedInput,
  WireAttachmentRef,
  CompactionEntry,
  PendingQuestion,
  PlanModePayload,
  WireGoal,
  ToolEntry,
  WireContextPressure,
  WireTodoItem,
} from '@nexus/wire';
import { Check, MoreHorizontal } from 'lucide-react';
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { AgentMentionChip } from '@/components/agent-mention-chip';
import { ApprovalCard } from '@/components/approval-card';
import { ArchivedBanner } from '@/components/archived-banner';
import { CompactionRow } from '@/components/compaction-row';
import { EarlierPager } from '@/components/earlier-pager';
import type { EarlierHistory } from '@/components/earlier-pager';
import { DelegatedChip } from '@/components/delegated-chip';
import { EmptyHero } from '@/components/empty-hero';
import { SessionUsage } from '@/components/cost/session-usage';
import { Composer } from '@/components/composer';
import { ContextMeter } from '@/components/context-meter';
import { PendingSwap } from '@/components/pending-swap';
import { PlanChip } from '@/components/plan/chip';
import { PlanReviewPanel, PlanToolCard } from '@/components/plan/review';
import { GoalBar } from '@/components/goal-bar';
import { QuestionPanel } from '@/components/question-panel';
import { QueueDock } from '@/components/queue-dock';
import { ReasoningRow } from '@/components/reasoning-row';
import { SessionReferenceContext } from '@/components/session-reference';
import { StatusLine } from '@/components/status-line';
import { RetryNotice } from '@/components/retry-notice';
import { Surface } from '@/components/surface';
import { TodoPanel } from '@/components/todo/panel';
import { Transcript } from '@/components/transcript';
import { ToolCard } from '@/components/tool/card';
import { SubagentControlContext } from '@/components/tool/subagent-control';
import type { SubagentControl } from '@/components/tool/subagent-control';
import { ToolRun } from '@/components/tool-run';
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import { createChangesStores } from '@/lib/changes-diff';
import { ABORTED_BEFORE_DISPATCH_CODE } from '@/lib/question-view';
import { planDocument, planReviewOf } from '@/lib/plan-review';
import { serverClock } from '@/lib/server-clock';
import { Script } from '@/test/conversation-frames';
import { turn, view, withTrajectory } from '@/test/trajectory-fixtures';
import { AttachmentRail } from '@/components/attachment-rail';
import { SentAttachments } from '@/components/sent-attachments';
import { ChangesCard } from '@/components/changes/card';
import { RightSidebarPanel, RightSidebarProvider } from '@/components/sidebar/right-sidebar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ComposerPick } from '@/components/ui/composer';
import { DiffStats } from '@/components/ui/diff-view';
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
import { STATUS_FIGURES } from '@/components/ui/status-glyph';
import { StepGroup, StepRow } from '@/components/ui/tool-steps';
import type { Step } from '@/components/ui/tool-steps';

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
                <DiffStats added={12} removed={3} />
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

const HANDOFF_APPROVAL: PendingApproval = {
  kind: APPROVAL_PENDING_KIND,
  interruptId: 'a-1',
  namespace: [],
  actions: [{ name: 'edit_file', args: { path: 'docs/deploy.md' } }],
  allowedDecisions: ['approve', 'reject'],
};
/** 允許的決定交集為空：卡上只剩「停止這一輪」（#376 第 12 條）。 */
const HANDOFF_STUCK: PendingApproval = {
  ...HANDOFF_APPROVAL,
  interruptId: 'a-2',
  allowedDecisions: [],
};
const HANDOFF_QUEUE: readonly WireQueuedInput[] = [
  { id: 'q-a', text: '順便把回滾那段也整理一下', source: { kind: 'user' } },
  { id: 'q-b', text: '整理完列出改了哪幾段', source: { kind: 'user' } },
];
const HANDOFF_AGENT = { id: 'researcher', name: 'researcher', description: '查資料' };
/** 子代理自己的對話：派出的任務與一則回覆；`renderEntry` 只畫字。 */
const HANDOFF_HISTORY: readonly ConversationEntry[] = [
  { kind: 'human', id: 'h-task', text: '找出 README 裡講部署的段落。' },
  {
    kind: 'ai',
    id: 'a-found',
    text: '找到兩段：「部署」與「回滾」。',
    streaming: false,
    attribution: { kind: 'root' },
  },
];

function handoffSubagents(state: 'running' | 'idle'): SubagentControl {
  return {
    connected: true,
    renderEntry: (entry) => ('text' in entry ? <p>{entry.text}</p> : null),
    history: async () => ({ ok: true, conversation: { entries: HANDOFF_HISTORY, hasMore: false } }),
    stateOf: () => state,
    echoesOf: () => ['先看部署那段'],
    send: async () => ({ ok: true }),
    interrupt: async () => undefined,
  };
}

function HandoffSubagent({ state }: { readonly state: 'running' | 'idle' }) {
  return (
    <div data-guard-handoff={`subagent-${state}`}>
      <SubagentControlContext.Provider value={handoffSubagents(state)}>
        <ToolCard
          entry={CARD({
            id: `bg-${state}`,
            name: 'task',
            input: '{"description":"找部署段落","subagent_type":"researcher"}',
            text: '已在背景開始',
            meta: { kind: 'background-subagent', runId: `bg-${state}`, subagentType: 'researcher' },
          })}
          defaultOpen
        />
      </SubagentControlContext.Provider>
    </div>
  );
}

function HandoffPage() {
  const approvalRef = useRef<HTMLTextAreaElement>(null);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const stuckRef = useRef<HTMLTextAreaElement>(null);
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
      <div data-guard-handoff="approval">
        <PendingSwap
          pendings={[HANDOFF_APPROVAL]}
          composerRef={approvalRef}
          composer={<textarea ref={approvalRef} aria-label="要說的話" />}
          renderPanel={(pending) =>
            pending.kind === APPROVAL_PENDING_KIND && (
              <ApprovalCard pending={pending} busy={false} onDecide={() => {}} onStop={() => {}} />
            )
          }
        />
      </div>
      <div data-guard-handoff="approval-stuck">
        <PendingSwap
          pendings={[HANDOFF_STUCK]}
          composerRef={stuckRef}
          composer={<textarea ref={stuckRef} aria-label="要說的話" />}
          renderPanel={(pending) =>
            pending.kind === APPROVAL_PENDING_KIND && (
              <ApprovalCard pending={pending} busy={false} onDecide={() => {}} onStop={() => {}} />
            )
          }
        />
      </div>
      <div data-guard-handoff="question">
        <PendingSwap
          pendings={[QUESTION]}
          composerRef={questionRef}
          composer={<textarea ref={questionRef} aria-label="要說的話" />}
          renderPanel={(pending) =>
            pending.kind === 'question' && (
              <QuestionPanel pending={pending} busy={false} onAnswer={() => {}} />
            )
          }
        />
      </div>
      <div data-guard-handoff="queue">
        <QueueDock
          items={HANDOFF_QUEUE}
          status="running"
          connected
          onUpdate={async () => undefined}
          onFocusFallback={() => {}}
        />
      </div>
      <div data-guard-handoff="chips" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <AgentMentionChip agent={HANDOFF_AGENT} onRemove={() => {}} />
        <DelegatedChip name="researcher" />
      </div>
      <HandoffSubagent state="running" />
      <HandoffSubagent state="idle" />
    </div>
  );
}

const PLAN_TEXT = '# 改登入頁\n\n先把**文案**改成中文。\n\n## 步驟\n\n- 改文案\n- 補測試';
const PLAN_PENDING = {
  kind: 'question',
  interruptId: 'int-plan',
  namespace: ['tools:a'],
  questions: [
    {
      id: 'plan-review',
      question: '同意這份計劃並離開計劃模式？',
      detail: PLAN_TEXT,
      options: [{ label: '同意' }, { label: '繼續規劃' }],
      intent: { kind: 'plan-review', approve: '同意', callId: 'call-plan' },
    },
  ],
} as unknown as PendingQuestion;
const PLAN_REVIEW = planReviewOf(PLAN_PENDING.questions)!;
const PLAN_ENTRY: ToolEntry = {
  kind: 'tool',
  id: 'tool-call-plan-done',
  callId: 'call-plan-done',
  name: 'exit_plan_mode',
  input: JSON.stringify({ plan: PLAN_TEXT }),
  status: 'done',
  attribution: { kind: 'root' },
};
const PLAN_ON: PlanModePayload = { active: true };
const PLAN_GOAL: WireGoal = {
  id: 'g1',
  revision: 1,
  objective: '把登入改好',
  phase: 'active',
  maxGoalRounds: 10,
  roundsStarted: 3,
  createdAt: 0,
  updatedAt: 0,
};

function PlanPage() {
  return (
    <RightSidebarProvider
      threadId="guard-plan"
      sources={{ plans: new Map([['call-plan', planDocument(PLAN_TEXT)]]) }}
    >
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
        <div data-guard-plan="chip">
          <PlanChip planMode={PLAN_ON} status="idle" connected onExit={async () => undefined} />
        </div>
        <div data-guard-plan="chip-running">
          <PlanChip planMode={PLAN_ON} status="running" connected onExit={async () => undefined} />
        </div>
        <div data-guard-plan="chip-failed">
          <PlanChip
            planMode={PLAN_ON}
            status="idle"
            connected
            onExit={async () => '斜線命令被拒：這一輪還在跑'}
          />
        </div>
        <div data-guard-plan="review">
          <PlanReviewPanel
            pending={PLAN_PENDING}
            review={PLAN_REVIEW}
            busy={false}
            onApprove={() => {}}
            onRevise={() => {}}
          />
        </div>
        <div data-guard-plan="card">
          <PlanToolCard entry={PLAN_ENTRY} />
        </div>
        <div data-guard-plan="goal">
          <GoalBar goal={PLAN_GOAL} activation="armed" connected onPause={async () => undefined} />
        </div>
      </div>
    </RightSidebarProvider>
  );
}

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
      <ToolCard entry={TOOL} />
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

/** tool-steps（#1682 PR A）：執行中那一列要有東西可展開（`detail`），不然按鈕停用、量不到 `animate-pulse` 那一顆。 */
const TOOL_STEPS: Step[] = [
  { id: 'running', label: '執行指令 pnpm test', status: 'running', detail: 'pnpm test' },
  {
    id: 'done',
    label: '搜尋 第 1 節',
    status: 'done',
    detail: '{"pattern":"第 1 節","output_mode":"count"}',
    output: 'notes-0.md: 1\nnotes-1.md: 1',
  },
  { id: 'failed', label: '讀取 nope.ts', status: 'error', error: '沒有這個檔' },
];

/** 單獨那一列的結果夠長、超過結果框的 `max-h-64`：量鍵盤聚焦後方向鍵捲得動（patch `0019`，#1682 PR B）。 */
const LONG_STEP: Step = {
  ...TOOL_STEPS[1]!,
  id: 'long',
  output: Array.from({ length: 60 }, (_, i) => `notes-${i}.md: 1`).join('\n'),
};

function ToolStepsPage() {
  const [open, setOpen] = useState<Record<string, boolean>>({ done: true, failed: true });
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
      <div data-guard-tool="group">
        <StepGroup steps={TOOL_STEPS} defaultOpen>
          {TOOL_STEPS.map((step) => (
            <StepRow
              key={step.id}
              step={step}
              open={open[step.id] ?? false}
              onOpenChange={(value) => setOpen((current) => ({ ...current, [step.id]: value }))}
            />
          ))}
        </StepGroup>
      </div>
      <div data-guard-tool="standalone">
        <StepRow step={LONG_STEP} open />
      </div>
    </div>
  );
}

/** 產品的工具卡與工具段（#1682 PR B）。 */
const CARD = (overrides: Partial<ToolEntry>): ToolEntry => ({ ...TOOL, ...overrides });
const RUN_TOOLS: ToolEntry[] = [
  CARD({
    id: 'run-1',
    callId: 'run-c1',
    name: 'echo',
    input: '{"message":"嗨"}',
    text: 'echo: 嗨',
  }),
  CARD({ id: 'run-2', callId: 'run-c2', name: 'grep', input: '{"pattern":"計畫"}', text: '2' }),
];
/** 段首是只有思考、沒有思考文字的那一步（`tool-runs.ts` 的 `transparent`）：畫出空的 item，量第 66 條。 */
const RUN_ENTRIES: ConversationEntry[] = [
  { kind: 'ai', id: 'run-0', text: '', streaming: false, attribution: { kind: 'root' } },
  ...RUN_TOOLS,
];
const STOP_ERROR = 'Error: tool call aborted before dispatch';
/** 背景子代理卡的狀態字（「跑著」）要有控制器才畫；guard 只量字，卡收著、面板不畫，其餘欄位不會被叫到。 */
const GUARD_SUBAGENTS: SubagentControl = {
  connected: true,
  renderEntry: () => null,
  history: async () => ({ ok: false, message: '' }),
  stateOf: () => 'running',
  echoesOf: () => [],
  send: async () => ({ ok: true }),
  interrupt: async () => undefined,
};
const ASK_INPUT = JSON.stringify({ questions: [{ id: 'd', question: '哪一天？' }] });

function ToolCardsPage() {
  const [open, setOpen] = useState(true);
  return (
    <div
      data-guard-cards=""
      style={{
        maxWidth: '48rem',
        margin: '0 auto',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      {/* 段裡每一則是一格 `MessageScrollerItem`，要包在 scroller 裡（同 `Transcript`）。 */}
      <MessageScrollerProvider>
        <MessageScroller>
          <MessageScrollerViewport aria-label="工具段">
            <MessageScrollerContent>
              <ToolRun
                run={{
                  kind: 'tool-run',
                  id: 'tools:run-0',
                  entries: RUN_ENTRIES,
                  tools: RUN_TOOLS,
                }}
                open={open}
                onOpenChange={setOpen}
                renderEntry={(entry) =>
                  entry.kind === 'tool' ? (
                    <ToolCard entry={entry} defaultOpen={entry.id === 'run-1'} />
                  ) : null
                }
              />
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </MessageScrollerProvider>
      <ToolCard
        entry={CARD({
          id: 'running',
          name: 'execute',
          input: '{"command":"pnpm test"}',
          status: 'running',
          text: undefined,
        })}
      />
      <ToolCard
        entry={CARD({
          id: 'suspended',
          name: 'ask_user_question',
          input: ASK_INPUT,
          status: 'suspended',
          text: undefined,
        })}
      />
      <ToolCard
        entry={CARD({ id: 'done', name: 'echo', input: '{"message":"嗨"}', text: 'echo: 嗨' })}
        defaultOpen
      />
      <ToolCard
        entry={CARD({
          id: 'failed',
          name: 'echo',
          input: '{"message":"嗨"}',
          status: 'failed',
          error: 'Error: 沒有這個檔',
          text: undefined,
        })}
        defaultOpen
      />
      <ToolCard
        entry={CARD({
          id: 'stopped',
          name: 'ask_user_question',
          input: ASK_INPUT,
          status: 'failed',
          error: STOP_ERROR,
          errorCode: ABORTED_BEFORE_DISPATCH_CODE,
          text: undefined,
        })}
      />
      <ToolCard
        entry={CARD({ id: 'sub', attribution: { kind: 'subagent', name: 'writer', callId: 'c0' } })}
      />
      <SubagentControlContext.Provider value={GUARD_SUBAGENTS}>
        <ToolCard
          entry={CARD({
            id: 'background',
            name: 'task',
            input: '{"description":"寫報告","subagent_type":"researcher"}',
            text: '已在背景開始',
            meta: { kind: 'background-subagent', runId: 'bg-1', subagentType: 'researcher' },
          })}
        />
      </SubagentControlContext.Provider>
      <ToolCard
        entry={CARD({
          id: 'max',
          name: 'task',
          input: '{"description":"寫報告"}',
          status: 'failed',
          error: 'Error: subagent run hit its token limit before finishing',
          text: undefined,
        })}
        defaultOpen
      />
    </div>
  );
}

/** 推理列（#1683）：內文要有連結與行內 code（量對比），還在想的那列摘要要長（量 375 寬往左裁）。 */
const REASONING_MD =
  '先讀**需求**，再對照 `docs/plan.md` 的[成本表](https://example.com)。\n\n- 方案 A：成本低、風險高\n- 方案 B：成本中、風險中\n\n建議方案 B。';
const REASONING_LONG =
  '先讀需求。\n使用者要一張表，列出三個方案的成本與風險、交付時程、需要的人力與每一項的假設，最後再給一句建議與理由';
const REASONING_RUN_ENTRIES: ConversationEntry[] = [
  {
    kind: 'ai',
    id: 'reasoning-run-0',
    text: '',
    reasoning: REASONING_MD,
    streaming: false,
    attribution: { kind: 'root' },
  },
  ...RUN_TOOLS.map((tool) => ({ ...tool, id: `reasoning-${tool.id}` })),
];

function ReasoningPage() {
  const [open, setOpen] = useState(true);
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
      <div data-guard-reasoning="done">
        <ReasoningRow text={REASONING_MD} running={false} />
      </div>
      <div data-guard-reasoning="running">
        <ReasoningRow text={REASONING_LONG} running />
      </div>
      {/* 段裡每一則是一格 `MessageScrollerItem`，要包在 scroller 裡（同 `Transcript`）。 */}
      <div data-guard-reasoning="panel">
        <MessageScrollerProvider>
          <MessageScroller>
            <MessageScrollerViewport aria-label="工具段">
              <MessageScrollerContent>
                <ToolRun
                  run={{
                    kind: 'tool-run',
                    id: 'tools:reasoning-run-0',
                    entries: REASONING_RUN_ENTRIES,
                    tools: REASONING_RUN_ENTRIES.filter(
                      (entry): entry is ToolEntry => entry.kind === 'tool',
                    ),
                  }}
                  open={open}
                  onOpenChange={setOpen}
                  renderEntry={(entry) =>
                    entry.kind === 'tool' ? (
                      <ToolCard entry={entry} />
                    ) : entry.kind === 'ai' && entry.reasoning !== undefined ? (
                      <ReasoningRow text={entry.reasoning} running={false} />
                    ) : null
                  }
                />
              </MessageScrollerContent>
            </MessageScrollerViewport>
          </MessageScroller>
        </MessageScrollerProvider>
      </div>
    </div>
  );
}

/** 狀態列（#1684）：執行中那一列每種 activity 一個本輪的樣子（判法見 `lib/turn-activity.ts`）。 */
const TURN_ENTRIES: Readonly<Record<string, readonly ConversationEntry[]>> = {
  thinking: [],
  searching: [RUN_TOOLS[0]!].map((t) => ({ ...t, name: 'grep', status: 'running' as const })),
  running: [RUN_TOOLS[0]!].map((t) => ({ ...t, name: 'execute', status: 'running' as const })),
  writing: [
    { kind: 'ai', id: 'a-writing', text: '找到了', streaming: true, attribution: { kind: 'root' } },
  ],
};

/** 這一輪 75 秒前開始（軌跡投影的 `turn/start`），server 時鐘樣本在畫面載入時補一次，經過時間才畫得出來（`lib/running-turn.ts`）。 */
function runningState(activity: string) {
  const { end: _end, durationMs: _duration, ...open } = turn(1, { time: Date.now() - 75_000 });
  const state = withTrajectory(emptyConversation(), new Script(), view([turn(0), open]));
  return { ...state, status: 'running' as const, entries: TURN_ENTRIES[activity] ?? [] };
}

function LivePager() {
  const [loading, setLoading] = useState(false);
  const earlier: EarlierHistory = {
    hasMore: true,
    loading,
    onLoad: () => {
      setLoading(true);
      setTimeout(() => setLoading(false), 300);
    },
  };
  return <EarlierPager earlier={earlier} />;
}

function TranscriptRowsPage() {
  const idle = { hasMore: true, loading: false, onLoad: () => undefined };
  const pagers: [string, EarlierHistory][] = [
    ['idle', idle],
    ['loading', { ...idle, loading: true }],
    ['fail', { ...idle, error: '連線中斷' }],
  ];
  return (
    <div
      style={{
        maxWidth: '42rem',
        margin: '0 auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      <div data-guard-rows="retry" style={{ padding: '16px 24px 0' }}>
        <RetryNotice retry={RETRY} />
      </div>
      {pagers.map(([name, earlier]) => (
        <div key={name} data-guard-pager={name}>
          <EarlierPager earlier={earlier} />
        </div>
      ))}
      <div data-guard-pager="live">
        <LivePager />
      </div>
      <div data-guard-rows="empty" style={{ display: 'flex', minHeight: 320, padding: '0 24px' }}>
        <EmptyHero />
      </div>
    </div>
  );
}

function TurnStatusPage() {
  const [activity, setActivity] = useState('thinking');
  useState(() => {
    const now = Date.now();
    serverClock.observe(new Date(now).toUTCString(), now - 20, now + 20);
    return null;
  });
  useEffect(() => {
    const hooks = window as unknown as {
      __setTurnActivity?: (a: string) => void;
      __openingPose?: (a: string) => string[][];
    };
    hooks.__setTurnActivity = setActivity;
    // 每種 activity 的起始姿勢（減少動態時 glyph 停在這裡），照 vendor `draw` 取到小數兩位、四個屬性都給。
    // 1.7 是 vendor 沒 export 的 `RADIUS`（`src/test/glyph-env.ts` 的 `GLYPH_RADIUS`，`registry-edits.test.ts` 釘住原文）。
    hooks.__openingPose = (a) =>
      (STATUS_FIGURES.find((entry) => entry.activity === a)?.figure(0) ?? []).map((dot) => [
        dot.x.toFixed(2),
        dot.y.toFixed(2),
        (1.7 * dot.s).toFixed(2),
        Math.max(0, Math.min(1, dot.o)).toFixed(2),
      ]);
  }, []);
  const only = params.get('only');
  const rows = [
    ['idle', emptyConversation()],
    ['running', runningState(activity)],
    [
      'awaiting',
      { ...emptyConversation(), status: 'awaiting-input' as const, pendings: [QUESTION] },
    ],
  ] as const;
  return (
    <div
      style={{
        maxWidth: '42rem',
        margin: '0 auto',
        padding: '16px 24px 0',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      {rows
        .filter(([name]) => only === null || only === name)
        .map(([name, state]) => (
          <div key={name} data-guard-status={name}>
            <StatusLine state={state} connected />
          </div>
        ))}
    </div>
  );
}

/**
 * 增刪行數（#1685 PR A，`?overlay=diff-stats`）：SG `DiffStats` 的 `+`／`−` 疊在四種底上量對比——頁面底與漸層（`page`）、
 * 工具段 `StepList` 的 `--panel`（`panel`，段裡寫檔那張卡的標頭）、改動卡（`changes`）、審查頁（測試點開卡片後量）。
 * 改動卡與審查頁讀假的 fetch：摘要三個檔（一個二進位），比較都回同一段。路徑故意很長：375 寬時列被擠，量 stats 有沒有被擠窄。
 */
const DIFF_LONG_NOTES = 'docs/meeting-notes/2026/october/quarterly-review-follow-up.md';
const DIFF_NOTES = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行`).join('\n');
const DIFF_WRITE = CARD({
  id: 'diff-write',
  callId: 'diff-c1',
  name: 'write_file',
  input: JSON.stringify({ file_path: `/${DIFF_LONG_NOTES}`, content: `${DIFF_NOTES}\n` }),
  text: `Successfully wrote to /${DIFF_LONG_NOTES}`,
});
const DIFF_TOOLS: ToolEntry[] = [
  DIFF_WRITE,
  CARD({
    id: 'diff-echo',
    callId: 'diff-c2',
    name: 'echo',
    input: '{"message":"嗨"}',
    text: 'echo: 嗨',
  }),
];
const DIFF_SUMMARY = {
  files: [
    {
      path: 'packages/nexus-harness/src/plugins/workspace/changes/summary-reader.ts',
      display: 'packages/nexus-harness/src/plugins/workspace/changes/summary-reader.ts',
      added: 1234,
      deleted: 5,
    },
    { path: 'notes.md', display: 'notes.md', added: 12, deleted: 0 },
    { path: 'logo.png', display: 'logo.png', added: 0, deleted: 0, binary: true },
  ],
  total: 3,
  added: 1246,
  deleted: 5,
};
const DIFF_FILE = {
  kind: 'text',
  path: 'packages/nexus-harness/src/plugins/workspace/changes/summary-reader.ts',
  display: 'packages/nexus-harness/src/plugins/workspace/changes/summary-reader.ts',
  before: true,
  after: true,
  coarse: false,
  hunks: [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 2, lines: [' keep', '-old', '+new'] }],
};
const DIFF_CHANGES = createChangesStores({
  threadId: 'guard',
  baseUrl: 'http://guard.invalid',
  fetch: async (url) =>
    new Response(
      JSON.stringify(new URL(String(url)).pathname.endsWith('/summary') ? DIFF_SUMMARY : DIFF_FILE),
    ),
});

function DiffStatsPage() {
  const [open, setOpen] = useState(true);
  return (
    <RightSidebarProvider threadId="guard" sources={{ changes: DIFF_CHANGES }}>
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
        <div data-guard-diffstats="page">
          <DiffStats added={1234} removed={0} />
        </div>
        {/* 段裡每一則是一格 `MessageScrollerItem`，要包在 scroller 裡（同 `Transcript`）。 */}
        <div data-guard-diffstats="panel">
          <MessageScrollerProvider>
            <MessageScroller>
              <MessageScrollerViewport aria-label="工具段">
                <MessageScrollerContent>
                  <ToolRun
                    run={{
                      kind: 'tool-run',
                      id: 'tools:diff-run',
                      entries: DIFF_TOOLS,
                      tools: DIFF_TOOLS,
                    }}
                    open={open}
                    onOpenChange={setOpen}
                    renderEntry={(entry) =>
                      entry.kind === 'tool' ? <ToolCard entry={entry} /> : null
                    }
                  />
                </MessageScrollerContent>
              </MessageScrollerViewport>
            </MessageScroller>
          </MessageScrollerProvider>
        </div>
        <div data-guard-diffstats="changes">
          <ChangesCard seq={7} changes={DIFF_CHANGES} />
        </div>
      </div>
      <RightSidebarPanel />
    </RightSidebarProvider>
  );
}

/**
 * SG 的 `DiffView`（#1685 PR B，`?overlay=diff-view`）：產品的工具卡給了 `step.patch` 之後，展開的 diff 疊在兩種底上——
 * 工具段 `StepList` 的 `--panel` 上（`data-guard-diffview="group"`），以及單獨一張卡、直接疊在頁面底上（`"standalone"`）。
 * 改檔那張有兩個檔、同一檔兩段：`diff --git`、`@@`、新增、刪除、上下文都有；寫檔那張每行 1,999 字，撞到整張卡的字元預算，尾端有
 * `... 還有 N 行沒畫`。
 */
const DIFF_VIEW_EDIT = CARD({
  id: 'dv-edit',
  callId: 'dv-c1',
  name: 'edit_file',
  input: JSON.stringify({ file_path: '/src/app.ts', old_string: 'a', new_string: 'b' }),
  text: 'ok',
  meta: {
    diffs: [
      { path: '/src/app.ts', oldText: 'x\nconst a = 1;\ny\n', newText: 'x\nconst a = 2;\ny\n' },
      { path: '/src/app.ts', oldText: 'p\nold\nq\n', newText: 'p\nnew\nq\n' },
      { path: '/docs/notes.md', oldText: null, newText: '第一行\n第二行\n' },
    ],
  },
});
const DIFF_VIEW_WRITE = CARD({
  id: 'dv-write',
  callId: 'dv-c2',
  name: 'write_file',
  input: JSON.stringify({
    file_path: '/data/wide.txt',
    content: Array.from({ length: 25 }, (_, i) => `${i}`.padEnd(1999, 'x')).join('\n'),
  }),
  text: 'ok',
});
const DIFF_VIEW_TOOLS: ToolEntry[] = [DIFF_VIEW_EDIT, DIFF_VIEW_WRITE];

function DiffViewPage() {
  const [open, setOpen] = useState(true);
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
      <div data-guard-diffview="group">
        <MessageScrollerProvider>
          <MessageScroller>
            <MessageScrollerViewport aria-label="工具段">
              <MessageScrollerContent>
                <ToolRun
                  run={{
                    kind: 'tool-run',
                    id: 'tools:dv-run',
                    entries: DIFF_VIEW_TOOLS,
                    tools: DIFF_VIEW_TOOLS,
                  }}
                  open={open}
                  onOpenChange={setOpen}
                  renderEntry={(entry) =>
                    entry.kind === 'tool' ? <ToolCard entry={entry} defaultOpen /> : null
                  }
                />
              </MessageScrollerContent>
            </MessageScrollerViewport>
          </MessageScroller>
        </MessageScrollerProvider>
      </div>
      <div data-guard-diffview="standalone">
        <ToolCard entry={{ ...DIFF_VIEW_EDIT, id: 'dv-edit-2' }} defaultOpen />
        <ToolCard entry={{ ...DIFF_VIEW_WRITE, id: 'dv-write-2' }} defaultOpen />
      </div>
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

const REFS_LINKS = {
  openable: (sessionId: string) => sessionId === 'thread-mine',
  open: () => undefined,
};
const REFS_ENTRIES: ConversationEntry[] = [
  ...MESSAGES,
  COMPACTION,
  {
    kind: 'human',
    id: 'h-refs',
    text: '照 @部署腳本除錯 的結論，順便看 @月報 那份。',
    references: [
      { sessionId: 'thread-mine', label: '部署腳本除錯' },
      { sessionId: 'thread-other', label: '月報' },
    ],
  },
  { kind: 'decision', id: 'decision-refs', decision: 'approve', actions: ['call-1'] },
];

function TranscriptRefsPage() {
  return (
    <div style={{ height: 600, display: 'flex', flexDirection: 'column' }}>
      <SessionReferenceContext.Provider value={REFS_LINKS}>
        <Transcript
          state={{ ...emptyConversation(), entries: REFS_ENTRIES }}
          isFresh={() => false}
        />
      </SessionReferenceContext.Provider>
      <div
        data-guard-rows="status"
        style={{ maxWidth: '42rem', margin: '0 auto', width: '100%', padding: '0 24px' }}
      >
        <StatusLine
          state={emptyConversation()}
          connected={false}
          reconnecting={{ wasConnected: true, offline: false }}
          onReconnect={() => undefined}
        />
      </div>
      <div
        data-guard-rows="archived"
        style={{ maxWidth: '42rem', margin: '0 auto', width: '100%', padding: '0 24px' }}
      >
        <ArchivedBanner onRestore={() => Promise.resolve(undefined)} />
      </div>
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
    case 'transcript-refs':
      return <TranscriptRefsPage />;
    case 'attachments':
      return <AttachmentsPage />;
    case 'tool-steps':
      return <ToolStepsPage />;
    case 'tool-cards':
      return <ToolCardsPage />;
    case 'reasoning':
      return <ReasoningPage />;
    case 'diff-stats':
      return <DiffStatsPage />;
    case 'diff-view':
      return <DiffViewPage />;
    case 'turn-status':
      return <TurnStatusPage />;
    case 'transcript-rows':
      return <TranscriptRowsPage />;
    case 'handoff':
      return <HandoffPage />;
    case 'plan':
      return <PlanPage />;
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
