# 由 PM、engineer、verifier 自動開發到合進 develop

需求在 `ready-for-agent` 之前由人和 agent 用 `grill`、`grill-with-docs`、`to-spec`／`to-tickets` 釐清；之後全自動。PM 是長駐的 session，只負責派工、追進度、升級，不讀程式碼、不在合併路徑上。每張卡配一位 sonnet engineer 和一個 worktree，照 pstack 的 playbook 開發。PM 另開一位 opus verifier，只給它 issue 和 PR：verifier 審兩軸、重跑 Evidence、對護欄做突變。verifier `PASS` 加上 `gate` 綠，就由 engineer 自己 squash 合進 `develop`；合併後那一輪紅了，重跑一次還是紅，就自動撤回（撤回要調高只降不升的基準才過得了時，改成往前修，不調基準、不改 gate）。`main` 與發版仍由人來。人不在事前核可，改成在卡上事後導正。舊流程每一步都在等人放行，產出和協作效率都被卡住；把人移出 `develop` 的合併路徑，是靠「審查的人沒寫過這段程式碼」和「合進 `develop` 用撤回 PR 就能退」這兩件事撐住。執行細節見 [`docs/agents/collab-mode.md`](../agents/collab-mode.md)。

## Considered Options

- **維持 PM 審查、demian 點名才合**：審查與放行都集中在兩個人身上，並行數上不去。
- **engineer 自己審自己**：沒有獨立的判定，Evidence 只是作者自己說的。
- **verifier 也用 sonnet**：省成本，但判定的人和寫的人用同一個模型，偏誤一致。試跑後再看退回輪數要不要調。

## Consequences

- 規則必須寫在進版控的檔裡，而且要逐步機械化：沒機械化的規則，agent 跳過它時什麼都不會失敗。
- 目錄歸屬與「轉述不是授權」拿掉，改成一張卡一個 worktree，加上 `develop` 的 strict 同步。
