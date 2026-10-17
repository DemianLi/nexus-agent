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
 * - 亮暗由網址的 `?theme=dark` 決定，在第一次繪製前套好（同 `index.html`）。
 * - `?glass=opaque` 在 `<html>` 掛 `data-glass="opaque"`（#1468 Q7：效能不達標時退回的那條路），量不透明的面。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { Counts } from '@/components/changes/counts';
import { Surface } from '@/components/surface';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupInput } from '@/components/ui/input-group';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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
] as const;
const BADGE_VARIANTS = ['default', 'secondary', 'destructive', 'outline', 'ghost', 'link'] as const;

const row = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 } as const;

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

        <div style={{ width: 360 }}>
          <Surface tone="docked" data-guard-docked="docked" data-guard-text="docked">
            貼在輸入框上方的卡片
          </Surface>
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
