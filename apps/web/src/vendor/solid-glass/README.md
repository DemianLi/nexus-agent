# vendor 的 solid-glass

上游的檔原樣複製進來，不經 npm 相依。格式照 repo 根目錄的 [`vendor/README.md`](../../../../../vendor/README.md)：清單記上游 commit，本地修改逐條登記，保留上游的 MIT `LICENSE`。

為什麼改用 solid-glass、為什麼原樣 vendor：demian 2026-10-17 拍板，見 [#1468 的拍板留言](https://github.com/DemianLi/nexus-agent/issues/1468#issuecomment-6221153573)（Q1、Q4、Q9、Q18）。整條線的進度在地圖 [#1497](https://github.com/DemianLi/nexus-agent/issues/1497)；這個目錄由第 ① 步 [#1498](https://github.com/DemianLi/nexus-agent/issues/1498) 建立。

## 清單

上游有兩個，版本只記在 [`manifest.json`](manifest.json) 的 `sources`：

| 上游 | 固定在 | 怎麼取 |
|---|---|---|
| solid-glass：https://github.com/deeplethe/solid-glass | `commit`（目前是 `387c3c2`，2026-10-15；上游 main 之後還有 commit，照拍板不跟） | git clone，停在那個 commit |
| shadcn：npm 的 `shadcn` 套件 | `version` 與 tarball 的 `integrity`（目前是 `4.21.4`，即 SG 的 `package-lock.json` 鎖的那一版、同一個 sha512） | `npm pack shadcn@<version>` 的 tarball；只取它 `exports["./tailwind.css"]` 指的那個檔，**不加 `shadcn` 這個 CLI 套件當相依**（它帶進 MCP SDK 等一串相依，內網不值得；#1523 PM 定） |

| 這裡 | 上游 | 從哪一步開始 |
|---|---|---|
| `solid-glass.css` | solid-glass `src/solid-glass.css` | ① |
| `LICENSE` | solid-glass `LICENSE` | ① |
| `components/ui/{button,input,textarea,input-group,separator,skeleton,card,badge}.tsx` | solid-glass `src/components/ui/` 同名檔 | ③-1（#1523） |
| `shadcn/tailwind.css` | shadcn `dist/tailwind.css` | ③-1（#1523） |
| `shadcn/LICENSE.md` | shadcn `LICENSE.md`（MIT） | ③-1（#1523） |

**目錄**：solid-glass 的檔照上游的相對路徑放，拿掉開頭的 `src/`（`solid-glass.css` 從 ① 就是這樣）；shadcn 的檔放在 `shadcn/` 底下，拿掉 `dist/`。每個檔登記它的上游（`source`）與上游路徑（`from`）。

每個檔的 sha256 記在 `manifest.json`，`vendor.test.ts` 比對（子目錄也掃）：手改這裡的檔、或放進沒登記的檔，CI 就紅，不用拉上游。

之後加進來的，照地圖的順序：其餘的 registry 元件在 ③-2～③-4，12 個 AI 元件與 AgentWorkspace 在第 ④ 步。每一步用到哪些檔就加哪些，同一支 `sync.mjs`、同一個 commit 同步（Q18 的「一起同步」）。

**元件怎麼接**（#1523 PM 定）：vendor 的元件原樣放這裡，`src/components/ui/<x>.tsx` 留著當 nexus 那一層，預設只轉出 vendor 版，本地修改能用 props 表達的寫成薄包裝放在那裡。vendor 檔裡的 `@/components/ui/button` 解析到的是 nexus 那一層，所以包裝層的修改在 vendor 的組合元件裡也生效。③-1 的 8 個元件，`components/ui/<x>.tsx` 都已換成轉出 vendor 版；有本地修改的只有 `input-group.tsx`（第 16 條），其餘是一行 `export … from`。

**載入**：`shadcn/tailwind.css` 照 SG `src/index.css:1-7` 的順序，排在 `tailwindcss`、`tw-animate-css` 之後、`solid-glass.css` 之前（`src/index.css`）。它的 9 個 `@custom-variant`（`data-open`、`data-closed`、`data-checked`、`data-unchecked`、`data-selected`、`data-disabled`、`data-active`、`data-horizontal`、`data-vertical`）會蓋掉 Tailwind 內建的同名 variant：寫成 `:where()`，specificity 從 0,1,0 變成 0，同時認 Radix 的 `data-state` 與 Base UI 的屬性，只認「有屬性且不是 `"false"`」。產品碼裡用到的只有 `components/ui/questionnaire.tsx`（`data-checked`、`data-disabled`、`group-data-checked`），畫出來的值跟換之前逐一相同（`guard/` 的問答選項、`components/ui/questionnaire.test.tsx` 釘 primitive 輸出的屬性）。

**護欄放行**：掃原始碼的護欄對這裡**登記過的**上游檔放行，名單只在 `src/test/vendor-upstream.ts`（從 `manifest.json` 取）。放行：`lib/utils.test.ts` 的 cn 那條（Q19）、`design-system`、`border-shadow`、`type-hierarchy`（外觀照 SG，Q8）；**不放行**：tsc、`live-region` 與其他無障礙類的掃描。設定檔非寫路徑字面不可的另外各寫一次：根目錄的 `eslint.config.js`（忽略 `components/`）與 `.prettierignore`（排除 `components/`、`shadcn/`，上游 tsx 用雙引號、不加分號，格式化後 sha256 就壞）、這個目錄的 `.gitattributes`（`-text`）、`src/index.css` 的 `@source not`。

## 本地修改

規則（Q9）：**這裡的檔不動。** 要改的寫在 `index.css` 裡排在它後面的檔，CSS 靠後載入就蓋得掉，所以同步只是換檔再比對，不必把修改重新套上去。修改分在兩處（第 ② 步 [#1512](https://github.com/DemianLi/nexus-agent/issues/1512) 建立），**同步上游時兩處都要看**：

- `src/styles/solid-glass.overrides.css`：機制類的規則與字型（Q6、Q8）。規則除了焦點 offset 那段刻意留在 base layer，都在 layer 外。
- `src/styles/tokens.generated.css`：顏色。由 `tokengen/generate.mjs` 產生，不要手改；SG 的輸入值抄在 `tokengen/sg-input.mjs`（`sg-input.test.ts` 逐值比對這個檔）。

| # | 在哪 | 蓋掉 `solid-glass.css` 的哪裡 | 改成什麼、為什麼 | 釘住的測試 |
|---|---|---|---|---|
| 1 | overrides | `:857-860` 的焦點 ring（`--focus-line` 3px；`:851-856` 是它的註解） | 焦點只有一種樣子：2px 字色外框、offset 2px，外框寫在 layer 外（Q5、#1279）；registry 的 `focus-visible:ring-*` 在 `:focus-visible` 上清成透明 | `focus-outline.test.ts`、`guard/`（焦點） |
| 2 | overrides | `:857-860` 兩個選擇器把 ring 帶回來（specificity 比 #1 高） | 照抄同一段選擇器、後載入，把 `--tw-ring-shadow` 壓回透明（D′）；不讓 Prettier 排版，才能一字不差 | `focus-ring-suppression.test.ts`（列舉 vendor 裡每一條帶回 ring 的宣告，條數釘死） |
| 3 | overrides | `:343` 起的 `body`（`@layer base`）、`:233` 的 `.dark { color-scheme }` | body 的底色、字色與亮暗兩個 `color-scheme` 寫在 layer 外：沒有 layer 的樣式永遠贏過有 layer 的，頁面被包進帶 reset 的外殼時暗色不會變成黑底深字（Q8 保留的機制）。SG 的漸層背景照用 | `solid-glass-overrides.test.ts` |
| 4 | overrides | `:1319-1322` reduced-motion 下進場 `animation: none` | 改成 150ms 的淡入（Q5：reduced-motion 保留 ≤ 150ms 的透明度動畫）；持續動畫照 SG 停掉 | `reduced-motion.test.ts`、`scripts/check-built-css.mjs` |
| 5 | overrides | （不是改 SG）| nexus 自己的高亮：`[data-located]`（chip 底色、3xl 圓角）、`[data-revealed]`（字色外框） | `solid-glass-overrides.test.ts`、`focus-outline.test.ts` |
| 6 | tokens.generated | `:root`／`.dark` 的顏色 | 達不到 Q5 門檻的 SG 顏色照 demian 選的 B 案重解（色相照 SG、彩度收進 sRGB、解明度）；達標的原樣。`--ring`／`--sidebar-ring`＝字色（Q5）。亮暗一定成對。`--destructive` 另外要過自己的淡紅底（#1523）：vendor 的 destructive 按鈕與 badge 是淡紅底配 `text-destructive`，所以字疊在頁面與卡片上的淡紅底也要 ≥ 4.5，平常（亮 /10、暗 /20，vendor 原值）與按鈕 hover（亮 /17、暗 /26，第 17 條）兩格都約束，alpha 只寫在 `tokengen/destructive-tint.mjs`。重解後亮 `oklch(0.45 0.183 27.325)`、暗 `oklch(0.765 0.139 22.216)`；暗色原本是 SG 原值（P3 內、不在 sRGB），現在落在 sRGB 內，`tokens-generated.test.ts` 的 `OUT_OF_SRGB` 已清空 | `tokens-contrast.test.ts`（含淡紅底 12 格）、`tokens-generated.test.ts`、`sg-input.test.ts`、`guard/`（destructive 平常與 hover） |
| 7 | tokens.generated | `:1171-1196` reduced-transparency 的不透明面 | 產物覆寫了 `--card`，排在 SG 後面的無條件值會蓋掉這段的不透明值，所以照 SG 原值重寫被覆寫的那幾個 | `tokens-generated.test.ts` |
| 8 | tokens.generated | `:1166-1170` `data-glass="opaque"` 只拿掉 blur | 面換成跟 reduced-transparency 同一組不透明值（含 `--primary-solid: 100%`）；暗色用 `.dark[data-glass]` 高一階 specificity（Q7） | `tokens-generated.test.ts`、`tokens-contrast.test.ts`（三種狀態都量） |
| 9 | overrides 的 `@theme inline` | `:41-42` 字型堆疊 | Geist／Geist Mono 打包 latin，Geist Mono 另加方框字元的 symbols2（`styles/fonts.css`），中文接 Noto Sans TC，系統後備 PingFang TC、Microsoft JhengHei，拿掉 SG 的三個簡體字型；等寬在 Noto Sans TC 前先接 Consolas、Menlo；等寬尾端保留三個 emoji 字型（#979）（Q6；symbols2 與系統等寬是 demian 2026-10-17 在 PM session 拍板，#1512） | `font-stack.test.ts` |
| 10 | overrides | `:37` `@custom-variant dark (&:is(.dark *))` | 重新定義成 `&:is(.dark, .dark *)`：`<html class="dark">` 本身也要吃到 `dark:`（Q8 保留的機制） | `scripts/check-built-css.mjs`（量產物） |
| 11 | tokens.generated | `:1171-1196` 不透明面的亮色 `--sidebar`（`oklch(0.985 0 0)`） | 不透明的退路（#7、#8 兩處共用同一組值）也要過 Q5 的表面亮暗差 ≤ 0.05：SG 原值不過，用跟半透明那套同一支 `solveLightSurface` 只調亮色，重解成 `oklch(0.952 0 0)`；其餘不透明值已達標、照 SG（#1512，PM 定 (b)） | `tokens-generated.test.ts`（具名覆寫）、`tokens-contrast.test.ts`、`guard/`（不透明的面） |
| 12 | overrides | `:944-948` 欄位聚焦的邊框、`:951-955` 一次性密碼格的內側線（都是 `--focus-line` 灰） | 照抄同一段選擇器、後載入，顏色換回 `var(--ring)`（字色）：Q5 焦點用字色，Q8 碰到 Q5 涵蓋的項目以 Q5 為準（#1512，PM 定 (b)）；不讓 Prettier 排版 | `focus-line-suppression.test.ts`（列舉每一條用到 `--focus-line` 的宣告）、`guard/`（欄位聚焦後的邊框） |
| 13 | overrides＋`components/surface.tsx` | `:378-391` `.bg-card` 歸零 border、加上浮起的整組陰影 | 貼在輸入框上方的卡片（`Surface tone="docked"`）要平的：`.bg-card[data-surface='docked']` 給 1px `--glass-edge` 邊、`box-shadow: none`，底色與 blur 照 SG。`data-surface` 是 `Surface` 只給 docked 掛的屬性，專給這條用（Q8 機制類保留，#1512，PM 定） | `solid-glass-overrides.test.ts`、`guard/`（docked 的邊與陰影） |

**解析層**（#1523 起）：vendor 的檔不動，改的是模組解析。

| # | 在哪 | 蓋掉 vendor 的哪裡 | 改成什麼、為什麼 | 釘住的測試 |
|---|---|---|---|---|
| 14 | `resolve-alias.ts`（`vite.config.ts`、`vitest.config.ts`、`guard/vite.config.ts` 共用）＋`tsconfig.json` 的 `paths` | `components/ui/*.tsx` 的 `import { cn } from "cn"` | 裸的 `cn` 精確解析到 `src/lib/utils.ts`（`cn/config` 不動，`utils.ts` 自己從它取）：npm 的 `cn` 不認得 `text-ui`、`rounded-row`，會把 #1141 帶回來（Q19 放行的執行方式，PM 定）。Vite 用正規式 `/^cn$/`，字串鍵會連 `cn/config` 一起改寫。別名是全域的，但打包進來的相依套件沒有一個 import 裸的 `cn`（#1523 用 build 時的 `resolveId` 探針確認），實際只作用在 vendor 的元件 | `lib/cn-alias.test.tsx`（渲染 vendor 原樣的 Button）、`vite-config.test.ts`（build、guard、tsconfig 三份解析） |

**元件層**（#1523 起）：vendor 的元件檔不動，改在覆寫檔或 `components/ui/<x>.tsx` 這一層（選層順序：覆寫檔 → 包裝層；③-1 不改 vendor 檔）。

| # | 在哪 | 蓋掉 vendor 的哪裡 | 改成什麼、為什麼 | 釘住的測試 |
|---|---|---|---|---|
| 15 | overrides | `components/ui/input-group.tsx:17` 群組容器的 `outline-none`，聚焦只靠 `has-[…:focus-visible]:ring-3`（而 `solid-glass.css:944-948` 又把容器的 ring 清掉，所以等於沒有焦點樣子） | 內部欄位 `:focus-visible` 時整個群組畫 2px 字色外框、offset 2px（#1279，Q19 留下的那條）：外框寫在 layer 外，offset 在 base layer（跟第 1 條同一套）；選擇器 `[data-slot="input-group"]:has([data-slot="input-group-control"]:focus-visible)`，不讓 Prettier 排版 | `registry-edits.test.ts`（覆寫檔含這段、vendor 原文仍是 `outline-none` 配 `ring-3`）、`focus-outline.test.ts`、`guard/`（群組聚焦） |
| 16 | `components/ui/input-group.tsx`（包裝層） | `components/ui/input-group.tsx:57-61` addon 的 `onClick` 只找 `input` 來 focus | 連 `textarea` 一起找：輸入框（`composer.tsx`）用的是 `InputGroupTextarea`，vendor 原樣點 addon 空白處拿不到焦點。vendor 把 `onClick` 寫在 `{...props}` 前面，所以包裝層傳的整段取代它；呼叫端自己傳的照舊蓋掉包裝層 | `components/ui/input-group.test.tsx`（textarea、vendor 原文只找 input、input 照舊、點按鈕不搶焦點、呼叫端蓋掉） |
| 17 | overrides | `components/ui/button.tsx:18` destructive 的 `hover:bg-destructive/20`、`dark:hover:bg-destructive/30` | hover 底改成亮 /17、暗 /26：vendor 原值下 `text-destructive` 疊在 hover 底上過不了 4.5。Q5 碰到 Q8 以 Q5 為準（PM 定 (c)，取格 2：第一個達標的值）。寫在 layer 外、包在 `@media (hover: hover)`（跟 Tailwind 的 `hover:` 同條件）；alpha 跟 tokengen 共用 `destructive-tint.mjs`，覆寫檔寫字面值、測試比對兩邊一致 | `solid-glass-overrides.test.ts`（cascade 的贏家、vendor 原文）、`tokens-contrast.test.ts`、`guard/`（destructive hover，拿掉這段會紅） |

另外**新增**、不是改 SG 的：`index.css` 的 `--radius-row`（SG 的 3xl 減 4px）與 nexus 獨有的顏色 token（`stage`、`chip*`、`brand-soft`、`warning`、`info`、`card-hairline`，Q11 留到第 ⑥ 步），以及 `tokens.generated.css` 的 `--primary-hover`／`--primary-active`（亮 `:12-13`、暗 `:35-36`，主按鈕 hover 與按下的底色，SG 沒有這兩格）。圓角階梯照 SG，不重綁。

讀 CSS 的護欄量的是疊出來的結果，不是某一個檔：`src/styles/css-cascade.ts` 從 `index.css` 照 import 順序展開，算過 layer 的優先序（Q2）。

## 同步

1. solid-glass：clone 另放，停在要同步的 commit，記下 `git rev-parse HEAD`，對過 `git ls-remote https://github.com/deeplethe/solid-glass`。工作區要乾淨。
2. shadcn：`npm pack shadcn@<version>`，tarball 的 sha512 要等於 SG `package-lock.json` 裡 `node_modules/shadcn` 的 `integrity`。
3. 換版本的話，先改 `manifest.json` 的 `sources`（commit；version 與 integrity）。
4. `node apps/web/src/vendor/solid-glass/sync.mjs --solid-glass <clone> --shadcn <tgz>`：照清單複製（子目錄自動建），重寫 `manifest.json` 的 sha256。
5. 跑 web 全套測試、`pnpm --filter @nexus/web build`（`check-built-css` 量建置出來的 CSS）與 `test:guard`。

`node apps/web/src/vendor/solid-glass/sync.mjs --solid-glass <clone> --shadcn <tgz> --check` 只比對不寫入：vendor 的檔與 `manifest.json` 的 sha256 都要等於上游原樣，有差異就列出並以 1 退出。clone 不在記的 commit 上、工作區不乾淨、tarball 的 integrity 或版本對不上、少給一個上游，直接以 2 退出。
