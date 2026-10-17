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
 *   - `data-guard-expanded`：Radix 浮層 Trigger（asChild）包著的 outline 按鈕開著時（`trigger`）跟沒開的（`reference`）比底色：
 *     SG 用 `[aria-expanded="true"]` 把它畫成按下去的樣子（#1523 的混合期）。
 *   - `data-guard-hover`：平常與滑鼠移上去兩種狀態各量一次字對底色（destructive 按鈕，頁面上與卡片裡各一顆；hover 底是覆寫檔調淡的，#1523）。
 *   - `data-guard-choice`：問答的選項（已勾選、沒勾選、停用），量平常與滑鼠移上去的底色、停用的樣子：shadcn 的 `data-*` custom variant
 *     （`vendor/solid-glass/shadcn/tailwind.css`，#1523）specificity 是 0，不能改掉這幾個 variant 原本的行為。
 * - 亮暗由網址的 `?theme=dark` 決定，在第一次繪製前套好（同 `index.html`）。
 * - `?glass=opaque` 在 `<html>` 掛 `data-glass="opaque"`（#1468 Q7：效能不達標時退回的那條路），量不透明的面。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { Counts } from '@/components/changes/counts';
import { ContextMeter } from '@/components/context-meter';
import { RetryNotice } from '@/components/retry-notice';
import { Surface } from '@/components/surface';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupInput } from '@/components/ui/input-group';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
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
          <InputGroup data-guard-outline-host="input-group" data-guard-shadow="input-group">
            <InputGroupInput
              data-guard-focus="input-group"
              data-guard-field="input-group"
              aria-label="輸入框"
              placeholder="輸入"
            />
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

        {/* 混合期（#1523）：Radix 浮層的 Trigger 用 asChild 包 Base UI 的 Button。Radix 掛的是 `aria-expanded`，
            SG 的 `:665` 用它把 outline 按鈕畫成按下去的玻璃；Base UI 的 `[data-popup-open]` 這時不會有。 */}
        <div style={{ ...row, gap: 240, paddingBottom: 120 }}>
          <Button variant="outline" data-guard-expanded="reference">
            沒開的按鈕
          </Button>
          <Popover open>
            <PopoverTrigger asChild>
              <Button variant="outline" data-guard-expanded="trigger">
                開著的按鈕
              </Button>
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
            <TooltipContent side="bottom" data-guard-text="tooltip">
              提示內容
            </TooltipContent>
          </Tooltip>
        </div>
      </main>
    </TooltipProvider>
  );
}

const root = document.getElementById('root');
if (root === null) throw new Error('找不到 #root');
createRoot(root).render(
  <StrictMode>
    <GuardPage />
  </StrictMode>,
);
