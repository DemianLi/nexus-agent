# 受管憑證檔的契約

`<home>/.credentials.yaml` 的現有行為（[#2666](https://github.com/DemianLi/nexus-agent/issues/2666)），寫給要讀這份檔的實作者：今天的 TS 解析器，
以及 [#2570](https://github.com/DemianLi/nexus-agent/issues/2570) PR-D 之後可能自己解析的 Rust 宿主。管理者要知道的事（放哪裡、`chmod 600`、
四層找值的順序、從舊版遷移、MCP 那一列怎麼引用）在 [`operations.md`](operations.md)〈金鑰放哪裡〉與〈MCP server 要的憑證〉，這裡不重寫。

格式在 [#1961](https://github.com/DemianLi/nexus-agent/issues/1961) 對齊 dsh，釘在 v1。本文件只記錄現況，不重新設計；
標了 [#2667](https://github.com/DemianLi/nexus-agent/issues/2667) 的是已知的缺陷，修好之後連同樣本一起改。

- 程式：`apps/harness/src/credentials.ts`（解析器與服務）、`apps/harness/src/owner-only.ts`（權限位元）。不帶檔名的 `:行號` 指 `credentials.ts`。
- 樣本：[`native/sandbox-spawner/credentials-vectors.json`](../native/sandbox-spawner/credentials-vectors.json)。
  TS 用 `apps/harness/src/credentials-vectors.test.ts` 跑；Rust 端若自己解析，要跑同一份、得到同樣的結果。

## 樣本檔

| 欄位 | 內容 |
| --- | --- |
| `documentVersion` | 這份樣本對應的文件版本（1）。 |
| `accept[]` | `text` 是檔案的完整內容，解析出 `refs`（`[名字, 值]`，照檔案順序）與 `ignoredKeys`（順序見〈只警告、不擋〉）。比對要完全相等。 |
| `reject[]` | `text` 要被拒絕，原因是 `reason`。有 `secret` 的，拒絕訊息裡不能出現那個字串。 |
| `modes[]` | 八進位的權限（字串），`accept` 表示一份內容合法的檔在這個權限下能不能讀。 |

樣本裡的值都是假的；長得像 key 的都帶 `FAKE`。

`reason` 只分到今天的訊息分得出的程度：

| `reason` | 意思 | 程式 |
| --- | --- | --- |
| `not-mapping` | 根不是 mapping | `credentials.ts:156` |
| `version` | `version` 缺、或不等於 1（含只有外來的頂層鍵、沒有 `version` 的檔） | `:162` |
| `records` | 有 `records` 這個頂層鍵 | `:165` |
| `refs-not-mapping` | `refs` 不是 mapping | `:170-172` |
| `bad-name` | `refs` 的鍵不是環境變數形狀 | `:176` |
| `not-string` | `refs` 的值不是字串（數字、布林、null、沒寫、mapping、序列） | `:179` |
| `empty-string` | `refs` 的值是空字串 | `:180` |
| `duplicate-key` | 同一層有重複的鍵（頂層或 `refs` 裡） | `:151` 的 `uniqueKeys` |
| `yaml` | 其他 YAML 錯誤（沒關上的括號、tab 縮排、多份文件） | `:151-153` |

`duplicate-key` 與 `yaml` 在 TS 是 YAML 函式庫的錯誤碼（`DUPLICATE_KEY`、`TAB_AS_INDENT`、`MULTIPLE_DOCS`…）。別的實作不必產生同樣的錯誤碼，
只要分得出這兩類。

## 形狀

```yaml
version: 1
refs:
  NVIDIA_API_KEY: nvapi-...
```

- **空的倉庫**：空檔、只有空白、只有註解、根是 `~` 或 `null`、空的 mapping（`{}`），都是沒有憑證，不要求 `version`（`:150`、`:155`、`:161`）。
  測試：`credentials.test.ts`「空檔與只有 version 都是『沒有憑證』」、「整份只有註解：check 不拋、沒有憑證，往下掉到 .env」。
- **只要根有任何一個鍵，`version` 就必須等於 1**（`:162`）。比的是數值：YAML 1.2 core schema 解成整數或浮點數 1 的寫法都算，
  `1.0`、`0x1`、`1e0`、`+1` 都收下；字串 `"1"` 不收。樣本：`accept`「version 寫成 1.0」等四條、`reject`「version 是字串 "1"」。
- **`refs` 可以缺、可以沒有值、可以是 `{}`**，都是沒有憑證（`:170`）。
- **名字**是 `^[A-Za-z_][A-Za-z0-9_]*$`（`CREDENTIAL_NAME_PATTERN`，`:115`）。照 YAML 1.2，`yes`、`on`、`true` 當鍵時是名字（布林鍵轉成字串
  `"true"`），`__proto__` 也是名字；`123`、`<<` 不是（`<<` 不當合併鍵）。
- **值**是非空字串，原樣收下，不修剪：`|` 區塊值帶著尾端換行、只有空白的值也收（修剪與字元檢查在模型 key 那一側，見下面〈之後的檢查〉）。
  照 YAML 1.2，`yes`、`on`、`no`、`2026-01-01`、加引號或 `!!str` 的數字都是字串；`012`、`0o12`、`.inf`、`~`、`true` 不是。
- 錨點與別名照常展開。檔頭的 BOM、CRLF 換行、開頭的 `---` 都收下；第二份文件（`---` 之後再一份）拒絕。

這幾類在不同的 YAML 實作（1.1／1.2、各家函式庫）之間容易解讀不同，自己解析的實作最容易在這裡各自解讀，所以樣本都收了。

## 拒絕

拒絕一律整份拒絕，不跳過其中一條：被靜靜忽略的條目，讀起來就是「我存的憑證沒作用」。條件見上面的 reason 表。

- `records` 拒絕而不是當外來鍵放過：nexus 沒有這種憑證，放過它會讓人以為存進去的東西有作用（`:165-169`）。
- 測試：`credentials.test.ts` 的 `parseCredentialsDocument` 那組，「records 仍然拒絕……」與「%s：拒絕，訊息指名檔案、不含秘密」。

## 只警告、不擋

`version`、`refs`、`records` 以外的頂層鍵不擋啟動，`refs` 照常解析（`:185`）。鍵名交回呼叫端，順序是 JS 物件的屬性順序（`:160`）：
像整數的鍵（例如 `2024`）排在最前面，其餘照檔案順序；樣本「外來的頂層鍵：像整數的鍵排最前面」釘住這一點。服務經 `warn` 講一次：
只印鍵名（JSON 跳脫），不印值；同一份檔（同一個 stat 簽章）只講一次（`:248-252`）。這些鍵留在檔案裡，不解析出任何東西。

測試：`credentials.test.ts`「version、refs 之外的頂層鍵不擋……（#1507）」、「多一個頂層鍵：解得出 key，warn 恰好一次……」、
「鍵名用 JSON 跳脫印出……」。

## 權限位元

讀之前先看 `stat` 的 mode：group 或 other 有任何一個權限位元（`mode & 0o077`）就拒絕，訊息帶 `chmod 600 <路徑>`（`owner-only.ts:25`）。
擁有者自己的位元不看：0400、0700 都過。setuid、setgid、sticky 位也不看，所以 4600 這種權限同樣會過；別的實作要照這個判法，
只看 `mode & 0o077`，不要寫成 `mode == 0o600`。Windows 跳過這項檢查。

特殊位元不做成 `modes` 樣本：setgid 位只有在檔案的群組是擁有者所屬的群組時才設得上；不是的時候，macOS 的 `chmod(1)` 回
`Operation not permitted`，Node 的 `chmodSync` 不報錯、但把那一位清掉，測試建出來的權限會隨環境不同。

測試：`credentials.test.ts` 的「權限」那組；樣本的 `modes`。

## 錯誤訊息

- 拒絕訊息是 `受管憑證檔 <路徑> 認不得：<原因>`，**不引值**。YAML 錯誤只寫錯誤碼與行列（`describeYamlError`，`:118`），不帶出錯那一行，
  因為那一行可能就是秘密。值不是字串時也只說「要是字串」，不說是什麼型別。
- **鍵名會原樣印出**：`bad-name`、`not-string`、`empty-string` 的訊息與外來頂層鍵的警告都帶鍵名。把 key 誤貼在鍵名的位置，它就會進訊息與日誌（[#2667](https://github.com/DemianLi/nexus-agent/issues/2667)）。

測試：`credentials.test.ts`「%s：拒絕，訊息指名檔案、不含秘密」；樣本 `reject[].secret`。

## 內容不進環境變數

解析出的值只在服務回傳的物件上，不寫進行程的環境變數，子行程不會順手繼承到（跟兩份 `.env` 不同，那兩份會寫）。
唯一的例外是 MCP 那一列用 `{ credential: <名字> }` 明著引用的，只交給那一台 server（`packages/nexus-plugin-mcp/src/credentials.ts`）。

測試：`credentials.test.ts`「受管檔的值不會被寫進 target」；`mcp-credentials-wire.test.ts`。

## 重讀

不監看檔案。每次解析先 `stat`，簽章是 **mtime、size、ino、mode 四項**（`:222-224`），跟上一次一樣就用快取，不一樣才重讀。
所以改了檔，下一次解析就是新的：模型 key 是下一個請求，MCP 是下一次建連線（下一條新對話；已建好的連線抓住舊值）。沒有解析就不重讀。

| 情況 | 結果 | 程式 |
| --- | --- | --- |
| 檔不存在 | 這一層是空的，往下一層找；清掉上一份可用的內容 | `:226-228` |
| 第一次讀就壞（權限、格式、讀檔失敗） | 拋 | `:238` |
| 讀好過之後改壞（權限、格式、讀檔失敗） | 續用上一份可用的內容，警告一次（同一個簽章不重複講） | `:238-243` |
| 讀好過之後刪掉，有一次解析看到檔不存在，再建成壞檔 | 上一份已經清掉，等於第一次讀：拋。刪掉與重建都在兩次解析之間的，只看得到簽章變了，照上一列續用 | `:226-228`、`:238` |
| `stat` 本身失敗（`ENOENT` 以外，例如 `EACCES`） | 拋，不續用上一份（[#2667](https://github.com/DemianLi/nexus-agent/issues/2667)） | `:230` |

測試：`credentials.test.ts` 的「重載：每次解析先 stat，變了才重讀」那組，以及「執行期被改成只剩註解……」、
「外來的鍵之後又改壞 refs……」。重讀的時序不做成樣本。

## 沒有寫入路徑

nexus 不寫這份檔：沒有設定頁，由管理者手動編輯。`apps/harness/src` 與 `packages/*/src` 裡沒有寫入它的程式，`credentials.ts` 只有
`statSync` 與 `readFileSync`。

## 哪些入口掛受管檔

服務以 `store` 旗標區分，沒有預設值（`credentials.ts` 的 `CredentialServiceOptions.store`）。

| 入口 | `store` | 程式 |
| --- | --- | --- |
| serve | `true`，受管檔最優先 | `serve-run.ts:890`、`:975-979` |
| plugin 試組 | `true` | `plugin-trial.ts:104-108` |
| CLI | `false` | `cli.ts:977`、`:1214` |
| eval | `false` | `eval/compare-cli.ts:156`、`eval/survey-cli.ts:171` |
| spike | `false` | `spike/cli.ts:24` |

- `store: false` 時完全不碰這份檔：不 `stat`、不讀、不檢查，壞掉的檔也不擋（`:261`、`:278`）。
- serve 帶 `--live` 時起動就完整檢查一次（`live-model.ts:2385-2386`，`loadLiveLaunchEnv` 建好服務就 `check()`），壞了起不來。沒帶 `--live` 時起動不檢查，
  MCP 那一列引用憑證、連線時才讀；從沒讀成功過就壞了，只讓引用它的那幾列連不上（`serve-run.ts:970-979`）。

測試：`credentials.test.ts`「一次性入口（CLI、eval、spike，不掛受管檔）……」那組；`mcp-credentials-wire.test.ts` 的 runCli、runServe 兩組。

## 之後的檢查

解析器只管這份檔的格式。模型 key 用之前還要過 [#1541](https://github.com/DemianLi/nexus-agent/issues/1541) 的修剪與字元檢查
（`api-key.ts` 的 `assertUsableApiKey`，由 `live-model.ts` 的 `resolveUsableKey` 呼叫），四層一視同仁。**MCP 那一列引用的值沒有過這道檢查**，原樣交給子行程的環境變數或 HTTP header
（`assembly-root.ts` 的 `mcpCredentialsOf`，[#2667](https://github.com/DemianLi/nexus-agent/issues/2667)）。
