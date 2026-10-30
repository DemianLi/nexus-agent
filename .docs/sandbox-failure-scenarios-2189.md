# 打包後的 serve 上五種沙箱失敗情境的實跑紀錄（#2189）

2026-10-31 實跑。結論：五種情境都跑了。實跑範圍內沒有穿出圍欄、讀到不該讀的內容。沙箱與收尾大多照設計運作，缺口列在〈缺口〉。

## 環境

| 項目 | 值 |
| --- | --- |
| commit | `d429155c` |
| 核心 | `7.0.14-linuxkit`（Docker Desktop 的 Linux VM） |
| `landlockAbi` | 6（`partial: false`），seccomp 指令 77 條 |
| 架構 | **linux-arm64，不是出貨的 x64**（demian 2026-10-31，#1827 D85） |
| Node | v22.23.3，純 `node` 起 `lib/serve.js`，uid 10001 |
| 模型 | 本機假端點，腳本決定工具呼叫，沒有碰金鑰 |
| 容器 | `--network none`、`--security-opt seccomp=unconfined`，路徑放 tmpfs |

**沒驗到：** x64 打包產物的端到端。本機只有模擬的 x64，spawner 裝 seccomp 時回 `Invalid argument`，起不來。CI 的 `sandbox-spawner` job 在 x64 真核心上跑 spawner 整合測試，但不涵蓋這五種情境。

**打包與 Release 的差異：**

- 同一支 `pack()`，spawner 是 arm64 musl 版。
- Mac 的 pnpm store 沒有 linux-arm64 原生套件，這些套件從本機映像 `nexus-demo:b3b55324` 接過來，版本相同。例外是 rollup：用 4.62.5 頂 lockfile 的 4.66.0，只用在建置，不進產物。
- 因為 pnpm 離線補不了，原生套件先接進 node_modules，再由 deploy 帶進產物。
- `verify-packed-install` 全部通過（exit 0），含 spawner 驗證（`git --version` 經 spawner 成功，ABI 6）。映像沒有 `ps`，這次用讀 `/proc` 的替身（`ps-shim.sh`）；沒有替身時只有「查殘留的 pnpm／tsx 行程」這一條紅，真的 `ps` 沒驗到。

## 軟連結

**操作：** `/shared` 放四種連結：指根外檔、指根外目錄、指根內的相對連結、懸空。私有根再放指根外的檔與目錄。一輪內依序呼叫 `read_file`、`write_file`、`edit_file`、`grep`、`glob`。

| 操作 | 實際結果 |
| --- | --- |
| `read_file` 普通檔（對照） | 讀到 |
| `grep` 普通檔（對照） | 找到 |
| `read_file` 根外檔、根外目錄連結（`/shared` 與私有根） | `[containment] 拒絕 read：經符號連結解析之後落在根之外` |
| `grep`、`glob` 明確指連結 | `[containment] 拒絕` |
| `grep`、`glob` 掃 `/shared`、`/` | 不跟連結，機密字串搜不到，清單沒有連結 |
| `write_file` `/shared` 的連結 | 拒絕，backend 唯讀 |
| `write_file` 私有根的檔、目錄連結 | 拒絕，落在可寫根之外 |
| `edit_file` 私有根的連結 | 回「讀到的時候它不存在」，沒寫 |
| `read_file` 懸空連結 | `ENOENT` |
| `read_file` 根內相對連結 | `ELOOP`，連根內的連結也讀不到 |

**事後：** 根外的檔沒變，根外目錄沒長出新檔。

**差異：** 四種工具對根外連結都沒放行。`read_file` 走 `O_NOFOLLOW`，所以根內連結回 `ELOOP`；`grep`、`glob` 掃目錄時靜靜略過連結。使用者看不出兩者的差別，見缺口 1。

## DNS

**操作：** 容器沒有對外網路，用本機假 DNS 當解析器。MCP 宣告與未宣告沙箱各跑一次，解析器有回應與不回應各一次。工具同時呼叫 `dns.lookup` 與 `dns.resolve4`。

| MCP | 解析器 | `lookup` | `resolve4` | 假 DNS 收到 |
| --- | --- | --- | --- | --- |
| 未宣告（對照） | 回應 | 成功，3ms | 成功，1ms | 有 |
| 宣告 | 回應 | `EAI_AGAIN`，3ms | `ECONNREFUSED`，0ms | 0 筆 |
| 未宣告 | 不回應 | `EAI_AGAIN`，4009ms | `ETIMEOUT`，20069ms | 8 筆 |
| 宣告 | 不回應 | `EAI_AGAIN`，1ms | `ECONNREFUSED`，1ms | 0 筆 |

**結論：** 宣告沙箱的 MCP 立刻失敗，不卡到逾時，請求沒有送出去。使用者看到的是 MCP 自己回的錯，錯誤碼不會說是沙箱擋的。

## 死循環

**操作：** 假 MCP 有 `hang`（永不回）與 `spin`（`for(;;)`，事件迴圈卡死）兩種。宣告與未宣告各跑。第一組一輪時鐘設 45 秒，第二組用出廠的 30 分鐘與 MCP 預設 60 秒。

| 情境 | 結果 |
| --- | --- |
| `hang`，到 MCP 60 秒 | 工具回 `TimeoutError`，輪次正常收尾，之後同一個 server 的 `ping` 正常 |
| `spin`，到 MCP 60 秒 | 同上，但 server 一直 100% CPU，之後每次呼叫都卡滿 60 秒才失敗 |
| 一輪時鐘 45 秒到 | 輪次中止，`cause.reason: turn-timeout`，顯示「這一輪被中止了」 |
| 使用者按停止 | 收尾 8～10ms |
| 其他 thread 的 `read_file` | 不受影響，66～106ms |
| 同一個 server 的另一條 thread | `hang` 時不受影響，`spin` 時卡住直到逾時 |
| `SIGTERM` serve | 約 4 秒 exit 0，兩個 MCP 都收掉，連不理 `SIGTERM` 的也收掉 |

宣告與未宣告行為相同。見缺口 2。

## 寫滿磁碟

**操作：** 用小容量 tmpfs 分開掛 home、`thread-roots`、暫存目錄，各自寫滿。另跑一組出廠佈局，home 與 `thread-roots` 在同一個檔案系統。

| 寫滿的位置 | 使用者看到 | 原檔 | 暫存殘留 | `/readyz` | 恢復 |
| --- | --- | --- | --- | --- | --- |
| 只有 `thread-roots` | 工具回 `ENOSPC: no space left on device, write`，輪次正常收尾 | 完好 | 無 | 200 | 釋放後重寫成功 |
| 只有暫存目錄 | 寫檔、`grep`、大檔讀取都成功 | 不受影響 | 無 | 200 | 不需要 |
| 只有 home，既有 thread | 工具與輪次都成功，日誌暫留記憶體，釋放後補寫 | 不受影響 | 無 | 200 | 補寫成功 |
| 只有 home，新 thread | 輪次失敗，顯示 `ENOSPC: no space left on device, write` | 不受影響 | 無 | 200 | 釋放後成功 |
| 出廠佈局，同 thread 與新 thread | 輪次失敗，同上 | 完好 | 無 | 200 | 釋放後重啟可續接 |

**重啟：** 磁碟滿時送 `SIGTERM`，serve 5 秒內結束，日誌印「收尾失敗」，退出碼仍是 0；沒寫進去的那幾筆會消失，重啟後從最後落盤處續接。見缺口 3、4。

## 崩潰後清理

**操作：** `kill -9` serve，當下分別有 `rg`、`git add`、大檔寫入、兩種 MCP 正在跑。

| 當下在跑 | 1 秒後 | 5 秒後 | 重啟後 |
| --- | --- | --- | --- |
| `rg`（經 spawner） | 收掉 | 收掉 | 正常 |
| `git add`（經 spawner） | 收掉 | 收掉 | 正常 |
| 宣告沙箱的 MCP | 收掉 | 收掉 | 重新起一支 |
| 未宣告的 MCP，stdin 關掉就結束 | 收掉 | 收掉 | 重新起一支 |
| 未宣告的 MCP，不理 stdin 結束 | **留下，ppid 變 1** | 留下 | **舊的還在，又多起一支** |
| 大檔寫到一半 | 原子寫入沒完成，目標檔沒有 | 同左 | **`.tmpdir` 與 `.tmp` 留著，`glob` 看得到** |

**其他：** `serve.lock` 與 `session.lock` 檔留著，但重啟正常，約 2.7 秒。續接 thread 時，中斷的工具回「結果沒有落盤、狀態未知」，模型會看到這句，不會假裝成功。見缺口 5、6。

## 缺口

卡都標 backlog，不掛 parent。

1. [#2193](https://github.com/DemianLi/nexus-agent/issues/2193) **根內相對連結讀不到，訊息也看不出原因。** `read_file` 回 `ELOOP`，`grep`、`glob` 靜靜略過。部署方的工作區若有根內連結，使用者只會看到工具失敗或搜不到。
2. [#2194](https://github.com/DemianLi/nexus-agent/issues/2194) **卡死的 stdio MCP 不會被重啟。** `spin` 之後 server 一直佔滿一顆 CPU，同 server 每次呼叫都等滿 60 秒，只有重啟 serve 才恢復。
3. [#2195](https://github.com/DemianLi/nexus-agent/issues/2195) **磁碟滿的錯誤是原始字串。** 使用者看到英文 `ENOSPC`，沒有說是哪裡滿、該找誰。`/readyz` 一直回 200，探針看不出來。
4. [#2196](https://github.com/DemianLi/nexus-agent/issues/2196) **收尾失敗退出碼仍是 0。** 磁碟滿時會話日誌沒寫完，serve 以 0 結束，監控看不出有資料沒落盤。
5. [#2197](https://github.com/DemianLi/nexus-agent/issues/2197) **未宣告的 MCP 若不理 stdin 結束，`kill -9` 後會留下孤兒，重啟再多一支。** 已知 `SIGKILL` 時 exit listener 不跑，這裡量到會隨重啟累積。宣告沙箱的不會。
6. [#2198](https://github.com/DemianLi/nexus-agent/issues/2198) **`kill -9` 留下的 `.tmpdir` 沒有人清。** 重啟不掃，`glob` 列得到，也佔私有根的空間。

另有一項發現已走非公開管道。

## 環境差異

Docker Desktop 的 bind mount 當 `--workspace` 時，`rg` 經 spawner 回 `Permission denied`（`.`），改用 tmpfs 就正常。根因未知，目前只在 Docker Desktop 看到，還沒有在真 Linux 主機上驗，追蹤在 [#2199](https://github.com/DemianLi/nexus-agent/issues/2199)。容器部署常 bind mount 工作區，查清楚之前，部署方上線前要先跑一次 `grep`。

## 轉成整合測試

- **已轉：** DNS。`apps/harness/src/mcp-sandbox.integration.test.ts` 新增宣告與未宣告各一條，用本機假 DNS，毫秒級完成，CI 的 spawner job 已經有跑這個檔。
- **軟連結不轉：** 工具層 32 個測試檔與 spawner 測試已涵蓋各層；這次補的是端到端，要打包後的 serve 與 spawner，CI 的 spawner job 沒有打包產物。
- **死循環不轉：** 要等 60 秒的 MCP 逾時，不算快。
- **寫滿磁碟不轉：** 要掛小容量 tmpfs，一般 runner 的測試程序沒有 mount 權限。
- **崩潰後清理不轉：** 要抓工具跑到一半的時間點，依賴機器速度，不穩定。

## 重現

腳本在 [`.docs/sandbox-failure-scenarios-2189/`](sandbox-failure-scenarios-2189/)。

1. 在 Linux arm64 容器裡 `pnpm install --offline --frozen-lockfile`，原生套件缺的話用 `graft.sh` 從映像接。
2. `cd native/sandbox-spawner`，`cargo build --release --locked --target aarch64-unknown-linux-musl`，再 `./bundle.sh <目錄>`。
3. `tsx pack.mjs` 打包，產物放進 `/out`。腳本裡的 commit 要換成當下的值。
4. 每個情境各起一個容器：

```bash
docker run --rm --pull=never -u 10001 --security-opt seccomp=unconfined --network none \
  -v <產物目錄>:/out:ro -v <腳本目錄>:/h:ro \
  --tmpfs /run2189:size=900m,exec,uid=10001,mode=0700 \
  --entrypoint sh <帶 node 的映像> /h/run.sh <腳本>.mjs
```

| 腳本 | 情境 | 額外參數 |
| --- | --- | --- |
| `s1.mjs` | 軟連結 | 無 |
| `s2.mjs` | DNS | `--sysctl net.ipv4.ip_unprivileged_port_start=0`、把 `resolv.conf` 掛到 `/etc/resolv.conf` |
| `s3.mjs`、`s3b.mjs` | 死循環 | 無 |
| `s4.mjs` | 寫滿磁碟，分開掛 | tmpfs：`/small`、`/small/h`、`/small/h/thread-roots`、`/small/t`，都要 `mode=0700` |
| `s4d.mjs` | 寫滿磁碟，出廠佈局 | tmpfs：`/small`、`/small/h` |
| `s5.mjs`、`s5b.mjs`、`s5c.mjs` | 崩潰後清理 | `s5b` 要把一個 400MB 的文字檔掛到 `/big/huge.txt`，`--tmpfs` 調大到 1800m |
| `s6.mjs` | bind mount 工作區（#2199） | 把一個目錄掛到 `/big` |

**讀結果要注意：** 工具結果是空的就不算數。假模型的回覆 `id` 要唯一；搜尋字串不能等於機密，否則「No matches」的回顯會被當成洩漏。
