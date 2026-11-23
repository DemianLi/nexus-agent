#!/usr/bin/env bash
# engineer 與 verifier 開、收 worktree 的唯一入口（#3151）。
#
# 用法：
#   worktree.sh new <分支> <卡號> [eng|ver]
#     從本機的 origin/develop 開 `--no-track` 的分支，位置固定在主 checkout 同層的
#     `worktrees/<角色>-<卡號>`（角色預設 eng；卡號可帶一段小寫尾碼，例如 3180-b），
#     接著 `pnpm install --offline` 與 `pnpm run build:lib`。不 fetch：開分支前的
#     `git fetch origin develop` 由呼叫的人先做一次。
#   worktree.sh done [--open-ok] <路徑>
#     核對全部成立才移除：登記在 `git worktree list`、不是主 checkout、沒有未提交或未追蹤的內容、
#     HEAD 等於某張 PR 最後一個 commit 而且那張 PR 已合（--open-ok：verifier 用，PR 還開著也算）。
#     移除用 `git worktree remove`，不加 force、不遞迴刪除；移除後目錄還在就報錯並列出留下的檔。
#     路徑沒登記、目錄卻在（半刪）時同樣只報錯、列檔，不刪。
#
# 環境變數（測試用）：GH、PNPM 換掉 `gh`、`pnpm`。
set -u

GH="${GH:-gh}"
PNPM="${PNPM:-pnpm}"
LIST_LIMIT=40

die() { echo "error: $*" >&2; exit 1; }
usage() { sed -n '2,/^set -u/p' "$0" | sed '$d; s/^# \{0,1\}//'; }

main_checkout() { git worktree list --porcelain | awk '/^worktree /{print substr($0, 10); exit}'; }

registered() {
	git worktree list --porcelain | awk -v p="$1" '/^worktree /{ if (substr($0, 10) == p) found = 1 } END { exit !found }'
}

list_leftovers() {
	local dir="$1" total
	total=$(find "$dir" -mindepth 1 -not -type d 2>/dev/null | wc -l | tr -d ' ')
	echo "留在 ${dir} 的檔共 ${total} 個（最多列 $LIST_LIMIT 個）：" >&2
	find "$dir" -mindepth 1 -not -type d 2>/dev/null | head -n "$LIST_LIMIT" >&2
	echo "不遞迴刪除：這個目錄交給 operator 決定怎麼刪。" >&2
}

cmd_new() {
	[ $# -ge 2 ] && [ $# -le 3 ] || { usage >&2; exit 2; }
	local branch="$1" card="$2" role="${3:-eng}"
	case "${role}" in eng|ver) ;; *) die "角色只能是 eng 或 ver：${role}" ;; esac
	[[ "${card}" =~ ^[0-9]+(-[a-z0-9]+)?$ ]] || die "卡號要是數字，可帶一段小寫尾碼：${card}"
	git check-ref-format --branch "${branch}" >/dev/null 2>&1 || die "分支名不合法：${branch}"
	git rev-parse --verify --quiet refs/remotes/origin/develop >/dev/null || die "本機沒有 origin/develop：先跑一次 git fetch origin develop"
	local main root path
	main=$(main_checkout)
	[ -n "${main}" ] || die "不在 git repo 裡"
	root="$(dirname "$main")/worktrees"
	path="$root/$role-$card"
	[ ! -e "${path}" ] || die "已經有 ${path}：先處理它，不覆蓋"
	mkdir -p "$root"
	git worktree add --no-track -b "${branch}" "${path}" origin/develop || die "git worktree add 失敗"
	if git -C "$path" rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then
		die "${path} 有 upstream：push 會打到 develop，開錯了"
	fi
	(cd "${path}" && "$PNPM" install --offline) || die "pnpm install --offline 失敗：跑不起來交給 CI；worktree 已開在 ${path}"
	(cd "${path}" && "$PNPM" run build:lib) || die "pnpm run build:lib 失敗；worktree 已開在 ${path}"
	echo "${path}"
}

pr_lines() {
	local branch="$1" sha="$2"
	local jq='.[] | "\(.number) \(.state) \(.headRefOid)"'
	if [ -n "$branch" ]; then
		"$GH" pr list --head "$branch" --state all --json number,state,headRefOid --jq "$jq"
	else
		"$GH" pr list --search "$sha" --state all --json number,state,headRefOid --jq "$jq"
	fi
}

cmd_done() {
	local open_ok=0
	if [ "${1:-}" = "--open-ok" ]; then open_ok=1; shift; fi
	[ $# -eq 1 ] || { usage >&2; exit 2; }
	local path="${1%/}" main
	[ ! -d "$path" ] || path=$(cd "$path" && pwd -P)
	main=$(main_checkout)
	[ -n "${main}" ] || die "不在 git repo 裡"
	[ "${path}" != "${main}" ] || die "這是主 checkout，不是 worktree"
	if ! registered "$path"; then
		if [ -e "$path" ]; then
			echo "error: ${path} 沒登記成 worktree，但目錄還在（半刪）" >&2
			list_leftovers "$path"
			exit 1
		fi
		die "${path} 沒登記成 worktree，目錄也不在：沒東西可移除"
	fi
	local dirty
	dirty=$(git -C "${path}" status --porcelain --untracked-files=all) || die "讀不到 ${path} 的狀態"
	if [ -n "$dirty" ]; then
		echo "error: ${path} 有未提交或未追蹤的內容，不移除：" >&2
		echo "$dirty" | head -n "$LIST_LIMIT" >&2
		exit 1
	fi
	local head branch matched=""
	head=$(git -C "${path}" rev-parse HEAD) || die "讀不到 ${path} 的 HEAD"
	branch=$(git -C "$path" symbolic-ref --quiet --short HEAD || true)
	local lines
	lines=$(pr_lines "${branch}" "${head}") || die "查不到 PR（gh 失敗）：不移除"
	local number state oid
	while read -r number state oid; do
		[ "$oid" = "$head" ] || continue
		if [ "$state" = MERGED ] || { [ "$open_ok" = 1 ] && [ "$state" = OPEN ]; }; then matched="$number"; fi
	done <<<"$lines"
	[ -n "${matched}" ] || die "${path} 的 HEAD ${head} 不等於任何符合條件的 PR 的最後一個 commit（要已合；--open-ok 時還開著也行）：不移除"
	git worktree remove "${path}" || die "git worktree remove 失敗：寫在卡上、停下，不加 force"
	if [ -e "$path" ]; then
		echo "error: 登記取消了，但 ${path} 還在（半刪）" >&2
		list_leftovers "$path"
		exit 1
	fi
	echo "已移除 ${path}（PR #${matched}）；分支沒動"
}

case "${1:-}" in
new) shift; cmd_new "$@" ;;
done) shift; cmd_done "$@" ;;
-h|--help) usage ;;
*) usage >&2; exit 2 ;;
esac
