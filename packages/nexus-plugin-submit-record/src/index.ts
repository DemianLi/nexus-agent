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
 * ## backend 是 `write_file` 實際讀寫的**那一個**
 *
 * 這個 plugin 不自己造 backend。分岔的樣子是「`write_file` 寫到 A、`submit_record` 寫到 B」，
 * **而那不會有任何測試紅**——兩邊各自都寫成功了。所以：
 *
 * - **從 `fs` 查找服務（`@nexus/fs`，#1466）拿，工具被叫時才讀**（[#694](https://github.com/DemianLi/nexus-agent/issues/694)，
 *   照 dsh 寫檔工具注入的 `fs`）。查找服務依這次呼叫的 `thread_id` 回**那條 thread 自己的** fs 把手，把手的 `backend()` 是
 *   fold 填的**折後**那一個：組裝點在 fold 之前包的路由（`apps/harness/src/agent-factory.ts` 的 `/conversation_history/`、
 *   `/large_tool_results/`）與 plugin `registry.backend.mount()` 掛的路由都在裡面。以前收的是組裝點交給 host-services 的
 *   **折前**那一個，被路由的兩個前綴上兩邊各寫各的。量它的是 `apps/harness/src/submit-record-mounts.test.ts`。
 * - **為什麼要依 thread 挑**：行程裡可以同時活著好幾條 thread，每條各有自己的 backend 與 `--workspace` 的 fence
 *   （`SandboxModeController`，`/permission` 切的就是它）。只讀一份行程級的把手，等於一條 thread 的送出寫進另一條 thread 的
 *   backend、套另一條 thread 的 fence——靜默的。挑法是 `@nexus/core` 的 `pickBoundForCall`，與會話查找同一支。
 * - **拿不到就響亮地拒絕，不退回自己建的預設**（[#687](https://github.com/DemianLi/nexus-agent/issues/687)）。
 *   **「拿不到」有四種**（沒有任何一條 thread 登記、呼叫認不出、多條 thread 挑不出、把手裡沒有 backend），**對模型一律同一句**
 *   {@link SUBMIT_RECORD_NO_BACKEND_MESSAGE}（#1466 Q3，逐字不變）；分開是給宿主與測試看的。
 *   照 dsh 的寫檔工具：`tool-str-replace-editor` 硬注入 `fs`（`inject = ['tools', 'fs']`，
 *   `packages/fs/tool-str-replace-editor/src/index.ts:503`，SHA `477b4f4`），缺件時不會悄悄換一個。
 *   以前退到一顆自建的 `StateBackend`：帶 `--workspace` 卻沒接上時，`write_file` 寫進磁碟、`submit_record`
 *   寫進 state，而且照樣回「已經寫進」。拒絕的時刻是**那一次呼叫**，不是載入：載體在工具被叫時才讀，
 *   排錯序對它不存在，剩下的只有「需要卻缺」。訊息見 {@link SUBMIT_RECORD_NO_BACKEND_MESSAGE}。
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
import type { StructuredToolInterface } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import type { Context } from '@nexus/cordis';
import { fsToken } from '@nexus/fs';
import type { FsLookup } from '@nexus/fs';
import { defineManifest, injectOf, need, service } from '@nexus/sdk';
import { toolCallIdOf, toolRefusal } from '@nexus/tool-result';
import { toolsToken } from '@nexus/tools';
import type { ToolGateListener } from '@nexus/tools';
import { resolveBackend } from 'deepagents';
import type { BackendProtocolV2 } from 'deepagents';
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

/**
 * 拿不到 backend 時模型看到的那一句（前面由 `toolRefusal` 加 `Error: `）。帶 plugin 名與 `backend`，
 * 同 dsh `tool-bash: the mounted bash executor confines but ctx.sandboxPolicy is missing` 的寫法：
 * 讀的人一眼看得出是誰、缺什麼。
 */
export const SUBMIT_RECORD_NO_BACKEND_MESSAGE =
  'submit-record: 這次組裝沒有 backend（沒有人提供 `fs` 服務，或裡面沒有值），所以沒有寫。';

/**
 * 組出 `submit_record` 這顆工具。
 *
 * **工具本體只有這一份**：樹上的列（{@link apply}）與還在相容層組裝的測試（`apps/harness/src/submit-record.fixture.ts`）都從這裡
 * 取，它們之間唯一不同的是「這次呼叫的 fs 把手怎麼來」，所以那一格是參數。
 *
 * @param fsFor - 這次呼叫的 fs 查找。**在呼叫當下才呼叫它**，不在建工具的時候；參數是工具 handler 的第二個參數（整份原樣，
 *   thread 身分在裡面）。把手的 `backend()` 也在這次呼叫才讀。
 * @returns 可以登記的工具。
 */
export function createSubmitRecordTool(
  fsFor: (invocation: unknown) => FsLookup,
): StructuredToolInterface {
  return tool(
    async (args: { file_path: string; record: Record<string, string> }, runtime?: unknown) => {
      const callId = toolCallIdOf(runtime) ?? '';
      // 前綴由 `toolRefusal` 加（#318）：dsh 的寫入失敗是拋 `FsError`，由 `toolErrorResult` 渲染。
      const failed = (message: string): ToolMessage =>
        toolRefusal(message, { callId, name: SUBMIT_RECORD_TOOL_NAME });

      // **拿不到就拒絕，不退回預設**，見模組註解。
      const found = fsFor(runtime);
      if (found.kind !== 'ok') return failed(SUBMIT_RECORD_NO_BACKEND_MESSAGE);
      const backend = found.fs.backend();
      if (backend === undefined) return failed(SUBMIT_RECORD_NO_BACKEND_MESSAGE);
      const fs = await resolveBackend(backend, runtime as never);
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
 * `submit_record` 的**核准閘門**：只認 `submit_record` 這個名字，一律問人；其餘 `next()`。
 *
 * ## 兩樣東西為什麼在同一個插件裡
 *
 * 形狀照當時的 `@nexus/plugin-plan-mode`：它那時也是自己註冊 `exit_plan_mode`、自己註冊一個只認
 * `exit_plan_mode` 的 `approvals.gate()`（[#652](https://github.com/DemianLi/nexus-agent/issues/652) 照 dsh
 * 改走提問通道，那位閘門已經拿掉）。**「這個工具要人看過」是這個工具的性質**，拆到
 * 別的組裝點去掛的失敗方式是「工具在、閘門沒掛」——而那條路上模型會直接把檔案寫出去，
 * 一張卡都不會出現。
 *
 * **這是新增一個閘門，不是打開一個開關**（#231 第 6 項）：`approvals` 的 waterfall
 * **鏈底是 `allow`**——沒人管的工具一律放行。掛上這個插件之前，`submit_record` 這個名字沒有任何人會攔。
 *
 * **幾個註冊者不會互相影響**：waterfall 依註冊順序跑，每一位對不是自己那個名字的一律 `next()`，
 * 這位對非 `submit_record` 一律 `next()`。「只認自己那個名字」的否定面有測試（見 `index.test.ts` 最後一段）——
 * 少了它，一個把所有工具都攔下來的閘門一條測試都不會紅。
 *
 * **閘門沒有開關**。做成可選的失敗方式是有人為了跑測試把它關掉，然後那個組裝就變成
 * 「模型自己把資料寫進真實磁碟」——而 `--workspace` 之下那就是真的檔案。
 *
 * ## 偏離 dsh（AGENTS.md 的偏離規則，#1466 Q1 (a)）
 *
 * **哪一條**：dsh 的工具插件用 `ctx.on('tools/pre-execute', listener)` 掛核准閘門
 * （`packages/core/tools/src/index.ts:1512-1516`，鏈底 `allow`）。**為什麼表達不出來**：樹上沒有事件匯流排的服務 token，
 * 而核准不搬上匯流排（demian 2026-10-09）。**退到什麼**：`@nexus/tools` 1.2.0 的 `gate(listener)`——同一個 waterfall、同一個
 * 鏈底，只是入口是 tools 服務上的方法；宿主把這一列的 listener 折進每條 thread 自己的 `registry.approvals`，問人仍走
 * `nexusApprovalGate` 中介層。
 *
 * @param exec - 這一次待決的呼叫。
 * @param next - 委派給下一位。
 * @returns 對 `submit_record` 是 `ask`，其餘委派。
 */
export const submitRecordGate: ToolGateListener = (exec, next) =>
  exec.name === SUBMIT_RECORD_TOOL_NAME
    ? { kind: 'ask', reason: '這一列要寫出去，先讓人看過' }
    : next();

/** 插件在樹上的列用的名字（`ctx.fiber.runtime.name`，錯誤訊息、log 與相容層清單用）。 */
export const name = 'submit-record';

/**
 * 要的服務：`tools`（**`^1.2.0`**：要有 `gate`）與 `fs`（`^2.0.0`）。範圍在這裡宣告，落進 Cordis 的 `Context.intercept`，
 * 提供者的 `check` 讀得到；`tools` 提供者比 1.2.0 舊時，這一列在 `requires` 階段就掉，不會在「閘門沒掛」的狀態下起來。
 */
export const inject = injectOf(need(toolsToken, '^1.2.0'), need(fsToken, '^2.0.0'));

/** 這個插件的設定（manifest 的 `config`）：沒有資料設定。`strictObject`：未知欄位讓載入失敗。 */
export const Config = z.strictObject({});

export const manifest = defineManifest({
  id: 'submit-record',
  version: '0.1.0',
  owner: '平台團隊',
  provides: [],
  consumes: [
    { token: toolsToken.name, range: '^1.2.0' },
    { token: fsToken.name, range: '^2.0.0' },
  ],
  config: Config,
  // 換程式碼要重啟行程；沒有資料設定（唯一的協作者 fs 在呼叫當下才讀）。
  reload: { code: 'restart', config: 'next-thread' },
  capabilities: [],
});

/**
 * 掛上：把 `submit_record` 與它的核准閘門登記進行程級的工具登記處。
 *
 * **fs 查找在這裡抓進閉包**，列卸載之後經 `ctx` 取服務會拋，抓住的那份仍可呼叫。**呼叫當下才 `forCall`**：行程裡活著哪幾條
 * thread 是呼叫當下的事實，不是掛載當下的；`backend()` 也在那一次才讀（同 #694，排在提供者前面或後面都一樣）。
 *
 * **閘門缺席不是靜默跳過**：`gate` 在契約上是選填（舊提供者沒有它），但這個插件宣告了 `^1.2.0`，真的沒有就是接線壞了——
 * 當場拋，不讓一個沒有閘門的 `submit_record` 起來（那一條路上模型會直接把檔案寫出去）。
 *
 * @param ctx - 這一列的 Cordis context。
 */
export function apply(ctx: Context): void {
  const fs = service(ctx, fsToken);
  const tools = service(ctx, toolsToken);
  if (tools.gate === undefined) {
    throw new Error(
      'submit-record: tools 服務沒有 gate()（要 @nexus/tools ^1.2.0），不讓沒有核准閘門的 submit_record 起來。',
    );
  }
  tools.register(createSubmitRecordTool((invocation) => fs.forCall(invocation)));
  tools.gate(submitRecordGate);
}
