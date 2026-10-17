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
 *   - `data-guard-chip`：裡面那顆按鈕平常、滑鼠移上去、按下去三種狀態各量一次字色對底色（chip 三階，#1512）。
 *   - `data-guard-located`：對話裡被定位的那一則（`[data-slot=message-scroller-item][data-located]`），量圓角真的畫出來。
 *   - `data-guard-glass`：SG 畫成玻璃的按鈕（outline、secondary、glass），量它真的有 `backdrop-filter`：`solid-glass.css:640-677`
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
 *   - `data-guard-checks`：picker 勾選的那一列，量它看得見的勾有幾顆、報讀名稱是什麼（vendor 附的勾由覆寫檔藏掉，#1583 本地修改第 27 條）。
 *   vendor 元件自己畫的部分（關閉鈕、遮罩）掛不了屬性，由 `guard.test.ts` 開頁後補上，見 `OVERLAY_MARKS`。
 * - 亮暗由網址的 `?theme=dark` 決定，在第一次繪製前套好（同 `index.html`）。
 * - `?glass=opaque` 在 `<html>` 掛 `data-glass="opaque"`（#1468 Q7：效能不達標時退回的那條路），量不透明的面。
 * - `?overlay=<名字>` 換成只畫一個開著的 modal 浮層（#1583）：modal 會把頁面其他部分設成 inert，跟主頁的焦點量測放不到一起。
 *   `dialog`、`sheet`、`mobile-sidebar`（要用手機寬度開）、`feedback`（回饋框，量寬度）、`alert-dialog`、`dropdown`（側欄列的「⋯」選單）、
 *   `picker`（輸入框底列的選擇座位，有搜尋框）、`dropdown-keyboard`（關著的選單，量鍵盤 Enter 打開與選取，#1583 驗收 D）。
 */
import { MoreHorizontal } from 'lucide-react';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { Counts } from '@/components/changes/counts';
import { ContextMeter } from '@/components/context-meter';
import { RetryNotice } from '@/components/retry-notice';
import { Surface } from '@/components/surface';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea,
} from '@/components/ui/input-group';
import { FeedbackDialog } from '@/components/feedback-dialog';
import { PickerSeat } from '@/components/picker-seat';
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
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
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
/** SG 畫成玻璃的按鈕（`solid-glass.css:640-677` 靠 `data-variant` 命中；`glass` 走 `glass-control`）。 */
const GLASS_VARIANTS: readonly string[] = ['outline', 'secondary', 'glass'];
const BADGE_VARIANTS = ['default', 'secondary', 'destructive', 'outline', 'ghost', 'link'] as const;

const row = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 } as const;

/** 用量表的門檻 10 個 token：5 是 50%（次要文字），9 是 90%（80% 以上換成 warning）。 */
const METER = {
  approxTokens: 0,
  messageCount: 1,
  thresholds: [{ type: 'tokens', value: 10 }],
} as const;
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

        {/* chip 三階（#1512）：用量表收著時是次要文字、80% 以上換成 warning，hover／按下的底是 chip-hover／chip-pressed；
            重試那一行是平的 chip 底加次要文字。 */}
        <div style={row}>
          <div data-guard-chip="context-meter">
            <ContextMeter pressure={{ measure: { ...METER, approxTokens: 5 } }} />
          </div>
          <div data-guard-chip="context-meter-warning">
            <ContextMeter pressure={{ measure: { ...METER, approxTokens: 9 } }} />
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

        <div style={{ height: 160 }}>
          <SidebarProvider style={{ minHeight: 0, height: '100%' }}>
            <Sidebar collapsible="none" data-guard-text="sidebar" data-guard-surface="sidebar">
              側欄
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    data-guard-text="sidebar-menu-button"
                    data-guard-focus="sidebar-menu-button"
                  >
                    側欄選單
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </Sidebar>
          </SidebarProvider>
        </div>

        {/* 浮層的 Trigger 用 `render` 畫成 Base UI 的 Button（#1583 起 popover 也是 Base UI）。開著時 Trigger 掛 `data-popup-open`
            與 `aria-expanded="true"`，SG 的 `:665` 用它們把 outline 按鈕畫成按下去的玻璃。 */}
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
    case 'picker':
      return <OpenPicker />;
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

/** 輸入框底列的選擇座位，打開、列數超過門檻（有搜尋框）；勾選的是第三列，跟 cmdk 預設選中的第一列分開。 */
function OpenPicker() {
  const items = ['一', '二', '三', '四', '五', '六', '七'].map((label, i) => ({
    id: `item-${i}`,
    label: `選項${label}`,
    checked: i === 2,
  }));
  return (
    <div style={{ padding: '420px 40px 40px' }}>
      <PickerSeat
        icon={<MoreHorizontal />}
        label="選項三"
        accessibleName="選項：選項三，點開切換"
        tip="選項：選項三"
        groups={[{ id: 'g', heading: '選項', items }]}
        onPick={() => {}}
        open
        onOpenChange={() => {}}
        popoverLabel="選選項"
        testId="guard-picker"
      />
    </div>
  );
}

const overlay = params.get('overlay');
const root = document.getElementById('root');
if (root === null) throw new Error('找不到 #root');
createRoot(root).render(
  <StrictMode>{overlay === null ? <GuardPage /> : <OverlayPage name={overlay} />}</StrictMode>,
);
