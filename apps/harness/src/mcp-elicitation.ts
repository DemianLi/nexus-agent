/**
 * MCP server 執行到一半反問使用者（elicitation，[#1098](https://github.com/DemianLi/nexus-agent/issues/1098)）：
 * 中斷酬載 ⇄ 線上的問答卡，以及「不問人、由系統代答」的判準。
 *
 * ## 這一層在做什麼
 *
 * `@langchain/mcp-adapters` 2.0.0 在連線開了 `elicitation` 之後，server 反問時把工具呼叫停在一顆 `interrupt()` 上，酬載長這樣
 * （實測，見 `packages/nexus-plugin-mcp` 的 `modern-tools.ts`）：
 *
 * ```
 * { type: 'mcp_elicitation', server, tool, arguments,
 *   requests: { <key>: { mode: 'form', message, requestedSchema } | { mode: 'url', message, url } } }
 * ```
 *
 * 回程要的是 `{ responses: { <key>: { action: 'accept' | 'decline' | 'cancel', content? } } }`，**每一個 key 都要有**，
 * `accept` 的 `content` 由 adapter 照 `requestedSchema` 驗。
 *
 * 線上已經有問答卡（`kind: 'question'`，[#231](https://github.com/DemianLi/nexus-agent/issues/231)）與它的 `origin`、
 * `declined` 回覆（wire 的 `QuestionOrigin`、`declineResponse`）。這一支只做翻譯：
 *
 * - {@link questionPayloadOf}：`form` 的每個欄位變成一題，酬載換成 `{ kind: 'question', questions, origin }` 廣播出去。
 * - {@link answerElicitation}：人回來的 `{ answers }`／`{ declined }`／`{ cancelled }` 翻回 `{ responses }`。
 * - {@link declineAll}：全部回絕，給系統代答用。
 *
 * ## 什麼情況不問人（由 pump 呼叫 {@link systemAnswerReasonOf} 判）
 *
 * - **`url` 模式一律回絕**（PM 2026-10-09 決定）：它要使用者去開一個網址做 OAuth 之類的授權，頁面上沒有可靠的地方承接
 *   （內網環境、沒有回呼），也不該把「去開這個連結」塞成一張只能按拒絕的問答卡。
 * - **子代理一律回絕**：dsh 的外部供應商子代理遇到 elicitation 就 `decline`
 *   （`subagent-claude-code/src/run.ts:351-359`、`subagent-codex/src/wire.ts:614-620`，`5badb150`），不拋錯——
 *   子代理背後沒有人在看，委派時核准政策也釘成 `never`。
 *
 * 回絕的是 MCP 的 `decline`（server 收到「使用者不給」），不是工具錯誤：工具照常回傳，server 自己決定怎麼收尾。
 *
 * @module
 */

import { QUESTION_INTERRUPT_KIND } from '@nexus/core';
import type { QuestionInterruptItem } from '@nexus/core';
import type { QuestionOrigin } from '@nexus/wire';

/** adapter 發的中斷酬載的判別值。 */
export const MCP_ELICITATION_TYPE = 'mcp_elicitation';

/** 一個反問。`form` 要人填欄位；`url` 要人去開網址。 */
export type ElicitationRequest =
  | {
      readonly mode: 'form';
      readonly message: string;
      readonly requestedSchema: Readonly<Record<string, unknown>>;
    }
  | { readonly mode: 'url'; readonly message: string; readonly url: string };

/** 驗過形狀的 adapter 酬載。 */
export interface McpElicitation {
  readonly server: string;
  readonly tool: string;
  readonly arguments: unknown;
  readonly requests: Readonly<Record<string, ElicitationRequest>>;
}

/** 回給 adapter 的一個 key 的動作。 */
export type ElicitationAction = 'accept' | 'decline' | 'cancel';

/** 回給 adapter 的整份回覆。 */
export interface ElicitationResponses {
  readonly responses: Readonly<
    Record<
      string,
      { readonly action: ElicitationAction; readonly content?: Record<string, unknown> }
    >
  >;
}

/** 系統代答的理由，原樣記進日誌的 `interrupt/system-answered`。 */
export type SystemAnswerReason = 'url-mode' | 'subagent';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 認出 adapter 的反問酬載。**形狀不對就當作不是**（回 `undefined`），讓它走一般中斷的路——
 * 認錯的代價是把別的東西當成反問回絕。
 */
export function parseMcpElicitation(value: unknown): McpElicitation | undefined {
  if (!isRecord(value) || value['type'] !== MCP_ELICITATION_TYPE) return undefined;
  const { server, tool, requests } = value;
  if (typeof server !== 'string' || typeof tool !== 'string' || !isRecord(requests)) {
    return undefined;
  }
  const parsed: Record<string, ElicitationRequest> = {};
  for (const [key, request] of Object.entries(requests)) {
    if (!isRecord(request) || typeof request['message'] !== 'string') return undefined;
    if (request['mode'] === 'form' && isRecord(request['requestedSchema'])) {
      parsed[key] = {
        mode: 'form',
        message: request['message'],
        requestedSchema: request['requestedSchema'],
      };
    } else if (request['mode'] === 'url' && typeof request['url'] === 'string') {
      parsed[key] = { mode: 'url', message: request['message'], url: request['url'] };
    } else {
      return undefined;
    }
  }
  if (Object.keys(parsed).length === 0) return undefined;
  return { server, tool, arguments: value['arguments'], requests: parsed };
}

/** 這顆反問裡 `url` 模式的 key。 */
export function urlKeysOf(elicitation: McpElicitation): string[] {
  return Object.entries(elicitation.requests)
    .filter(([, request]) => request.mode === 'url')
    .map(([key]) => key);
}

/** 這顆反問裡 `form` 模式的 key。 */
export function formKeysOf(elicitation: McpElicitation): string[] {
  return Object.entries(elicitation.requests)
    .filter(([, request]) => request.mode === 'form')
    .map(([key]) => key);
}

/**
 * 這顆反問**要不要整顆由系統代答**；要的話回理由，要問人就回 `undefined`。
 *
 * @param elicitation - 驗過形狀的酬載。
 * @param isSubagent - 這顆中斷是不是子代理發的。
 */
export function systemAnswerReasonOf(
  elicitation: McpElicitation,
  isSubagent: boolean,
): SystemAnswerReason | undefined {
  if (isSubagent) return 'subagent';
  return formKeysOf(elicitation).length === 0 ? 'url-mode' : undefined;
}

/** 全部回絕。 */
export function declineAll(
  elicitation: McpElicitation,
  action: 'decline' | 'cancel' = 'decline',
): ElicitationResponses {
  return {
    responses: Object.fromEntries(
      Object.keys(elicitation.requests).map((key) => [key, { action }]),
    ),
  };
}

/** 一個欄位對應的一題。 */
interface Field {
  /** 題目 id（`<key>/<欄位名>`；沒有欄位的表單用 `<key>`）。 */
  readonly id: string;
  readonly key: string;
  /** 欄位名；沒有欄位的表單是 `undefined`。 */
  readonly name: string | undefined;
  readonly schema: Record<string, unknown>;
  readonly required: boolean;
  /** 選項標籤 → 實際的值。沒有選項的欄位是空的。 */
  readonly values: ReadonlyMap<string, unknown>;
  readonly kind: 'text' | 'number' | 'integer' | 'boolean' | 'choice' | 'multi' | 'confirm';
}

const CONFIRM_LABEL = '確認';
const TRUE_LABEL = '是';
const FALSE_LABEL = '否';

/** 一個 enum 欄位的選項：`oneOf`／`anyOf` 的 `const`＋`title`，或單純的 `enum`（可配 `enumNames`）。 */
function choicesOf(
  schema: Record<string, unknown>,
): { label: string; value: unknown }[] | undefined {
  const tagged = schema['oneOf'] ?? schema['anyOf'];
  if (Array.isArray(tagged)) {
    const choices = tagged.flatMap((entry: unknown) => {
      if (!isRecord(entry) || !('const' in entry)) return [];
      const title = entry['title'];
      return [
        {
          label: typeof title === 'string' ? title : String(entry['const']),
          value: entry['const'],
        },
      ];
    });
    return choices.length > 0 ? choices : undefined;
  }
  const values = schema['enum'];
  if (!Array.isArray(values)) return undefined;
  const names = schema['enumNames'];
  return values.map((value: unknown, index) => ({
    label:
      Array.isArray(names) && typeof names[index] === 'string'
        ? (names[index] as string)
        : String(value),
    value,
  }));
}

function fieldsOf(elicitation: McpElicitation): Field[] {
  const fields: Field[] = [];
  for (const [key, request] of Object.entries(elicitation.requests)) {
    if (request.mode !== 'form') continue;
    const properties = request.requestedSchema['properties'];
    const entries = isRecord(properties) ? Object.entries(properties) : [];
    if (entries.length === 0) {
      fields.push({
        id: key,
        key,
        name: undefined,
        schema: {},
        required: true,
        values: new Map([[CONFIRM_LABEL, undefined]]),
        kind: 'confirm',
      });
      continue;
    }
    const required = request.requestedSchema['required'];
    for (const [name, raw] of entries) {
      const schema = isRecord(raw) ? raw : {};
      const base = {
        id: `${key}/${name}`,
        key,
        name,
        schema,
        required: Array.isArray(required) && required.includes(name),
      };
      const type = schema['type'];
      const items = isRecord(schema['items']) ? schema['items'] : {};
      const multi = type === 'array' ? choicesOf(items) : undefined;
      const single = type === 'array' ? undefined : choicesOf(schema);
      if (multi !== undefined) {
        fields.push({
          ...base,
          values: new Map(multi.map((c) => [c.label, c.value])),
          kind: 'multi',
        });
      } else if (single !== undefined) {
        fields.push({
          ...base,
          values: new Map(single.map((c) => [c.label, c.value])),
          kind: 'choice',
        });
      } else if (type === 'boolean') {
        fields.push({
          ...base,
          values: new Map<string, unknown>([
            [TRUE_LABEL, true],
            [FALSE_LABEL, false],
          ]),
          kind: 'boolean',
        });
      } else if (type === 'number' || type === 'integer') {
        fields.push({ ...base, values: new Map(), kind: type });
      } else {
        fields.push({ ...base, values: new Map(), kind: 'text' });
      }
    }
  }
  return fields;
}

/** 線上的來源標註：畫面據它說「哪台 server、哪支工具在問」。 */
export function originOf(elicitation: McpElicitation): QuestionOrigin {
  return {
    kind: 'mcp-elicitation',
    server: elicitation.server,
    tool: elicitation.tool,
    arguments: elicitation.arguments,
  };
}

/**
 * 反問酬載 → 廣播出去的問答酬載。每個 `form` 的欄位一題；`message` 是 server 寫給人看的話，放在該表單第一題的 `detail`。
 * `url` 模式的不出題（由系統回絕，見檔頭）。
 */
export function questionPayloadOf(elicitation: McpElicitation): {
  readonly kind: typeof QUESTION_INTERRUPT_KIND;
  readonly questions: readonly QuestionInterruptItem[];
  readonly origin: QuestionOrigin;
} {
  const seen = new Set<string>();
  const questions = fieldsOf(elicitation).map((field): QuestionInterruptItem => {
    const request = elicitation.requests[field.key];
    const message = request?.mode === 'form' && !seen.has(field.key) ? request.message : undefined;
    seen.add(field.key);
    const description = field.schema['description'];
    const title = field.schema['title'];
    const detail = [message, typeof description === 'string' ? description : undefined]
      .filter((part): part is string => part !== undefined && part !== '')
      .join('\n\n');
    return {
      id: field.id,
      question:
        field.kind === 'confirm'
          ? (message ?? field.key)
          : typeof title === 'string'
            ? title
            : (field.name ?? field.key),
      ...(detail === '' || field.kind === 'confirm' ? {} : { detail }),
      ...(field.values.size === 0
        ? {}
        : { options: [...field.values.keys()].map((label) => ({ label })) }),
      ...(field.kind === 'multi' ? { multiSelect: true } : {}),
    };
  });
  return { kind: QUESTION_INTERRUPT_KIND, questions, origin: originOf(elicitation) };
}

interface WireAnswer {
  readonly id?: unknown;
  readonly selected?: unknown;
  readonly custom?: unknown;
}

/**
 * 人回來的東西 → adapter 要的 `{ responses }`。
 *
 * - `{ cancelled: true }` → 每個 key 都 `cancel`；`{ declined: true }` → 每個 key 都 `decline`。
 * - `{ answers }` → 每個 `form` 的 key 都 `accept`，欄位值照型別換回去；沒填的非必填欄位不放。`url` 的 key 一律 `decline`。
 *   沒有欄位的確認表單：選了「確認」才 `accept`，否則 `decline`。
 *
 * **不替人做合法性的決定**：數字欄位填了不是數字就把原字串送過去，由 adapter 照 schema 驗並讓工具報錯，而不是在這裡
 * 默默丟掉或改成別的值。
 *
 * @throws 回覆既不是 `cancelled`、`declined` 也不是 `{ answers: [...] }`。
 */
export function answerElicitation(
  elicitation: McpElicitation,
  reply: unknown,
): ElicitationResponses {
  if (!isRecord(reply)) throw new Error('MCP 反問的回覆看不懂：不是物件');
  if (reply['cancelled'] === true) return declineAll(elicitation, 'cancel');
  if (reply['declined'] === true) return declineAll(elicitation, 'decline');
  const answers = reply['answers'];
  if (!Array.isArray(answers)) {
    throw new Error(
      'MCP 反問的回覆看不懂：要 { answers }、{ declined: true } 或 { cancelled: true }',
    );
  }
  const byId = new Map<string, WireAnswer>();
  for (const answer of answers as WireAnswer[]) {
    if (typeof answer?.id === 'string') byId.set(answer.id, answer);
  }
  const contents = new Map<string, Record<string, unknown>>();
  const declined = new Set<string>(urlKeysOf(elicitation));
  for (const field of fieldsOf(elicitation)) {
    const answer = byId.get(field.id);
    const selected = Array.isArray(answer?.selected)
      ? (answer.selected as unknown[]).filter((item): item is string => typeof item === 'string')
      : [];
    const custom = typeof answer?.custom === 'string' ? answer.custom.trim() : '';
    const content = contents.get(field.key) ?? {};
    contents.set(field.key, content);
    if (field.kind === 'confirm') {
      if (!selected.includes(CONFIRM_LABEL)) declined.add(field.key);
      continue;
    }
    const name = field.name as string;
    switch (field.kind) {
      case 'choice':
      case 'boolean': {
        const picked = selected[0];
        if (picked !== undefined && field.values.has(picked))
          content[name] = field.values.get(picked);
        else if (custom !== '') content[name] = custom;
        break;
      }
      case 'multi': {
        const picked = selected.filter((label) => field.values.has(label));
        if (picked.length > 0 || field.required)
          content[name] = picked.map((label) => field.values.get(label));
        break;
      }
      case 'number':
      case 'integer':
        if (custom !== '') content[name] = Number.isNaN(Number(custom)) ? custom : Number(custom);
        break;
      case 'text':
        if (custom !== '') content[name] = custom;
        else if (selected.length > 0) content[name] = selected[0];
        break;
    }
  }
  const responses: Record<
    string,
    { action: ElicitationAction; content?: Record<string, unknown> }
  > = {};
  for (const key of Object.keys(elicitation.requests)) {
    responses[key] = declined.has(key)
      ? { action: 'decline' }
      : { action: 'accept', content: contents.get(key) ?? {} };
  }
  return { responses };
}
