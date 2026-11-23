#!/usr/bin/env bash
# #1386 驗收 ① 的對照數字：上游原樣與我們 vendor 的版本，在「原始碼模式」與「宣告檔模式」下各報幾個錯。
#
# 用法：baseline.sh <上游 cordis clone>（要在 c261dd2c；clone 見 vendor/README.md 的「同步」）
#
# 在 mktemp 的目錄裡複製一份 vendor、自己接 node_modules，不碰工作樹。
# 原始碼模式＝不建 lib/types：exports 的 types 條件找不到檔，tsc 落到 default 的 src/index.ts。
set -euo pipefail

UPSTREAM=${1:?用法：baseline.sh <上游 cordis clone>}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../../../../.." && pwd)
VENDOR=$ROOT/vendor
TSC=$(cd "$VENDOR/cordis" && node -p "require.resolve('typescript/bin/tsc')")
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

echo "upstream $(git -C "$UPSTREAM" rev-parse HEAD)"

mkdir -p "$T/node_modules/@nexus" "$T/node_modules/@types" "$T/node_modules/@standard-schema" "$T/consumer"
for pkg in cordis loader; do
  rsync -a --exclude node_modules --exclude lib --exclude tests "$VENDOR/$pkg/" "$T/$pkg/"
done
ln -s "$T/cordis" "$T/node_modules/@nexus/cordis"
ln -s "$T/loader" "$T/node_modules/@nexus/cordis-plugin-loader"
ln -s "$(cd "$VENDOR/cordis/node_modules/cosmokit" && pwd -P)" "$T/node_modules/cosmokit"
ln -s "$(cd "$VENDOR/cordis/node_modules/@standard-schema/spec" && pwd -P)" "$T/node_modules/@standard-schema/spec"
ln -s "$(cd "$VENDOR/cordis/node_modules/@types/node" && pwd -P)" "$T/node_modules/@types/node"

cp "$HERE/consumer.ts" "$T/consumer/consumer.ts"
cp "$HERE/tsconfig.json" "$T/consumer/tsconfig.json"
node -e '
const fs = require("node:fs");
const c = JSON.parse(fs.readFileSync(process.argv[1] + "/tsconfig.json", "utf8"));
c.compilerOptions.allowImportingTsExtensions = true;
fs.writeFileSync(process.argv[1] + "/tsconfig.src.json", JSON.stringify(c));
fs.writeFileSync(process.argv[1] + "/tsconfig.base.json", JSON.stringify({
  extends: process.argv[2] + "/tsconfig.base.json",
  compilerOptions: { types: ["node"] },
  include: ["consumer.ts"],
}));
' "$T/consumer" "$ROOT"

# 跑一次 tsc，印錯誤總數與 TS2578（未使用的 @ts-expect-error＝型別退化成 any）的數量。
measure() {
  local label=$1 dir=$2 project=$3 out
  out=$(cd "$dir" && node "$TSC" -p "$project" 2>&1 || true)
  printf '%-34s errors=%-4s TS2578=%s\n' "$label" \
    "$(grep -c 'error TS' <<<"$out" || true)" "$(grep -c 'error TS2578' <<<"$out" || true)"
}

build() {
  rm -rf "$T/cordis/lib" "$T/loader/lib"
  measure "  建 cordis 宣告檔" "$T/cordis" tsconfig.json
  measure "  建 loader 宣告檔" "$T/loader" tsconfig.json
}

echo "== 上游原樣（packages/core/src 不改）"
rm -rf "$T/cordis/src" && cp -R "$UPSTREAM/packages/core/src" "$T/cordis/src"
rm -rf "$T/cordis/lib" "$T/loader/lib"
measure "原始碼模式、NodeNext 消費者" "$T/consumer" tsconfig.src.json
build
measure "宣告檔模式、NodeNext 消費者" "$T/consumer" tsconfig.json

echo "== vendor（本地修改第 1 條）"
rm -rf "$T/cordis/src" && cp -R "$VENDOR/cordis/src" "$T/cordis/src"
rm -rf "$T/cordis/lib" "$T/loader/lib"
measure "原始碼模式、NodeNext 消費者" "$T/consumer" tsconfig.src.json
measure "原始碼模式、nexus 的 base 設定" "$T/consumer" tsconfig.base.json
build
measure "宣告檔模式、NodeNext 消費者" "$T/consumer" tsconfig.json
measure "宣告檔模式、nexus 的 base 設定" "$T/consumer" tsconfig.base.json
