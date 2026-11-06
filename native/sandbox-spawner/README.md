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

同一個 crate 的第二支執行檔（#2340，`src/bin/nexus-supervisor.rs`，邏輯在 `src/supervisor/`）：起一個前台、按前台的要求每條 thread 起一個對話行程，管它們的生死，寫稽核紀錄。不裝 seccomp：前台要綁 port、對話行程要開 Unix socket 與連模型端點。還沒打進離線包。

```text
nexus-supervisor --run-dir <目錄> --audit <檔> --front <程式> [--front-arg <參數>]...
                 --conversation <程式> [--conversation-arg <參數>]...
                 [--eof-grace-ms 6000] [--term-grace-ms 3000] [--front-restart-ms 1000]
```

- 前台與對話行程的 stdin／stdout 是控制通道（框格式見上），stdout 只能寫框；stderr 照監督行程的。
- 對話行程的 argv 是 `<程式> <--conversation-arg>... --socket <--run-dir>/c<序號>.sock`。`--run-dir` 不在就建成 0700；已存在就要是自己擁有、0700 的目錄，否則不起。
- 每個子行程自成一個行程群組，設 `PR_SET_PDEATHSIG`（SIGKILL）：監督行程被 SIGKILL，前台與對話行程跟著死。監督行程設了 `PR_SET_CHILD_SUBREAPER`，後代成了孤兒也由它收。
- 前台結束（不是停機）就隔 `--front-restart-ms` 重起；新的前台會先收到每條已經 `up` 的對話行程的 `up`。前台不在的期間要給它的訊息丟掉。
- 拆除梯度：關 stdin → `--eof-grace-ms` → 群組 SIGTERM → `--term-grace-ms` → 群組 SIGKILL；leader 結束時再對它的群組送一次 SIGKILL。
- 稽核：每個行程結束寫一行 JSON 到 `--audit`（只追加、0600）：`ts_ms`、`role`（`conversation`／`front`）、`thread`、`pid`、`cause`、`turns`、`exit_code`、`signal`，沒起成的多一個 `error`。
- 結束碼：停機完成 0；起不來（`--run-dir`、`--audit`、signalfd）1；參數錯 2。

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
