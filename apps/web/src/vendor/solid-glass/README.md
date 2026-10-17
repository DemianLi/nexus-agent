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

目前沒有。

規則（Q9）：**這裡的檔不動。** 要改的寫在 `index.css` 裡排在它後面、layer 外的覆寫檔（第 ② 步建立），每一條覆寫都登記在這一節：改了什麼、為什麼、哪條測試釘住。CSS 靠後載入就蓋得掉，所以同步只是換檔再比對，不必把修改重新套上去。

讀 CSS 的護欄量的是疊出來的結果，不是某一個檔：`src/styles/css-cascade.ts` 從 `index.css` 照 import 順序展開，算過 layer 的優先序（Q2）。

## 同步

1. 上游 clone 另放，停在要同步的 commit，記下 `git rev-parse HEAD`，對過 `git ls-remote https://github.com/deeplethe/solid-glass`。工作區要乾淨。
2. 換版本的話，先改 `manifest.json` 的 `commit`。
3. `node apps/web/src/vendor/solid-glass/sync.mjs <上游 clone>`：照清單複製，重寫 `manifest.json` 的 sha256。
4. 跑 web 全套測試與 `pnpm --filter @nexus/web build`（`check-built-css` 量建置出來的 CSS）。

`node apps/web/src/vendor/solid-glass/sync.mjs <上游 clone> --check` 只比對不寫入：vendor 的檔與 `manifest.json` 的 sha256 都要等於上游原樣，有差異就列出並以 1 退出。clone 不在 `manifest.json` 記的 commit 上、或工作區不乾淨，直接以 2 退出。
