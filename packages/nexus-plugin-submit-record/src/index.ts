/**
 * `submit_record`：把湊齊的欄位寫成外部目標的**一列**，而且**一定要人核准**。
 *
 * 這是 [#231](https://github.com/DemianLi/nexus-agent/issues/231) 四段鏈
 * （**問 → 補齊 → 核准 → 寫出去**）的後兩段。前兩段是 `@nexus/plugin-ask-user`。
 *
 * ## 為什麼是一個自己的工具，而不是叫模型去呼叫 `write_file`
 *
 * #231 第 5 項的三個理由，逐條都看得見：
 *
 * 1. **閘門認得出來。** `approvals.gate()` 判的是工具名（`ToolExecution.name`）。送出如果
 *    走 `write_file`，只認名字就等於把**所有**檔案寫入都攔下來——那是射程大得多的另一張卡
 *    （#231「不在這張卡裡」）；而要只攔「這一次是送出」就得去猜路徑，猜錯的方向是**放行**。
 * 2. **核准卡顯示的是填好的欄位。** 中斷酬載裡的 `actionRequests[0].args` 就是這個工具的
 *    參數，所以人看到的是 `{ file_path, record: { 姓名: "阿明", … } }`——不是一坨已經
 *    escape 過的 CSV 字串。**這條有測試釘著**（`apps/harness/src/submit-record-wire.test.ts`），
 *    否則這個理由就只是散文。
 * 3. **換目標只換這個工具的身體。** `.xlsx`／MCP 那兩條（#231 都在「不在這張卡裡」）換的是
 *    下面 `writeRow` 那幾行，模型面與閘門那一面一個字都不用動。
 *
 * ## backend 由組裝點注入，而且必須是**同一個**
 *
 * 這個 plugin 不自己造 backend。理由與 `@nexus/plugin-ask-user` 的 `channel` 完全相同：
 * 分岔的樣子是「`write_file` 寫到 A、`submit_record` 寫到 B」，**而那不會有任何測試紅**——
 * 兩邊各自都寫成功了。所以：
 *
 * - **組裝點傳它交給 `createNexusAgent` 的那一個**（`apps/harness/src/cli.ts` 把它 hoist
 *   成一個 const，兩個消費者共用）。
 * - **省略時的預設，字面照抄基座**：`(runtime) => new StateBackend(runtime)`，與
 *   `createFilesystemMiddleware` 的預設**逐字相同**（`deepagents@1.13.1`）。換一種寫法
 *   （例如 `new StateBackend()`）的失敗方式同上：沒有 `--workspace` 的組裝裡兩個工具會
 *   落在不同的地方。
 *
 * **今天這個注入等價於「折出來的那一個」，但那是一件要量的事，不是恆真。** `fold.ts` 交給
 * `createDeepAgent` 的是**折後**的 backend：只要有人 `registry.backend.mount()` 掛了路由，
 * 它就會被包成 `CompositeBackend`，而這裡收到的是**折前**的 default。實測（2026-09-09）
 * 生產程式碼裡 `backend.mount()` **零個呼叫點**（只有 `apps/harness/src/fixtures.ts` 的測試
 * 替身與 `@nexus/core` 的測試），所以兩者今天是同一個物件。**絆索**在
 * `apps/harness/src/submit-record-mounts.test.ts`：哪天有 plugin 開始掛路由，那一條會紅，
 * 而不是等到某一列 CSV 悄悄寫進 route 前綴外面。
 *
 * ## 對欄名，不對欄序
 *
 * 檔案已經存在時，欄序由**檔案的表頭**決定，不由模型這次給的鍵序決定。`record` 裡沒提到的
 * 欄位補空字串；**`record` 裡有而表頭沒有的欄位是錯誤，不是靜靜丟掉**——那一格是人剛剛
 * 親手回答的東西，丟掉它的失敗方式是「寫成功了、答案不見了」。
 *
 * ## 讀回來用 `readRaw`，不用 `read`，而且**要 try/catch**
 *
 * `BackendProtocolV2` 沒有 append，所以追加一列＝讀全文、接一行、寫回去。而
 * `read(path)` **預設只給前 500 行**（`limit = 500`）——用它的失敗方式是第 501 列送出時
 * 把前面的檔案截成 500 行寫回去。`readRaw` 沒有分頁。
 *
 * **代價是這兩個方法對「檔案不存在」的回法不一樣**（`deepagents@1.13.1` 的
 * `FilesystemBackend`，2026-09-09 實測）：`read()` 回一則結構化的
 * `{ error: "Error reading file …: ENOENT …" }`，`readRaw()` **直接把 `stat` 的 ENOENT 拋
 * 出來**。而這個工具每一次執行都在 resume 那一輪，拋出去會從 LangGraph 的 stream mux
 * 逃成 unhandled rejection、整場 run 當場死——第一次寫這條路時就是這樣紅的，症狀是
 * 「檔案沒建出來，而且線上什麼都沒說」。所以 `readRaw` 一定包在 try/catch 裡。
 * 絆索見 `apps/harness/src/submit-record-wire.test.ts` 最後那一段。
 *
 * ## 錯誤一律回 `status: 'error'` 的 ToolMessage，不 `throw`
 *
 * 與 `@nexus/plugin-ask-user` 同一條實測教訓：**resume 那一輪從工具裡拋出去**會從
 * LangGraph 的 stream mux 逃成 unhandled rejection，整場 run 當場死。而這個工具的每一次
 * 執行都在 resume 那一輪之後（它一定經過核准），所以這裡沒有「拋也沒差」的分支。
 *
 * @module
 */

import { ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import type { NexusPlugin } from '@nexus/core';
import { StateBackend, resolveBackend } from 'deepagents';
import type { AnyBackendProtocol, BackendFactory, BackendProtocolV2 } from 'deepagents';
import { z } from 'zod';

import { formatCsvRow, parseCsvLine } from './csv.js';

/** 模型看到的工具名。**閘門認的就是這個字串**，所以它是導出的。 */
export const SUBMIT_RECORD_TOOL_NAME = 'submit_record';

/**
 * 工具描述。
 *
 * **命令句，而且明著說「先湊齊再送」。** 軟提示壓不動模型（#231 第 1 項那條實測），而這個
 * 工具最貴的失敗是**拿著半份資料送出去**——送出經過核准，人看到的是一列已經缺了兩格的
 * 紀錄，按下核准之後就落盤了。
 */
export const SUBMIT_RECORD_DESCRIPTION =
  '把湊齊的欄位寫成目標檔案的一列。**欄位缺了就先用 ask_user_question 問人，不要自己編、不要留空送出。**' +
  '送出一定要經過人核准，所以你會停一下；被拒絕時不要換個路徑再送一次，去問人為什麼。' +
  '欄名要跟檔案表頭一致；檔案不存在時會用你這次給的鍵當表頭建起來。';

const submitSchema = z.object({
  file_path: z.string().describe('目標檔案的絕對路徑，例如 "/visitors.csv"。不存在就會被建出來。'),
  record: z
    .record(z.string(), z.string())
    .describe('這一列的欄位，鍵是欄名、值是欄位內容。值一律是字串。'),
});

/** 這個 plugin 的組裝參數。 */
export interface SubmitRecordPluginOptions {
  /**
   * 寫出去用的 backend。
   *
   * **給組裝點交給 `createNexusAgent` 的那一個**，理由見模組註解。省略即基座那個預設
   * （`StateBackend`，跑在 state 裡不碰磁碟）。
   */
  readonly backend?: AnyBackendProtocol;
}

/** 這次執行拿到的 runtime。只用得到兩格，所以不整包相依基座的型別。 */
interface ToolRuntimeLike {
  readonly toolCall?: { readonly id?: string };
}

/** 讀回檔案現在的全文。**讀不到一律當作「還沒有這個檔案」**，見下面的說明。 */
async function readWhole(
  backend: BackendProtocolV2,
  filePath: string,
): Promise<{ text?: string; binary?: true }> {
  // **拋的與回 error 的兩種都要接住**，見模組註解：同一個基座裡 `read` 回結構化錯誤而
  // `readRaw` 拋 ENOENT。
  //
  // **任何讀取失敗都當成「檔案不存在」**，不去比對措辭。理由：措辭歸 backend（`StateBackend`
  // 與 `FilesystemBackend` 各說各的），把它們解析成一套分類，等於讓「檔案不存在」與「沒有
  // 讀取權限」共用一條路而我們分不出來。**唯一有權宣告失敗的是 `write`**——真的寫不進去時
  // 它會說，而那一句才是這個工具回報的依據。
  let result: Awaited<ReturnType<BackendProtocolV2['readRaw']>>;
  try {
    result = await backend.readRaw(filePath);
  } catch {
    return {};
  }
  if (result.error !== undefined || result.data === undefined) return {};
  const content = result.data.content;
  if (typeof content === 'string') return { text: content };
  if (Array.isArray(content)) return { text: content.join('\n') };
  return { binary: true };
}

/**
 * 把一列接到現有內容後面。
 *
 * @returns 新的全文，或一句拒絕的理由。
 */
function appendRow(
  existing: string | undefined,
  record: Record<string, string>,
): { text: string } | { refusal: string } {
  const keys = Object.keys(record);
  if (keys.length === 0) {
    return { refusal: '`record` 是空的——一列沒有任何欄位的紀錄寫出去也讀不回來，所以沒有寫。' };
  }

  const trimmed = existing?.replace(/\r?\n$/, '');
  if (trimmed === undefined || trimmed === '') {
    // 新檔案：這次的鍵序就是表頭的欄序。**只有這一次由模型決定欄序**，之後都由表頭說了算。
    return {
      text: `${formatCsvRow(keys)}\n${formatCsvRow(keys.map((key) => record[key] ?? ''))}\n`,
    };
  }

  const [headerLine] = trimmed.split(/\r?\n/);
  const header = parseCsvLine(headerLine ?? '');
  const unknown = keys.filter((key) => !header.includes(key));
  if (unknown.length > 0) {
    return {
      refusal:
        `這幾個欄名不在 "${headerLine ?? ''}" 這份表頭裡：${unknown.join('、')}。` +
        `**沒有寫**——把它們丟掉的話這一列會寫成功而人剛剛回答的東西不見了。` +
        `表頭現在有的是：${header.join('、')}。`,
    };
  }
  const row = formatCsvRow(header.map((column) => record[column] ?? ''));
  return { text: `${trimmed}\n${row}\n` };
}

function createSubmitRecordTool(backend: AnyBackendProtocol | undefined) {
  // **字面照抄 `createFilesystemMiddleware` 的預設**，見模組註解。
  const resolved: AnyBackendProtocol | BackendFactory =
    backend ?? ((runtime) => new StateBackend(runtime));
  return tool(
    async (
      args: { file_path: string; record: Record<string, string> },
      runtime: ToolRuntimeLike,
    ) => {
      const callId = runtime?.toolCall?.id ?? '';
      const failed = (message: string): ToolMessage =>
        new ToolMessage({
          content: message,
          tool_call_id: callId,
          name: SUBMIT_RECORD_TOOL_NAME,
          status: 'error',
        });

      const fs = await resolveBackend(resolved, runtime as never);
      const current = await readWhole(fs, args.file_path);
      if (current.binary === true) {
        return failed(`"${args.file_path}" 讀出來不是文字——這個工具只寫得了 CSV，所以沒有寫。`);
      }
      const next = appendRow(current.text, args.record);
      if ('refusal' in next) return failed(next.refusal);

      const written = await fs.write(args.file_path, next.text);
      if (written.error !== undefined)
        return failed(`寫不進 "${args.file_path}"：${written.error}`);

      const message = new ToolMessage({
        content: `已經寫進 "${args.file_path}"：${formatCsvRow(Object.values(args.record))}`,
        tool_call_id: callId,
        name: SUBMIT_RECORD_TOOL_NAME,
      });
      // **`filesUpdate` 那一支不能省。** `StateBackend` 是 checkpoint backend，它的寫入靠這
      // 份 state update 才算數；只回 ToolMessage 的話沒有 `--workspace` 的組裝**每一次送出
      // 都會靜靜地什麼都沒寫**。形狀照 `write_file`（`deepagents@1.13.1`）。
      if (written.filesUpdate) {
        return new Command({ update: { files: written.filesUpdate, messages: [message] } });
      }
      return message;
    },
    {
      name: SUBMIT_RECORD_TOOL_NAME,
      description: SUBMIT_RECORD_DESCRIPTION,
      schema: submitSchema,
    },
  );
}

/**
 * 送出一筆紀錄的工具，**外加一個只認它的核准閘門**。
 *
 * ## 兩樣東西為什麼在同一個 plugin 裡
 *
 * 形狀照 `@nexus/plugin-plan-mode`：它也是自己註冊 `exit_plan_mode`、自己註冊一個只認
 * `exit_plan_mode` 的 `approvals.gate()`。**「這個工具要人看過」是這個工具的性質**，拆到
 * 別的組裝點去掛的失敗方式是「工具在、閘門沒掛」——而那條路上模型會直接把檔案寫出去，
 * 一張卡都不會出現。
 *
 * **這是新增一個閘門，不是打開一個開關**（#231 第 6 項）：`approvals` 的 waterfall
 * **鏈底是 `allow`**——沒人管的工具一律放行。這一刀之前生產程式碼裡只有一個註冊者
 * （plan-mode，只管 `exit_plan_mode`），**這一刀之後是兩個**，而承重的那一半仍然是鏈底：
 * 掛上這個 plugin 之前，`submit_record` 這個名字沒有任何人會攔。
 *
 * **兩個註冊者不會互相影響**：waterfall 依註冊順序跑，plan-mode 那位對非
 * `exit_plan_mode` 一律 `next()`，這位對非 `submit_record` 一律 `next()`。「只認自己那個
 * 名字」的否定面各自有測試（見 `index.test.ts` 最後一段）——少了它，一個把所有工具都攔
 * 下來的閘門一條測試都不會紅。
 *
 * **閘門沒有開關**。做成可選的失敗方式是有人為了跑測試把它關掉，然後那個組裝就變成
 * 「模型自己把資料寫進真實磁碟」——而 `--workspace` 之下那就是真的檔案。
 *
 * @param options - 見 {@link SubmitRecordPluginOptions}。
 * @returns 可以放進組裝點清單的 plugin。
 */
export function createSubmitRecordPlugin(options: SubmitRecordPluginOptions = {}): NexusPlugin {
  return {
    name: 'submit-record',
    apply(registry) {
      registry.tools.register(createSubmitRecordTool(options.backend));
      registry.approvals.gate((exec, next) =>
        exec.name === SUBMIT_RECORD_TOOL_NAME
          ? { kind: 'ask', reason: '這一列要寫出去，先讓人看過' }
          : next(),
      );
    },
  };
}
