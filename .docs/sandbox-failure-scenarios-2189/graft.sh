# 把映像裡已有的 linux-arm64 原生套件接到目標樹：$1 是目標的 node_modules/.pnpm
set -eu
T=$1; SRC=/opt/nexus/node_modules/.pnpm
for d in "$SRC"/*linux-arm64*; do
  b=$(basename "$d"); name=${b%@*}
  pj=$(find "$d/node_modules" -mindepth 2 -maxdepth 3 -name package.json | head -1)
  [ -n "$pj" ] || { echo "skip $b: no package.json"; continue; }
  src_pkg=$(dirname "$pj")
  case "$src_pkg" in "$d"/node_modules/*) ;; *) echo "bad path $src_pkg"; exit 1;; esac
  rel=${src_pkg#"$d"/}
  for dst in "$T"/"$name"@*; do
    [ -d "$dst" ] || continue
    mkdir -p "$dst/$rel"
    cp -a "$src_pkg/." "$dst/$rel/"
    echo "graft $b -> $(basename "$dst")"
  done
done
