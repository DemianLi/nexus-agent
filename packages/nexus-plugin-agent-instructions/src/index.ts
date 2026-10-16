/**
 * `@nexus/plugin-agent-instructions`——把工作區的 `AGENTS.md` 這類指令**當成一則持久的使用者訊息**
 * 送進每個 agent 的第一步。對上 dsh 的 `@deepseek-ai/dsh-agent-instructions`
 * （`packages/context/agent-instructions`，`ddefc45`），在 `dsh-base` 裡預設啟用。
 *
 * 只做**基線**：模型眼前沒有一則時組一則——第一步，以及摘要把它切掉之後的下一次 invoke
 * （[#397](https://github.com/DemianLi/nexus-agent/issues/397)）。巢狀發現、改檔刷新、移除通知不做：
 * [#389](https://github.com/DemianLi/nexus-agent/issues/389) 已以 not planned 關閉，重開條件寫在
 * 那張卡的決議留言裡。
 *
 * ## 為什麼不是把基座的 memory middleware 掛進預設清單
 *
 * `@nexus/plugin-memory` 包的是 `deepagents` 的 `createMemoryMiddleware`，跟 dsh 的形狀差在兩處
 * **模型看得到**的地方（量在 `deepagents@1.13.1`，`dist/langsmith-zm0ILQsV.js`）：
 *
 * 1. **它叫模型主動寫記憶**（`:3921-3975` 的 `<memory_guidelines>`：「updating memory must be your
 *    FIRST, IMMEDIATE action」），而且**沒有記憶檔時也照附**。預設掛上去等於叫每個 agent 去改使用者
 *    repo 裡的 `AGENTS.md`。dsh 的模板寫的是反過來的那句話：「Use them as guidance when applicable...
 *    They do not override system, developer, or direct user instructions.」
 * 2. **載體不同**：基座把內容併進 system prompt，不進會話日誌；dsh 刻意做成一則持久的 `user/message`，
 *    好讓模型看得到的狀態總能從日誌重建（可回放、可壓縮、可恢復）。
 *
 * 所以這裡照 dsh 新做一顆，`@nexus/plugin-memory` 留著當選配。**兩顆同時掛時同一份 `AGENTS.md` 會在
 * prompt 裡出現兩次**（一次在 system prompt、一次在這則訊息），而且只有它會附那段寫入指示。
 *
 * ## 偏離登記（AGENTS.md 的偏離規則）
 *
 * 1. **哪一條**：dsh 的使用者全域來源 `$DSH_HOME/AGENTS.md`，以及從工作目錄往上找 `.git` 專案根、
 *    專案根到 cwd 的整條來源鏈。
 *    **為什麼表達不出來**：backend 的命名空間以 `--workspace` 為根（`contained-backend.ts` 拒絕含 `..`
 *    的路徑），`StateBackend` 更是虛擬的；我們也沒有 harness home 目錄的慣例。要做就得另立一個 home
 *    慣例、繞過 backend 直接讀主機檔案，越過 fence。
 *    **退到什麼**：只讀工作區根那一層的四個候選。
 *    **重開條件**：出現跨專案共用指令的需求，或 `--workspace` 常指到 repo 子目錄而漏掉 repo 根的指令。
 * 2. **哪一條**：dsh 的 `fs` 是**選配**（`inject = ['sessionProjections', 'workingDirectory']`，`ctx.get('fs')` 拿不到就返回，
 *    `src/index.ts:36`、`:121-127`）；我們把 `fs` 放進 `inject`（必填，`^1.1.0`）。
 *    **為什麼表達不出來**：我們要在 `apply` 當下就把服務抓進閉包。沒有樹的路徑上（eval、`createNexusAgent` 的測試）插件被
 *    `mountDetached` 掛一次就卸載，呼叫當下才經 `ctx` 取服務會拋；而不經 `inject` 的選用服務在 `apply` 當下沒有次序保證——`fs` 那一列
 *    還沒提供就會永遠拿到 `undefined`，基線也就靜靜消失。
 *    **退到什麼**：`fs` 列是宿主內建列、永遠先起來，必填不會讓清單上的這一列多掉一種原因。
 *    **要守的風險**：呼叫當下 `fs.forCall(invocation)` 的查找若不是 `ok`，基線會**靜靜消失**。`apps/harness/src/agent-instructions-on-tree.test.ts`
 *    在 CLI、serve、無樹三個入口，root 與同步／背景子代理，量到的查找都是 `ok`。
 * 3. **哪一條**：摘要把基線切掉之後，dsh 在**下一步**補回——`agent/pre-step` 每一步都跑
 *    `visibleBaselineSource`，看的是壓縮後還看得到的那一面，看不到就重讀、重渲染一則新的（`src/index.ts:46-62`、
 *    `:130-190`）。我們在**下一次 invoke** 補回；判準相同（模型看得到的那一串裡有沒有），重讀與重渲染也相同。
 *    **為什麼表達不出來**：每一步的載體只有 `beforeModel`，而它是圖裡的節點，預設上限 100 下每輪多一格＝
 *    33 輪變 24 輪（#389 triage 實測）；#389 拍板每一步的那一半先不做（路線 B），這裡也就沒有另外為恢復
 *    付那一格。
 *    **退到什麼**：留在既有的 `beforeAgent`，不加節點。載體從「插件自己的 `beforeAgent`」改成「宿主為 listener 建的 `beforeAgent`」
 *    （#1474，`@nexus/agent-loop` 的 `preStep`；接縫本身的偏離登記在那個套件的檔頭），內容與重開條件不變。
 *    **留下的缺口**：同一次 invoke 裡，摘要之後的那幾輪看不到工作區指令，要等使用者下一句話。
 *    **重開條件**：#389 重開，或 core 開了讓多個貢獻者共用一格的 pre-step 節點。
 *
 * ## 摘要之後：看的是模型看得到的那一串
 *
 * 基座的摘要器不改寫 `state.messages`，只記一顆 `_summarizationEvent`，模型呼叫時才組
 * `[summary, ...messages.slice(cutoffIndex)]`。所以舊基線還在 state 裡、落在切點之前，模型卻看不到；
 * v0.4.30 只看 `state.messages`，說「有」，整條 thread 再也補不回來。現在判準走 `@nexus/core` 的
 * `effectiveMessages`（摘要器那個函式的抄本，已有單元測試），**跟摘要器用同一個述詞**，兩者不會再分岔。
 * 讀那顆私有鍵要宣告 `stateSchema`，見 {@link SUMMARIZATION_EVENT_VIEW}。
 *
 * 射程的邊界，兩處講明：
 *
 * - **子代理**：基座把 `_summarizationEvent` 擋在傳進傳出子代理兩個方向之外（`EXCLUDED_STATE_KEYS`，
 *   原文理由是切點只對算它的那一串有效）。子代理每次被委派都從一串新的訊息起跑，第一步本來就拿得到
 *   基線，所以這條修法在子代理身上沒有東西要修；子代理自己那一趟裡被摘掉，是上面同一次 invoke 的缺口。
 * - **續接**（`--resume`、serve 碰到舊 thread）：`conversation-restore.ts` 刻意只灌 `messages`、不帶切點，
 *   而灌回去的是「摘要＋之後的」，被切掉的舊基線本來就不在裡面，判準退回「有沒有」也照樣補一則。
 *   2026-09-18 實測，見 `apps/harness/src/agent-instructions.test.ts`。
 *
 * ## 攔截時刻：dsh 第 2 格 `agent/pre-step`
 *
 * dsh 在 `agent/pre-step` 組好基線、折進那一步的批次，**緊跟在已領取的訊息之後**
 * （`86a40220` 上的 `src/index.ts:334-360`，splice 在 `:355-359`）。我們這側對應的是 `@nexus/agent-loop` 的 `preStep`（宿主以 `beforeAgent` 承載），**只佔了注入那半**：
 * 拿不到整個訊息批次自己 splice，只能追加；落點由基座決定（2026-09-18 實測落在使用者那一句之後，與 dsh 同位）。
 * 攔截那半（`jumpTo: 'end'`）用不到，基線只注入。逐欄的差與頻率量在
 * `apps/harness/src/interception-index.test.ts` 第 2 列。
 *
 * ## 代價：每次 invoke 一格，每一輪零格
 *
 * 掛在 `beforeAgent` 上，**每一輪不多付 super-step，但每次 invoke 多付一格**——`beforeAgent` 也是圖裡的
 * 一個節點，只是一次 invoke 只走一次。2026-09-18 用 `LoopingChatModel` 在預設上限 100 上實測：預設組裝
 * 33 輪，加上這顆是 32 輪（有沒有 `--workspace` 都一樣：沒有工作區時組裝點墊 `StateBackend`，宿主的 middleware 照建；#1474 的 D 組量過）；同樣的注入改掛 `beforeModel` 是 24 輪（每輪多一格，見
 * `@nexus/core` 的 `repeat-reminder.ts`「代價」那一段）。
 *
 * **#394 原本寫「代價：零」，錯的。** 那次在上限 20、每輪兩格的組裝上量，`floor(19/2)` 與 `floor(18/2)`
 * 都是 9，每次 invoke 的那一格被 floor 吃掉了。每輪零增量的結論是對的，「零」這個字是錯的
 * （[#389](https://github.com/DemianLi/nexus-agent/issues/389) 的 triage）。
 *
 * ## 遷上樹（[#1474](https://github.com/DemianLi/nexus-agent/issues/1474)）
 *
 * 函式插件，套 SDK lint：**不 import `@nexus/core`**，也不碰 langchain 的 middleware。要在一次呼叫開頭追加訊息，經 `agentLoop` 服務
 * （`@nexus/agent-loop`）登記一位 `preStep` listener；宿主建 middleware、建訊息、記日誌（Q2 (a)）。這個檔只剩「讀什麼、渲染什麼、
 * 什麼時候不加」。**行為逐字不變**（Q4）：記號、渲染文字、四個候選與順序、`maxBytes` 預設、middleware 名字與在鏈上的位置、日誌
 * `source`、每次 invoke 一格、摘要後下一次 invoke 補回、寫日誌失敗訊息照送。
 *
 * 舊外殼的建構式（`createAgentInstructionsMiddleware`）搬到 harness 的
 * `agent-instructions.fixture.ts`，給 `pre-step-middleware.test.ts` 的單元測試用；`NexusPlugin` 外殼與 `createAgentInstructionsPlugin`
 * 沒有人用，已拿掉（#1479）。
 *
 * @module
 */

import { createHash } from 'node:crypto';

import type { BaseMessage } from '@langchain/core/messages';
import { agentLoopToken } from '@nexus/agent-loop';
import type { PreStepInjection, PreStepInvocation, PreStepListener } from '@nexus/agent-loop';
import type { Context } from '@nexus/cordis';
import { fsToken } from '@nexus/fs';
import type { FsLookup } from '@nexus/fs';
import { defineManifest, injectOf, need, service } from '@nexus/sdk';
import { adaptBackendProtocol } from 'deepagents';
import type { AnyBackendProtocol } from 'deepagents';
import { z } from 'zod';

import { renderAgentInstructions } from './render.js';
import type { InstructionFile } from './render.js';

export { AGENT_INSTRUCTIONS_INTRO, COMPACT_AGENT_INSTRUCTIONS_INTRO } from './render.js';

/**
 * middleware 的名字，也是 listener 登記時給宿主的名字（宿主用它當 middleware 名與日誌 `source.plugin`）。撞名是 fold 那側的判準，
 * 所以它是公開的。
 */
export const AGENT_INSTRUCTIONS_MIDDLEWARE_NAME = 'AgentInstructionsMiddleware';

/**
 * 認出「這個 agent 已經有基線了」的記號。
 *
 * **判準放在訊息上、不放在閉包裡**：一份 listener 服務好幾條 thread、root 與每個子代理（`@nexus/agent-loop` 的契約），
 * 閉包裡的旗標會讓第二個 agent 以為自己已經拿過。放在 `additional_kwargs` 則跟著訊息走，`--resume`
 * 與壓縮之後從日誌重建回來的那一則照樣認得出來——同 `@nexus/core` 的 `REPEAT_REMINDER_MARKER`（#305）。
 */
export const AGENT_INSTRUCTIONS_MARKER = 'nexus.agentInstructions';

/**
 * 候選檔，**順序就是渲染順序**：先兩個基礎檔，再兩個 local overlay。
 * 照 dsh `src/config.ts:11-13` 的 `instructionFileCandidates` 與 `localInstructionFileCandidates`。
 */
export const INSTRUCTION_FILE_CANDIDATES = [
  'AGENTS.md',
  'CLAUDE.md',
  'AGENTS.local.md',
  'CLAUDE.local.md',
] as const;

/**
 * 一則基線的位元組上限。照 dsh 在 `dsh-base` 給這顆 plugin 的值：`packages/bundle/base/cordis.patch.yml:278`
 * 的 `id: agent-instructions` 底下 `maxBytes: 65536`（`ddefc45`，自己核過）。**這個套件出廠就掛**是另一件
 * 事，證據在 `packages/bundle/base/package.json:122` 的相依宣告——「有這個套件」與「出廠就開」是兩件事，
 * 這個 repo 在那上面失手過三次（見 `.docs/plugin-architecture-gap-survey.md` §五第 5 條）。
 */
export const DEFAULT_MAX_BYTES = 65536;

/**
 * 這個 plugin 的設定。
 *
 * **dsh 拿非正數當「關掉」，我們這側不留那條路**：要關就別把這個 plugin 放進清單，而一個
 * 看起來像設定值的 `0` 靜靜關掉整個功能是那種沒有人會發現的失敗。這條是登記過的偏離。
 */
export const agentInstructionsConfigSchema = z.strictObject({
  /** 一則基線的 UTF-8 位元組上限。正的有限數，省略即 {@link DEFAULT_MAX_BYTES}。 */
  maxBytes: z
    .number()
    .positive('上限要是正的有限數')
    .finite('上限要是正的有限數')
    .default(DEFAULT_MAX_BYTES),
});

/** 驗過的設定。 */
export type AgentInstructionsConfig = z.infer<typeof agentInstructionsConfigSchema>;

/** 這一則訊息是基線嗎。 */
export function isAgentInstructionsMessage(message: BaseMessage): boolean {
  return message.additional_kwargs?.[AGENT_INSTRUCTIONS_MARKER] === true;
}

/** 去重用的指紋：**去掉首尾空白之後**的內容雜湊。dsh `src/digest.ts:26-28` 同一個規則。 */
function trimmedDigest(content: string): string {
  return createHash('sha1').update(content.trim(), 'utf8').digest('hex');
}

/**
 * 讀工作區根那一層的候選檔。
 *
 * 讀不到（不存在、backend 拒絕、內容不是字串）就跳過——**不拋**。指令是幫忙的東西，一份讀不到不該
 * 讓這一輪對話倒下；dsh 那側同樣是「沒有就沒有」。
 *
 * 同一層內容相同的只留第一個（`AGENTS.md` 與 `CLAUDE.md` 互為符號連結或直接複製是常見的做法），
 * 保留的是**先出現的那個路徑**。
 */
async function discover(backend: AnyBackendProtocol): Promise<InstructionFile[]> {
  const adapted = adaptBackendProtocol(backend);
  const files: InstructionFile[] = [];
  const seen = new Set<string>();
  for (const candidate of INSTRUCTION_FILE_CANDIDATES) {
    let content: string | undefined;
    try {
      const result = await adapted.read(`/${candidate}`);
      if (result.error != null) continue;
      if (typeof result.content !== 'string') continue;
      content = result.content;
    } catch {
      continue;
    }
    if (content.length === 0) continue;
    const digest = trimmedDigest(content);
    if (seen.has(digest)) continue;
    seen.add(digest);
    files.push({ displayPath: candidate, content });
  }
  return files;
}

/** {@link createAgentInstructionsListener} 要的查找。測試換成替身；`apply` 換成從服務抓進閉包的那一份。 */
export interface AgentInstructionsLookups {
  /** 這次呼叫那條 thread 的 fs 把手（`fs.forCall`）。 */
  fs(invocation: PreStepInvocation): FsLookup;
}

/**
 * 建 listener：**模型看得到一則才算有**（serve 的第二輪、`--resume`、子代理第二次被委派都走到這裡），沒有就讀工作區根、渲染，回一則。
 *
 * 判準看的是宿主交來的第一個參數——摘要器會組給模型的那一串，不是 `state.messages`：摘要之後舊基線還在 state 裡、但落在切點
 * 之前（#397）。fs 查找不是 `ok`、或 `backend()` 是 `undefined`（這次組裝沒有 backend）就不注入。
 *
 * @param maxBytes - 一則基線的位元組上限。
 * @param lookups - 查找，見 {@link AgentInstructionsLookups}。
 * @returns 登記給 `agentLoop.preStep` 的 listener。
 */
export function createAgentInstructionsListener(
  maxBytes: number,
  lookups: AgentInstructionsLookups,
): PreStepListener {
  return async (visible, invocation): Promise<readonly PreStepInjection[] | undefined> => {
    if (visible.some(isAgentInstructionsMessage)) return undefined;
    const found = lookups.fs(invocation);
    const backend = found.kind === 'ok' ? found.fs.backend() : undefined;
    if (backend === undefined) return undefined;
    const rendered = renderAgentInstructions(await discover(backend), maxBytes);
    if (rendered === undefined) return undefined;
    return [{ content: rendered.text, additionalKwargs: { [AGENT_INSTRUCTIONS_MARKER]: true } }];
  };
}

export const name = 'agent-instructions';

/**
 * 要的服務：`agentLoop`（`^1.0.0`，登記 `preStep` listener）與 `fs`（`^1.1.0`，呼叫當下拿這條 thread 的 backend）。範圍在這裡宣告，
 * 落進 Cordis 的 `Context.intercept`，提供者的 `check` 讀得到。`fs` 放進 `inject` 而不是選配，理由見檔頭偏離 2。
 */
export const inject = injectOf(need(agentLoopToken, '^1.0.0'), need(fsToken, '^1.1.0'));

/** 這個插件的設定（manifest 的 `config`）：見 {@link agentInstructionsConfigSchema}。`strictObject`：未知欄位讓載入失敗。 */
export const Config = agentInstructionsConfigSchema;

export const manifest = defineManifest({
  id: 'agent-instructions',
  version: '0.1.0',
  owner: '平台團隊',
  provides: [],
  consumes: [
    { token: agentLoopToken.name, range: '^1.0.0' },
    { token: fsToken.name, range: '^1.1.0' },
  ],
  config: Config,
  // 換程式碼要重啟行程；設定（`maxBytes`）只給新的 thread（#1405、決議 §3-2 第 6 條：組 thread 時取快照）。
  reload: { code: 'restart', config: 'next-thread' },
  capabilities: [],
});

/**
 * 掛上：登記一位 `preStep` listener。
 *
 * **兩個服務都在這裡抓進閉包**，列卸載之後經 `ctx` 取服務會拋，抓住的那份仍可呼叫（見檔頭偏離 2）。**呼叫當下才 `fs.forCall`**。
 *
 * @param ctx - 這一列的 Cordis context。
 * @param config - 驗過的設定。
 */
export function apply(ctx: Context, config: AgentInstructionsConfig): void {
  const agentLoop = service(ctx, agentLoopToken);
  const fs = service(ctx, fsToken);
  agentLoop.preStep(
    AGENT_INSTRUCTIONS_MIDDLEWARE_NAME,
    createAgentInstructionsListener(config.maxBytes, {
      fs: (invocation) => fs.forCall(invocation),
    }),
  );
}
