#!/usr/bin/env bash
# 裝 musl-gcc（musl target 的 C 編譯器，ring 的 C 與組語要用，#2570）。沙箱 spawner 的 action 與預熱排程（warm-musl-debs.yml）共用這一支，
# 裝法只有一份：套件站一時連不到不該讓整輪紅（#2702）。
#
# .deb 存在快取目錄：命中就離線 dpkg 裝；沒命中，或裝壞了，退回 apt，最多三次，每次 120 秒封頂、次間睡 10 秒，整步最壞 3×120+2×10＝380 秒。
#
# 環境變數：
#   CACHE_HIT            '快取命中'（actions/cache 的 cache-hit 輸出）；不是 'true' 就直接走 apt
#   ALLOW_GCC_FALLBACK   'true' 才允許三次都失敗時退回 image 內建的 gcc；其餘一律 exit 1。發版與預熱排程傳 'false'
#   MUSL_DEBS            .deb 目錄，預設 ~/.cache/musl-debs
set -eo pipefail

debs="${MUSL_DEBS:-$HOME/.cache/musl-debs}"
fallback=
mkdir -p "$debs/partial"
if [ "$CACHE_HIT" = "true" ] && sudo dpkg -i "$debs"/*.deb && command -v musl-gcc > /dev/null; then
  echo "從快取裝好 musl-gcc"
else
  [ "$CACHE_HIT" = "true" ] && echo "::warning::快取的 .deb 裝不起來，退回 apt"
  for attempt in 1 2 3; do
    if sudo timeout 120 bash -c 'apt-get update && apt-get -o Dir::Cache::archives="$1" -o Acquire::Retries=2 install -y --no-install-recommends musl-tools' _ "$debs"; then
      break
    fi
    if [ "$attempt" = 3 ]; then
      # 最後的退路（#2702）：不下載任何東西，用 image 內建的 gcc 編 ring 的 C 與組語。標頭是 glibc 的，不是 musl 的；
      # ring 的 C 只用 memcpy 這類少數函式，連結由 rustup 附的 musl 與自帶的 crt 完成，產物仍是靜態連結的 musl。
      # 發版（cache: 'false'）不准走這條：出貨的二進位只用 musl-gcc 編。
      if [ "$ALLOW_GCC_FALLBACK" = "true" ] && command -v gcc > /dev/null; then
        echo "::warning::apt 三次都沒裝成 musl-tools，退回 image 內建的 gcc 編 ring 的 C（標頭是 glibc 的，不是 musl 的）；這輪不代表 musl-gcc 的編法"
        fallback=gcc
        break
      fi
      echo "::error::apt 三次都沒裝成 musl-tools"
      exit 1
    fi
    sleep 10
  done
fi
# apt 以 root 在目錄裡留下 lock 與 partial/：快取的 post 步驟用 runner 身分打包，讀不到就存不起來。只留 .deb，擁有者換回來。
# 沒有 .deb（走了 gcc 退路）就整個目錄刪掉：空目錄也會被存成這把鍵的快取，之後命中空快取、鍵又不會再被覆寫，同一個 image 版本就永遠沒有保護。
sudo rm -rf "$debs/lock" "$debs/partial"
if compgen -G "$debs/*.deb" > /dev/null; then
  sudo chown -R "$(id -u):$(id -g)" "$debs"
else
  sudo rm -rf "$debs"
fi
echo "CC_$(uname -m)_unknown_linux_musl=${fallback:-musl-gcc}" >> "$GITHUB_ENV"
