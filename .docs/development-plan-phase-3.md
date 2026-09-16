# 開發計劃：Phase 3 — 記憶層

**這是 [`development-plan.md`](development-plan.md) 切出來的一節**，內容原封不動，沒有改寫。
切檔的理由與量測見 [#364](https://github.com/DemianLi/nexus-agent/issues/364)：主檔 98,379 字元裡
這三塊佔 62%，而每次讀取只需要其中一塊。

**結論速查在主檔**，本檔不重複。回主檔：[`development-plan.md`](development-plan.md)。

---

### Phase 3 — 記憶層（約 3 個 PR）

**動工前查過一輪基座（`deepagents@1.13.1`，`dist/langsmith-zm0ILQsV.js`）。這次「基座已內建」是真的**——`createMemoryMiddleware`、`createSkillsMiddleware`、`createSummarizationMiddleware` 三個都在，`createDeepAgent` 上還有一等公民的 `memory?: string[]` 與 `skills?: string[]` 參數，而且 `@nexus/core` 的 `skills` / `memory` 註冊點與 fold 在 Phase 1 就接好了。**錯的是「完整」**：三個都只做「注入」，沒有一個做「保存」。以下每條都標了實測依據。

- `feat/memory-plugin`：AGENTS.md memory 來源 plugin ＋ 狀態儲存決策收斂。三件實測事實決定它的形狀：

  1. **memory middleware 是唯讀的。** 只有 `beforeAgent`（讀）與 `wrapModelCall`（注入 system prompt），**不註冊任何工具**。記憶要寫回去，唯一的路是模型自己呼叫 `write_file`。所以「記憶留不留得住」是 **backend** 的問題，跟 checkpointer 無關。
  2. **來源路徑不展開 `~`。** `loadMemoryFromBackend` 把路徑原樣交給 backend 的 `downloadFiles` / `read`。基座 JSDoc 裡那個 `"~/.deepagents/AGENTS.md"` 是**已 deprecated 的 `createAgentMemoryMiddleware`** 留下的——`os.homedir()` 只出現在 node-only 的 `createSettings`，backend-agnostic 這條路上一次都沒有。照抄那個例子的下場：`ContainedFilesystemBackend` 讀時放行、找不到字面上的 `~` 目錄 → 靜默沒有記憶；而寫回去會撞上我們自己那條 `"~"` 檢查。**來源一律用 backend 命名空間下的絕對路徑。**
  3. **載入失敗是靜默的，而且靜默是構造出來的。** 每個來源包在 `try / console.debug` 裡，收進來的條件又是 `if (content)`——空字串是 falsy，所以**讀不到、不存在、讀到空檔三者同形**，都塌成 `(No memory loaded)`。`memoryContents` 再快取在 state（`if ("memoryContents" in state ...) return`），配上 checkpointer 就是**一個 thread 只載一次**，thread 中途改 AGENTS.md 不生效。

     **原文這裡寫「一條蓋到記憶檔的 deny 規則 = agent 安靜地沒有記憶」，實測是反的。** `loadMemoryFromBackend` 呼叫的是 `backend.downloadFiles` / `backend.read`——**backend 方法，不是工具**，而 `checkPermission` 只活在七個工具工廠裡。所以 deny 規則**擋不住記憶載入**：檔案內容照樣被注入 system prompt，同時模型被指示「學到東西就用 `edit_file` 存起來」——存去一個規則明文禁止它寫的檔。**讀得到、寫不回去**，而不是沒有記憶。

     這是 [#66](https://github.com/DemianLi/nexus-agent/issues/66) 那件事的第三次現身：**規則表管工具，管不到 backend 方法**。差別在方向——offload 那邊是「該寫的沒寫成」，這邊是「該擋的沒擋住」，後者把檔案內容送進了模型的 context，比前者嚴重。

     真正會造成「安靜地沒有記憶」的是**路徑寫錯**（`~`、相對路徑、`..`）。這一條因此收在 `@nexus/core` 的 `assertLoadableMemoryPath`：**在註冊期擋，不在跑起來之後**。放在 registry 而不是 plugin，是因為一道只有某個 plugin 做的檢查補不住一個「不經過那個 plugin 就沒人擋」的洞——也因此 `registry.memory` 原本「純累加、基座自理」的契約要跟著改。這跟 `permissions.deny()` 刻意不驗第二次是相反情況而非不一致：那邊基座自己會拋，這邊基座什麼都不做。

     **對 dsh 的偏離（標註）**：dsh 的對應機制 `@deepseek-ai/dsh-agent-instructions` 收的是**檔名候選**（`['AGENTS.md', 'CLAUDE.md']`），`resolveInstructionFileCandidates` 把任何含 `/` 的候選連同 `RESERVED_PATH_SEGMENTS`（`''` / `'.'` / `'..'`）**靜默濾掉**——因為往上找 project root 的走查與 `~` / `$DSH_HOME` 的展開都由 loader 自己擁有。**這個形狀在 deepagents 上表達不出來**：`memory` 參數收的就是 backend 路徑，它的 loader 不走查也不展開任何東西。退到最接近的：**擋下 dsh 濾掉的同一組路段，但改成拋錯**。靜默濾掉在 dsh 那邊無害（濾完還有其他候選與走查），在這裡等於把唯一的來源刪掉，正好製造出這道檢查要防的那種靜默。

  4. **subagent 拿不到 root 的記憶，而且沒有任何公開介面給得了。** `buildSubagentMiddleware(input, isForkable)` 只在 `isForkable` 為真時併入 root 的 memory middleware，`SubAgent` 定義上**沒有 `memory` 欄位**可以自帶（`createSubagentDefaultMiddleware` 有 `input.skills` 分支，沒有 memory 的）。general-purpose subagent 也一樣：它是一般的 subagent，走 `normalizeSubagentSpec`（`isForkable` 為 false）。（當時寫的是基座自己補的那份，它那次 `mergeMiddlewareStack` 帶 `{ appendNew: false }`；後來換成 `foldRegistry` 自己註冊的，因為基座那份連核准閘門都拿不到，見 `fold.ts` 的 `generalPurposeSpec`。）只有 `mode: 'fork'` 的 subagent 有。這跟下面 `feat/summarization-tuning` 記的「root 換掉不影響 subagent」是同一種邊界，要有絆索測試。

  「多來源併入 prompt」的形狀斷言照舊補（[#32](https://github.com/DemianLi/nexus-agent/issues/32)）——這一條查過是真的：`formatMemoryContents(contents, sources)` 依 `sources` 順序串。

- `feat/skills-plugin`：SKILL.md 來源 plugin。**progressive disclosure 是純 prompt，不是機制**——middleware 只把 name／description／path 注入 system prompt，然後用文字叫模型自己 `read_file`。動工前又查了一輪，原本的四條有兩條要更正、另外三條是原本沒寫的：

  1. **skills 的讀取走 `permissions`——但不走我們的 fence。原文寫「與我們的 fence」是錯的。** `ContainedFilesystemBackend` 只在寫入路徑加 fence，讀一律通過（那是 Phase 2 的定案：讀的策略歸 `permissions`，兩層正交）。所以擋人的自始至終只有 `permissions` 一層。

     「看得到、讀不到」本身成立，而且是這個擴充點的預設失敗模式：清單走 `listSkillsFromBackend` 的 `ls` / `downloadFiles`（**backend 方法，不經規則表**），正文走 `read_file` 工具（**經規則表**）。一條蓋到 skill 路徑的 deny 規則因此不會讓 skill 消失，只會讓它好端端列在 prompt 裡、模型每次去讀都被拒。已有測試（實測回傳 `Error: permission denied for read on /skills/<name>/SKILL.md`）。

     這是 [#66](https://github.com/DemianLi/nexus-agent/issues/66) 那件事的第四次現身，但**後果比記憶那次輕**：記憶那邊 deny 擋不住整份內容進 context，這邊只有 name 與 description 進得去，正文真的擋住了。差別在於 skills 的兩條路一半經過規則表、一半不經過。

  2. `allowedTools` frontmatter **解析了、印進 prompt、零強制**——原文寫「9 個出現點」，實測是 **7 個**（zod schema、解析、`formatSkillsList` 印一行），沒有一個是強制點。不能當權限用。
  3. `module` frontmatter 只印一行 `await import("@/skills/<name>")`，**沒有東西實作那個 import**（全包 `@/skills` 只有那一個出現點）——[#64](https://github.com/DemianLi/nexus-agent/pull/64) 已記錄過同一件事。
  4. **快取比 memory 更硬，但只在載到東西的時候。原文的「per-agent-instance，跨 thread 都不重載」兩個方向都不完整。**

     - **空的不算。** 載入結果為空時 `loadedSkills.length > 0` 是 false，於是**每一次 `beforeAgent` 都重掃整個來源**。實測：有 skill 的來源兩次 `invoke` 只掃 1 次，空的來源掃 2 次。一個沒有 skill 的工作區是最貴的那種，這件事原文完全沒提到。
     - **閉包與 state 是雙向的，不是單向快取。** 空閉包 + state 有 `skillsMetadata` → `loadedSkills = state.skillsMetadata`；非空閉包 + state 沒有 → 回寫 `{ skillsMetadata: loadedSkills }`。所以配上 checkpointer，一個**全新的 agent 實例**會從 thread 的 checkpoint 撿回舊 skills——「per-agent-instance」在有 checkpointer 時不成立。

  5. **skills 與 memory 的 subagent 繼承規則正好相反。**（原本沒寫）`createSubagentDefaultMiddleware` 有 `input.skills` 分支，而 general-purpose subagent 被塞進了 root 的 `skills`——**它拿得到**（當時是基座自己補那份時在 `normalizeSubagentSpec` 塞的，現在是 `foldRegistry` 註冊時照抄的）；自訂 subagent 沒人幫它塞，要自帶 `skills` 才有。基座註解明說：「Custom subagents do NOT inherit skills from the main agent by default. Only the general-purpose subagent inherits the main agent's skills.」

     對照上面 `feat/memory-plugin` 第 4 條：memory 只有 `mode: 'fork'` 的 subagent 拿得到，general-purpose **拿不到**。淨結果是同一組 subagent 上兩個擴充點互為反面——**fork 有 root memory 沒 root skills，general-purpose 有 root skills 沒 root memory**。已有兩條絆索釘著。

  6. **基座驗證 skill 的名字，但驗完不擋。**（原本沒寫）`validateSkillName` 檢查 kebab-case、長度、以及「`name` 必須等於目錄名」，任一條不過都只是 `console.warn`，**metadata 照樣進清單**。三種失敗還是三種音量：讀不到（`ls` 失敗 / `SKILL.md` 讀不到）**完全無聲**、frontmatter 壞掉有 `console.warn`、名字不合規範有 warn 但照收。

  7. **來源路徑的註冊期檢查比照 memory，但規則不同**（`assertLoadableSkillsPath`，`@nexus/core`）。**不能重用 `assertLoadableMemoryPath`**：那個明文拒絕結尾斜線（「記憶來源是檔不是目錄」），而 skill 來源**就是目錄**，基座還會自己補斜線。路徑寫錯的下場是 prompt 裡出現 `(No skills available yet...)`，字面上像「這個工作區還沒有 skill」，實際上是「那個目錄根本不存在」——比記憶那邊的 `(No memory loaded)` 更難察覺。順帶刻意收窄一格：基座支援 `\` 分隔，我們擋掉，理由是 backend 命名空間不是宿主檔案系統。

     **接受結尾斜線就得讓重複檢查跟上。** `/skills/` 與 `/skills` 是同一個目錄，而 `skills` 註冊點的重複檢查原本拿原字串當 key——兩個 plugin 各寫一種就兩筆都進去，基座載兩次只會讓同名 skill 自己覆蓋自己，正好是那個檢查要擋的事。改成 **key 用正規化後的、value 留 plugin 寫下的原文**：交給基座的仍是原文，撞名看的是目錄。

  **對 dsh 的偏離（標註）**：dsh **有**這個 seam，而且比 deepagents 完整得多——`packages/skill/` 下四個套件（`skill` 純註冊表、`skill-filesystem` 本地提供方、`tool-skill` 面向模型的 loader、`skill-badge`）。三格表達不出來：

  - **progressive disclosure 在 dsh 是真機制**：`ctx.skills.get(name)` 由 loader 工具執行、每次載入重讀當前檔案，所以「正文編輯不需要 hash、修訂號、快取失效」。deepagents 這邊正文讀取是模型呼叫 `read_file`，那一格意外地同向；真正不同向的是**目錄**——dsh 有 Chokidar watcher 失效，deepagents 載到就凍住。退到：絆索釘住「目錄凍住」。
  - **調用策略是 fail-closed**：dsh 的 `disable-model-invocation` / `user-invocable` 遇到駝峰拼寫或非布林值會**把整個 skill 從發現結果排除**，理由明文寫著「忽略無效資料可能在已停用的介面上暴露 skill」。deepagents 的 frontmatter 解析整個關在 `parseSkillMetadataFromContent` 裡，plugin 這側碰不到。退到：不動基座行為，用絆索釘住「不合規範的名字照樣進清單」。
  - **rank 與預設根**：dsh 收的是 `customSkillDirs`（**額外**根），疊在五個 rank 過的預設根之上（project `.dsh/skills`=100、`.agents/skills`=200、custom=300、user `<dshHome>/skills`=400、`<agentsHome>/skills`=500），project root 由「最近含 `.git` 的祖先」走查決定。deepagents 的 `skills` 就是一組平等的 backend 路徑，沒有 rank、沒有走查、沒有 `$DSH_HOME`。退到：照 `sources` 的有序 last-wins，把 rank 語意能保留的唯一一格（順序即優先序）寫進 plugin 文件，並在註冊期擋掉 dsh 的 `RESERVED_PATH_SEGMENTS` 那一組路段。

  skills last-wins 的形狀斷言照舊補（[#32](https://github.com/DemianLi/nexus-agent/issues/32)）——這一條查過是真的：`allSkills.set(skill.name, skill)` 依 `sources` 順序覆蓋。**但只說對一半**：`Map` 的迭代順序是**第一次**插入的順序，所以覆蓋換的是內容與路徑，**不換它在清單裡的位置**。斷言要照這個形狀寫。

- `feat/summarization-tuning`：**基座上沒有「參數化」這個參數。** `createSummarizationMiddleware({ backend })` 被無條件寫死進 root 與每一個 subagent 的 stack，`CreateDeepAgentParams` 上沒有任何 summarization 欄位。唯一的縫是 `mergeMiddlewareStack` **按 `.name` 原地取代**：自己建一個同名（字串 `"SummarizationMiddleware"`）的 middleware 從 `middleware` 參數傳進去，就換掉內建那個。fold 這一側是通的（`foldMiddleware` 只做 `prepend` 排序，不包不改）。動工前又查了一輪，原本的兩件變成**四件**：

  1. **這條縫掛在一個字串上**，要有絆索測試——基座改名或改合併語意時它該紅。**而且絆索要斷言「取代」而不是「有生效」**：兩者在行為上分不出來，差別只在內建那個還在不在（還在的話對話會被摘要兩次）。實測是原地取代——stack 仍是四個、位置沒動、`SummarizationMiddleware` 那一格換成我們的。

  2. **這條縫的價值不只是「換掉」，而是它是唯一的設定入口。**（原本沒寫）`historyPathPrefix` 是 `createSummarizationMiddleware` 的選項（預設 `/conversation_history`），`trigger` / `keep` / `summaryPrompt` / `trimTokensToSummarize` 也都是——而基座無條件建的那個**只吃 `{ backend }`**。所以同名取代不是「調校的手段之一」，是**唯一**能碰到這些參數的路。原文把 `/conversation_history` 當成寫死的常數，那是錯的。

  3. **root 換掉不影響 subagent。** `createSubagentDefaultMiddleware` 每個 subagent 各建一份新的，`buildSubagentMiddleware` 只併 `input.middleware`。而長任務的 token 大戶正是 subagent，所以「長任務 token 控制」靠換掉 root 那個是**結構上就不完整的**——要嘛每個 subagent 定義自己帶，要嘛承認這個邊界並寫下來。已有絆索。

     **`harnessProfile.excludedMiddleware` 是第二條縫，但它不是這個邊界的解法。**（原本沒寫）`REQUIRED_MIDDLEWARE_NAMES` 只有 `FilesystemMiddleware` 與 `SubAgentMiddleware`，所以排除 `SummarizationMiddleware` 是被允許的，而 `buildSubagentMiddleware` 結尾那個 filter 讓排除**對每個 subagent 都生效**——射程確實比同名取代大。但兩件事讓它出局：它只能**排除**不能替換（排掉等於 subagent 完全沒有摘要，長對話直接爆 context），而且它走的是**全域 profile registry**（`registerHarnessProfile` / `resolveHarnessProfile`）、靠 model spec 字串或 provider hint 查表，`CreateDeepAgentParams` 上沒有這個欄位。那是全域可變狀態加模型識別綁定，不是組裝點的參數，更不是 plugin 表達得出來的東西。

  4. **offload fail-open 的測試收在這張 PR。**（原本沒指派給任何一張）機制全在這裡，不收進來就會夾在兩張 PR 中間掉下去。詳見下面「跨 Phase 的坑」。

- **跨 Phase 的坑（Phase 2 埋的）**：summarization 的 offload 寫到 `/conversation_history`。我們的 `ContainedFilesystemBackend` 在 `read-only` mode 下會擋掉它——而基座對 offload 失敗是 **fail-open**：`console.warn` 之後照樣把訊息換成摘要（`Proceeding with summary generation.`）。也就是**完整歷史靜默消失，只留一行 warn**。已收進 `feat/summarization-tuning` 並有測試（實測 warn：`Failed to offload conversation history to /conversation_history/session_*.md: [containment] 拒絕 write ...`，而四次 invoke 全部正常回話）。

  **原文寫「走 backend 的 `uploadFiles`」只對了三分之一。** `offloadToBackend` 有三條分支：沒有既有檔走 `write()`、有既有檔且 backend 有 `uploadFiles` 走 `uploadFiles()`、有既有檔但沒有 `uploadFiles` 走 `edit()`。三條我們的 fence 都覆寫了，所以三條都擋得住——結論不變，但理由要對。

  **而 `/conversation_history` 有第二個寫入者，比這個更安靜。**（原本完全沒寫）`createFilesystemMiddleware` 的 `beforeAgent` 有一條**超大 human message 的 eviction**：最後一則 human message 超過 `4 * humanMessageTokenLimitBeforeEvict` 字元（預設 `5e4`，即 20 萬字元）時，把它寫進 `/conversation_history/<uuid>` 並在送進模型時換成一句佔位。兩個差別都往壞的方向：**路徑寫死**（不吃 `historyPathPrefix`，同名取代那條縫救不了它），**失敗完全靜默**（`if (writeResult.error) return;`，連 `console.warn` 都沒有）。

  而它失敗的**方向跟直覺相反**：fence 擋住的時候不是「原話消失」，是原話**原封不動**送進模型——20 萬字元直接灌進 context，正是 eviction 本來要避免的事。已有兩條測試（可寫時落檔一個檔、模型只收到 `Message content too large`；`read-only` 時零落檔、原話完整進 prompt）。

  兩個寫入者都要在 Phase 3 有測試，不能等它們在長對話裡自己發生——現在都有了。

  **而 `permissions` 對這條路完全沒有作用**——`checkPermission` 只在七個工具工廠裡被呼叫（`createWriteFileTool` / `createEditFileTool` / `createReadFileTool` / `createLsTool` / `createGlobTool` / `createGrepTool` 與 delete 那條），**不在 backend 方法上**。`uploadFiles` 是 backend 方法、不是工具，所以 offload 從來不經過規則表：一條蓋到 `/conversation_history*` 的 deny 規則**擋不住它**，歷史照樣寫進一個規則名義上禁止的路徑。這正好是 `contained-backend.test.ts` 那句「讀不經過 fence——讀的策略歸 permissions，兩層正交」的另一面：**寫不經過 permissions，寫的圍堵歸 fence**。

  兩件事都要在 Phase 3 有測試，不能等它們在長對話裡自己發生。

- **`feat/summarization-tuning` 的動工前一驗（第十二次）：上面那四點與「跨 Phase 的坑」**已經**在 [#70](https://github.com/DemianLi/nexus-agent/pull/70) 落地了**（`test: 釘住摘要層的設定入口與兩個歷史寫入者的靜默失敗`）—— 同名取代的絆索、subagent 邊界、offload fail-open 的兩條、eviction 那個第二寫入者的兩條，全在 `summarization.test.ts` 裡。**這張因此不是一張 feat，是三件收尾**：

  1. **`permissions` 那個洞只有散文，沒有行為證據** —— 而它是最該有證據的那一種：一條寫對的規則看起來在保護一個它碰不到的東西。實測的四格對照：同一條 `deny(['/conversation_history*', '/conversation_history/**'])`，**經工具**（`write_file` 寫 `/conversation_history/x.md`）換來 `Error: permission denied for write`、磁碟零檔案；**經 backend 方法**（summarization 的 offload）`session_*.md` **照樣寫進去**。同一條規則、同一個路徑、兩個呼叫者、相反的結果。→ 這條測試補進去，並把 `permissions.test.ts` 檔頭那句「無規則命中即 allow」補上更大的那一半：**backend 方法根本不經過規則表**。

  2. **`read-only` ✕ 長對話的三選一，決定是「(c) 為預設 ＋ (b) 為逃生口」。** (a)「組裝期擋下這個組合」**在結構上不可行**：summarization 是被無條件加進 stack 的，所以「read-only ＋ summarization」就是**每一個** read-only 組裝，擋掉它等於禁用 read-only 這個 mode 本身 —— 連根本不會觸發摘要的短對話也一起禁掉。所以預設是 (c)：**`read-only` 就是不留歷史**，寫進 `ContainedFilesystemBackend` 的文件。

  3. **而 (b) 這條逃生口是真的存在的，實測過**：`createSummarizationMiddleware` 的 `backend` **是獨立的一格**，不必是 agent 的那個。預設 backend 用 `read-only`、摘要器指向另一個 `workspace-write` 的 backend，實測唯讀根一個檔案都沒多、歷史落在另一個根裡、四輪對話全部正常回話。→ 這是 `historyPathPrefix` 那條路之外更直接的一條，而且它連 `backend.mount()` 都不需要。**代價要寫清楚**：走這條就得自己建摘要器，也就等於接管 `trigger` / `keep` 的預設值。

- 驗收：**跨 thread 記憶保留**——注意這一條**不是 checkpointer 能滿足的**（它是 thread 內的狀態），要靠落磁碟的 backend，或把 `store` 包成 `StoreBackend` 當 backend 用。**`store` 參數本身對記憶是惰性的**：memory middleware 不碰 `store`，`StoreBackend.getStore()` 才從 LangGraph 的執行 context 把它取出來——所以那不是「兩個選項」，是「backend 這一軸的兩種選法」。長對話在 token 上限內完成多步任務，且 `/conversation_history` 真的寫得出來。
