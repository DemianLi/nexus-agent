# nexus-sandbox-spawner

工具子行程的沙箱（[#1946](https://github.com/DemianLi/nexus-agent/issues/1946)）：常駐的 Rust 行程，只在 Linux 上跑。

- 啟動時裝一次 seccomp，之後 fork 的子行程都繼承：擋網路（`AF_INET`、`AF_INET6`）、`AF_UNIX`、`AF_VSOCK`、io_uring、namespace 與 mount 系列，`clone3` 回 ENOSYS（`src/seccomp.rs`）。
- 每個子行程在 exec 之前各自上一份 Landlock。讀根、寫根由 Node 在每次要求裡帶來（`src/landlock.rs`）。全權模式不上 Landlock，seccomp 照樣繼承。
- Landlock 不能用（none）：spawner 照樣起，只有全權模式的要求起得來，其餘回 `SandboxUnavailable`。seccomp 裝不上：spawner 送 `Unavailable` 後結束。
- 核心沒有 `pidfd_open`（5.3 以前，ENOSYS）：起動就送 `Unavailable`，連全權模式也起不來。其他錯（例如 fd 用盡）不算，留給那一筆工具的 `Resource` 失敗。

單次模式 `--exec`：替自己上同一份 seccomp 與 Landlock 再 exec，給設定裡宣告要套沙箱的 MCP stdio server 用，一條連線起一次，stdio 由呼叫端接好。沒有 Landlock、seccomp 裝不上、讀根打不開都以 125 結束，不跑。沒有全權模式。讀根寫根要是 realpath，不是就拒絕，重起時路徑被換成連結也走不出去。Landlock 不到 ABI 6 時往 stderr 講一句。

協定（控制通道與 stdio 怎麼接）在 `src/protocol.rs` 與 `src/main.rs` 的檔頭。

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
