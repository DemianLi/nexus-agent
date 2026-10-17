# vendor 的 solid-glass

上游的檔原樣複製進來，不經 npm 相依。格式照 repo 根目錄的 [`vendor/README.md`](../../../../../vendor/README.md)：清單記上游 commit，本地修改逐條登記，保留上游的 MIT `LICENSE`。

為什麼改用 solid-glass、為什麼原樣 vendor：demian 2026-10-17 拍板，見 [#1468 的拍板留言](https://github.com/DemianLi/nexus-agent/issues/1468#issuecomment-6221153573)（Q1、Q4、Q9、Q18）。整條線的進度在地圖 [#1497](https://github.com/DemianLi/nexus-agent/issues/1497)；這個目錄由第 ① 步 [#1498](https://github.com/DemianLi/nexus-agent/issues/1498) 建立。

## 清單

上游 https://github.com/deeplethe/solid-glass ，commit 只記在 [`manifest.json`](manifest.json) 的 `commit`（目前是 `387c3c2`，2026-10-15）。上游 main 之後還有 commit，照拍板不跟。

| 這裡 | 上游 | 從哪一步開始 |
|---|---|---|
| `solid-glass.css` | `src/solid-glass.css` | ① |
| `LICENSE` | `LICENSE` | ① |

每個檔的 sha256 記在 `manifest.json`，`vendor.test.ts` 比對：手改這裡的檔，CI 就紅，不用拉上游。

之後加進來的，照地圖的順序：23 個 registry 元件（`src/components/ui/`）跟 `@base-ui/react` 一起在第 ③ 步，12 個 AI 元件與 AgentWorkspace 在第 ④ 步。每一步用到哪些檔就加哪些，同一支 `sync.mjs`、同一個 commit 同步（Q18 的「一起同步」）。`.tsx` 要的護欄放行（`cn` 從哪裡 import 之類）跟著第一個 `.tsx` 落地。

## 本地修改

規則（Q9）：**這裡的檔不動。** 要改的寫在 `index.css` 裡排在它後面的檔，CSS 靠後載入就蓋得掉，所以同步只是換檔再比對，不必把修改重新套上去。修改分在兩處（第 ② 步 [#1512](https://github.com/DemianLi/nexus-agent/issues/1512) 建立），**同步上游時兩處都要看**：

- `src/styles/solid-glass.overrides.css`：機制類的規則與字型（Q6、Q8）。規則除了焦點 offset 那段刻意留在 base layer，都在 layer 外。
- `src/styles/tokens.generated.css`：顏色。由 `tokengen/generate.mjs` 產生，不要手改；SG 的輸入值抄在 `tokengen/sg-input.mjs`（`sg-input.test.ts` 逐值比對這個檔）。

| # | 在哪 | 蓋掉 `solid-glass.css` 的哪裡 | 改成什麼、為什麼 | 釘住的測試 |
|---|---|---|---|---|
| 1 | overrides | `:851-860` 的焦點 ring（`--focus-line` 3px） | 焦點只有一種樣子：2px 字色外框、offset 2px，外框寫在 layer 外（Q5、#1279）；registry 的 `focus-visible:ring-*` 在 `:focus-visible` 上清成透明 | `focus-outline.test.ts`、`guard/`（焦點） |
| 2 | overrides | `:857-860` 兩個選擇器把 ring 帶回來（specificity 比 #1 高） | 照抄同一段選擇器、後載入，把 `--tw-ring-shadow` 壓回透明（D′）；不讓 Prettier 排版，才能一字不差 | `focus-ring-suppression.test.ts`（列舉 vendor 裡每一條帶回 ring 的宣告，條數釘死） |
| 3 | overrides | `:343` 起的 `body`（`@layer base`）、`:233` 的 `.dark { color-scheme }` | body 的底色、字色與亮暗兩個 `color-scheme` 寫在 layer 外：沒有 layer 的樣式永遠贏過有 layer 的，頁面被包進帶 reset 的外殼時暗色不會變成黑底深字（Q8 保留的機制）。SG 的漸層背景照用 | `solid-glass-overrides.test.ts` |
| 4 | overrides | `:1319-1322` reduced-motion 下進場 `animation: none` | 改成 150ms 的淡入（Q5：reduced-motion 保留 ≤ 150ms 的透明度動畫）；持續動畫照 SG 停掉 | `reduced-motion.test.ts`、`scripts/check-built-css.mjs` |
| 5 | overrides | （不是改 SG）| nexus 自己的高亮：`[data-located]`（chip 底色、3xl 圓角）、`[data-revealed]`（字色外框） | `solid-glass-overrides.test.ts`、`focus-outline.test.ts` |
| 6 | tokens.generated | `:root`／`.dark` 的顏色 | 達不到 Q5 門檻的 SG 顏色照 demian 選的 B 案重解（色相照 SG、彩度收進 sRGB、解明度）；達標的原樣。`--ring`／`--sidebar-ring`＝字色（Q5）。亮暗一定成對 | `tokens-contrast.test.ts`、`tokens-generated.test.ts`、`sg-input.test.ts` |
| 7 | tokens.generated | `:1171-1196` reduced-transparency 的不透明面 | 產物覆寫了 `--card`，排在 SG 後面的無條件值會蓋掉這段的不透明值，所以照 SG 原值重寫被覆寫的那幾個 | `tokens-generated.test.ts` |
| 8 | tokens.generated | `:1166-1170` `data-glass="opaque"` 只拿掉 blur | 面換成跟 reduced-transparency 同一組不透明值（含 `--primary-solid: 100%`）；暗色用 `.dark[data-glass]` 高一階 specificity（Q7） | `tokens-generated.test.ts`、`tokens-contrast.test.ts`（三種狀態都量） |
| 9 | overrides 的 `@theme inline` | `:41-42` 字型堆疊 | Geist／Geist Mono 打包 latin，Geist Mono 另加方框字元的 symbols2（`styles/fonts.css`），中文接 Noto Sans TC，系統後備 PingFang TC、Microsoft JhengHei，拿掉 SG 的三個簡體字型；等寬在 Noto Sans TC 前先接 Consolas、Menlo；等寬尾端保留三個 emoji 字型（#979）（Q6；symbols2 與系統等寬是 demian 2026-10-17 在 PM session 拍板，#1512） | `font-stack.test.ts` |
| 10 | overrides | `:37` `@custom-variant dark (&:is(.dark *))` | 重新定義成 `&:is(.dark, .dark *)`：`<html class="dark">` 本身也要吃到 `dark:`（Q8 保留的機制） | `scripts/check-built-css.mjs`（量產物） |
| 11 | tokens.generated | `:1171-1196` 不透明面的亮色 `--sidebar`（`oklch(0.985 0 0)`） | 不透明的退路（#7、#8 兩處共用同一組值）也要過 Q5 的表面亮暗差 ≤ 0.05：SG 原值不過，用跟半透明那套同一支 `solveLightSurface` 只調亮色，重解成 `oklch(0.952 0 0)`；其餘不透明值已達標、照 SG（#1512，PM 定 (b)） | `tokens-generated.test.ts`（具名覆寫）、`tokens-contrast.test.ts`、`guard/`（不透明的面） |
| 12 | overrides | `:944-948` 欄位聚焦的邊框、`:951-955` 一次性密碼格的內側線（都是 `--focus-line` 灰） | 照抄同一段選擇器、後載入，顏色換回 `var(--ring)`（字色）：Q5 焦點用字色，Q8 碰到 Q5 涵蓋的項目以 Q5 為準（#1512，PM 定 (b)）；不讓 Prettier 排版 | `focus-line-suppression.test.ts`（列舉每一條用到 `--focus-line` 的宣告）、`guard/`（欄位聚焦後的邊框） |
| 13 | overrides＋`components/surface.tsx` | `:378-391` `.bg-card` 歸零 border、加上浮起的整組陰影 | 貼在輸入框上方的卡片（`Surface tone="docked"`）要平的：`.bg-card[data-surface='docked']` 給 1px `--glass-edge` 邊、`box-shadow: none`，底色與 blur 照 SG。`data-surface` 是 `Surface` 只給 docked 掛的屬性，專給這條用（Q8 機制類保留，#1512，PM 定） | `solid-glass-overrides.test.ts`、`guard/`（docked 的邊與陰影） |

另外**新增**、不是改 SG 的：`index.css` 的 `--radius-row`（SG 的 3xl 減 4px）與 nexus 獨有的顏色 token（`stage`、`chip*`、`brand-soft`、`warning`、`info`、`card-hairline`，Q11 留到第 ⑥ 步）。圓角階梯照 SG，不重綁。

讀 CSS 的護欄量的是疊出來的結果，不是某一個檔：`src/styles/css-cascade.ts` 從 `index.css` 照 import 順序展開，算過 layer 的優先序（Q2）。

## 同步

1. 上游 clone 另放，停在要同步的 commit，記下 `git rev-parse HEAD`，對過 `git ls-remote https://github.com/deeplethe/solid-glass`。工作區要乾淨。
2. 換版本的話，先改 `manifest.json` 的 `commit`。
3. `node apps/web/src/vendor/solid-glass/sync.mjs <上游 clone>`：照清單複製，重寫 `manifest.json` 的 sha256。
4. 跑 web 全套測試與 `pnpm --filter @nexus/web build`（`check-built-css` 量建置出來的 CSS）。

`node apps/web/src/vendor/solid-glass/sync.mjs <上游 clone> --check` 只比對不寫入：vendor 的檔與 `manifest.json` 的 sha256 都要等於上游原樣，有差異就列出並以 1 退出。clone 不在 `manifest.json` 記的 commit 上、或工作區不乾淨，直接以 2 退出。
