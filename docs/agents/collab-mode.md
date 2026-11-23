# 協作模式

需求由人和 agent 一起釐清，開成卡之後由 agent 全自動開發到合進 `develop`；合進 `main` 與發版仍然由人來。為什麼選這套見 [ADR 0001](../adr/0001-pm-engineer-verifier-collab-mode.md)。

## 流程

```text
grill（討論）
  → grill-with-docs（ADR、詞彙表）
  → 功能卡：to-spec（只寫要什麼、為什麼、測試接縫）
    機械卡：to-tickets
  → 標 ready-for-agent
  → PM 派工 → engineer 開發、開 PR → verifier 判定 → engineer 合進 develop
```

`ready-for-agent` 之前每一步都要人回答；之後不等人，只有 [poteto-mode](../../.agents/skills/pstack/skills/poteto-mode/SKILL.md)〈Autonomy〉列的動作會停下來。

- **卡的正文是唯一的規格。** 標 `ready-for-agent` 之前，把留言裡還要做的併進正文；沒併進去的，engineer 不做。
- **正文寫到程式碼現況的地方，要對 `origin/develop` 核過，附 `path:line` 與 SHA**，不從舊留言或記憶抄。前提跟程式碼不合時，engineer 照程式碼做，把差異列成可逆的預設。

## 角色

operator（demian）、PM、engineer、verifier 的職責與模型見 [poteto-mode](../../.agents/skills/pstack/skills/poteto-mode/SKILL.md)〈Nexus roles〉與〈Subagents〉。PM 照 [Autopilot-full](../../.agents/skills/pstack/skills/poteto-mode/playbooks/autopilot-full.md) 跑佇列，engineer 照 Feature 或 Bug fix 開發、照 [Shipping](../../.agents/skills/pstack/skills/poteto-mode/playbooks/shipping.md) 合併。

pstack 不走 Skill 工具：照 [Claude Code 對照](../../.agents/skills/pstack/docs/harness/claude-code.md)直接讀 `SKILL.md`。副本的來源與改寫見 [UPSTREAM.md](../../.agents/skills/pstack/UPSTREAM.md)。

## 開場說明

PM 由 operator 開在**主 checkout**，開場整段貼：

```text
Read .agents/skills/pstack/skills/poteto-mode/SKILL.md and docs/agents/collab-mode.md before anything else.
你是 PM。照 .agents/skills/pstack/skills/poteto-mode/playbooks/autopilot-full.md 跑 ready-for-agent 佇列。
同時進行的 engineer 上限：<N>。
每張卡各開一個獨立 engineer session，每次要判定時各開一個獨立 verifier session，被叫醒時直接開。
```

engineer 由 PM 開，一張卡一個 session、一個 worktree：

```text
Read <主 checkout>/.agents/skills/pstack/skills/poteto-mode/worker.md before anything else.
再讀 .agents/skills/pstack/skills/poteto-mode/SKILL.md 與 docs/agents/collab-mode.md。
你是 engineer，負責 #<issue>。照 .agents/skills/pstack/skills/poteto-mode/playbooks/autopilot-full.md 第 2 步做到合併。
不傳訊息給 PM：結果寫在 PR 或卡上，收尾第一行接在 `AGENTS.md` 的前綴之後帶 PR 號碼與完整 head SHA（code-ready 時 `不可封存：PR #<號碼> code-ready <SHA>`；合併、合併後那一輪綠了、Shipping 第 5 步的回報寫在卡上之後才寫 `可封存：PR #<號碼> 已合 <SHA>`）。不讀不寫 app 給的共用 notes 目錄。
下載只有開分支前一次 `git fetch origin develop`；其餘下載先寫在卡上、停下等 operator 核可（worker.md 與〈下載〉）。
暫存的寫入、覆寫、刪除只在你自己的 scratchpad，不寫 `/tmp`；`git worktree remove` 不加 `--force`／`-f`；不 npx，用 `pnpm exec` 跑已安裝的。
開子代理時，把上面暫存、`--force`、下載、npx 這幾條原文寫進它的 prompt。
```

verifier 由 PM 開，只給 issue 與 PR，不給 engineer 的對話：

```text
Read <主 checkout>/.agents/skills/pstack/skills/poteto-mode/worker.md before anything else.
再讀 .agents/skills/pstack/skills/poteto-mode/SKILL.md（〈Nexus roles〉的 Verifier）與 docs/agents/collab-mode.md。
你是 verifier，判定 #<issue> 的 PR #<pr>。照 .agents/skills/pstack/skills/poteto-mode/playbooks/autopilot-full.md 第 4 步與 shipping.md 第 1 步，在 PR 上貼 PASS、PASS+NOTES 或 FAIL。
不傳訊息給 PM：判定貼在 PR 上，收尾第一行接在 `AGENTS.md` 的前綴之後帶判定與 PR 號碼（`可封存：PR #<號碼> PASS`）。不讀不寫 app 給的共用 notes 目錄。
下載只有開分支前一次 `git fetch origin develop`（verifier 不 fetch）；其餘下載先寫在卡上、停下等 operator 核可（worker.md 與〈下載〉）。
暫存的寫入、覆寫、刪除只在你自己的 scratchpad，不寫 `/tmp`；`git worktree remove` 不加 `--force`／`-f`；不 npx，用 `pnpm exec` 跑已安裝的。
開子代理時，把上面暫存、`--force`、下載、npx 這幾條原文寫進它的 prompt。
```

`<主 checkout>` 換成主 checkout 的絕對路徑：worker.md 要求第一行是絕對路徑，而每個 worktree 的路徑都不同。

- PM 直接開 engineer 與 verifier，不先問 operator（operator 在開場一次授權）。`name` 用 `eng-<issue>`、`ver-<pr>`，`model` 與 `effort` 照 [SKILL.md](../../.agents/skills/pstack/skills/poteto-mode/SKILL.md)〈Subagents〉的角色表。開 session 不帶 `cwd`、`host`，`use_worktree: false`，子 session 因此從 PM 所在的主 checkout 起跑；`PreToolUse` hook 擋下 `eng-`／`ver-` 開頭但參數不合（`model`、`effort`、`cwd`、`host`、`use_worktree`）、title 是 engineer／verifier 卻沒給 `name`、用 fork 或 cloud 開的，prompt 沒有「不讀不寫共用 notes 目錄」、下載規則、暫存與 `--force` 與 npx 與「規則原文傳給子代理」那幾句的也擋（重送提案卡、沒有 prompt 時不查），出錯就放行。
- **開 session 的回合，要不要成功跟那一回合的來源有關，不是保證。** 2026-11-21～22 四個 session（PM 三個、顧問一個，`user_asked`、不帶 `cwd`／`host`）的紀錄：

  | 回合 | operator 最後一句來自 | 結果 |
  | --- | --- | --- |
  | 子 session 停下、app 接續 | 桌面 app | 成功 6；被拒 2（auto mode 分類器 1、app「不是使用者本人的話」1） |
  | 子 session 停下、app 接續 | iOS（Remote Control） | 成功 0；被拒 2 |
  | 背景工作叫醒 | 桌面 app | 成功 0；被拒 4（其中 1 次是 Remote Control） |
  | operator 說話 | iOS | 開得成 |

  所以 operator 用桌面 app 時，engineer 停下、app 叫醒 PM 的回合通常開得成（code-ready 開 verifier、結卡後開下一位 engineer、FAIL 後開新 verifier），不能當成一定成功；用 Remote Control 時不要指望，背景工作叫醒的回合實測被拒（上表那 4 次），也不指望。engineer 帶著背景工作停下算不算這一類，沒有紀錄。app 實際的判準不明，上表只是相關。判定後合併那一段只用訊息把判定轉給 engineer，不開 session；自動接續時傳訊息給已開好的 session，在 iOS 的情況下成功過。沒測過：子 session 傳了訊息的回合是否一定開不了、平行、連續接續的上限。
- **備案是事前做的。** operator 用 Remote Control 時，PM 在 operator 說話的回合就預開待命的 session：數量夠一張卡走完（含一次重判）並加上下一張，之後用訊息叫醒。待命的不算同時進行的 engineer，前一張收掉才叫醒下一位。備案的 verifier 一位只判一次，重判要另一位沒看過這張 PR 的。備案也不行才改成提案卡，收尾框不另放「開始」按鈕，並用一句話說是 app 擋下的。
- 自動模式回「no verdict」且附了 hook 產生的輸入時：照那份輸入單獨重送一次；再被擋就停、回報原文，不改用別的做法繞過。
- engineer 與 verifier 都開成 session，不開成 subagent。app 自己建 worktree 會取分支名、加前綴，跟 `<type>/<kebab-case>` 不合，所以子 session 不用 app 的 worktree，自己照 worker.md 開，之後只在那個 worktree 裡改。
- engineer 推出 code-ready 的 head 之後，把結果寫在 PR 或卡上，收尾第一行接在 `AGENTS.md` 的前綴之後帶 PR 號碼與完整 head SHA，然後結束這一輪，不自己合併，也不傳訊息給 PM。PM 被叫醒後核對 PR 與 SHA 再開 verifier；PM 仍用訊息把 verifier 的判定轉給 engineer，engineer 收到 `PASS` 或 `PASS+NOTES` 才進 Shipping 第 2 步，收到 `FAIL` 就照理由修。修完 `FAIL`、解衝突要重判時，同樣只寫在 PR 或卡上、收尾帶 SHA。
- engineer 帶著背景工作（例如盯 CI）停下也會叫醒 PM。PM 先核對 PR 與 SHA：沒到 code-ready 或還沒判定，就只記錄，不當成做完。
- verifier 開背景子代理（例如 code-review 兩軸）之後，先做完自己的部分（重跑 Evidence、突變護欄、核行號）才結束回合，少停幾次；判定貼上之前，自己移除它開的 worktree。

## worktree 與上下文

- 一張卡一個 worktree，從 `origin/develop` 開、`--no-track`（指令見 [worker.md](../../.agents/skills/pstack/skills/poteto-mode/worker.md)）。卡合併、合併後那一輪綠了，PM 照 [Worktree cleanup](../../.agents/skills/pstack/skills/poteto-mode/playbooks/worktree-cleanup.md) 移除它。移除到一半、目錄還有殘留時：PM 派出去的 session 建的 worktree，卡已結、合併後那一輪綠、沒有人在用，而且剩下的內容都能從 commit 或建置重建（`.DS_Store` 這類系統中繼檔也算），PM 直接刪那一個路徑，刪完確認目錄不在；分支不刪。
- **上下文只放在進版控的檔或共用的記憶目錄。** worktree 是用完即丟的工作台：不建 `.claude/settings.local.json`，`.env` 從主 checkout 讀。
- 兩張卡會寫到同一個檔時，PM 讓它們依序跑，不同時派。
- engineer 與 verifier 的開場第一行讀主 checkout 的檔，`.env` 也從主 checkout 讀，所以 PM 每次派工前先把主 checkout 同步到 `origin/develop`：`git -C <主 checkout> fetch origin develop`，再 `git -C <主 checkout> merge --ff-only FETCH_HEAD`。不用 `pull`，也不用不帶 refspec 的 `fetch`。

## 下載

agent 做的下載都要 operator 核可。常設核可只有一個形狀：`git fetch origin develop`（只這個 remote、這個 ref），用在兩處：engineer **開分支前一次**，分支開了之後不再 fetch；PM 每次派工前同步主 checkout（見上）。

- `pnpm install`、`pnpm deploy` 一律加 `--offline`，跑不起來交給 CI。
- 不用 `git pull`，不用不帶 refspec 的 `git fetch`，不 pip install、不 npx、不 cargo 下載、不用 `gh api` 讀上游 repo；docker 一律 `--pull=never`。
- 其他下載：把指令和用途寫在卡上，停下，等 operator 核可，PM 不能代核。核可後誰跑看形狀：會被下面 hook 擋的形狀（`git pull`、`git remote update`、別的 `git fetch`、沒帶 `--offline` 的 `pnpm install`／`pnpm deploy`）由 operator 在終端自己跑，agent 與 PM 不代跑，也沒有 agent 自己能開的放行路；hook 不擋的形狀（例如解衝突的 `git fetch origin develop`、`worktree-audit.sh`）核可後由原本要跑的 session 跑。
- 「是否在開分支前」script 判不了，只有文件。

`PreToolUse` hook（`.github/scripts/session_hooks.py pre-download`，指令形狀在 `.github/scripts/shell_downloads.py`）對 Bash、Monitor 與 Terminal 面板的 `run_in_terminal` 用同一套判斷，只認 git 與 pnpm 的這幾個形狀：擋 `git pull`、`git remote update`、不是 `git fetch origin develop`（只允許再加 `-q`／`--quiet`）的 `git fetch`（含 `-c remote.*`／`url.*` 改寫的）、沒帶 `--offline` 的 `pnpm install`／`pnpm deploy`。它把指令字串當 shell 語法解析：引號、註解與 heredoc 裡的字串不算指令；`$(…)`、反引號、`<(…)`／`>(…)` 裡（`$(…)` 與反引號也查出現在 `${…}`、算術與會展開的 heredoc 本文裡的；`<(…)`／`>(…)` 在不加引號的 `${…}` 裡查，算術與 heredoc 本文裡 shell 不會執行它所以不查；`${…}` 本身的字串不算指令）、`bash -c`／`bash -lc`／`eval` 的參數，都照樣查；同一條指令裡只要有不帶腳本、讀 stdin 的 shell（`bash`、`sh`、`zsh` 等），這條指令的每個 heredoc 本文都當指令查；`env`、`nice`、`timeout`、`sudo`、`taskpolicy`、`npx`、`corepack`、`rtk` 之類前綴會剝掉。它只看指令字串，環境變數與 marker 檔都不影響結果。`bash -c`、`eval`、餵給 shell 的 heredoc 疊超過 12 層、`$(…)` 巢狀深到遞迴爆掉，都判不了，一律擋。擋不到的：

- 上面以外的下載指令：`pnpm add`／`update`／`dlx`／`fetch`、`npx <套件>` 本身、`pip`、`curl`、`docker pull`、`gh api`、`gh pr checkout`、`git clone`、`git submodule update --remote`、`git lfs`、`git remote prune`。上面那幾條禁令對這些只有文件。`git ls-remote` 只列 ref、不下載物件，不算下載（push 之後核對 `develop` 沒動要用它）。
- 腳本或別的程式裡的下載、指令名來自變數（`$cmd pull`）或 alias、zsh 特有語法（`=git pull`）、`source` 進來的檔。
- 用管線或 here-string 餵給 shell 的指令（`echo git pull | bash`、`bash <<<"git pull"`）。
- 讓 remote 指到別處的寫法，形狀符合就放行：`git -C <別的 repo> fetch origin develop`、`GIT_DIR`／`GIT_CONFIG_*`、`-c include.path=…`、先跑 `git config remote.origin.url …`。
- 上面沒列的包裝指令（`find -exec`、`watch`、`ssh`、`coproc` 之類）。
- 掃描器是手寫的，認得哪些 shell 語法以 `test_session_hooks.py` 的 `CONSTRUCTS` × `PLACES` 與 `BASIC_CONSTRUCTS` × `BASIC_PLACES` 兩張表為準（算術 `$((…))`／`((…))`／`$[…]`、`${…}`、`case`、`function`、子殼、反引號、heredoc、`bash -c`／`bash -`），表外的語法可能漏。兩張表各跳過兩種 shell 結果不一致或不合法的組合：含單引號的語法放進 `bash -c '…'`，以及反引號語法放進反引號（bash 回語法錯，zsh 會跑；hook 照擋）。
- 解析不了的指令，出錯就放行。

**分支開了之後需要本機沒有的物件時，不放寬，逐次核可：**

- `gh pr update-branch` 之後 verifier 要在本機檢出新 head：抓 PR head 的 `git fetch` 會被 hook 擋，`gh pr checkout` 擋不到但同樣要核可；兩者核可後都由 operator 在終端跑；operator 不在電腦前，這張卡就等。
- engineer 解衝突：`git fetch origin develop` 的形狀 hook 放行，所以先申請核可這一條只有文件；核可後由 engineer 自己跑。
- 跑 `worktree-audit.sh`（`:46` 會自己 fetch develop）：hook 看不到腳本裡的指令，跑它之前先申請核可，只有文件；核可後由 PM 跑。

## 指令護欄

同一支 `PreToolUse` hook（`session_hooks.py pre-download`，指令形狀在 `shell_downloads.py`，掃描器與〈下載〉共用）也擋下面三類，只看工具名、不分角色，對 PM、engineer、verifier 一律生效（子代理見下），**沒有放行路**：需要時由 operator 在終端自己跑。hook 出錯就放行。

- **`npx` 與等價指令**：`npx`、`pnpx`、`bunx`、`npm exec`／`npm x`、`pnpm dlx`、`yarn dlx`，包在 `env`、`timeout`、`bash -c` 之類裡面也擋。已安裝的用 `pnpm exec`，沒裝的寫在卡上。
- **`git worktree remove` 帶 `--force` 或 `-f`**（含 `-ff`）：不帶 force 拆不掉，就把原因寫在卡上、停下。
- **對共用暫存區的寫入與刪除**：導向（`>`、`>>`、`&>`、`>|`）的目標，以及 `cp`（目的地）、`mv`（來源與目的地）、`tee`、`rm`、`rmdir`、`mkdir`、`touch` 的路徑，落在 `/tmp`、`/private/tmp`、`/var/tmp`、`/var/folders`（含 `/private` 開頭）底下就擋，`..` 先算掉。例外只有自己 session 的 scratchpad（`/private/tmp/claude-<uid>/<專案>/<session_id>/scratchpad`，`session_id` 用 hook 事件裡的值；事件沒給時，任何 session 的 scratchpad 都放行）；別的 session 的 scratchpad 算共用。

**只防堵一部分**：相對路徑、含變數或指令替換的路徑（`$TMPDIR/x`、`"$(mktemp)"/x`）算不出來，一律放行；腳本或別的程式裡的寫檔（`python`、`node`、`sed -i`、`dd of=`、`find -delete`、`pnpm exec` 之後的子指令）、`cd /tmp` 之後的相對路徑看不到；`mktemp` 不擋。這些只有文件，由開場範本與 worker.md 那幾句規則把關。

兩份開場範本帶這幾句，`start_session` 對這幾句只查有沒有，不判讀前後文（下載那一句另外會擋「不用核可」這類否定說法）。子代理是否吃到 hook 以合併後的實測為準，結果記在卡 #3168。

**為什麼用 hook、不用 sandbox**：Claude Code 的 sandbox 能從作業系統層限制可寫路徑（本機 2.1.330 的程式裡有 `allowWrite`、`denyWrite`，沒實測），補得上上面看不到的腳本寫檔。但它會影響 git、gh、worktree 與測試的行為，而且是 operator 自己的安全設定，agent 不改；開不開由 operator 另外決定。

## 合併與撤回

- 放行條件是 verifier `PASS`（或 `PASS+NOTES`）加 `gate` 綠，由 engineer 自己 squash 合併。同步 `develop` 後 patch-id 沒變就沿用判定；有衝突，engineer 自己解，PM 重開 verifier（[Shipping](../../.agents/skills/pstack/skills/poteto-mode/playbooks/shipping.md) 第 2 步）。
- **`gate` 綠**是最新那一輪的 `gate` 為 `SUCCESS` 或 `SKIPPED`。輕模式下，`plan` 成功、`rust` 為 `false`、其餘 job 全部跳過時 `gate` 不起 job，顯示 `SKIPPED`，ruleset 照樣放行（`.github/workflows/ci.yml` 裡 `gate` 的 `if`）。`SKIPPED` 時再確認 `plan` 是 `SUCCESS`。
- 一張卡最多 `FAIL` 三次：前兩次 `FAIL` 退回同一位 engineer 修（它的 worktree 與分支就是要接續的狀態），第三次 `FAIL` 就停。每一次 `FAIL` 都算，解衝突之後的重判也算，不然解壞了可以一直退回。停下時 PM 標 `needs-info`、拿掉 `ready-for-agent`，在卡上寫明卡在哪，交給 operator；engineer 不封存，留著它的 worktree 等 operator 回覆。
- 修 `FAIL` 理由的 commit，就算只改註解或文件，也一律由 PM 開新的 verifier 判新的 head。
- 判定只記在 PR 上，卡上只放那則留言的連結。
- `gate` 對功能分支 → `develop` 的 PR 只跑跟異動有關的檢查；動到 `.github/workflows|scripts|actions` 的照樣全跑。跑哪些見 `.github/workflows/ci.yml` 檔頭。只改 PR 內文不重跑 gate，例外是 `develop → main` 與清 dsh 對照的 PR（階段 1，見〈對照 dsh〉）：它們的 gate 讀內文，由 `pr-edited.yml` 重跑，改標題也會重跑。
- **合進 `develop` 之後，每個 commit 各跑一輪完整的 CI**（`.github/workflows/post-merge.yml`）。它不擋合併，由合併的 engineer 盯：紅了先只重跑失敗的 job 一次；轉綠、而且同一個 tree 在 PR 上是綠的，就當成偶發，開 backlog 卡或在既有的卡上記一筆；還是紅，分兩條路：
  1. **撤回過得了 gate**：engineer 立刻開撤回 PR 讓 `develop` 先恢復綠，再由同一位 engineer 修好、重新開 PR，照常走 verifier。只含 `git revert` 的撤回 PR 不需要 verifier，gate 綠就合。
  2. **撤回要調高基準才過得了**（在最新 `develop` 上試 `git revert`，基準保留 `develop` 的或改成實際值，`check_ratchets.py --base` 都擋）：改成往前修，不開撤回 PR。同一位 engineer 立刻開修復 PR，只能修這次的紅，這是「不開下一張 PR」的例外；修法可以是修壞掉的地方，也可以是撤掉程式變更、保留已降下來的清理。內文附試撤回被擋的實際輸出。修復 PR 照常要 verifier 與 `gate` 綠，「純 revert 不需要 verifier」不適用。修復 PR 合併後那一輪綠了，原卡才算可以收。修不出來，或 `FAIL` 第三次：標 `needs-info` 交給 operator，engineer 與 worktree 留著。**任何情況都不調高基準、不改 gate 來讓撤回通過。**

  只有被基準擋下的撤回走往前修；因為別的原因衝突的撤回照第 1 條。engineer 確認自己合併 commit 的那一輪是綠的（或已撤回），或往前修的 PR 那一輪是綠的之前，不開下一張 PR（往前修的 PR 除外）。
- 合併後那一輪的「視覺差異」有差時會在 PR 留言，它不讓這一輪變紅、不走撤回；作者開下一張 PR 之前回那則留言：都在打算改的範圍裡就回「畫面變動符合預期」，不是就當成 bug 修（[`apps/web/COMPONENTS.md`](../../apps/web/COMPONENTS.md)〈視覺差異〉）。
- `main` 只收來自 `develop` 的 PR，由人合併、由人發版（[`docs/release.md`](../release.md)）。緊急修補同樣先進 `develop`。
- 分支合併後由 GitHub 自動刪除；突變、實驗分支在對應的卡結了之後可以清。`develop` 與 `main` 之外的分支同樣不 force push。

## 收尾與封存

每個 session 收尾的第一句寫 `可封存：…`、`不可封存：…` 或 `還在等：…`（[AGENTS.md](../../AGENTS.md)〈收尾〉）。三個角色什麼時候算可封存：

| 角色 | 可封存的時候 | 誰封存 |
| --- | --- | --- |
| engineer | 自己合的 PR 合併後那一輪是綠的，Shipping 第 5 步的回報也寫在卡上了。撤回 PR 合了不算：撤回之後它還要修好、重新開 PR；往前修的情況，修復 PR 合併後那一輪也綠了才算 | PM |
| verifier | 判定已經貼在 PR 上，自己開的 worktree 也移除了 | PM |
| PM | 長駐的不封存；有終點的（例如試跑），交出報告之後 | operator |

PM 在 engineer 可封存時依序做三件事：

1. 拿掉卡上的 `ready-for-agent`，免得下一輪再派一次。
2. engineer 的回報說卡上要做的都做完了，就結卡；沒做完，就把剩下的寫在卡上，卡留著。
3. 封存 engineer，再照 [Worktree cleanup](../../.agents/skills/pstack/skills/poteto-mode/playbooks/worktree-cleanup.md) 移除它的 worktree。

## 仍需要人的情況

**需要人**（規則本來就停在這裡）：

- 開場授權，一次。
- 刪 worktree 時有未提交或來源不明的內容、或那不是這位 PM 派出去的 session 建的（後者照 #3151 先列清單）。
- 放寬 gate。
- 第 3 次 `FAIL`，或合併後那一輪紅了、撤回被基準擋下而往前修修不出來。

**實測被拒**：背景工作叫醒的回合（4 次都被拒）；Remote Control 接續的回合（2 次被拒）。

**沒測過**（不是保證能自動，也不是一定要人）：verifier 停下的回合能不能開 session；Remote Control 下 PM 靠預開的待命 session 走完 code-ready → 判定 → 合併；平行；連續接續的上限；解衝突後重判；撤回與往前修；開 session 被拒後接備案；Auto-fix 叫醒；PM 不在主 checkout（只寫進規則，不用 hook 擋，擋了備案就不能用）；子 session 傳了訊息是否一定開不了。

## 導正

engineer 遇到可逆的選擇就先做一版，把預設決定和理由列在卡上（[Shipping](../../.agents/skills/pstack/skills/poteto-mode/playbooks/shipping.md) 第 5 步）。operator 在卡上回覆不同意，就開一張修正卡。

同一類 verifier `FAIL` 理由在兩張不同的卡上各出現一次，PM 就開一張 `correct` 卡，把那條規則改成機械檢查，並更新下面的表。

## 對照 dsh

技術實現以 deepseek-harness 為參照（[AGENTS.md](../../AGENTS.md)〈技術實現標準〉）。**先讀原始碼，不要靠搜尋或記憶回答。** engineer 自己做、自己選：

1. **廣度**：在 `deepseek-harness` 與 `nexus-agent` 兩個圖上用 `search_graph`、`trace_path` 找出相關的符號與呼叫路徑。「沒有」「只有 N 個」這類否定宣稱，配 `check_index_coverage` 再 grep 一次（[codebase-memory.md](codebase-memory.md)）。
2. **深度**：對圖找到的關鍵點讀原始碼，引用寫 `path:line` 並註明 SHA（[引用 deepseek-harness 之前](codebase-memory.md#引用-deepseek-harness-之前)）。說出 dsh 在解決什麼問題、付出什麼代價；講不出來，就還不能選。
3. **選**：至少比一種別的做法，用同一組標準比：正確性、失敗與恢復、效能、維護成本、nexus 的產品需求（企業內部聊天機器人、完全內網、多人共用主機、稽核、幾百人並行開發）、現有基座做不做得到（今天是 deepagents／LangChain JS／LangGraph JS，正遷往 vendor 的 Cordis，見 [`.docs/decisions-2026-10-11.md`](../../.docs/decisions-2026-10-11.md)）。選比較好的那一個；比不出高下就照 dsh，因為它的做法已經在實際使用中驗證過。

比較結果寫在 PR 內文 Summary 的「對照 dsh」；符合下面 ADR 條件的寫成 ADR，「對照 dsh」只放一行連結。不寫進程式碼與註解。operator 事後不同意，走上面的導正。

**清掉程式碼註解裡的 dsh 對照的 PR**（階段 1：dsh 計數下降，而且除了註解與字串內容，程式碼沒變）有三條規則，gate 會讀這張 PR 的內文（`.github/scripts/check_dsh_cleanup.py`）：

1. 帶 dsh 對照的句子預設整句刪。要留或改寫，內文逐句附 nexus 實作的 `path:line`；改寫與新增的每一句，內文都要有一列表格列：第一格是整句，其後的格子要有在 head 上存在的 `path:line`（句子跨到的每一行都不算）。
2. 階段 1 不改段名（註解裡的 `##` 標題與表格的名稱格；含 dsh 的段名不在此限，括號裡的說明不算）。改名留給階段 2，跟所有指向它的地方同一張 PR 改。
3. 刪掉一段或段名之前，找全 repo 指向它的地方；script 列出候選，每一個要在這張 PR 改掉，或在內文有一列（`| path:line | 詞 | 為什麼仍成立 |`，理由放最後一格，命中的詞不算理由）。

本機跑 `python3 .github/scripts/check_dsh_cleanup.py` 印出第 1、3 條要填的列，貼進內文再補。補完內文不用推 commit，gate 會用新內文重判（`pr-edited.yml`）。句子是真是假、理由成不成立，script 判不了，由 verifier 判。

## ADR

三個條件都成立才寫：**難以撤回、少了背景會讓人意外、是真的取捨過的結果**。少一個就不寫，比較留在 PR 內文。

- 全系統的決策放 [`docs/adr/`](../adr/)，單一 app 的放 `apps/<name>/docs/adr/`；`packages/*` 的歸到根目錄。
- 檔名 `NNNN-<kebab-slug>.md`，四位數編號從 `0001` 起依序遞增、不跳號。第一行 `# <標題>`，正文一段話說清楚情境、決定與理由就夠；有價值時才加「Considered Options」與「Consequences」（格式照 `domain-modeling` 的 ADR-FORMAT）。
- `docs/` 只寫現況；決策與取捨寫 ADR；`.docs/` 逐步退場，不再新增。

## 規則與執行者

每條規則由誰擋。「只有文件」的列代表還沒機械化，agent 跳過它時什麼都不會失敗。

| 規則 | 執行者 |
| --- | --- |
| PR 標題的 type、8 到 50 字、至少一個中文字、不是填充句 | gate（`.github/scripts/check_pr.py`） |
| PR 標題是祈使句、說做了什麼 | 只有文件 |
| `main` 只收 `develop` | gate（`.github/actions/plan-checks`） |
| 發版 PR 內文要有〈變更內容〉〈驗證方式〉 | gate（`check_pr.py`） |
| 發版 PR 的〈驗證方式〉只寫實際跑過的 | 只有文件 |
| md 相對連結連得過去 | gate（`check_md_links.py`） |
| 升級指南的格式 | gate（`check_upgrade_guides.py`） |
| 升級指南有沒有寫 | verifier |
| 禁止直接 push、force push、刪 `develop`／`main` | ruleset |
| `develop` 只收 squash、要求 strict；`main` 只收 merge commit | ruleset |
| `gate` 綠才能合 | ruleset |
| 沒有測試的套件不得通過 | 全跑的 CI（`develop → main` 的 gate 與合併後那一輪；功能 PR 的輕模式不擋） |
| 會話日誌格式升版要補版本邊 | 執行期（不補邊，模組載入就拋） |
| home 狀態檔改 schema 要留 v1 夾具 | 測試（`home-state-v1-fixtures.test.ts`）＋ verifier |
| 秘密不進程式碼 | GitHub push protection（已知格式）＋ verifier |
| 不得有預設 key 或 fallback | verifier |
| 修 bug 先寫會紅的測試 | verifier |
| 護欄要證明會紅 | verifier（自己突變一次） |
| 期望值不取自被測物、斷言看得到被宣稱的東西 | verifier |
| Evidence 只寫實際跑過的 | verifier（重跑每一條） |
| 跨套件型別收緊先實測拆不拆得開 | verifier |
| 註解規則 | engineer 跑 no-comments ＋ verifier |
| 清 dsh 對照的 PR：改寫與新增的每句註解，內文有一列整句加存在的 `path:line` | gate（`check_dsh_cleanup.py`） |
| 清 dsh 對照的 PR：那一行撐不撐得起那一句 | verifier |
| 清 dsh 對照的 PR 不改註解裡原有的段名（含 dsh 的除外） | gate（`check_dsh_cleanup.py`） |
| 刪掉一段或段名之前，找全 repo 指向它的地方；每個候選指向改掉或在內文寫為什麼仍成立 | gate（`check_dsh_cleanup.py` 列候選、查內文有一列）＋ verifier（理由對不對、script 找不到的寫法） |
| verifier `PASS` 才合併 | 只有文件（ruleset 不要求 approval） |
| 合併後那一輪紅了：重跑一次，還是紅就撤回；撤回要調高基準才過得了就往前修，不調基準、不改 gate | 只有文件（engineer 照 Shipping 做；基準只降不升仍由 `check_ratchets.py` 擋） |
| 內文寫 `Refs #N`，不寫 Closes | 只有文件 |
| 分支命名 `<type>/<kebab-case>` | 只有文件 |
| 上下文只放進版控的檔或共用記憶目錄 | 只有文件 |
| 開完 PR 開 Auto-fix | 只有文件（工具不在或被權限檢查擋下時，在卡上記一筆，不重試；沒開成，engineer 照 [Babysit](../../.agents/skills/pstack/skills/poteto-mode/playbooks/babysit.md) 自己盯 CI） |
| 收尾第一句寫可封存、不可封存或還在等 | `Stop` hook（`.github/scripts/session_hooks.py`；只看前綴與 `還在等：` 是否一行，擋一次、出錯放行） |
| engineer、verifier 照角色表的 `model`、`effort` 開，不帶 `cwd`、`host`，`use_worktree: false`，開場有「不讀不寫共用 notes 目錄」 | `PreToolUse` hook（同上，看 `name` 的 `eng-`、`ver-` 與 title；沒給 `name`、title 也不像角色的就看不到；沒有 prompt 時不查最後一項） |
| 下載：不 pull、只 `git fetch origin develop`、`pnpm install`／`deploy` 帶 `--offline`，其餘先核可 | `PreToolUse` hook（`session_hooks.py pre-download`，管 Bash、Monitor 與 `run_in_terminal`）擋這幾個指令形狀；git 與 pnpm 以外的下載指令、〈下載〉列的擋不到的寫法、腳本裡的下載、指向別的 remote 的 `git -C`、是否在開分支前、解衝突與跑 `worktree-audit.sh` 前先申請核可：只有文件 |
| engineer、verifier 的開場有下載規則那一句 | `PreToolUse` hook（`session_hooks.py pre-start-session`，沒有 prompt 時不查） |
| 不 npx（含 `npm exec`、`pnpm dlx`），沒有放行路 | `PreToolUse` hook（同 `pre-download`；包在 `env`、`bash -c` 裡也擋，腳本裡的看不到，出錯放行） |
| `git worktree remove` 不加 `--force`／`-f` | `PreToolUse` hook（同上） |
| 共用暫存區（`/tmp`、`/var/folders` 等）不寫不刪，只寫自己 session 的 scratchpad | `PreToolUse` hook（同上，只防堵一部分：導向與 `cp`、`mv`、`tee`、`rm` 等的明確路徑；腳本裡的寫檔、算不出來的路徑只有文件） |
| 開場有暫存、`--force`、npx 與「規則原文傳給每個子代理」那幾句；子代理的 prompt 帶這些規則 | `PreToolUse` hook（`pre-start-session`，只查開場有沒有那幾句）；子代理的 prompt 只有文件（hook 看不到子代理的 prompt） |
| 子 session 不傳訊息給 PM、PM 開在主 checkout | 只有文件（hook 看不到訊息與 PM 所在的資料夾） |
| 開 session 被 app 拒絕時先用備案、再提案卡、不另放開始按鈕 | 只有文件（app 行為，hook 看不到工具結果與收尾框） |
| 備案的 verifier 一位只判一次 | 只有文件 |
| engineer 可封存之後拿掉 `ready-for-agent`、結卡、封存 | 只有文件（PM 照〈收尾與封存〉做） |
| 卡的正文是唯一的規格、寫到的程式碼現況要核過 | verifier（Spec 軸對程式碼核正文的前提） |
| ADR 的位置、檔名、編號與標題行 | gate（`check_adrs.py`） |
| ADR 只在三個條件都成立時寫 | verifier |
| 程式碼裡的 dsh 引用數只降不升 | gate（`check_ratchets.py`，基準在 `.github/ratchets/`） |
| 註解裡的變更敘事用語只降不升 | gate（同上） |

只降不升的計數以目錄為單位，計法見 `check_ratchets.py` 的 `EXTENSIONS`、`EXCLUDED_PREFIXES`、`EXCLUDED_PARTS`、`EXEMPT`、`DSH`、`COMMENT_OR_INLINE_SLASHES`、`NARRATIVE`。基準每個目錄一個檔：`.github/ratchets/<目錄，/ 換成 __>.json`，根目錄是 `_root.json`，沒有檔的目錄算 0。清掉引用的 PR 要在同一張把基準調低：`python3 .github/scripts/check_ratchets.py --write`（只重寫數字變了的檔），平行的 PR 改不同目錄就不會互相衝突。基準不能調高，gate 會拿分歧點那一版的基準比：分歧點有新資料夾就比資料夾，只有舊的 `.github/ratchets.json` 就比它，有 `check_ratchets.py` 卻讀不到基準會報錯，連腳本都沒有（例如 `main` 的舊版本）才跳過並印出原因。
