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

同一個 crate 的第二支執行檔（#2340，`src/bin/nexus-supervisor.rs`，邏輯在 `src/supervisor/`）：起一個前台、按前台的要求每條 thread 起一個對話行程，給了 `--host` 再起一個宿主，管它們的生死，寫稽核紀錄。不裝 seccomp：前台要綁 port、對話行程要開 Unix socket 與連模型端點。不在離線包裡。

```text
nexus-supervisor --run-dir <目錄> --audit <檔> --front <程式> [--front-arg <參數>]...
                 --conversation <程式> [--conversation-arg <參數>]...
                 [--eof-grace-ms 6000] [--term-grace-ms 3000] [--front-restart-ms 1000]
                 [--rss-limit-mb <MiB>] [--rss-poll-ms 250] [--stall-ms 15000]
                 [--capacity <條>] [--warm 1] [--idle-ms 7200000] [--read-only-idle-ms 300000]
                 [--drain-timeout-ms 5000] [--stats-ms 10000]
                 [--throttle-ms 2000] [--throttle-run-ms 25] [--throttle-stop-ms 75]
                 [--admission-timeout-ms 5000]
                 [--host <程式> [--host-arg <參數>]... [--host-backoff-ms 1000] [--host-backoff-max-ms 30000]
                  [--host-start-failures 5] [--host-stable-ms 60000] [--host-ready-timeout-ms 30000]]
```

- 前台與對話行程的 stdin／stdout 是控制通道（框格式見上），stdout 只能寫框。前台的 stderr 照監督行程的；對話行程的 stderr 接到監督行程，由它原樣轉到自己的 stderr，同時找 V8 heap 用完的訊息（見死因）；leader 收屍時再讀最多 1 MiB 就關掉，之後群組外還活著的後代寫的不轉出。**監督行程的 stderr 一定要有人讀**：它是阻塞的而沒人讀時，整個監督行程（計時器、RSS 上限、拆除梯度）都停住；寫不出去（非阻塞而滿了、或壞了）的丟掉、記數，監督行程自己的訊息與轉出的對話行程 stderr 都一樣，下次寫得出去時先講一句丟了多少。
- 對話行程的 leader 本身要是跑 V8 的 `node`（node 的旗標放在腳本前面；或用 `exec` 換成 node），不能多一層會留下來的外層行程（shell、`tsx` CLI）：外層不是以 SIGABRT 結束，heap 會判成 `crash`，RSS 量到的也是外層。
- 對話行程的 argv 是 `<程式> <--conversation-arg>... --socket <--run-dir>/c<序號>.sock`，有給 `--host` 時再加 `--host-socket <--run-dir>/host.sock`（就是宿主 bind 的那一個）。`--run-dir` 不在就建成 0700；已存在就要是自己擁有、0700 的目錄；也不能長到 socket 路徑放不進 `sun_path`（108 bytes）。否則不起。
- 每個子行程自成一個行程群組，設 `PR_SET_PDEATHSIG`（SIGKILL）：監督行程被 SIGKILL，前台與對話行程跟著死。監督行程設了 `PR_SET_CHILD_SUBREAPER`，後代成了孤兒也由它收。
- 每條控制通道的第一框都是 `hello`，協定版本是 `src/supervisor_protocol.rs` 的 `PROTOCOL_VERSION`：子行程一起來監督行程先送自己的，給前台與對話行程的帶連宿主用的 token（只在這一框，不放 env 也不放 argv）；子行程送來的第一框也要是版本相等的 `hello`。對話行程不是就當場 SIGKILL，死因 `protocol`；前台或宿主送來的解得開卻不是，就不重起，整台停機、回 3。第一框解不開的照壞框處置：前台殺掉重起，宿主殺掉、算一次 `ready` 之前的失敗。
- 前台結束（不是停機）就隔 `--front-restart-ms` 重起；新的前台會先收到每條已經 `up` 的對話行程的 `up`。前台不在的期間要給它的訊息丟掉。
- 拆除梯度：關 stdin → `--eof-grace-ms` → 群組 SIGTERM → `--term-grace-ms` → 群組 SIGKILL；leader 結束時再對它的群組送一次 SIGKILL。RSS 超過上限與心跳斷了太久的不走梯度，當場對群組送 SIGKILL。
- 宿主（`--host`，#2569）：見下面〈宿主 `nexus-host`〉。argv 是 `<程式> <--host-arg>... --socket <--run-dir>/host.sock`，stdin／stdout 是控制通道，stderr 照監督行程的。它送 `ready` 之後，監督行程把身分表（每個前台與對話行程一筆：pid、token、角色、綁的 thread）整張送過去；之後起的行程在 spawn 當下、把 token 交給它之前先送那一筆，指派 thread 時更新，收屍之前撤掉：撤銷寫進給宿主的 pipe 才收屍，500 ms 內寫不進去就殺掉宿主的群組。每一筆另帶一個序號：監督行程每 spawn 一個行程就發一個新的，pid 被重用之後的新行程不同。宿主回報某個 pid 違反協定（`violation`）時帶回那條連線所屬那一筆的序號；監督行程寫一行稽核，pid 與序號都對上現在的前台或對話行程的，就隔離到它結束，宿主重起重送的表裡也不再有它；剛隔離時，宿主 `ready` 了、沒在收的，也經同一條通道再送一次 `revoke`，蓋掉可能還排在監督行程這邊、沒寫出去的那一筆 `grant`。序號對不上的，是同一個 pid 號碼上一個行程的回報，只寫稽核。序號 0 是宿主表上沒有那個 pid 時、還沒送 `hello` 的連線報的：已經隔離的（那一筆撤掉了）照它的身分記；沒被隔離的只寫稽核，因為上一個行程在收屍之前寫進 pipe 的 0，讀到時重用同一個 pid 的新行程正是沒被隔離的。代價是那一筆還沒寫進宿主 pipe 的活行程在 `hello` 之前送壞框不會被隔離：那條連線已經斷了，那一筆到了之後再犯就帶它自己的序號。回報 pid 不在宿主表上（`unregistered`）的，是活著、沒被隔離的前台或對話行程就不算違規（那一筆還沒寫進宿主的 pipe：宿主剛起來或剛重起，或還排在監督行程這邊；或是撤銷之前就連上的連線：pid 被重用、同一個號碼上一個行程留下的，或重用得比宿主讀 pipe 快、新行程先連上的），只在監督行程的 stderr 記一行警告，帶 pid 與宿主的連線編號；其餘照違規記。宿主結束就照退避重起：第一次等 `--host-backoff-ms`，之後每次加倍到 `--host-backoff-max-ms`，活過 `--host-stable-ms` 才結束的回到起始。`ready` 之前的失敗（沒起成、`ready` 之前結束、`--host-ready-timeout-ms` 內沒 `ready`）連續 `--host-start-failures` 次，整台停機、回 4；`ready` 一次就歸零。`ready` 之後的失敗不算，只退避重起。宿主在 `ready` 之前報 `config-broken`，或回 4（插件清單壞了），稽核那一行的 `error` 是「宿主設定壞了：」接宿主報的那一句（沒收到 `config-broken` 就只有前半）。這個監督行程起來之後宿主還沒 `ready` 過的，設定錯每次重起都一樣，不重起，整台直接停機、回 5；`ready` 過的照退避重起（清單修好，下一次重起就接上），跟 `ready` 之後的失敗一樣不算進連續失敗的次數，不會讓整台停機。
- 停機（SIGINT／SIGTERM／SIGHUP）：① 送前台 `stop-admission`，等它回 `admission-stopped` 最多 `--admission-timeout-ms`（前台不在、或等的時候結束了就不等）；② 所有對話行程走拆除梯度；③ 全部收完之後宿主走一次；④ 宿主收完之後前台走一次。停機中再收到一次這些訊號，所有對話行程與宿主的群組當場 SIGKILL。
- 心跳：送出 `bind` 起開始計時，之後收到對話行程的任何一個框都算聽到。超過 `--stall-ms` 沒聽到就殺（死因 `stalled`；壓住期間只算放它跑的時間，見下一條）；判之前先讀一次它的控制通道，監督行程自己停住過時（fd 2 阻塞、被 SIGSTOP）回報可能還在管線裡。監督行程比預定晚了超過 `--stall-ms` 的一半才醒時，判定自己被停住過（通常是整棵樹一起被凍住：docker pause、cgroup freezer、VM 暫停），所有對話行程的沉默從醒來起重新算、記一行訊息；為了量得出來，有已送出 `bind` 的對話行程時，最晚每 `--stall-ms` 的四分之一醒一次，心跳間隔要小於這個值。`ready` 之前不判。對話行程從收到 `bind` 起每 1 s 送一次 `heartbeat`（`apps/harness/src/conversation-process.ts` 的 `HEARTBEAT_MS`），一直送到行程結束；`turn` 不參與判斷。`--stall-ms 0` 是不判。
- 壓住吃滿 CPU 的對話行程（#2496）：已經 `up`、沒在收、沒在等 `drain` 回答的對話行程，沉默滿 `--throttle-ms`，而且這段期間 leader 一直要 CPU（`/proc/<pid>/schedstat` 的在 CPU 上加上在可執行佇列上等的時間，至少是牆鐘的 0.9 倍），就對 leader 交替送 SIGSTOP（`--throttle-stop-ms`）與 SIGCONT（`--throttle-run-ms`），預設值下它只拿到約 run／(run＋stop)＝四分之一的 CPU。取樣跟著 `--rss-poll-ms`，取樣的跨度不到 `--throttle-ms` 的一半不判。聽到它任何一個框就 SIGCONT、不再壓；開始收（`drain`、拆除梯度）之前也先 SIGCONT。壓住期間 `stalled` 只算放它跑的時間：停住的時間不算沉默，真的卡死的要多等，預設值下約 2＋13×4＝54 s 才被殺。`bind` 到 `bound` 之間（冷開）不壓；沉默但不吃 CPU 的同步等待（`execSync`）不壓。訊號只送 leader，不送群組：監督行程在壓住期間死掉時，leader 靠 `PR_SET_PDEATHSIG` 被殺，群組裡被停住的子行程卻沒人叫醒。`--throttle-ms 0` 是不壓。
- 容量（設計 `.docs/supervisor-1947-design-2026-11-03.md` §七）：同時活著的對話行程最多 `--capacity` 個，含預熱池、起動中與正在收的。沒給就算：⌊（記憶體上限 − 一半 − 19 − 150）÷ 209⌋（MiB），最少 1；記憶體上限取 `/proc/self/cgroup` 指到的 cgroup v2 目錄與它每一層上層的 `memory.max`，以及 `/proc/meminfo` 的 `MemTotal`，裡面最小的；都讀不到就用 1。起來時記一行算出的容量（或讀不到上限）。19 MiB（監督行程）與 209 MiB（每條對話峰值）是研究量的，150 MiB（前台）是估的。
- 逐出：名額滿時，排著的每一條都要有一個正在收、或在等 `drain` 回答的行程讓出名額，不夠就挑閒置的送 `drain`：只讀開啟的先，同類裡閒置最久的先；閒置從對話行程回報 `idle` 的時間點（收到的時間減 `idleMs`）與最後一次被 `ensure` 要到的時間兩者較晚的算。挑不到的從最晚排進來的起回 `capacity(thread, current, limit)`。回 `drained` 就走拆除梯度收掉（死因 `evicted`；逾時之後才到的也照收），收完照排隊順序起排著的；回 `busy` 或 `--drain-timeout-ms` 內沒回答都不收。在等 `drain` 回答時又被 `ensure` 的 thread：回 `busy` 或逾時就回 `up`；回 `drained` 就先收到 `down(evicted)`，再跟其他排著的一起重算名額，沒名額回 `capacity`。等回答的這段期間，它跟自己的行程互抵，不算排著的、也不算讓出名額，不會被回 `capacity`；別的行程結束讓出的名額也不會拿去替它起第二個行程，要等它自己的行程回答（或收完）。這條 thread 的行程回了 `drained`、還在收時又被 `ensure`，也排進隊伍，跟其他排著的一起重算名額：有名額就等它收完，先回 `down(evicted)` 再照排隊順序起；沒名額當場回 `capacity`，收完照樣送 `down(evicted)`。死因是別的（`stalled`、`memory`、`crash`）、正在收、又沒在等 `drain` 回答的不理，收完回的 `down` 就是回答。已經在排的再被 `ensure`（含它自己的行程在等 `drain` 回答、或還在收的期間），只把開啟方式升成 `run`。閒置超過 `--idle-ms`（只讀開啟的 `--read-only-idle-ms`）也送 `drain`；給 0 是不照時間逐出。`release(thread)` 只收只讀開啟的：已經閒置就送 `drain`，還沒閒置（含正在等 `drain` 回答、後來回了 `busy` 或逾時的）就等它回報閒置再送，之間再被 `ensure` 或收到 `turn(begin)` 就作廢。已經轉成一般的（收到過 `ensure(run)` 或 `turn(begin)`；目標輪與背景子代理結算後在主對話開的輪都算，子代理自己的輪不算）不理，照 `--idle-ms` 收：`turn(begin)` 只有監督行程看得到，所以由它判斷；前台只在等 `ensure` 回答時記著送出的開啟方式，回答之後就不記。
- 只讀開啟：`ensure(thread, read-only)` 起的標成只讀；同一條 thread 收到 `ensure(run)` 或 `turn(begin)` 就轉成一般的。
- 預熱池：補到 `--warm` 個還沒綁 thread 的對話行程（含還在起的）（0 是不預熱）；`ensure` 先從池裡拿，拿了再補。有排著的、名額滿、停機中都不補；池裡的沒綁就死了（或起不來），隔 `--front-restart-ms` 才再補。池裡的沒送 `bind`，不判 stalled。
- `stats(live, warm, rssKib, deaths)`：每 `--stats-ms` 送一次，前台（重）起時也送；`--stats-ms 0` 是不送。`live` 含預熱池、起動中與正在收的，`rssKib` 是各 leader 最近一次輪詢到的 `VmRSS` 加總，`deaths` 是起來以來各類死因的累計（含預熱池裡的與沒起成的）。
- 死因（`down` 與稽核的 `cause`）：監督行程自己決定收的（停機、逐出、RSS 超過上限、心跳斷了太久、送了解不開的框或綁錯 thread、第一框不是對的 `hello`）照那個理由，不再往下判；其餘的依下列：
  - `memory`：每 `--rss-poll-ms` 讀一次每條對話行程 leader 的 `VmRSS`（`/proc/<pid>/status`），超過 `--rss-limit-mb` 就殺它的群組。不給 `--rss-limit-mb` 就只記不殺。只量 leader（見已知限制）。
  - `heap`：以 SIGABRT 結束，而且 stderr 裡有一行以 `FATAL ERROR: ` 開頭、含 `JavaScript heap out of memory`、不超過 512 位元組，那一行的結尾又落在 stderr 的最後 16 KiB 內（node heap 用完時印的那一行；它後面還有約 1–3 KiB 的 stack trace）。夾在行中間的（例如轉印的工具輸出）、整行超長的、或印過之後又寫了超過 16 KiB 才死的，都不算。收屍時先把 stderr 管線裡剩下的再讀最多 1 MiB，才判。
  - `host-oom`：被 SIGKILL、監督行程沒決定收它，而且監督行程啟動時所在 cgroup（v2）的 `memory.events` 裡 `oom_kill` 比啟動時的值加上已經算掉的次數多：多一次只算給一個行程。讀不到 `memory.events`（不是 cgroup v2、沒開記憶體控制器、hybrid 主機的 v2 掛在別處）就一律算 `crash`。監督行程自己送 SIGKILL 的（RSS 超過上限、停機的最後一步）也會先算一次：核心搶先 OOM kill 了它時，那一次在這裡消掉，死因仍照監督行程的理由。
  - `stalled`：心跳斷了超過 `--stall-ms`。
  - `evicted`：回了 `drained`、被收掉的（見逐出）。
  - `protocol`：第一框不是版本相等的 `hello`。
  - `crash`：其他自己結束或被殺的；`shutdown`：停機收掉的。停機時還排著的 thread 只回 `down(shutdown)`，不寫稽核，也不算進 `deaths`；那條 thread 還有行程（例如在等它回答 `drain`）的，只在那個行程結束時回一次。
- 已知限制：
  - RSS 上限只管 leader：只讀 leader 自己的 `VmRSS`，不含任何子孫行程；spawner 與工具又各自 `setsid`，`memory` 的群組 SIGKILL 也打不到它們（[#2494](https://github.com/DemianLi/nexus-agent/issues/2494)）。
  - `host-oom` 的計數涵蓋整個 cgroup（含子 cgroup）：leader 以外的行程（前台、工具）被 OOM 殺掉也會讓計數加一，之後一條無關、被別人 SIGKILL 的對話行程會領走這一次，記成 `host-oom`。
  - 同一批收屍的幾條都被 SIGKILL 時，一次 OOM 歸給誰看收屍的順序，不一定是真正被 OOM 殺的那條。
  - 壓制只管沉默的 leader：CPU 吃在主執行緒以外（worker）時心跳照送，不壓也不殺（讀程式推論，沒量過）。SIGSTOP 只送 leader，同群組裡吃 CPU 的子行程壓不到；觸發也只看 leader 的 schedstat，本來就不看它們。spawner 與工具各自 `setsid`，更打不到（[#2494](https://github.com/DemianLi/nexus-agent/issues/2494) 同一件事）。沉默 `--throttle-ms` 之前的那一段照樣吃滿 CPU。有 CPU 配額（cgroup `cpu.max`）時，放它跑的那四分之一仍吃同一份配額，鄰居照樣變慢（S4 量的見設計 §6-1）。冷開失敗之後由後來的請求重建 thread 時已經 `up`，那段同步工作沉默滿 `--throttle-ms` 也會被壓，牆鐘約拉長成 4 倍；沉默只算放它跑的時間，所以不會因此被判 `stalled`（讀程式推論，沒量過）。
  - 只有監督行程被停住超過 `--stall-ms` 的一半時（例如它自己被 SIGSTOP），也會把所有沉默重算，真的卡死的對話行程要多等最多 `--stall-ms` 才被殺。合法的同步阻塞做到一半時整棵樹被凍住，沉默加上凍住的時間超過 `--stall-ms` 仍會被殺。兩者都是讀程式推論，沒量過。
  - `ready` 之前（載插件、建根）不判 stalled，這一段卡死的對話行程會一直留著。
  - 監督行程卡在寫自己的 fd 2 超過 `--stall-ms` 時，就不再讀對話行程的 stderr；對話行程寫滿 64 KiB 的管線之後，如果 node 對管線是同步寫，它的事件迴圈也會卡住，醒來後被判成 `stalled`。這違反上面「監督行程的 stderr 一定要有人讀」的前提；node 對管線是不是同步寫沒核過。
  - V8 heap 快用完時，GC 可能連續空轉超過 `--stall-ms`，結果先被判成 `stalled` 而不是 `heap`。沒量過。
  - 容量算的是行程數，不看實際用掉的記憶體：每條對話實際用得比 209 MiB 多（例如掛了 MCP）時，名額還沒滿記憶體就先滿了。
  - 正在收的行程照樣佔名額：排著的 thread 要等 `drained` 之後的拆除梯度走完（最長 `--eof-grace-ms` 加 `--term-grace-ms`）才起。
  - 回 `busy` 或沒回答 `drain` 的，要等它下次回報 `idle` 才會再被挑。對話行程（`apps/harness/src/conversation-control.ts`）在變成閒置時送 `idle`，閒置期間最後活動時間往前推了才再送；所以一直閒著、沒有新活動又沒回答 `drain` 的，之後不會再被逐出。讀程式推論，沒量過。
  - 名額滿而送出的 `drain` 不撤回：排著的 thread 先被別的行程結束讓出的名額起掉之後，那個 `drain` 仍會照常收掉一條閒置的對話，多逐出一條。對話行程的協定沒有「取消 drain」。
  - 收到 `turn(begin)` 不清掉閒置記號：正在跑一輪的對話仍可能被挑中送 `drain`，靠對話行程收到 `drain` 時當場再判一次、回 `busy` 擋下（`apps/harness/src/conversation-control.ts`）。讀程式推論，沒量過。
  - 收屍時讀到的 stderr 也包括群組外還活著的後代在 leader 死後寫的；寫得多時，會把 heap 那一行擠出最後 16 KiB，判成 `crash`。
- 稽核：每個行程結束寫一行 JSON 到 `--audit`（只追加、0600；已存在的要是自己擁有、0600 的一般檔，不能是連結，否則不起）：`ts_ms`、`role`（`conversation`／`front`／`host`）、`pid`、`exit_code`、`signal`；`ready`（結束前送過 `ready` 沒有）只有 `host` 有；`thread`（預熱池裡還沒指派的是空字串）、`cause`、`turns`、`rss_kb`（輪詢看到的最高 RSS，KiB；沒量到是 0）、`max_silence_ms`（送出 `bind` 起相鄰兩次聽到之間最長的間隔，不含死前最後一段，也不含監督行程判定自己被停住過的那段）只有 `conversation` 有；沒起成的，與宿主 `ready` 之前逾時、插件清單壞了的，多一個 `error`。宿主回報的違反協定另寫一行：`ts_ms`、`event`（`protocol`）、`pid`、`role`（那個 pid 在身分表上是 `front`、`conversation`，不在表上是 `unknown`）、`thread`、`reason`。欄位與值只加不改，讀的人照 `role` 或 `event` 分辨每一行。
- 結束碼：停機完成 0；起不來（signalfd、subreaper、`--run-dir`、`--audit`）或執行中 poll 失敗 1；參數錯 2；前台或宿主的 `hello` 對不上 3；宿主在 `ready` 之前連續失敗 4；這個監督行程起來之後宿主還沒 `ready` 過、插件清單就壞了 5。

整合測試 `tests/supervisor.rs` 用 `examples/fake_front.rs`、`examples/fake_conversation.rs`、`examples/fake_host.rs` 三支假程式站在前台、對話行程與宿主的位置；真宿主的端到端也在這裡。

## 宿主 `nexus-host`

同一個 crate 的第三支執行檔（#2569，`src/bin/nexus-host.rs`，邏輯在 `src/host/`），由監督行程起、整台一個，聽 `--socket` 給的 Unix socket，驗明連進來的是誰。不裝 seccomp。

```text
nexus-host [--plugins <檔>] --socket <路徑>
```

- 插件清單（`--plugins`，`src/host/plugins.rs`）：跟監督行程換完 `hello`、bind socket 之前讀。JSON 陣列，一列一個插件：`name`（必填，編進執行檔的插件名；出貨的建置還沒有任何一支）、`config`（選填，原封不動交給插件，裡面的鍵由插件自己判）、`disabled`（選填，只收字面布林；`null` 當沒寫）。沒帶 `--plugins`，或檔案不存在，是空樹。檔案讀不了、超過 1 MiB、JSON 壞了，或哪一列少了 `name`、是不認得的鍵、名字對不上、型別不對，整份拒絕：寫一行 stderr、送 `config-broken`（帶同一句錯誤）取代 `ready`、回 4，不 bind。`intercept` 還沒做（#2596），寫了一樣整份拒絕，錯誤指到那張卡。插件自己不收它的 `config` 的，只有那一列沒掛（寫一行 stderr），其他照掛。插件的每一筆事件（狀態轉換、apply 失敗…）寫一行 stderr。整合測試用的 `test-echo` 只在 `test-hooks` 的建置裡有。

- 控制通道（stdin／stdout）：起來先送 `hello`，等到監督行程版本相等的 `hello` 才 bind socket（版本不對回 3，`hello` 之前 EOF 回 1）；bind 好送 `ready`；插件清單壞了的改送 `config-broken`，不 bind（見上一條）。之後收身分表的 `grant`／`revoke`，回報 `violation`／`unregistered`。stdin 讀到 EOF 或讀不下去（控制通道送來超長的框）就刪 socket、回 0。
- 連線的框格式同控制通道（u32 LE 長度＋內容），內容是 JSON，協定在 `src/host_protocol.rs`，向量檔 `host-vectors.json`。客戶端第一框送 `{"type":"hello","version":…,"token":"…"}`，宿主回 `{"type":"hello","version":…}` 或 `{"type":"rejected","reason":"…"}`。版本是 `HOST_PROTOCOL_VERSION`（4），跟控制通道的版本各自獨立；不用 3（那是控制通道的版本）：客戶端送 3 進來會被判版本不對。上限：一框 256 KiB、JSON 巢狀 32 層、一條連線最多緩衝 2 框；連線最多 1024 條（收監督行程的 `revoke` 時收 backlog 不受這個上限），宿主起來時把開檔數的軟上限拉到硬上限；連上 5 s 內沒送 `hello` 就斷。開檔數還是用完時，排著的連線接下來就關（宿主先留著一個 fd，用完時關掉它騰出位子），不留在 backlog、也不空轉；連那個 fd 都開不回來（整台主機的 fd 用完）、或 backlog 收空了，停 100 ms 不 poll listener 再試（收 `revoke` 時照樣收 backlog）；EMFILE、ENFILE 以外的 accept 錯也一樣停 100 ms。
- 呼叫（`src/host/calls.rs`）：驗過身分之後，客戶端送 `call`（`side`、`id`、`service`、`method`、`payload`）與 `cancel`（`side`、`id`）；宿主回 `chunk`（`seq` 從 0 起）與 `result`（`ok` 或 `error{code,message}`），並主動推 `event`（`service`、`topic`、`payload`）給服務指名的那一條連線（它的某個呼叫所在的連線），不廣播。只傳資料。
  - 服務是插件用 `Cx::expose` 提供的（`src/kernel/remote.rs`），照服務名找；沒有就回 `unknown_service`，沒有那個方法回 `unknown_method`。
  - 每個 `id` 剛好一框 `result`，取消的也有（`cancelled`）；`cancel` 已經結束或不存在的 `id` 不回。結束了的 `id` 可以再用。
  - 一條連線同時最多 64 個呼叫，再來的回 `busy`。一塊或結果編出來超過一框回 `too_large`，大的結果由服務自己切塊串流。排著沒寫出去的到了 1 MiB，先不 poll 那條連線的呼叫，也先不讀它送來的框，排著的降回 1 MiB 以下就恢復；一次讀進來的框照序處理，停下時剩的留著，恢復後接著處理。
  - 服務在一步裡推的塊加起來超過 1 MiB，超過的那一塊起不送（前面的照送），那個呼叫回 `service_error`，服務還當它在跑的話在服務那邊取消。事件不受讀端暫停管：要推給的連線排著的已經到了 2 MiB、又有事件要推，就斷掉那條連線，不丟掉那個事件；客戶端重連後要再發呼叫，服務才知道新的連線。單一事件編出來超過一框的不送，宿主只記一行 log，連線不斷。
  - 綁定跟著連線走：連線一斷，它還在跑的呼叫在服務那邊全部取消，宿主不記跨連線的東西。提供服務的插件卸載或換了實體，還在跑的呼叫回 `service_error`。
  - `side` 是 `id` 由哪一邊發的，`"h"` 保留給宿主發起的請求，宿主收到 `"h"` 的 `call`／`cancel` 判違規。還沒送 `hello` 就送 `call`／`cancel`、還在跑的 `id` 又送一次，也判違規（照下面狀態表「壞框」那一欄）。
- 驗身分：用 `SO_PEERCRED` 取連線的 pid（uid 要跟宿主相同），驗 `hello` 之前先把控制通道讀乾淨，所以監督行程已經寫進 pipe 的撤銷一定先生效。客戶端報的 thread 不看。
  - pid 不在表上：回 `rejected`、報 `unregistered`（帶 pid 與連線編號，編號依 accept 的順序從 1 起，宿主自己的 stderr 也寫它），表上沒有它可以撤；算不算違規由監督行程判斷。
  - token 或版本不對、重複的 `hello`、框太大、JSON 或訊息解不開（送的若是撤過的連線，見下一條）：回 `rejected`、報 `violation`，把那個 pid 從表上拿掉，它其他驗過身分的連線一起斷，還沒送 `hello` 的記成撤過。
  - 撤過的連線：收到監督行程的 `revoke` 時先把 listen backlog 收完，那個 pid 的連線全部記成撤過（驗過身分的當場斷）；上一條的違規也一樣記，只是不收 backlog。撤過的連線之後送什麼都只回 `rejected`、報 `unregistered`，同一個 pid 號碼再登記也不照新的那一筆驗，也不撤它。pid 被重用得比宿主讀 pipe 還快時，新行程先連上的連線也會這樣被拒，重連就好（不會被隔離）。
- 整合測試 `tests/host.rs` 由測試站在監督行程的位置；`examples/host_client.rs` 是另一個 pid 的客戶端，`tests/spawner.rs` 用它驗工具子行程連不了 socket（seccomp 擋 `socket(AF_UNIX)`，回 EPERM）。

### 連線身分的狀態表

一條連線在宿主這邊的狀態：

- **B**：還在 listen backlog，宿主還沒 accept。
- **A⁺**：已 accept、還沒送 `hello`，pid 在表上。
- **A⁻**：同上，pid 不在表上。
- **A⁰**：同上，`SO_PEERCRED` 讀不到 pid 或 uid 不同。
- **V**：已驗過身分。
- **R**：撤過。驗過身分的連線一被撤就斷，所以留在這一格的都還沒送過 `hello`。

宿主每驗一個 `hello`、每判一次違規，都先把控制通道讀乾淨，所以已經寫進 pipe 的 `revoke`／`grant` 一定先生效。表裡的「撤 pid」是宿主自己撤：表上拿掉那一筆，那個 pid 的連線全部記成撤過，驗過身分的當場斷，不收 backlog（這四件事各由哪條測試釘住見 [n8]）。

**宿主這邊**（方括號是釘住這一格的測試，n 開頭的是不測的原因，見下面的清單）

| 狀態 | `hello`，token 與版本都對 | `hello`，token 或版本錯 | 壞框（框太大、解不開） | 重複的 `hello` | 監督行程的 `revoke` | 同 pid 的新登記 | EOF／5 s 沒送 `hello` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B | accept 之後照 A 那幾列 [n5] | 同左 | 同左 | — | 先收進來，記成撤過，變 R [t8]；accept 出錯的除外 [n3] | accept 之後照 A⁺ [n5] | accept 之後照 A [n5] |
| A⁺ | 回 `hello`，變 V，不報 [t1] | 回 `rejected token 不對`／`版本不對`，報 `violation`，撤 pid [t2] | 回 `rejected <理由>`，報 `violation`，撤 pid [t3] | — | 變 R，不回 [t5][t6] | 整筆換掉，之後照新的驗 [t11] | 斷，不報 [t15][n4] |
| A⁻ | 回 `rejected 沒有登記`，報 `unregistered` [t9][t17] | 同左（不看 token 與版本）[t17][t18] | 回 `rejected <理由>`，報 `violation`，撤 pid [t13] | — | 變 R [t12] | 變 A⁺ [t11] | 斷，不報 [t15][t16] |
| A⁰ | 回 `rejected 沒有登記`，報 `unregistered`，pid 0 [n1] | 同左 [n1] | 回 `rejected <理由>`，報 `violation`，pid 0，沒有 pid 可撤 [n1] | — | 不適用 | 不適用 | 斷，不報 [n1] |
| V | — | — | 回 `rejected <理由>`，報 `violation`，撤 pid [t14]；撤銷剛好在路上時見 [n6] | 回 `rejected 重複的 hello`，報 `violation`，撤 pid [t1]；token 與版本不看 [t18]；撤銷剛好在路上時見 [n6] | 斷，不回、不報 [t4] | 照樣連著，不重驗 [t11] | 斷，不報 [t15] |
| R | 回 `rejected 沒有登記`，報 `unregistered` [t5][t6][t8]，不撤表上那一筆 [t12] | 同左（不看 token 與版本）[t18] | 回 `rejected <理由>`，報 `unregistered`（理由照框），不撤表上那一筆 [t7] | — | 照舊是 R [t15] | 照舊是 R，不照新的驗 [t6][t8] | 斷，不報 [t15] |

**監督行程這邊**（宿主的回報 × 那個 pid 是誰）

| 回報 | 活著、沒被隔離的前台或對話行程 [n7] | 已隔離的 | 不是我們的（含 pid 0） |
| --- | --- | --- | --- |
| `violation` | 隔離到它結束；寫 `protocol` 稽核（`role` 是 `front`／`conversation`）；宿主 `ready` 了、沒在停，就補送 `revoke`；不記警告 [s1][s2][n2]；宿主重起重送的表裡沒有它 [s9]；序號對不上的、序號 0 的照最右邊「不是我們的」那一格 [s10][s12][s13] | 再寫一行稽核，只在剛隔離時送過那一次 `revoke` [s3]；序號 0 的也照它的身分記 [s11]；不記警告 [s4] | 寫稽核，`role` 是 `unknown`；不隔離、不記警告、不送 `revoke` [s5][s8] |
| `unregistered` | 不隔離、不寫稽核；運作 log（監督行程的 stderr）記一行警告，帶 pid 與宿主的連線編號，不帶 token [s6] | 照 `violation` 那一格，稽核的理由是宿主回給連線的 [s4][s7] | 照 `violation` 那一格 [s5][s8] |

**釘住各格的測試**（`tests/host.rs` 是 t，`tests/supervisor.rs` 與 `src/supervisor/mod.rs` 的單元測試是 s）

- t1 `a_granted_pid_with_its_token_gets_hello_and_a_second_hello_is_a_violation`
- t2 `a_wrong_token_or_version_quarantines_the_pid_and_drops_its_other_connections`
- t3 `every_invalid_vector_is_rejected_and_the_host_keeps_serving`
- t4 `a_hello_after_a_revoke_is_always_rejected`
- t5 `a_revoke_leaves_connections_that_have_not_said_hello_to_be_rejected`
- t6 `a_connection_from_before_a_revoke_is_not_verified_against_a_later_grant`
- t7 `a_bad_frame_on_a_revoked_connection_leaves_a_later_grant_alone`
- t8 `a_connection_still_in_the_backlog_at_a_revoke_is_not_verified_against_a_later_grant`
- t9 `unregistered_reports_number_each_connection`
- t10 `the_host_raises_its_open_file_soft_limit_to_the_hard_limit`（n3 的前提）
- t11 `a_regrant_replaces_the_token_and_keeps_verified_connections`
- t12 `a_connection_from_a_pid_not_on_the_table_is_also_marked_by_a_revoke`
- t13 `a_bad_frame_from_a_pid_that_is_not_on_the_table_is_a_violation`
- t14 `a_bad_frame_after_hello_quarantines_the_pid`
- t15 `a_connection_that_closes_reports_nothing_and_leaves_the_grant`（A⁻、A⁺、V、R 的 EOF，與 R 撤兩次再登記）
- t16 `a_client_that_never_says_hello_is_dropped`（A⁻ 逾時）
- t17 `an_unsandboxed_mcp_server_with_a_stolen_token_is_rejected`（別的 pid 拿正主的 token）
- t18 `a_hello_is_judged_by_the_connection_state_before_its_version_or_token`（A⁻、R 送錯版本與 token，V 送錯版本與 token 的重複 `hello`）
- t19 `a_violation_carries_the_generation_of_the_grant_it_belongs_to`（`violation` 帶的序號：V 是驗它時那一筆的，A⁺ 是表上現在那一筆的；A⁻ 是 0，由 t13）
- t20 `running_out_of_fds_closes_queued_connections_instead_of_spinning`（n3）
- s1 `a_violation_revokes_the_live_identity_on_the_host`
- s2 `conversations_reach_the_host_and_violations_are_audited_and_quarantined`
- s3 `a_second_violation_for_a_quarantined_conversation_is_audited_but_not_revoked_again`（收屍之後數 `revoke`：隔離一次、收屍一次）
- s4 `a_quarantined_conversation_is_audited_on_every_later_rejection`
- s5 `a_connection_from_a_pid_that_is_not_ours_is_audited_as_unknown`
- s6 `an_unregistered_report_for_a_live_conversation_neither_quarantines_nor_audits`
- s7 `an_unregistered_report_for_a_quarantined_conversation_is_audited_with_the_hosts_reason`（假宿主報的理由不是「沒有登記」，理由寫死就紅）
- s8 `reports_for_a_pid_that_is_not_ours_send_no_revoke`（pid 0；非 0 的表外 pid 走同一道 `role` 判斷，讀碼）
- s9 `a_quarantined_conversation_is_left_out_of_the_table_sent_to_a_restarted_host`
- s10 `a_violation_with_a_stale_generation_neither_quarantines_nor_revokes`
- s11 `a_zero_generation_violation_for_a_quarantined_conversation_keeps_its_role`（序號 0：撤銷之後宿主表上沒有它，還沒送 `hello` 的連線報的就是 0）
- s12 `a_zero_generation_violation_for_a_conversation_that_is_not_quarantined_is_only_audited`（序號 0：宿主在上一個行程收屍之前回報的，或那一筆還沒寫進宿主 pipe 的活行程）
- s13 `a_zero_generation_read_after_the_pid_is_reused_does_not_inherit_the_quarantine`（`src/supervisor/mod.rs` 的單元測試：pid 重用在整合測試造不出來，直接建監督行程，P1 隔離、收屍，P2 重用 pid 後讀到 0）

**不測的格與原因**

- n1 A⁰：要另一個 uid 的行程才造得出來；CI 的 `cargo test` 不用 root 跑（`ubuntu-latest`、沒有 container），測試行程換不了 uid，測試也不另用 sudo 或容器開 uid。程式只有一條路：`pid` 是 `None` 時查不到表，`hello` 走 `unregistered`，壞框走 `violation` 且沒有 pid 可撤。
- n2 宿主沒 `ready` 或正在停時不補送 `revoke`：`ready` 之前宿主還沒有 socket，不會有回報；正在停時，監督行程已經對宿主的 stdin 叫了 `finish`，或當場關了寫端並殺掉它的群組（`kill_now`）：就算送了，寫端關了之後補送的 `revoke` 也直接丟掉；只有 `finish` 當下還有排著沒寫完的，它會排在後面、在 EOF 之前被宿主讀到，宿主接著讀到 EOF 就結束。這段窗口測試造不穩。
- n3 開檔數用完：t20 把宿主的軟硬上限壓到 12 與 13（每條連線 2 個 fd，兩個相鄰的上限裡一定有一個走到 EMFILE），確認排著的連線被關掉、宿主 1 秒內用不到 20 個 tick、fd 空出來之後照常收連線。整台主機的 fd 用完、預留的 fd 開不回來的退避沒有測試：要把整台主機的 fd 用完。
- n4 A⁺、R 的 5 s 逾時：跟 A⁻ 同一行判斷（`retain` 只看有沒有送過 `hello` 與連上多久，不看表），只測 A⁻（t16）。
- n5 B 的「accept 之後照 A」沒有專門的測試：每條測試的連線都先經過 backlog 才被 accept。新登記只改表、不碰連線，`hello` 驗的是驗那一刻的表（先讀乾淨控制通道），所以登記在 accept 之前或之後到，結果一樣；accept 不讀資料，EOF 照 A 那幾列的 `retain` 處理（讀碼）。
- n6 已驗過身分的連線送重複的 `hello` 或壞框時，撤銷剛好已經寫進 pipe、宿主還沒讀：宿主先讀乾淨控制通道，這條連線先變成撤過，結果跟 R 那一列的壞框格一樣：回 `rejected`、報 `unregistered`，理由照違規（`重複的 hello` 或框的錯），不撤表上那一筆。窗口只有幾行程式，測試造不穩。
- n7 前台的格跟對話行程走同一段程式（`role` 換成 `front`），監督行程這邊的測試只用對話行程。
- n8 「撤 pid」的前三件在 `Host::revoke`；不收 backlog 是因為違規時 `violate` 直接呼叫它，收監督行程的 `revoke` 時才由 `Host::sync` 先 `accept(usize::MAX)` 再呼叫它。表上拿掉由 t1、t2、t3、t14 釘住；還沒送 `hello` 的記成撤過由 t13、t18；驗過身分的斷由 t2；不收 backlog 沒有測試，要讓連線停在 backlog 得先把連線數撐到上限（t8 的做法），沒另外造。

**已知限制**

- pid 被重用得比宿主讀 pipe 還快時，新行程先連上的連線也會在收到 `revoke` 時被記成撤過，照 R 那一列被拒，要重連；它不會被隔離。
- 收 `revoke` 時 accept 出錯、又沒能把那條連線接下來關掉（整台主機的 fd 用完，預留的 fd 開不回來；或 EMFILE、ENFILE 以外的錯）而留在 backlog 的連線，不會記成撤過，之後被 accept 時照當下的表驗。它若是死掉的行程留下、還被子孫拿著的，pid 被重用之後送舊 token，報的 `violation` 帶的是新行程那一筆的序號，會落在新行程頭上（還沒送 `hello` 的報 0，只寫稽核）。
- 收屍時宿主還沒 `ready`（剛起來或剛重起、監督行程還沒處理它的 `ready`）就不送撤銷：新宿主 bind 之後連上、在監督行程處理它的 `ready` 之前就被收屍的行程，它留下的連線不會記成撤過。pid 被重用、新行程那一筆到了之後它才送舊 token 或壞框，報的 `violation` 帶新行程的序號，會落在新行程頭上。
- 不是我們起、但跟我們同 uid 的行程，它死後留下的 A⁻ 連線送 `hello` 或壞框，報的 `violation` 會落在重用同一個 pid 的新行程頭上。同 uid 的行程本來就在信任範圍內（能讀別的行程的記憶體），不修。

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
