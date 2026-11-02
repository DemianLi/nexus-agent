/**
 * `grep` 與 `glob` 的參數在模型看到的工具定義裡的說法（[#1605](https://github.com/DemianLi/nexus-agent/issues/1605) N0345、N0347）。
 *
 * ## 為什麼要有這顆
 *
 * #1563 Q1 (a) 拍板 `grep` 照 dsh 改成正規式語意（`ContainedFilesystemBackend.grep` 不再帶 `-F`），而 `glob` 改走 `rg --files`（沒有 `/` 的
 * pattern 比檔名、任何深度）。基座的工具卻處處說舊的：`grep` 的工具描述是「Search for a LITERAL text pattern … (NOT regex)」，`pattern` 參數寫
 * 「Literal text pattern to search for (not regex)」；`glob` 的 `pattern` 參數只舉副檔名的例子，沒講基名規則
 * （`deepagents@1.13.1`，`dist/langsmith-zm0ILQsV.js` 的 `GREP_TOOL_DESCRIPTION`、`createGrepTool`、`createGlobTool`）。說法不換，模型就會照字面寫
 * （把 `foo|bar` 拆成兩次呼叫），或把 `*.ts` 當成只找起點那一層。
 *
 * **工具描述**經 `createFilesystemMiddleware` 的 `customToolDescriptions` 換（`fs-tool-descriptions.ts`，跟 `read_file` 的預設行數同一條路）；
 * **參數的說明**只能在這裡換：`customToolDescriptions` 只管工具描述，參數 schema 是基座的 zod，沒有任何選項換它，同 `read_file` 的 `limit`
 * （`read-continuation.ts` 檔頭「JSON schema 換不掉」）：在模型那一側把工具換成一份 OpenAI 形狀的定義，執行時 ToolNode 找的仍是基座那個實例。
 *
 * ## 換什麼
 *
 * 照 dsh（`687f282e`）：
 *
 * - `grep` 的 `pattern`（`grep.ts:289`）：`Regular expression to search for (ripgrep syntax).`
 * - `grep` 的 `glob`（dsh 叫 `include`，`grep.ts:290`）：`One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}"). Not a list; negation is not supported.`——
 *   跟著換，因為這一張同時讓 backend 拒絕逗號清單與 `!` 開頭的篩選（`SEARCH_INVALID_PATTERN`），舊說法（`'*.py'`）沒說這件事。
 * - `glob` 的 `pattern`（`glob.ts:311-314`）：講基名規則——沒有 `/` 的 pattern 比檔名、任何深度，帶分隔符才錨定深度。
 *
 * ## 開不開，看 backend 的語意
 *
 * 這顆 middleware 說的是 **backend 的行為**，不是它自己的：fold 只在組裝點說「搜尋走工作區 backend」（{@link FoldOptions.workspaceSearch}）時才掛。
 * 沒有 `--workspace` 時 default 是記憶體裡的 `StateBackend`，它的 `grep` 是字面比對、`glob` 是 `micromatch`，說正規式與基名規則就是在說謊；
 * 那時留基座的原說法。plugin 自帶的 backend 同理（組裝點只在 default 是 `ContainedFilesystemBackend` 時才說）。
 * 已知的例外：工作區底下的 `/conversation_history/` 那一格路由也是 `StateBackend`，`grep` 是字面比對；工具描述裡明講。
 *
 * @module
 */

import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { createMiddleware } from 'langchain';

import type { AgentMiddleware } from './base-types.js';

/** 這個 middleware 的名字。`fs-tool-descriptions.ts` 看它在不在決定要不要換工具描述。 */
export const SEARCH_DESCRIPTIONS_MIDDLEWARE_NAME = 'nexusSearchDescriptions';

/** `grep` 的 `pattern` 參數的說法，照 dsh `grep.ts:289`。 */
export const GREP_PATTERN_DESCRIPTION = 'Regular expression to search for (ripgrep syntax).';

/** `grep` 的 `glob` 參數的說法，照 dsh `include` 的（`grep.ts:290`）。 */
export const GREP_GLOB_DESCRIPTION =
  'One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}"). Not a list; negation is not supported.';

/** `glob` 的 `pattern` 參數的說法，照 dsh `glob.ts:311-314`。 */
export const GLOB_PATTERN_DESCRIPTION =
  'Glob pattern to match file paths against (e.g. "**/*.ts", "src/**/*.test.js"). ' +
  'A pattern with no "/" matches the basename at any depth, so "*" and "*.ts" both search the whole tree; include a separator to anchor the depth.';

/** 哪個工具的哪幾格參數說明要換。工具名是 `deepagents@1.13.1` 取的，不是我們。 */
const PARAMETER_DESCRIPTIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  grep: { pattern: GREP_PATTERN_DESCRIPTION, glob: GREP_GLOB_DESCRIPTION },
  glob: { pattern: GLOB_PATTERN_DESCRIPTION },
};

/** OpenAI 形狀的工具定義，只取這裡動得到的幾格。 */
interface FunctionParameters {
  readonly properties?: Readonly<Record<string, unknown>>;
}

/** 基座的工具 → 模型看到的那一份。每個工具實例算一次。 */
const modelFacing = new WeakMap<object, object>();

/**
 * 模型看到的搜尋工具：要換的參數說明換掉，其餘（名字、描述、別的參數、必填）原樣。
 * **是 OpenAI 形狀的一份定義，不是工具**，也**帶一格不可列舉的 `name`**：理由同 `read-continuation.ts` 的 `modelFacingReadTool`
 * （基座的 `_ToolExclusionMiddleware` 用 `tool.name` 認要拿掉的工具）。
 */
function modelFacingSearchTool(tool: object, name: string): object {
  const cached = modelFacing.get(tool);
  if (cached !== undefined) return cached;
  const converted = convertToOpenAITool(tool as never);
  const parameters = converted.function.parameters as FunctionParameters;
  const properties = parameters.properties ?? {};
  const swapped = Object.fromEntries(
    Object.entries(PARAMETER_DESCRIPTIONS[name] ?? {})
      // 基座沒有這一格（升版改名）就不憑空加：留著模型看到的原樣，由 `search-descriptions.test.ts` 對著基座實際的 schema 絆線。
      .filter(([parameter]) => properties[parameter] !== undefined)
      .map(([parameter, description]) => [
        parameter,
        { ...(properties[parameter] as object), description },
      ]),
  );
  const definition = {
    ...converted,
    function: {
      ...converted.function,
      parameters: { ...parameters, properties: { ...properties, ...swapped } },
    },
  };
  Object.defineProperty(definition, 'name', { value: name, enumerable: false });
  modelFacing.set(tool, definition);
  // 已經換過的再進來（同一份請求被兩層看到）原樣留著。
  modelFacing.set(definition, definition);
  return definition;
}

function searchToolName(tool: unknown): string | undefined {
  if (typeof tool !== 'object' || tool === null) return undefined;
  const name = (tool as { readonly name?: unknown }).name;
  return typeof name === 'string' && name in PARAMETER_DESCRIPTIONS ? name : undefined;
}

/**
 * 造一顆把 `grep`、`glob` 的參數說明換成 ripgrep 語意說法的 middleware。**無狀態**：root 與每個子代理共用同一顆。
 *
 * @returns 交給 fold 排位置的 middleware。
 */
export function createSearchDescriptionsMiddleware(): AgentMiddleware {
  return createMiddleware({
    name: SEARCH_DESCRIPTIONS_MIDDLEWARE_NAME,
    wrapModelCall: (request, handler) => {
      const tools = request.tools as readonly unknown[] | undefined;
      if (!Array.isArray(tools) || !tools.some((tool) => searchToolName(tool) !== undefined)) {
        return handler(request);
      }
      return handler({
        ...request,
        tools: tools.map((tool) => {
          const name = searchToolName(tool);
          return name === undefined ? tool : modelFacingSearchTool(tool as object, name);
        }),
      } as typeof request);
    },
  }) as AgentMiddleware;
}
