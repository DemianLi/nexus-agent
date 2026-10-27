#!/usr/bin/env bash
# 型別檢查：參數是 pnpm 的篩選。全跑那一層的 typecheck job 與輕的模式的 plan 共用。
# 不照套件的相依順序跑（`--no-sort`）：各套件經 paths 讀別套件的原始碼，不等別人先跑完。
# buildinfo 寫進各套件的 node_modules/.cache，快取的存取見 ci.yml。
set -euo pipefail
exec pnpm "$@" --no-sort run typecheck --incremental --tsBuildInfoFile node_modules/.cache/nexus-typecheck.tsbuildinfo
