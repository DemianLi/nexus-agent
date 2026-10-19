---
kind: upgrade-guide
description: /sandbox 換成 /permission 權限組合，出廠拿掉全開；用 --sandbox danger-full-access 起動的 serve 會起不來，全開的舊 thread 續接時被收回。
---

# `/sandbox` 換成權限組合，出廠不給全開

## 變更

v0.5.19 在有 `--workspace` 時用 `/sandbox <模式>` 切檔案政策，三格 `read-only`、`workspace-write`、`danger-full-access` 都切得到，
核准政策另外是 `ask`。新版：

- **`/sandbox` 拿掉，換成 `/permission <組名>`**（PR #1196）。組合把檔案政策與核准政策捆在一起，清單上 `permission-presets` 那一列定義。
- **出廠表只有 `read-only`、`workspace-write` 兩組**（PR #1648）。
- **`--sandbox danger-full-access` 的意思變了**：現在是「檔案全開＋核准 `never`」，表裡沒有對得上的那一組就**起不來**：
  `起不來：1 列必掛的沒有掛上。…起始的檔案政策 danger-full-access、核准 never 對不上組合表裡任何一組（有：read-only、workspace-write）。要嘛在表裡補上那一組，要嘛設定 defaultPreset。`
- **v0.5.19 切到全開的 thread，續接時自動收回**（PR #1737）：日誌記的檔案政策比表裡每一組都寬，就收到預設組，server 日誌留一行
  `[權限] thread "…" 日誌記的檔案政策 danger-full-access（核准 ask）比權限表裡每一組都寬，續接時收回預設組 workspace-write（…）`。
  收回之後切不回全開，除非表裡有那一組。

受影響的：用 `--sandbox danger-full-access` 起動 `serve` 的主機，以及有 thread 在 v0.5.19 切到全開過的主機。
操作上習慣打 `/sandbox` 的使用者要改打 `/permission`。

## 遷移

1. 不需要全開：拿掉啟動指令裡的 `--sandbox danger-full-access`。全開的舊 thread 會在續接時收到 `workspace-write`。
2. 要保留 v0.5.19 的「檔案全開、核准照舊會問」：在 `--patch` 覆寫檔（或 `plugin config set permission-presets --file -`）
   把整張表重寫一份，加一組 `sandbox: danger-full-access`、`approval: ask`，並把 `defaultPreset` 設成那一組。`presets` 是整份替換，
   出廠那兩組也要寫出來：

   ```yaml
   - id: permission-presets
     config:
       presets:
         read-only:
           sandbox: read-only
           approval: ask
           description: 只能讀，不能改檔；要改動時先問你。
         workspace-write:
           sandbox: workspace-write
           approval: ask
           description: 可以寫工作區；要超出時先問你。
         full-access-ask:
           sandbox: danger-full-access
           approval: ask
           description: 檔案不圍堵，要人點頭的事照樣先問你。
       defaultPreset: full-access-ask
   ```

   不設 `defaultPreset` 的話，`--sandbox danger-full-access` 要的是核准 `never`，對不上這一組，照樣起不來。
   要的是「全開＋不問」，照 [`docs/operations.md`](../../../operations.md) 的「權限組合」那一節加回 `approval: never` 的那一組。
3. 確認：serve 起得來；全開的舊 thread 續接時沒有 `[權限] … 收回` 那一行（第 2 步），或有（第 1 步）。
