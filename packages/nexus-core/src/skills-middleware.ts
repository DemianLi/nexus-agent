/**
 * skills 的 middleware——**包一層基座的 `createSkillsMiddleware`，補上兩件它不做的事**
 * （[#440](https://github.com/DemianLi/nexus-agent/issues/440)）。
 *
 * ## 基座的兩個行為（`deepagents@1.13.1`，實跑確認過，不是只讀 dist）
 *
 * 1. **`wrapModelCall` 不看清單是不是空的**：不管掃到幾個 skill，一律把整段 skills 說明
 *    （`SKILLS_SYSTEM_PROMPT` 加 `(No skills available yet...)`）接到 system prompt 後面，約 2000 字。
 *    也就是說「來源有註冊但目錄是空的 ／ 沒有 `--workspace`」每一輪都多送一大段模型用不到的字。
 * 2. **只有載到東西才快取**（`loadedSkills.length > 0`）：載到空的，每一輪 `beforeAgent` 都重掃整個 backend。
 *
 * ## dsh 的做法
 *
 * dsh 沒有「沒有 skill 就不加字」這個分支要寫，是結構上就不產生：目錄訊息只有在清單非空、或之前發佈過
 * 才會出現（`packages/skill/tool-skill/src/index.ts:237` 的 `!history.published && skills.length === 0`），
 * 而掃描結果連空的也進快取（`packages/skill/skill/src/index.ts:540-541`，`cacheable` 就寫入 `collectCache`）。
 *
 * ## 偏離登記
 *
 * 基座的 middleware 是一個整塊，**表達不出「空清單就不接字」**，所以退到最接近的：包一層，行為完全委派給基座，
 * 只在第一次掃描結果是空的之後，（a）`beforeAgent` 不再重掃、（b）`wrapModelCall` 原樣放行。
 * 差別：dsh 的快取以目錄內容的 revision 失效（目錄新增 skill 後下一輪會看到），這裡跟基座一樣**以 middleware
 * 實例為界**——載到空的就空到這個 agent 結束；基座對「載到東西」本來就是這個語意，這裡讓「載到空」對齊它。
 * 基座在 `ls` 失敗時回空陣列且完全無聲（見 `assertLoadableSkillsPath` 的說明），所以「備份端暫時讀不到」與
 * 「目錄是空的」在這裡分不開，兩者都會被當成空。
 *
 * @module
 */

import { createSkillsMiddleware } from 'deepagents';
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from 'langchain';

/** {@link createSkillsMiddleware} 收的東西，原樣轉給基座。 */
type BaseOptions = Parameters<typeof createSkillsMiddleware>[0];

/** 基座 middleware 上我們要轉呼叫的兩個鉤子，型別放寬成我們用得到的形狀。 */
interface BaseHooks {
  readonly stateSchema?: unknown;
  readonly beforeAgent: (
    state: unknown,
    runtime: unknown,
  ) =>
    | Promise<{ skillsMetadata?: unknown[] } | undefined>
    | { skillsMetadata?: unknown[] }
    | undefined;
  readonly wrapModelCall: (request: unknown, handler: (request: unknown) => unknown) => unknown;
}

/**
 * 建 skills middleware：掃到空的就整個隱形（不掃第二次、不加任何字）。
 *
 * @param options - 同基座的 `createSkillsMiddleware`。
 * @returns 與基座同名（`SkillsMiddleware`）同 state 形狀的 middleware，可以直接換掉基座那顆。
 */
export function createSkillsMiddlewareQuietWhenEmpty(options: BaseOptions): AgentMiddleware {
  const base = createSkillsMiddleware(options) as unknown as BaseHooks & { name: string };
  /** 第一次掃描的結果是空的之後為 `true`。非空或還沒掃都是 `false`，委派給基座。 */
  let empty = false;
  return createMiddleware({
    name: base.name,
    ...(base.stateSchema !== undefined && { stateSchema: base.stateSchema as never }),
    async beforeAgent(state: unknown, runtime: unknown) {
      if (empty) return undefined;
      const result = await base.beforeAgent(state, runtime);
      if (
        result !== undefined &&
        Array.isArray(result.skillsMetadata) &&
        result.skillsMetadata.length === 0
      ) {
        // 空的連 state 都不寫（基座會寫一格空的 `skillsMetadata`）：`invoke` 的回傳多一個鍵也算「有東西」。
        empty = true;
        return undefined;
      }
      return result as never;
    },
    wrapModelCall(request: unknown, handler: (request: unknown) => unknown) {
      if (empty) return handler(request);
      return base.wrapModelCall(request, handler);
    },
  } as never) as unknown as AgentMiddleware;
}
