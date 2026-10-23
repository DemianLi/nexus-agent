# nexus 的底座換成 Rust？—— 先判斷表達得出來，再用原型量

這份筆記回答兩個問題：

1. nexus 的底座要不要從 vendor 的 TS Cordis（`vendor/cordis`，上游 rc.11）換成 Rust。
2. 換之前的前置判斷：Cordis 這套「萬物皆可插件」的設計，在 Rust 裡表達不表達得出來。

它取代 [`rust-and-langchain-removal-2026-10-06.md`](rust-and-langchain-removal-2026-10-06.md) 的決定 ①。那份的前提是「nexus 沒有 import Cordis」，這個前提已在 10-11 由 [#1385](https://github.com/DemianLi/nexus-agent/issues/1385) 改 vendor Cordis 而過期（見 §一）。

**日期**：問題在 2026-10-22 提出，原型量測在 2026-10-23 執行。

**對讀版本**：

| 對象 | 版本 |
| --- | --- |
| nexus | develop `058d90ef` |
| dsh | `dsh-v0.2.1-rc.1`，tag 指向 `1600d8a1`（它的 `vendor/` 與 rc.2 `687f282e` 逐檔相同） |
| cordis-rs | `d77cf919`（用 `gh api` 取檔，沒有 clone） |

**這份筆記是研究，不是決議。** 現在不開卡、不派工。結論是「要換」，所以各段之後會在 #1385 底下開卡。要 demian 決定的事列在 §十一，並會寫進 [#1827](https://github.com/DemianLi/nexus-agent/issues/1827)。

## 結論

| 問題 | 答案 | 一句話理由 |
| --- | --- | --- |
| Cordis 在 Rust 裡表達得出來嗎 | **核心模型表達得出來，有兩處表達不出來** | 表達得出來的部分：fiber 樹、provide/inject、effect 歸屬、依序卸載，cordis-rs 已經做出來。表達不出來的有兩處：靠 JS `Proxy` 自動追蹤呼叫者，以及把任意 JS 值（LangChain 的工具物件、closure）當服務值。所以 TS 插件留在 TS 的 Cordis 樹裡，Rust 只接主機級的樹（§四） |
| 要不要換 | **要換，分四段換，每段單獨量、單獨回退** | 理由是失控保護 (b) 與安全隔離 (c)，這兩條都超出 dsh 的範圍，是偏離理由 2（§六）。**效能本身不是偏離理由**：每條對話的記憶體沒有過「省 30%」的門檻（§三-4） |
| 選哪個形狀 | **B：Rust 監督行程＋每條對話一個 Node 行程** | 量到的結果：同一個行程裡的隔離（worker、isolate、N-API）只擋得住「JS heap 慢慢長」；一次大配置或 heap 外配置，整個宿主一起死。只有一條對話一個行程，三種記憶體失控都擋得住（§三-3） |
| 為什麼監督行程用 Rust | **記憶體安全加上量到的足跡；CPU 這一項原型落後** | 監督行程閒置 RSS 2.7 MB（Node 46.3 MB），啟動 5.7 ms（Node 34.2 ms），30 分鐘長跑沒有看到洩漏。但未調校的原型每千輪 CPU 114 ms，Node 是 44.5 ms，demian 拍板 (b)：先調校原型，量到 CPU 不輸 Node 監督行程，這條偏離才收（§十一） |

## 這份筆記的來源與可信度

| 區塊 | 誰做的 | 核對狀況 |
| --- | --- | --- |
| §一 背景 | 主代理讀 | 第一手 |
| §二 版本與 nexus 盤點 | 主代理讀，加一個子代理的盤點 | 版號與檔案行號在 `058d90ef` 上重讀過。子代理的使用盤點是在 `edd38ae3` 上做的；本篇引用的計數已在 `058d90ef` 重數，數法寫在表下 |
| §三 原型與量測 | 主代理設計並執行 | 原型 P1、P2、P3 由三個子代理照同一份規格（`common/SPEC.txt`）各自建出。量測驅動、對照組 C0／C0p、沙箱執行器、所有執行與判讀都是主代理做的。原始判定 JSON 與每一步的狀態都在證據目錄，**不進 repo** |
| §四 表達得出來嗎 | 主代理讀 | 讀 cordis-rs 原始碼（`crates/cordis-core/src/service.rs` 等）、vendor 的 Cordis 原始碼，以及 demian 先前整理 Cordis TS 與 cordis-rs 優劣的 artifact |
| §五～§九 決定與計畫 | demian 逐題拍板（grilling Q1–Q32） | 是決定，不是事實 |
| §十 已知限制 | 主代理 | 第一手 |

## 一、背景：10-06 的前提已經過期

10-06 那份筆記的決定 ① 是「用 Rust 重寫編排層，現在不做」。它當時更正說「nexus 沒有 import Cordis 這個套件」，所以「用 Rust 取代 Cordis」的意思是重寫我們自己的 `PluginRegistry`。

這個前提已經不成立：

- **10-11**：#1385 決定核心底座改用 vendor 的 Cordis，見 [`decisions-2026-10-11.md`](decisions-2026-10-11.md)。
- **今天**：`vendor/cordis` 是 `@nexus/cordis 4.0.0-rc.11`，`vendor/loader` 是 `@nexus/cordis-plugin-loader 1.0.0-rc.8`。插件樹由 `apps/harness/cordis.yml` 描述（`058d90ef` 上 `grep -c -- '- id:'` 是 61 條）。

10-06 量到的兩個熱點，存檔點（#1109）與 token 估算（#1110），都已在 JS 層修掉，本篇不重談。本篇談的是 10-06 沒有涵蓋的兩件事：**失控保護**與**安全隔離**。

## 二、版本與現況盤點

### 2-1 三份 Cordis 的版本

| 對象 | Cordis 本體 | Loader | 來源 |
| --- | --- | --- | --- |
| dsh `dsh-v0.2.1-rc.1` | `@deepseek-ai/cordis 4.0.5` | `cordis-plugin-loader 1.0.6` | dsh tag `1600d8a1` 的 `vendor/` |
| nexus | `@nexus/cordis 4.0.0-rc.11` | `@nexus/cordis-plugin-loader 1.0.0-rc.8` | `vendor/cordis/package.json`、`vendor/loader/package.json` |
| cordis-rs | 對齊上游 rc.8（不是 rc.11） | 有 Loader 的對應，語意不完全相同 | `d77cf919`；差異細節見 dshbox/cordis-rs#264 |

dsh 是比對基準。nexus 的 rc.11 比 dsh 的 4.0.5 新，兩者的差異已由 #1385 底下各子卡處理，本篇不重列。

### 2-2 nexus 怎麼用 Cordis

nexus 把 Cordis 當成「插件貢獻的收集器」：插件在 apply 裡 provide 服務，消費者在 inject 裡宣告依賴。

| 項目 | 現況（`058d90ef`） |
| --- | --- |
| 服務契約類別 | `extends ContractService` 15 處（排除測試與 `.d.ts`） |
| 服務 token | `defineToken<…>` 15 處，名稱是字串 |
| 讀服務的方式 | `service()` 回傳 `ctx[token.name]`（`packages/nexus-sdk/src/token.ts:63`）。沒有宣告 inject 就讀會拋錯 |
| ctx 的實作 | 每個 ctx 都是 `Proxy`（`vendor/cordis/src/context.ts:39`）。effect 歸給哪個 fiber，靠 Proxy 追蹤呼叫者 |
| 版本並存 | `reload.code: 'coexist'` 被擋下（`packages/nexus-sdk/src/manifest.ts:190`），只放行 `restart` |
| 沒用到的 Cordis 功能 | 依 `edd38ae3` 的盤點：HMR、timer、isolate、emit/parallel/serial/bail、`ctx.set`、entry group |
| `nexus-core` | 不依賴 `@nexus/cordis` |

**跨對話共用的服務**，這是兩層樹的上層要接的東西：

- MCP 連線池：PR #1820（`fc7c6786`）。
- 模型並行上限：#1618（`bafc0dae`），五條路徑共用。

### 2-3 沙箱的現況

- **nexus**：`apps/harness/src/contained-backend.ts` 是**行程內**的詞法路徑圍欄，加上 symlink 檢查，只管檔案工具。沒有 OS 層的行程沙箱：MCP stdio 伺服器、ripgrep、git 都直接 spawn。目前沒有 shell 工具。
- **dsh**：`dsh-sandbox` 是一道 TS 接縫：
  - `SandboxMode` 有三種：`read-only | workspace-write | danger-full-access`；
  - 強制程度分 `full | partial` 兩級；
  - 後端：Linux 用 bwrap 或 Landlock（`native/system` 裡用 C 寫的靜態 `landlock-run`），macOS 用 Seatbelt，Windows 用 ACL 加受限 token；
  - **網路明寫不在範圍內**。

## 三、原型與量測

### 3-1 做法

所有原型都在 Docker 裡跑，模型是假的，不碰任何 key。

**量測環境**：

| 項目 | 值 |
| --- | --- |
| 宿主 | Docker Desktop VM：12 CPU、8.2 GB、kernel 7.0.14-linuxkit、aarch64 |
| 每條對話的 heap 上限 | `SESSION_HEAP_MB=128` |
| 一輪的時限 | `TURN_DEADLINE_MS=6000` |
| 容器限制 | S3 系列 `--memory=1g`；S4 `--cpus=2`；S6 `--memory=4g` |

**受測系統（SUT）的形狀**：

- 一個行程，用 stdin/stdout 交換 JSON lines，指令有 `load`、`remove`、`open`、`close`、`turn`、`stats`。
- 工具查找一律以 SUT 的登記表為準。登記表照 cordis-rs 的模型：provide 當下顯式記下 owner 與版本，不靠追蹤呼叫者。
- 插件用 JS 寫，代表 TS 插件：

```js
export default function apply(ctx) {
  ctx.provideTool(name, fn)
}
```

**組別**：

| 組 | 形狀 |
| --- | --- |
| c0s | 純 Node，全部在主執行緒（今天 nexus 的形狀） |
| c0w | 純 Node，一條對話一個 `worker_threads`（`resourceLimits`） |
| c0p | Node 監督行程＋一條對話一個 Node 子行程（子行程與 p2 相同，只換監督行程的語言） |
| p1 | Node 主行程＋Rust N-API 登記表（napi 3.15.0）＋一條對話一個 worker |
| p2 | Rust 監督行程（tokio 1.54.1）＋一條對話一個 Node 子行程（資料＋RPC 契約） |
| p3 | Rust 宿主＋`deno_core` 0.412.0，一條對話一個 V8 isolate、一條 OS 執行緒 |

所有組的 shell 工具都走同一支沙箱執行器 `sbx-run`（Rust，見 3-5）。

**情境**：

| 情境 | 內容 | 及格標準 |
| --- | --- | --- |
| S1 歸屬與卸載 | 插件移除後，它提供的工具立刻不可用 | `no_tool` |
| S2 執行期加版本 | 舊對話留在 v1、新對話拿 v2；最後一條 v1 對話關掉時，v1 被釋放 | `unloaded` 含 `echo@v1` |
| S3 記憶體失控 | 5 條對話裡的 1 條讓 JS heap 慢慢長 | 失控那條被殺，其他 4 條零中斷，宿主存活 |
| S3b 一次大配置 | 同上，改成一次 `new Array(1<<27).fill(0)` | 同上 |
| S3c heap 外失控 | 同上，改成不停配置 16 MB 的 `Uint8Array` | 同上 |
| S4 CPU 失控 | 1 條對話 `for(;;){}` | 其他對話的 p95 上升 ≤20%，失控那條在時限內被殺 |
| S5 沙箱逃逸 | 寫工作區外、讀 `/secret/token`、TCP 連線、UDP 送封包 | 全部被擋，寫工作區內成功 |
| S6 成本 | N=50、100 條對話，每條 5 輪，每輪附加 20,000 字元 | 量 cgroup anon 的增量 ÷ N，以及同一對話連呼 2,000 次工具的平均耗時 |

S3 與 S4 的及格標準就是 Q4.2 的門檻。

### 3-2 S1、S2

- **S1**：全部組都及格。
- **S2**：c0s 不及格。ESM 的模組快取卸不掉，`unloaded=[]`。其他組都及格。

### 3-3 記憶體失控：只有「一條對話一個行程」三種都擋得住

| 組 | S3 heap 慢慢長 | S3b 一次大配置 | S3c heap 外 |
| --- | --- | --- | --- |
| c0s | ✘ 整個行程 SIGABRT，5 條全死 | ✘ SIGABRT | ✘ SIGKILL |
| c0w | ✔ 64 ms | ✘ SIGABRT | ✘ SIGKILL |
| p1 | ✔ 58 ms | ✘ SIGABRT | ✘ SIGKILL |
| p3 | ✔ 65 ms | ✘ 容器 SIGKILL | ✘ SIGKILL |
| **c0p** | ✔ 58 ms | **✔ 839 ms** | **✔ 103 ms** |
| **p2** | ✔ 58 ms | **✔ 1,434 ms** | **✔ 129 ms** |

表中的毫秒數是從失控開始到那條對話被判定死亡的時間。

- **worker、isolate、N-API 擋不住的原因**：它們的上限只管 V8 heap。一次大配置和 heap 外配置會繞過那個上限，直接撞上整個宿主的 cgroup。
- **c0p 和 p2 的結果相同**：擋得住是因為「一條對話一個行程」，不是因為 Rust。這是設對照組 c0p 的目的。

### 3-4 CPU 失控與成本

**S4**：每輪固定 3e6 次運算，列出其他 4 條對話的 p95，三次執行。

| 組 | 失控前 → 失控期間（ms） | 比值 |
| --- | --- | --- |
| c0s | 75–91 → 全部逾時（事件迴圈卡死，時限計時器也不觸發） | ✘ |
| c0w | 74–76 → 86–89 | 1.18 / 1.15 / 1.18 |
| c0p | 75–79 → 90–92 | 1.20 / 1.19 / 1.15 |
| p1 | 76–78 → 87–92 | 1.18 / 1.14 / 1.19 |
| p2 | 80–81 → 90–92 | 1.14 / 1.11 / 1.15 |
| p3 | 三次不一致（兩次的基準比失控期間還慢） | 不採計 |

- 隔離組彼此差不多（+11%～+20%）。失控的對話都在時限被殺，其他對話零錯誤。
- **沒有一組能替單條對話設 CPU 上限**：預設容器的 cgroup 是唯讀的，`cpu.max` 寫不進去；renice 也只能單向調低（沒有 `CAP_SYS_NICE`）。比值上升的主因是 2 顆 CPU 被吃掉 1 顆。
- 第一輪用 0.3–0.7 ms 的極小工作量量過一次，比值被基準高低扭曲，那一輪不採計。原始資料保留在證據目錄。

**S6**：

| 組 | N=50（KB/條） | N=100（KB/條） | 一次工具呼叫（µs，50 / 100） |
| --- | --- | --- | --- |
| c0s | 446 | 488 | 0.34 / 0.51 |
| c0w | 11,945 | 11,875 | 0.28 / 0.31 |
| c0p | 10,833 | 10,782 | 0.54 / 0.60 |
| p1 | 12,268 | 12,214 | 0.85 / 1.04 |
| p2 | 10,816 | 10,869 | 0.54 / 0.51 |
| p3 | 7,622 | 7,653 | 0.16 / 0.38 |

- **對有隔離的對照組 c0w**：p1 +2.5%、p2 −9%、p3 −36%。
- **p3 的 −36% 是上限**：p3 的世界裡沒有 Node API（`process`、`Buffer`、`fetch`、`setTimeout`、`node:*`、npm 都沒有），省下的一部分來自少了 Node 執行期。要跑真的 nexus 插件，得補 deno 的 `ext/node`。
- **對今天的形狀 c0s**：每條對話多 7–12 MB，約 15–27 倍。

**對 Q4.3 門檻的判讀**：門檻是「每條對話記憶體比 C0 省 ≥30%，或同樣記憶體多撐 ≥30% 條」。

- 唯一過門檻的是 p3，但 p3 在 S3b、S3c 不及格。
- p2 對 c0w 只省 9%，對 c0s 則是大幅變差。

所以**效能不能當偏離理由**，換 Rust 的理由只能是 (b) 與 (c)。

**邊界呼叫 ≤1 ms** 的門檻：

- p1 的每次工具呼叫都過一次 N-API，量到 0.85–1.04 µs，遠低於門檻。
- p2 的「一輪跨行程往返」沒有單獨量。監督行程的 stats 往返在長跑負載下 p99 最高 210 ms，見 3-6。

### 3-5 沙箱：Landlock＋seccomp，Rust 寫

**執行器 `sbx-run`**（Rust，`landlock` 0.4，ABI V5，best effort）：

- **檔案**：
  - 可讀：`/usr /bin /lib /lib64 /etc /proc`；
  - 可完整存取：工作區與 `/dev/null`。
- **網路**：
  - 手寫 seccomp BPF（只用 `libc`），擋 `socket(AF_INET/AF_INET6)` 與 `io_uring_setup`，回 `EACCES`；
  - 會先檢查架構：aarch64 與 x86_64。
- **執行順序**：先在 stderr 印出 `SBX-ENFORCEMENT=<full|partial|none>`，再 exec 指令。

**結果**：

| 版本 | S5 結果 |
| --- | --- |
| v1：只有 Landlock | 檔案與 TCP 全部擋住，**UDP 六組都漏**。Landlock 只管 TCP 的 bind/connect |
| v2：Landlock＋seccomp | 六組全部及格，含 UDP |
| 對照：bwrap | 預設容器裡建不了 namespace，加 `--security-opt seccomp=unconfined` 也不行 |

- Landlock 在這個 kernel 上是 `full`，而且不需要特權。
- bwrap 這一組沒有試 `--privileged`，因為那等於拿掉容器邊界。

### 3-6 監督行程本身（Q13）

量法：

- 容器 6 GB、`--cpus=4`；
- 只量監督行程那一個 pid，數值從 `/proc` 取；
- 長跑：20 條並行做「開→5 輪→關」，連續 30 分鐘。

| 指標 | Rust（p2） | Node（c0p） |
| --- | --- | --- |
| 啟動到第一個回應（中位數） | 5.7 ms | 34.2 ms |
| 閒置 RSS / anon | 2.7 MB / 0.35 MB | 46.3 MB / 7.6 MB |
| 200 條對話時 RSS / anon | 7.8 MB / 5.3 MB | 56.3 MB / 12.1 MB |
| 全部關掉後 RSS | 9.1 MB | 58.7 MB |
| 吞吐（20 條併發） | 13,986 輪/s | 9,881 輪/s |
| 監督行程 CPU / 千輪 | **114 ms** | **44.5 ms** |
| 長跑：循環數、失敗數 | 約 17 萬、0 | 約 17 萬、0 |
| 長跑：RSS 首 → 末 | 9.3 → 9.5 MB | 91.4 → 100.5 MB |
| 長跑：後 2/3 的 RSS 斜率 | +0.14 MB/h | +0.83 MB/h |
| 長跑：CPU / 循環 | **2.32 ms** | **1.37 ms** |
| 長跑：stats 往返 p99 的範圍 | **3.5–210 ms** | **0.26–77 ms** |

- **記憶體與啟動**：Rust 明顯小，約 1/10～1/17。30 分鐘內都沒看到洩漏；Node 先長約 9 MB，然後持平。
- **CPU 與尾延遲**：這支 Rust 原型反而較差。原型用多執行緒 tokio、`serde_json::Value`、`std::Mutex`，沒有調校。這是實作品質的問題，不是語言的上限，但也代表「Rust 一定比較省 CPU」在這裡**沒有被證明**。
- **換算**：監督行程省下的 40–90 MB，約等於 4–8 條原型對話子行程（每條 10.8 MB）。

### 3-7 執行器的語言：Rust 對 C（2026-10-23 晚補）

這一節回答「R1 (b) 的 CPU 條件管不管執行器」。條件是監督行程的 CPU 不輸 Node 監督行程。

**量法**：

- 環境：同一個容器，`--cpus=4 --memory=2g`。量測時宿主負載 load avg 12–20，四個變體交錯執行，抵銷負載漂移。
- 編譯：全部編成 static glibc。dsh 正式出貨是 `musl-gcc -Os -static -s`，容器裡沒有 musl，所以 musl 版沒量。
- 指標：每次 fork＋exec `/bin/true` 到結束，用 `wait4` 取子行程的 rusage；另從 Node `spawn` 量一次產品實際走的路徑。

**變體**：

| 變體 | 內容 | 大小 |
| --- | --- | --- |
| C | dsh 的 `native/system/packages/entry/src/main.c`（`687f282e`，與 rc.1 相同），只有 Landlock | 600 KB |
| C＋seccomp | 同上，加上 Rust v2 的 seccomp 過濾器，逐條移植 | 600 KB |
| Rust v1 | `sbx-run` v1，只有 Landlock | 1.06 MB |
| Rust v2 | `sbx-run` v2，Landlock＋seccomp | 1.06 MB |

四個都擋得住 `/secret/token`，也都寫得進工作區。UDP 只有兩個 seccomp 版擋得住（回 `EACCES`）。

**結果**：每次執行比直接 exec 多出的時間，取 p50。

| 比較 | 負載較低時 | 負載較高時 |
| --- | --- | --- |
| Rust v1 對 C（都只有 Landlock） | +36～37 µs | +97～154 µs |
| Rust v2 對 C＋seccomp | 沒量 | +66～164 µs（多 6～15%） |
| maxrss | C 708 KB、Rust 848 KB | 同左 |

- **功能相同時，Rust 每次多 0.04–0.16 ms。** 一次工具呼叫本身要幾毫秒到幾百毫秒。
- **成本大頭是 seccomp，不是語言。** C 加上同一份過濾器，多出的時間和 Rust v2 幾乎一樣。10 條 BPF 指令為什麼要 0.1–1 ms，沒有查。
- **對照：Node 啟動一次（`node -e 0`）要 16.8 ms、42 MB。** 所以「不輸 Node」對執行器沒有意義，執行器要比的對象是 C。

**業界做法**：子代理讀各專案原始碼得出，主代理抽查了 Codex 的 seccomp 規則、srt 的 `apply-seccomp.c`、Codex Discussion #1174。

- **監督行程是 TS／JS 的工具，「套沙箱再 exec」那段都交給 C**：
  - dsh：`landlock-run`；
  - Anthropic 的 sandbox-runtime 與 Claude Code：bubblewrap 加上 965 行的 `apply-seccomp.c`；
  - Gemini CLI：bubblewrap。
- **執行器用 Rust 的，都是監督行程本來就是原生語言的專案**：
  - Codex：landlock 0.4 加 seccompiler，擋 `AF_INET`、`AF_INET6` 與 `io_uring`，和本篇最像，但 namespace 那段仍交給 bubblewrap；
  - youki、Firecracker jailer：全 Rust。
- **專案自己寫下的語言理由**：
  - dsh：只依賴 libc，要稽核的只有一個檔；
  - minijail：C 好連結，也能控制會用到哪些 syscall；
  - crun：低階工具適合 C；
  - youki：記憶體安全，處理 fork 和 namespace 比 Go 容易；
  - Codex：只有一句「bindings 現成」。
- **查不到**：只變「語言」這一個變數的公開效能比較。
- **政策面**：CISA 等機構的《The Case for Memory Safe Roadmaps》（2023-12）建議新的、小的、安全關鍵的程式優先用記憶體安全語言，但沒有點名沙箱執行器。把執行器算進這條，是本篇的推論。

**決定**：執行器照 Q11 用 Rust，**不受 R1 (b) 管**（demian 2026-10-23 拍板）。代價是每次多 0.04–0.16 ms、執行檔大約 460 KB，換到的是記憶體安全，做法和 Codex 一致。

## 四、前置判斷：Cordis 在 Rust 裡表達得出來嗎

**表達得出來的部分**：cordis-rs 已經實作了這些。

| Cordis 概念 | cordis-rs 的做法 |
| --- | --- |
| 服務 | `trait Service { const NAME }`；值存成 `Arc<dyn Any + Send + Sync>`，以 `TypeId` 當型別契約 |
| effect 歸屬 | provide 當下，在 slot 裡記下擁有者 fiber（`Weak<Fiber>`）。歸屬是顯式的，不靠 Proxy 追蹤呼叫者 |
| 生命週期 | fiber 樹、依序卸載、apply 與 dispose 有期限 API、計時器綁在生命週期上 |
| 設定 | 嚴格解析；不支援 `__jsExpr` 那種 eval |

cordis-rs 證明的是這些概念表達得出來，**不是語意和 rc.11 相同**。10-18 的 parity 實跑結果是 83 個情境裡 44 個不一致，含 Loader、isolate、Timer、update 否決。這也是 §七 有幾項語意取自 TS rc.11 的原因。

**表達不出來的部分，有兩處**：

1. **自動追蹤呼叫者**：TS Cordis 的每個 ctx 都是 `Proxy`，effect 自動歸給呼叫它的 fiber。Rust 沒有這種攔截，只能改成顯式傳遞擁有者，像 cordis-rs 那樣。
2. **把任意 JS 值當服務值**：nexus 的服務值裡有 LangChain 的 `StructuredToolInterface` 和 closure。這些值過不了語言邊界。原型 P1 實測過：Rust 不能跨 isolate 持有 JS 函式，否則 V8 FATAL；Rust 登記表只能存資料。

**另外一處，表達得出來但代價高**：Rust 插件的執行期熱換。要做得用動態函式庫加 ABI 穩定，所以 Rust 側插件改成編進執行檔、用設定開關（Q18）。

**判斷結果**：Cordis 的核心模型可以用 Rust 表達。但 TS 插件依賴的那兩處，只有 TS 的 Cordis 給得出來。所以採兩層樹（§八）：

- **TS 插件**：寫法不變，留在每條對話行程裡的 TS Cordis 樹。
- **Rust**：接主機級的樹，也就是跨對話共用的服務。

## 五、決定清單（grilling Q1–Q32，demian 逐題拍板）

| 題 | 決定 |
| --- | --- |
| Q1 | 重新評估換不換，另做「表達得出來嗎」的前置判斷 |
| Q2 | 以資源與效能為主；偏離照 AGENTS.md 標明理由 1 或 2 |
| Q3 | 只換核心與沙箱，其他優先維持 TS 插件 |
| Q4.1 | 要解決失控保護 (b) 與安全隔離 (c) |
| Q4.2 | S3：失控那條被殺、其他零中斷、宿主存活。S4：其他對話的 p95 上升 ≤20% |
| Q4.3 | 每條對話的記憶體比 C0 省 ≥30%（或多撐 ≥30% 條），且邊界呼叫多出 ≤1 ms，否則效能不算偏離理由 |
| Q5 | 基準是 dsh `v0.2.1-rc.1`。要保留萬物皆可插件，要扛得住企業情境，可以參考 cordis-rs |
| Q6 | 寫本篇、開 `docs:` PR、在 10-06 補一行；不開卡、不派工 |
| Q7 | 「沙箱」指工具執行的行程沙箱。TS 接縫照 dsh，原生執行器是新的 |
| Q8 | 形狀 B：Rust 監督行程＋每條對話一個 Node 行程 |
| Q11 | 沙箱執行器用 Rust 寫 |
| Q12 | 網路要擋 |
| Q13 | 監督行程本身要量：記憶體用量、洩漏、CPU、記憶體管理指標、啟動速度、長時間運行（§三-6） |
| Q14 | 底座用 Rust 重寫，保留萬物皆可插件。MCP 改用 Rust 的 MCP client，仍以插件形式可插拔。模型並行上限也搬進 Rust 監督行程 |
| Q15 | 每條對話一個行程，加上 #1484 的閒置逐出 |
| Q16 | 用 seccomp 擋 `AF_INET`/`AF_INET6`。工具子行程一律擋；MCP stdio 伺服器預設照今天的行為，每條 MCP 設定可以宣告要套沙箱 |
| Q17 | 自己用 Rust 寫核心，結合 Cordis TS 與 cordis-rs 的優勢 |
| Q18 | Rust 側插件（MCP、並行上限、沙箱）編進執行檔、用設定開關。換程式碼走排程重啟，和 #1385 的「核心更新走排程重啟」一致 |
| Q21 | 兩層樹（§八） |
| Q22 | sub-agent 跑在父對話的行程裡 |
| Q23–Q27 | Rust 核心的語意清單（§七） |
| Q28 | 橋支援請求→回應、取消、串流，契約是 schema 描述的資料＋RPC |
| Q29 | agent loop 要換，但不是現在，不在本篇範圍。本篇的形狀不擋它 |
| Q30 | 分段替換（§九），理由是每一段都能量出有沒有全方位的提升 |
| Q31 | 第一版只支援 Linux，穩定後再擴充 macOS 與 Windows |
| Q32 | 每段事先宣告要提升的指標與允許的退步，用同一套量具做前後對照。沒宣告的退步擋合併 |

Q9、Q10 是量測計畫與下載許可的程序題，不列。Q19、Q20 整理時找不到單獨的拍板紀錄，也不列。

## 六、偏離理由鏈（AGENTS.md「技術實現標準」）

每一條都寫明是理由 1（基座表達不出來）還是理由 2（需求超出 dsh 的範圍）。

| # | 偏離 | 理由 | 具體理由 | 補了什麼 |
| --- | --- | --- | --- | --- |
| 1 | 每條對話一個行程＋監督行程 | **2** | dsh 沒有整體的資源保險絲，只有各入口 fail-closed 的上限。nexus 的主機要多人共用（企業內網），一條對話失控不能拖垮全部。§三-3 量到同一個行程裡的隔離擋不住 S3b、S3c | 監督行程管對話行程的生死、heap 上限、時限、renice；加上 #1484 的閒置逐出 |
| 2 | 工具子行程擋網路 | **2** | dsh 的 `SandboxMode` 明寫網路不在範圍內。企業內網要防資料外流。Landlock 只管 TCP，擋 UDP 要用 seccomp（§三-5） | seccomp 擋 `socket(AF_INET/AF_INET6)` 與 `io_uring_setup` |
| 3 | 自己寫原生執行器 | **2**（由 #2 推出） | dsh 的 `landlock-run` 只做 Landlock，表達不出 seccomp 擋網路 | 新的執行器；dsh 的 TS 接縫（`SandboxMode`、`full/partial`）照用 |
| 4a | 監督行程用 Rust | **語言選擇**（dsh 沒有監督行程，無從比照；依附在 #1 的理由 2 之下） | 監督行程站在安全邊界上，要記憶體安全、不要 GC。足跡有量測支持（§三-6），但 CPU 原型落後 | demian 拍板 (b)：先調校原型，量到 CPU 不輸 Node 監督行程才收（§十一） |
| 4b | 執行器用 Rust，不照 dsh 的 C | **語言選擇**（偏離 dsh 的 C `landlock-run`；依附在 #2、#3 的理由 2 之下） | 執行器是安全邊界上的新小程式，要記憶體安全。量到同功能下比 C 每次多 0.04–0.16 ms、執行檔大 460 KB（§三-7）。業界同樣做法：Codex | demian 拍板：照 Q11 用 Rust，不受 R1 (b) 管（§三-7） |
| 5 | MCP 搬進 Rust | **2**（由 #1、#4 推出） | 跨對話的 MCP 連線池（PR #1820）必須活在監督行程裡，對話行程活不久也看不到彼此。監督行程是 Rust，所以 MCP client 是 Rust | Rust MCP client，以編進執行檔的插件形式提供 |
| 6 | 模型並行上限搬進 Rust | **2**（由 #1 推出） | 上限要跨所有對話計數（#1618），對話分成多個行程以後，只有監督行程看得到全部 | 監督行程裡的並行上限插件，經橋提供給對話行程 |

**不是偏離理由的**：「效能比較好」。§三-4 的 S6 沒有一組有隔離的形狀過 Q4.3 的門檻。

## 七、Rust 核心的語意（Q23–Q27）

**取自 cordis-rs**：

- 服務與事件有型別。
- apply、dispose 有期限 API。
- 設定嚴格解析，不支援 `__jsExpr` eval。
- exporter 出錯被圍住，不外溢。
- 計時器綁在生命週期上。
- 設定值是 `None` 時不覆寫。

**取自 TS rc.11**：

- 執行期的插件樹。
- fiber 有六種狀態，每次轉換都發事件。
- provide/inject 帶 epoch。
- effect 有擁有者。
- Loader 以 diff 做執行期的編輯與移除。
- update 否決照 rc.11 的語意。
- isolate。
- group 可以停用。

**取自 nexus 自己**：

- 讀沒有宣告的服務會拋錯。
- `internal/*` 事件只給框架用。
- semver 契約檢查。

**行為規則**：

| 題 | 規則 |
| --- | --- |
| Q24 | 子插件跟著父插件一起收（TS 的語意） |
| Q25 | 卸載照 rc.11 的順序：同一個 effect 內反序、依序；兄弟之間並行；依賴者先於提供者收完 |
| Q26 | 第一次 apply 失敗就整個回滾，並在 append-only 稽核紀錄寫一筆結構化的失敗紀錄。啟動時的對帳讀這筆紀錄（對應 #1467） |
| Q27 | 每個 listener 各自 try/catch，錯誤轉成結構化事件。派發時取固定快照（cordis-rs 的做法）。慢的 listener 由期限 API 管 |

## 八、兩層樹與橋（Q21、Q22、Q28）

```
Rust 監督行程（主機級的樹）
├─ MCP（Rust client，插件，設定開關）
├─ 模型並行上限（插件）
├─ 沙箱執行器（插件，spawn sbx-run）
└─ TS 插件的版本登記表
        │  橋：請求→回應 / 取消 / 串流；schema 描述的資料＋RPC
        ▼
每條對話一個 Node 行程（對話級的樹）
└─ TS Cordis 樹：今天的 harness 插件，寫法不變
   └─ sub-agent 跑在同一個行程裡
```

- **Rust 側服務進到對話行程的方式**：在對話行程裡化成 Cordis 服務，TS 插件照樣用 `inject` 宣告、用 `service()` 讀。
- **過橋的只有資料**：closure 和 LangChain 物件留在對話行程內，這是 §四第 2 點的直接後果。
- **sub-agent 的位置**：跑在父對話的行程裡，所以父子共用 heap 上限與時限。

## 九、分段計畫與每段的宣告（Q30、Q32）

每一段都能單獨量、單獨回退。量具用同一套：S1–S6，加上 §三-6 的監督行程指標。在同一台機器上做前後對照。**沒有事先宣告的退步，擋合併。**

| 段 | 內容 | 要提升 | 宣告允許的退步 |
| --- | --- | --- | --- |
| 1 | Rust 沙箱執行器（Landlock＋seccomp），接 dsh 形狀的 TS 接縫 | (c)：S5 從「沒有 OS 沙箱」變成全擋，含 UDP | 無 |
| 2 | Rust 監督行程＋每條對話一個 Node 行程，行程裡跑今天的 harness | (b)：S3、S3b、S3c、S4 及格 | **每條對話的記憶體**。原型的下限是 c0s 0.45 MB → p2 10.8 MB。真 harness 子行程沒有量過，見 §十。**每輪 CPU 與邊界延遲**：多一跳 IPC，必然退步。**這三項的數字都要在這段動工前，用真 harness 子行程量好，才能宣告** |
| 3 | Rust 主機級的樹、Rust MCP client、並行上限 | 監督行程的記憶體與啟動 | CPU 不得退步。原型 CPU 落後，所以這段要先調校 |
| 4 | 收掉相容層 | 收回一部分記憶體 | 無 |

**第 1 段可以最先做**：它不依賴其他段。

## 十、範圍外與已知限制

**範圍外**：

- **agent loop**（Q29）：要換，但不是現在。
- **macOS、Windows**（Q31）：第一版只做 Linux。dsh 在這兩個平台的後端（Seatbelt、受限 token）之後再對讀。

**已知限制**：

- **第 2 段的真實成本沒量**：原型的對話子行程是空的 Node 加一支玩具 `session-host.mjs`，10.8 MB 是下限。真的 harness 子行程要載入 LangChain、deepagents 與整棵插件樹。作為參考，#1464 在 macOS 上量過 serve 閒置 RSS 237 MB（GC 後 heap 109 MB），每條 thread 常駐約 2.1 MB。所以真實的每條成本很可能由 harness 的匯入足跡主導。**第 2 段動工前要先量**，也要評估閒置逐出（#1484）與預熱這類緩解。
- **第 2 段還缺 CPU 與延遲的宣告**：第 2 段的「之前」是沒有監督行程的單一行程，加上監督行程後每輪多一跳 IPC，每輪 CPU 與邊界延遲必然上升。照 Q32，這兩項也要事先宣告。demian 2026-10-23 拍板：等真 harness 子行程量出來再定，和記憶體同一批量。
- **邊界延遲沒證明**：p2 一輪跨行程往返的延遲沒有單獨量。監督行程的 stats 往返在長跑負載下 p99 最高 210 ms，不符合 Q4.3「邊界多出 ≤1 ms」的門檻。原型沒調校，第 2、3 段要重量。
- **CPU 原型落後**：見 §三-6。
- **單條對話的 CPU 上限**：預設容器做不到，cgroup 唯讀、renice 只能單向。要做得在宿主上給監督行程一棵可寫的 cgroup 子樹，部署形狀要另議。
- **p3 的 S4 不一致**：不採計。p3 本來也在 S3b、S3c 不及格。
- **seccomp 過濾器的缺口**：
  - 目前只擋 `AF_INET`、`AF_INET6` 與 `io_uring_setup`。
  - Codex 還擋 `io_uring_enter`、`io_uring_register`。
  - Anthropic 的 sandbox-runtime 還擋 `AF_UNIX`、`AF_VSOCK` 與建立 namespace 的 syscall；Codex 棄用舊的 Landlock 路徑，也是因為擋不住 Unix socket。
  - 第 1 段開卡時要逐條決定。
- **seccomp 的成本**：每次 0.1–1 ms，原因沒查（§三-7）。執行器用 musl 編的版本也沒量。
- **平台只量了 aarch64 Linux**：沒有量 x86_64。seccomp 過濾器有處理 x86_64 的架構檢查，但沒有在 x86_64 上跑過。
- **bwrap**：只在預設容器裡試過。在可以建 namespace 的宿主上沒有量。

## 十一、要 demian 決定的事（會寫進 #1827）

1. **監督行程與執行器用 Rust**（§六 #4）：
   - 支持：記憶體約 1/10、啟動快約 6 倍、30 分鐘沒有洩漏。
   - 反對：未調校的原型 CPU 約 2.6 倍、尾延遲較差。
   - 要決定：接受「記憶體安全加上足跡」當語言理由，還是要等調校後 CPU 不輸 Node 再定？
   - **已拍板（2026-10-23）：(b)**。先調校原型，量到監督行程的 CPU 不輸 Node 監督行程（c0p），這條語言偏離才收。比法：同一支 `bench.mjs`、同一台機器。在那之前，監督行程的語言視為未定。**這個條件只管監督行程，不管執行器**：執行器照 Q11 用 Rust（§三-7、§六 #4b）。
2. **第 2 段的記憶體退步要先量**：在真 harness 子行程量出每條成本以前，第 2 段不宣告數字。要決定：是否同意這個前置條件？量出來太高時，可以接受的上限是多少？
   - **已拍板（2026-10-23）：是**。可以接受的上限，等量出來以後再定。
3. **CPU 上限的部署形狀**：要不要在部署時給監督行程一棵可寫的 cgroup 子樹？這會改變內網部署的要求。
   - **已拍板（2026-10-23）：先否**。第 2 段先用時限加 renice，量到不夠再提。
4. **第 2 段的 CPU 與邊界延遲宣告**：多一跳 IPC 必然有退步（見 §十）。**已拍板（2026-10-23）**：等真 harness 子行程量出來再定。

## 證據位置

全部在 `~/.nexus-agent-evidence/2026-10-23/cordis-rust-proto/`，不進 repo：

| 路徑 | 內容 |
| --- | --- |
| `common/SPEC.txt` | SUT 協定與情境 |
| `common/driver.mjs` | S1–S6 驅動 |
| `common/bench.mjs` | 監督行程評測 |
| `common/plugins/` | 測試用插件 |
| `c0/`、`c0p/` | 對照組 |
| `p1/`、`p2/`、`p3/` | 三個原型，各附 `README.txt` |
| `sbx/` | 沙箱執行器原始碼，含 v1 |
| `runs/RESULTS.txt` | 結果總表 |
| `runs/*.json`、`runs/*.log` | 每次執行的判定與每一步的完整狀態 |
| `run.sh`、`measure-*.sh` | 量測腳本 |
