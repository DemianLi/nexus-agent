# 受管憑證檔的契約

`<home>/.credentials.yaml` 的現有行為（[#2666](https://github.com/DemianLi/nexus-agent/issues/2666)），寫給要讀這份檔的實作者：今天的 TS 解析器，
以及 [#2570](https://github.com/DemianLi/nexus-agent/issues/2570) 加進 Rust 宿主的解析器（還沒有呼叫者）。管理者要知道的事（放哪裡、`chmod 600`、
四層找值的順序、從舊版遷移、MCP 那一列怎麼引用）在 [`operations.md`](operations.md)〈金鑰放哪裡〉與〈MCP server 要的憑證〉，這裡不重寫。

格式在 [#1961](https://github.com/DemianLi/nexus-agent/issues/1961) 對齊 dsh，釘在 v1。本文件只記錄現況，不重新設計；
標了 [#2667](https://github.com/DemianLi/nexus-agent/issues/2667) 的條目是該 issue 改過的行為。

- 程式：`apps/harness/src/credentials.ts`（解析器與服務）、`apps/harness/src/owner-only.ts`（權限位元）。不帶檔名的 `:行號` 指 `credentials.ts`。
  Rust 宿主的是 `native/sandbox-spawner/host/src/credentials/`（`mod.rs` 解析器與 `Store`，`scalar.rs` 照 core schema 解純量）。
- 樣本：[`native/sandbox-spawner/credentials-vectors.json`](../native/sandbox-spawner/credentials-vectors.json)。
  TS 用 `apps/harness/src/credentials-vectors.test.ts` 跑，Rust 用 `native/sandbox-spawner/host/tests/credentials.rs` 跑同一份，兩邊結果要一樣。

## 樣本檔

| 欄位 | 內容 |
| --- | --- |
| `documentVersion` | 這份樣本對應的文件版本（1）。 |
| `accept[]` | `text` 是檔案的完整內容，解析出 `refs`（`[名字, 值]`）與 `ignoredKeys`，兩者都照檔案順序。比對要完全相等。 |
| `reject[]` | `text` 要被拒絕，原因是 `reason`。有 `code` 的，訊息要以 `YAML 錯誤 <code>` 開頭：`reason` 是 `yaml` 時用它分出是哪一種、釘住〈拒絕〉的先後。有 `secret` 的，拒絕訊息裡不能出現那個字串。 |
| `modes[]` | 八進位的權限（字串），`accept` 表示一份內容合法的檔在這個權限下能不能讀。 |
| `mcpValue[]` | MCP 憑證值的檢查（[#2570](https://github.com/DemianLi/nexus-agent/issues/2570)）。`use` 是 `env` 或 `header`，`value` 是原值；`accept` 為真時修剪後的值要等於 `trimmed`，為假時拒絕原因要是 `reason`（`empty`、`too-short`、`nul`、`header-chars`），有 `secret` 的，拒絕訊息裡不能出現它。TS 與 Rust 都跑。 |
| `redact[]` | MCP 憑證值的遮蔽。用 `values` 建遮蔽器，對 `text` 遮，輸出要完全等於 `expect`；`scope` 是 `result`（預設，成功結果與工具清單）或 `error`（錯誤與診斷）；`absent` 列的字串不能出現在輸出裡。Rust 宿主與 TS 都跑同一組：TS 的遮蔽器是 `packages/nexus-plugin-mcp/src/redact.ts`，執行端在同目錄的 `redact.test.ts`（[#2669](https://github.com/DemianLi/nexus-agent/issues/2669)）。 |
| `stdioRow[]` | TS 的 `hostStdioConnection`（`apps/harness/src/mcp-host-stdio-row.ts`）輸出的 stdio 那一列（#2570 D2b-2）。`input` 是它的輸入（`credentialEnv` 的每個值是憑證服務給的原值），`ts` 是 `{ row }`（輸出要完全相等）或 `{ error }`（拋出的訊息要含這段字）。有 `row` 的，Rust 的 `Server::parse` 一律要收。 |
| `stdioHost[]` | 只給 Rust：`connection` 直接交 `Server::parse`，`error` 是 `null`（要收）或訊息要含的字。釘宿主自己的拒絕（相對路徑、credentialEnv 不在 env、憑證值沒修剪或太短）。 |

樣本裡的值都是假的；長得像 key 的都帶 `FAKE`。

`reason` 只分到今天的訊息分得出的程度：

| `reason` | 意思 | 程式 |
| --- | --- | --- |
| `not-mapping` | 根不是 mapping | `credentials.ts:382-384` |
| `version` | `version` 缺、或不等於 1（含只有外來的頂層鍵、沒有 `version` 的檔） | `:388` |
| `records` | 有 `records` 這個頂層鍵 | `:391` |
| `refs-not-mapping` | `refs` 不是 mapping | `:396-399` |
| `bad-name` | `refs` 的鍵不是環境變數形狀 | `:405-409` |
| `not-string` | `refs` 的值不是字串（數字、布林、null、沒寫、mapping、序列） | `:412` |
| `empty-string` | `refs` 的值是空字串 | `:413-415` |
| `duplicate-key` | 同一層有重複的鍵（頂層或 `refs` 裡），包括換成同一個名字的兩個鍵（見〈形狀〉） | `:358-365` 的 `uniqueKeys`、`:430-437` 的 `uniqueEntries` |
| `yaml` | 其他 YAML 錯誤（沒關上的括號、多份文件），以及解析前就拒的字元、太深的巢狀、指令、明示 tag、錨點、別名、顯式鍵、空鍵與集合鍵（見〈形狀〉） | `:358-374`；字元是 `:350-357`，巢狀是 `:375`，指令、tag、錨點與別名是 `:376-377`，顯式鍵與空鍵是 `:378`，集合鍵是 `:379` |

`duplicate-key` 與 `yaml` 在 TS 是 YAML 函式庫的錯誤碼（`DUPLICATE_KEY`、`BLOCK_AS_IMPLICIT_KEY`、`MULTIPLE_DOCS`…）；換成同一個名字的兩個鍵由
`uniqueEntries` 自己講成 `DUPLICATE_KEY`；指令、明示 tag、錨點與別名是 nexus 自己的 `DIRECTIVE_NOT_ALLOWED`、`TAG_NOT_ALLOWED`、`ANCHOR_NOT_ALLOWED`、`ALIAS_NOT_ALLOWED`，
字元、巢狀、顯式鍵、空鍵與集合鍵是 `CHARACTER_NOT_ALLOWED`、`NESTING_TOO_DEEP`、`EXPLICIT_KEY_NOT_ALLOWED`、`EMPTY_KEY_NOT_ALLOWED`、`COLLECTION_KEY_NOT_ALLOWED`（[#2570](https://github.com/DemianLi/nexus-agent/issues/2570)）。
別的實作不必產生同樣的錯誤碼，只要分得出這兩類；Rust 宿主沿用 nexus 自己的錯誤碼，語法錯一律 `YAML_SYNTAX`，多份文件沿用 `MULTIPLE_DOCS`。

## 形狀

```yaml
version: 1
refs:
  NVIDIA_API_KEY: nvapi-...
```

- **空的倉庫**：空檔、只有空白、只有註解、根是 `~` 或 `null`、空的 mapping（`{}`），都是沒有憑證，不要求 `version`（`:341`、`:381`、`:386`）。
  測試：`credentials.test.ts`「空檔與只有 version 都是『沒有憑證』」、「整份只有註解：check 不拋、沒有憑證，往下掉到 .env」。
- **只要根有任何一個鍵，`version` 就必須等於 1**（`:388`）。比的是數值：YAML 1.2 core schema 解成整數或浮點數 1 的寫法都算，
  `1.0`、`0x1`、`1e0`、`+1` 都收下；字串 `"1"` 不收。樣本：`accept`「version 寫成 1.0」等四條、`reject`「version 是字串 "1"」。
- **`refs` 可以缺、可以沒有值、可以是 `{}`**，都是沒有憑證（`:396`）。
- **名字**是 `^[A-Za-z_][A-Za-z0-9_]*$`（`CREDENTIAL_NAME_PATTERN`，`:107`）。照 YAML 1.2，`yes`、`on`、`true` 當鍵時是名字（布林鍵轉成字串
  `"true"`），`__proto__` 也是名字；`123`、`<<` 不是（`<<` 不當合併鍵）。
- **鍵的名字是轉成 JS 之後的字串**，所以 YAML 層不同、名字相同的兩個鍵是重複鍵，整份拒絕（[#2667](https://github.com/DemianLi/nexus-agent/issues/2667)）：
  `true` 與 `"true"`、`1` 與 `"1"`。YAML 函式庫的 `uniqueKeys` 比的是同一個節點或純量的值，型別不同就算不同，擋不到這兩種，
  後一個會靜靜蓋掉前一個；`uniqueEntries`（`:430-437`）照名字再比一次，頂層與 `refs` 裡都比。樣本：`reject` 裡「換成同一個名字」那三條。
  別名鍵展開後跟別的鍵同名的情形，在更早的地方就因為錨點被拒絕（見下一條）。
- **值**是非空字串，原樣收下，不修剪：`|` 區塊值帶著尾端換行、只有空白的值也收（修剪與字元檢查在用值的那一側，見下面〈之後的檢查〉）。
  照 YAML 1.2，`yes`、`on`、`no`、`2026-01-01`、加引號的數字都是字串；`012`、`0o12`、`.inf`、`~`、`true` 不是。
- **指令、明示 tag、錨點與別名整份拒絕**（[#2667](https://github.com/DemianLi/nexus-agent/issues/2667)，`scanTokens`，`:196-225`）：
  - 指令：`%YAML`、`%TAG`，以及任何 `%` 開頭的指令行，訊息是 `YAML 錯誤 DIRECTIVE_NOT_ALLOWED（第 L 行第 C 欄）`。`%YAML 1.1` 會換掉 schema（`yes` 變成 `true`）。
  - 明示 tag：`!!str`、`!!binary`、`!foo`、非特定的 `!`、逐字的 `!<…>`，不論在鍵、值、mapping 還是文件開頭，訊息是 `YAML 錯誤 TAG_NOT_ALLOWED（第 L 行第 C 欄）`。
    `!!binary` 會把值換成位元組，`!!str` 會把 `678` 這類數字換成字串（沒寫 tag 是數字）；兩者一律拒絕，規則才簡單。
  - 錨點（`&x`）與別名（`*x`）：不論在鍵、值、mapping 還是文件開頭，訊息是 `YAML 錯誤 ANCHOR_NOT_ALLOWED`、`ALIAS_NOT_ALLOWED`（附行欄）。
    錨點名字收哪些字元各家實作不同（`&a:` 在 `yaml` 裡是名字 `a:`），別名展開還要防別名炸彈；拒絕之後，自己解析的實作不必做這兩件事。
    沒有對應錨點的別名會讓 `toJS()` 拋出不帶檔名的 `ReferenceError`；這裡在那之前就講成 `ALIAS_NOT_ALLOWED`。
  - 有好幾個時指到最前面那一個。值、引號、區塊值與註解裡的 `!`、`%`、`&`、`*` 都不是 token，照收。
  - 不看 YAML 函式庫有沒有發 warning：認得的 tag 不發 warning，結果照樣被換掉。
  - 樣本：`reject` 裡 `reason` 是 `yaml`、名字以「指令」「tag」「錨點」「別名」開頭的那幾條；`accept` 裡「不是 tag 也不是指令」「不是錨點也不是別名」那幾條。
- **解析之前就拒絕的字元**（[#2570](https://github.com/DemianLi/nexus-agent/issues/2570)，`forbiddenCharacter`）：NUL、tab、不接 LF 的 CR、不在檔頭的 U+FEFF，
  不論在值、引號、註解還是縮排裡，訊息是 `YAML 錯誤 CHARACTER_NOT_ALLOWED（第 L 行第 C 欄）`，指到第一個。例外是整份只有空白的檔
  （含 tab、單獨的 CR）：它在字元檢查之前就當成空的倉庫（`:341`）。這幾種 `yaml` 與 Rust 宿主用的 `saphyr-parser` 各自解讀，
  同一份檔兩條路會讀出不同的結果：`:`、`?` 後面緊接的 tab，`yaml` 收、`saphyr-parser` 報錯；先空白再 tab 的縮排，`yaml` 報
  `TAB_AS_INDENT`、`saphyr-parser` 收；單獨的 CR，一邊當換行一邊當內容；NUL 與檔中間的 U+FEFF，一邊收進值或鍵名、一邊報錯。
  值裡要放 tab，用雙引號寫成 `"\t"`。樣本：`reject` 裡名字以「字元」開頭的那幾條。
- **mapping 與序列最多 64 層**（`CREDENTIALS_MAX_DEPTH`）：根的 mapping（或序列）是第 1 層，每往裡一個 mapping 或序列多一層，純量不算層；
  mapping 的鍵與值都算在它裡面一層。超過整份拒絕，訊息是 `YAML 錯誤 NESTING_TOO_DEEP（mapping 與序列最多 64 層）`，不附行欄。
  `version: 1` 是 1 層，`refs:` 底下的 `名字: 值` 是 2 層，正常的檔遠用不到。深到 `yaml` 自己用光資源的檔（一千多層起）也講成 `NESTING_TOO_DEEP`，不會讓行程掛掉。
  樣本：`accept`「巢狀 64 層：照收」兩條、`reject`「巢狀 65 層」「巢狀 2000 層」等三條。
- **鍵是 mapping 或序列（`[a]: 1`、`{a: 1}: x`）整份拒絕**，不論在頂層、`refs` 裡還是外來鍵的值底下，訊息是
  `YAML 錯誤 COLLECTION_KEY_NOT_ALLOWED（第 L 行第 C 欄）`，指到最前面那一個，不含鍵。`yaml` 把集合鍵字串化成名字的寫法別的實作照不出來，
  受管檔也用不到。用 `?` 寫的集合鍵先算顯式鍵（見下一條）。樣本：`reject` 裡名字以「集合當鍵」開頭的八條（三個位置乘兩種寫法，再加兩條 `refs` 裡不是第一個鍵的）。
- **顯式鍵（`?`）與空鍵整份拒絕**（[#2570](https://github.com/DemianLi/nexus-agent/issues/2570)，`scanTokens`，`:196-225`），不論在頂層、`refs` 裡、外來鍵的值底下、序列項目裡的 mapping，還是 flow mapping 與 flow 序列：
  - 顯式鍵：任何用 `?` 起頭的鍵，包括 `?` 後面什麼都沒有的，訊息是 `YAML 錯誤 EXPLICIT_KEY_NOT_ALLOWED（第 L 行第 C 欄）`，指到 `?`。
  - 空鍵：沒寫鍵的 `:`（`: x`、`{ : x }`）與解出來是空字串的引號鍵（`"": x`、`'': x`，以及 flow mapping 裡雙引號內反斜線接換行的折行寫法），訊息是 `YAML 錯誤 EMPTY_KEY_NOT_ALLOWED（第 L 行第 C 欄）`，指到 `:` 或引號。
  - 有好幾個時指到最前面那一個，訊息不含鍵名。值裡、引號裡、註解裡的 `?` 不是顯式鍵，`note: ""` 這種值是空字串的鍵照收。
  - `yaml` 把 `?` 的內容當一般鍵讀，空鍵換成空字串或 `null` 的名字；別的實作照不出同樣的名字，受管檔的鍵也一律寫在 `名字:` 同一行，用不到這兩樣。
  - 樣本：`reject` 裡名字以「顯式鍵」「空鍵」開頭的條目；`accept` 裡「不是顯式鍵」「不是空鍵」那幾條。
- 檔頭的 BOM、CRLF 換行、開頭的 `---` 都收下；第二份文件（`---` 之後再一份）拒絕。只有 BOM、或 BOM 加空白的檔是空的倉庫（JS 的 `trim` 修得掉 U+FEFF）。
- **鍵轉成名字照 JS 的 `String()`**：`true` 是 `"true"`，`null`、`~` 是空字串，`.inf` 是 `"Infinity"`，`0x1F` 是 `"31"`，`1e21` 是 `"1e+21"`。
  樣本：`accept`「TRUE 當鍵」「.inf 當鍵」「NULL 當鍵」「數字鍵照 JS 的 String() 轉成名字」。

這幾類在不同的 YAML 實作（1.1／1.2、各家函式庫）之間容易解讀不同，自己解析的實作最容易在這裡各自解讀，所以樣本都收了。

## 拒絕

拒絕一律整份拒絕，不跳過其中一條：被靜靜忽略的條目，讀起來就是「我存的憑證沒作用」。條件見上面的 reason 表。

一份檔同時有好幾種錯時，照下面的順序檢查，回第一個檢查到的；同一步裡有好幾個，回檔案裡最前面那一個。TS 與 Rust 宿主照同一個順序，
樣本裡名字以「先後」開頭的那幾條用 `code` 或 `reason` 釘住：

1. 解析前就拒的字元（`CHARACTER_NOT_ALLOWED`）。
2. YAML 本身的錯：語法、多份文件，以及同一個純量鍵寫兩次（`DUPLICATE_KEY`）。這一類跟集合鍵同時出現時，不論誰在前，都回這一類。
   兩個例外：YAML 函式庫自己的巢狀上限（`yaml` 用光呼叫堆疊的 `RESOURCE_EXHAUSTION`，`saphyr-parser` 超過 255 層 flow 的錯）講成
   `NESTING_TOO_DEEP`；`yaml` 2.9.1 對區塊 mapping 裡不是第一個鍵的 flow 集合鍵誤報 `IMPOSSIBLE`，那一筆不算，照第 6 步講成集合鍵。
3. 巢狀超過 64 層（`NESTING_TOO_DEEP`），包括集合鍵本身就超過的。
4. 指令、明示 tag、錨點、別名。
5. 顯式鍵與空鍵（`EXPLICIT_KEY_NOT_ALLOWED`、`EMPTY_KEY_NOT_ALLOWED`）。同一步裡有兩種時回檔案裡最前面那一個；`? [a]: 1` 回顯式鍵，不是集合鍵。
6. 集合鍵（`COLLECTION_KEY_NOT_ALLOWED`）。兩個一樣的集合鍵也是這一個，不算重複鍵。
7. 根不是 mapping；頂層換成同一個名字的兩個鍵（`true` 與 `"true"`），講成 `DUPLICATE_KEY`。
8. `version`、`records`、`refs` 的形狀；接著 `refs` 裡換成同一個名字的兩個鍵（`DUPLICATE_KEY`）；最後是 `refs` 裡一條一條的
   `bad-name`、`not-string`、`empty-string`。

第 6 步排在第 7、8 步之前，所以 `refs` 裡的集合鍵即使排在名字形狀不對的鍵之後，回的也是集合鍵。

兩個 YAML 函式庫的語法錯誤碼不同（`yaml` 分成 `BAD_INDENT`、`UNEXPECTED_TOKEN`…，Rust 宿主一律 `YAML_SYNTAX`），行欄也可能差一點，
`reason` 一樣是 `yaml`。nexus 自己的錯誤碼會不同的已知情形有兩種：

- 沒有對應錨點的別名後面又有語法錯：`saphyr-parser` 停在別名，回 `ALIAS_NOT_ALLOWED`，TS 回後面那個語法錯。
- 沒寫鍵的 `:` 後面同一行接區塊集合（`: : x`、`: - x`、`- : : x`、`? : - x`、`: ? x`）：`yaml` 自己報語法錯（`BLOCK_AS_IMPLICIT_KEY` 或
  `UNEXPECTED_TOKEN`），在第 2 步就回；`saphyr-parser` 把它讀成「空鍵加值」，沒有語法錯，走到第 5 步回 `EMPTY_KEY_NOT_ALLOWED`
  （鍵前面有 `?` 的回 `EXPLICIT_KEY_NOT_ALLOWED`）。共用樣本裡這幾條（名字以「已知差異」開頭）只釘 `reason`，沒有 `code`；
  兩邊的錯誤碼各自釘在 `credentials.test.ts` 與 `host/tests/credentials.rs`。

- `records` 拒絕而不是當外來鍵放過：nexus 沒有這種憑證，放過它會讓人以為存進去的東西有作用（`:391-395`）。
- 測試：`credentials.test.ts` 的 `parseCredentialsDocument` 那組，「records 仍然拒絕……」與「%s：拒絕，訊息指名檔案、不含秘密」。

## 只警告、不擋

`version`、`refs`、`records` 以外的頂層鍵不擋啟動，`refs` 照常解析。鍵名（`ignoredKeys`）與各自的行號（`ignoredLines`）交回呼叫端，
**照檔案順序**（`:418-423`）：像整數的鍵（例如 `2024`）也不往前排，樣本「外來的頂層鍵：像整數的鍵也照檔案順序」釘住這一點。
服務經 `warn` 講一次，**只講個數與行號，不印鍵名也不印值**（`:512-516`）：鍵名的位置可能被誤貼了 key（見〈錯誤訊息〉）。
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

- 拒絕訊息是 `受管憑證檔 <路徑> 認不得：<原因>`，**不引值，也不引鍵名**。YAML 錯誤只寫錯誤碼與行欄（`describeYamlError`，`:122`），
  不帶出錯那一行，因為那一行可能就是秘密。值不是字串時也只說「要是字串」，不說是什麼型別。
- **鍵名不印，只講位置**（[#2667](https://github.com/DemianLi/nexus-agent/issues/2667)）：把 key 誤貼在鍵名的位置時，鍵名就是秘密，而且
  `not-string`、`empty-string` 的鍵名形狀合法，分不出來。三種訊息都寫 `refs 第 L 行第 C 欄`：`bad-name` 再加鍵名的長度（字元數），
  `not-string` 是「那一把要是字串」，`empty-string` 是「那一把是空字串」。行、欄從 1 起算，指的是鍵的開頭。
- **欄照字元（code point）數**（`locator`，`:113-119`）：BMP 以外的字元（例如 emoji）算一欄，跟 Rust 宿主一致；`yaml` 的 `LineCounter`
  照 UTF-16 code unit 數，那種字元會算成兩欄。檔頭的 BOM 算在第 1 行的欄裡。
  外來頂層鍵的警告同理（〈只警告、不擋〉）。
- **YAML 函式庫自己的警告關掉**（`logLevel: 'error'`，`:362-364`）：鍵是集合（例如 `? [nvapi-…]`）時，`toJS()` 會把它字串化，
  預設經 `process.emitWarning` 把整個鍵印到 stderr。集合鍵現在在 `toJS()` 之前就拒絕，這個設定留著當第二道。

測試：`credentials.test.ts`「%s：拒絕，訊息指名檔案、不含秘密」、「鍵名不進訊息與日誌」那組（含「%s的集合鍵：yaml 自己的 process 警告不把鍵印出來」）；樣本 `reject[].secret`，
其中「鍵的位置貼了……」三條的 `secret` 是鍵名。

## 內容不進環境變數

解析出的值只在服務回傳的物件上，不寫進行程的環境變數，子行程不會順手繼承到（跟兩份 `.env` 不同，那兩份會寫）。
唯一的例外是 MCP 那一列用 `{ credential: <名字> }` 明著引用的，只交給那一台 server（`packages/nexus-plugin-mcp/src/credentials.ts`）。

測試：`credentials.test.ts`「受管檔的值不會被寫進 target」；`mcp-credentials-wire.test.ts`。

## MCP 憑證值的遮蔽

MCP 那一列用 `{ credential: <名字> }` 引用的值，會代進 server 的環境變數或 header。server 把它回顯在錯誤、成功的工具結果、resources、instructions 或工具描述裡，
都會原樣進模型的上下文與會話日誌，所以送回對話行程的文字要先遮掉（[#2570](https://github.com/DemianLi/nexus-agent/issues/2570)、[#2669](https://github.com/DemianLi/nexus-agent/issues/2669)）。

**值檢查（代入之前）**：修掉頭尾空白之後，

- 空的拒絕（`empty`）；
- `env` 含 NUL 拒絕（`nul`）；`header` 含 tab、0x20–0x7E、0x80–0xFF 以外的字元拒絕（`header-chars`）；
- **少於 8 個 code point 拒絕**（`too-short`）。以 code point 算，不是 UTF-16 單位或位元組：一個中文字、一個補充平面的表情符號都算一個。

「空白」跟 JS 的 `String.prototype.trim` 一樣：U+FEFF 修掉，U+0085 不修。拒絕訊息只講憑證名、來源層與規則。
短值拒絕的理由是遮蔽不能靠「短的不遮」來避開誤判（那等於洩漏）：憑證值不到門檻就在源頭擋掉，太短、偶然撞上正常內容的值進不了遮蔽器。
短的非秘密值（帳號、埠號）改寫成設定裡的字面值。8 是以偶然命中的機率估的，定在 #2570。

**遮蔽（送出之前）**：

- **收集**：入口只有一個，宿主的 `Redactor::new(values)`（`host/src/mcp/redact.rs`）：呼叫端把這一份連線手上的值交進去。今天交進去的是：
  - header 的值，除了 `LITERAL_HEADERS`（`config.rs`）：`Accept`、`Content-Type`、`User-Agent`、`Accept-Language`、`MCP-Protocol-Version`（不分大小寫）。這幾個是協定層、一定不是秘密，值不進遮蔽器。
    值取原始位元組：能解成 UTF-8 就收那個字串，含非 ASCII 時另收逐位元組當 Latin-1 的字串。`Authorization` 與 `Proxy-Authorization` 另收 scheme 後面那一段（server 常只回顯 token）；
  - 網址的 query：整串、每個值的原樣與解碼後，全部收；TS 的 `redactorFor` 同樣收，**唯一不同：不到 8 個 code point 的值不收**，整串、原樣、解碼後各個形式各自算（所以非 ASCII 的短值，百分號編碼後的原樣若有 8 個以上字元就收）。理由是 TS 的斷線判斷讀遮過的訊息，`v=2` 的 `2` 會切斷 `MCP error -32000`；整段 `?…` 的比對仍遮逐字回顯；
  - 代理的帳密；
  - stdio：`connection.credentialEnv` 標的那幾個環境變數的值，**只有這些**。TS 看得到每個值的來源（`apps/harness/src/mcp-host-stdio-row.ts`），所以 stdio 不用 header 那種「分不出來就全收」的近似：`PATH`、`HOME` 這類清洗後的父環境與字面值都不進，成功結果不會被遮壞。每個值照上面的值檢查。

  憑證引用解出來的值之後走同一個入口。**過渡：** 宿主收到的是 TS 解好的成品，分不出一個值是憑證還是設定裡寫死的字面值，所以今天其餘的 header 與 query 值一律當秘密收，字面值也會被遮。憑證引用接到宿主（PR-E）之後，只收憑證解出來的值，字面值不再收集，`LITERAL_HEADERS` 也拿掉。
  網址的 `user:password@` 設定時就拒（見 `docs/host-mcp.md`），不進入口；遮蔽器本身不分來源，帶 userinfo 的字串照樣遮（樣本「網址 userinfo 的帳密」）。
- **形式**：每個值收原值、`encodeURIComponent`、form 編碼（空白寫成 `+`，保留的字元也不同）、JSON 字串裡的跳脫（`"`、`\`、控制字元；非 ASCII 另收 `\uXXXX`，補充平面用代理對；也收把 `/` 寫成 `\/` 的）。
  百分號與 `\u` 的十六進位只收全大寫與全小寫，不收同一段裡大小寫混用的。
- **替換**：在原文上找出所有值、所有形式的命中區間，合併重疊與相鄰的，一次換成 `[redacted]`。不是逐值各換一次，所以兩個重疊的值不會漏，占位字串也不會被後面的值打中。
- **範圍與出口**：送回對話行程的文字有三條出口，都先遮：
  - 結果與 resources（含 `isError`）走 `bridge.rs` 的 `outgoing`，工具清單走 `outgoing_tools`：遮 JSON 值裡的字串，在序列化之前做，所以換掉的區間不會跨過 JSON 的引號；
  - instructions 走 `Shared::redact_text`；
  - 錯誤走 `Shared::scrub`；連線診斷在 `connection::connect` 回錯之前就 `scrub` 過。
- **不遮的欄位**：遮完的清單必須還能用，所以 server 之後要原樣收回去的識別不動：
  - 物件的鍵（工具 schema 的參數名、結果的欄位名）；
  - 工具清單裡每個工具自己的 `name`（`tools/call` 要用）；
  - 值是字串的 `uri` 與 `uriTemplate`（resources、resource_link；`resources/read` 要用）。

  其餘字串（描述、內容、resource 的 `name`）都遮。server 若把秘密放在這些識別欄位裡，會原樣送回，這是不遮它們的代價。
- **短的字面值**：header 的短字面值（例如 `X-Mode: ab`）與網址 query 裡的片段（`limit=10` 的 `10`）不到 8 個字元，不會是憑證。它們只在錯誤與診斷裡遮（reqwest 會把網址印進錯誤），不遮成功結果：遮了會把 server 正常的回答改壞。
- **TS 收的 query 值（#2669）的後果**，接 PR-2b 的人要知道：
  - 8 個 code point 以上的 query 字面值（`?workspace=production-eu`）進了「到處遮」那一組。`Redactor.redactText`（成功結果）今天沒有呼叫端，所以成功結果不受影響；PR-2b 接上之後這類值會在成功結果裡被遮。與宿主的過渡做法一致，但和 TS 對 header 字面值、stdio 只收憑證的原則不同；
  - 錯誤與診斷裡會過度遮蔽：query 值若也出現在 host 或別處（`?env=production` 對 `production.example.com`），那段文字也被換成 `[redacted]`；
  - 8 個 code point 的門檻不是完整保證：`?state=connected` 的值夠長、會收，於是 `Not connected` 被遮，斷線判定（`isConnectionLost`）失效；`?x=TimeoutError` 讓以 `name` 判斷的 `TimeoutError` 認不出（SDK 的 `REQUEST_TIMEOUT` code 不受影響）。
- **沒收的形式**：截斷（只回顯值的前半）、部分編碼（`encodeURI`、Python `quote` 的預設只編一部分字元）、值本身被轉大小寫（宿主與 TS 都漏）；base64（例如 `Authorization: Basic` 把帳密編成 base64）、HTML 實體、雙重百分號編碼；`<` 這類別家編碼器多跳脫的寫法（`\u003c`）；百分號或 `\u` 後的十六進位大小寫混用；
  一個值被拆在兩個字串裡（例如分兩個 content 區塊）；JSON 的數字（`{"pin": 12345678}` 不遮，值檢查不限數字）。值被 server 轉成這些形式再回顯就遮不到。

測試：樣本 `mcpValue[]`、`redact[]`；`host/tests/mcp_stdio.rs`（stdio 只收 `credentialEnv`、字面值照舊、子行程的環境只有交來的那份）；`host/tests/mcp_redact.rs`（含經真的橋的：成功結果、編碼形式、代理帳密、只回顯 token、協定層 header 不遮、名稱含字面值的工具仍叫得動、instructions、`isError`、resources）；TS 的 `mcp-credential.test.ts`「長度下限」那組。

## 重讀

不監看檔案。每次解析先 `stat`，簽章是 **mtime、size、ino、mode 四項**（`:489`），跟上一次一樣就用快取，不一樣才重讀。
所以改了檔，下一次解析就是新的：模型 key 是下一個請求，MCP 是下一次建連線（下一條新對話；已建好的連線抓住舊值）。沒有解析就不重讀。

| 情況 | 結果 | 程式 |
| --- | --- | --- |
| 檔不存在 | 這一層是空的，往下一層找；清掉上一份可用的內容 | `:491-494` |
| 第一次讀就壞（`stat` 失敗、權限、格式、讀檔失敗） | 拋 | `:474` |
| 讀好過之後改壞（權限、格式、讀檔失敗） | 續用上一份可用的內容，警告一次（同一個簽章不重複講；讀成功一次就重新算，`:498`、`:509`） | `:506`、`:473-480` |
| 讀好過之後 `stat` 本身失敗（`ENOENT` 以外，例如 `EACCES`） | 同上一列，續用上一份並警告一次；這時沒有簽章，以 `stat:<錯誤碼>` 去重（[#2667](https://github.com/DemianLi/nexus-agent/issues/2667)，同 dsh 的熱重載） | `:495` |
| 讀好過之後刪掉，有一次解析看到檔不存在，再建成壞檔 | 上一份已經清掉，等於第一次讀：拋。刪掉與重建都在兩次解析之間的，只看得到簽章變了，照「讀好過之後改壞」那一列續用 | `:491-494`、`:474` |

測試：`credentials.test.ts` 的「重載：每次解析先 stat，變了才重讀」那組，以及「執行期被改成只剩註解……」、
「外來的鍵之後又改壞 refs……」；`credentials-stat.test.ts`（`stat` 本身失敗，用 mock 造錯）。重讀的時序不做成樣本。

## 沒有寫入路徑

nexus 不寫這份檔：沒有設定頁，由管理者手動編輯。`apps/harness/src` 與 `packages/*/src` 裡沒有寫入它的程式，`credentials.ts` 只有
`statSync` 與 `readFileSync`。
將來加寫入路徑時，檔以 `0600`、目錄以 `0700` 建立（`owner-only.ts` 的 `PRIVATE_FILE_MODE`、`PRIVATE_DIR_MODE`）。

## 哪些入口掛受管檔

服務以 `store` 旗標區分，沒有預設值（`credentials.ts` 的 `CredentialServiceOptions.store`）。

| 入口 | `store` | 程式 |
| --- | --- | --- |
| serve | `true`，受管檔最優先 | `serve-run.ts:890`、`:975-979` |
| plugin 試組 | `true` | `plugin-trial.ts:104-108` |
| CLI | `false` | `cli.ts:977`、`:1214` |
| eval | `false` | `eval/compare-cli.ts:156`、`eval/survey-cli.ts:171` |
| spike | `false` | `spike/cli.ts:24` |

- `store: false` 時完全不碰這份檔：不 `stat`、不讀、不檢查，壞掉的檔也不擋（`:525`、`:542`）。
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

引用在 dsh `8bd073392eef` 核對過。
不帶路徑的 `:行號` 指 `packages/credentials/credentials-local/src/index.ts`。

- **兩邊的找值順序照 dsh。** serve 對應 dsh 的 Web profile，受管檔最優先，理由同 `:1-20`：使用者明確存進受管檔的 key 要一致生效。
  dsh 的決策紀錄 `.agents/notes/implemented/architecture/2026-10-09-stored-credential-precedence.md`（在 dsh repo 裡）否決了「受管值蓋掉環境值時警告」（第 38 行），nexus 照採。
  一次性入口（CLI、eval、spike）對應 headless profile，不掛受管檔，理由同 dsh 的 `2026-10-12-headless-environment-auth.md`（同一個目錄）。
  沒有儲存值時退回啟動環境，同 dsh `packages/credentials/credentials-local/README.md:80`；`ambientCredentials` 是沒掛受管檔時只看環境的那一份服務。
  受管檔擋不住以同一個使用者身分跑的 agent，dsh 的 README 也明說了（`README.md:12`）。起動時印的那一行來源（`describeKeySource`）對應 dsh `describe` 回報的 `source`。
- **名字的形狀**同 dsh `packages/credentials/credentials/src/index.ts:19` 的 `REF_PATTERN`。
- **空的倉庫**同 dsh：`toJS() ?? {}`，空的 mapping 不要求 `version`（`:203`、`:209-211`）。
- **`refs` 裡面一律拒絕、外來頂層鍵只警告**同 dsh 的規則（`:179-185`、`:228`、`:883-890`）。nexus 的警告不印鍵名，這是偏離，見〈錯誤訊息〉。
- **偏離：重讀不監看檔案。** dsh 用 chokidar 監看，寫入後等 100ms 穩定才重讀（`:40`、`:92`、`:582-586`）。
  nexus 每次解析先 `stat`，簽章變了才重讀：模型每次請求都會取 key，所以「改了檔、下一次請求就用新的」照樣成立，少一個相依，測試裡也沒有計時器要處理。
  代價是沒有請求就不重讀，也就不會在請求之外提早發現檔案壞了；啟動那一次照樣完整檢查。
- **執行期重讀失敗保留最後一份並警告**同 dsh 的熱重載，見〈重讀〉。
- **偏離：沒有 `records`。** nexus 沒有第二種憑證（`grant`／`api-key` 記錄），`records` 這個鍵照舊拒絕，不跟其他外來鍵一起放過。
  理由用 dsh 自己的規則（`:179-183`）：nexus 不會用 `records` 裡的東西，放過它，使用者會以為存進去的 grant 有作用。
- **偏離：拒絕指令、明示 tag、錨點與別名**（[#2667](https://github.com/DemianLi/nexus-agent/issues/2667)）。dsh 只看 `document.errors`（`:198-202`），這幾樣都收，別名照常展開。見〈形狀〉。
- **偏離：拒絕解析前的四種字元、超過 64 層的巢狀與集合鍵**（[#2570](https://github.com/DemianLi/nexus-agent/issues/2570)）。dsh 只有一個 TS 解析器
  （`packages/credentials/credentials-local/src/index.ts:198`、`:246` 的 `parseDocument`，沒有字元前置檢查、深度上限與集合鍵檢查），
  沒有第二個實作要對齊；nexus 的宿主用 Rust 自己解析，這三類是兩個 YAML 函式庫實測讀出不同結果的地方，整份拒絕才能讓兩邊跑同一份樣本得到同樣的結果。
  NUL 與檔中間的 U+FEFF 在 dsh 會靜靜進到值或鍵名裡；只用 CR 換行的檔在 dsh 多半以別的 YAML 錯誤拒絕，沒拒絕的會把 CR 當成內容讀錯。見〈形狀〉。
