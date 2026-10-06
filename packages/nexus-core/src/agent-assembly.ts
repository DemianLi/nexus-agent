/**
 * 自有的 agent 組裝點——**取代 `deepagents` 的 `createDeepAgent`**。
 *
 * ## 為什麼要有這個檔
 *
 * 研究文件 [`.docs/rust-and-langchain-removal-2026-10-06.md`](../../../.docs/rust-and-langchain-removal-2026-10-06.md)
 * §七的接縫 1。`createDeepAgent` 只是疊在 `langchain` 的 `createAgent` 上的一層 middleware 組裝，
 * 而它在我們這側做的事裡，有一半是我們一直在擋的：
 *
 * - **按模型改寫組裝**（harness profile）：拿掉工具、改工具描述、加 middleware、換系統提示詞。
 *   `fold` 看不到它，所以組裝點要另寫一道「宣告」檢查（舊的 `harness-profile.ts`）。**自己組就沒有
 *   這回事**：模型字串不再影響組成，那整套宣告機制跟著拿掉。
 * - **一次性子代理與背景子代理是兩條路**：背景那條早就繞過基座自編（`subagent-graph.ts`），
 *   並自己抄了一份「預設疊」。這裡把預設疊抽成一個函式，兩條路共用。
 *
 * ## 還走基座的東西
 *
 * 檔案工具（接縫 3）、摘要（接縫 4）、`task` 子代理（接縫 5）、skills／memory 的 middleware
 * 都還是呼叫 `deepagents` 匯出的建構函式，**這個檔只換「怎麼把它們疊起來」**。
 *
 * ## 照抄基座的組裝順序，不是照猜
 *
 * ```text
 * core  = [skills?, 檔案工具, task, 摘要, 補懸空呼叫]
 * tail  = [memory?]
 * 疊    = mergeMiddlewareStack(core, fold 給的 middleware, tail)
 * ```
 *
 * 同名的 fold middleware 原地換掉 core／tail 裡的預設（摘要就是這樣被換成我們的），沒撞名的新 middleware
 * 插在 core 與 tail 之間。**對照的證據**是 `apps/harness/src/assembly-parity.test.ts`：同一份 fold
 * 產物分別走 `createDeepAgent` 與這裡，middleware 名稱與順序、工具、系統提示、兩邊第一次送給模型的
 * 請求（root 與子代理）要逐位元組相同。基座移除之前，那條測試同時是升版絆索。
 *
 * ## 不做的事：拒絕，不悄悄少做
 *
 * `createDeepAgent` 還支援 Anthropic／Bedrock 的快取 middleware、`interruptOn`、`responseFormat`、
 * async 子代理（帶 `graphId`）、fork 模式的子代理、`stateSchema`／`contextSchema`／`streamTransformers`。
 * fold 交出的參數不會帶它們，產品路徑也沒有 Anthropic／Bedrock 模型；**遇到就拋並指名**，不要靜靜略過。
 *
 * @module
 */

import {
  createFilesystemMiddleware,
  createMemoryMiddleware,
  createSkillsMiddleware,
  createSubAgentMiddleware,
  createSummarizationMiddleware,
} from 'deepagents';
import type { SubAgent } from 'deepagents';
import { createAgent } from 'langchain';
import type { AgentMiddleware } from 'langchain';

import type { FoldedAgentParams } from './fold.js';
import { createPatchToolCallsMiddleware } from './patch-tool-calls.js';

/** 組裝一個 agent 要的東西：fold 的產物，加上選填的系統提示詞。 */
export interface AssembleAgentParams extends FoldedAgentParams {
  /** 系統提示詞。**原樣**送給模型，沒有基座 base prompt 墊在後面（基座預設本來就不注入）。 */
  systemPrompt?: string;
}

/**
 * 把 fold 的 middleware 併進預設疊與尾段，**照基座的 `mergeMiddlewareStack`**。
 *
 * 同名的原地換掉預設（兩段都找）；沒撞名的新 middleware 排在預設與尾段之間，或在
 * `appendNew: false` 時丟掉。
 *
 * @param defaults - 預設疊。
 * @param custom - 呼叫端給的。
 * @param tail - 排在最後的尾段。
 * @param options - `appendNew: false` 時沒撞名的 custom 不加進去。
 * @returns 合併後的疊。
 */
export function mergeMiddlewareStack(
  defaults: readonly AgentMiddleware[],
  custom: readonly AgentMiddleware[],
  tail: readonly AgentMiddleware[] = [],
  options: { readonly appendNew?: boolean } = {},
): AgentMiddleware[] {
  const defaultNames = new Set(defaults.map((entry) => entry.name));
  const tailNames = new Set(tail.map((entry) => entry.name));
  const replaceByName = (
    base: readonly AgentMiddleware[],
    names: ReadonlySet<string>,
  ): AgentMiddleware[] => {
    const replacements = new Map(
      custom.filter((entry) => names.has(entry.name)).map((entry) => [entry.name, entry]),
    );
    // 同名取最後一個：基座用 `Map.set` 覆寫，後給的贏。
    return base.map((entry) => replacements.get(entry.name) ?? entry);
  };
  const novel =
    options.appendNew === false
      ? []
      : custom.filter((entry) => !defaultNames.has(entry.name) && !tailNames.has(entry.name));
  return [...replaceByName(defaults, defaultNames), ...novel, ...replaceByName(tail, tailNames)];
}

/**
 * 一個宣告式子代理的預設疊：檔案工具、摘要、補懸空呼叫，規格帶 `skills` 時再加 skills。
 *
 * **一次性子代理（經 `task`）與背景子代理（經 `compileSubagentGraph`）共用這一個函式**——兩條路
 * 以前各自維護一份，靠漂移絆索測試維持一致。
 *
 * @param spec - 子代理規格。
 * @param context - 後端與全域權限。
 * @returns 預設疊；呼叫端再用 {@link mergeMiddlewareStack} 併上規格自己帶的。
 */
export function subagentDefaultMiddleware(
  spec: Pick<Exclude<SubAgent, { runnable: unknown }>, 'permissions' | 'skills'>,
  context: Pick<FoldedAgentParams, 'backend' | 'permissions'>,
): AgentMiddleware[] {
  const backend = context.backend;
  if (backend === undefined) throw new Error('子代理沒有 backend，檔案系統 middleware 建不起來');
  // 規格自己有就用規格的（fold 已把全域的併進去）；基座傳的也是 `input.permissions ?? permissions`，
  // 缺席時它的預設值是空陣列，與不傳等價。
  const permissions = spec.permissions ?? context.permissions;
  const skills = spec.skills ?? [];
  return [
    createFilesystemMiddleware({ backend, ...(permissions !== undefined && { permissions }) }),
    createSummarizationMiddleware({ backend }),
    createPatchToolCallsMiddleware(),
    ...(skills.length > 0 ? [createSkillsMiddleware({ backend, sources: [...skills] })] : []),
  ] as unknown as AgentMiddleware[];
}

/** 規格帶了這個組裝點不支援的東西時拋。 */
function assertSupportedSubagent(spec: SubAgent): void {
  const record = spec as unknown as Record<string, unknown>;
  if ('graphId' in record) {
    throw new Error(`子代理 "${spec.name}" 是 async 子代理（帶 graphId），自有組裝點不支援`);
  }
  if (record['mode'] === 'fork') {
    throw new Error(`子代理 "${spec.name}" 是 fork 模式，自有組裝點不支援`);
  }
  if ('runnable' in spec) return;
  for (const field of ['interruptOn', 'responseFormat'] as const) {
    if (record[field] !== undefined) {
      throw new Error(
        `子代理 "${spec.name}" 帶了 ${field}，自有組裝點不處理它；fold 交出的規格不該有這一格`,
      );
    }
  }
}

/**
 * 把 fold 的產物組成一個 agent。
 *
 * @param params - fold 的產物，加上選填的系統提示詞。
 * @returns `createAgent` 編好的圖。**呼叫端自己疊 `withConfig`**（迴圈上限、並行上限）——基座
 *   那層 `withConfig({ recursionLimit: 10000 })` 本來就被我們蓋掉，這裡不再放。
 * @throws 沒有模型或 backend、沒有 `general-purpose`、規格帶了不支援的欄位。
 */
export function assembleAgent(params: AssembleAgentParams) {
  const { model, backend, checkpointer, store } = params;
  if (model === undefined) throw new Error('組裝 agent 需要模型：fold 的產物沒有 model');
  if (backend === undefined) throw new Error('組裝 agent 需要 backend：fold 的產物沒有 backend');
  const permissions = params.permissions ?? [];
  const skills = params.skills ?? [];
  const memory = params.memory ?? [];
  const tools = params.tools;
  const systemPrompt = params.systemPrompt ?? '';

  for (const spec of params.subagents) assertSupportedSubagent(spec);
  // 基座只在清單裡沒有 `general-purpose` 時才自己補一個；fold 一律自己補，所以這裡斷言它在，
  // 不照搬基座那段補件（它會讓 profile 的 `generalPurposeSubagent` 設定有作用，我們不要）。
  if (!params.subagents.some((spec) => spec.name === 'general-purpose')) {
    throw new Error(
      'fold 的產物沒有 general-purpose 子代理：fold 一律自己補它，缺了表示 fold 壞了',
    );
  }

  const inlineSubagents = params.subagents.map((spec) =>
    'runnable' in spec
      ? spec
      : {
          ...spec,
          tools: spec.tools ?? [],
          middleware: mergeMiddlewareStack(
            subagentDefaultMiddleware(spec, { backend, permissions }),
            (spec.middleware ?? []) as AgentMiddleware[],
          ),
        },
  );

  const core = [
    // 選填的 root skills，排在檔案工具前面。
    ...(skills.length > 0 ? [createSkillsMiddleware({ backend, sources: [...skills] })] : []),
    createFilesystemMiddleware({ backend, permissions }),
    createSubAgentMiddleware({
      defaultModel: model as never,
      defaultTools: tools,
      subagents: inlineSubagents,
      generalPurposeAgent: false,
      parentSystemPrompt: systemPrompt,
    }),
    createSummarizationMiddleware({ backend }),
    createPatchToolCallsMiddleware(),
  ] as unknown as AgentMiddleware[];
  const tail = [
    ...(memory.length > 0
      ? [createMemoryMiddleware({ backend, sources: [...memory], addCacheControl: false })]
      : []),
  ] as unknown as AgentMiddleware[];

  return createAgent({
    model: model as never,
    ...(systemPrompt !== '' && { systemPrompt }),
    tools: tools as never,
    middleware: mergeMiddlewareStack(core, params.middleware as AgentMiddleware[], tail),
    checkpointer,
    store,
  });
}
