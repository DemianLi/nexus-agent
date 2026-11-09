/**
 * 宿主頁工具（[#2374](https://github.com/DemianLi/nexus-agent/issues/2374)，設計 `.docs/host-page-tools-2374-design-2026-11-03.md`）：嵌入
 * `<nexus-chat>` 的宿主頁在 `run.start` 宣告自己的工具，模型呼叫時 serve 停下這一輪、發一顆 `input.requested`（{@link HOST_TOOL_INTERRUPT_KIND}），
 * 宿主頁執行後用 `input.respond` 把 {@link HostToolResponse} 交回。
 *
 * 上限與形狀的判準在這裡（{@link hostToolsProblem}、{@link hostToolResponseProblem}、{@link hostToolResultProblem}），serve 用這一份驗。
 * 宣告超過上限整句拒收；結果超過上限交回模型當這次呼叫的錯誤。都不截。
 *
 * @module
 */

/** 宿主頁宣告的一支工具。只收這三格，多一格就拒。 */
export interface HostToolDeclaration {
  /** 工具名，合 {@link HOST_TOOL_NAME_PATTERN}。模型看到的是 {@link HOST_TOOL_PREFIX} 加上它。 */
  readonly name: string;
  /** 給模型看的說明，非空，至多 {@link HOST_TOOL_LIMITS} 的 `descriptionChars` 個字。 */
  readonly description: string;
  /** 參數的 JSON Schema，`type: 'object'`。 */
  readonly parameters: { readonly type: 'object'; readonly [keyword: string]: unknown };
}

/** 模型看到的工具名前綴：`page__focus_device`。撞不到內建工具（同 MCP 的 `mcp__`）。 */
export const HOST_TOOL_PREFIX = 'page__';

/** 宿主頁工具名的形狀。 */
export const HOST_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/u;

/**
 * 上限。字數算 Unicode code point；位元組算 `JSON.stringify` 之後的 UTF-8。
 *
 * - `tools`：每輪幾支。
 * - `descriptionChars`：每支說明幾個字。
 * - `parametersBytes`：每支參數 schema 序列化後幾個位元組。
 * - `declarationBytes`：整份宣告序列化後幾個位元組。
 * - `resultChars`：宿主頁回的結果（或錯誤字串）序列化後幾個字。
 */
export const HOST_TOOL_LIMITS = {
  tools: 8,
  descriptionChars: 500,
  parametersBytes: 4 * 1024,
  declarationBytes: 16 * 1024,
  resultChars: 4_000,
} as const;

/** 宿主頁工具的中斷判別值，`input.requested` 酬載的 `kind`。 */
export const HOST_TOOL_INTERRUPT_KIND = 'host_tool';

/** 宿主頁工具那顆 `input.requested` 的酬載。 */
export interface HostToolInterruptPayload {
  readonly kind: typeof HOST_TOOL_INTERRUPT_KIND;
  /** 宣告時的名字，不帶 {@link HOST_TOOL_PREFIX}。 */
  readonly name: string;
  /** 模型給的參數，已照宣告的 schema 驗過。 */
  readonly args: Readonly<Record<string, unknown>>;
}

/** 宿主頁交回的結果：`input.respond` 的 `response`。其他形狀 serve 回 `invalid_argument`，那顆中斷照樣掛著。 */
export type HostToolResponse =
  { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: string };

/** 宿主頁沒在期限內回時，serve 自己交回的錯誤字串。 */
export const HOST_TOOL_TIMEOUT_ERROR = 'timeout';

const encoder = new TextEncoder();

function utf8Bytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

function chars(text: string): number {
  return [...text].length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * `run.start` 的 `host_tools` 合不合格。
 *
 * @returns 不合格的原因（給呼叫端放進 `invalid_argument`）；合格回 `undefined`。
 */
export function hostToolsProblem(raw: unknown): string | undefined {
  if (!Array.isArray(raw)) return 'host_tools 要是陣列';
  if (raw.length > HOST_TOOL_LIMITS.tools) {
    return `host_tools 最多 ${HOST_TOOL_LIMITS.tools} 支，收到 ${raw.length} 支`;
  }
  const seen = new Set<string>();
  for (const [index, tool] of raw.entries()) {
    const where = `host_tools[${index}]`;
    if (!isPlainObject(tool)) return `${where} 要是物件`;
    const extra = Object.keys(tool).filter(
      (key) => key !== 'name' && key !== 'description' && key !== 'parameters',
    );
    if (extra.length > 0) {
      return `${where} 只收 name、description、parameters，多了 ${extra.join('、')}`;
    }
    const { name, description, parameters } = tool;
    if (typeof name !== 'string' || !HOST_TOOL_NAME_PATTERN.test(name)) {
      return `${where}.name 要合 ${HOST_TOOL_NAME_PATTERN.source}`;
    }
    if (seen.has(name)) return `${where}.name ${name} 重名`;
    seen.add(name);
    if (typeof description !== 'string' || description.trim() === '') {
      return `${where}.description 要是非空字串`;
    }
    if (chars(description) > HOST_TOOL_LIMITS.descriptionChars) {
      return `${where}.description 最多 ${HOST_TOOL_LIMITS.descriptionChars} 個字`;
    }
    if (!isPlainObject(parameters) || parameters.type !== 'object') {
      return `${where}.parameters 要是 type 為 object 的 JSON Schema`;
    }
    if (utf8Bytes(parameters) > HOST_TOOL_LIMITS.parametersBytes) {
      return `${where}.parameters 序列化後最多 ${HOST_TOOL_LIMITS.parametersBytes} 位元組`;
    }
  }
  if (utf8Bytes(raw) > HOST_TOOL_LIMITS.declarationBytes) {
    return `host_tools 序列化後最多 ${HOST_TOOL_LIMITS.declarationBytes} 位元組`;
  }
  return undefined;
}

/**
 * 宿主頁交回的 `response` 形狀對不對：`{ ok: true, result }`（`result` 是 JSON 值）或 `{ ok: false, error: string }`，多一格就不對。
 * 不看大小，大小見 {@link hostToolResultProblem}。
 *
 * @returns 不對的原因；對的回 `undefined`。
 */
export function hostToolResponseProblem(raw: unknown): string | undefined {
  const wrong = '宿主頁的回應要是 { ok: true, result } 或 { ok: false, error: string }';
  if (!isPlainObject(raw)) return wrong;
  const keys = Object.keys(raw).sort().join(',');
  if (raw.ok === true && keys === 'ok,result') {
    return JSON.stringify(raw.result) === undefined ? '宿主頁的結果要是 JSON 值' : undefined;
  }
  if (raw.ok === false && keys === 'error,ok' && typeof raw.error === 'string') return undefined;
  return wrong;
}

/**
 * 形狀對的回應，結果（或錯誤字串）序列化後有沒有超過 {@link HOST_TOOL_LIMITS} 的 `resultChars`。
 *
 * @returns 超過時的原因；沒超過回 `undefined`。
 */
export function hostToolResultProblem(response: HostToolResponse): string | undefined {
  const serialized = JSON.stringify(response.ok ? response.result : response.error) ?? '';
  return chars(serialized) > HOST_TOOL_LIMITS.resultChars
    ? `宿主頁回傳的${response.ok ? '結果' : '錯誤'}超過上限：序列化後 ${chars(serialized)} 個字，最多 ${HOST_TOOL_LIMITS.resultChars} 個字`
    : undefined;
}
