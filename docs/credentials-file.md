# 受管憑證檔的契約

`<home>/.credentials.yaml` 的現有行為（[#2666](https://github.com/DemianLi/nexus-agent/issues/2666)），寫給要讀這份檔的實作者：今天的 TS 解析器，
以及 [#2570](https://github.com/DemianLi/nexus-agent/issues/2570) PR-D 之後可能自己解析的 Rust 宿主。管理者要知道的事（放哪裡、`chmod 600`、
四層找值的順序、從舊版遷移、MCP 那一列怎麼引用）在 [`operations.md`](operations.md)〈金鑰放哪裡〉與〈MCP server 要的憑證〉，這裡不重寫。

格式在 [#1961](https://github.com/DemianLi/nexus-agent/issues/1961) 對齊 dsh，釘在 v1。本文件只記錄現況，不重新設計；
標了 [#2667](https://github.com/DemianLi/nexus-agent/issues/2667) 的是那一張改過的行為。

- 程式：`apps/harness/src/credentials.ts`（解析器與服務）、`apps/harness/src/owner-only.ts`（權限位元）。不帶檔名的 `:行號` 指 `credentials.ts`。
- 樣本：[`native/sandbox-spawner/credentials-vectors.json`](../native/sandbox-spawner/credentials-vectors.json)。
  TS 用 `apps/harness/src/credentials-vectors.test.ts` 跑；Rust 端若自己解析，要跑同一份、得到同樣的結果。

## 樣本檔

| 欄位 | 內容 |
| --- | --- |
| `documentVersion` | 這份樣本對應的文件版本（1）。 |
| `accept[]` | `text` 是檔案的完整內容，解析出 `refs`（`[名字, 值]`）與 `ignoredKeys`，兩者都照檔案順序。比對要完全相等。 |
| `reject[]` | `text` 要被拒絕，原因是 `reason`。有 `secret` 的，拒絕訊息裡不能出現那個字串。 |
| `modes[]` | 八進位的權限（字串），`accept` 表示一份內容合法的檔在這個權限下能不能讀。 |

樣本裡的值都是假的；長得像 key 的都帶 `FAKE`。

`reason` 只分到今天的訊息分得出的程度：

| `reason` | 意思 | 程式 |
| --- | --- | --- |
| `not-mapping` | 根不是 mapping | `credentials.ts:231-233` |
| `version` | `version` 缺、或不等於 1（含只有外來的頂層鍵、沒有 `version` 的檔） | `:237` |
| `records` | 有 `records` 這個頂層鍵 | `:240` |
| `refs-not-mapping` | `refs` 不是 mapping | `:245-248` |
| `bad-name` | `refs` 的鍵不是環境變數形狀 | `:255-259` |
| `not-string` | `refs` 的值不是字串（數字、布林、null、沒寫、mapping、序列） | `:262` |
| `empty-string` | `refs` 的值是空字串 | `:263-265` |
| `duplicate-key` | 同一層有重複的鍵（頂層或 `refs` 裡），包括換成同一個名字的兩個鍵（見〈形狀〉） | `:215-221` 的 `uniqueKeys`、`:280-287` 的 `uniqueEntries` |
| `yaml` | 其他 YAML 錯誤（沒關上的括號、tab 縮排、多份文件），以及指令與明示 tag（見〈形狀〉） | `:215-221`；指令與 tag 是 `:224-228` |

`duplicate-key` 與 `yaml` 在 TS 是 YAML 函式庫的錯誤碼（`DUPLICATE_KEY`、`TAB_AS_INDENT`、`MULTIPLE_DOCS`…）；換成同一個名字的兩個鍵由
`uniqueEntries` 自己講成 `DUPLICATE_KEY`；指令與明示 tag 是 nexus 自己的 `DIRECTIVE_NOT_ALLOWED`、`TAG_NOT_ALLOWED`。別的實作不必產生同樣的錯誤碼，只要分得出這兩類。

## 形狀

```yaml
version: 1
refs:
  NVIDIA_API_KEY: nvapi-...
```

- **空的倉庫**：空檔、只有空白、只有註解、根是 `~` 或 `null`、空的 mapping（`{}`），都是沒有憑證，不要求 `version`（`:213`、`:230`、`:235`）。
  測試：`credentials.test.ts`「空檔與只有 version 都是『沒有憑證』」、「整份只有註解：check 不拋、沒有憑證，往下掉到 .env」。
- **只要根有任何一個鍵，`version` 就必須等於 1**（`:237`）。比的是數值：YAML 1.2 core schema 解成整數或浮點數 1 的寫法都算，
  `1.0`、`0x1`、`1e0`、`+1` 都收下；字串 `"1"` 不收。樣本：`accept`「version 寫成 1.0」等四條、`reject`「version 是字串 "1"」。
- **`refs` 可以缺、可以沒有值、可以是 `{}`**，都是沒有憑證（`:245`）。
- **名字**是 `^[A-Za-z_][A-Za-z0-9_]*$`（`CREDENTIAL_NAME_PATTERN`，`:106`）。照 YAML 1.2，`yes`、`on`、`true` 當鍵時是名字（布林鍵轉成字串
  `"true"`），`__proto__` 也是名字；`123`、`<<` 不是（`<<` 不當合併鍵）。
- **鍵的名字是轉成 JS 之後的字串**，所以 YAML 層不同、名字相同的兩個鍵是重複鍵，整份拒絕（[#2667](https://github.com/DemianLi/nexus-agent/issues/2667)）：
  `true` 與 `"true"`、`1` 與 `"1"`、別名與它指到的字（`*n` 指到 `refs`）。YAML 函式庫的 `uniqueKeys` 比的是同一個節點或純量的值，型別不同或是別名就算不同，擋不到這三種，
  後一個會靜靜蓋掉前一個；`uniqueEntries`（`:280-287`）照名字再比一次，頂層與 `refs` 裡都比。樣本：`reject` 裡「換成同一個名字」那四條。
- **值**是非空字串，原樣收下，不修剪：`|` 區塊值帶著尾端換行、只有空白的值也收（修剪與字元檢查在用值的那一側，見下面〈之後的檢查〉）。
  照 YAML 1.2，`yes`、`on`、`no`、`2026-01-01`、加引號的數字都是字串；`012`、`0o12`、`.inf`、`~`、`true` 不是。
- **指令與明示 tag 整份拒絕**（[#2667](https://github.com/DemianLi/nexus-agent/issues/2667)，`forbiddenToken`，`:122-147`）：
  - 指令：`%YAML`、`%TAG`，以及任何 `%` 開頭的指令行，訊息是 `YAML 錯誤 DIRECTIVE_NOT_ALLOWED（第 L 行第 C 欄）`。`%YAML 1.1` 會換掉 schema（`yes` 變成 `true`）。
  - 明示 tag：`!!str`、`!!binary`、`!foo`、非特定的 `!`、逐字的 `!<…>`，不論在鍵、值、mapping 還是文件開頭，訊息是 `YAML 錯誤 TAG_NOT_ALLOWED（第 L 行第 C 欄）`。
    `!!binary` 會把值換成位元組，`!!str` 雖然不改結果，一樣拒絕，規則才簡單。
  - 有好幾個時指到最前面那一個。值、引號、區塊值與註解裡的 `!`、`%` 不是 tag 也不是指令，照收。
  - 不看 YAML 函式庫有沒有發 warning：認得的 tag 不發 warning，結果照樣被換掉。
  - 樣本：`reject` 裡 `reason` 是 `yaml`、名字以「指令」「tag」開頭的那幾條；`accept` 裡「不是 tag 也不是指令」那幾條。
- 錨點與別名照常展開。檔頭的 BOM、CRLF 換行、開頭的 `---` 都收下；第二份文件（`---` 之後再一份）拒絕。

這幾類在不同的 YAML 實作（1.1／1.2、各家函式庫）之間容易解讀不同，自己解析的實作最容易在這裡各自解讀，所以樣本都收了。

## 拒絕

拒絕一律整份拒絕，不跳過其中一條：被靜靜忽略的條目，讀起來就是「我存的憑證沒作用」。條件見上面的 reason 表。

- `records` 拒絕而不是當外來鍵放過：nexus 沒有這種憑證，放過它會讓人以為存進去的東西有作用（`:240-244`）。
- 測試：`credentials.test.ts` 的 `parseCredentialsDocument` 那組，「records 仍然拒絕……」與「%s：拒絕，訊息指名檔案、不含秘密」。

## 只警告、不擋

`version`、`refs`、`records` 以外的頂層鍵不擋啟動，`refs` 照常解析。鍵名（`ignoredKeys`）與各自的行號（`ignoredLines`）交回呼叫端，
**照檔案順序**（`:268-273`）：像整數的鍵（例如 `2024`）也不往前排，樣本「外來的頂層鍵：像整數的鍵也照檔案順序」釘住這一點。
服務經 `warn` 講一次，**只講個數與行號，不印鍵名也不印值**（`:362-366`）：鍵名的位置可能被誤貼了 key（見〈錯誤訊息〉）。
同一份檔（同一個 stat 簽章）只講一次。這些鍵留在檔案裡，不解析出任何東西。

測試：`credentials.test.ts`「version、refs 之外的頂層鍵不擋……（#1507）」、「多一個頂層鍵：解得出 key，warn 恰好一次……」、
「鍵名不進警告……」、「ignoredKeys 照檔案順序」、「不認得的頂層鍵：警告只講個數與行號，不含鍵名」。

## 權限位元

讀之前先看 `stat` 的 mode：group 或 other 有任何一個權限位元（`mode & 0o077`）就拒絕，訊息帶 `chmod 600 <路徑>`（`owner-only.ts:25`）。
擁有者自己的位元不看：0400、0700 都過。setuid、setgid、sticky 位也不看，所以 4600 這種權限同樣會過；別的實作要照這個判法，
只看 `mode & 0o077`，不要寫成 `mode == 0o600`。Windows 跳過這項檢查。

特殊位元不做成 `modes` 樣本：setgid 位只有在檔案的群組是擁有者所屬的群組時才設得上；不是的時候，macOS 的 `chmod(1)` 回
`Operation not permitted`，Node 的 `chmodSync` 不報錯、但把那一位清掉，測試建出來的權限會隨環境不同。

測試：`credentials.test.ts` 的「權限」那組；樣本的 `modes`。

## 錯誤訊息

- 拒絕訊息是 `受管憑證檔 <路徑> 認不得：<原因>`，**不引值，也不引鍵名**。YAML 錯誤只寫錯誤碼與行欄（`describeYamlError`，`:109`），
  不帶出錯那一行，因為那一行可能就是秘密。值不是字串時也只說「要是字串」，不說是什麼型別。
- **鍵名不印，只講位置**（[#2667](https://github.com/DemianLi/nexus-agent/issues/2667)）：把 key 誤貼在鍵名的位置時，鍵名就是秘密，而且
  `not-string`、`empty-string` 的鍵名形狀合法，分不出來。三種訊息都寫 `refs 第 L 行第 C 欄`：`bad-name` 再加鍵名的長度（字元數），
  `not-string` 是「那一把要是字串」，`empty-string` 是「那一把是空字串」。行、欄從 1 起算，指的是鍵的開頭。
  外來頂層鍵的警告同理（〈只警告、不擋〉）。
- **YAML 函式庫自己的警告關掉**（`logLevel: 'error'`，`:219-220`）：鍵是集合（例如 `? [nvapi-…]`）時，`toJS()` 會把它字串化，
  預設經 `process.emitWarning` 把整個鍵印到 stderr。

測試：`credentials.test.ts`「%s：拒絕，訊息指名檔案、不含秘密」、「鍵名不進訊息與日誌」那組（含「%s的集合鍵：yaml 自己的 process 警告不把鍵印出來」）；樣本 `reject[].secret`，
其中「鍵的位置貼了……」三條的 `secret` 是鍵名。

## 內容不進環境變數

解析出的值只在服務回傳的物件上，不寫進行程的環境變數，子行程不會順手繼承到（跟兩份 `.env` 不同，那兩份會寫）。
唯一的例外是 MCP 那一列用 `{ credential: <名字> }` 明著引用的，只交給那一台 server（`packages/nexus-plugin-mcp/src/credentials.ts`）。

測試：`credentials.test.ts`「受管檔的值不會被寫進 target」；`mcp-credentials-wire.test.ts`。

## 重讀

不監看檔案。每次解析先 `stat`，簽章是 **mtime、size、ino、mode 四項**（`:339`），跟上一次一樣就用快取，不一樣才重讀。
所以改了檔，下一次解析就是新的：模型 key 是下一個請求，MCP 是下一次建連線（下一條新對話；已建好的連線抓住舊值）。沒有解析就不重讀。

| 情況 | 結果 | 程式 |
| --- | --- | --- |
| 檔不存在 | 這一層是空的，往下一層找；清掉上一份可用的內容 | `:341-344` |
| 第一次讀就壞（`stat` 失敗、權限、格式、讀檔失敗） | 拋 | `:324` |
| 讀好過之後改壞（權限、格式、讀檔失敗） | 續用上一份可用的內容，警告一次（同一個簽章不重複講；讀成功一次就重新算，`:348`、`:359`） | `:356`、`:323-330` |
| 讀好過之後 `stat` 本身失敗（`ENOENT` 以外，例如 `EACCES`） | 同上一列，續用上一份並警告一次；這時沒有簽章，以 `stat:<錯誤碼>` 去重（[#2667](https://github.com/DemianLi/nexus-agent/issues/2667)，同 dsh 的熱重載） | `:345` |
| 讀好過之後刪掉，有一次解析看到檔不存在，再建成壞檔 | 上一份已經清掉，等於第一次讀：拋。刪掉與重建都在兩次解析之間的，只看得到簽章變了，照「讀好過之後改壞」那一列續用 | `:341-344`、`:324` |

測試：`credentials.test.ts` 的「重載：每次解析先 stat，變了才重讀」那組，以及「執行期被改成只剩註解……」、
「外來的鍵之後又改壞 refs……」；`credentials-stat.test.ts`（`stat` 本身失敗，用 mock 造錯）。重讀的時序不做成樣本。

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

- `store: false` 時完全不碰這份檔：不 `stat`、不讀、不檢查，壞掉的檔也不擋（`:375`、`:392`）。
- serve 帶 `--live` 時起動就完整檢查一次（`live-model.ts:2385-2386`，`loadLiveLaunchEnv` 建好服務就 `check()`），壞了起不來。沒帶 `--live` 時起動不檢查，
  MCP 那一列引用憑證、連線時才讀；從沒讀成功過就壞了，只讓引用它的那幾列連不上（`serve-run.ts:970-979`）。

測試：`credentials.test.ts`「一次性入口（CLI、eval、spike，不掛受管檔）……」那組；`mcp-credentials-wire.test.ts` 的 runCli、runServe 兩組。

## 之後的檢查

解析器只管這份檔的格式，值原樣交出去。用值之前各自再檢查一次，四層一視同仁：

- **模型 key**：[#1541](https://github.com/DemianLi/nexus-agent/issues/1541) 的修剪與字元檢查（`api-key.ts` 的 `assertUsableApiKey`，由 `live-model.ts` 的
  `resolveUsableKey` 呼叫）。修掉頭尾空白，只收可列印 ASCII、不含空白。
- **MCP 那一列引用的值**（[#2667](https://github.com/DemianLi/nexus-agent/issues/2667)）：`mcp-credential.ts` 的 `assertUsableMcpCredential`，由
  `assembly-root.ts` 的 `mcpCredentialsOf` 呼叫。plugin 那一側把這把憑證代入到哪裡（`env` 或 `header`，看這一列的 transport）傳過來
  （`packages/nexus-plugin-mcp/src/credentials.ts` 的 `McpCredentials.resolve`）。
  - 兩條路都修掉頭尾空白（JS 的 `String.prototype.trim`），修完是空的就拒絕。
  - `env`：只擋 NUL。
  - `header`：照 Node http 驗 header 值的規則，只收 `[\t\x20-\x7E\x80-\xFF]`。這裡先擋，是因為 HTTP transport 走 `fetch`，
    undici 的 `Headers` 遇到 CR、LF、NUL 拋的錯會把整個值帶進訊息。
  - 拒絕訊息只講名字與來源層，不含值的任何片段。

## 對照 dsh

從 `credentials.ts` 的註解搬來（[#2667](https://github.com/DemianLi/nexus-agent/issues/2667)），引用在 dsh `8bd073392eef` 核對過。
不帶路徑的 `:行號` 指 `packages/credentials/credentials-local/src/index.ts`。

- **兩邊的找值順序照 dsh。** serve 對應 dsh 的 Web profile，受管檔最優先，理由同 `:1-20`：使用者明確存進受管檔的 key 要一致生效。
  一次性入口（CLI、eval、spike）對應 headless profile，不掛受管檔。起動時印的那一行來源（`describeKeySource`）對應 dsh `describe` 回報的 `source`。
- **名字的形狀**同 dsh `packages/credentials/credentials/src/index.ts:19` 的 `REF_PATTERN`。
- **空的倉庫**同 dsh：`toJS() ?? {}`，空的 mapping 不要求 `version`（`:203`、`:209-211`）。
- **`refs` 裡面一律拒絕、外來頂層鍵只警告**同 dsh 的規則（`:179-185`、`:228`、`:883-890`）。nexus 的警告不印鍵名，這是偏離，見〈錯誤訊息〉。
- **偏離：重讀不監看檔案。** dsh 用 chokidar 監看，寫入後等 100ms 穩定才重讀（`:40`、`:92`、`:582-586`）。
  nexus 每次解析先 `stat`，簽章變了才重讀：模型每次請求都會取 key，所以「改了檔、下一次請求就用新的」照樣成立，少一個相依，測試裡也沒有計時器要處理。
  代價是沒有請求就不重讀，也就不會在請求之外提早發現檔案壞了；啟動那一次照樣完整檢查。
- **執行期重讀失敗保留最後一份並警告**同 dsh 的熱重載，見〈重讀〉。
- **偏離：沒有 `records`。** nexus 沒有第二種憑證（`grant`／`api-key` 記錄），`records` 這個鍵照舊拒絕，不跟其他外來鍵一起放過。
  理由用 dsh 自己的規則（`:179-183`）：nexus 不會用 `records` 裡的東西，放過它，使用者會以為存進去的 grant 有作用。
- **偏離：拒絕指令與明示 tag**（[#2667](https://github.com/DemianLi/nexus-agent/issues/2667)）。dsh 收任何 YAML。見〈拒絕〉。
