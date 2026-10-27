#!/usr/bin/env bash
# 暫時的量測腳本（#2090 第 1 條），開 PR 前拿掉。
set -uo pipefail
BI=$RUNNER_TEMP/bi; mkdir -p "$BI"
TSC=$GITHUB_WORKSPACE/node_modules/.bin/tsc
now() { date +%s.%N; }
report() { printf '%-48s %6.1fs exit=%s\n' "$1" "$(echo "$3 - $2" | bc)" "$4" | tee -a "$RUNNER_TEMP/bench.txt"; }
inc() { # $@ = pnpm filters
  pnpm "$@" --workspace-concurrency=4 exec sh -c "\"$TSC\" --noEmit --incremental --tsBuildInfoFile \"$BI/\$(basename \"\$PWD\").tsbuildinfo\""
}
run() { local name=$1; shift; local t0; t0=$(now); "$@" >/dev/null 2>&1; local rc=$?; report "$name" "$t0" "$(now)" "$rc"; }
probe_core() { echo 'export const __benchProbe = 1;' >> packages/nexus-core/src/index.ts; }
probe_leaf() { echo 'export const __benchProbe = 1;' >> packages/nexus-plugin-todo/src/index.ts; }
reset() { git checkout -- packages; }
ALL=(-r)

nproc | sed 's/^/nproc=/' | tee -a "$RUNNER_TEMP/bench.txt"
run 'a 冷跑 pnpm -r run typecheck（今天的指令）' pnpm -r run typecheck
run 'a2 冷跑＋寫 buildinfo（全部）' inc "${ALL[@]}"
run 'b 暖、沒有異動（全部）' inc "${ALL[@]}"
probe_leaf
run 'c 暖、改 plugin-todo（只查它與下游）' inc --filter '...@nexus/plugin-todo'
reset
run 'c 復原後（全部）' inc "${ALL[@]}"
probe_core
run 'd 暖、改 core（只查它與下游 34 個）' inc --filter '...@nexus/core'
run 'd2 暖、改 core 之後再跑一次全部' inc "${ALL[@]}"
reset
run 'd 復原後（全部）' inc "${ALL[@]}"
probe_core
run 'd3 冷、改 core（只查它與下游、無快取）' pnpm --filter '...@nexus/core' --workspace-concurrency=4 run typecheck
reset

# e：快取落後 develop 幾個 commit。先在舊 commit 上寫 buildinfo，再回到 HEAD 跑。
HEAD_SHA=$(git rev-parse HEAD)
for n in 5 20; do
  rm -rf "$BI"; mkdir -p "$BI"
  base=$(git rev-parse "origin/develop~$n")
  git checkout -q "$base" && pnpm install --frozen-lockfile >/dev/null 2>&1
  inc "${ALL[@]}" >/dev/null 2>&1
  git checkout -q "$HEAD_SHA" && pnpm install --frozen-lockfile >/dev/null 2>&1
  changed=$(git diff --name-only "$base" "$HEAD_SHA" | wc -l)
  run "e 快取落後 develop $n 個 commit（$changed 檔異動，全部）" inc "${ALL[@]}"
done
du -sh "$BI" | sed 's/^/buildinfo 大小 /' | tee -a "$RUNNER_TEMP/bench.txt"
cat "$RUNNER_TEMP/bench.txt" >> "$GITHUB_STEP_SUMMARY"
