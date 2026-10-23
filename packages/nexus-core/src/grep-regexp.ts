/**
 * `grep` 的 `pattern` 與 `glob` 兩格在模型看到的工具定義裡的說法（[#1605](https://github.com/DemianLi/nexus-agent/issues/1605) N0347）。
 *
 * ## 為什麼要有這顆
 *
 * #1563 Q1 (a) 拍板 `grep` 照 dsh 改成正規式語意（`ContainedFilesystemBackend.grep` 不再帶 `-F`）。基座的 `grep` 工具卻處處說「字面」：
 * 工具描述是「Search for a LITERAL text pattern … (NOT regex)」，`pattern` 參數寫「Literal text pattern to search for (not regex)」
 * （`deepagents@1.13.1`，`dist/langsmith-zm0ILQsV.js` 的 `GREP_TOOL_DESCRIPTION` 與 `createGrepTool`）。說法不換，模型就會照字面寫（把
 * `foo|bar` 拆成兩次呼叫），或把要找的 `(` 寫成沒轉義的而吃一個 `SEARCH_INVALID_PATTERN`。
 *
 * **工具描述**經 `createFilesystemMiddleware` 的 `customToolDescriptions.grep` 換（`fs-tool-descriptions.ts`，跟 `read_file` 的預設行數同一條路）；
 * **參數的說明**只能在這裡換：`customToolDescriptions` 只管工具描述，參數 schema 是基座的 zod，沒有任何選項換它，同 `read_file` 的 `limit`
 * （`read-continuation.ts` 檔頭「JSON schema 換不掉」）：在模型那一側把工具換成一份 OpenAI 形狀的定義，執行時 ToolNode 找的仍是基座那個實例。
 *
 * ## 換什麼
 *
 * 照 dsh `grep.ts:286-289`（`687f282e`）：
 *
 * - `pattern`：`Regular expression to search for (ripgrep syntax).`
 * - `glob`（dsh 叫 `include`）：`One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}"). Not a list; negation is not supported.`——
 *   跟著換，因為這一張同時讓 backend 拒絕逗號清單與 `!` 開頭的篩選（`SEARCH_INVALID_PATTERN`），舊說法（`'*.py'`）沒說這件事。
 *
 * ## 開不開，看 backend 的語意
 *
 * 這顆 middleware 說的是 **backend 的行為**（正規式），不是它自己的：只在 fold 有 backend 時掛，跟讀檔續讀一樣。`ContainedFilesystemBackend`
 * 是產品唯一的工作區 backend；plugin 自帶的 backend 若仍是字面比對，這句話對它就是錯的——跟 `read-continuation.ts`「只認得切片語意的 backend」
 * 同一條已知界線。
 *
 * @module
 */

import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { createMiddleware } from 'langchain';

import type { AgentMiddleware } from './base-types.js';

/** 這個 middleware 的名字。`fs-tool-descriptions.ts` 看它在不在決定要不要換工具描述。 */
export const GREP_REGEXP_MIDDLEWARE_NAME = 'nexusGrepRegexp';

/** 基座的 `grep` 工具。名字是 `deepagents@1.13.1` 取的，不是我們。 */
const GREP_TOOL = 'grep';

/** `pattern` 參數的說法，照 dsh `grep.ts:289`。 */
export const GREP_PATTERN_DESCRIPTION = 'Regular expression to search for (ripgrep syntax).';

/** `glob` 參數的說法，照 dsh `include` 的（`grep.ts` 的 `include` 參數）。 */
export const GREP_GLOB_DESCRIPTION =
  'One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}"). Not a list; negation is not supported.';

/** OpenAI 形狀的工具定義，只取這裡動得到的幾格。 */
interface FunctionParameters {
  readonly properties?: Readonly<Record<string, unknown>>;
}

/** 基座的 `grep` → 模型看到的那一份。每個工具實例算一次。 */
const modelFacing = new WeakMap<object, object>();

/**
 * 模型看到的 `grep`：`pattern`、`glob` 兩格的說明換掉，其餘（名字、描述、別的參數、必填）原樣。
 * **是 OpenAI 形狀的一份定義，不是工具**，也**帶一格不可列舉的 `name`**：理由同 `read-continuation.ts` 的 `modelFacingReadTool`
 * （基座的 `_ToolExclusionMiddleware` 用 `tool.name` 認要拿掉的工具）。
 */
function modelFacingGrepTool(tool: object): object {
  const cached = modelFacing.get(tool);
  if (cached !== undefined) return cached;
  const converted = convertToOpenAITool(tool as never);
  const parameters = converted.function.parameters as FunctionParameters;
  const properties = parameters.properties ?? {};
  const withDescription = (name: string, description: string): Record<string, unknown> =>
    // 基座沒有這一格（升版改名）就不憑空加：留著模型看到的原樣，由 `grep-regexp.test.ts` 對著基座實際的 schema 絆線。
    properties[name] === undefined
      ? {}
      : { [name]: { ...(properties[name] as object), description } };
  const definition = {
    ...converted,
    function: {
      ...converted.function,
      parameters: {
        ...parameters,
        properties: {
          ...properties,
          ...withDescription('pattern', GREP_PATTERN_DESCRIPTION),
          ...withDescription('glob', GREP_GLOB_DESCRIPTION),
        },
      },
    },
  };
  Object.defineProperty(definition, 'name', { value: GREP_TOOL, enumerable: false });
  modelFacing.set(tool, definition);
  // 已經換過的再進來（同一份請求被兩層看到）原樣留著。
  modelFacing.set(definition, definition);
  return definition;
}

function isGrepTool(tool: unknown): tool is object {
  return (
    typeof tool === 'object' &&
    tool !== null &&
    (tool as { readonly name?: unknown }).name === GREP_TOOL
  );
}

/**
 * 造一顆把 `grep` 兩格參數說明換成正規式說法的 middleware。**無狀態**：root 與每個子代理共用同一顆。
 *
 * @returns 交給 fold 排位置的 middleware。
 */
export function createGrepRegexpMiddleware(): AgentMiddleware {
  return createMiddleware({
    name: GREP_REGEXP_MIDDLEWARE_NAME,
    wrapModelCall: (request, handler) => {
      const tools = request.tools as readonly unknown[] | undefined;
      if (!Array.isArray(tools) || !tools.some(isGrepTool)) return handler(request);
      return handler({
        ...request,
        tools: tools.map((tool) => (isGrepTool(tool) ? modelFacingGrepTool(tool) : tool)),
      } as typeof request);
    },
  }) as AgentMiddleware;
}
