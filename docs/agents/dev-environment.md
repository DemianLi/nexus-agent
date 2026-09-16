# 開發環境的已知坑

在 Claude Code on the web 的遠端容器裡開發這個 repo 時會撞到的東西，以及繞法。

**這份文件裡的腳本不會被任何東西自動執行。** 它改的是 Claude Code 自己的 hook，不是 nexus-agent 的程式碼，所以刻意不放成可執行檔——要用的人自己貼進 environment 設定。

## Stop hook 把合併後的分支誤報成「未推送」

### 症狀

PR squash merge 之後，Stop hook 擋下來說：

```
There are 1 unpushed commit(s) on branch 'claude/<name>'. Please push these changes to the remote repository.
```

但什麼都沒有未推送：

```console
$ git log --oneline origin/develop..HEAD | wc -l
0
$ git status --short     # 乾淨
```

**而且它的指示做不到**——它要你推的分支在遠端已經不存在：

```console
$ git push --force-with-lease=<branch>:<old-sha> origin HEAD:<branch>
 ! [rejected]        HEAD -> <branch> (stale info)
$ git fetch origin <branch>
fatal: couldn't find remote ref <branch>
```

### 成因

`~/.claude/stop-hook-git-check.sh:39-45` 用 `git rev-parse "origin/$branch"` 決定 upstream，而 `rev-parse` **只看本地的 remote-tracking ref**。本 repo 設定為 squash merge ＋ 合併後刪除分支，於是：遠端分支沒了、本地 ref 停在 squash 前、agent 照規矩把分支重設到更新後的 `develop`。HEAD 不是那個舊 ref 的後代，`$upstream..HEAD`（`:116`）就數出一個不存在的未推送 commit。

**清理的陷阱**：`git fetch --prune origin <branch>` **清不掉**那個 ref——refspec 限制了 prune 的範圍。要用 `git remote prune origin`，或不帶 refspec 的 `git fetch --prune`。

### 當場繞過

```sh
git remote prune origin
```

### 讓它不再發生

上游已回報：[anthropics/claude-code#94771](https://github.com/anthropics/claude-code/issues/94771)。

在上游修好之前，把下面這段貼進 **environment 的 setup script**（在 Claude Code 網頁端設定，不在容器裡也不在這個 repo 裡）。hook 由 `/opt/env-runner/environment-manager` 在每次 session 啟動時重新佈署，所以直接改檔案活不過一次 session。

```bash
#!/bin/bash
# 讓 stop-hook-git-check.sh 不要把「遠端分支已刪的過期 tracking ref」報成未推送。
# 冪等；任何一步對不上就安靜跳過（它跑在啟動路徑上，絕不能讓啟動失敗）。
set -uo pipefail

TARGET="${HOME}/.claude/stop-hook-git-check.sh"
MARKER='# STALE-TRACKING-REF-SUPPRESSOR'
ANCHOR='  if [[ "$unpushed" -gt 0 ]]; then'

[[ -f "$TARGET" ]] || { echo "patch-stop-hook: 找不到 $TARGET，跳過"; exit 0; }
grep -qF "$MARKER" "$TARGET" && { echo "patch-stop-hook: 已套用，跳過"; exit 0; }
[[ "$(grep -cF "$ANCHOR" "$TARGET")" == "1" ]] || {
  echo "patch-stop-hook: 定位點不唯一或不存在（上游可能改過），跳過"; exit 0; }

BACKUP="$(mktemp)"
cp "$TARGET" "$BACKUP"

python3 - "$TARGET" "$MARKER" <<'PY'
import sys, pathlib
target, marker = pathlib.Path(sys.argv[1]), sys.argv[2]
s = target.read_text()
anchor = '  if [[ "$unpushed" -gt 0 ]]; then'
block = f'''  {marker}
  # 每個 HEAD 上的 commit 都已經在「某個」遠端 ref 上時，把計數歸零。
  # $upstream 是 git rev-parse 解出來的，只看本地 tracking ref —— 遠端分支刪掉
  # 之後它還是解析得出來（squash merge ＋ 合併後刪除分支）。
  # 'HEAD --not --remotes' 回答的才是這個 gate 真正在意的問題：有沒有工作只存在
  # 於本地。不需要網路，離線也對。寫成抑制器而非替換，其他情境行為與訊息不變。
  if [[ "$unpushed" -gt 0 ]] &&
     [[ "$(git rev-list HEAD --not --remotes --count 2>/dev/null)" == "0" ]]; then
    unpushed=0
  fi

{anchor}'''
assert s.count(anchor) == 1
target.write_text(s.replace(anchor, block, 1))
PY

if bash -n "$TARGET" 2>/dev/null; then
  echo "patch-stop-hook: 已套用"
  rm -f "$BACKUP"
else
  cp "$BACKUP" "$TARGET"; rm -f "$BACKUP"
  echo "patch-stop-hook: 套用後語法檢查失敗，已還原原檔" >&2
fi

exit 0
```

**為什麼用 `HEAD --not --remotes`**：這個 primitive 那個檔案裡已經在用了（`:79`，簽章檢查那段），所以這不是引進新概念，是讓同一個檔案裡的兩個檢查一致。不需要網路呼叫，離線也對。

**唯一改變的情境**是「commit 在別的遠端 ref 上但不在 `$upstream` 上」——那種 commit 不會因為容器消失而遺失，而防止遺失正是這個 gate 存在的理由。

**考慮過但否決的做法**：用 `git ls-remote --exit-code --heads origin "$branch"` 先確認遠端分支還在。否決理由是每次 Stop 都多一次網路往返，而且離線或 proxy 不通時會 fail closed。

### 驗證過的四個情境

2026-09-16 在活的容器上實跑：

| 情境 | 修正前 | 修正後 |
| --- | --- | --- |
| squash merge 後的過期 tracking ref（本 bug） | `exit 2` ＋ 假訊息 | **`exit 0`** |
| 真的有未推送的 commit | `exit 2` | `exit 2` |
| 未提交的改動 | `exit 2` | `exit 2` |
| 乾淨、ref 已 prune | `exit 0` | `exit 0` |

重現本 bug 的合成方式（不必真的跑一輪 PR）：

```console
$ git update-ref refs/remotes/origin/<branch> <squash 前的 sha>
$ echo '{"stop_hook_active":false}' | bash ~/.claude/stop-hook-git-check.sh; echo "exit=$?"
```
