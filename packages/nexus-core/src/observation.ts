/**
 * 先讀後改：沒讀過的檔不准改。
 *
 * 模型可以對一個**沒讀過**的檔直接 `edit_file`——盲改。失敗一次是一輪往返（工具錯誤 →
 * 模型重讀 → 再改），成功了則可能改壞它沒看到的地方。這個 middleware 記下每個 agent
 * 這一場觀察過哪些檔，並用那份紀錄擋下每一次寫入與編輯。
 *
 * ## 照抄 dsh 的哪些、退了哪兩條
 *
 * 標準是 `packages/fs/fs-observation-policy`（SHA `4e84901`，對到上游
 * `76fda72` 時該套件除了版號沒有變動）。**三個狀態、三個錯誤碼、以及「部分讀也算」
 * 都是照抄的**：
 *
 * - **未見／確認缺席／存在於某版本**。讀一個不存在的檔會把它記成**確認缺席**，
 *   所以之後的 `write_file` 可以走受防護的新建流程重建它。
 * - **`write_file` 也擋**，不只 `edit_file`：未見或確認缺席解析成 `createIfAbsent`
 *   （新建可以、覆蓋既有檔不行），確認存在則要求版本仍是讀到的那個。
 * - **任何窗口的讀都算**。dsh 明文把這寫成刻意的弱化：「授权依据是版本新鲜度，
 *   而非视图完整性……任何窗口读取都会授权对未变文件执行全文件覆盖」。所以帶
 *   `offset` / `limit` 的部分讀一樣讓你改整個檔。
 * - **紀錄逐 agent 一份，而且不跨 session**。dsh 的 owner 是 `agent.session`，而那邊
 *   agent id ≡ session id、child agent 各自一份；恢復的 session 從零觀測開始。
 *   我們的對應是 fold **逐個 agent 建一份實例**（見 `fold.ts`）。
 *
 * **偏離一：新鮮度檢查不是原子的。** dsh 把防護推到 provider——`write` / `edit` 帶著
 * expected version 下去，後端自己做 compare-and-swap。`deepagents@1.13.1` 的
 * `BackendProtocol` 表達不出來：`write(filePath, content)` 與
 * `edit(filePath, old, new, replaceAll)` 收不到任何 expected-version 參數。退到最接近的
 * 實作——在 `wrapToolCall` 裡先 `readRaw()` 比對版本再放行。**殘留 TOCTOU**：比對與寫入
 * 之間有縫。這跟 `ContainedFilesystemBackend` 已經明文接受的那條同型（policy fence，
 * 不是 kernel boundary）。
 *
 * **偏離二：規則寫在系統提示詞，不是工具描述裡。** dsh 把它寫進工具描述——
 * 「read an existing file first (**the default fs-observation-policy requires it**)」、
 * 「Read the file first…, unless you just created or edited it in this session」
 * （`snapshots/web` 底下每一份 `system-prompt.expected.md`）。理由跟 {@link ROOT_ONLY_NOTICE} 同一條：
 * 模型看得到的只有描述，不寫在那裡它每碰一個新檔就得先撞一次牆。**那個縫在我們這裡是關
 * 著的**：`customToolDescriptions` 只存在於 `FilesystemMiddlewareOptions` 上，而
 * `createDeepAgent` 建 `createFilesystemMiddleware` 時只傳
 * `{ backend, permissions, tools }`——root 與 subagent 兩條路都不轉發它。退到最接近的
 * 載體：`wrapModelCall` 往 `systemMessage` 追加一句（同一個模型、同一輪看得到，只是位置
 * 不同）。**紀律沒退**：規則照樣在模型動手之前就講給它聽。
 *
 * @module
 */

import { ToolMessage } from '@langchain/core/messages';
import { adaptBackendProtocol } from 'deepagents';
import type { AnyBackendProtocol } from 'deepagents';
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from './base-types.js';
import { resolveToolName } from './containment.js';

/** 這個 middleware 的名字。排序斷言用得到。 */
export const OBSERVATION_POLICY_MIDDLEWARE_NAME = 'nexusFileObservationPolicy';

/**
 * 被防護的三顆基座工具。
 *
 * 名字是 `deepagents@1.13.1` 內建檔案系統工具的名字，**不是我們取的**——
 * `apps/harness/src/baseline.test.ts` 那條「StateBackend 下註冊的內建工具是這七個加
 * task」已經把整組釘住了，所以基座哪天改名，那條會先紅。
 *
 * dsh 那側不必列名字：它的策略掛在 `fs/*` 事件上，由 fs 工具自己派發。我們的派發點是
 * LangGraph 的 ToolNode，插不進去，所以只能按名字認。
 */
export const OBSERVED_READ_TOOL = 'read_file';
/** 見 {@link OBSERVED_READ_TOOL}。 */
export const OBSERVED_WRITE_TOOL = 'write_file';
/** 見 {@link OBSERVED_READ_TOOL}。 */
export const OBSERVED_EDIT_TOOL = 'edit_file';

/**
 * 一次權威觀測。
 *
 * `absent` 不是「沒觀測過」——它是**確認缺席**，授權受防護的新建，但不授權編輯。
 * 「沒觀測過」由這張表裡沒有這個鍵表示。形狀照 dsh 的 `FsObservation`。
 */
type Observation =
  { readonly kind: 'present'; readonly version: string } | { readonly kind: 'absent' };

/**
 * 加進系統提示詞的那一句。**這句話是機制的一部分，不是註解。**
 *
 * 沒有它，模型每碰一個新檔都會先撞一次牆再學會——而省掉那一輪往返正是這件事的主要價值。
 * dsh 把同一件事寫在工具描述裡；為什麼我們寫在這裡，見本檔檔頭的「偏離二」。
 */
export const OBSERVATION_POLICY_NOTICE =
  '這個 agent 啟用了「先讀後改」策略：' +
  `\`${OBSERVED_EDIT_TOOL}\` 要求先讀過目標檔；` +
  `\`${OBSERVED_WRITE_TOOL}\` 可以新建檔案，但覆蓋一個已經存在的檔之前一樣要先讀過它。` +
  '讀過之後那個檔又被改動的，要重讀一次才能再改。' +
  `讀整個檔或只讀一段（帶 \`offset\` / \`limit\`）都算讀過。`;

/** 錯誤碼照抄 dsh，句子中文——碼是給機器讀的，句子是給模型讀的。 */
const NOT_OBSERVED = 'FS_NOT_OBSERVED';
const NOT_FOUND = 'FS_NOT_FOUND';
const STALE_VERSION = 'FS_STALE_VERSION';

/**
 * 把 `FileData` 折成一個不透明的版本 token。
 *
 * dsh 的本地後端用的是 `dev:ino:size:mtimeNs:ctimeNs`（`fs-local/src/fsio.ts:75`）——
 * 一個由後端自己組出來、消費端不得解讀的複合字串。我們手上只有 `modified_at`
 * （ISO 8601，毫秒），**單靠它會在同一毫秒內的兩次寫入上撞號**，所以再併上長度與一個
 * 便宜的內容雜湊。內容本來就在 `readRaw` 的回傳裡，不必多讀一次。
 *
 * 二進位檔（`content` 不是字串也不是行陣列）只落到 `modified_at`——那是這一格已知的弱點，
 * 不是疏漏：模型改不動二進位檔，這條路上唯一會走到它的是 `write_file` 覆蓋。
 */
function versionOf(data: unknown): string {
  const file = data as { readonly modified_at?: unknown; readonly content?: unknown };
  const modified = typeof file.modified_at === 'string' ? file.modified_at : '';
  const text = contentText(file.content);
  return `${modified}:${text.length}:${hash(text)}`;
}

/** `FileData.content` 在 v1 是行陣列、v2 是字串或位元組。認不得的一律當空字串。 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.every((line) => typeof line === 'string'))
    return content.join('\n');
  return '';
}

/** djb2。這裡要的是「內容變了會變號」，不是密碼學強度。 */
function hash(text: string): string {
  let acc = 5381;
  for (let i = 0; i < text.length; i += 1) acc = ((acc << 5) + acc + text.charCodeAt(i)) | 0;
  return (acc >>> 0).toString(36);
}

/** 一則說得出碼與恢復辦法的拒絕。`status: 'error'` 是模型分辨它與成功結果的唯一依據。 */
function refusal(callId: string, toolName: string, code: string, reason: string): ToolMessage {
  return new ToolMessage({
    content: `[${code}] ${reason}`,
    tool_call_id: callId,
    name: toolName,
    status: 'error',
  });
}

/**
 * 這次工具呼叫是不是失敗了。
 *
 * 判準是 `status === 'error'`——`ToolMessage` 上分辨成功與失敗的唯一依據，跟圍堵與核准
 * 閘門用的是同一格。認不得的形狀（例如 `Command`）一律當成功：這裡多算一次成功只會讓
 * 策略**多記一筆觀測**，而那條路上已經有版本新鮮度在守；多算一次失敗才會讓它漏記缺席。
 */
function isErrorResult(result: unknown): boolean {
  return (result as { readonly status?: unknown } | undefined)?.status === 'error';
}

/** 這次呼叫的 `file_path`，不是字串就回 `undefined`（表示這一格不歸我們管）。 */
function filePathOf(args: unknown): string | undefined {
  const path = (args as { readonly file_path?: unknown } | undefined)?.file_path;
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}

/**
 * 造一份「先讀後改」的策略 middleware。
 *
 * **一個 agent 一份，不共用。** 觀測紀錄在 closure 裡，共用會讓 root 讀過的檔變成
 * subagent 也可以直接改——那正好把這件事要擋的東西放掉。這是與 {@link createSummarizer}
 * 同型的理由，跟圍堵與提醒器（無狀態、共用一份）相反。
 *
 * @param backend - 這次組裝真正在用的那個 backend（`foldBackend` 的產物，可能是
 *   `CompositeBackend`）。版本 token 從它身上取——**必須是工具實際讀寫的那一個**，
 *   拿兜底那個會讓掛了路由的路徑量到別人的版本。
 * @returns 可以放進 `middleware` 陣列的 middleware。
 */
export function createObservationPolicy(backend: AnyBackendProtocol): AgentMiddleware {
  // v1 / v2 兩種 backend 的 `readRaw` 回傳形狀不同；轉接一次之後統一是 `{ data } | { error }`。
  const fs = adaptBackendProtocol(backend);
  const observed = new Map<string, Observation>();

  /**
   * 現在這個檔的權威狀態。
   *
   * **判準是 `'data' in result`**，不是比對錯誤訊息的字面——基座把措辭改一個字，靠字面
   * 認的版本就會把「不存在」悄悄讀成「存在」。
   *
   * **拋錯也算不存在，而那不是偷懶。** `readRaw` 的失敗形狀在後端之間不一致：
   * `StateBackend` 回 `{ error }`，落磁碟的那個對缺檔直接拋 `ENOENT`（實測）。
   * 這裡任何一種失敗都收斂成「讀不到」，而讀不到只會讓策略**放行新建、擋下覆蓋**，
   * 不會放寬任何一格。
   */
  const look = async (path: string): Promise<Observation> => {
    let result: unknown;
    try {
      result = await fs.readRaw(path);
    } catch {
      return { kind: 'absent' };
    }
    if (result !== null && typeof result === 'object' && 'data' in result) {
      return { kind: 'present', version: versionOf((result as { data: unknown }).data) };
    }
    return { kind: 'absent' };
  };

  /**
   * 記一筆權威觀測。成功的變更已經落地了，所以這裡只有副作用、不會拒絕。
   *
   * **讀失敗的時候只記得下「不存在」，記不下「存在」**，而那條界線是承重的：
   *
   * - 讀一個不存在的檔失敗 → 記成**確認缺席**。這是 dsh 明文的行為（「读取缺失文件会
   *   把它标记为确认缺失，因此随后的 `write` 可以通过防护创建流程重新创建它」）。
   * - 讀一個**存在**的檔卻失敗（內容被 token 上限截掉、offset 超過檔尾、解碼失敗……）
   *   → **什麼都不記**。記下去等於讓模型握有一份它從來沒看過的內容的觀測，下一次
   *   `write_file` 覆蓋就這樣穿過去了——那正好是這整件事要擋的盲改。
   *
   * dsh 沒有這個洞是因為 `fs/observed` 由 read 工具在權威成功時才發；它從反面講的是
   * 同一條界線：「直接 `ctx.fs` 读取不会发出 `fs/observed`」。我們的判準只能是工具交回
   * 來的那則訊息是不是錯誤——版本照樣從 backend 取，那一格沒變。
   *
   * @param path - 這次的目標。
   * @param readFailed - 這次讀取的工具結果是不是錯誤。變更路徑上一律 `false`。
   */
  const observe = async (path: string, readFailed = false): Promise<void> => {
    const state = await look(path);
    if (readFailed && state.kind === 'present') return;
    observed.set(path, state);
  };

  return createMiddleware({
    name: OBSERVATION_POLICY_MIDDLEWARE_NAME,

    // 規則要在模型動手之前就講給它聽，理由見檔頭的「偏離二」。
    wrapModelCall: (request, handler) =>
      handler({
        ...request,
        systemMessage: request.systemMessage.concat(`\n\n${OBSERVATION_POLICY_NOTICE}`),
      }),

    wrapToolCall: async (request, handler) => {
      const toolName = resolveToolName(request);
      const path = filePathOf(request.toolCall.args);
      // 不是這三顆、或者參數根本不帶路徑（模型填壞了）→ 原樣放行，讓工具自己講。
      if (path === undefined) return handler(request);
      const callId = request.toolCall.id ?? '';

      if (toolName === OBSERVED_READ_TOOL) {
        const result = await handler(request);
        // **讀完才記，而且版本記的是後端的真話不是工具的輸出**：讀一個不存在的檔會被
        // 記成確認缺席，那正是之後受防護的新建所需要的授權。**但讀失敗時記不下「存在」**
        // ——理由見 {@link observe}。
        await observe(path, isErrorResult(result));
        return result;
      }

      if (toolName === OBSERVED_EDIT_TOOL) {
        const prior = observed.get(path);
        if (prior === undefined)
          return refusal(
            callId,
            toolName,
            NOT_OBSERVED,
            `要編輯 "${path}" 得先讀過它——先用 \`${OBSERVED_READ_TOOL}\` 讀一次，再重試。`,
          );
        if (prior.kind === 'absent')
          return refusal(callId, toolName, NOT_FOUND, `不能編輯 "${path}"：讀到的時候它不存在。`);
        const stale = await staleness(path, prior);
        if (stale !== undefined) return refusal(callId, toolName, STALE_VERSION, stale);
        const result = await handler(request);
        await observe(path);
        return result;
      }

      if (toolName === OBSERVED_WRITE_TOOL) {
        const prior = observed.get(path);
        if (prior?.kind === 'present') {
          const stale = await staleness(path, prior);
          if (stale !== undefined) return refusal(callId, toolName, STALE_VERSION, stale);
        } else {
          // 未見或確認缺席 ＝ 只授權新建。現在檔在那裡，就是「覆蓋一個沒讀過的檔」——
          // 沒讀過的那次是 NOT_OBSERVED，讀到缺席之後又冒出來的那次是有人搶先建了。
          const now = await look(path);
          if (now.kind === 'present')
            return refusal(
              callId,
              toolName,
              prior === undefined ? NOT_OBSERVED : STALE_VERSION,
              prior === undefined
                ? `"${path}" 已經存在，覆蓋它之前要先讀過——先用 \`${OBSERVED_READ_TOOL}\` 讀一次，再重試。`
                : `"${path}" 在你讀到它不存在之後被建出來了——重新讀一次，再重試。`,
            );
        }
        const result = await handler(request);
        await observe(path);
        return result;
      }

      return handler(request);
    },
  }) as AgentMiddleware;

  /** 版本還是不是讀到的那個；是就回 `undefined`，不是就回那句要給模型看的話。 */
  async function staleness(path: string, prior: Observation): Promise<string | undefined> {
    if (prior.kind !== 'present') return undefined;
    const now = await look(path);
    if (now.kind === 'present' && now.version === prior.version) return undefined;
    return now.kind === 'absent'
      ? `"${path}" 在你讀過之後不見了——重新讀一次，再重試。`
      : `"${path}" 在你讀過之後被改動了——重新讀一次，再重試。`;
  }
}
