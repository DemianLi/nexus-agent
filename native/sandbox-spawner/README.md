# nexus-sandbox-spawner

工具子行程的沙箱（[#1946](https://github.com/DemianLi/nexus-agent/issues/1946)）：常駐的 Rust 行程，只在 Linux 上跑。

- 啟動時裝一次 seccomp，之後 fork 的子行程都繼承：擋網路（`AF_INET`、`AF_INET6`）、`AF_UNIX`、`AF_VSOCK`、io_uring、namespace 與 mount 系列，`clone3` 回 ENOSYS（`src/seccomp.rs`）。
- 每個子行程在 exec 之前各自上一份 Landlock。讀根、寫根由 Node 在每次要求裡帶來（`src/landlock.rs`）。
- Landlock 不能用、seccomp 裝不上：spawner 送 `Unavailable` 後結束，Node 對工具回 `SANDBOX_UNAVAILABLE`。

協定（控制通道與 stdio 怎麼接）在 `src/protocol.rs` 與 `src/main.rs` 的檔頭。

## 建置與測試

需要 Linux。Mac 上用容器跑，例如：

```bash
docker run --rm --security-opt seccomp=unconfined -v "$PWD":/src -w /src -e CARGO_TARGET_DIR=/tmp/target rust:1.98.1-slim-bookworm cargo test --features test-hooks
```

- `--security-opt seccomp=unconfined`：拿掉 Docker 預設的 seccomp 設定檔，測試看到的拒絕才確定是 spawner 自己的過濾器擋的。
- `--features test-hooks`：只給整合測試用，可以把 Landlock ABI 壓低來造出 partial、讓子行程在 `setsid` 之前先睡一下。出貨的建置不帶它。
- `NEXUS_REQUIRE_LANDLOCK=1`：核心沒有 Landlock 時，整合測試直接紅，不跳過。CI 會設。

CI 的 `sandbox-spawner` job（`.github/workflows/ci.yml`，步驟在 `.github/actions/sandbox-spawner`）在動到這個目錄、動到 CI、要打包的一輪（`packed-install` 跑的時候），以及合併後完整一輪時跑。`sandbox-spawner-arm64` 只在合併後完整一輪與發版時跑，在 arm64 的 runner 上原生編與測，不出貨。

## 出貨

Linux 的離線包帶 x64 的 release 執行檔，放在 `native/nexus-sandbox-spawner`。`bundle.sh` 把執行檔與連進去的 Rust 程式碼的授權全文（`cargo tree -e normal,no-proc-macro` 收到的 crate，加上標準函式庫的 `COPYRIGHT-library.html`）打成 bundle，`pnpm run release:pack --spawner <目錄>` 原樣放進產物。bundle 的形狀與產物裡的檢查在 `scripts/release/spawner.ts`。

改了相依（`Cargo.lock`）就同步改 `scripts/release/spawner.ts` 的 `SPAWNER_CRATES`，再跑 `pnpm run gen-third-party-notices`。
