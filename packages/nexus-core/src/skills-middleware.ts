/**
 * skills 的 middleware——**包一層基座的 `createSkillsMiddleware`，補上三件它不做的事**
 * （[#440](https://github.com/DemianLi/nexus-agent/issues/440)、[#1574](https://github.com/DemianLi/nexus-agent/issues/1574)）。
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
 * ## 只給人叫的技能不列給模型（#1574）
 *
 * 基座不讀 SKILL.md 的 `disable-model-invocation`／`user-invocable`，掃到的全部印進 prompt。dsh 在提供者解析這兩個旗標、
 * 不合規的整份不收，`tool-skill` 只把 `isModelInvocable` 的列給模型，快照不完整就整份目錄不發
 * （`skill-filesystem/src/index.ts:831-837`、`tool-skill/src/index.ts:227-228`，`687f282e`）。
 *
 * **偏離登記（理由 1：基座表達不出來）**：基座不讀這兩個鍵，`createSkillsMiddleware` 也沒有過濾參數
 * （`langsmith-zm0ILQsV.js:4516-4553`）。退到：nexus 自己解析（`skill-catalog.ts`），交給基座的 `backend` 換成
 * {@link modelVisibleSkillsBackend} 的視圖：它先自己掃一次、記下快照，基座的 `ls` 與讀 `SKILL.md` 都由這份快照回應，
 * 該藏的目錄不在 `ls` 裡。基座的解析與格式化一行都不動，沒有旗標的技能 prompt 位元組跟沒包時一樣。
 * - **代價**：每次掃描多一層解析與一份快照的記憶體；碰 backend 的次數不變（基座讀的是快照，不再讀 inner）。基座看到的是
 *   掃描當時那一份，掃完之後才改的檔案，跟今天一樣要等下一次掃描。
 * - **不完整就這一次不發、下一次 invoke 重掃**：掃描遇到「不存在」以外的讀檔或列目錄錯誤，這一次一份技能都不給模型
 *   （不接任何字），也**不**把這次的空結果凍住。dsh 不完整的快照不進快取（`skill/src/index.ts:540`、`:604-611`），
 *   下一步（pre-step）重取；這裡基座只在 `beforeAgent` 掃描，所以退到下一次 invoke 重掃。serve 每條 thread 各組一個
 *   agent（#1405），這個旗標是那一條 thread 的。出廠的 `FilesystemBackend.ls` 把錯誤吞成空列表，那一種這一側看不出來，
 *   照「目錄是空的」處理（同上一段）；基座讀的是同一份快照，不會因此自己列出該藏的技能。
 * - **擋的只有清單**：nexus 沒有 dsh 的 `skill` 載入工具（正文由模型自己 `read_file`），所以沒有「拒絕叫用」那一道。
 *   基座的提示詞會印出來源目錄（`formatSkillsLocations`），模型 `ls` 一次就看得到那個目錄，照樣讀得到檔。dsh 也不擋檔案讀取，
 *   差的只是 `skill` 工具那一道。
 * - **撤除條件**：自寫 skills 中介層，或基座支援這兩個鍵。
 *
 * @module
 */

import { createSkillsMiddleware } from 'deepagents';
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from 'langchain';

import { modelVisibleSkillsBackend } from './skill-catalog.js';

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
 * 建 skills middleware：掃到空的就整個隱形（不掃第二次、不加任何字）；只給人叫的、旗標不合規的技能不列給模型。
 *
 * @param options - 同基座的 `createSkillsMiddleware`。`backend` 會換成 {@link modelVisibleSkillsBackend} 的視圖再交給基座。
 * @returns 與基座同名（`SkillsMiddleware`）同 state 形狀的 middleware，可以直接換掉基座那顆。
 */
export function createSkillsMiddlewareQuietWhenEmpty(options: BaseOptions): AgentMiddleware {
  /** 這一次 invoke 的掃描不完整：這一次不接字、不凍住，下一次 invoke 基座會重掃（它只快取非空的結果）。 */
  let incomplete = false;
  const base = createSkillsMiddleware({
    ...options,
    backend: modelVisibleSkillsBackend(options.backend, options.sources, (complete) => {
      incomplete = !complete;
    }),
  }) as unknown as BaseHooks & { name: string };
  /** 第一次完整掃描的結果是空的之後為 `true`。非空或還沒掃都是 `false`，委派給基座。 */
  let empty = false;
  return createMiddleware({
    name: base.name,
    ...(base.stateSchema !== undefined && { stateSchema: base.stateSchema as never }),
    async beforeAgent(state: unknown, runtime: unknown) {
      if (empty) return undefined;
      incomplete = false;
      const result = await base.beforeAgent(state, runtime);
      if (incomplete) return undefined;
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
      if (empty || incomplete) return handler(request);
      return base.wrapModelCall(request, handler);
    },
  } as never) as unknown as AgentMiddleware;
}
