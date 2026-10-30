#!/bin/sh
# 把 release 執行檔與連進去的程式碼的授權全文打成 bundle，交給 `pnpm run release:pack --spawner`。
# bundle 的形狀與產物裡的檢查在 scripts/release/spawner.ts。
#
# 用法：在這個目錄、`cargo build --release --locked --target "$(uname -m)-unknown-linux-musl"` 之後跑 `./bundle.sh <輸出目錄>`。
# 連進執行檔的 crate 用 `cargo tree -e normal,no-proc-macro` 收，授權檔從 cargo 的 registry 原始碼複製；
# 標準函式庫的版權說明從工具鏈複製；musl 與 LLVM libunwind 的授權原文從 licenses/ 複製。
set -eu

out=$1
target="$(uname -m)-unknown-linux-musl"
licenses="$out/licenses/sandbox-spawner"
rm -rf "$out"
mkdir -p "$out/native" "$licenses/rust-std"
install -m 0755 "target/$target/release/nexus-sandbox-spawner" "$out/native/nexus-sandbox-spawner"
cp "$(rustc --print sysroot)/share/doc/rust/COPYRIGHT-library.html" "$licenses/rust-std/"

# licenses/ 底下的 LLVM 版本要跟工具鏈的一致，換了工具鏈就要換授權原文。
llvm=$(rustc -vV | sed -n 's/^LLVM version: //p')
if [ ! -d "licenses/llvm-libunwind-$llvm" ]; then
  echo "bundle.sh：工具鏈的 LLVM 是 $llvm，licenses/ 沒有 llvm-libunwind-$llvm" >&2
  exit 1
fi
cp -R licenses/. "$licenses/"

cargo tree --locked --target "$target" -e normal,no-proc-macro --prefix none --format '{p}' | sort -u |
  while read -r name version _; do
    [ "$name" = nexus-sandbox-spawner ] && continue
    version=${version#v}
    src=$(ls -d "${CARGO_HOME:-$HOME/.cargo}"/registry/src/*/"$name-$version" | head -n 1)
    dst="$licenses/$name-$version"
    mkdir -p "$dst"
    find "$src" -maxdepth 1 -type f \( -iname 'LICENSE*' -o -iname 'COPYING*' -o -iname 'COPYRIGHT*' -o -iname 'NOTICE*' \) \
      -exec cp {} "$dst/" \;
    if [ -z "$(ls "$dst")" ]; then
      echo "bundle.sh：$name $version 的原始碼裡找不到授權檔" >&2
      exit 1
    fi
  done
