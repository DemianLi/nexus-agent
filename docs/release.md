# 發版與升級指南

版號怎麼跳、Release 怎麼跑、不相容變更怎麼寫升級指南。[`AGENTS.md`](../AGENTS.md)〈發版〉只留觸發條件，細節在這裡。

## 發版

發版分兩段：

1. **版號 PR。** 版號寫在 repo 裡，不是 CI 裡推出來的（照 dsh `scripts/release/bump.ts`）。先跑
   `pnpm run release:bump <patch|minor|major|x.y.z>`，它把同一個版本寫進根、`apps/*`、`packages/*` 的每一份
   `package.json`（`vendor/*` 跟著上游，不動），再開一張 `chore:` 的版號 PR 合進 `develop`，隨後照常 `develop → main`。
2. **發版。** 到 Actions 頁面執行 **Release** workflow，branch 選 `main` 並輸入版號（`vX.Y.Z`）。輸入值**只拿來核對**
   manifest 裡的版本，不一樣就停。workflow 會建置、用 `pnpm deploy --prod` 打成 `nexus-agent-<版本>-linux-x64.tar.gz`
   （主機要預裝 Node：22.19 以上的 22.x，或 24 以上（23 已 EOL，不支援），以 `package.json` 的 `engines` 為準），在 repo 外解開、用純 `node` 驗過起得來之後，自行打 tag 並建立 GitHub Release，
   把 tar.gz、SBOM（`.cdx.json`）與各自的 `.sha256` 附上（核對方式見 `docs/operations.md`〈核對安裝內容〉）。因為 `workflow_dispatch` 限定在 `main` 執行，「從 develop 發版」在機制上不可能發生。

同一套打包與驗證在每個合進 `develop` 的 commit 與 `develop → main` 的 PR 上都會跑（`ci.yml` 的 `packed-install`），所以 Release 當天不會是第一次試。

版號規則在 1.0 之前從簡：**完成一個 Phase 跳 minor，其餘一律 patch**。1.0 之前 semver 本來就不承諾
相容性，此刻套用完整規則只是徒增判斷成本。

不維護手寫的 CHANGELOG。release notes 由 `--generate-notes` 依 PR 標題自動生成，而 PR 標題規範已經
強制每個變更都有一句可讀的中文描述 —— 那就是 changelog 的原料。

### 升級指南

標題只說做了什麼，不說營運者要改哪個設定。所以**外部看得到的不相容變更，在引入它的那張 PR 裡就寫一份升級指南**，
不留到發版前（照 dsh `AGENTS.md:11` 與 `.agents/skills/dsh-create-upgrade-guide/SKILL.md`）。

- **範圍**：升上來之後，照舊版的做法、設定或檔案，行為會變、會壞或會被拒的：
  - `serve` 與 CLI 的旗標、子命令；
  - `cordis.yml`、`cordis.serve.yml`、`--patch` 覆寫檔、變更紀錄裡的列 id 與 config 鍵、允許的值；
  - home 底下的檔與格式：`sessions/`、`attachments/`、`tool-results/`、`plugin-journal.jsonl`、`thread-organization.json`、
    `browser-session.json`、`.credentials.yaml`、`config-hash-key.json`、`.env`、`serve.lock`；
  - `@nexus/sdk` 給外部插件的面；
  - wire 協定裡 web 以外的客戶端會用到的部分。

  web 與 harness 在同一張 PR 一起改的 wire 變更不必寫：消費者同一張都改到了，同 dsh。純新增、而且不改既有預設行為的
  旗標、鍵、插件也不必寫；出廠就掛上、會改變模型看到的內容或多打模型的插件不算純新增，要寫。
  會話日誌格式的升版紀錄在 `packages/nexus-core/src/session-store.ts` 檔頭，指南只寫讀者要做的事，再連到那裡。
- **位置**：`docs/upgrade-guide/v<版號>/<item>/guide.md`。`<版號>` 是**最近一個 Release 的 tag**，也就是讀者正在跑的
  那一版；`<item>` 是 kebab-case 的變更名。每個 item 目錄只有 `guide.md` 一份。
- **維護**：下一版發出之前，最新的版本目錄描述「那一版到 `develop`」的差異。之後的 PR 再碰同一個面，就在同一張 PR
  改那份指南；變更撤回就刪掉它。發版之後舊目錄凍結，新的不相容變更寫進新 tag 的目錄。一份指南不跨兩版。
- **格式**：frontmatter 恰好 `kind: upgrade-guide` 與一句說「什麼壞了」的 `description`；一個 `#` 標題，之後恰好
  `## 變更`、`## 遷移` 兩段。「變更」寫舊行為、新行為、誰受影響；「遷移」是編號步驟，指名檔、鍵、指令，最後一步寫
  怎麼確認改好了。
- **gate**：`.github/scripts/check_upgrade_guides.py`，跑在 `ci.yml` 的 `plan`（`.github/actions/plan-checks`，純文件 PR 也跑），檢查路徑形狀、
  版本目錄是已存在的 tag、frontmatter 與段落。tag 只驗存在，不驗是不是最近一個：發版之後還寫進
  舊目錄的，gate 擋不住，要靠審查。指南裡的相對連結由 `.github/scripts/check_md_links.py` 驗（同樣跑在 `plan-checks`，
  掃 `README.md`、`AGENTS.md`、`GLOSSARY-MAP.md`、`docs/**`、`.docs/**`、`.github/**`、`.agents/skills/**`、`packages/*` 三層、
  `apps/*` 兩層與兩份本地寫的 vendor README，目標檔要存在、`#片段` 要對到標題）。指到不進版控的 `references/` 的連結不查。

Release 的說明開頭會連到 `docs/upgrade-guide/v<上一個 tag>/`，有這個目錄才連。升級前要備份什麼、怎麼確認、出事怎麼
退回去，見 [`docs/operations.md`](operations.md)〈升級與回滾〉。

和 dsh 不同的兩處：

- **只寫中文一份**（產品需求：本 repo 的文件只有中文）。dsh 每份有英、中兩份加配對紀錄，500 字上限只套英文；本 repo 的文件只有中文，所以只有
  `guide.md`，段落名用 dsh 中文版的「變更」「遷移」，不設字數上限（同 dsh 中文版）。
- **`<版號>` 取 tag，不取根 `package.json`**（現況做不到：manifest 的版號跟 tag 對不上）。dsh 的 `<version>` 是讀者正在跑的那一版，從根 manifest 讀；
  發版順序兩邊一樣，都是版號 commit 先合、再打 tag（dsh `scripts/release/bump.ts` 檔頭）。不同在 manifest 的值：
  本 repo 的 manifest 今天還是 `0.0.0`，跟已發出的 `v0.5.19` 對不上，照抄會把指南全寫進 `v0.0.0/`；而且版號 PR
  合進去到 Release 發出之間，manifest 已經是還沒發的那一版，這段時間合進來的 PR 會把指南放進讀者還沒在跑的目錄。
  撤除條件（兩條都成立）：根 `package.json` 的 `version` 等於最近一個 Release tag 去掉 `v`；而且「發版」寫明版號 PR
  合進去到 Release 發出之間 `develop` 不收其他 PR。
