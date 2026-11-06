# nexus-sandbox-spawner

工具子行程的沙箱（[#1946](https://github.com/DemianLi/nexus-agent/issues/1946)）：常駐的 Rust 行程，只在 Linux 上跑。

- 啟動時裝一次 seccomp，之後 fork 的子行程都繼承：擋網路（`AF_INET`、`AF_INET6`）、`AF_UNIX`、`AF_VSOCK`、io_uring、namespace 與 mount 系列，`clone3` 回 ENOSYS（`src/seccomp.rs`）。
- 每個子行程在 exec 之前各自上一份 Landlock。讀根、寫根由 Node 在每次要求裡帶來（`src/landlock.rs`）。全權模式不上 Landlock，seccomp 照樣繼承。
- Landlock 不能用（none）：spawner 照樣起，只有全權模式的要求起得來，其餘回 `SandboxUnavailable`。seccomp 裝不上：spawner 送 `Unavailable` 後結束。
- 核心沒有 `pidfd_open`（5.3 以前，ENOSYS）：起動就送 `Unavailable`，連全權模式也起不來。其他錯（例如 fd 用盡）不算，留給那一筆工具的 `Resource` 失敗。

單次模式 `--exec`：替自己上同一份 seccomp 與 Landlock 再 exec，給設定裡宣告要套沙箱的 MCP stdio server 用，一條連線起一次，stdio 由呼叫端接好。沒有 Landlock、seccomp 裝不上、讀根打不開都以 125 結束，不跑。沒有全權模式。讀根寫根要是 realpath，不是就拒絕，重起時這些路徑被換成連結也走不出去。Landlock 不到 ABI 6 時往 stderr 講一句。

單次模式 `--guard`：不上沙箱，只設 `PR_SET_PDEATHSIG` 再 `execvp`，給沒宣告沙箱的 MCP server 用（#2197）。

單次模式 `--flock`：對繼承來的 fd 3 拿 `flock(LOCK_EX | LOCK_NB)` 就結束，不上沙箱，給 harness 的 home 鎖與會話寫租約用（#2253）。鎖屬於 open file description，所以這個行程結束之後還在，呼叫端關掉把手或死掉才放。結束碼：0 拿到、10 別人握著、11 其他失敗（errno 的數字印在 stdout）。

協定（控制通道與 stdio 怎麼接）在 `src/protocol.rs` 與 `src/main.rs` 的檔頭。

監督行程的控制面協定（[#1947](https://github.com/DemianLi/nexus-agent/issues/1947)，#2339）也放在這個 crate：`src/supervisor_protocol.rs`，跟 spawner 共用框格式；向量檔是 `supervisor-vectors.json`，TS 那一側是 `apps/harness/src/supervisor-protocol.ts`。spawner 的執行檔不用它。

## 監督行程 `nexus-supervisor`

同一個 crate 的第二支執行檔（#2340，`src/bin/nexus-supervisor.rs`，邏輯在 `src/supervisor/`）：起一個前台、按前台的要求每條 thread 起一個對話行程，管它們的生死，寫稽核紀錄。不裝 seccomp：前台要綁 port、對話行程要開 Unix socket 與連模型端點。不在離線包裡。

```text
nexus-supervisor --run-dir <目錄> --audit <檔> --front <程式> [--front-arg <參數>]...
                 --conversation <程式> [--conversation-arg <參數>]...
                 [--eof-grace-ms 6000] [--term-grace-ms 3000] [--front-restart-ms 1000]
                 [--rss-limit-mb <MiB>] [--rss-poll-ms 250] [--stall-ms 15000]
                 [--capacity <條>] [--warm 1] [--idle-ms 7200000] [--read-only-idle-ms 300000]
                 [--drain-timeout-ms 5000] [--stats-ms 10000]
```

- 前台與對話行程的 stdin／stdout 是控制通道（框格式見上），stdout 只能寫框。前台的 stderr 照監督行程的；對話行程的 stderr 接到監督行程，由它原樣轉到自己的 stderr，同時找 V8 heap 用完的訊息（見死因）；leader 收屍時再讀最多 1 MiB 就關掉，之後群組外還活著的後代寫的不轉出。**監督行程的 stderr 一定要有人讀**：它是阻塞的而沒人讀時，整個監督行程（計時器、RSS 上限、拆除梯度）都停住；寫不出去（非阻塞而滿了、或壞了）的丟掉、記數，監督行程自己的訊息與轉出的對話行程 stderr 都一樣，下次寫得出去時先講一句丟了多少。
- 對話行程的 leader 本身要是跑 V8 的 `node`（node 的旗標放在腳本前面；或用 `exec` 換成 node），不能多一層會留下來的外層行程（shell、`tsx` CLI）：外層不是以 SIGABRT 結束，heap 會判成 `crash`，RSS 量到的也是外層。
- 對話行程的 argv 是 `<程式> <--conversation-arg>... --socket <--run-dir>/c<序號>.sock`。`--run-dir` 不在就建成 0700；已存在就要是自己擁有、0700 的目錄；也不能長到 socket 路徑放不進 `sun_path`（108 bytes）。否則不起。
- 每個子行程自成一個行程群組，設 `PR_SET_PDEATHSIG`（SIGKILL）：監督行程被 SIGKILL，前台與對話行程跟著死。監督行程設了 `PR_SET_CHILD_SUBREAPER`，後代成了孤兒也由它收。
- 前台結束（不是停機）就隔 `--front-restart-ms` 重起；新的前台會先收到每條已經 `up` 的對話行程的 `up`。前台不在的期間要給它的訊息丟掉。
- 拆除梯度：關 stdin → `--eof-grace-ms` → 群組 SIGTERM → `--term-grace-ms` → 群組 SIGKILL；leader 結束時再對它的群組送一次 SIGKILL。RSS 超過上限與心跳斷了太久的不走梯度，當場對群組送 SIGKILL。
- 心跳：送出 `bind` 起開始計時，之後收到對話行程的任何一個框都算聽到。超過 `--stall-ms` 沒聽到就殺（死因 `stalled`）；判之前先讀一次它的控制通道，監督行程自己停住過時（fd 2 阻塞、被 SIGSTOP）回報可能還在管線裡。監督行程比預定晚了超過 `--stall-ms` 的一半才醒時，判定自己被停住過（通常是整棵樹一起被凍住：docker pause、cgroup freezer、VM 暫停），所有對話行程的沉默從醒來起重新算、記一行訊息；為了量得出來，有已送出 `bind` 的對話行程時，最晚每 `--stall-ms` 的四分之一醒一次，心跳間隔要小於這個值。`ready` 之前不判。對話行程從收到 `bind` 起每 1 s 送一次 `heartbeat`（`apps/harness/src/conversation-process.ts` 的 `HEARTBEAT_MS`），一直送到行程結束；`turn` 不參與判斷。`--stall-ms 0` 是不判。
- 容量（設計 §七）：同時活著的對話行程最多 `--capacity` 個，含預熱池、起動中與正在收的。沒給就算：⌊（記憶體上限 − 一半 − 19 − 150）÷ 209⌋（MiB），最少 1；記憶體上限取 `/proc/self/cgroup` 指到的 cgroup v2 目錄與它每一層上層的 `memory.max`，以及 `/proc/meminfo` 的 `MemTotal`，裡面最小的。起來時記一行算出的容量。19 MiB（監督行程）與 209 MiB（每條對話峰值）是研究量的，150 MiB（前台）是估的。
- 逐出：名額滿時，排著的每一條都要有一個正在收的行程讓出名額，不夠就挑閒置的送 `drain`：只讀開啟的先，同類裡閒置最久的先；閒置從對話行程回報 `idle` 的時間點（收到的時間減 `idleMs`）與最後一次被 `ensure` 要到的時間兩者較晚的算。挑不到的從最晚排進來的起回 `capacity(thread, current, limit)`。回 `drained` 就走拆除梯度收掉（死因 `evicted`），收完起排著的；回 `busy` 或 `--drain-timeout-ms` 內沒回答都不收。閒置超過 `--idle-ms`（只讀開啟的 `--read-only-idle-ms`）也送 `drain`；給 0 是不照時間逐出。`release(thread)` 是已經閒置就送 `drain`，還沒閒置就等它回報閒置再送。
- 只讀開啟：`ensure(thread, read-only)` 起的標成只讀；同一條 thread 收到 `ensure(run)` 或 `turn(begin)` 就轉成一般的。
- 預熱池：補到 `--warm` 個已經 `ready`、還沒綁 thread 的對話行程（0 是不預熱）；`ensure` 先從池裡拿，拿了再補。有排著的、名額滿、停機中都不補；池裡的沒綁就死了（或起不來），隔 `--front-restart-ms` 才再補。池裡的沒送 `bind`，不判 stalled。
- `stats(live, warm, rssKib, deaths)`：每 `--stats-ms` 送一次，前台（重）起時也送；`--stats-ms 0` 是不送。`live` 含預熱池，`rssKib` 是各 leader 最近一次輪詢到的 `VmRSS` 加總，`deaths` 是起來以來各類死因的累計（含預熱池裡的與沒起成的）。
- 死因（`down` 與稽核的 `cause`）：監督行程自己決定收的（停機、逐出、RSS 超過上限、心跳斷了太久、送了解不開的框或綁錯 thread）照那個理由，不再往下判；其餘的依下列：
  - `memory`：每 `--rss-poll-ms` 讀一次每條對話行程 leader 的 `VmRSS`（`/proc/<pid>/status`），超過 `--rss-limit-mb` 就殺它的群組。不給 `--rss-limit-mb` 就只記不殺。只量 leader（見已知限制）。
  - `heap`：以 SIGABRT 結束，而且 stderr 裡有一行以 `FATAL ERROR: ` 開頭、含 `JavaScript heap out of memory`、不超過 512 位元組，那一行的結尾又落在 stderr 的最後 16 KiB 內（node heap 用完時印的那一行；它後面還有約 1–3 KiB 的 stack trace）。夾在行中間的（例如轉印的工具輸出）、整行超長的、或印過之後又寫了超過 16 KiB 才死的，都不算。收屍時先把 stderr 管線裡剩下的再讀最多 1 MiB，才判。
  - `host-oom`：被 SIGKILL、監督行程沒決定收它，而且監督行程啟動時所在 cgroup（v2）的 `memory.events` 裡 `oom_kill` 比啟動時的值加上已經算掉的次數多：多一次只算給一個行程。讀不到 `memory.events`（不是 cgroup v2、沒開記憶體控制器、hybrid 主機的 v2 掛在別處）就一律算 `crash`。監督行程自己送 SIGKILL 的（RSS 超過上限、停機的最後一步）也會先算一次：核心搶先 OOM kill 了它時，那一次在這裡消掉，死因仍照監督行程的理由。
  - `stalled`：心跳斷了超過 `--stall-ms`。
  - `evicted`：回了 `drained`、被收掉的（見逐出）。
  - `crash`：其他自己結束或被殺的；`shutdown`：停機收掉的，含停機時還排著的 thread。
- 已知限制：
  - RSS 上限只管 leader：只讀 leader 自己的 `VmRSS`，不含任何子孫行程；spawner 與工具又各自 `setsid`，`memory` 的群組 SIGKILL 也打不到它們（[#2494](https://github.com/DemianLi/nexus-agent/issues/2494)）。
  - `host-oom` 的計數涵蓋整個 cgroup（含子 cgroup）：leader 以外的行程（前台、工具）被 OOM 殺掉也會讓計數加一，之後一條無關、被別人 SIGKILL 的對話行程會領走這一次，記成 `host-oom`。
  - 同一批收屍的幾條都被 SIGKILL 時，一次 OOM 歸給誰看收屍的順序，不一定是真正被 OOM 殺的那條。
  - 沒有單條對話的 CPU 上限：事件迴圈空轉的對話行程要到 `--stall-ms` 才被 `stalled` 殺掉，這段期間其他對話會變慢（S4 實測 p95 上升 7–91%）。壓住鄰居另做（[#2496](https://github.com/DemianLi/nexus-agent/issues/2496)）。CPU 吃在主執行緒以外（worker、工具子行程）時心跳照送，不會被殺，也沒有別的限制（讀程式推論，沒量過）。
  - 只有監督行程被停住超過 `--stall-ms` 的一半時（例如它自己被 SIGSTOP），也會把所有沉默重算，真的卡死的對話行程要多等最多 `--stall-ms` 才被殺。合法的同步阻塞做到一半時整棵樹被凍住，沉默加上凍住的時間超過 `--stall-ms` 仍會被殺。兩者都是讀程式推論，沒量過。
  - `ready` 之前（載插件、建根）不判 stalled，這一段卡死的對話行程會一直留著。
  - 監督行程卡在寫自己的 fd 2 超過 `--stall-ms` 時，就不再讀對話行程的 stderr；對話行程寫滿 64 KiB 的管線之後，如果 node 對管線是同步寫，它的事件迴圈也會卡住，醒來後被判成 `stalled`。這違反上面「監督行程的 stderr 一定要有人讀」的前提；node 對管線是不是同步寫沒核過。
  - V8 heap 快用完時，GC 可能連續空轉超過 `--stall-ms`，結果先被判成 `stalled` 而不是 `heap`。沒量過。
  - 容量算的是行程數，不看實際用掉的記憶體：每條對話實際用得比 209 MiB 多（例如掛了 MCP）時，名額還沒滿記憶體就先滿了。
  - 正在收的行程照樣佔名額：排著的 thread 要等 `drained` 之後的拆除梯度走完（最長 `--eof-grace-ms` 加 `--term-grace-ms`）才起。
  - 回 `busy` 或沒回答 `drain` 的，要等它下次回報 `idle` 才會再被挑；對話行程只在變成閒置的那一刻回報一次，所以一直閒著卻沒回答 `drain` 的，之後都不會再被逐出。讀程式推論，沒量過。
  - 收屍時讀到的 stderr 也包括群組外還活著的後代在 leader 死後寫的；寫得多時，會把 heap 那一行擠出最後 16 KiB，判成 `crash`。
- 稽核：每個行程結束寫一行 JSON 到 `--audit`（只追加、0600；已存在的要是自己擁有、0600 的一般檔，不能是連結，否則不起）：`ts_ms`、`role`（`conversation`／`front`）、`pid`、`exit_code`、`signal`；`thread`（預熱池裡還沒指派的是空字串）、`cause`、`turns`、`rss_kb`（輪詢看到的最高 RSS，KiB；沒量到是 0）、`max_silence_ms`（送出 `bind` 起相鄰兩次聽到之間最長的間隔，不含死前最後一段，也不含監督行程判定自己被停住過的那段）只有 `conversation` 有；沒起成的多一個 `error`。
- 結束碼：停機完成 0；起不來（signalfd、subreaper、`--run-dir`、`--audit`）或執行中 poll 失敗 1；參數錯 2。

整合測試 `tests/supervisor.rs` 用 `examples/fake_front.rs`、`examples/fake_conversation.rs` 兩支假程式站在前台與對話行程的位置。

## 建置與測試

需要 Linux。Mac 上用容器跑，例如：

```bash
docker run --rm --security-opt seccomp=unconfined -v "$PWD":/src -w /src -e CARGO_TARGET_DIR=/tmp/target rust:1.98.1-slim-bookworm cargo test --features test-hooks
```

- `--security-opt seccomp=unconfined`：拿掉 Docker 預設的 seccomp 設定檔，測試看到的拒絕才確定是 spawner 自己的過濾器擋的。
- `--features test-hooks`：只給整合測試用，可以把 Landlock ABI 壓低來造出 partial、讓子行程在 `setsid` 之前先睡一下。出貨的建置不帶它。
- `NEXUS_REQUIRE_LANDLOCK=1`：核心沒有 Landlock，或 ABI 不到 6 而驗不到訊號 scope 時，整合測試直接紅，不跳過。CI 會設。
- 出貨的是 musl 版：要對著它測，先 `rustup target add "$(uname -m)-unknown-linux-musl"`，再加 `--target "$(uname -m)-unknown-linux-musl"`。CI 兩種都跑：musl 那輪驗出貨的 libc；不帶 target 的那輪，測試用的 probe 是 glibc 程式，它的 `thread` 驗 glibc（2.34 起先試 `clone3`）拿到 ENOSYS 會退回 `clone`。

CI 的 `sandbox-spawner` job（`.github/workflows/ci.yml`，步驟在 `.github/actions/sandbox-spawner`）在動到這個目錄、動到 TS 那一側的接縫與 client、動到 CI、要打包的一輪（`packed-install` 跑的時候），以及合併後完整一輪時跑。`sandbox-spawner-arm64` 只在合併後完整一輪與發版時跑，在 arm64 的 runner 上原生編與測，不出貨。

## 出貨

Linux 的離線包帶 x64 的 release 執行檔，放在 `native/nexus-sandbox-spawner`：靜態連結 musl 的 static-pie（`x86_64-unknown-linux-musl`），不依賴主機的 glibc。`bundle.sh` 把執行檔與連進去的程式碼的授權全文打成 bundle，`pnpm run release:pack --spawner <目錄>` 原樣放進產物。bundle 的形狀與產物裡的檢查在 `scripts/release/spawner.ts`。授權全文有三個來源：

- crate：`cargo tree -e normal,no-proc-macro` 收到的，從 cargo 的 registry 原始碼複製；
- 標準函式庫：工具鏈的 `COPYRIGHT-library.html`；
- 工具鏈自帶、跟著標準函式庫連進執行檔的 C 函式庫：musl 與 LLVM libunwind，授權原文放在 `licenses/<名>-<版本>/`。

改了相依（`Cargo.lock`）就同步改 `scripts/release/spawner.ts` 的 `SPAWNER_CRATES`，再跑 `pnpm run gen-third-party-notices`。換了工具鏈，LLVM 或 musl 的版本跟著變：`bundle.sh` 對不上 `rustc -vV` 的 LLVM 版本就停；要換 `licenses/` 底下的原文與 `SPAWNER_NATIVE_LIBS`，再重產聲明檔。
