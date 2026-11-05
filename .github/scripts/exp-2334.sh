#!/usr/bin/env bash
# 實驗用，不合併（#2334 D）：同一個 commit 交替跑「四件事並行」與「typecheck 單獨」，每次先還原同一份型別檢查快取。
set -uo pipefail
L="$RUNNER_TEMP/light"
snap="$RUNNER_TEMP/tc-snap.tar"
restore() {
  rm -rf packages/*/node_modules/.cache/nexus-typecheck apps/*/node_modules/.cache/nexus-typecheck
  tar -xf "$snap"
}
now() { echo "${EPOCHREALTIME/[.,]/}"; }
secs() { local us=$(($(now) - $1)); printf '%d.%02d' $((us / 1000000)) $((us % 1000000 / 10000)); }
run() {
  local name="$1" t; shift; t=$(now)
  "$@" > "$RUNNER_TEMP/x-$name.log" 2>&1; echo $? > "$RUNNER_TEMP/x-$name.rc"; secs "$t" > "$RUNNER_TEMP/x-$name.sec"
}
per_dir() {
  local tsv="$1" rc=0 d; shift
  mapfile -t dirs < <(cut -f1 "$tsv" | sort -u)
  for d in "${dirs[@]}"; do
    mapfile -t files < <(awk -F'\t' -v d="$d" '$1 == d { print $2 }' "$tsv")
    (cd "$d" && pnpm exec "$@" "${files[@]}") || rc=1
  done
  return $rc
}
typecheck() {
  mapfile -t filters < "$L/typecheck.txt"
  local t; t=$(now)
  pnpm "${filters[@]}" --silent exec pwd | wc -l
  echo "計時：affected 的 pnpm exec pwd $(secs "$t")"
  .github/scripts/typecheck.sh "${filters[@]}"
}
format() { mapfile -t files < "$L/format.txt"; pnpm exec prettier --check --ignore-unknown "${files[@]}"; }
lint() { local t; t=$(now); pnpm run build:lib; echo "計時：build:lib $(secs "$t")"; per_dir "$L/lint.tsv" eslint --no-warn-ignored; }
tests() { per_dir "$L/tests.tsv" vitest run; }
report() {
  local label="$1" name; shift
  for name in "$@"; do
    echo "結果｜$label｜$name｜$(cat "$RUNNER_TEMP/x-$name.sec")｜rc=$(cat "$RUNNER_TEMP/x-$name.rc")"
    grep '計時：' "$RUNNER_TEMP/x-$name.log" | sed "s/^/結果｜$label｜$name｜/"
  done
}
nproc
for i in 1 2 3; do
  restore; t=$(now)
  run typecheck typecheck & run format format & run lint lint & run tests tests & wait
  echo "結果｜並行$i｜牆鐘｜$(secs "$t")"; report "並行$i" typecheck format lint tests
  restore
  run typecheck typecheck
  report "單獨$i" typecheck
done
