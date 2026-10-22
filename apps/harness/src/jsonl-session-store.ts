/**
 * {@link @nexus/core!SessionStore} 的 JSONL 後端：一份會話一個檔，一行一顆事件。
 *
 * 形狀照 dsh 隨產品交付的 `session-persistence-jsonl`（`docs/subsystems/persistence.zh.md`，
 * 本地 clone SHA `d347e703908d0406b7a7ef80e3a0e594d86b2215`）：逐 session 的僅追加日誌、
 * **header 與日誌邏輯上分開**（dsh 明文：元資料在日誌之外，`stat`／`list` 讀 header 不掃正文）、
 * 實體化延後到第一次寫。**實體上 dsh 把 header 寫成日誌檔的第一行**（`format.ts` 的 `toHeaderLine`），
 * 我們是兩個獨立的檔（`<base>.header.json`、`<base>.jsonl`）：這是一條沒有合格偏離理由的差異，
 * 見下面「首次落盤」的登記與 [#1510](https://github.com/DemianLi/nexus-agent/issues/1510) 的拍板（Q1 (a)）。
 *
 * **選 JSONL 不選 SQLite 是一個有代價的選擇，代價登記在這裡。** dsh 兩個 provider 都出
 * （`-jsonl` 與 `-sqlite`），我們先做 JSONL，理由三條：不必現場編譯（SQLite 那條要
 * `better-sqlite3`，而我們的 `onlyBuiltDependencies` 只放了 `esbuild`）、人讀得懂、
 * 以及未來 Proteus 的 `read_trace` 解析的就是 jsonl。丟掉的是頻繁更新時的效率，而
 * 僅追加的日誌本來就沒有頻繁更新。**第一條原本寫的是「零原生相依」，寫租約之後不成立了**：
 * 租約吃一個原生模組，但它是預編譯的、沒有 install script（見 `session-lease.ts`），所以
 * 真正擋掉 SQLite 的那件事——要在裝的機器上編——這條路仍然沒有。
 *
 * ## 一條沒抄的、一條照抄的
 *
 * - **沒有 Zstandard 壓縮與 checksum。** dsh 預設存成帶 checksum 的連續 Zstandard frame
 *   （也可配置成原始行）。我們存原始行：撕裂尾部的偵測與部分解碼是**讀方**的機器，
 *   而今天的讀方讀的都是原始行：續接（{@link JsonlSessionStore.resume}，CLI 的 `--resume`
 *   與 serve 碰到以前寫過的 thread，[#251](https://github.com/DemianLi/nexus-agent/issues/251) 的門 A）、
 *   唯讀的列與冷讀（`list`／`open(id, 'read')`，serve 的會話列表與按內容搜尋，
 *   [#665](https://github.com/DemianLi/nexus-agent/issues/665)），與離線掃描（`eval/session-scan.ts`，
 *   [#268](https://github.com/DemianLi/nexus-agent/issues/268)，唯讀，共用 {@link parseJsonlSessionBody}）。
 *   加壓縮換到的是第二套解碼路徑，沒有人要。
 * - **寫租約照抄了**（`session-lease.ts`）：新開的在第一次實體化寫入之前拿，續接的在讀
 *   之前拿，把手關掉才放。一份會話一把，鎖檔跟日誌並排（`<base>.lock`）——理由在那個模組。
 *   撞名跟租約各擋一件事：**撞名在 `create` 當下就報**（[#1559](https://github.com/DemianLi/nexus-agent/issues/1559)，
 *   照 dsh `index.ts:360-379`）——同一個後端建過還沒實體化的（行程內的 pending），或磁碟上 header、日誌任一個已經在的，
 *   都同步拋 `SessionAlreadyExistsError`。實體化時的 `link` 與日誌的 `wx` 仍然在，**檔案已經在就拒絕**，不覆寫也不續寫：
 *   擋的是 `create` 之後才出現的競態，撞上的 `EEXIST` 一樣換成 `SessionAlreadyExistsError`（`cause` 留著原錯）。
 *
 *   **拿租約是惰性的，所以輸的可能是先起來的那個**：一個行程還沒寫第一筆（還沒拿），另一個
 *   就 `--resume` 了同一份，後者先拿到；前者第一次寫的時候才撞上，而那一下在協調器的背景
 *   路徑上，**被收成一行 warn 而不是一個錯**。dsh 也是惰性的，所以不算偏離；只是我們的
 *   協調器讓那個後果更安靜。`create` 之後才發生的撞名同樣是惰性的，後果一樣。
 *
 * ## 每批落盤、失敗截回（[#1506](https://github.com/DemianLi/nexus-agent/issues/1506)）
 *
 * 照 dsh 的 `appendLines`（`packages/session/session-persistence-jsonl/src/index.ts:1406-1449`，SHA `1517a4db`）：
 * 每一批 `append` 先記檔案現在的大小，**寫滿**整批（`writeFile`，不接受短寫）、`fsync`，成功才讓 `seq` 前進。
 * 寫或 `fsync` 任一步失敗，就把檔案截回寫前大小再 `fsync`，然後拋原錯；截回也失敗拋
 * `AggregateError([原錯, 截回錯])`。協調器保留整批、之後重送（`session-persistence.ts`），所以殘留的半批
 * 不截掉，重送的內容就接在它後面，變成中段壞行或重複的 `seq`。
 *
 * **和 dsh 唯一的形狀差異是把手的壽命**：dsh 每批開關一次，這裡成功路徑一個把手用到會話結束；失敗路徑
 * 照 dsh——先關掉這個把手、另用 `r+` 開檔截回，下一批用 `a` 重開（demian 2026-10-17 在 #1506 拍板 Q1 (a)）。
 * `append`／`flush`／`close` 排在同一條鏈上，一次只跑一個（dsh `storage.ts:187-195`），否則一邊關把手時另一邊還拿著它。
 *
 * ## 首次落盤是原子的（[#1510](https://github.com/DemianLi/nexus-agent/issues/1510)）
 *
 * 一份新會話第一次寫入時，斷電或行程被殺只會有兩種結果：整份都在，或整份都不在——不會留下空的或半份的 header，
 * 讓這條 thread 之後每次打開都回「建不起來」。照 dsh `materializePosix`（`index.ts:1282-1322`，SHA `1517a4db`）：
 *
 * - 逐層 `mkdir`，每建一層就 `fsync` 它的父目錄；**每次物化都 fsync，不看目錄本來在不在**（別的會話剛建、還沒
 *   fsync 完的目錄，看到它在就跳過的話會漏掉）。
 * - header 先寫成暫存檔（`<final>.<12 hex>.tmp`，`wx`、`0600`）、`fsync`，再用 **`link` 發佈，不用 `rename`**：
 *   目標已存在時 `link` 回 `EEXIST`，兩個行程同時物化同一個 id 不會互相覆蓋（`rename` 會靜靜蓋掉）；
 *   發佈後 `fsync` 會話目錄，新目錄項才算斷電後還在；暫存檔盡力刪掉，刪不掉不讓這次寫入失敗。
 * - **目錄 `fsync` 的錯往外拋，不吞**（dsh `syncDirPosix`）。`plugin-journal.ts` 那支不分平台吞掉所有錯，不能拿來用：
 *   一次 `EIO` 會悄悄關掉目錄 `fsync`。
 * - **header 的目錄項落盤之後才建日誌**（`wx`，再 `fsync` 一次目錄）。反過來的話，斷電可能留下「有日誌、沒 header」：
 *   列表看不到它，同一個 id 之後再建時 `create` 就拒（看的是 header 與日誌兩個檔，同 dsh 的 `findLog` 看日誌）。
 * - 發佈是**可重試、不撞上自己**的：`link` 一成功就記下 header 已發佈，之後的重試只補做目錄 `fsync`；
 *   日誌開成了但目錄 `fsync` 失敗，重試也沿用同一個把手，不再 `wx` 一次。跟租約的 `??=` 同一個理由。
 *
 * 偏離，登記（第 1 條是過渡，第 2 條是理由 1）：
 *
 * 1. **兩個檔，兩次各自原子的發佈**（**過渡**，不是合格偏離）。dsh 一個檔、一次 `link` 涵蓋 header 與首批事件；兩檔佈局下
 *    一次 `link` 涵蓋不了。這裡把 header 檔當成「這份會話存在」的提交點：先原子發佈 header，再建日誌。中間狀態「只有
 *    header、日誌不在或是空的」讀方今天就當成一份零事件的會話，不是新狀態。首批事件要不要立刻 `fsync` 歸 #1506（每批
 *    `fsync`）。**撤除條件**：#1594 ③（寫方切到世代檔，header 在日誌第一行）落地。
 * 2. **Windows：照樣 `link` 發佈，不做目錄 `fsync`**（理由 1，基座表達不出來）：Node 在 Windows 上開不了目錄，
 *    也沒有 dsh 用來呼叫 `MoveFileExW` 的 FFI。判斷依據是 `process.platform === 'win32'`，**不是吞錯**；
 *    比照 `session-lease.ts` 已登記的 Windows 偏離。
 * 3. 不清當機後殘留的 `*.tmp`，同 dsh。殘留檔不會被讀方撿到：讀方都經 {@link readSessionEntry} 認 header 檔名
 *    （`@nexus/core` 的 `parseSessionHeaderFilename`），`<base>.header.json.<hex>.tmp` 不認。
 *
 * ## 續接換版：header 原子取代、日誌本文穩定讀（[#1509](https://github.com/DemianLi/nexus-agent/issues/1509)）
 *
 * 續接以前會就地覆寫 header（`writeFile`，先截成 0 位元組再寫）：當機或斷電留下空的或半份的 header，這條 thread
 * 從此接不回來、側欄也找不到；唯讀的讀方（`list`、`open(id, 'read')`、serve 的存在檢查、背景子代理冷讀）不拿租約，
 * 同時進來就讀到半份。dsh 的 header 不可變、從不就地覆寫（`session-persistence-jsonl/src/index.ts:615-629`，SHA `1517a4db`）。
 *
 * - **同版本不寫 header。** 讀到的 header 版本已經是這一版就整步跳過，只截尾、開日誌（與 dsh「同版本續接不碰 header」一致）。
 * - **版本較舊才換，換法是原子取代**：暫存檔（`<檔名>.<12 hex>.tmp`，`wx`、`0600`）寫滿、`fsync`，`rename` 蓋過 header，
 *   再 `fsync` 會話目錄。讀方不用鎖，只會看到舊的或新的完整一份（dsh `writeFileAtomic` 的做法，
 *   `packages/util/atomic-write/src/index.ts:64-95`）。任何一步失敗：暫存檔刪掉、header 原樣、錯照拋。
 *   換版落定（含目錄 `fsync`）之後才截日誌尾、開日誌續寫。
 * - **和 `link` 發佈（#1510）刻意是兩支**：`link` 的目標不該存在、撞上就是錯；`rename` 的目標本來就在。
 * - **日誌本文走穩定快照讀**（{@link readStableSnapshot}，照 dsh `readStableSnapshot`，
 *   `generation.ts:262-282`）：讀前讀後各 `stat`，身分不變才算數，變了重讀一次，第二次還在變就回傳第二次讀到的位元組
 *   截到讀前大小的前綴，不被持續寫入的寫者餓死。日誌不是嚴格只追加（續接先 `truncate` 掉撕裂尾巴再續寫），分段讀的大檔
 *   可能拼出一行垃圾，而 #1508 之後那行會被當成壞尾丟掉、續接還會照錯的位置截檔。
 *
 * 偏離，登記：
 *
 * 1. **header 換版用「暫存＋fsync＋rename 取代 header 檔」，不換成 dsh 的世代檔**（**過渡**，不是合格偏離）：
 *    nexus 的落盤格式把 header 獨立成 `<base>.header.json`、檔名不帶版本，所有既存會話、離線掃描與日誌匯出共用。
 *    要照世代檔得先整個遷格式（#1509 Q1 (a)，後來成為 #1594）。今天退到 dsh 自己取代既有檔用的 `writeFileAtomic`，
 *    補上它 TODO 裡寫的檔案 `fsync` 與目錄 `fsync`。**撤除條件**：#1594 ③（寫方切到世代檔）落地。
 *
 * 照 dsh、不算偏離的：Windows 的 `rename` 暫時性錯誤（`EACCES`／`EBUSY`／`EPERM`）有界重試，常數同 `atomic-write:19-44`
 * （20 ms 起、上限 200 ms、8 次）。Windows 不做目錄 `fsync`，沿用 #1510 登記的偏離 2（理由 1）。
 *
 * ## 目錄：CLI 每次一個，serve 按專案固定一格
 *
 * dsh 的 `SessionId` 全域唯一；我們的 CLI root 固定叫 `cli`，放在固定的地方會每次都撞。
 * 所以 CLI 用 {@link createJsonlSessionStore} 每次開一個 **run 目錄**——沒有這一層，`wx`
 * 會讓第二次啟動變成一個硬錯誤。serve 的 root 是 thread id，本來就全域唯一，所以它照 dsh
 * 用 {@link openJsonlSessionStore} 落在 `<根>/<projectKey(cwd)>` 那一格，重開之後找得回同一條
 * thread。
 *
 * ## 檔名與 header 的規則：檔名在 `@nexus/core`，讀法在這裡
 *
 * 一份會話三個檔並排：`<base>.header.json`、`<base>.jsonl`、`<base>.lock`（`base` 見 {@link safeBaseName}）。檔名只在
 * `@nexus/core` 的 `session-filename.ts` 定義，同 dsh 的檔名只有一份定義（`packages/session/session-format/src/filename.ts:14`，
 * 跟版本目錄同一個格式層）。讀一份會話的接縫是 {@link readSessionEntry}（[#1857](https://github.com/DemianLi/nexus-agent/issues/1857)）：
 * 列表、唯讀打開、續接、離線掃描（[#665](https://github.com/DemianLi/nexus-agent/issues/665)）與 `log-derived-history.fixture.ts`
 * 都經過它。不經過它、只用到檔名的：
 *
 * - 知道 id、要直接碰檔的煙霧測試、`checkpoint-depth-cold.fixture.ts` 與量測（`measure/thread-list-cli.ts`，寫方）用
 *   {@link sessionPathsIn}；
 * - 發版驗證（`scripts/release/verify-packed-install.ts`）只 import `@nexus/core` 的檔名葉模組：發版腳本不拉整支 store 進來；
 * - 夾具產生器（`scripts/session-format-fixtures/run-directory.ts`）要凍原樣位元組與寫入器記的版號，接縫會把 header 的
 *   `version` 轉譯成這一版（#1856），不是它要的。
 *
 * 別的地方寫這兩個副檔名或 import {@link parseHeader}，`session-files-single-owner.test.ts` 會紅。
 *
 * @see [#172](https://github.com/DemianLi/nexus-agent/issues/172)
 * @module
 */

import { link, mkdir, open, readdir, readFile, rename, rm, stat, truncate } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  classifyStoredFormatVersion,
  isUnreadableSessionEvent,
  materializeAppendBatch,
  parseSessionHeaderFilename,
  SESSION_FORMAT_CATALOG,
  SESSION_LOG_FORMAT_VERSION,
  SessionAlreadyExistsError,
  SessionCorruptionError,
  SessionEventUnsupportedError,
  SessionFormatUnsupportedError,
  SessionHandleClosedError,
  SessionNotFoundError,
  sessionFilenames,
  snapshotJsonValue,
} from '@nexus/core';
import type {
  ReadonlyStoredSession,
  ResumedStoredSession,
  SessionEvent,
  SessionFilenames,
  SessionFormatCatalog,
  SessionLocation,
  SessionStore,
  StoredSession,
  StoredSessionHeader,
  StoredSessionListing,
  StoredSessionListOptions,
  StoredSessionReadOptions,
  StoredSessionSnapshot,
} from '@nexus/core';
import { acquireSessionLease } from './session-lease.js';
import type { LeaseUnavailable, SessionWriteLease, TryLock } from './session-lease.js';
import {
  assertStoredEventData,
  assertStoredHeaderFields,
  assertStoredRelationships,
} from './session-log-validation.js';

/**
 * 目錄與檔案的權限。
 *
 * **會話日誌裡有使用者打的每一句話**，所以是 `0700`／`0600`，同 dsh 的 spill store
 * （`dsh-spill-local` 的根目錄 `0700`、檔案 `0600`）。
 */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * 檔名基底的長度上限。超過就截短並綴上摘要（見 {@link safeBaseName}）。
 *
 * 多數檔案系統的單段上限是 255 **位元組**，而中文一個字三個位元組，所以用字元數當
 * 上限得留餘裕：120 個字元最壞情況是 360 位元組，加上 `.header.json` 還是進得去
 * 255 的只有截短後那條路——所以截短的門檻設在遠低於上限的地方，不是貼著它。
 */
const MAX_BASE_LENGTH = 120;
/** 截短後保留的前綴長度；其餘讓位給摘要。 */
const TRUNCATED_PREFIX_LENGTH = 96;
/** 摘要取幾個十六進位字元。48 bit，撞得到要靠刻意構造。 */
const DIGEST_LENGTH = 12;

/**
 * 把 session id 變成一個安全的檔名基底，**而且是單射的**。
 *
 * subagent 的 id 是 `<root>/<runId>`，帶斜線，直接拿去當檔名會變成子目錄。
 *
 * ## 為什麼要單射：`serve` 的 session id 是呼叫端給的
 *
 * CLI 的 root 固定叫 `cli`，subagent 是 `cli/<runId>`——那組 id 是我們自己造的，怎麼
 * 壓平都不會撞。**`serve` 不是**：`ThreadPump` 用 `new SessionRegistry(threadId)`
 * 開 root（`thread-pump.ts:129`），而 `threadId` 直接來自 `/threads/:id/...` 的路徑。
 * 把不合法字元一律換成 `_` 的話，`a~b`、`a!b`、`a_b` 三條不同的 thread 會壓成同一個
 * 檔名——第二條的第一次寫入撞上 `wx` 而失敗，協調器按設計吞掉它（暫停自動路徑、
 * 一行 warn），於是**那條 thread 的日誌就這麼沒了**。`wx` 那條拒絕是留給「`create`
 * 撞上一份已存的會話」的絆索——續接走的是 `resume`，不走 `create`——不是拿來擋這個的。
 *
 * ## 三條規則，各擋一種撞法
 *
 * 1. **百分號編碼，不壓平。** 不在 `[A-Za-z0-9._-]` 裡的位元組寫成 `%<小寫 hex>`，
 *    而 `%` 自己也被編碼（`%25`），所以解得回去，也就撞不到。`cli`、`cli%2frun-1`
 *    這種常見形狀仍然一眼看得懂。
 * 2. **大寫字母另外收。** macOS 與 Windows 的檔案系統預設**不分大小寫**，所以
 *    `Alpha` 與 `alpha` 在編碼之後仍然是同一個檔。把大寫字母也編碼會讓每一個
 *    駝峰 id 變得不能讀，所以改成：**含大寫就綴上摘要**。編碼用的 hex 刻意是小寫的，
 *    這樣這條規則只會被 id 自己的大寫觸發，不會被編碼觸發。
 * 3. **超過 {@link MAX_BASE_LENGTH} 就截短並綴上摘要。** 截短之後的單射性靠那段
 *    摘要，不靠前綴。
 *
 * 摘要是**完整 `sessionId`** 的 SHA-256 前 {@link DIGEST_LENGTH} 個十六進位字元。
 * **那個輸入不能改成 `encoded`**：規則 3 先判、走的是提早回傳，所以又長又含大寫的 id
 * 只拿得到截短那一顆摘要——它之所以同時擋得住大小寫，正是因為摘要算在原始 id 上。
 * 換成算在 `encoded` 上的話，大小寫的撞名會只在長 id 上回來，而那條路沒有測試蓋到。
 *
 * @param sessionId - 會話 id。
 * @returns 檔名基底；不同的 id 給出不同的基底，**而且在不分大小寫的檔案系統上也是**。
 */
function safeBaseName(sessionId: string): string {
  if (sessionId.length === 0) return 'session';
  const digest = (): string =>
    createHash('sha256').update(sessionId).digest('hex').slice(0, DIGEST_LENGTH);
  const encoded = [...Buffer.from(sessionId, 'utf8')]
    .map((byte) => {
      const char = String.fromCharCode(byte);
      return /[A-Za-z0-9._-]/.test(char) ? char : `%${byte.toString(16).padStart(2, '0')}`;
    })
    .join('');
  if (encoded.length > MAX_BASE_LENGTH) {
    return `${encoded.slice(0, TRUNCATED_PREFIX_LENGTH)}-${digest()}`;
  }
  // 編碼產生的 hex 是小寫的，所以這裡認出來的大寫一定來自 id 本身。
  return encoded === encoded.toLowerCase() ? encoded : `${encoded}-${digest()}`;
}

/**
 * 續接一份已存會話時，把手要知道的兩件事。
 *
 * `torn` 只在日誌尾端有讀方不算的東西時才有：最後一行寫到一半（當掉的常態），或讀不懂的完整行加上它之後
 * 沒收尾的行（可復原的壞尾，#1508）。而把手第一次寫入之前要把它截掉——不截的話，續寫的第一行會黏在那半行後面，
 * 兩行一起變成壞行。截完 sync、講一行（thread id、截到哪、丟了幾個位元組）；截掉的位元組不另存，同 dsh。
 *
 * **截是跟著第一次寫入走的，不是跟著續接走的。** 續接幾乎都會寫：seed 結尾補的那顆
 * `session/end-seed` 就是一筆待寫。唯一不寫的是 seed 本來就停在 end-seed（上一次續接之後
 * 什麼都沒做）而這一次也什麼都沒做——那半行就留在檔上。無害：下一次讀方照樣不算它、
 * 照樣截。
 */
interface ResumePoint {
  readonly nextSeq: number;
  /** 日誌尾端有東西要丟（撕裂的半行、可復原的壞行與它之後的行）；第一次寫入之前截到 `truncateTo`。 */
  readonly torn?: { readonly truncateTo: number; readonly droppedBytes: number };
  /** 磁碟上 header 的版本比這一版舊：第一次寫入之前要原子取代它（#1509）。同版本就是 `undefined`，不碰 header。 */
  readonly headerStale?: true;
  /** 讀之前就拿到的租約；這個平台拿不到就是 `undefined`。 */
  readonly lease: SessionWriteLease | undefined;
}

/**
 * 日誌檔的把手上，這個後端會用到的那幾個動作。測試包住它來製造寫入失敗（見 {@link OpenLogFile}）。
 */
export type LogFileHandle = Pick<
  FileHandle,
  'stat' | 'writeFile' | 'sync' | 'datasync' | 'truncate' | 'close'
>;

/**
 * 開日誌檔。`wx` 是新會話的第一次實體化、`a` 是續接與失敗後的重開、`r+` 是失敗後的截回。
 * **只給測試換**：真的磁碟上量不到「寫了一半就拋」「sync 拋錯」這幾條路（前例是 `lock`）。
 */
export type OpenLogFile = (
  path: string,
  flags: 'wx' | 'a' | 'r+',
  mode: number,
) => Promise<LogFileHandle>;

/**
 * 一個後端裡每一份會話共用的：拿鎖的那一下、「這個平台拿不到鎖」那張嘴，與開日誌檔的那一下。
 *
 * **那張嘴一個後端只開一次**——不然每個 subagent 出生都重講一遍。
 */
interface LeaseContext {
  readonly lock: TryLock | undefined;
  readonly unavailable: (outcome: LeaseUnavailable) => void;
  readonly openLog: OpenLogFile;
  /** 後端的 `options.warn`（沒給就是 `console.warn` 加前綴）：截掉尾巴時講一行。 */
  readonly warn: (message: string) => void;
  /** 讀 header 時問的版本邊目錄（見 {@link ParseHeaderOptions.catalog}）。 */
  readonly catalog: SessionFormatCatalog;
  /** 讀 header、日誌本文與取 revision 用的檔案系統（見 {@link JsonlSessionStoreOptions.fs}）。 */
  readonly fs: StableReadFileSystem;
  /**
   * 這個後端 `create` 過、還沒實體化的 id，照 dsh 的 `JsonlBackendTracker.pending`（`storage.ts:391` 起）：只在記憶體裡，
   * 實體化成功或還沒實體化就關掉時移掉（dsh `:473`、`:499`）。
   */
  readonly pending: Set<string>;
  /** 冷讀解析快取（{@link ColdLogMemo}）。 */
  readonly coldLogs: ColdLogMemo;
  /**
   * 這個後端**所有同時在跑的列舉共用**的並行上限，照 dsh 的 `listLimit`（`index.ts:297-302`、`:328`）：
   * 兩個 `list()` 同時跑，加起來也最多 `listConcurrency` 份在讀。
   */
  readonly listLimit: ListLimit;
}

/**
 * 冷讀解析快取的一筆：一份日誌在某個 revision 上解析出來的東西。續接要的不只事件，還有 header（決定要不要換版）、
 * `validBytes` 與本文長度（決定要不要截撕裂的尾巴、截到哪）。
 */
interface ColdLog {
  readonly headerRevision: string;
  readonly logRevision: string;
  readonly header: StoredSessionHeader;
  readonly storedFormatVersion: number;
  /** 深凍結過、讀方共用的那一份（照 dsh `freezeStoredEvents`，`index.ts:153-180`）。 */
  readonly events: readonly SessionEvent[];
  readonly validBytes: number;
  readonly bodyBytes: number;
}

/** 冷讀解析快取最多留幾份，同 dsh 的 `COLD_LOG_MEMO_MAX_ENTRIES`（`index.ts:67`）。 */
const COLD_LOG_MEMO_MAX_ENTRIES = 2;

/**
 * **冷讀解析快取**（[#1559](https://github.com/DemianLi/nexus-agent/issues/1559) N0625），照 dsh 的 `coldLogMemo`
 * （`session-persistence-jsonl/src/index.ts:312`、`:615-649`、`:752`、`:799-810`、`:868-880`，`687f282e`）。
 *
 * 冷復活先唯讀打開檢查一次（`background-cold.ts` 的 inspect），緊接著續接又讀一次：同一份日誌整份解析兩次。
 * 這裡記住最近兩份的解析結果，**鍵是 id，守衛是 header 與日誌兩個檔的 revision**（{@link fileRevision}，#1509 穩定讀的
 * 那組身分）：任一個對不上就當沒有、照常讀。別的行程寫進去，revision 就變了；本後端自己寫的，寫之前先刪掉那一筆
 * （同 dsh `:752`）。只存預設讀法（`recoverable`）的結果，`salvage` 撿回來的不存——續接不走撿回，存了會讓一份該拒的
 * 檔靜靜續接成功（同 dsh `:860-868` 只存驗過的）。
 *
 * 不是持久投影快取（#725 的決定照舊）：行程內、最多兩份。常駐記憶體因此最多多出兩份日誌的大小（#1490 量測時要算進去）。
 */
class ColdLogMemo {
  readonly #entries = new Map<string, ColdLog>();

  /**
   * @returns 兩個 revision 都對得上的那一筆（並把它移到最新）；對不上的順手刪掉。
   */
  get(id: string, headerRevision: string, logRevision: string): ColdLog | undefined {
    const memoized = this.#entries.get(id);
    if (memoized === undefined) return undefined;
    this.#entries.delete(id);
    if (memoized.headerRevision !== headerRevision || memoized.logRevision !== logRevision) {
      return undefined;
    }
    this.#entries.set(id, memoized);
    return memoized;
  }

  /** 存一筆；超過上限就淘汰最舊的（Map 的插入序）。 */
  set(id: string, entry: ColdLog): void {
    this.#entries.delete(id);
    this.#entries.set(id, entry);
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= COLD_LOG_MEMO_MAX_ENTRIES) break;
      this.#entries.delete(oldest);
    }
  }

  /** 本後端要寫這一份了：先刪掉。 */
  delete(id: string): void {
    this.#entries.delete(id);
  }
}

/** 深凍結一批解析出來的事件，照 dsh `freezeStoredEvent`（`index.ts:153-173`）：迭代、不遞迴（深物件不撞堆疊）。 */
function freezeStoredEvents(events: SessionEvent[]): readonly SessionEvent[] {
  const pending: object[] = [...events];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    Object.freeze(current);
    for (const child of Object.values(current)) {
      if (child !== null && typeof child === 'object') pending.push(child as object);
    }
  }
  return Object.freeze(events);
}

/** 拿租約；拿不到的平台講一聲、回 `undefined`。搶不到與其餘的錯照常拋。 */
async function leaseFor(
  context: LeaseContext,
  path: string,
  id: string,
): Promise<SessionWriteLease | undefined> {
  const outcome = await acquireSessionLease(path, id, context.lock);
  if ('unavailable' in outcome) {
    context.unavailable(outcome);
    return undefined;
  }
  return outcome;
}

/** 新會話第一次物化的進度（見 {@link JsonlStoredSession} 的 `#publish`）。 */
interface PublishProgress {
  /** 要發佈的 header 暫存檔。 */
  tempHeader?: string;
  /** `link` 成功了：正式路徑上的 header 是完整的那份。 */
  headerPublished?: true;
  /** header 發佈之後的目錄 `fsync` 做完了。 */
  headerSynced?: true;
  /** 開成了、但還沒確認目錄項落盤的日誌把手。 */
  log?: LogFileHandle;
}

/**
 * 暫存檔：`open(wx)` → 寫滿 → `fsync` → 關。失敗就刪暫存檔再拋。照 dsh `writeSyncedTempFile`（`index.ts:1359-1369`）。
 *
 * @returns 暫存檔的路徑。
 */
async function writeSyncedTemp(finalPath: string, content: string): Promise<string> {
  const temp = `${finalPath}.${randomBytes(6).toString('hex')}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temp, 'wx', FILE_MODE);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    const done = handle;
    handle = undefined;
    await done.close();
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  return temp;
}

/**
 * `fsync` 一個目錄，讓裡面新的目錄項斷電後還在（`datasync` 只保證檔案內容）。照 dsh `syncDirPosix`
 * （`index.ts:1394-1403`）：**錯往外拋，不吞。** Windows 開不了目錄，直接回（見檔頭的登記）。
 */
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const WINDOWS_TRANSIENT_RENAME_ERRORS: ReadonlySet<string> = new Set(['EACCES', 'EBUSY', 'EPERM']);
const WINDOWS_RENAME_RETRY_INITIAL_MS = 20;
const WINDOWS_RENAME_RETRY_MAX_MS = 200;
const WINDOWS_RENAME_RETRY_LIMIT = 8;

/** `rename` 蓋過既有檔，Windows 上暫時性的 `EACCES`／`EBUSY`／`EPERM` 有界重試，常數同 dsh `atomic-write`（`:19-44`）。 */
async function renameOverExisting(temp: string, finalPath: string): Promise<void> {
  let delay = WINDOWS_RENAME_RETRY_INITIAL_MS;
  for (let retries = 0; ; retries += 1) {
    try {
      await rename(temp, finalPath);
      return;
    } catch (error: unknown) {
      const code = (error as { code?: unknown } | null)?.code;
      const transient =
        process.platform === 'win32' &&
        typeof code === 'string' &&
        WINDOWS_TRANSIENT_RENAME_ERRORS.has(code);
      if (!transient || retries >= WINDOWS_RENAME_RETRY_LIMIT) throw error;
    }
    await wait(delay);
    delay = Math.min(delay * 2, WINDOWS_RENAME_RETRY_MAX_MS);
  }
}

/**
 * 原子取代一個已存在的檔：暫存檔寫滿＋`fsync`（{@link writeSyncedTemp}）、`rename` 蓋過去。失敗刪暫存檔、目標原樣、錯照拋。
 * **目錄 `fsync` 由呼叫端做**（取代落定之後）。和 `link` 發佈不是同一支：`link` 的目標不該存在。
 */
async function replaceSyncedFile(finalPath: string, content: string): Promise<void> {
  const temp = await writeSyncedTemp(finalPath, content);
  try {
    await renameOverExisting(temp, finalPath);
  } catch (error: unknown) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 一份已存會話。IO 延後到第一次 {@link append} 或 {@link flush}。 */
class JsonlStoredSession implements StoredSession {
  readonly #directory: string;
  readonly #base: string;
  readonly #header: StoredSessionHeader;
  readonly #resume: ResumePoint | undefined;
  readonly #context: LeaseContext;
  #lease: SessionWriteLease | undefined;
  #handle: LogFileHandle | undefined;
  /**
   * 實體化成功過。之後 `#handle` 是 `undefined` 就只有一種意思：追加失敗、把手連同截回一起收掉了，
   * 下一次要用 `a` 重開（{@link #materialize}），不是從頭實體化。
   */
  #opened = false;
  /** `append`／`flush`／`close` 的串行鏈：一次只跑一個，前一個失敗不擋後一個。 */
  #tail: Promise<void> = Promise.resolve();
  #closing: Promise<void> | undefined;
  /**
   * 進行中的那次實體化。`#materialize` 裡有好幾個 await，同時進來兩次的話第二次會拿不到
   * **自己的**租約，拋出一句「另一個行程還開著它」——同一個行程、同一份會話，那句話會讓人去找
   * 一個不存在的行程。協調器的背景寫入與 `flush` 排在不同的隊伍上，所以這不是理論上的。
   */
  #materializing: Promise<LogFileHandle> | undefined;
  /** 已存的 next-seq。下一批的第一顆必須等於它。 */
  #nextSeq: number;
  /**
   * 新會話第一次物化走到哪一步（{@link #open}）。每一步成功就記下來，失敗後的重試只補沒做完的——
   * `link` 成功但目錄 `fsync` 拋錯時，重試再 `link` 一次會撞上自己的 header（`EEXIST`），這個行程從此寫不進這份會話。
   */
  #publish: PublishProgress = {};

  /**
   * @param directory - run 目錄。
   * @param header - 要寫的 header。續接時是**已經翻成這一版**的那份。
   * @param context - 這個後端的租約設定。
   * @param resume - 續接一份已存的會話；省略即開一份新的。
   */
  constructor(
    directory: string,
    header: StoredSessionHeader,
    context: LeaseContext,
    resume?: ResumePoint,
  ) {
    this.#directory = directory;
    this.#base = safeBaseName(header.id);
    this.#header = header;
    this.#context = context;
    this.#resume = resume;
    this.#lease = resume?.lease;
    this.#nextSeq = resume?.nextSeq ?? 0;
  }

  async append(events: readonly SessionEvent[]): Promise<void> {
    this.#assertOpen();
    if (events.length === 0) return;
    // 排隊之前先驗過並拷成沒凍過的副本，照 dsh `session-persistence-jsonl/src/storage.ts:191`：日誌交來的事件是凍過的，
    // 凍過的深陣列 `JSON.stringify` 會撞 `RangeError`，這一批就永遠寫不出去（#1526）。持久化層的重試也走這裡，
    // 等同 dsh `:308` 那一處。
    const batch = materializeAppendBatch(events);
    return this.#enqueue(async () => {
      for (const [index, event] of batch.entries()) {
        const expected = this.#nextSeq + index;
        if (event.seq !== expected) {
          throw new Error(
            `會話 "${this.#header.id}" 的這一批不連續：第 ${index} 顆的 seq 是 ${event.seq}，` +
              `應該是 ${expected}。寫過的事件不重寫，缺號也不補。`,
          );
        }
      }
      await this.#persist(batch.map((event) => `${JSON.stringify(event)}\n`).join(''));
      this.#nextSeq += batch.length;
    });
  }

  async flush(): Promise<void> {
    this.#assertOpen();
    return this.#enqueue(async () => {
      // 實體化過的會話，每一批 `append` resolve 時都已經 fsync 過（失敗那批也已截回並 fsync），
      // 這裡不再多一次——照 dsh `storage.ts:207`（「appends are durable on resolution」）。
      if (this.#opened) return;
      // 一份還沒寫過任何事件的會話，在這裡才真的變成磁碟上看得到的東西——dsh 同條
      // （「一个空的已创建会话在此变得可持久列出」）。
      const handle = await this.#materialize();
      await handle.datasync();
    });
  }

  close(): Promise<void> {
    // 已經排在前面的 append／flush 先跑完，再收尾；第二次呼叫拿到同一個結果。
    return (this.#closing ??= this.#enqueue(() => this.#shutdown()));
  }

  /**
   * 收尾：落盤、關檔、放租約，**三步各自接住，全收完才報**——只有一個錯就拋那一個，兩個以上才是
   * `AggregateError`，照 dsh `storage.ts:246-258`。以前關檔的錯會蓋掉落盤的錯，「哪些位元組沒落盤」就看不見了。
   */
  async #shutdown(): Promise<void> {
    // 還沒實體化就關掉：這個 id 在這個後端上不再算建過（dsh `storage.ts:499`），同一個 id 可以再 `create`。
    if (!this.#opened && this.#resume === undefined) this.#context.pending.delete(this.#header.id);
    const failures: unknown[] = [];
    // 第一次物化開成了日誌、但目錄 fsync 失敗又沒等到重試就關：把手還在 `#publish.log`，也要關。
    const handle = this.#handle ?? this.#publish.log;
    this.#handle = undefined;
    delete this.#publish.log;
    if (handle !== undefined) {
      try {
        await handle.datasync();
      } catch (error: unknown) {
        failures.push(error);
      }
      try {
        await handle.close();
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    // **不論開沒開過日誌都放**：續接那條路在讀之前就拿了租約，一筆都沒寫就關也要放掉，
    // 不然同一個行程裡下一次接同一份會撞上自己。
    const lease = this.#lease;
    this.#lease = undefined;
    try {
      await lease?.release();
    } catch (error: unknown) {
      failures.push(error);
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `會話 "${this.#header.id}" 收尾有 ${failures.length} 步失敗`,
      );
    }
    if (failures.length === 1) throw failures[0];
  }

  #assertOpen(): void {
    if (this.#closing !== undefined) throw new SessionHandleClosedError(this.#header.id);
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(task);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * 追加一批並 fsync；失敗就截回寫前大小（見檔頭「每批落盤、失敗截回」）。
   *
   * **寫前大小取檔案現在的大小，不在記憶體裡累計**：續接截尾（{@link #materializeResumed}）會讓記憶體裡的數字對不上檔案。
   */
  async #persist(content: string): Promise<void> {
    // 本後端要寫這一份了：冷讀快取那一筆先刪（同 dsh `index.ts:752`）。
    this.#context.coldLogs.delete(this.#header.id);
    const handle = await this.#materialize();
    const { size: before } = await handle.stat();
    try {
      await handle.writeFile(content);
      await handle.sync();
    } catch (error: unknown) {
      this.#handle = undefined;
      try {
        await handle.close();
        await this.#rollback(before);
      } catch (rollbackError: unknown) {
        throw new AggregateError(
          [error, rollbackError],
          `會話 "${this.#header.id}" 的追加失敗，截回 ${this.#logPath()} 也失敗了：殘留的半批還在檔案裡`,
        );
      }
      throw error;
    }
  }

  /** 另開 `r+` 把日誌截回 `size` 並 fsync，同 dsh `rollbackAppend`（`index.ts:1441-1449`）。 */
  async #rollback(size: number): Promise<void> {
    const handle = await this.#context.openLog(this.#logPath(), 'r+', FILE_MODE);
    try {
      await handle.truncate(size);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  #logPath(): string {
    return join(this.#directory, sessionFilenames(this.#base).log);
  }

  /**
   * 第一次真的要寫時才建目錄、寫 header、開檔。之後直接回同一個 handle；追加失敗收掉把手之後，用 `a` 重開。
   *
   * 呼叫端已經串行，所以不會同時進來兩次；失敗了就清掉，下一次重來——協調器靠的正是「失敗保留、下次再送」。
   */
  #materialize(): Promise<LogFileHandle> {
    if (this.#handle !== undefined) return Promise.resolve(this.#handle);
    if (this.#opened) {
      return this.#context.openLog(this.#logPath(), 'a', FILE_MODE).then((handle) => {
        this.#handle = handle;
        return handle;
      });
    }
    this.#materializing ??= this.#open().then(
      (handle) => {
        this.#opened = true;
        if (this.#resume === undefined) this.#context.pending.delete(this.#header.id);
        return handle;
      },
      (error: unknown) => {
        this.#materializing = undefined;
        throw error;
      },
    );
    return this.#materializing;
  }

  async #open(): Promise<LogFileHandle> {
    if (this.#resume !== undefined) return this.#materializeResumed(this.#resume);
    const directory = this.#directory;
    // 逐層建、每層都 fsync 父目錄（每次都做，不看它本來在不在）。少了 dsh 每份會話一個目錄那一層（我們沒有）。
    await mkdir(dirname(directory), { recursive: true, mode: DIR_MODE });
    await syncDirectory(dirname(dirname(directory)));
    await mkdir(directory, { recursive: true, mode: DIR_MODE });
    await syncDirectory(dirname(directory));
    // **租約在第一筆實體化寫入之前拿**，照 dsh：一份還沒實體化的會話在檔案系統上沒有足跡。
    // 上一次實體化拿到租約之後才失敗的話，重試不再拿一次——那會撞上自己。
    this.#lease ??= await leaseFor(
      this.#context,
      join(directory, sessionFilenames(this.#base).lock),
      this.#header.id,
    );
    const progress = this.#publish;
    // header 先發佈：日誌有內容而 header 不見，比反過來難解釋得多。暫存檔加 `link`：正式路徑上只會有不存在或完整的那份；
    // 已經在就 `EEXIST`（撞名絆索，不覆寫也不續寫）。
    if (progress.headerPublished === undefined) {
      const headerPath = join(directory, sessionFilenames(this.#base).header);
      const temp = await writeSyncedTemp(headerPath, `${JSON.stringify(this.#header, null, 2)}\n`);
      try {
        await link(temp, headerPath);
      } catch (error: unknown) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw this.#collision(error);
      }
      // **`link` 一成功的下一行就記**，不等目錄 fsync：目錄 fsync 拋錯之後重試再 `link`，會撞上自己的 header。
      progress.headerPublished = true;
      progress.tempHeader = temp;
    }
    if (progress.headerSynced === undefined) {
      await syncDirectory(directory);
      progress.headerSynced = true;
    }
    // 暫存檔盡力刪：刪不掉不讓這次寫入失敗（殘留檔讀方不認）。
    if (progress.tempHeader !== undefined) {
      await rm(progress.tempHeader, { force: true }).catch(() => undefined);
      delete progress.tempHeader;
    }
    // header 的目錄項落盤之後才建日誌。`wx`：檔案已經在就拒絕，不覆寫、也不續寫。
    try {
      progress.log ??= await this.#context.openLog(this.#logPath(), 'wx', FILE_MODE);
    } catch (error: unknown) {
      throw this.#collision(error);
    }
    await syncDirectory(directory);
    const handle = progress.log;
    delete progress.log;
    this.#handle = handle;
    return handle;
  }

  /** 實體化撞上 `EEXIST`：`create` 之後才出現的同名（競態），換成型別化的錯，原錯留在 `cause`。其餘原樣。 */
  #collision(error: unknown): unknown {
    if ((error as { code?: unknown } | null)?.code !== 'EEXIST') return error;
    return new SessionAlreadyExistsError(this.#header.id, { cause: error });
  }

  /**
   * 續接那條：header 版本較舊才**原子取代**（#1509），日誌續寫（`a`，不是 `wx`）。
   *
   * 取代是因為續寫進去的是這一版的詞彙（`session-store.ts` 的版本 3 那一段）；其餘欄位原樣——`createdAt` 是這份會話
   * 出生的時間，不是這一次打開的時間。**同版本不寫**：就地覆寫同樣的位元組也會先截成 0 位元組。
   * header 落定（含目錄 `fsync`）之後才截日誌尾、開日誌。重試（`rename` 成功但目錄 `fsync` 失敗）會再取代一次，
   * 內容相同，不像 `link` 會撞上自己。
   */
  async #materializeResumed(resume: ResumePoint): Promise<LogFileHandle> {
    this.#context.coldLogs.delete(this.#header.id);
    if (resume.headerStale === true) {
      await replaceSyncedFile(
        join(this.#directory, sessionFilenames(this.#base).header),
        `${JSON.stringify(this.#header, null, 2)}\n`,
      );
      await syncDirectory(this.#directory);
    }
    const logPath = this.#logPath();
    if (resume.torn !== undefined) await this.#truncateTornTail(logPath, resume.torn);
    this.#handle = await this.#context.openLog(logPath, 'a', FILE_MODE);
    return this.#handle;
  }

  /**
   * 截掉尾巴：先 `truncate`，再開 `r+` 做 `sync`，最後講一行（照 dsh `truncateTornTail`／`repair`，
   * `session-persistence-jsonl/src/index.ts:1452-1460`、`:942-946`）。**不 sync 的話**，斷電後截斷可能沒落盤，
   * 續寫的新行接在舊尾巴後面。**截掉的位元組不另存**（Q2 (a)，同 dsh）：磁碟上就沒了，warn 是唯一的紀錄。
   */
  async #truncateTornTail(
    logPath: string,
    torn: { readonly truncateTo: number; readonly droppedBytes: number },
  ): Promise<void> {
    await truncate(logPath, torn.truncateTo);
    const handle = await this.#context.openLog(logPath, 'r+', FILE_MODE);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.#context.warn(
      `會話 "${this.#header.id}" 的日誌尾端有 ${torn.droppedBytes} 個位元組不屬於任何完整的事件` +
        `（撕裂的半行，或讀不懂的行與它之後沒收尾的行），已截到第 ${torn.truncateTo} 個位元組、這些位元組已丟棄。`,
    );
  }
}

/** `readFile` 撞到的是「沒有這個檔」。 */
function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** {@link parseHeader} 的選項。 */
export interface ParseHeaderOptions {
  /** 呼叫方知道是哪一份時給（續接、唯讀打開）：header 記的 id 要一樣。列的時候不知道，不給。 */
  readonly id?: string;
  /** 版本比這一版新照讀、不拋。**只給產品路徑外的離線掃描**（`eval/session-scan.ts` 的「照格式版本表態」）。 */
  readonly acceptNewer?: boolean;
  /**
   * 問「這個版本讀不讀得了」的版本邊目錄（`@nexus/core` 的 `session-format.ts`，#1529）。省略即出貨那一份。
   * **只給測試換**（同 {@link JsonlSessionStoreOptions.lock}）：把一條邊標成 `breaking`，驗舊檔經出貨的 store 被拒。
   */
  readonly catalog?: SessionFormatCatalog;
  /** 這份日誌在哪裡：拒讀時放進 {@link SessionFormatUnsupportedError.location}（不進訊息）。不知道就不給。 */
  readonly location?: SessionLocation;
}

/** {@link parseHeader} 交出來的東西。 */
export interface ParsedSessionHeader {
  /** 轉譯成這一版的 header：`version` 一律是 `SESSION_LOG_FORMAT_VERSION`，其餘各格原樣（照 dsh `types.ts:96-100`）。 */
  readonly header: StoredSessionHeader;
  /** 磁碟上那份 header 寫的格式版本。見 `@nexus/core` 的 `ReadonlyStoredSession.storedFormatVersion`。 */
  readonly storedFormatVersion: number;
}

/**
 * 讀 header，**版本太新與讀不懂分開報**（見 `session-store.ts` 的版本 3 那一段）。續接、列、唯讀打開與離線掃描
 * 共用這一份，差別只在選項。
 *
 * **版本讀不讀得了問目錄**（`classifyStoredFormatVersion`，#1529）：比目錄新的，與比某條 `breaking` 邊舊的（這一版
 * 沒有那一段的遷移），都以 {@link SessionFormatUnsupportedError} 拒讀，訊息分得出是哪一種。續接、唯讀打開與列表都經過
 * 這裡，所以就地續寫只走得到全是 `additive` 的區間。
 *
 * **header 在這裡轉譯成這一版**（#1856）：交出去的 `header.version` 一律是 `SESSION_LOG_FORMAT_VERSION`，磁碟上寫的
 * 那個版號另交 `storedFormatVersion`。本文照後者解析；過了上面那道目錄檢查，兩者之間只有 `additive` 的邊。
 *
 * @throws {@link SessionFormatUnsupportedError} 版本比這一版新（開了 `acceptNewer` 就不拋），或比一條 `breaking` 邊舊
 *   （`acceptNewer` 不放行這一種）。
 * **各格的形狀與鍵白名單**與 `create` 共用（`session-log-validation.ts` 的 `assertStoredHeaderFields`，#1549），對到 dsh
 * 讀 header 時的精確鍵與型別檢查（`session-format-v1-to-v2/src/codec.ts:40-75`）。開了 `acceptNewer` 不檢白名單：
 * 比這一版新的 header 可能有這一版不認得的鍵。
 *
 * @throws {@link SessionCorruptionError} 不是 JSON、欄位形狀不對、或 id 對不上。
 */
export function parseHeader(text: string, options: ParseHeaderOptions = {}): ParsedSessionHeader {
  const { id: expected } = options;
  /** 錯誤訊息裡的那個 id：呼叫方給的，沒給就是 header 自己記的。 */
  let id = expected ?? '（不明）';
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SessionCorruptionError(id, 'header 不是 JSON');
  }
  if (!isRecord(value)) throw new SessionCorruptionError(id, 'header 不是一個物件');
  if (expected === undefined && typeof value['id'] === 'string') id = value['id'];
  const { version } = value;
  if (typeof version === 'number' && Number.isSafeInteger(version) && version >= 1) {
    const verdict = classifyStoredFormatVersion(version, options.catalog ?? SESSION_FORMAT_CATALOG);
    if (verdict === 'newer' && options.acceptNewer !== true) {
      throw new SessionFormatUnsupportedError(id, version, undefined, options.location);
    }
    if (verdict === 'older-without-migration') {
      throw new SessionFormatUnsupportedError(
        id,
        version,
        `會話 "${id}" 的格式版本是 ${String(version)}，這一版沒有 v${String(version)} 的遷移，讀不了。` +
          `檔案沒有壞，是比這一版能接的舊。`,
        options.location,
      );
    }
  }
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new SessionCorruptionError(id, `header 的 version 是 ${JSON.stringify(version)}`);
  }
  if (expected === undefined ? typeof value['id'] !== 'string' : value['id'] !== expected) {
    throw new SessionCorruptionError(id, `header 記的 id 是 ${JSON.stringify(value['id'])}`);
  }
  if (typeof value['createdAt'] !== 'number') {
    throw new SessionCorruptionError(id, 'header 沒有 createdAt');
  }
  // 各格的形狀與鍵白名單，與 `create` 共用同一支（#1549）。排在版本判定之後：讀不了的版本照舊報
  // `SessionFormatUnsupportedError`，不會被這裡改判成壞檔。
  try {
    assertStoredHeaderFields(value, { allowUnknownKeys: options.acceptNewer === true });
  } catch (error: unknown) {
    throw new SessionCorruptionError(id, error instanceof Error ? error.message : String(error));
  }
  const header = {
    ...value,
    version: SESSION_LOG_FORMAT_VERSION,
  } as unknown as StoredSessionHeader;
  return { header, storedFormatVersion: version };
}

/**
 * {@link parseJsonlSessionBody} 的選項。**要嘛說明白是哪一版的日誌，要嘛明說不守**——不給預設，因為守衛開著的時候
 * 拒絕訊息要講是哪一份的哪個版本，而不守是少數呼叫方的例外。`recovery` 同理必填、不給預設：兩種讀法對壞行的
 * 態度相反，呼叫方要明說自己是哪一種。
 */
export type ParseBodyOptions = (
  | {
      /** 不認得又沒標可忽略的種類也照收。**只給產品路徑外的離線掃描**（`eval/session-scan.ts` 的「照格式版本表態」）。 */
      readonly acceptUnknownEvents: true;
    }
  | {
      readonly acceptUnknownEvents?: false;
      /** header 上寫的版本，原樣；只用在拒絕時的訊息。 */
      readonly version: unknown;
    }
) & {
  /**
   * `strict`：第一個壞行就整份拒絕——驗證工具與離線掃描用。
   * `recoverable`：壞行與它之後的行可以丟掉，除非後面跟著收尾（見 {@link parseJsonlSessionBody}）——產品路徑的
   * 續接與預設讀取用，照 dsh 的 `SessionLogScanner` 預設（`format.ts:404`）。
   */
  readonly recovery: 'strict' | 'recoverable';
  /** 同 {@link ParseHeaderOptions.location}：不認得的必需種類拒讀時帶上。 */
  readonly location?: SessionLocation;
};

/** 收尾一輪的事件種類：`session-log.ts` 的 `openTurnStart` 與 `interrupted-turn.ts` 都把這兩個當收尾（Q1 (a)，#1508）。 */
const TURN_CLOSER_TYPES: ReadonlySet<unknown> = new Set(['turn/end', 'turn/failed']);

function isTurnCloser(value: unknown): boolean {
  return isRecord(value) && TURN_CLOSER_TYPES.has(value['type']);
}

/**
 * 讀日誌本文：**實體上有效的前綴**，加上它有幾個位元組。
 *
 * **換行在原始位元組上找（`0x0A`），位元組數也算在 Buffer 上**，只有完整的行才解碼成字串。先解碼成字串再算
 * `Buffer.byteLength` 會多算：完整行裡的非法 UTF-8 位元組解碼時變成 U+FFFD（3 個位元組），算出來的位元組數比
 * 實際多，截斷就會留下撕裂尾巴的前幾個位元組（照 dsh `format.ts:381-385`、`:423-436`）。`validBytes` 是最後一個
 * 被接受的行的結束位元組（dsh 的 `committedBytes`）。
 *
 * 最後一個換行之後的東西是寫到一半的那一行——當掉時的常態，不算壞檔，只是不算進去。
 * 換行之前的每一行必須是一筆 `seq` 等於已接受事件數的事件；不是的話那一行是壞行：
 *
 * - `strict`：整份拒絕。
 * - `recoverable`（照 dsh `format.ts:478-521`）：**第一個**壞行記成 issue，不立刻拋。之後的行不再檢查 `seq`，
 *   遇到任何一個收尾事件（`turn/end` 或 `turn/failed`）就拋那個 issue——壞行落在一個已收尾的輪中間，不是當掉
 *   留下的尾巴，是壞檔；沒有收尾的話，壞行與它之後的行都屬於那一次沒寫完的輪，丟掉，由續接補「中斷」。壞行本身
 *   parse 得了、而且是收尾事件，也立即拋。
 *
 * 壞行指：不是 JSON、不像一筆事件（`type` 是字串、`time` 是數字的物件），或 `seq` 不等於已接受的事件數。
 *
 * **種類這一版不認得、又沒標 `ignorable` 的，整份拒絕**（{@link SessionEventUnsupportedError}，
 * [#507](https://github.com/DemianLi/nexus-agent/issues/507)），不是略過那一行：不認得的必需事件可能左右後面每一筆
 * 怎麼讀。同 dsh（`packages/core/session/src/types.ts:501-511`，`5badb15`）。守衛在這裡而不是 append：
 * append 時拒絕詞彙會讓正在跑的會話的耐久寫入卡住。`strict` 裡順序在壞檔判斷**之後**：同一行既不認得又 `seq`
 * 對不上的話，先報壞檔，那是比「更新的版本寫的」更需要人看的一種。`recoverable` 裡順序反過來，照 dsh「准入先於
 * 復原」（`format.ts:490-497`）：像一筆事件的每一行（`type` 是字串、`seq` 與 `time` 是數字，同撿回模式的門檻），
 * 包括壞行與壞行之後要丟掉的行，都先過這一關——否則新版行程寫的事件會被當成壞尾，靜靜截掉。
 *
 * **匯出給唯讀的讀方**：離線掃描（`eval/session-scan.ts`）不能走 {@link JsonlSessionStore.resume}
 * ——那條會拿寫租約、換版時取代 header、截掉撕裂的尾巴，全是寫入，還會把一個正在寫的行程擋在門外。
 * 撕裂尾巴的規則只有這一份，唯讀打開（`open(id, 'read')`）也走它，但**唯讀的永遠不截、不講**。
 *
 * @throws {@link SessionCorruptionError} 中段某一行讀不懂，或 `seq` 不連續（`recoverable` 只在壞行之後還有收尾時）。
 */
export function parseJsonlSessionBody(
  id: string,
  body: Buffer,
  options: ParseBodyOptions,
): { events: SessionEvent[]; validBytes: number } {
  const events: SessionEvent[] = [];
  let validBytes = 0;
  let issue: SessionCorruptionError | undefined;
  let lineStart = 0;
  let lineNumber = 0;
  for (let newline = body.indexOf(0x0a, lineStart); newline !== -1;) {
    lineNumber += 1;
    const lineEnd = newline + 1;
    const line = body.toString('utf8', lineStart, newline);
    lineStart = lineEnd;
    newline = body.indexOf(0x0a, lineStart);

    let value: unknown;
    let problem: string | undefined;
    try {
      value = JSON.parse(line);
    } catch {
      problem = `第 ${lineNumber} 行不是 JSON`;
    }
    const eventLike =
      problem === undefined &&
      isRecord(value) &&
      typeof value['type'] === 'string' &&
      typeof value['time'] === 'number';
    if (problem === undefined && !eventLike) problem = `第 ${lineNumber} 行不是一筆會話事件`;

    if (options.recovery === 'strict') {
      if (problem !== undefined) throw new SessionCorruptionError(id, problem);
      events.push(
        admitEvent(id, value as Record<string, unknown>, events.length, lineNumber, options),
      );
      validBytes = lineEnd;
      continue;
    }

    // recoverable：准入先於復原——壞行與壞行之後的行都先過。
    if (
      eventLike &&
      typeof (value as Record<string, unknown>)['seq'] === 'number' &&
      options.acceptUnknownEvents !== true
    ) {
      const { ignorable, seq } = value as Record<string, unknown>;
      const type = (value as Record<string, unknown>)['type'] as string;
      if (isUnreadableSessionEvent({ type, ignorable })) {
        throw new SessionEventUnsupportedError(
          id,
          options.version,
          seq as number,
          type,
          options.location,
        );
      }
    }
    if (issue !== undefined) {
      if (isTurnCloser(value)) throw issue;
      continue;
    }
    if (problem === undefined && (value as Record<string, unknown>)['seq'] !== events.length) {
      problem = seqMismatchMessage(
        lineNumber,
        (value as Record<string, unknown>)['seq'],
        events.length,
      );
    }
    if (problem !== undefined) {
      issue = new SessionCorruptionError(id, problem);
      if (isTurnCloser(value)) throw issue;
      continue;
    }
    events.push(value as unknown as SessionEvent);
    validBytes = lineEnd;
  }
  return { events, validBytes };
}

function seqMismatchMessage(lineNumber: number, seq: unknown, expected: number): string {
  return `第 ${lineNumber} 行的 seq 是 ${JSON.stringify(seq)}，應該是 ${expected}——缺號或重號`;
}

/** strict 的一行：`seq` 對得上、這一版認得，才算一筆事件。 */
function admitEvent(
  id: string,
  value: Record<string, unknown>,
  index: number,
  lineNumber: number,
  options: ParseBodyOptions,
): SessionEvent {
  if (value['seq'] !== index) {
    throw new SessionCorruptionError(id, seqMismatchMessage(lineNumber, value['seq'], index));
  }
  const { ignorable } = value;
  const type = value['type'] as string;
  if (options.acceptUnknownEvents !== true && isUnreadableSessionEvent({ type, ignorable })) {
    throw new SessionEventUnsupportedError(id, options.version, index, type, options.location);
  }
  return value as unknown as SessionEvent;
}

/**
 * 中段壞掉的本文**撿回讀得懂的**：只看完整的行（最後一個換行之前），解析不動、或沒有數字的 `seq` 與 `time` 的略過。
 * 見 `@nexus/core` 的 `StoredSessionReadOptions.salvage`。
 */
function salvageJsonlSessionBody(
  id: string,
  body: Buffer,
  version: unknown,
  location: SessionLocation,
): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const line of body.toString('utf8', 0, body.lastIndexOf(0x0a) + 1).split('\n')) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      isRecord(value) &&
      typeof value['seq'] === 'number' &&
      typeof value['time'] === 'number' &&
      typeof value['type'] === 'string'
    ) {
      // 撿回的是**壞行**，不是「更新的版本寫的」：不認得的必需種類照樣整份拒絕（#507）。壞行排在它前面或後面，結果
      // 不能不一樣。
      if (isUnreadableSessionEvent({ type: value['type'], ignorable: value['ignorable'] })) {
        throw new SessionEventUnsupportedError(id, version, value['seq'], value['type'], location);
      }
      events.push(value as unknown as SessionEvent);
    }
  }
  return events;
}

/** {@link readStableSnapshot} 用到的檔案系統。**只給測試換**：真的磁碟上造不出「讀的當下變了」。同 dsh 的 `GenerationFileSystem`。 */
export interface StableReadFileSystem {
  stat(path: string): Promise<BigIntStats>;
  readFile(path: string): Promise<Buffer>;
}

const defaultStableReadFs: StableReadFileSystem = {
  stat: (path) => stat(path, { bigint: true }),
  readFile: (path) => readFile(path),
};

/** 身分字串：裝置、inode、大小、修改與變更時間（奈秒）。照 dsh `generation.ts:243-245`。 */
function identityOf(stats: BigIntStats): string {
  return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(':');
}

/**
 * 穩定快照讀，逐行照 dsh `readStableSnapshot`（`session-persistence-jsonl/src/generation.ts:262-282`）：讀前 `stat`、
 * `readFile`、讀後再 `stat`，身分一樣就回傳；不一樣就重讀一次；第二次還是變了，回傳**第二次讀到的位元組截到讀前大小的前綴**
 * 與讀前身分——不被持續寫入的寫者餓死。（沒有 `AbortSignal`：今天沒有呼叫方要中止單份讀，見 #1509。）
 *
 * @param path - 要讀的檔。
 * @param fs - 檔案系統，預設是真的。
 * @returns 位元組，與證明它穩定（或截成前綴）的那次 `stat` 的身分字串。
 */
export async function readStableSnapshot(
  path: string,
  fs: StableReadFileSystem = defaultStableReadFs,
): Promise<{ readonly bytes: Buffer; readonly identity: string }> {
  let before = await fs.stat(path);
  for (let attempt = 0; ; attempt += 1) {
    const bytes = await fs.readFile(path);
    const after = await fs.stat(path);
    if (identityOf(before) === identityOf(after)) return { bytes, identity: identityOf(after) };
    if (attempt === 1) {
      return { bytes: bytes.subarray(0, Number(before.size)), identity: identityOf(before) };
    }
    before = after;
  }
}

/**
 * 讀日誌本文，原始位元組（不給 encoding）：換行與位元組偏移都要算在 Buffer 上，見 {@link parseJsonlSessionBody}。
 * 走 {@link readStableSnapshot}（#1509），順序同 dsh：先穩定讀、再解碼。
 * **不在是空的**：只有 header 是「還沒寫第一筆就當了」。
 */
async function readBody(
  logPath: string,
  fs: StableReadFileSystem = defaultStableReadFs,
): Promise<Buffer> {
  return (await readBodySnapshot(logPath, fs)).bytes;
}

/**
 * 同 {@link readBody}，另交證明它穩定的那次 `stat` 的身分（格式同 {@link fileRevision}，不在就是 `missing`）：冷讀快取
 * 拿它當日誌的 revision，不另外再 `stat` 一次。
 */
async function readBodySnapshot(
  logPath: string,
  fs: StableReadFileSystem,
): Promise<{ readonly bytes: Buffer; readonly identity: string }> {
  try {
    return await readStableSnapshot(logPath, fs);
  } catch (error: unknown) {
    if (isNotFound(error)) return { bytes: Buffer.alloc(0), identity: MISSING_REVISION };
    throw error;
  }
}

/** {@link readSessionEntry} 的選項。 */
export interface ReadSessionEntryOptions extends ParseHeaderOptions {
  /** 讀 header 與日誌本文用的檔案系統。**只給測試換**，同 {@link readStableSnapshot}。 */
  readonly fs?: StableReadFileSystem;
}

/** 目錄裡的一份會話：header 已經讀過，日誌本文要的時候才讀。 */
export interface SessionEntry {
  /** 檔名基底（{@link safeBaseName} 算出來的那個）。 */
  readonly base: string;
  /** 日誌本文的路徑。檔不一定在：只有 header 是「還沒寫第一筆就當了」。 */
  readonly logPath: string;
  /** 同 {@link ParsedSessionHeader.header}。 */
  readonly header: StoredSessionHeader;
  /** 同 {@link ParsedSessionHeader.storedFormatVersion}。 */
  readonly storedFormatVersion: number;
  /** 日誌本文的原始位元組，走 {@link readStableSnapshot}。日誌不在就是空的。 */
  readBody(): Promise<Buffer>;
}

/**
 * **讀一份會話的接縫**（[#1857](https://github.com/DemianLi/nexus-agent/issues/1857)）：給一個目錄項，回 header 與日誌本文。
 * 後端自己的列表、唯讀打開、續接，跟產品路徑外的離線掃描、夾具都經過這裡，誰也不自己 `readFile` 兩個檔。佈局換掉
 * （#1594 ②）時，讀方只動這一支與 `@nexus/core` 的檔名模組。
 *
 * 只管「讀」與「讀不讀得懂」（{@link parseHeader} 拋什麼就拋什麼）。檔名基底對不上 header 記的 id 算不算讀不懂，是列表
 * 自己的規則（`open(id)` 照 id 算檔名），不在這裡判。
 *
 * @param directory - 會話所在的目錄。
 * @param filename - 目錄裡的一個檔名。
 * @param options - 同 {@link parseHeader}，另加測試用的檔案系統。
 * @returns 不是 header 檔，或 header 在讀目錄與讀檔之間不見了，都是 `undefined`。
 * @throws 同 {@link parseHeader}。
 */
export async function readSessionEntry(
  directory: string,
  filename: string,
  options: ReadSessionEntryOptions = {},
): Promise<SessionEntry | undefined> {
  const base = parseSessionHeaderFilename(filename);
  if (base === undefined) return undefined;
  const { fs = defaultStableReadFs, ...parseOptions } = options;
  let text: string;
  try {
    text = (await fs.readFile(join(directory, filename))).toString('utf8');
  } catch (error: unknown) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  const { header, storedFormatVersion } = parseHeader(text, parseOptions);
  const logPath = join(directory, sessionFilenames(base).log);
  return { base, logPath, header, storedFormatVersion, readBody: () => readBody(logPath, fs) };
}

/**
 * 一份會話三個檔在 `directory` 裡的路徑。給**知道 id、要直接碰檔**的產品路徑外讀寫方（量測、夾具、煙霧測試）：
 * 檔名照 `@nexus/core` 的那一份，基底照 {@link safeBaseName}，不自己拼。
 *
 * @param directory - 會話所在的目錄。
 * @param sessionId - session id。
 */
export function sessionPathsIn(directory: string, sessionId: string): SessionFilenames {
  const names = sessionFilenames(safeBaseName(sessionId));
  return {
    header: join(directory, names.header),
    log: join(directory, names.log),
    lock: join(directory, names.lock),
  };
}

/** {@link fileRevision} 對「檔不在」給的那個值。 */
const MISSING_REVISION = 'missing';

/**
 * 一個檔此刻的樣子，照 dsh 的 `fileRevision`（`packages/session/session-persistence-jsonl/src/index.ts:184-192`）：
 * 裝置、inode、大小、修改與變更時間（奈秒）。不在就是 `missing`。
 */
async function fileRevision(
  path: string,
  fs: StableReadFileSystem = defaultStableReadFs,
): Promise<string> {
  let stats: BigIntStats;
  try {
    stats = await fs.stat(path);
  } catch (error: unknown) {
    if (isNotFound(error)) return MISSING_REVISION;
    throw error;
  }
  return identityOf(stats);
}

/** 列舉預設同時讀幾份，同 dsh 的 `DEFAULT_LIST_CONCURRENCY`（`index.ts:91`）。 */
const DEFAULT_LIST_CONCURRENCY = 3;

/** 把一件工作排進上限裡跑：名額滿了就照到的順序排隊。 */
type ListLimit = <R>(task: () => Promise<R>) => Promise<R>;

/**
 * 最多 `concurrency` 件同時跑的限流器，語意同 dsh 用的 `p-limit`（`index.ts:328`）：dsh 引套件，這裡自己寫是因為
 * 引套件要先過 #1545 的發布年齡閘。一個後端只建一個（{@link LeaseContext.listLimit}）。
 */
function createListLimit(concurrency: number): ListLimit {
  let active = 0;
  const queue: (() => void)[] = [];
  const release = (): void => {
    active -= 1;
    queue.shift()?.();
  };
  return <R>(task: () => Promise<R>): Promise<R> =>
    new Promise<R>((fulfil, reject) => {
      const run = (): void => {
        active += 1;
        // 同步拋的也算失敗、照樣放掉名額。
        void Promise.resolve().then(task).then(fulfil, reject).finally(release);
      };
      if (active < concurrency) run();
      else queue.push(run);
    });
}

/**
 * 每一件經後端共用的上限跑，**全部 settle 之後**才交結果，順序同輸入。逐行照 dsh `settleLimited`（`index.ts:225-231`）。
 */
function settleLimited<T, R>(
  limit: ListLimit,
  items: readonly T[],
  task: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  return Promise.allSettled(items.map((item) => limit(() => task(item))));
}

/** settle 完的結果取值：**依輸入順序**拋第一個失敗，照 dsh `settledValues`（`index.ts:238-243`）——不是先失敗的那個。 */
function settledValues<R>(results: readonly PromiseSettledResult<R>[]): R[] {
  return results.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
}

/**
 * 列 `directory` 裡落了盤的每一份。見 {@link SessionStore.list}。
 *
 * `revision` 算的是 **header 與本文兩個檔**：dsh 的 header 在同一個檔裡，我們分開存，而續接換版會取代 header
 * （改 `version`）。只算本文的話，那一下看不出來。
 *
 * **檔名基底對不上 header 記的 id 的算讀不懂**：`open(id)` 照 id 算檔名，找不到它。只有手動改過檔名才會這樣。
 */
async function listStoredSessions(
  directory: string,
  context: LeaseContext,
  options: StoredSessionListOptions = {},
): Promise<StoredSessionListing> {
  const { signal } = options;
  const { catalog, fs } = context;
  signal?.throwIfAborted();
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error: unknown) {
    if (isNotFound(error)) return { sessions: [], unreadable: 0 };
    throw error;
  }
  // 一份一份讀換成經後端共用的上限讀（#1559 N0627），照 dsh `list`（`index.ts:532`）。每份開始前看一次 signal：
  // 被取消的列舉，排隊中的那幾份輪到時才拋（同 dsh `:297-302`）。
  const outcomes = settledValues(
    await settleLimited(
      context.listLimit,
      names,
      async (name): Promise<StoredSessionSnapshot | 'unreadable' | undefined> => {
        signal?.throwIfAborted();
        const base = parseSessionHeaderFilename(name);
        if (base === undefined) return undefined;
        const files = sessionFilenames(base);
        // 先記樣子再讀：兩步之間被改了的話，記下的是舊的，下一次比對時不相等，衍生的快取多讀一次而已。
        const revision = `${await fileRevision(join(directory, files.header), fs)}|${await fileRevision(join(directory, files.log), fs)}`;
        let entry: SessionEntry | undefined;
        try {
          entry = await readSessionEntry(directory, name, { catalog, fs });
        } catch (error: unknown) {
          if (
            error instanceof SessionCorruptionError ||
            error instanceof SessionFormatUnsupportedError
          ) {
            return 'unreadable';
          }
          throw error;
        }
        // 讀目錄與讀檔之間被刪掉：不是壞檔，就是不在了。
        if (entry === undefined) return undefined;
        if (safeBaseName(entry.header.id) !== base) return 'unreadable';
        const { header, storedFormatVersion } = entry;
        return { header, storedFormatVersion, revision };
      },
    ),
  );
  const sessions: StoredSessionSnapshot[] = [];
  let unreadable = 0;
  for (const outcome of outcomes) {
    if (outcome === 'unreadable') unreadable += 1;
    else if (outcome !== undefined) sessions.push(outcome);
  }
  return { sessions, unreadable };
}

/**
 * 拒讀診斷用的位置（#1559 N0646），照 dsh 的 `locate()`（`index.ts:345-347`）：日誌檔的絕對路徑，不碰檔案系統。
 */
function locate(directory: string, files: SessionFilenames): SessionLocation {
  return { kind: 'jsonl', path: resolve(directory, files.log) };
}

/**
 * 解析好的已接受前綴，交出去之前（也是存進冷讀快取之前）的驗證（#1549），續接與唯讀打開共用，順序照 dsh：
 * 讀檔器收尾時的關係驗證（`session-persistence-jsonl/src/format.ts:468`），再逐筆跑單筆資料規則（`index.ts:860` 的
 * `validateStoredEvents`，之後才 `:868` 存快取）。撿回（salvage）不跑：它本來就是在處理壞檔，dsh 沒有這條路。
 * 事件信封不在這裡驗：照 dsh 在 core 的 seed（`SessionLog`）驗。
 *
 * @throws {@link SessionCorruptionError} 哪一行、哪一格不對。
 */
function validateStoredLog(id: string, events: readonly SessionEvent[]): void {
  assertStoredRelationships(id, events);
  assertStoredEventData(id, events);
}

/**
 * 唯讀打開 `directory` 裡的那一份。見 {@link SessionStore.open}：**不拿租約、不截尾巴、不動 header**。
 */
async function openStoredSessionForRead(
  directory: string,
  id: string,
  context: LeaseContext,
): Promise<ReadonlyStoredSession> {
  const { catalog, fs, coldLogs } = context;
  const files = sessionFilenames(safeBaseName(id));
  const headerPath = join(directory, files.header);
  const location = locate(directory, files);
  // 先記樣子再讀 header（同 list）：中間被換掉的話，存進快取的是舊 revision，之後比對不相等、多讀一次而已。
  const headerRevision = await fileRevision(headerPath, fs);
  const entry = await readSessionEntry(directory, files.header, { id, catalog, fs, location });
  if (entry === undefined) {
    throw new SessionNotFoundError(id, `${directory} 裡沒有會話 "${id}"（找不到 ${headerPath}）。`);
  }
  const { header, storedFormatVersion, logPath } = entry;
  return {
    header,
    storedFormatVersion,
    async read(options: StoredSessionReadOptions = {}): Promise<readonly SessionEvent[]> {
      if (options.salvage !== true) {
        const memoized = coldLogs.get(
          id,
          await fileRevision(headerPath, fs),
          await fileRevision(logPath, fs),
        );
        if (memoized !== undefined) return memoized.events;
      }
      const { bytes: body, identity } = await readBodySnapshot(logPath, fs);
      try {
        // 開了 salvage 的先走 strict、失敗才撿回：salvage 的語意（已登記的偏離）維持今天的樣子，不被 recoverable 搶先丟掉。
        const { events, validBytes } = parseJsonlSessionBody(id, body, {
          version: storedFormatVersion,
          recovery: options.salvage === true ? 'strict' : 'recoverable',
          location,
        });
        if (options.salvage === true) return events;
        validateStoredLog(id, events);
        const frozen = freezeStoredEvents(events);
        coldLogs.set(id, {
          headerRevision,
          logRevision: identity,
          header,
          storedFormatVersion,
          events: frozen,
          validBytes,
          bodyBytes: body.byteLength,
        });
        return frozen;
      } catch (error: unknown) {
        if (options.salvage === true && error instanceof SessionCorruptionError) {
          return salvageJsonlSessionBody(id, body, storedFormatVersion, location);
        }
        throw error;
      }
    },
  };
}

/**
 * 續接 `directory` 裡的那一份。見 {@link SessionStore.resume}。
 *
 * **只有 header、沒有日誌不是壞檔**：`#open` 先發佈 header（暫存檔加 `link`，#1510）再開日誌，兩步之間當掉
 * 就是這個樣子——一份一筆都還沒寫進去的會話。
 */
async function resumeStoredSession(
  directory: string,
  id: string,
  context: LeaseContext,
): Promise<ResumedStoredSession> {
  const { catalog, fs, coldLogs } = context;
  const files = sessionFilenames(safeBaseName(id));
  const headerPath = join(directory, files.header);
  const location = locate(directory, files);
  const missing = () =>
    new SessionNotFoundError(id, `${directory} 裡沒有會話 "${id}"（找不到 ${headerPath}）。`);
  // **先認得有這份，再拿租約**：打錯的 `--resume` 不該留下一個鎖檔。
  try {
    await fs.stat(headerPath);
  } catch (error: unknown) {
    if (isNotFound(error)) throw missing();
    throw error;
  }
  // **在讀之前拿**，照 dsh：別人握著的話，該在什麼都還沒讀之前就講；也不讓兩個續接者同時換版。
  // header 換版是原子取代（#1509），唯讀的讀方不拿租約也只會看到舊的或新的完整一份。
  const lease = await leaseFor(context, join(directory, files.lock), id);
  try {
    // 冷讀快取（#1559 N0625）：**租約拿到之後**才比兩個檔的 revision——比對之後到第一次寫之前，別人寫不進來。
    // 對上了就省掉 readFile 與解析；對不上照常讀。
    const memoized = coldLogs.get(
      id,
      await fileRevision(headerPath, fs),
      await fileRevision(join(directory, files.log), fs),
    );
    let read: Omit<ColdLog, 'headerRevision' | 'logRevision'>;
    if (memoized !== undefined) {
      read = memoized;
    } else {
      const entry = await readSessionEntry(directory, files.header, { id, catalog, fs, location });
      if (entry === undefined) throw missing();
      const { header, storedFormatVersion } = entry;
      const { bytes: body } = await readBodySnapshot(entry.logPath, fs);
      const { events, validBytes } = parseJsonlSessionBody(id, body, {
        version: storedFormatVersion,
        recovery: 'recoverable',
        location,
      });
      validateStoredLog(id, events);
      read = { header, storedFormatVersion, events, validBytes, bodyBytes: body.byteLength };
    }
    const { header, storedFormatVersion, events, validBytes } = read;
    const droppedBytes = read.bodyBytes - validBytes;
    return {
      header,
      storedFormatVersion,
      events,
      // 就地續寫、header 換成這一版：**只在加性區間成立**（#1529）。走到這裡的版本，從它到這一版的每一條邊都是
      // `additive`——有 `breaking` 的話上面的 `parseHeader` 已經拒讀，續寫進去的新詞彙舊段落的讀法不受影響。
      // `header` 已經是這一版（`parseHeader` 轉譯過），磁碟上那份要不要換掉看 `storedFormatVersion`。
      stored: new JsonlStoredSession(directory, header, context, {
        nextSeq: events.length,
        ...(storedFormatVersion !== SESSION_LOG_FORMAT_VERSION && { headerStale: true as const }),
        ...(droppedBytes > 0 && { torn: { truncateTo: validBytes, droppedBytes } }),
        lease,
      }),
    };
  } catch (error: unknown) {
    // 讀壞了就沒有把手可關，租約得在這裡放。
    await lease?.release();
    throw error;
  }
}

/**
 * 一個專案目錄在會話根底下的目錄名——照 dsh 的 `projectKey`
 * （`packages/session/session-persistence-jsonl/src/format.ts`，SHA `c291e79`），逐字元抄。
 *
 * 分隔符（`/`、`\\`、`:`）變成 `-`，連續的只留一個；不安全的 UTF-16 碼元寫成 `~XXXX`；
 * 前後包 `--`，長度封頂。**它是有損的**（分隔符與截短），dsh 明說這是刻意的：換來的是人
 * 在目錄裡找得到自己的專案。有損就可能撞，所以續接時照樣比 header 的 `cwd`
 * （{@link ./resume-guards.ts | ResumeCwdConflictError}），同 dsh。
 *
 * @param cwd - 專案目錄。
 * @returns 一段檔案系統安全的目錄名。
 * @throws 空字串。
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('專案目錄是空字串，排不出目錄名。');
  let readable = '';
  let separatorRun = false;
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index);
    const char = String.fromCharCode(code);
    if (char === '/' || char === '\\' || char === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (char !== '~' && /^[A-Za-z0-9._-]$/.test(char)) {
      readable += char;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root';
  return `--${slug.slice(0, 251)}--`;
}

/** {@link createJsonlSessionStore} 與 {@link openJsonlSessionStore} 交出來的東西。 */
export interface JsonlSessionStore extends SessionStore {
  /** 這一次的 run 目錄。披露那一行印的就是它。 */
  readonly directory: string;
}

/** 兩個工廠共用的選項。 */
export interface JsonlSessionStoreOptions {
  /**
   * 這個平台拿不到寫租約時講的那一句（見 `session-lease.ts`）。一個後端只講一次。
   * 省略就走 `console.warn`；產品路徑兩個入口都各自給（CLI 走 `Printer`，serve 走伺服器日誌）。
   */
  readonly warn?: (message: string) => void;
  /** 拿鎖的那一下。**只給測試換**：真的平台上量不到「拿不到」那兩條路。 */
  readonly lock?: TryLock;
  /** 開日誌檔的那一下。**只給測試換**：用來包住把手，製造寫到一半拋錯、短寫、sync 拋錯與截回失敗。 */
  readonly openLog?: OpenLogFile;
  /** 讀 header 時問的版本邊目錄。**只給測試換**，見 {@link ParseHeaderOptions.catalog}。 */
  readonly catalog?: SessionFormatCatalog;
  /**
   * 列舉時最多同時讀幾份（#1559 N0627），照 dsh 的 `listConcurrency`（`index.ts:1811`，`min(1)`）。省略即 3。
   * 是**這個後端**的上限：同時跑的幾個 `list()` 加起來不超過它。
   * @throws `TypeError`（建構時）不是 1 以上的整數。
   */
  readonly listConcurrency?: number;
  /**
   * 讀 header、日誌本文與取 revision 用的檔案系統。**只給測試換**（同 {@link lock}）：數讀了幾次、同時在跑幾個、
   * 製造讀檔失敗。寫入不經過它。
   */
  readonly fs?: StableReadFileSystem;
}

/**
 * `create` 收到的 header 先驗、再拷一份（#1559 N0622），照 dsh 的 `materializeCreateHeader`
 * （`session-persistence/src/storage-contract.ts:112-121`）加 `toHeaderLine` 的版本與欄位斷言（`format.ts:119-134` →
 * `session-format/src/catalog.ts:110-122` → `session-format-v3-to-v4/src/codec.ts:43`）。驗過的就是要寫的那一份：
 * 呼叫方之後改它的物件，不會改到落盤的 header。
 *
 * @throws `TypeError` 不是無損的 JSON、版本不是這一版、或某一格的形狀不對（{@link assertStoredHeaderFields}）。
 */
function materializeCreateHeader(header: StoredSessionHeader): StoredSessionHeader {
  let snapshot: unknown;
  try {
    snapshot = snapshotJsonValue(header, 'session header');
  } catch (error: unknown) {
    throw new TypeError(
      `session header 不是無損的 JSON：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const { version } = snapshot as { version?: unknown };
  if (version !== SESSION_LOG_FORMAT_VERSION) {
    throw new TypeError(
      `session header 的 version 要是這一版（${SESSION_LOG_FORMAT_VERSION}），拿到 ${JSON.stringify(version)}`,
    );
  }
  assertStoredHeaderFields(snapshot);
  return snapshot as StoredSessionHeader;
}

/**
 * 磁碟上這個 id 的 header 或日誌已經在了沒有（#1559 N0622）。**同步**：`SessionStore.create` 是同步介面，它的呼叫方
 * （`sessions.observe` 的回呼）也是同步的（Q1 (a)）；dsh 建構子同樣用同步的 `readdirSync`。看兩個檔，同 dsh `findLog`
 * 看的是日誌：「header 不在、日誌在」（首次落盤兩步之間當掉）也算建過。不在才放行，其餘的錯原樣拋。
 */
function existsOnDisk(directory: string, id: string): boolean {
  const files = sessionFilenames(safeBaseName(id));
  for (const name of [files.header, files.log]) {
    try {
      statSync(join(directory, name));
      return true;
    } catch (error: unknown) {
      if (!isNotFound(error)) throw error;
    }
  }
  return false;
}

/** 落在 `directory` 上的後端。兩個工廠差在目錄是新開的還是既有的。 */
function jsonlStoreAt(directory: string, options: JsonlSessionStoreOptions): JsonlSessionStore {
  // 建構時就檢查根能不能讀（#1559 N0633），照 dsh `assertUsableRoot`（`index.ts:1591-1598`）：不在照常（第一次寫才建），
  // 其餘（不是目錄、沒權限）當場拋。不然要等第一條會話第一次寫，在協調器的背景路徑上變成一行 warn。
  try {
    readdirSync(directory);
  } catch (error: unknown) {
    if (!isNotFound(error)) throw error;
  }
  const listConcurrency = options.listConcurrency ?? DEFAULT_LIST_CONCURRENCY;
  if (!Number.isSafeInteger(listConcurrency) || listConcurrency < 1) {
    throw new TypeError(`listConcurrency 要是 1 以上的整數，拿到 ${String(listConcurrency)}`);
  }
  const warn = options.warn ?? ((message: string) => console.warn(`[會話日誌] ${message}`));
  let warned = false;
  const context: LeaseContext = {
    lock: options.lock,
    warn,
    openLog: options.openLog ?? ((path, flags, mode) => open(path, flags, mode)),
    catalog: options.catalog ?? SESSION_FORMAT_CATALOG,
    fs: options.fs ?? defaultStableReadFs,
    pending: new Set(),
    coldLogs: new ColdLogMemo(),
    listLimit: createListLimit(listConcurrency),
    unavailable: (outcome) => {
      if (warned) return;
      warned = true;
      warn(
        `這個平台拿不到寫租約（${outcome.unavailable}），${directory} 裡的會話都不鎖：` +
          `兩個行程同時寫同一份會撞號。`,
      );
    },
  };
  return {
    directory,
    create(header: StoredSessionHeader): StoredSession {
      const snapshot = materializeCreateHeader(header);
      if (context.pending.has(snapshot.id) || existsOnDisk(directory, snapshot.id)) {
        throw new SessionAlreadyExistsError(snapshot.id);
      }
      context.pending.add(snapshot.id);
      return new JsonlStoredSession(directory, snapshot, context);
    },
    resume(id: string): Promise<ResumedStoredSession> {
      return resumeStoredSession(directory, id, context);
    },
    list(options?: StoredSessionListOptions): Promise<StoredSessionListing> {
      return listStoredSessions(directory, context, options);
    },
    open(id: string): Promise<ReadonlyStoredSession> {
      return openStoredSessionForRead(directory, id, context);
    },
  };
}

/**
 * 開一個 JSONL 後端。
 *
 * @param options - `rootDir` 底下會開一個這一次專用的 run 目錄。
 * @returns 後端，以及它實際會寫進去的那個目錄。
 */
export function createJsonlSessionStore(
  options: { readonly rootDir: string } & JsonlSessionStoreOptions,
): JsonlSessionStore {
  // 每一次組裝一個目錄。時間戳在前面是為了人排序得動，UUID 在後面是為了同一毫秒起兩次
  // 也不會撞（`wx` 會擋，但擋下來的是一次硬錯誤，不是我們要的行為）。
  const directory = join(
    options.rootDir,
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
  );
  return jsonlStoreAt(directory, options);
}

/** {@link createJsonlSessionStore} 開的 run 目錄的名字：`2026-09-25T12-15-38-007Z-eef8c1ff`。 */
const RUN_DIRECTORY_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/u;
/** {@link projectKey} 排出來的名字。 */
const PROJECT_DIRECTORY_NAME = /^--.+--$/u;

/** 會話根底下的一格。 */
export interface SessionStoreDirectory {
  /** `project` 是 serve 的 `<projectKey(cwd)>`，`cli-run` 是 CLI 一次一個的 run 目錄。 */
  readonly kind: 'project' | 'cli-run';
  readonly directory: string;
}

/**
 * 會話根底下有哪幾格存著會話，給跨專案的讀方（[#713](https://github.com/DemianLi/nexus-agent/issues/713) 的引用候選）
 * 一格一格 {@link openJsonlSessionStore} 再 `list`——**它不必自己認目錄名**。哪幾種要列成候選由它決定。
 *
 * dsh 的後端根就在整個會話根，`list` 一次掃遍（`packages/session/session-persistence-jsonl/src/index.ts` 的
 * `listArtifacts`）。我們不能照搬：CLI 的 root id 一律是 `cli`，一個根底下會有很多份同 id 的，而 dsh 對重複的 id
 * 直接拋。所以 `list` 掛在一格上，跨格的列舉另開這一支（demian 2026-09-29 拍板，#665）。
 *
 * @param rootDir - 會話根（`harnessSessionsDir` 或 `--session-log` 給的）。還不存在就是空的。
 * @returns 認得出來的每一格，照名字排；其餘的（使用者自己放的東西）略過。
 * @throws 會話根存在但讀不到。
 */
export async function listSessionStoreDirectories(
  rootDir: string,
): Promise<readonly SessionStoreDirectory[]> {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch (error: unknown) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const found: SessionStoreDirectory[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!entry.isDirectory()) continue;
    const kind = PROJECT_DIRECTORY_NAME.test(entry.name)
      ? 'project'
      : RUN_DIRECTORY_NAME.test(entry.name)
        ? 'cli-run'
        : undefined;
    if (kind !== undefined) found.push({ kind, directory: join(rootDir, entry.name) });
  }
  return found;
}

/**
 * 打開一個**既有的** run 目錄——續接（`--resume`）用的。
 *
 * **不另開目錄**：續接照 dsh 是往同一份檔續寫，不是把舊的抄進新的——抄一份的話，兩個目錄
 * 會帶著同一個 `(session.id, seq)`，而遙測的去重鍵正是它（`session-log.ts` 檔頭）。
 * 這個行程新出生的 subagent 日誌也落在這裡，與上一個行程的並排；它們的 id 帶 LangGraph
 * 的 task id（`session-address.ts`），`wx` 仍然擋撞名。
 *
 * **續接撞上別人握著就拋 {@link @nexus/core!SessionAlreadyOwnedError}**，在讀之前——另一個
 * 行程還開著這份會話的話，兩邊一起寫會撞號。
 *
 * @param options - 那個 run 目錄。
 * @returns 後端；`create` 開新的、`resume` 接舊的。
 */
export function openJsonlSessionStore(
  options: { readonly directory: string } & JsonlSessionStoreOptions,
): JsonlSessionStore {
  return jsonlStoreAt(options.directory, options);
}
