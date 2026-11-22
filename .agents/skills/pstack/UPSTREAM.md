# pstack 的 nexus 副本

這個目錄是 [pstack](https://github.com/cursor/plugins/tree/main/pstack) 給 Claude Code 用的版本，只取 nexus 用得到的部分，並改寫成本 repo 的規則。本 repo 的 `AGENTS.md` 與 `docs/standards.md` 跟這裡衝突時，以 repo 為準。

## 來源

| 項目 | 值 |
| --- | --- |
| 上游 repo | `https://github.com/cursor/plugins` |
| 上游路徑 | `harness/pstack/claude-code/`（由上游 `pstack/` 產生的 Claude Code 版） |
| 基準 SHA | `d42aff08aa58965d2735c4ead61a9af82b89d0d0` |
| 授權 | MIT，Copyright (c) 2026 Lauren Tan，全文見同目錄的 [`LICENSE`](LICENSE) |

本機的唯讀 clone 放在 `references/pstack`（`references/` 不進版控）：

```bash
git clone --depth=1 --filter=blob:none --sparse https://github.com/cursor/plugins.git references/pstack
```

```bash
git -C references/pstack sparse-checkout set pstack harness/pstack
```

clone 屬於下載，照 repo 的規則先回報再做。核對基準用 `git -C references/pstack rev-parse HEAD`，跟上表的 SHA 比字串。

## 檔案

**原樣複製**，跟上游逐位元組相同：`LICENSE`、`skills/benchmark-checklist/`、`skills/correct/`、`skills/why/`，以及 24 個 `skills/principle-*` 中除了 `principle-type-system-discipline` 以外的 23 個。

**改寫過的**：

| 檔案 | 改了什麼 |
| --- | --- |
| `skills/poteto-mode/SKILL.md` | 加上 nexus 的四個角色（operator、PM、engineer、verifier）；Non-negotiables 拿掉沒複製的 skill 與 Cursor 專屬工具，PR 改走 `mattpocock-skills:pr` 與 gate 的標題格式；模型改成依角色的表（engineer 用 sonnet／medium，verifier 用 opus／medium，由 hook 強制；Comment Sicko 用 opus）；PM 可以是長駐或有終點的；Autonomy 把 force push、刪分支、合進 `main`、發版、下載列為要停的動作；跟 dsh 做法不同的選擇，符合條件寫 ADR、不符合寫進 PR 的「對照 dsh」；playbook 只留複製進來的七個；engineer 與 verifier 開成 session，`FAIL` 退回同一位 engineer；回覆改用中文 |
| `skills/poteto-mode/worker.md` | 加上 repo 規則優先；worktree 用 `--no-track`、push 寫完整 refspec、禁止 force push；上下文只放進版控的檔；PR 標題與內文照 `AGENTS.md` |
| `playbooks/feature.md`、`playbooks/bug-fix.md` | engineer 自己寫程式，不再把寫程式委派出去，review 的隔離由 verifier 提供；拿掉 arena、interrogate、`/loop`；修 bug 一定要先寫測試 |
| `playbooks/opening-a-pr.md` | 標題、內文、`Refs #N` 照 `AGENTS.md`；拿掉 `/deslop`；不疊 PR；開完 PR 立刻用 `mcp__ccd_pr__set_monitor` 開 Auto-fix，不開 auto-merge；開不成就在 issue 上記一筆、不重試，自己照 babysit 盯 CI |
| `playbooks/babysit.md` | 用 `gh pr update-branch` 同步，衝突由 engineer 自己 merge `develop` 解，新 head 的 SHA 寫在 PR 或卡上、不傳訊息給 PM，由 PM 被叫醒後重開 verifier；拿掉 `watch-pr`、Origin、Bugbot |
| `playbooks/shipping.md` | 改成單張 PR：verifier 判定（第三次 `FAIL` 就停，每次 `FAIL` 都算；停下時拿掉 `ready-for-agent`、engineer 不封存）、patch-id 規則、`gate` 為 `SKIPPED` 也算綠的條件、`--match-head-commit` 的 squash 合併、合併後完整一輪的重跑與撤回（純 `git revert` 的撤回 PR 不需要 verifier；撤回要調高基準才過得了就改成往前修，修復 PR 照常走 verifier、不調基準不改 gate；自己那一輪綠了或撤回之前不開下一張，往前修的 PR 除外）、在 issue 上列出可逆的預設決定與卡做完了沒；`FAIL` 修完與解衝突重判時，寫在 PR 或卡上、不傳訊息給 PM |
| `playbooks/autopilot-full.md` | root 換成 PM、owner 換成 engineer；一張卡一位 verifier，PM 直接開、被 app 拒先用備案再改提案卡；verifier 判定前移除自己的 worktree；engineer 在 code-ready 停下、結果寫在 PR 或卡上、收尾第一行帶 PR 與 SHA、不傳訊息給 PM，PM 被叫醒後核對再開 verifier 並轉告判定；修 `FAIL` 的 commit 一律重開 verifier；判定只連結不複製；判定貼上後封存 verifier，合併後那一輪綠了就拿掉 `ready-for-agent`、結卡、封存 engineer（撤回不算結束，同一位 engineer 修好重開；往前修的修復 PR 合併後那一輪綠了才算）；拿掉 cloud agent、`/loop`、ketchup、show-me-your-work、force push |
| `playbooks/worktree-cleanup.md` | 基準固定 `origin/develop`；腳本路徑寫成 repo 裡的完整路徑；拿掉模擬器與 Cursor 的清理；不刪分支；第 5 步移除到一半的殘留，符合條件（PM 派的、卡已結、合併後綠、沒人用、可重建）就直接刪那一個路徑 |
| `scripts/worktree-audit.sh` | 對話紀錄改讀 `~/.claude/projects/<slug>*/`，slug 規則改成 Claude Code 的（非英數字元換成 `-`），每個 worktree 自己的專案資料夾一起掃 |
| `skills/no-comments/SKILL.md`、`agents/comment-sicko.md` | 基準改成 `origin/develop`；保留清單補上回歸釘、量測值、內部不變量；`TODO(#N)` 刪；模型看得到的文字不歸它管；md 正文的事實宣稱要核對；新的或契約改了的 export 要有契約 doc comment；dsh 對照符合 ADR 條件的寫成 ADR，其餘刪；刪掉的每一條列進 PR 內文；Comment Sicko 改由 `general-purpose` 子代理讀這份檔來扮演，拿掉開場台詞 |
| `skills/tdd/SKILL.md` | 每個 bug fix 都要先有會紅的測試，不再允許「測試不划算就跳過」；重現不了就寫在 issue 上停下，不傳訊息給 PM |
| `skills/architect/SKILL.md` | 有爭議的設計不跑 arena，改成做可逆的選擇並記錄 |
| `skills/principle-type-system-discipline/SKILL.md` | 指向 `typescript-best-practices` 的那一句改成照 repo 的 tsconfig 與 lint |
| `docs/harness/claude-code.md` | `<pstack>` 指到本目錄；`poteto-agent`、`comment-sicko` 改成 `general-purpose` 加讀檔；拿掉 `setup-pstack` 與 `pstack-models` 規則；路徑表改成本 repo 的；對話紀錄 slug 規則修正 |

**沒複製的**：其餘 skill（arena、swarm、interrogate、unslop、technical-writing、show-me-your-work、ketchup、figure-it-out、statechart、verification 系列等）、其他 15 個 playbook、`agents/poteto-agent.md`、`scripts/watch-pr/` 與 `scripts/bootstrap.ts`（依賴 bun）、`references/bugbot-triage.md`。要用時讀 `references/pstack` 的原檔，並在這張表補一列。

## 跟上游同步

上游有更新、要換基準 SHA 時：

1. 回報下載後，在 `references/pstack` 取新的 SHA。
2. 對**原樣複製**的檔，直接用新版覆蓋。
3. 對**改寫過的**檔，先看上游兩個 SHA 之間的差異：`git -C references/pstack diff <舊SHA> <新SHA> -- harness/pstack/claude-code/<路徑>`，再手動把差異合進這裡，保住上表列的改寫。
4. 更新本檔的基準 SHA 與檔案表。
