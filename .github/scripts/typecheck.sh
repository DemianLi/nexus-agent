#!/usr/bin/env bash
# 型別檢查：參數是 pnpm 的篩選。全跑那一層的 typecheck job 與輕的模式的 plan 共用。
# web 以外的套件交給一次 `tsc -b`：scripts/gen-typecheck-projects.ts 依 package.json 的相依產生 project references，
# 每個套件只查一次，下游讀上游輸出的宣告檔。web 單獨 `tsc --noEmit`，兩邊同時跑。
# 產生的設定、buildinfo 與宣告檔都在各套件的 node_modules/.cache/nexus-typecheck，快取的存取見 ci.yml。
set -euo pipefail
cd "$(dirname "$0")/../.."
tsc="$PWD/node_modules/.bin/tsc"
cache=node_modules/.cache/nexus-typecheck

pnpm exec tsx scripts/gen-typecheck-projects.ts
dirs=$(pnpm "$@" --silent exec pwd)

projects=()
web=false
while IFS= read -r dir; do
  [ -n "$dir" ] || continue
  if [ "$dir" = "$PWD/apps/web" ]; then
    web=true
  elif [ -f "$dir/$cache/tsconfig.json" ]; then
    projects+=("$dir/$cache/tsconfig.json")
  else
    echo "$dir 沒有產生的型別檢查設定" >&2
    exit 1
  fi
done <<< "$dirs"

rc=0
build=
if [ ${#projects[@]} -gt 0 ]; then
  "$tsc" -b "${projects[@]}" &
  build=$!
fi
if $web; then
  # 跟 tsc -b 同時跑，輸出先收起來，免得兩邊的錯誤訊息交錯。
  log=$(mktemp)
  (cd apps/web && "$tsc" --noEmit --incremental --tsBuildInfoFile "$cache/tsconfig.tsbuildinfo") > "$log" 2>&1 || rc=1
fi
if [ -n "$build" ]; then
  wait "$build" || rc=1
fi
if $web; then
  cat "$log"
  rm -f "$log"
fi
exit $rc
