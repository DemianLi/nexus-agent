/**
 * {@link @nexus/core!SessionStore} 的 JSONL 後端：一份會話一個目錄、一個世代檔，一行一顆事件。
 *
 * 形狀照 dsh 隨產品交付的 `session-persistence-jsonl`（`docs/subsystems/persistence.zh.md`，
 * 本地 clone SHA `d347e703908d0406b7a7ef80e3a0e594d86b2215`）：逐 session 的僅追加日誌、
 * **header 與日誌邏輯上分開**（dsh 明文：元資料在日誌之外，`stat`／`list` 讀 header 不掃正文）、
 * 實體化延後到第一次寫。header 是世代檔的第一行（header 行，{@link JsonlHeaderLine}），檔在 `<目錄>/<sessionDirectoryName(id)>/session.v<N>.jsonl`（#1594 ③）。v0.5.19 以前寫的舊兩檔
 * （`<base>.header.json`、`<base>.jsonl`）照讀，續接時遷成世代檔，舊路徑留墓碑（見下面〈遷移與墓碑〉）。
 *
 * **選 JSONL 不選 SQLite 是一個有代價的選擇，代價登記在這裡。** dsh 兩個 provider 都出
 * （`-jsonl` 與 `-sqlite`），我們先做 JSONL，理由三條：不必現場編譯（SQLite 那條要
 * `better-sqlite3`，而我們的 `onlyBuiltDependencies` 只放了 `esbuild`）、人讀得懂、
 * 以及未來 Proteus 的 `read_trace` 解析的就是 jsonl。丟掉的是頻繁更新時的效率，而
 * 僅追加的日誌本來就沒有頻繁更新。
 * 不必現場編譯這一條，租約也守得住：
 * 租約的鎖在 spawner 裡（見 `session-lease.ts`），spawner 是打包時編好的。
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
 *   之前拿，把手關掉才放。一份會話一把，鎖檔在會話目錄裡（`session.lock`）。續接時要動舊路徑的
 *   （遷移舊兩檔、補墓碑）另外先拿舊路徑的 `<base>.lock`：v0.5.19 以前的版本寫舊兩檔時拿的就是它，遷移跟同時跑的舊版本因此
 *   互斥。順序固定是 `<base>.lock` 先、`session.lock` 後，兩個行程不會各握一把互等；`<base>.lock` 在交把手之前就放。
 *   撞名跟租約各擋一件事：**撞名在 `create` 當下就報**（[#1559](https://github.com/DemianLi/nexus-agent/issues/1559)，
 *   照 dsh `index.ts:360-379`）——同一個後端建過還沒實體化的（行程內的 pending），或磁碟上舊路徑的 header（含墓碑）、日誌任一個
 *   已經在，或會話目錄裡已有正規世代檔的，都同步拋 `SessionAlreadyExistsError`。實體化時的 `link` 仍然在，**檔案已經在就拒絕**，
 *   不覆寫也不續寫：擋的是 `create` 之後才出現的競態，撞上的 `EEXIST` 一樣換成 `SessionAlreadyExistsError`（`cause` 留著原錯）。
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
 * **第一批同時是這份新會話的第一次實體化時，沒有東西要截**：header 行與第一批是同一次 `link` 發佈的（下一節），寫不進去就
 * 什麼都沒發佈。發佈之後的步驟（目錄 `fsync`、墓碑）失敗時
 * 不撤，重試只補沒做完的；協調器重送的那批從 seq 0 起算，已經在世代檔裡的那幾顆不再寫。
 *
 * **和 dsh 唯一的形狀差異是把手的壽命**：dsh 每批開關一次，這裡成功路徑一個把手用到會話結束；失敗路徑
 * 照 dsh——先關掉這個把手、另用 `r+` 開檔截回，下一批用 `a` 重開（demian 2026-10-17 在 #1506 拍板 Q1 (a)）。
 * `append`／`flush`／`close` 排在同一條鏈上，一次只跑一個（dsh `storage.ts:187-195`），否則一邊關把手時另一邊還拿著它。
 *
 * ## 首次落盤是原子的（[#1510](https://github.com/DemianLi/nexus-agent/issues/1510)）
 *
 * 一份新會話第一次寫入時，斷電或行程被殺只會有兩種結果：整份都在，或整份都不在——不會留下空的或半份的 header，
 * 讓這條 thread 之後每次打開都回「建不起來」：
 *
 * - 逐層 `mkdir`，每建一層就 `fsync` 它的父目錄；**每次物化都 fsync，不看目錄本來在不在**（別的會話剛建、還沒
 *   fsync 完的目錄，看到它在就跳過的話會漏掉）。
 * - header 行加第一批事件先寫成暫存檔（`<final>.<12 hex>.tmp`，`wx`、`0600`）、`fsync`，再用 **`link` 發佈，不用 `rename`**：
 *   目標已存在時 `link` 回 `EEXIST`，兩個行程同時物化同一個 id 不會互相覆蓋（`rename` 會靜靜蓋掉）；
 *   發佈後 `fsync` 會話目錄，新目錄項才算斷電後還在；暫存檔盡力刪掉，刪不掉不讓這次寫入失敗。
 * - **目錄 `fsync` 的錯往外拋，不吞**（dsh `syncDirPosix`）。`plugin-journal.ts` 那支不分平台吞掉所有錯，不能拿來用：
 *   一次 `EIO` 會悄悄關掉目錄 `fsync`。
 * - `link` 之前失敗就整個收回：握著租約刪鎖檔、放租約、會話目錄是空的就刪掉，同一個 id 建得回來。
 * - 發佈是**可重試、不撞上自己**的：`link` 一成功就記下已發佈的事件數，之後的重試只補做目錄 `fsync` 與墓碑。
 *   跟租約的 `??=` 同一個理由。
 * - 發佈之後在舊路徑寫墓碑（下一節）。
 *
 * 偏離，登記：
 *
 * 1. **Windows：照樣 `link` 發佈，不做目錄 `fsync`**（理由 1，基座表達不出來）：Node 在 Windows 上開不了目錄，
 *    也沒有 dsh 用來呼叫 `MoveFileExW` 的 FFI。判斷依據是 `process.platform === 'win32'`，**不是吞錯**；
 *    比照 `session-lease.ts` 已登記的 Windows 偏離。
 * 2. 不清當機後殘留的 `*.tmp`。殘留檔不會被讀方撿到：從目錄項認會話的只認 `@nexus/core` 的
 *    `parseLegacyTwoFileHeaderFilename` 與 `parseGenerationLogFilename` 認得的名字，照 id 找的由 id 算名字；
 *    `<base>.header.json.<hex>.tmp` 與世代目錄裡的 `session.v<N>.jsonl.<hex>.tmp` 都不認。
 *
 * ## 遷移與墓碑（[#1594](https://github.com/DemianLi/nexus-agent/issues/1594) ③）
 *
 * - **續接時遷移，唯讀不遷**：續接舊兩檔、或比這一版舊的世代，先遷成這一版的世代檔再交把手（{@link migrateToCurrentGeneration}）。
 *   來源的已接受前綴**原樣複製**、讀回來比位元組數
 *   與雜湊、照這一版解析，來源沒變才 `link` 發佈。失敗時來源不動。唯讀打開（`list`、`open(id, 'read')`）照讀舊的，不發佈。
 * - **墓碑**：舊路徑的 `<base>.header.json` 換成這一版的 header 行（版本 52 起，{@link tombstoneOf}）。v0.5.19 讀到它會報「比這一版
 *   新」而拒讀，不會把舊兩檔當成還在、往裡面續寫（退版的後果見 `@nexus/core` 的 `session-store.ts` 檔頭 ## 52）。新建的會話也寫一份，
 *   同一個理由。
 * - **遷移當下當掉**：新世代發佈了、墓碑還沒寫。新世代的 header 行記著來源（`migratedFrom`），舊日誌跟它對得上就讀新世代，
 *   下一次寫打開補墓碑；對不上（遷移之後舊兩檔又被寫過）就當成兩份並存、大聲拒讀（{@link locateSession} 的表）。
 *
 * 照 dsh、不算偏離的：Windows 的 `rename` 暫時性錯誤（`EACCES`／`EBUSY`／`EPERM`）有界重試，常數同 `atomic-write:19-44`
 * （20 ms 起、上限 200 ms、8 次），只有墓碑取代舊 header 時用到。Windows 不做目錄 `fsync`，沿用上一節的偏離 1（理由 1）。
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
 * 新建的會話寫每會話目錄的單檔佈局：`<sessionDirectoryName(id)>/session.v<N>.jsonl`（header 在第一行）與 `session.lock`，舊路徑
 * 留墓碑（`<base>.header.json`，`base` 見 {@link safeBaseName}）。讀方另外認 v0.5.19 以前寫的舊兩檔（`<base>.header.json`、
 * `<base>.jsonl`，鎖檔 `<base>.lock`）；同一個目錄裡挑最高世代；同一個 id 兩種佈局並存就大聲拒讀（見 {@link locateSession}）。
 * 檔名只在 `@nexus/core` 的 `session-filename.ts` 定義，跟版本目錄（`@nexus/core` 的 `session-format.ts`）同一個格式層。
 * 讀一份會話都經 `readSite`（[#1857](https://github.com/DemianLi/nexus-agent/issues/1857)），兩個入口：從目錄項認的
 * {@link readSessionEntry}（離線掃描 [#665](https://github.com/DemianLi/nexus-agent/issues/665)、`session-files.fixture.ts`；
 * 列表走同一條 `siteOfEntry` → `readSite`），照 id 找的 {@link readSessionEntryById}（唯讀打開、續接走同一條
 * `locateSession` → `readSite`）。不經過它們、只用到檔名的：
 *
 * - 知道 id、要直接碰檔的煙霧測試、`checkpoint-depth-cold.fixture.ts` 與量測（`measure/thread-list-cli.ts`，寫方）用
 *   {@link sessionPathsIn}，手寫舊兩檔的用 {@link legacyTwoFilePathsIn}；
 * - 發版驗證（`scripts/release/verify-packed-install.ts`）只 import `@nexus/core` 的檔名葉模組：發版腳本不拉整支 store 進來；
 * - 夾具產生器（`scripts/session-format-fixtures/run-directory.ts`）要凍原樣位元組與寫入器記的版號，接縫會把 header 的
 *   `version` 轉譯成這一版（#1856），不是它要的。
 *
 * 別的地方寫這兩個副檔名或 import {@link parseHeader}，`session-files-single-owner.test.ts` 會紅。
 *
 * @see [#172](https://github.com/DemianLi/nexus-agent/issues/172)
 * @module
 */

import {
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  truncate,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createReadStream, readdirSync, statSync } from 'node:fs';
import type { BigIntStats, Dirent } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  assertSessionEventEnvelope,
  classifyStoredFormatVersion,
  FIRST_GENERATION_FORMAT_VERSION,
  generationLogFilename,
  isUnreadableSessionEvent,
  legacyTwoFileSessionFilenames,
  materializeAppendBatch,
  parseGenerationLogFilename,
  parseLegacyTwoFileHeaderFilename,
  SESSION_FORMAT_CATALOG,
  SESSION_LOCK_FILENAME,
  SESSION_LOG_FORMAT_VERSION,
  SessionAlreadyExistsError,
  SessionCorruptionError,
  SessionEventUnsupportedError,
  SessionFormatUnsupportedError,
  SessionHandleClosedError,
  SessionNotFoundError,
  sessionDirectoryName,
  snapshotJsonValue,
} from '@nexus/core';
import type {
  ReadonlyStoredSession,
  ResumedStoredSession,
  SessionEvent,
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
import { mib } from './memory-gauge.js';
import { acquireSessionLease } from './session-lease.js';
import type { LeaseUnavailable, SessionWriteLease, TryLock } from './session-lease.js';
import { processSessionLogBudget } from './session-log-budget.js';
import type { SessionLogBudget, SessionLogReservation } from './session-log-budget.js';
import {
  assertStoredEventData,
  assertStoredHeaderFields,
  assertStoredInheritance,
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
 * 續接一份已存會話時，把手要知道的幾件事。續接一律寫進這一版的世代檔：舊兩檔與比這一版舊的世代，交出把手之前已經遷成
 * 新世代（{@link resumeStoredSession}）。
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
  /** 會話目錄裡 `session.lock` 的租約，讀之前就拿到；這個平台拿不到就是 `undefined`。 */
  readonly lease: SessionWriteLease | undefined;
  /** 這份日誌在位元組額度上佔的那一筆（#2115），關把手時跟租約一起還。 */
  readonly reservation: SessionLogReservation;
  /** 續寫的世代檔。 */
  readonly logPath: string;
}

/**
 * 日誌檔的把手上，這個後端會用到的那幾個動作。測試包住它來製造寫入失敗（見 {@link OpenLogFile}）。
 */
export type LogFileHandle = Pick<
  FileHandle,
  'stat' | 'writeFile' | 'sync' | 'datasync' | 'truncate' | 'close'
>;

/**
 * 開日誌檔。`wx` 是世代檔的暫存檔（新會話的第一次實體化與遷移）、`a` 是續接與失敗後的重開、`r+` 是失敗後的截回。
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
  /** 後端的 `options.warn`（沒給就是 `console.warn` 加前綴）：存放處對營運者講話的那張嘴。 */
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
  /** 會話日誌的位元組額度（#2115，見 {@link JsonlSessionStoreOptions.logBudget}）。 */
  readonly logBudget: SessionLogBudget;
}

/**
 * 冷讀解析快取的一筆：一份日誌在某個 revision 上解析出來的東西。續接要的不只事件，還有 header（決定要不要換版）、
 * `validBytes` 與本文長度（決定要不要截撕裂的尾巴、截到哪）。
 */
interface ColdLog {
  /** 解析時那一份的 revision（{@link siteRevision}）。 */
  readonly revision: string;
  readonly header: StoredSessionHeader;
  readonly storedFormatVersion: number;
  /** 深凍結過、讀方共用的那一份（照 dsh `freezeStoredEvents`，`index.ts:153-180`）。 */
  readonly events: readonly SessionEvent[];
  /** 本文在檔裡從哪個位元組起算：舊兩檔是 0，單檔佈局是 header 行（含換行）的長度。 */
  readonly bodyOffset: number;
  /** 本文裡已接受前綴的位元組數，從 {@link bodyOffset} 起算。 */
  readonly validBytes: number;
  /** 本文的位元組數，不含 header 行。 */
  readonly bodyBytes: number;
}

/** 冷讀解析快取最多留幾份，同 dsh 的 `COLD_LOG_MEMO_MAX_ENTRIES`（`index.ts:67`）。 */
const COLD_LOG_MEMO_MAX_ENTRIES = 2;

/**
 * **冷讀解析快取**（[#1559](https://github.com/DemianLi/nexus-agent/issues/1559) N0625），照 dsh 的 `coldLogMemo`
 * （`session-persistence-jsonl/src/index.ts:312`、`:615-649`、`:752`、`:799-810`、`:868-880`，`687f282e`）。
 *
 * 冷復活先唯讀打開檢查一次（`background-cold.ts` 的 inspect），緊接著續接又讀一次：同一份日誌整份解析兩次。
 * 這裡記住最近兩份的解析結果，**鍵是 id，守衛是那一份的 revision**（{@link siteRevision}）：舊兩檔是 header 與日誌兩個檔的
 * {@link fileRevision}（#1509 穩定讀的那組身分），單檔佈局是**先挑世代、再取那個世代檔**的世代版本與 revision：別的行程
 * 發佈新世代時舊世代檔一個位元組都沒變，不先重挑世代、只比舊檔的 revision 會命中舊內容。對不上就當沒有、照常讀。
 * 別的行程寫進去，revision 就變了；本後端自己寫的，寫之前先刪掉那一筆
 * （同 dsh `:752`）。只存預設讀法（`recoverable`）的結果，`salvage` 撿回來的不存——續接不走撿回，存了會讓一份該拒的
 * 檔靜靜續接成功（同 dsh `:860-868` 只存驗過的）。
 *
 * 不是持久投影快取（#725 的決定照舊）：行程內、最多兩份。常駐記憶體因此最多多出兩份日誌的大小（#1490 量測時要算進去）。
 */
class ColdLogMemo {
  readonly #entries = new Map<string, ColdLog>();

  /**
   * @returns revision 對得上的那一筆（並把它移到最新）；對不上的順手刪掉。
   */
  get(id: string, revision: string): ColdLog | undefined {
    const memoized = this.#entries.get(id);
    if (memoized === undefined) return undefined;
    this.#entries.delete(id);
    if (memoized.revision !== revision) return undefined;
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

/** 新會話第一次實體化的進度（見 {@link JsonlStoredSession} 的 `#publish`）。 */
interface PublishProgress {
  /** 世代檔 `link` 成功了，裡面有這麼多顆事件（跟 header 行一起發佈的首批）。重送的那批不再寫它們。 */
  linkedEvents?: number;
  /** 已發佈、還沒刪的暫存檔：會話目錄 `fsync` 之後才刪。 */
  temp?: string;
  /** 發佈之後的會話目錄 `fsync` 做完了。 */
  directorySynced?: true;
  /** 舊路徑的墓碑落定了（含目錄 `fsync`）。 */
  tombstoned?: true;
}

/**
 * 暫存檔：`open(wx)` → 依序寫滿每一段 → `fsync` → 關。失敗就關掉、刪暫存檔再拋；關也失敗的話兩個錯都報（`AggregateError`）。照 dsh `writeSyncedTempFile`（`index.ts:1359-1369`）。
 * 分段寫是給遷移的：header 行跟搬過來的前綴分開寫，不先拼成一份完整的 Buffer。
 *
 * @param openFile - 世代檔的暫存檔傳 {@link LeaseContext.openLog}，測試才換得到它的把手。
 * @returns 暫存檔的路徑。
 */
async function writeSyncedTemp(
  finalPath: string,
  content: string | readonly (string | Uint8Array)[],
  openFile: OpenLogFile = open,
): Promise<string> {
  const temp = `${finalPath}.${randomBytes(6).toString('hex')}.tmp`;
  let handle: LogFileHandle | undefined;
  try {
    handle = await openFile(temp, 'wx', FILE_MODE);
    for (const chunk of typeof content === 'string' ? [content] : content) {
      await handle.writeFile(chunk, 'utf8');
    }
    await handle.sync();
    const done = handle;
    handle = undefined;
    await done.close();
  } catch (error: unknown) {
    const failures: unknown[] = [];
    const opened = handle;
    if (opened !== undefined) await attempt(failures, () => opened.close());
    await rm(temp, { force: true }).catch(() => undefined);
    if (failures.length > 0) {
      throw new AggregateError([error, ...failures], `寫 ${temp} 失敗，關掉它也失敗了`);
    }
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

/** 跑一步；拋錯就收進 `failures`，不往外拋——收尾與撤銷要每一步都走到，全走完才報。 */
async function attempt(failures: unknown[], step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch (error: unknown) {
    failures.push(error);
  }
}

/** 刪掉一個空目錄；不在或不是空的就不動（會話目錄裡有別的東西時那不是這一次留下的）。 */
async function removeEmptyDirectory(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error: unknown) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
  }
}

/** 撞上已經在的目標（`link`、`wx`）。 */
function isAlreadyExists(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'EEXIST';
}

/** 一批事件寫成日誌的行：一行一顆、每行以換行收尾。 */
function eventLines(events: readonly SessionEvent[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join('');
}

/**
 * 從舊兩檔遷過來的世代，header 行記下來源（#1594 ③）：遷移在 `link` 新世代與寫墓碑之間當掉時，讀方靠它分辨
 * 「舊兩檔還是遷移當下那一份」（讀新世代）跟「遷移之後舊兩檔又被寫過」（大聲拒讀）。
 */
export interface JsonlMigrationSource {
  /** 來源日誌（`<base>.jsonl`）當時整個檔的位元組數；只有 header、沒有日誌的是 0。 */
  readonly bytes: number;
  /** 其中已接受的前綴有幾個位元組：搬進新世代的就是這一段。 */
  readonly acceptedBytes: number;
  /** 那段前綴的 SHA-256，小寫十六進位。 */
  readonly sha256: string;
}

/**
 * 世代檔的第一行：`type: 'session'` 加上
 * header 各格。跟邏輯 header（{@link StoredSessionHeader}）分開：`type` 與 {@link migratedFrom} 只在這一行，讀的時候拿掉
 * （{@link parseHeader} 的 `line`）。舊路徑的墓碑也是這個形狀（沒有 `migratedFrom`）。
 */
export interface JsonlHeaderLine extends StoredSessionHeader {
  readonly type: 'session';
  /** 從舊兩檔遷過來的才有，見 {@link JsonlMigrationSource}。 */
  readonly migratedFrom?: JsonlMigrationSource;
}

/** header 行（含換行）。`type` 排第一格，其餘照 header 的鍵序。 */
function encodeHeaderLine(
  header: StoredSessionHeader,
  migratedFrom?: JsonlMigrationSource,
): string {
  const line: JsonlHeaderLine = {
    type: 'session',
    ...header,
    ...(migratedFrom !== undefined && { migratedFrom }),
  };
  return `${JSON.stringify(line)}\n`;
}

/**
 * 舊路徑那個 header 檔是不是墓碑：版本不小於 {@link FIRST_GENERATION_FORMAT_VERSION}（#1594）。
 * 舊兩檔的寫方寫不出這種版本。只看 `version` 與 `id`，不走 {@link parseHeader} 的白名單：墓碑是給退回去的舊版本讀的，這一版只要它
 * 指的是哪一份。
 *
 * @returns 墓碑記的 id；不是 JSON、不是物件、版本不到門檻的都是 `undefined`（交給 {@link parseHeader} 當舊兩檔讀）。
 * @throws {@link SessionCorruptionError} 版本到了門檻、`id` 卻不是字串。
 */
function tombstoneOf(text: string): { readonly id: string } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const { version, id } = value;
  if (typeof version !== 'number' || !(version >= FIRST_GENERATION_FORMAT_VERSION))
    return undefined;
  if (typeof id !== 'string') {
    throw new SessionCorruptionError('（不明）', `舊路徑的墓碑記的 id 是 ${JSON.stringify(id)}`);
  }
  return { id };
}

/** 一份已存會話。IO 延後到第一次 {@link append} 或 {@link flush}。 */
class JsonlStoredSession implements StoredSession {
  /** 後端的目錄：舊路徑的墓碑在這裡。 */
  readonly #directory: string;
  /** 這份會話的目錄：`<directory>/<sessionDirectoryName(id)>`，世代檔與 `session.lock` 在這裡。 */
  readonly #sessionDirectory: string;
  readonly #header: StoredSessionHeader;
  readonly #resume: ResumePoint | undefined;
  readonly #context: LeaseContext;
  #lease: SessionWriteLease | undefined;
  #handle: LogFileHandle | undefined;
  /**
   * 新會話發佈過、或續接的世代檔截過尾巴了。之後 `#handle` 是 `undefined` 就只有一種意思：追加失敗、把手連同截回一起收掉了，
   * 下一次用 `a` 重開（{@link #materialize}），不是從頭實體化。
   */
  #opened = false;
  /** `append`／`flush`／`close` 的串行鏈：一次只跑一個，前一個失敗不擋後一個。 */
  #tail: Promise<void> = Promise.resolve();
  #closing: Promise<void> | undefined;
  /** 已存的 next-seq。下一批的第一顆必須等於它。 */
  #nextSeq: number;
  /**
   * 新會話第一次實體化走到哪一步（{@link #publishFresh}）。每一步成功就記下來，失敗後的重試只補沒做完的：
   * `link` 成功但目錄 `fsync` 拋錯時，重試再 `link` 一次會撞上自己的世代檔（`EEXIST`），這個行程從此寫不進這份會話。
   */
  #publish: PublishProgress = {};
  /** 這個把手講過日誌長過額度了沒（{@link #warnIfOverBudget}）。 */
  #overBudgetWarned = false;

  /**
   * @param directory - 後端的目錄（CLI 的 run 目錄，或 serve 的專案目錄）。
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
    this.#sessionDirectory = join(directory, sessionDirectoryName(header.id));
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
      await this.#persist(batch);
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
      // （「一个空的已创建会话在此变得可持久列出」）。發佈的暫存檔寫完就 fsync 過了。
      await this.#materialize([]);
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
    // 新建的關掉之後，這個 id 在這個後端上不再算建過：沒發佈的，同一個 id 可以再 `create`；
    // 發佈過的，磁碟上的檔擋 `create`。
    if (this.#resume === undefined) this.#context.pending.delete(this.#header.id);
    const failures: unknown[] = [];
    const handle = this.#handle;
    this.#handle = undefined;
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
    // 額度跟租約一樣，不論收尾哪一步失敗都還：把手關了，這份的事件不再由它握著。
    this.#resume?.reservation.release();
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
   * 新會話的第一批跟 header 行一起發佈（{@link #publishFresh}）。發佈之後的某一步失敗、協調器重送時，重送的那批從 seq 0
   * 起算、可能比發佈時的長（協調器保留整批，期間又收進來的接在後面）：已經在世代檔裡的那幾顆不再寫，只追加之後的。
   *
   * **寫前大小取檔案現在的大小，不在記憶體裡累計**：續接截尾（{@link #prepareResumed}）會讓記憶體裡的數字對不上檔案。
   */
  async #persist(batch: readonly SessionEvent[]): Promise<void> {
    // 本後端要寫這一份了：冷讀快取那一筆先刪（同 dsh `index.ts:752`）。
    this.#context.coldLogs.delete(this.#header.id);
    const handle = await this.#materialize(batch);
    const published = Math.max(0, (this.#publish.linkedEvents ?? 0) - this.#nextSeq);
    const rest = batch.slice(published);
    if (rest.length === 0) return;
    const { size: before } = await handle.stat();
    const lines = eventLines(rest);
    try {
      await handle.writeFile(lines);
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
    this.#warnIfOverBudget(before + Buffer.byteLength(lines));
  }

  /**
   * 開著的日誌長過額度時講一行（#2215）：只講不擋，每個把手一次；額度還沒算出來就不講。
   * 超過額度的日誌在這個行程續接不回來，所以一個行程裡同一條 thread 只講一次。自動算的額度隨起動基準浮動，這句只能講「以現在的額度」。
   */
  #warnIfOverBudget(logBytes: number): void {
    const limitBytes = this.#context.logBudget.knownLimitBytes;
    if (this.#overBudgetWarned || limitBytes === undefined || logBytes <= limitBytes) return;
    this.#overBudgetWarned = true;
    this.#context.warn(
      `會話 "${this.#header.id}" 的日誌長到 ${mib(logBytes)}，比現在的額度 ${mib(limitBytes)} 大：` +
        '這條 thread 還開著，照常運作；以現在的額度，關掉或被逐出之後重開會被拒收。要保住重開，給行程更多記憶體後重啟，或調高 sessionLogBudgetMiB。',
    );
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
    return (
      this.#resume?.logPath ??
      join(this.#sessionDirectory, generationLogFilename(SESSION_LOG_FORMAT_VERSION))
    );
  }

  /**
   * 第一次真的要寫時才實體化：新會話發佈世代檔（{@link #publishFresh}，`first` 是要跟 header 行一起發佈的首批），續接的截掉
   * 撕裂的尾巴；然後用 `a` 開世代檔。之後直接回同一個 handle；追加失敗收掉把手之後，用 `a` 重開。
   *
   * 呼叫端已經串行（{@link #enqueue}），所以不會同時進來兩次；失敗了下一次重來——協調器靠的正是「失敗保留、下次再送」。
   */
  async #materialize(first: readonly SessionEvent[]): Promise<LogFileHandle> {
    if (this.#handle !== undefined) return this.#handle;
    if (!this.#opened) {
      if (this.#resume === undefined) await this.#publishFresh(first);
      else await this.#prepareResumed(this.#resume);
      this.#opened = true;
    }
    this.#handle = await this.#context.openLog(this.#logPath(), 'a', FILE_MODE);
    return this.#handle;
  }

  /**
   * 新會話的第一次實體化：逐層建目錄、每層 fsync 父目錄
   * （**每次都做，不看它本來在不在**）→ 拿 `session.lock` → header 行加首批事件寫成暫存檔、fsync → **`link` 發佈**（目標已經在就
   * `EEXIST`，換成 `SessionAlreadyExistsError`，不覆寫）→ fsync 會話目錄 → 盡力刪暫存檔。之後在舊路徑寫墓碑
   * （{@link #writeFreshTombstone}）。
   *
   * **`link` 之前失敗就整個收回**（{@link #abandonFresh}），磁碟上不留這份會話的任何東西；`link` 之後的步驟失敗不撤，重試只補沒做完的。
   */
  async #publishFresh(first: readonly SessionEvent[]): Promise<void> {
    const progress = this.#publish;
    if (progress.linkedEvents === undefined) {
      const directory = this.#directory;
      try {
        await mkdir(dirname(directory), { recursive: true, mode: DIR_MODE });
        await syncDirectory(dirname(dirname(directory)));
        await mkdir(directory, { recursive: true, mode: DIR_MODE });
        await syncDirectory(dirname(directory));
        await mkdir(this.#sessionDirectory, { recursive: true, mode: DIR_MODE });
        await syncDirectory(directory);
        // **租約在第一筆實體化寫入之前拿**，照 dsh：一份還沒實體化的會話在檔案系統上沒有足跡。
        this.#lease ??= await leaseFor(
          this.#context,
          join(this.#sessionDirectory, SESSION_LOCK_FILENAME),
          this.#header.id,
        );
      } catch (error: unknown) {
        return this.#abandonFresh(error, true);
      }
      const logPath = this.#logPath();
      let temp: string;
      try {
        temp = await writeSyncedTemp(
          logPath,
          `${encodeHeaderLine(this.#header)}${eventLines(first)}`,
          this.#context.openLog,
        );
      } catch (error: unknown) {
        return this.#abandonFresh(error, true);
      }
      try {
        await link(temp, logPath);
      } catch (error: unknown) {
        await rm(temp, { force: true }).catch(() => undefined);
        // 撞上 `EEXIST`：目錄裡那份是別人的，不碰它的鎖檔與目錄。
        return this.#abandonFresh(this.#collision(error), !isAlreadyExists(error));
      }
      // **`link` 一成功的下一行就記**，不等目錄 fsync：目錄 fsync 拋錯之後重試再 `link`，會撞上自己的世代檔。
      progress.linkedEvents = first.length;
      progress.temp = temp;
    }
    if (progress.directorySynced === undefined) {
      await syncDirectory(this.#sessionDirectory);
      progress.directorySynced = true;
    }
    // 暫存檔在目錄項落盤之後才盡力刪：刪不掉不讓這次寫入失敗（殘留檔讀方不認）。
    if (progress.temp !== undefined) {
      await rm(progress.temp, { force: true }).catch(() => undefined);
      delete progress.temp;
    }
    if (progress.tombstoned === undefined) {
      await this.#writeFreshTombstone();
      progress.tombstoned = true;
    }
  }

  /**
   * 新會話發佈之前就失敗：放租約，`ownFootprint` 時先握著租約刪掉鎖檔、會話目錄是空的就刪掉，再拋原錯。
   * 刪不掉的步驟收進 `AggregateError`（原錯在第一個）。順序的理由：先放再刪的話，別的行程可能在中間鎖到舊 inode、驗過路徑，接著
   * 路徑被我們刪掉，它握著的就是一個沒人看得到的檔；握著刪，後來的人驗 inode 對不上會自己重來（`session-lease.ts`）。
   *
   * @param ownFootprint - 鎖檔與會話目錄是這一次留下的（`link` 撞上別人的世代檔時不是）。
   */
  async #abandonFresh(error: unknown, ownFootprint: boolean): Promise<never> {
    const failures: unknown[] = [];
    if (ownFootprint && this.#lease !== undefined) {
      await attempt(failures, () =>
        rm(join(this.#sessionDirectory, SESSION_LOCK_FILENAME), { force: true }),
      );
    }
    const lease = this.#lease;
    this.#lease = undefined;
    await attempt(failures, async () => lease?.release());
    if (ownFootprint) {
      await attempt(failures, () => removeEmptyDirectory(this.#sessionDirectory));
    }
    if (failures.length > 0) {
      throw new AggregateError(
        [error, ...failures],
        `會話 "${this.#header.id}" 第一次寫入失敗，收回這次實體化也有 ${failures.length} 步失敗：` +
          `${this.#sessionDirectory} 可能還留著 ${SESSION_LOCK_FILENAME}`,
      );
    }
    throw error;
  }

  /** 新會話在舊路徑的墓碑（{@link publishTombstone}）。 */
  async #writeFreshTombstone(): Promise<void> {
    await publishTombstone(this.#directory, this.#header);
  }

  /** 實體化撞上 `EEXIST`：`create` 之後才出現的同名（競態），換成型別化的錯，原錯留在 `cause`。其餘原樣。 */
  #collision(error: unknown): unknown {
    if (!isAlreadyExists(error)) return error;
    return new SessionAlreadyExistsError(this.#header.id, { cause: error });
  }

  /** 續接的世代檔第一次寫之前：有撕裂的尾巴就截掉。遷移過來的世代只複製已接受的前綴，沒有尾巴可截。 */
  async #prepareResumed(resume: ResumePoint): Promise<void> {
    this.#context.coldLogs.delete(this.#header.id);
    if (resume.torn !== undefined) await this.#truncateTornTail(resume.logPath, resume.torn);
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

/**
 * 在舊路徑寫墓碑：`<base>.header.json`，內容是這一版的 header 行（#1594 ③），舊路徑本來**沒有東西**時用。暫存檔加
 * `link`，再 fsync 目錄。撞上 `EEXIST`：那一份是這個 id 的墓碑（例如上一次發佈到一半）就算寫好了；不是的話，世代發佈之後別的行程在
 * 舊路徑建了同一個 id 的舊兩檔，報 `SessionAlreadyExistsError`，世代檔留著，讀方會把兩份當成並存而拒讀。
 */
async function publishTombstone(directory: string, header: StoredSessionHeader): Promise<void> {
  const { id } = header;
  const path = legacyTwoFilePathsIn(directory, id).header;
  const temp = await writeSyncedTemp(path, encodeHeaderLine(header));
  try {
    await link(temp, path);
  } catch (error: unknown) {
    if (!isAlreadyExists(error)) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
    const existing = await readFile(path, 'utf8').catch(() => undefined);
    let tombstone: { readonly id: string } | undefined;
    try {
      tombstone = existing === undefined ? undefined : tombstoneOf(existing);
    } catch {
      tombstone = undefined;
    }
    if (tombstone?.id !== id) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw new SessionAlreadyExistsError(id, { cause: error });
    }
  }
  try {
    await syncDirectory(directory);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

/**
 * 寫打開時把舊路徑落定成墓碑（{@link LegacyPathState}）：`missing` 用 {@link publishTombstone}；`pending`（還是舊兩檔的 header）
 * 原子取代成墓碑，再 fsync 目錄。呼叫方握著舊路徑的 `<base>.lock`：v0.5.19 以前的版本寫舊兩檔時也拿它。
 */
async function settleTombstone(
  directory: string,
  header: StoredSessionHeader,
  state: Exclude<LegacyPathState, 'tombstone'>,
): Promise<void> {
  if (state === 'missing') return publishTombstone(directory, header);
  await replaceSyncedFile(
    legacyTwoFilePathsIn(directory, header.id).header,
    encodeHeaderLine(header),
  );
  await syncDirectory(directory);
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
  /**
   * 讀的是世代檔的 header 行（{@link JsonlHeaderLine}）：52 起要有 `type: 'session'`，`type` 與 `migratedFrom` 讀完拿掉，交出來的
   * `header` 跟舊兩檔的一樣是邏輯 header。舊兩檔的 header 檔不給：它沒有這兩格，有的話白名單照樣拒。
   */
  readonly line?: boolean;
}

/** {@link parseHeader} 交出來的東西。 */
export interface ParsedSessionHeader {
  /** 轉譯成這一版的 header：`version` 一律是 `SESSION_LOG_FORMAT_VERSION`，其餘各格原樣（照 dsh `types.ts:96-100`）。 */
  readonly header: StoredSessionHeader;
  /** 磁碟上那份 header 寫的格式版本。見 `@nexus/core` 的 `ReadonlyStoredSession.storedFormatVersion`。 */
  readonly storedFormatVersion: number;
  /** header 行記的遷移來源（只有 `line`、而且是從舊兩檔遷過來的才有）。 */
  readonly migratedFrom?: JsonlMigrationSource;
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
 * 讀 header 時的精確鍵與型別檢查（`session-format-v1-to-v2/src/codec.ts:40-75`）。開了 `acceptNewer`、而且版本確實
 * 比這一版新的，整支不跑（dsh `format.ts:333-337`：新版的格式不必過這一版的結構檢查）；版本就是這一版的照驗。
 *
 * @throws {@link SessionCorruptionError} 不是 JSON、欄位形狀不對、或 id 對不上。
 */
export function parseHeader(text: string, options: ParseHeaderOptions = {}): ParsedSessionHeader {
  const { id: expected } = options;
  /** 錯誤訊息裡的那個 id：呼叫方給的，沒給就是 header 自己記的。 */
  let id = expected ?? '（不明）';
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SessionCorruptionError(id, 'header 不是 JSON', options.location);
  }
  if (!isRecord(parsed))
    throw new SessionCorruptionError(id, 'header 不是一個物件', options.location);
  if (expected === undefined && typeof parsed['id'] === 'string') id = parsed['id'];
  let value: Record<string, unknown> = parsed;
  let lineType: unknown;
  let migratedFrom: unknown;
  if (options.line === true) {
    ({ type: lineType, migratedFrom, ...value } = parsed);
  }
  const { version } = value;
  /** 比這一版新、又開了 `acceptNewer` 才走得到底的那一種。 */
  let newer = false;
  if (typeof version === 'number' && Number.isSafeInteger(version) && version >= 1) {
    const verdict = classifyStoredFormatVersion(version, options.catalog ?? SESSION_FORMAT_CATALOG);
    newer = verdict === 'newer';
    if (newer && options.acceptNewer !== true) {
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
    throw new SessionCorruptionError(
      id,
      `header 的 version 是 ${JSON.stringify(version)}`,
      options.location,
    );
  }
  if (expected === undefined ? typeof value['id'] !== 'string' : value['id'] !== expected) {
    throw new SessionCorruptionError(
      id,
      `header 記的 id 是 ${JSON.stringify(value['id'])}`,
      options.location,
    );
  }
  if (typeof value['createdAt'] !== 'number') {
    throw new SessionCorruptionError(id, 'header 沒有 createdAt', options.location);
  }
  // 52 起的寫方一定寫 `type`；比 {@link FIRST_GENERATION_FORMAT_VERSION} 舊的世代只會是手寫的，可以沒有這一格，有的話也要是 "session"。
  if (
    options.line === true &&
    !newer &&
    lineType !== 'session' &&
    (lineType !== undefined || version >= FIRST_GENERATION_FORMAT_VERSION)
  ) {
    throw new SessionCorruptionError(
      id,
      `header 行的 type 是 ${JSON.stringify(lineType)}，應該是 "session"`,
      options.location,
    );
  }
  const source =
    migratedFrom === undefined || newer
      ? undefined
      : migrationSourceOf(id, migratedFrom, options.location);
  // 各格的形狀與鍵白名單，與 `create` 共用同一支（#1549）。排在版本判定之後：讀不了的版本照舊報
  // `SessionFormatUnsupportedError`，不會被這裡改判成壞檔。比這一版新的（只有 `acceptNewer` 走得到）整支跳過：
  // 新版的 header 不必過這一版的結構檢查（dsh `format.ts:333-337`）。
  if (!newer) {
    try {
      assertStoredHeaderFields(value);
    } catch (error: unknown) {
      throw new SessionCorruptionError(
        id,
        error instanceof Error ? error.message : String(error),
        options.location,
      );
    }
  }
  const header = {
    ...value,
    version: SESSION_LOG_FORMAT_VERSION,
  } as unknown as StoredSessionHeader;
  return {
    header,
    storedFormatVersion: version,
    ...(source !== undefined && { migratedFrom: source }),
  };
}

const SHA256_HEX = /^[0-9a-f]{64}$/u;

/** header 行的 `migratedFrom`：三格、都是對的形狀，前綴不比整個檔長。 */
function migrationSourceOf(
  id: string,
  value: unknown,
  location: SessionLocation | undefined,
): JsonlMigrationSource {
  const problem = (detail: string): SessionCorruptionError =>
    new SessionCorruptionError(id, `header 行的 migratedFrom ${detail}`, location);
  if (!isRecord(value)) throw problem('不是一個物件');
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'acceptedBytes,bytes,sha256') throw problem(`的鍵是 ${keys.join('、')}`);
  const { bytes, acceptedBytes, sha256 } = value;
  if (!Number.isSafeInteger(bytes) || (bytes as number) < 0) throw problem('的 bytes 不是非負整數');
  if (
    !Number.isSafeInteger(acceptedBytes) ||
    (acceptedBytes as number) < 0 ||
    (acceptedBytes as number) > (bytes as number)
  ) {
    throw problem('的 acceptedBytes 不是 0 到 bytes 之間的整數');
  }
  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) throw problem('的 sha256 不對');
  return { bytes: bytes as number, acceptedBytes: acceptedBytes as number, sha256 };
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
      /**
       * header 的版本比這一版新（`classifyStoredFormatVersion` 判 `newer`）。是的話不驗信封：新版的格式不必過這一版的
       * 結構檢查（dsh `format.ts:333-337`，同 `parseHeader` 那一側）；這一版的檔照驗（#1549 PM 裁決 issuecomment-6354566852）。
       */
      readonly newerFormat: boolean;
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
  /** 本文第一行在檔裡是第幾行，訊息裡的行號照檔算（{@link bodyFirstLine}）。沒給是 1。 */
  readonly firstLine?: number;
};

/** 本文第一行在檔裡是第幾行：世代檔的第 1 行是 header 行，本文從第 2 行起；舊兩檔的日誌整份都是本文。 */
export function bodyFirstLine(layout: SessionEntry['layout']): number {
  return layout === 'generation' ? 2 : 1;
}

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
 * 壞行指：不是 JSON、信封不對（`@nexus/core` 的 `assertSessionEventEnvelope`，與 seed 共用，照 dsh 讀檔器逐行的
 * `decodeEvent`，`session-format-v1-to-v2/src/codec.ts:132-146`，#1549），或 `seq` 不等於已接受的事件數。
 * 離線掃描讀比這一版新的日誌（`newerFormat`）不驗信封、只看像不像一筆事件（`type` 是字串、`time` 是數字的物件）：
 * 新版的信封不必過這一版的結構檢查（同 header 那一側，dsh `format.ts:333-337`）。
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
  let lineNumber = (options.firstLine ?? 1) - 1;
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
    if (problem === undefined && !(options.acceptUnknownEvents === true && options.newerFormat)) {
      // 信封照 dsh 逐行驗（`decodeEvent`，#1549），與 core 的 seed 共用同一支；不過就是壞行，照下面的 strict／recoverable 處理。
      // `seq` 的形狀不在這裡驗，交給下面的 `seq === events.length`（同 dsh 讀檔器）。
      try {
        assertSessionEventEnvelope(value, `第 ${lineNumber} 行`, { checkSeq: false });
      } catch (error: unknown) {
        problem = error instanceof Error ? error.message : String(error);
      }
    } else if (problem === undefined && !eventLike) {
      problem = `第 ${lineNumber} 行不是一筆會話事件`;
    }

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
 * 走 {@link readStableSnapshot}（#1509）：先穩定讀、再解碼。
 * 沒給 `vanished`（舊兩檔）：**不在是空的**，只有 header 是「還沒寫第一筆就當了」。給了（世代檔）：不在就拋它給的錯，
 * header 就在那個檔裡，挑定之後它不見了不是空會話。
 */
async function readBody(
  logPath: string,
  fs: StableReadFileSystem = defaultStableReadFs,
  vanished?: () => Error,
): Promise<Buffer> {
  return (await readBodySnapshot(logPath, fs, vanished)).bytes;
}

/**
 * 同 {@link readBody}，另交證明它穩定的那次 `stat` 的身分（格式同 {@link fileRevision}；沒給 `vanished` 時不在就是 `missing`）：冷讀快取
 * 拿它當日誌的 revision，不另外再 `stat` 一次。
 */
async function readBodySnapshot(
  logPath: string,
  fs: StableReadFileSystem,
  vanished?: () => Error,
): Promise<{ readonly bytes: Buffer; readonly identity: string }> {
  try {
    return await readStableSnapshot(logPath, fs);
  } catch (error: unknown) {
    if (!isNotFound(error)) throw error;
    if (vanished !== undefined) throw vanished();
    return { bytes: Buffer.alloc(0), identity: MISSING_REVISION };
  }
}

/** 讀世代檔本文時給的 `vanished`：挑定的世代檔在讀本文之前不見了。 */
function generationVanished(id: string): () => SessionNotFoundError {
  return () => new SessionNotFoundError(id, `會話 "${id}" 挑定的世代檔在讀本文之前不見了`);
}

/** 日誌本文現在有幾個位元組（位元組額度要的，#2115）。不在就是 0；世代檔不在由之後的 {@link readBodySnapshot} 報錯。 */
async function logBytesOf(logPath: string, fs: StableReadFileSystem): Promise<number> {
  try {
    return Number((await fs.stat(logPath)).size);
  } catch (error: unknown) {
    if (isNotFound(error)) return 0;
    throw error;
  }
}

/** {@link readSessionEntry} 的選項。 */
export interface ReadSessionEntryOptions extends ParseHeaderOptions {
  /** 讀舊兩檔的 header 與兩種佈局的本文用的檔案系統。**只給測試換**，同 {@link readStableSnapshot}。 */
  readonly fs?: StableReadFileSystem;
  /** 讀世代檔的第一行時，每讀一塊之前看一次（同列表的 `signal`）。 */
  readonly signal?: AbortSignal;
}

/** 目錄裡的一份會話：header 已經讀過，日誌本文要的時候才讀。 */
export interface SessionEntry {
  /** 會話落在哪一種佈局：`'two-file'`（舊兩檔）或 `'generation'`（每會話目錄裡的世代檔）。 */
  readonly layout: SessionSite['layout'];
  /** 目錄項的名字：舊兩檔是檔名基底（{@link safeBaseName} 算出來的），單檔佈局是會話目錄名（`sessionDirectoryName`）。 */
  readonly name: string;
  /**
   * 日誌的路徑：舊兩檔是 `<base>.jsonl`，單檔佈局是挑中的世代檔（header 在它的第一行）。舊兩檔的日誌不一定在：
   * 只有 header 是「還沒寫第一筆就當了」。
   */
  readonly logPath: string;
  /** 本文在日誌檔裡從哪個位元組起算：舊兩檔是 0，單檔佈局是 header 行（含換行）的位元組數。 */
  readonly bodyOffset: number;
  /** 同 {@link ParsedSessionHeader.header}。 */
  readonly header: StoredSessionHeader;
  /** 同 {@link ParsedSessionHeader.storedFormatVersion}。 */
  readonly storedFormatVersion: number;
  /** 世代檔的 header 行記的遷移來源（{@link JsonlMigrationSource}）；舊兩檔與新建的世代沒有。 */
  readonly migratedFrom?: JsonlMigrationSource;
  /**
   * 日誌本文的原始位元組（單檔佈局不含 header 行），走 {@link readStableSnapshot}。舊兩檔的日誌不在就是空的；單檔佈局挑定的
   * 世代檔不在就拋 `SessionNotFoundError`。
   */
  readBody(): Promise<Buffer>;
}

/**
 * 一份會話在目錄裡落在哪裡。讀方兩種都認；寫方只寫世代檔，續接舊兩檔時遷成世代檔（{@link resumeStoredSession}）：
 *
 * - `two-file`：`<base>.header.json`＋`<base>.jsonl`（v0.5.19 以前寫的佈局，`@nexus/core` 的 `legacyTwoFileSessionFilenames`）。
 *   header 是墓碑（{@link tombstoneOf}）的不算這一種。
 * - `generation`：`<sessionDirectoryName(id)>/session.v<N>.jsonl`，每會話目錄的單檔佈局，header 在第一行（版本 0 的檔名是
 *   `session.jsonl`）；同一個目錄裡有幾個世代就挑最高的（{@link resolveGeneration}）。照 id 找的（{@link locateSession}）另外記
 *   舊路徑的樣子（{@link LegacyPathState}），寫打開時靠它決定要不要補墓碑。
 */
type SessionSite =
  | {
      readonly layout: 'two-file';
      readonly name: string;
      readonly headerPath: string;
      readonly logPath: string;
    }
  | {
      readonly layout: 'generation';
      readonly name: string;
      readonly logPath: string;
      readonly version: number;
      /** 只有 {@link locateSession} 給。 */
      readonly legacy?: LegacyPathState;
    };

/**
 * 有世代檔時，同一個 id 的舊路徑（`<base>.header.json`）是什麼樣子：
 *
 * - `tombstone`：墓碑，正常的樣子。
 * - `missing`：什麼都沒有。新建的在世代檔發佈之後、墓碑寫好之前當掉，或是手寫的世代。
 * - `pending`：還是舊兩檔的 header，而且世代的 `migratedFrom` 對得上舊日誌（{@link migrationMatches}）：遷移在發佈新世代與
 *   寫墓碑之間當掉。讀新世代。
 *
 * 後兩種在下一次寫打開時補上墓碑（{@link settleTombstone}）。
 */
type LegacyPathState = 'tombstone' | 'missing' | 'pending';

type TwoFileSite = Extract<SessionSite, { readonly layout: 'two-file' }>;

/** {@link readSessionEntry} 認得的目錄項：`readdir(..., { withFileTypes: true })` 交出來的那種。 */
export type SessionDirent = Pick<Dirent, 'name' | 'isDirectory'>;

/**
 * 探單檔佈局的路徑時，哪幾種錯算「不在」：`ENOENT`；`ENAMETOOLONG`（`sessionDirectoryName` 截短後不超過單段上限，但上層目錄
 * 長到整條路徑超限時，那份會話不可能落在單檔佈局）；`ENOTDIR`（同名的是個檔）。其餘的錯照拋。
 */
function isAbsentPath(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENAMETOOLONG' || code === 'ENOTDIR';
}

/**
 * 目錄項裡數字最大的正規世代檔。只認一般檔：同名的目錄不算世代。**跟旁邊舊兩檔的日誌同名的不算**：id 是空字串、`session`、
 * `session.v3` 這類的舊兩檔會話，日誌就叫 `session.jsonl`、`session.v3.jsonl`；同一層有它的 `.header.json` 時，那個檔是舊兩檔
 * 會話的日誌，不是世代。
 */
function latestGenerationIn(
  entries: readonly Dirent[],
): { readonly name: string; readonly version: number } | undefined {
  const legacyLogs = new Set<string>();
  for (const entry of entries) {
    const base = entry.isDirectory() ? undefined : parseLegacyTwoFileHeaderFilename(entry.name);
    if (base !== undefined) legacyLogs.add(legacyTwoFileSessionFilenames(base).log);
  }
  let latest: { readonly name: string; readonly version: number } | undefined;
  for (const entry of entries) {
    if (!entry.isFile() || legacyLogs.has(entry.name)) continue;
    const version = parseGenerationLogFilename(entry.name);
    if (version !== undefined && (latest === undefined || version > latest.version)) {
      latest = { name: entry.name, version };
    }
  }
  return latest;
}

/**
 * 一個會話目錄裡數字最大的正規世代（{@link latestGenerationIn}）。**最高世代比讀方新也照樣挑它**，不退回次高的：讀不讀得了交給
 * {@link parseHeader} 判（太新就拒讀）。
 *
 * @returns 目錄不在（見 {@link isAbsentPath}）或裡面沒有正規的世代檔，就是 `undefined`。
 */
async function resolveGeneration(
  sessionDirectory: string,
): Promise<{ readonly logPath: string; readonly version: number } | undefined> {
  let entries: Dirent[];
  try {
    entries = await readdir(sessionDirectory, { withFileTypes: true });
  } catch (error: unknown) {
    if (isAbsentPath(error)) return undefined;
    throw error;
  }
  const latest = latestGenerationIn(entries);
  return latest && { logPath: join(sessionDirectory, latest.name), version: latest.version };
}

/** {@link resolveGeneration} 的同步版，只回「有沒有正規的世代檔」：`create` 的撞名檢查用（見 {@link existsOnDisk}）。 */
function hasGenerationSync(sessionDirectory: string): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(sessionDirectory, { withFileTypes: true });
  } catch (error: unknown) {
    if (isAbsentPath(error)) return false;
    throw error;
  }
  return latestGenerationIn(entries) !== undefined;
}

const FIRST_LINE_CHUNK_BYTES = 8192;

/**
 * 讀檔案的第一個完整行（不含換行）：一塊 {@link FIRST_LINE_CHUNK_BYTES} 地讀，讀到換行所在那一塊就停；第一行一直沒有換行
 * 就讀到檔尾才回 `undefined`。每讀一塊之前看一次 `signal`：沒有換行的大檔要讀到檔尾，取消的列舉不等它讀完。
 *
 * @returns 第一行的原始位元組；空檔或第一行沒有換行就是 `undefined`。
 */
async function readFirstLine(path: string, signal?: AbortSignal): Promise<Buffer | undefined> {
  const handle = await open(path, 'r');
  try {
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(FIRST_LINE_CHUNK_BYTES);
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) return undefined;
      const slice = buffer.subarray(0, bytesRead);
      const newline = slice.indexOf(0x0a);
      if (newline !== -1) {
        chunks.push(slice.subarray(0, newline));
        return Buffer.concat(chunks);
      }
      chunks.push(Buffer.from(slice));
    }
  } finally {
    await handle.close();
  }
}

/**
 * 由一個目錄項認出它是不是一份會話、落在哪種佈局。不是就是 `undefined`。目錄看裡面有沒有世代檔；其餘（一般檔與符號連結）
 * 看名字是不是舊兩檔的 header，符號連結照舊跟著讀。
 */
async function siteOfEntry(
  directory: string,
  entry: SessionDirent,
): Promise<SessionSite | undefined> {
  if (!entry.isDirectory()) {
    const base = parseLegacyTwoFileHeaderFilename(entry.name);
    return base === undefined ? undefined : twoFileSite(directory, base);
  }
  const generation = await resolveGeneration(join(directory, entry.name));
  return generation && { layout: 'generation', name: entry.name, ...generation };
}

function twoFileSite(directory: string, base: string): TwoFileSite {
  const names = legacyTwoFileSessionFilenames(base);
  return {
    layout: 'two-file',
    name: base,
    headerPath: join(directory, names.header),
    logPath: join(directory, names.log),
  };
}

/**
 * 照 id 找一份會話，兩種佈局都看（open、續接、夾具用）。舊路徑讀 header 的內容，分得出舊兩檔與墓碑；單檔佈局看會話目錄裡有沒有
 * 正規的世代檔，**而且它的 header 行記的是這個 id**（{@link ownGeneration}）。
 *
 * | 世代檔 | 舊路徑 | 結果 |
 * | --- | --- | --- |
 * | 有 | 沒有 | 世代，`missing` |
 * | 有 | 墓碑 | 世代，`tombstone` |
 * | 有 | 舊兩檔，`migratedFrom` 對得上 | 世代，`pending`（遷移當下當掉） |
 * | 有 | 舊兩檔，對不上 | 並存，拋 |
 * | 沒有 | 墓碑 | 會話目錄不見了，拋 |
 * | 沒有 | 舊兩檔 | 舊兩檔 |
 *
 * @returns 兩種都沒有就是 `undefined`。
 * @throws {@link SessionCorruptionError} 兩種佈局並存，或舊路徑是墓碑、會話目錄卻不在。
 */
async function locateSession(
  directory: string,
  id: string,
  fs: StableReadFileSystem,
): Promise<SessionSite | undefined> {
  const twoFile = twoFileSite(directory, safeBaseName(id));
  let legacyText: string | undefined;
  try {
    legacyText = (await fs.readFile(twoFile.headerPath)).toString('utf8');
  } catch (error: unknown) {
    if (!isNotFound(error)) throw error;
  }
  const tombstone = legacyText === undefined ? undefined : tombstoneOf(legacyText);
  const name = sessionDirectoryName(id);
  const generation = await ownGeneration(join(directory, name), id);
  if (generation !== undefined) {
    const { logPath, version } = generation;
    const site = { layout: 'generation', name, logPath, version } as const;
    if (legacyText === undefined) return { ...site, legacy: 'missing' };
    if (tombstone !== undefined) return { ...site, legacy: 'tombstone' };
    if (await migrationMatches(twoFile.logPath, generation.migratedFrom)) {
      return { ...site, legacy: 'pending' };
    }
    throw coexistingLayouts(id, logPath);
  }
  if (tombstone !== undefined) throw orphanTombstone(tombstone.id, twoFile.headerPath);
  return legacyText === undefined ? undefined : twoFile;
}

/**
 * 會話目錄裡挑中的世代（{@link resolveGeneration}），**header 行記的 id 是別人的就當沒有**：`sessionDirectoryName` 截短過，
 * 短 id 可以刻意取成長 id 截短之後的名字，兩份撞進同一個目錄名。header 行讀不出 id（空檔、不是 JSON）的照樣算這個 id 的，
 * 讀不懂交給 {@link readSite} 報。
 *
 * @returns 世代檔，加上它 header 行裡原樣的 `migratedFrom`（沒驗過，{@link migrationMatches} 自己驗）。
 */
async function ownGeneration(
  sessionDirectory: string,
  id: string,
): Promise<
  | { readonly logPath: string; readonly version: number; readonly migratedFrom?: unknown }
  | undefined
> {
  const generation = await resolveGeneration(sessionDirectory);
  if (generation === undefined) return undefined;
  const line = await headerLineOf(generation.logPath);
  let value: unknown;
  try {
    value = line === undefined ? undefined : JSON.parse(line.toString('utf8'));
  } catch {
    return generation;
  }
  if (!isRecord(value)) return generation;
  if (typeof value['id'] === 'string' && value['id'] !== id) return undefined;
  return { ...generation, migratedFrom: value['migratedFrom'] };
}

/**
 * 舊兩檔的日誌是不是還是遷移當下的那一份：整個檔的大小等於 `migratedFrom.bytes`，前 `acceptedBytes` 個位元組的 SHA-256 也對得上。
 * 雜湊串流算，不把日誌讀成一份 Buffer，所以走真的檔案系統（同挑世代與讀世代檔的第一行，見 {@link readSessionEntry}）。
 * `migratedFrom` 不是對的形狀（沒有、新建的世代、手改壞的）就是對不上。
 */
async function migrationMatches(legacyLogPath: string, migratedFrom: unknown): Promise<boolean> {
  let source: JsonlMigrationSource;
  try {
    source = migrationSourceOf('（不明）', migratedFrom, undefined);
  } catch {
    return false;
  }
  let size = 0;
  try {
    size = (await stat(legacyLogPath)).size;
  } catch (error: unknown) {
    if (!isNotFound(error)) throw error;
  }
  if (size !== source.bytes) return false;
  return (await prefixDigest(legacyLogPath, source.acceptedBytes)) === source.sha256;
}

/** 一個檔前 `bytes` 個位元組的 SHA-256（小寫十六進位），串流讀。`bytes` 是 0 就不開檔。 */
async function prefixDigest(path: string, bytes: number): Promise<string> {
  const hash = createHash('sha256');
  if (bytes > 0) {
    for await (const chunk of createReadStream(path, { start: 0, end: bytes - 1 })) {
      hash.update(chunk as Buffer);
    }
  }
  return hash.digest('hex');
}

function coexistingLayouts(id: string, generationPath: string): SessionCorruptionError {
  return new SessionCorruptionError(
    id,
    '同一個 id 同時有舊兩檔與單檔佈局，分不出哪一份才算數，兩份都不讀',
    { kind: 'jsonl', path: resolve(generationPath) },
  );
}

/** 舊路徑是墓碑、會話目錄裡卻沒有世代檔：墓碑指的那一份不見了，不當成沒有這份會話。 */
function orphanTombstone(id: string, tombstonePath: string): SessionCorruptionError {
  return new SessionCorruptionError(
    id,
    `舊路徑是 v${String(FIRST_GENERATION_FORMAT_VERSION)} 起留下的墓碑，會話目錄裡卻沒有世代檔：這份會話的日誌不見了`,
    { kind: 'jsonl', path: resolve(tombstonePath) },
  );
}

/**
 * 世代檔的 header 行（{@link readFirstLine}）。檔不在、空檔、第一行還沒換行都是 `undefined`：當成不在，不算讀不懂。
 */
async function headerLineOf(logPath: string, signal?: AbortSignal): Promise<Buffer | undefined> {
  try {
    return await readFirstLine(logPath, signal);
  } catch (error: unknown) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/**
 * 一份會話此刻的 revision：舊兩檔是 header 與日誌兩個檔的 {@link fileRevision}（續接換版會取代 header，只算日誌看不出來）；
 * 單檔佈局是挑中的世代版本加那個檔的 revision。呼叫方要先重新挑世代再算：新世代發佈時舊世代檔不變，只算舊檔會命中舊內容。
 */
async function siteRevision(site: SessionSite, fs: StableReadFileSystem): Promise<string> {
  return composeRevision(
    site,
    await headerRevisionOf(site, fs),
    await fileRevision(site.logPath, fs),
  );
}

/** 舊兩檔的 header 檔的 {@link fileRevision}；單檔佈局的 header 在世代檔裡，沒有另一個檔，是 `undefined`。 */
async function headerRevisionOf(
  site: SessionSite,
  fs: StableReadFileSystem,
): Promise<string | undefined> {
  return site.layout === 'two-file' ? fileRevision(site.headerPath, fs) : undefined;
}

/** 由已經取好的兩段拼出 {@link siteRevision}：冷讀快取拿穩定讀那次的身分當日誌的 revision，不另外再 `stat`。 */
function composeRevision(
  site: SessionSite,
  headerRevision: string | undefined,
  logRevision: string,
): string {
  return site.layout === 'two-file'
    ? `${String(headerRevision)}|${logRevision}`
    : `v${String(site.version)}|${logRevision}`;
}

/** 讀一份已經定位好的會話。header 在讀目錄與讀檔之間不見了（或世代檔的第一行還沒寫完）就是 `undefined`。 */
async function readSite(
  site: SessionSite,
  options: ReadSessionEntryOptions,
): Promise<SessionEntry | undefined> {
  const { fs = defaultStableReadFs, signal, ...parseOptions } = options;
  if (site.layout === 'two-file') {
    let text: string;
    try {
      text = (await fs.readFile(site.headerPath)).toString('utf8');
    } catch (error: unknown) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    const tombstone = tombstoneOf(text);
    if (tombstone !== undefined) {
      // 墓碑不是一份會話：會話目錄在就由那一項代表，不在就是孤兒墓碑（{@link orphanTombstone}）。
      const sessionDirectory = join(dirname(site.headerPath), sessionDirectoryName(tombstone.id));
      if ((await resolveGeneration(sessionDirectory)) !== undefined) return undefined;
      throw orphanTombstone(tombstone.id, site.headerPath);
    }
    const { header, storedFormatVersion } = parseHeader(text, parseOptions);
    const { logPath } = site;
    return {
      layout: site.layout,
      name: site.name,
      logPath,
      bodyOffset: 0,
      header,
      storedFormatVersion,
      readBody: () => readBody(logPath, fs),
    };
  }
  const line = await headerLineOf(site.logPath, signal);
  if (line === undefined) return undefined;
  const location = parseOptions.location ?? locate(site);
  const { header, storedFormatVersion, migratedFrom } = parseHeader(line.toString('utf8'), {
    ...parseOptions,
    location,
    line: true,
  });
  if (storedFormatVersion !== site.version) {
    // 算讀不懂：列表跟其餘壞檔一樣計進 unreadable（`session-store.ts` 檔頭），不讓一份拖垮整份清單。
    throw new SessionCorruptionError(
      header.id,
      `世代檔名是 v${String(site.version)}，header 記的是 v${String(storedFormatVersion)}`,
      location,
    );
  }
  const bodyOffset = line.byteLength + 1;
  const { logPath } = site;
  return {
    layout: site.layout,
    name: site.name,
    logPath,
    bodyOffset,
    header,
    storedFormatVersion,
    ...(migratedFrom !== undefined && { migratedFrom }),
    readBody: async () =>
      (await readBody(logPath, fs, generationVanished(header.id))).subarray(bodyOffset),
  };
}

/**
 * **讀一份會話的接縫**（[#1857](https://github.com/DemianLi/nexus-agent/issues/1857)）：給一個目錄項，回 header 與日誌本文。
 * 離線掃描與夾具從目錄項讀一份會話都走這裡（列表走同一條 `siteOfEntry` → `readSite`），誰也不自己讀會話檔。兩種佈局都認
 * （{@link SessionSite}）：目錄看裡面有沒有正規的世代檔，有就挑最高的那個；其餘看是不是舊兩檔的 header。
 *
 * 只管「讀」與「讀不讀得懂」（{@link parseHeader} 拋什麼就拋什麼；世代檔名跟 header 版本對不上另外算讀不懂）。目錄項的名字
 * 對不上 header 記的 id 算不算讀不懂，是列表自己的規則（`open(id)` 照 id 算名字），不在這裡判。
 *
 * @param directory - 會話所在的目錄。
 * @param entry - 目錄裡的一個目錄項。
 * @param options - 同 {@link parseHeader}，另加測試用的檔案系統與 `signal`。檔案系統只管舊兩檔的 header 與兩種佈局的本文，
 *   挑世代與讀世代檔的第一行走真的檔案系統；`signal` 只在讀世代檔的第一行時看。
 * @returns 不是一份會話，header 在讀目錄與讀檔之間不見了，或世代檔是空的、第一行還沒有換行，都是 `undefined`。
 * @throws 同 {@link parseHeader}；{@link SessionCorruptionError} 世代檔名跟 header 版本對不上（單檔佈局的錯都帶
 *   `location`）；`signal` 取消時拋它的 `reason`；其餘檔案系統的錯（例如 `EACCES`）照拋。
 */
export async function readSessionEntry(
  directory: string,
  entry: SessionDirent,
  options: ReadSessionEntryOptions = {},
): Promise<SessionEntry | undefined> {
  const site = await siteOfEntry(directory, entry);
  return site === undefined ? undefined : readSite(site, options);
}

/**
 * 同 {@link readSessionEntry}，照 id 找（兩種佈局都看，見 {@link locateSession}）。給知道 id 的測試支援用。
 *
 * @returns 兩種佈局都沒有這一份就是 `undefined`。
 * @throws {@link SessionCorruptionError} 兩種佈局並存，或 header 記的 id 跟 `id` 對不上；其餘同 {@link readSessionEntry}。
 */
export async function readSessionEntryById(
  directory: string,
  id: string,
  options: ReadSessionEntryOptions = {},
): Promise<SessionEntry | undefined> {
  const site = await locateSession(directory, id, options.fs ?? defaultStableReadFs);
  return site === undefined ? undefined : readSite(site, { id, ...options });
}

/** {@link sessionPathsIn} 交出來的路徑。 */
export interface SessionPaths {
  /** 會話目錄：`<directory>/<sessionDirectoryName(id)>`。 */
  readonly sessionDirectory: string;
  /** 這一版寫的世代檔：`<會話目錄>/session.v<SESSION_LOG_FORMAT_VERSION>.jsonl`，header 在第一行。 */
  readonly log: string;
  /** 寫租約的鎖檔：`<會話目錄>/session.lock`。 */
  readonly lock: string;
  /** 舊路徑上的墓碑：`<base>.header.json`。 */
  readonly tombstone: string;
}

/**
 * 一份會話在 `directory` 裡的路徑（這一版寫的佈局）。給**知道 id、要直接碰檔**的產品路徑外讀寫方（量測、夾具、煙霧測試）：
 * 檔名照 `@nexus/core` 的那一份，目錄名照 `sessionDirectoryName`、墓碑的基底照 {@link safeBaseName}，不自己拼。
 *
 * @param directory - 會話所在的目錄。
 * @param sessionId - session id。
 */
export function sessionPathsIn(directory: string, sessionId: string): SessionPaths {
  const sessionDirectory = join(directory, sessionDirectoryName(sessionId));
  return {
    sessionDirectory,
    log: join(sessionDirectory, generationLogFilename(SESSION_LOG_FORMAT_VERSION)),
    lock: join(sessionDirectory, SESSION_LOCK_FILENAME),
    tombstone: join(directory, legacyTwoFileSessionFilenames(safeBaseName(sessionId)).header),
  };
}

/**
 * 一份會話在舊兩檔佈局（v0.5.19 以前寫的）裡的三個路徑。給要**手寫舊兩檔**的夾具與量測：遷移的來源、退版後舊版本寫的樣子。
 *
 * @param directory - 會話所在的目錄。
 * @param sessionId - session id。
 */
export function legacyTwoFilePathsIn(
  directory: string,
  sessionId: string,
): { readonly header: string; readonly log: string; readonly lock: string } {
  const names = legacyTwoFileSessionFilenames(safeBaseName(sessionId));
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
 * 列 `directory` 裡落了盤的每一份。見 {@link SessionStore.list}。兩種佈局都列（{@link SessionSite}）。
 *
 * `revision` 是 {@link siteRevision}：舊兩檔算 header 與本文兩個檔（續接換版會取代 header，只算本文看不出來），單檔佈局算
 * 挑中的世代檔。
 *
 * 算讀不懂的，除了 header 讀不懂、版本讀不了（含最高世代比這一版新）、世代檔名跟 header 版本對不上之外還有兩種：
 *
 * - **目錄項的名字對不上 header 記的 id**：`open(id)` 照 id 算名字，找不到它。只有手動改過名字才會這樣。
 * - **同一個 id 兩種佈局並存、而且至少一份讀得懂**：判法跟 {@link locateSession} 一樣（{@link otherLayoutEntry}），另一份只看
 *   在不在、不看讀不讀得懂。兩份都不列，合起來算一份讀不懂（`open`／`resume` 碰到同樣的並存會拋）。讀得懂的那份也不列：列出
 *   一項點不開的，等於默默挑了一份。兩份都讀不懂時認不出 id，各算一份。照 `session-store.ts`
 *   檔頭登記的 unreadable 計數，不讓一份拖垮整份清單。
 * - **舊路徑是墓碑、會話目錄卻不在**（{@link orphanTombstone}）。
 *
 * 不算並存、也不重複列的：墓碑（會話目錄那一項代表它）、遷移當下當掉留著的舊兩檔（`migratedFrom` 對得上，讀新世代，同
 * {@link locateSession}）、會話目錄裡記的是別的 id 的世代（那一份照它自己的 id 列）。
 */
async function listStoredSessions(
  directory: string,
  context: LeaseContext,
  options: StoredSessionListOptions = {},
): Promise<StoredSessionListing> {
  const { signal } = options;
  const { catalog, fs } = context;
  signal?.throwIfAborted();
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    if (isNotFound(error)) return { sessions: [], unreadable: 0 };
    throw error;
  }
  // 一份一份讀換成經後端共用的上限讀（#1559 N0627），照 dsh `list`（`index.ts:532`）。每份開始前看一次 signal：
  // 被取消的列舉，排隊中的那幾份輪到時才拋（同 dsh `:297-302`）。
  const outcomes = settledValues(
    await settleLimited(
      context.listLimit,
      entries,
      async (
        dirent,
      ): Promise<
        | { snapshot: StoredSessionSnapshot; coexisting?: string }
        | { unreadable: string }
        | undefined
      > => {
        signal?.throwIfAborted();
        const site = await siteOfEntry(directory, dirent);
        if (site === undefined) return undefined;
        // 先記樣子再讀：兩步之間被改了的話，記下的是舊的，下一次比對時不相等，衍生的快取多讀一次而已。
        const revision = await siteRevision(site, fs);
        let entry: SessionEntry | undefined;
        try {
          entry = await readSite(site, { catalog, fs, signal });
        } catch (error: unknown) {
          if (
            error instanceof SessionCorruptionError ||
            error instanceof SessionFormatUnsupportedError
          ) {
            return { unreadable: dirent.name };
          }
          throw error;
        }
        // 讀目錄與讀檔之間被刪掉：不是壞檔，就是不在了。
        if (entry === undefined) return undefined;
        const { header, storedFormatVersion } = entry;
        if (expectedEntryName(entry.layout, header.id) !== entry.name) {
          return { unreadable: dirent.name };
        }
        const snapshot = { header, storedFormatVersion, revision };
        const other = await otherLayoutEntry(directory, entry, fs);
        // 遷移當下當掉的舊兩檔：由會話目錄那一項代表。
        if (other === 'superseded') return undefined;
        return other === undefined ? { snapshot } : { snapshot, coexisting: other };
      },
    ),
  );
  // 並存的那一對：讀得懂的那份記下另一份的目錄項名字，另一份讀不懂時就不再單獨算。
  const coexistingIds = new Set<string>();
  const coexistingNames = new Set<string>();
  for (const outcome of outcomes) {
    if (outcome !== undefined && 'snapshot' in outcome && outcome.coexisting !== undefined) {
      coexistingIds.add(outcome.snapshot.header.id);
      coexistingNames.add(outcome.coexisting);
    }
  }
  const sessions: StoredSessionSnapshot[] = [];
  let unreadable = coexistingIds.size;
  for (const outcome of outcomes) {
    if (outcome === undefined) continue;
    if ('unreadable' in outcome) {
      if (!coexistingNames.has(outcome.unreadable)) unreadable += 1;
    } else if (outcome.coexisting === undefined) {
      sessions.push(outcome.snapshot);
    }
  }
  return { sessions, unreadable };
}

/** 一份 id 是 `id` 的會話，在某種佈局裡的目錄項該叫什麼。 */
function expectedEntryName(layout: SessionSite['layout'], id: string): string {
  return layout === 'two-file' ? safeBaseName(id) : sessionDirectoryName(id);
}

/**
 * 同一個 id 的另一種佈局跟這一份是什麼關係，判法同 {@link locateSession}：
 *
 * - `undefined`：沒有另一份；或另一份是墓碑；或這一份是世代、舊兩檔是它遷移當下的來源；或會話目錄裡是別的 id 的世代。
 * - `'superseded'`：這一份是遷移當下的來源，讀方讀新世代，這一項不列。
 * - 目錄項名字：並存。回 `readdir` 交出來的那個名字（舊兩檔是 `<base>.header.json`，單檔佈局是會話目錄名），對得上列表裡的
 *   `dirent.name`。
 */
async function otherLayoutEntry(
  directory: string,
  entry: SessionEntry,
  fs: StableReadFileSystem,
): Promise<string | 'superseded' | undefined> {
  const { id } = entry.header;
  if (entry.layout === 'generation') {
    const legacy = twoFileSite(directory, safeBaseName(id));
    let text: string;
    try {
      text = (await fs.readFile(legacy.headerPath)).toString('utf8');
    } catch (error: unknown) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    let tombstone: { readonly id: string } | undefined;
    try {
      tombstone = tombstoneOf(text);
    } catch (error: unknown) {
      if (!(error instanceof SessionCorruptionError)) throw error;
    }
    if (tombstone !== undefined) return undefined;
    if (await migrationMatches(legacy.logPath, entry.migratedFrom)) return undefined;
    return basename(legacy.headerPath);
  }
  const name = sessionDirectoryName(id);
  const generation = await ownGeneration(join(directory, name), id);
  if (generation === undefined) return undefined;
  return (await migrationMatches(entry.logPath, generation.migratedFrom)) ? 'superseded' : name;
}

/**
 * 拒讀診斷用的位置（#1559 N0646），照 dsh 的 `locate()`（`index.ts:345-347`）：日誌檔的絕對路徑，不碰檔案系統。
 */
function locate(site: SessionSite): SessionLocation {
  return { kind: 'jsonl', path: resolve(site.logPath) };
}

/**
 * 解析好的已接受前綴，交出去之前（也是存進冷讀快取之前）的驗證（#1549），續接與唯讀打開共用，順序照 dsh：
 * 讀檔器收尾時的關係驗證（`session-persistence-jsonl/src/format.ts:468`），再逐筆跑單筆資料規則（`index.ts:860` 的
 * `validateStoredEvents`，之後才 `:868` 存快取）。撿回（salvage）不跑：它本來就是在處理壞檔，dsh 沒有這條路。
 * 事件信封不在這裡驗：它在 {@link parseJsonlSessionBody} 逐行驗（壞行照 strict／recoverable 處理，照 dsh `decodeEvent`），
 * core 的 seed（`SessionLog`）再驗一次（dsh 兩層都有）。
 *
 * 分叉前綴（#1579）排第一：關係驗證要用它回的切點，同 dsh 先在 `restoreReleasedV4Artifact` 驗標記、再跑
 * `assertReleasedV4Relationships`（`session-format-v3-to-v4/src/validation.ts:70-79`）。跑在尾端復原之後，理由見 {@link assertStoredInheritance}。
 *
 * @throws {@link SessionCorruptionError} 哪一行、哪一格不對。
 */
function validateStoredLog(
  id: string,
  header: StoredSessionHeader,
  events: readonly SessionEvent[],
): void {
  const cut = assertStoredInheritance(id, header, events);
  assertStoredRelationships(id, events, cut);
  assertStoredEventData(id, events);
}

/** `directory` 裡沒有這一份：兩種佈局都找過了。 */
function notFoundIn(directory: string, id: string): SessionNotFoundError {
  return new SessionNotFoundError(
    id,
    `${directory} 裡沒有會話 "${id}"（找不到舊兩檔的 header，也沒有讀得出 header 的世代檔）。`,
  );
}

/**
 * 唯讀打開 `directory` 裡的那一份。見 {@link SessionStore.open}：**不拿租約、不截尾巴、不動 header**。兩種佈局都認
 * （{@link locateSession}）；打開時挑定的那個世代就是這個把手讀的那一份，別的行程之後發佈的新世代，下一次打開才讀得到。
 */
async function openStoredSessionForRead(
  directory: string,
  id: string,
  context: LeaseContext,
): Promise<ReadonlyStoredSession> {
  const { catalog, fs, coldLogs, logBudget } = context;
  const site = await locateSession(directory, id, fs);
  if (site === undefined) throw notFoundIn(directory, id);
  const location = locate(site);
  // 先記樣子再讀 header（同 list）：中間被換掉的話，存進快取的是舊 revision，之後比對不相等、多讀一次而已。
  const headerRevision = await headerRevisionOf(site, fs);
  const entry = await readSite(site, { id, catalog, fs, location });
  if (entry === undefined) throw notFoundIn(directory, id);
  const { header, storedFormatVersion, logPath, bodyOffset } = entry;
  return {
    header,
    storedFormatVersion,
    async read(options: StoredSessionReadOptions = {}): Promise<readonly SessionEvent[]> {
      if (options.salvage !== true) {
        const memoized = coldLogs.get(id, await siteRevision(site, fs));
        if (memoized !== undefined) return memoized.events;
      }
      // 讀之前先佔額度（#2115），解析完就還：放不下的連 `readFile` 都不做。量的是實際要讀的那個檔（單檔佈局含 header 行）。
      const reservation = await logBudget.reserveForRead(id, await logBytesOf(logPath, fs));
      const { bytes, identity } = await readBodySnapshot(
        logPath,
        fs,
        site.layout === 'generation' ? generationVanished(id) : undefined,
      ).catch((error: unknown) => {
        reservation.release();
        throw error;
      });
      const body = bytes.subarray(bodyOffset);
      try {
        // 開了 salvage 的先走 strict、失敗才撿回：salvage 的語意（已登記的偏離）維持今天的樣子，不被 recoverable 搶先丟掉。
        const { events, validBytes } = parseJsonlSessionBody(id, body, {
          version: storedFormatVersion,
          recovery: options.salvage === true ? 'strict' : 'recoverable',
          location,
          firstLine: bodyFirstLine(site.layout),
        });
        if (options.salvage === true) return events;
        validateStoredLog(id, header, events);
        const frozen = freezeStoredEvents(events);
        coldLogs.set(id, {
          revision: composeRevision(site, headerRevision, identity),
          header,
          storedFormatVersion,
          events: frozen,
          bodyOffset,
          validBytes,
          bodyBytes: body.byteLength,
        });
        return frozen;
      } catch (error: unknown) {
        if (options.salvage === true && error instanceof SessionCorruptionError) {
          return salvageJsonlSessionBody(id, body, storedFormatVersion, location);
        }
        throw error;
      } finally {
        reservation.release();
      }
    },
  };
}

/**
 * 續接 `directory` 裡的那一份。見 {@link SessionStore.resume}。兩種佈局都認（{@link locateSession}）。
 *
 * **只有 header、沒有日誌不是壞檔**：v0.5.19 以前的版本先發佈 header 再開日誌，兩步之間當掉就是這個樣子——一份一筆都還沒寫進去
 * 的會話。
 *
 * **寫打開時先遷移，再交把手**（#1594 ③）：舊兩檔、比這一版舊的世代，都先遷成這一版的世代檔
 * （{@link migrateToCurrentGeneration}），把手往新世代追加。已經是這一版的世代往它追加，撕裂的尾巴從 header 行之後起算、截到
 * `bodyOffset + validBytes`。舊路徑不是墓碑的（遷移的來源、`missing`、`pending`）在交把手之前落定成墓碑（{@link settleTombstone}）。
 *
 * **租約**：會話目錄裡的 `session.lock` 一定拿，握到把手關掉；要動舊路徑的另外先拿舊路徑的 `<base>.lock`（v0.5.19 以前的版本
 * 寫舊兩檔時拿的那一把，擋住同時跑的舊版本），交把手之前就放。順序固定是舊的先、新的後。
 */
async function resumeStoredSession(
  directory: string,
  id: string,
  context: LeaseContext,
): Promise<ResumedStoredSession> {
  // **先認得有這份，再拿租約**：打錯的 `--resume` 不該留下一個鎖檔。單檔佈局要讀得到 header 行才算有，同 readSite。
  const found = await locateSession(directory, id, context.fs);
  if (
    found === undefined ||
    (found.layout === 'generation' && (await headerLineOf(found.logPath)) === undefined)
  ) {
    throw notFoundIn(directory, id);
  }
  // 拿鎖之前看到的樣子不必動舊路徑、拿到之後卻要動（別的行程在中間改了它）：放掉，連舊路徑的鎖一起重來一次。
  let legacyLock = touchesLegacyPath(found);
  for (;;) {
    const resumed = await resumeLocked(directory, id, context, legacyLock);
    if (resumed !== undefined) return resumed;
    legacyLock = true;
  }
}

/** 續接這一份要不要動舊路徑：遷移舊兩檔，或補墓碑。 */
function touchesLegacyPath(site: SessionSite): boolean {
  return site.layout === 'two-file' || site.legacy !== 'tombstone';
}

/**
 * 拿好租約之後的續接（見 {@link resumeStoredSession}）。
 *
 * @param legacyLock - 要不要先拿舊路徑的 `<base>.lock`。
 * @returns 沒拿舊路徑的鎖、拿到租約之後卻發現要動舊路徑，就是 `undefined`（租約都已放掉）。
 */
async function resumeLocked(
  directory: string,
  id: string,
  context: LeaseContext,
  legacyLock: boolean,
): Promise<ResumedStoredSession | undefined> {
  const { fs } = context;
  const sessionDirectory = join(directory, sessionDirectoryName(id));
  let legacyLease: SessionWriteLease | undefined;
  let sessionLease: SessionWriteLease | undefined;
  let reservation: SessionLogReservation | undefined;
  /** 會話目錄是這一次建的（遷移的來源是舊兩檔）：沒發佈成就整個收回，不留半份目錄。 */
  let createdDirectory = false;
  let resumed: ResumedStoredSession | undefined;
  let failure: { readonly error: unknown } | undefined;
  try {
    // **在讀之前拿**，照 dsh：別人握著的話，該在什麼都還沒讀之前就講。
    if (legacyLock) {
      legacyLease = await leaseFor(context, legacyTwoFilePathsIn(directory, id).lock, id);
    }
    createdDirectory =
      (await mkdir(sessionDirectory, { recursive: true, mode: DIR_MODE })) !== undefined;
    if (createdDirectory) await syncDirectory(directory);
    sessionLease = await leaseFor(context, join(sessionDirectory, SESSION_LOCK_FILENAME), id);
    // 拿到租約之後再找一次：前後之間別的行程可能發佈了新世代、遷移完、或寫了墓碑，要讀、要續寫的是這之後的那一份。
    const site = await locateSession(directory, id, fs);
    if (site === undefined) throw notFoundIn(directory, id);
    if (legacyLock || !touchesLegacyPath(site)) {
      resumed = await resumeSite(directory, id, site, context, sessionLease, (held) => {
        reservation = held;
      });
    }
  } catch (error: unknown) {
    failure = { error };
  }
  if (resumed !== undefined) {
    // 把手握著 `session.lock` 與額度；舊路徑的鎖到這裡就用完了。
    await legacyLease?.release();
    return resumed;
  }
  const failures: unknown[] = [];
  reservation?.release();
  if (createdDirectory && sessionLease !== undefined) {
    // 握著租約刪鎖檔、再放、再刪空目錄，理由同 `JsonlStoredSession` 的 `#abandonFresh`。
    await attempt(failures, async () => {
      if ((await resolveGeneration(sessionDirectory)) === undefined) {
        await rm(join(sessionDirectory, SESSION_LOCK_FILENAME), { force: true });
      }
    });
  }
  await attempt(failures, async () => sessionLease?.release());
  if (createdDirectory) await attempt(failures, () => removeEmptyDirectory(sessionDirectory));
  await attempt(failures, async () => legacyLease?.release());
  if (failure === undefined) {
    if (failures.length > 0) {
      throw new AggregateError(failures, `會話 "${id}" 放掉租約重來時有 ${failures.length} 步失敗`);
    }
    return undefined;
  }
  if (failures.length > 0) {
    throw new AggregateError(
      [failure.error, ...failures],
      `會話 "${id}" 續接失敗，收尾也有 ${failures.length} 步失敗`,
    );
  }
  throw failure.error;
}

/**
 * 讀（必要時遷移）一份已經在租約底下定位好的會話，交出把手。額度一佔到就交給 `held`，失敗時由呼叫方還。
 */
async function resumeSite(
  directory: string,
  id: string,
  site: SessionSite,
  context: LeaseContext,
  lease: SessionWriteLease | undefined,
  held: (reservation: SessionLogReservation) => void,
): Promise<ResumedStoredSession> {
  const { catalog, fs, coldLogs } = context;
  const location = locate(site);
  // **位元組額度（#2115）在讀之前佔**：只是唯讀佔著就等它們讀完；開著的 thread 佔的加上這一份放不下就拋，一個位元組
  // 都不讀。冷讀快取命中也佔——事件同樣要握在記憶體裡，佔到把手關掉為止。量的是實際要讀的那個檔。遷移的峰值也在這裡面：
  // 驗證時讀回來的暫存檔與它解析出的事件，取代第一次讀的那一份，不同時握著兩份。
  const reservation = await context.logBudget.holdForSession(
    id,
    await logBytesOf(site.logPath, fs),
  );
  held(reservation);
  if (site.layout === 'two-file' || site.version < SESSION_LOG_FORMAT_VERSION) {
    const migrated = await migrateToCurrentGeneration(directory, id, site, context, location);
    // 從舊兩檔遷的：舊 header 換成墓碑。從舊世代遷的：舊路徑照它原本的樣子落定。
    const legacy = site.layout === 'two-file' ? 'pending' : (site.legacy ?? 'tombstone');
    if (legacy !== 'tombstone') await settleTombstone(directory, migrated.header, legacy);
    return {
      header: migrated.header,
      storedFormatVersion: migrated.storedFormatVersion,
      events: migrated.events,
      stored: new JsonlStoredSession(directory, migrated.header, context, {
        nextSeq: migrated.events.length,
        lease,
        reservation,
        logPath: migrated.logPath,
      }),
    };
  }
  // 冷讀快取（#1559）：**租約拿到之後**才比 revision——比對之後到第一次寫之前，別人寫不進來。
  // 對上了就省掉 readFile 與解析；對不上照常讀。
  const memoized = coldLogs.get(id, await siteRevision(site, fs));
  let read: Omit<ColdLog, 'revision'>;
  if (memoized !== undefined) {
    read = memoized;
  } else {
    const entry = await readSite(site, { id, catalog, fs, location });
    if (entry === undefined) throw notFoundIn(directory, id);
    const { header, storedFormatVersion, bodyOffset } = entry;
    const body = await entry.readBody();
    const { events, validBytes } = parseJsonlSessionBody(id, body, {
      version: storedFormatVersion,
      recovery: 'recoverable',
      location,
      firstLine: bodyFirstLine(entry.layout),
    });
    validateStoredLog(id, header, events);
    read = {
      header,
      storedFormatVersion,
      events,
      bodyOffset,
      validBytes,
      bodyBytes: body.byteLength,
    };
  }
  const { header, storedFormatVersion, events, bodyOffset, validBytes } = read;
  if (site.legacy !== undefined && site.legacy !== 'tombstone') {
    await settleTombstone(directory, header, site.legacy);
  }
  const droppedBytes = read.bodyBytes - validBytes;
  return {
    header,
    storedFormatVersion,
    events,
    stored: new JsonlStoredSession(directory, header, context, {
      nextSeq: events.length,
      ...(droppedBytes > 0 && {
        torn: { truncateTo: bodyOffset + validBytes, droppedBytes },
      }),
      lease,
      reservation,
      logPath: site.logPath,
    }),
  };
}

/** {@link migrateToCurrentGeneration} 交出來的東西。 */
interface MigratedSession {
  readonly header: StoredSessionHeader;
  /** 來源的格式版本。 */
  readonly storedFormatVersion: number;
  /** 從新世代讀回來、驗過的事件。 */
  readonly events: readonly SessionEvent[];
  /** 新世代檔。 */
  readonly logPath: string;
}

/**
 * 把一份舊的會話（舊兩檔，或比這一版舊的世代）遷成這一版的世代檔（#1594 ③）。
 * 呼叫方握著 `session.lock`，來源是舊兩檔的還握著 `<base>.lock`。
 *
 * 1. 穩定讀來源、照 `recoverable` 解析並驗證；撕裂的尾巴不帶過去（講一行）。
 * 2. 暫存檔：header 行（來源是舊兩檔的記 `migratedFrom`）加上**原樣複製**的已接受前綴，fsync。
 * 3. 驗暫存檔：讀回來，位元組數與前綴的 SHA-256 要對得上，header 行讀得懂，本文照這一版 `strict` 解析、事件數相同、驗證過。
 *    交出去的就是這一份事件：第一次解析的那份在寫暫存檔之前就放掉。
 * 4. 來源沒變（{@link siteRevision}，舊兩檔比 header 與日誌兩個檔），才 `link` 排他發佈、fsync 會話目錄。
 *
 * **失敗時來源不動**，暫存檔刪掉。發佈之後舊路徑換墓碑是呼叫方的事（{@link settleTombstone}）。
 *
 * @throws {@link SessionAlreadyExistsError} 這一版的世代檔已經在（`link` 撞上 `EEXIST`）。
 * @throws {@link SessionCorruptionError} 來源讀不懂，或暫存檔驗不過。
 * @throws `Error` 來源在遷移途中被改了：這一次不發佈，再續接一次就好。
 */
async function migrateToCurrentGeneration(
  directory: string,
  id: string,
  site: SessionSite,
  context: LeaseContext,
  location: SessionLocation,
): Promise<MigratedSession> {
  const { catalog, fs } = context;
  const sessionDirectory = join(directory, sessionDirectoryName(id));
  const logPath = join(sessionDirectory, generationLogFilename(SESSION_LOG_FORMAT_VERSION));
  const before = await siteRevision(site, fs);
  const entry = await readSite(site, { id, catalog, fs, location });
  if (entry === undefined) throw notFoundIn(directory, id);
  const { header, storedFormatVersion } = entry;
  let source: AcceptedPrefix | undefined = await acceptedPrefixOf(id, entry, location);
  const migratedFrom =
    site.layout === 'two-file'
      ? { bytes: source.bytes, acceptedBytes: source.prefix.byteLength, sha256: source.sha256 }
      : undefined;
  const headerLine = encodeHeaderLine(header, migratedFrom);
  const temp = await writeSyncedTemp(logPath, [headerLine, source.prefix], context.openLog);
  const expected = {
    acceptedBytes: source.prefix.byteLength,
    sha256: source.sha256,
    events: source.events,
  };
  const droppedBytes = source.bytes - source.prefix.byteLength;
  // 來源的 Buffer 寫進暫存檔之後就放掉：驗證要讀回一整份，不同時握兩份。
  source = undefined;
  let events: readonly SessionEvent[];
  try {
    events = await verifyMigratedTemp(id, header, temp, headerLine, expected, catalog, location);
    if ((await siteRevision(site, fs)) !== before) {
      throw new Error(
        `會話 "${id}" 的來源在遷移途中被改了：這一次不發佈新世代，來源原樣，再續接一次就好。`,
      );
    }
    try {
      await link(temp, logPath);
    } catch (error: unknown) {
      if (isAlreadyExists(error)) throw new SessionAlreadyExistsError(id, { cause: error });
      throw error;
    }
  } catch (error: unknown) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  try {
    await syncDirectory(sessionDirectory);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
  if (droppedBytes > 0) {
    context.warn(
      `會話 "${id}" 遷成 v${String(SESSION_LOG_FORMAT_VERSION)} 的世代時，來源日誌尾端有 ${droppedBytes} 個位元組不屬於任何` +
        `完整的事件，沒有搬過去（來源原樣留著）。`,
    );
  }
  return { header, storedFormatVersion, events, logPath };
}

/** {@link acceptedPrefixOf} 交出來的東西。 */
interface AcceptedPrefix {
  /** 本文整個的位元組數（舊兩檔就是整個日誌檔）。 */
  readonly bytes: number;
  /** 已接受的前綴，原樣的位元組（本文的一段 view）。 */
  readonly prefix: Buffer;
  /** {@link prefix} 的 SHA-256，小寫十六進位。 */
  readonly sha256: string;
  /** 前綴裡有幾顆事件。 */
  readonly events: number;
}

/**
 * 來源的已接受前綴：讀本文、照 `recoverable` 解析並驗證，只留前綴的位元組、雜湊與事件數。解析出來的事件不留：驗證暫存檔時
 * 會再解析一次，交出去的是那一份。
 */
async function acceptedPrefixOf(
  id: string,
  entry: SessionEntry,
  location: SessionLocation,
): Promise<AcceptedPrefix> {
  const body = await entry.readBody();
  const { events, validBytes } = parseJsonlSessionBody(id, body, {
    version: entry.storedFormatVersion,
    recovery: 'recoverable',
    location,
    firstLine: bodyFirstLine(entry.layout),
  });
  validateStoredLog(id, entry.header, events);
  const prefix = body.subarray(0, validBytes);
  return {
    bytes: body.byteLength,
    prefix,
    sha256: createHash('sha256').update(prefix).digest('hex'),
    events: events.length,
  };
}

/**
 * 驗遷移寫出來的暫存檔（{@link migrateToCurrentGeneration} 第 3 步）。
 *
 * @returns 從暫存檔解析、驗過的事件。
 * @throws {@link SessionCorruptionError} 哪一項對不上。
 */
async function verifyMigratedTemp(
  id: string,
  header: StoredSessionHeader,
  temp: string,
  headerLine: string,
  expected: { readonly acceptedBytes: number; readonly sha256: string; readonly events: number },
  catalog: SessionFormatCatalog,
  location: SessionLocation,
): Promise<readonly SessionEvent[]> {
  const bytes = await readFile(temp);
  const headerBytes = Buffer.byteLength(headerLine);
  const body = bytes.subarray(headerBytes);
  const mismatch = (detail: string): SessionCorruptionError =>
    new SessionCorruptionError(id, `遷移寫出的暫存檔${detail}，不發佈`, location);
  if (bytes.byteLength !== headerBytes + expected.acceptedBytes) {
    throw mismatch(
      `有 ${bytes.byteLength} 個位元組，應該是 ${headerBytes + expected.acceptedBytes}`,
    );
  }
  if (createHash('sha256').update(body).digest('hex') !== expected.sha256) {
    throw mismatch('的本文跟來源的前綴雜湊對不上');
  }
  parseHeader(bytes.subarray(0, headerBytes - 1).toString('utf8'), {
    id,
    catalog,
    location,
    line: true,
  });
  const { events } = parseJsonlSessionBody(id, body, {
    version: SESSION_LOG_FORMAT_VERSION,
    recovery: 'strict',
    location,
    firstLine: bodyFirstLine('generation'),
  });
  if (events.length !== expected.events) {
    throw mismatch(`解析出 ${events.length} 顆事件，來源是 ${expected.events} 顆`);
  }
  validateStoredLog(id, header, events);
  return events;
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
   * 後端對營運者講話的那張嘴：拿不到寫租約（見 `session-lease.ts`，一個後端只講一次）、截掉或沒搬過去的尾巴、開著的日誌長過額度（每個把手一次）。
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
  /**
   * 會話日誌的位元組額度（#2115）：續接佔到把手關掉、唯讀讀完就還，放不下的在讀之前拋
   * {@link @nexus/core!SessionLogTooLargeError}；開著的日誌長過容量不拋、也不追加佔用，只講一行。省略即這個行程共用的那一本（{@link processSessionLogBudget}）；
   * serve 與 CLI 傳各自照 `thread-capacity` 開的那一本，測試換小的。
   */
  readonly logBudget?: SessionLogBudget;
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
 * 磁碟上這個 id 已經在了沒有（#1559 N0622），兩種佈局都看（#1594 ②）。**同步**：`SessionStore.create` 是同步介面，它的呼叫方
 * （`sessions.observe` 的回呼）也是同步的（#1559 Q1 (a)）。
 *
 * - 舊兩檔看 header 與日誌兩個檔，任一個在都算建過（例如 header 被外部刪掉、只剩日誌）。不在才放行，其餘的錯原樣拋。
 * - 單檔佈局看會話目錄裡有沒有正規的世代檔。目錄不在、路徑太長、同名的是個檔都算不在（{@link isAbsentPath}），其餘的錯
 *   原樣拋。
 */
function existsOnDisk(directory: string, id: string): boolean {
  const files = legacyTwoFileSessionFilenames(safeBaseName(id));
  for (const name of [files.header, files.log]) {
    try {
      statSync(join(directory, name));
      return true;
    } catch (error: unknown) {
      if (!isNotFound(error)) throw error;
    }
  }
  return hasGenerationSync(join(directory, sessionDirectoryName(id)));
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
    logBudget: options.logBudget ?? processSessionLogBudget(),
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
