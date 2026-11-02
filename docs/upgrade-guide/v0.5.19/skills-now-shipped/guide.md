---
kind: upgrade-guide
description: skills 已經是出貨列，照 v0.5.19 文件 insert 的 id skills 會讓整份清單載入失敗、serve 起不來。
---

# skills 已經出貨，不用再 insert

## 變更

v0.5.19 的技能外掛 `@nexus/plugin-skills` 不在出貨清單上，要在 patch 檔裡 `insert` 才掛（v0.5.19 `README.md`「要自己疊一層 patch 才掛」）。
新版（PR #1174）把它放進出貨清單，id 是 `skills`，來源預設是工作區的 `/skills/`；工作區沒有 `skills/` 時一個字都不加進提示詞。

照舊的 insert 留著，結果看 id 與來源：

- **id 也寫 `skills`**：整份清單載入失敗，serve 與 CLI 都起不來：
  `…/cordis.yml 的第 4 列與第 54 列都寫了 id "skills"。id 是「哪一次掛載」的答案，…`。
  更麻煩的是順序：新版第一次啟動**先**把 home 的 `cordis.patch.yml` 遷進變更紀錄、原檔改名，**再**載入清單失敗；`plugin` 指令又不能移除列。
- **換了 id 或沒寫 id、來源也是 `/skills/`**（沒給 `config` 就是這樣）：serve 起得來，那一列掛不上，啟動輸出
  `警告：1 列沒有掛上…skill 來源 "/skills/" 與 include:skills 登記的 "/skills/" 是同一個目錄…`，變更紀錄多一筆 `failed`。技能照樣由出貨那一列提供。
- **換了 id、來源不同**：兩列都掛上，兩個來源都生效。

受影響的：在 home 的 `cordis.patch.yml` 或 `--patch` 覆寫檔裡 insert 過 `@nexus/plugin-skills` 的主機。

## 遷移

1. **升級前**，從 home 的 `cordis.patch.yml` 與每一份 `--patch` 覆寫檔拿掉 insert skills 的那一列。原本給的 `sources` 改成對出貨那一列寫
   `- id: skills` 加 `config: { sources: [...] }`（整份替換，要保留 `/skills/` 就一起列）。拿掉之後檔案空了的話寫 `[]`（空檔或只有註解會讓啟動失敗）。
2. 已經升上來、卡在同 id 那則訊息的：停 serve，把剛建的 `<home>/plugin-journal.jsonl` 移開（例如改名成 `plugin-journal.jsonl.bad-<時間>`，
   不要刪，跟 [`docs/operations.md`〈升級與回滾〉](../../../operations.md#升級與回滾)一樣「移開、不刪」），把 `cordis.patch.yml.migrated-<時間>`
   改回 `cordis.patch.yml`，照第 1 步改好，再起新版讓它重新遷移。只在紀錄檔裡**只有**那次遷移的筆時這樣做；之後已經用 `plugin` 改過的，照
   [`docs/operations.md`〈後台改清單〉](../../../operations.md#後台改清單plugin-寫入口與變更紀錄)的「紀錄壞了怎麼救」。
3. 確認：serve 起得來、沒有提到 skills 的警告，`--dump-config` 裡 `@nexus/plugin-skills` 只出現一次。
