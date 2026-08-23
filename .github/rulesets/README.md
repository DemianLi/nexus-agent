# rulesets

這個目錄裡的 JSON 是 `develop` 與 `main` 分支保護規則的**快照，不是 source of truth**。

線上設定以 GitHub 上的實際 ruleset 為準（Settings → Rules → Rulesets）。修改流程是：**先在 GitHub UI 改，再回頭更新這裡的檔案。** 沒有任何 workflow 會讀取或套用這些 JSON。

## 為什麼不做自動套用

讓檔案成為 source of truth 需要一個有 admin 權限的 token 存在 repo secrets。為了兩個幾乎不會變動的檔案引入一個高權限憑證，風險大於收益。

## 為什麼不做 drift check

GitHub 會自行為 ruleset 增加新的參數欄位。實測（2026-08）線上設定就比這裡的檔案多出 `require_extra_approval_for_unattributed_changes` 與 `required_reviewers` 兩個欄位，都是 GitHub 端新增的預設值，並非有人手動改過設定。自動比對會定期因為 GitHub 改版而假性紅燈，久了就沒人看。

## 目前的規則

兩條分支共通：禁止刪除、禁止 non-fast-forward、必須走 PR、`gate` 為 required status check、`bypass_actors` 為空（含 repo owner 在內無人可繞）。

差別在合併方式與同步要求：

| | `develop` | `main` |
| --- | --- | --- |
| 允許的合併方式 | 僅 squash | 僅 merge commit |
| strict（分支需與 base 同步） | 是 | 否 |

`main` 刻意不開 strict 的原因見 [README.md](../../README.md) 的分支策略段。
