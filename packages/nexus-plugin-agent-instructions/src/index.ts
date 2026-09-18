/**
 * `@nexus/plugin-agent-instructions`——把工作區的 `AGENTS.md` 這類指令**當成一則持久的使用者訊息**
 * 送進每個 agent 的第一步。對上 dsh 的 `@deepseek-ai/dsh-agent-instructions`
 * （`packages/context/agent-instructions`，`ddefc45`），在 `dsh-base` 裡預設啟用。
 *
 * 這一刀只做**基線**：會話的第一步組一則、後面不再重複。巢狀發現、改檔刷新、移除通知是第二刀
 * （[#389](https://github.com/DemianLi/nexus-agent/issues/389)）。
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
 * 2. **哪一條**：dsh 的這顆 plugin 從 cordis 拿檔案系統提供方（`ctx.get('fs')`）。
 *    **為什麼表達不出來**：我們的 plugin 在 `apply(registry)` 裡看不到 backend——`backend.mount()` 掛的是
 *    路由分支，兜底那個是組裝點的一格，兩者要等 `foldRegistry` 折起來才算得出來。
 *    **退到什麼**：`registry.middleware.useWithBackend()`（#388 一起開的窄縫），由 fold 把折好的 backend
 *    交給工廠。**射程相同**：一份實例走遍 root 與每個子代理；一個 backend 都沒有時工廠不會被呼叫，
 *    等於 dsh 在 `ctx.get('fs')` 拿不到提供方時直接返回。
 *
 * ## 攔截時刻：dsh 第 2 格 `agent/pre-step`
 *
 * dsh 在 `agent/pre-step` 組好基線、折進那一步的批次，**緊跟在已領取的訊息之後**
 * （`src/index.ts:315-345`）。我們這側對應的是 `beforeAgent`，**只佔了注入那半**：拿不到整個訊息
 * 批次自己 splice，只能追加；落點由基座決定（2026-09-18 實測落在使用者那一句之後，與 dsh 同位）。
 * 攔截那半（`jumpTo: 'end'`）用不到，基線只注入。逐欄的差與頻率量在
 * `apps/harness/src/interception-index.test.ts` 第 2 列。
 *
 * ## 代價：零
 *
 * 掛在 `beforeAgent` 上，**每一輪不多付 super-step**。2026-09-18 用 `LoopingChatModel` 在
 * `recursionLimit: 20` 上實測：裸組裝 9 輪，加上這顆之後還是 9 輪；同樣的注入改掛 `beforeModel`
 * 是 6 輪（每輪多一格，見 `@nexus/core` 的 `repeat-reminder.ts`「代價」那一段）。基線一個 agent 只要
 * 一次，所以不必付那一格。
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { NexusPlugin, PluginRegistry, SessionLookup } from '@nexus/core';
import { toLoggedMessage } from '@nexus/core';
import { adaptBackendProtocol } from 'deepagents';
import type { AnyBackendProtocol } from 'deepagents';
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from 'langchain';

import { renderAgentInstructions } from './render.js';
import type { InstructionFile } from './render.js';

export { AGENT_INSTRUCTIONS_INTRO, COMPACT_AGENT_INSTRUCTIONS_INTRO } from './render.js';

/** 這個 plugin 宣告的能力名。要相依它的 plugin 把這個字串放進自己的 `requires`。 */
export const AGENT_INSTRUCTIONS_CAPABILITY = 'agent-instructions';

/** middleware 的名字。撞名是 fold 那側的判準，所以它是公開的。 */
export const AGENT_INSTRUCTIONS_MIDDLEWARE_NAME = 'AgentInstructionsMiddleware';

/**
 * 認出「這個 agent 已經有基線了」的記號。
 *
 * **判準放在訊息上、不放在閉包裡**：一份實例走遍 root 與每個子代理（`registry.middleware` 的契約），
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
 * 一則基線的位元組上限。照 dsh 在 `dsh-base` 給這顆 plugin 的值
 * （`packages/bundle/base/package.json:122`，`maxBytes: 65536`）。
 */
export const DEFAULT_MAX_BYTES = 65536;

export interface AgentInstructionsPluginOptions {
  /** 一則基線的 UTF-8 位元組上限。省略即 {@link DEFAULT_MAX_BYTES}。 */
  readonly maxBytes?: number;
}

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

/**
 * 建 middleware。**由 fold 呼叫**，見 `createAgentInstructionsPlugin`。
 *
 * @param backend - 折出來的 backend。
 * @param maxBytes - 一則基線的位元組上限。
 * @param sessions - 註冊表的 `sessions` 通道：基線也記進日誌。**省略就不記**。
 * @returns 可以掛在任意多個 agent 上的 middleware。
 */
export function createAgentInstructionsMiddleware(
  backend: AnyBackendProtocol,
  maxBytes: number,
  sessions?: { forCall(config: unknown): SessionLookup },
): AgentMiddleware {
  return createMiddleware({
    name: AGENT_INSTRUCTIONS_MIDDLEWARE_NAME,
    beforeAgent: async (
      state: { messages?: readonly BaseMessage[] },
      runtime?: { readonly configurable?: unknown },
    ) => {
      // 已經有一則就不再加。serve 的第二輪、`--resume`、子代理第二次被委派都走到這裡。
      if ((state.messages ?? []).some(isAgentInstructionsMessage)) return undefined;
      const rendered = renderAgentInstructions(await discover(backend), maxBytes);
      if (rendered === undefined) return undefined;
      const message = new HumanMessage({
        content: rendered.text,
        additional_kwargs: { [AGENT_INSTRUCTIONS_MARKER]: true },
      });
      record(sessions, runtime?.configurable, message);
      return { messages: [message] };
    },
  }) as unknown as AgentMiddleware;
}

/** 把基線記成 `user/message`。沒接會話、認不出屬於哪一份、或寫不進去，都不記。 */
function record(
  sessions: { forCall(config: unknown): SessionLookup } | undefined,
  configurable: unknown,
  message: HumanMessage,
): void {
  if (sessions === undefined) return;
  const found = sessions.forCall({ configurable });
  if (found.kind !== 'ok') return;
  try {
    found.log.append('user/message', {
      message: toLoggedMessage(message),
      source: { kind: 'plugin', plugin: AGENT_INSTRUCTIONS_MIDDLEWARE_NAME },
    });
  } catch {
    // 見上面：基線照樣送出。記不進去的後果是續接時重建不回來，不是這一輪少了指令。
  }
}

/**
 * 建一個 agent-instructions plugin。
 *
 * @param options - 位元組上限。
 * @returns 可以放進組裝點清單的 plugin。
 * @throws `maxBytes` 不是正的有限數。dsh 拿非正數當「關掉」，我們這側不留那條路：**要關就別把這個
 *   plugin 放進清單**，而一個看起來像設定值的 `0` 靜靜關掉整個功能是那種沒有人會發現的失敗。
 */
export function createAgentInstructionsPlugin(
  options: AgentInstructionsPluginOptions = {},
): NexusPlugin {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error(
      `createAgentInstructionsPlugin({ maxBytes: ${String(options.maxBytes)} })：` +
        '上限要是正的有限數。真的不要工作區指令就別把這個 plugin 放進清單。',
    );
  }

  return {
    name: 'agent-instructions',
    apply(registry: PluginRegistry): void {
      registry.capabilities.provide(AGENT_INSTRUCTIONS_CAPABILITY);
      registry.middleware.useWithBackend((backend) =>
        createAgentInstructionsMiddleware(backend, maxBytes, registry.sessions),
      );
    },
  };
}
