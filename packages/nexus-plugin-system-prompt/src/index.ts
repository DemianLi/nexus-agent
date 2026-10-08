/**
 * 系統提示詞的身分與 persona：**部署方寫，模型讀**（[#720](https://github.com/DemianLi/nexus-agent/issues/720)）。
 *
 * 照 dsh 的 `system-prompt` 插件（`packages/core/system-prompt/src/index.ts:407-442`，`477b4f4`）的三格設定：
 *
 * - `includeHarnessIdentity`（預設開）：最前面一句身分句。
 * - `personaPrefix`：身分句之後、其餘一切之前的一段（dsh 的 `deployment:persona-prefix`）。
 * - `personaSuffix`：**最後一段**（dsh 的 `deployment:persona-suffix`）。
 *
 * 順序是身分句 → 前綴 → 其餘（基座與各 plugin 的指引、我們組裝點傳的那句指引）→ 後綴（dsh
 * `packages/core/system-prompt/README.md:137`）。
 *
 * ## 嚴格插值
 *
 * 前後綴裡的 `{{variable}}` 是嚴格的（dsh `README.md:107`）：**未知的變數、註冊了卻沒有值的變數、寫壞的 `{{…}}`
 * 都拋**，不會把字面的 `{{…}}` 送給模型——一份寫壞的提示詞比一個大聲的失敗更糟。單獨一個 `{{` 而後面沒有 `}}`
 * 是普通的字；代入進去的值不會再被掃一次。
 *
 * **在掛載當下算，不是每次請求算**：變數的生產者是組裝點（見 {@link SYSTEM_PROMPT_VARIABLES_SERVICE}），一次組裝
 * 期間不變，所以寫壞的設定在起動時就講，不是等到第一輪才全面失敗。dsh 在渲染時拋，是因為它的變數會隨每一輪變
 * （執行期上下文）；我們今天沒有那種變數。
 *
 * ## 為什麼是一顆 `wrapModelCall`，而且前綴前置、後綴附加
 *
 * 照 `@nexus/plugin-sandbox-policy` 的先例：`beforeModel` 是圖裡的一個節點，每輪多一格；這裡要做的只是改 system
 * prompt。前綴**前置**——基座與其他 plugin 都是往後 concat，前置是唯一讓它排在它們之前的做法。後綴**附加**，而
 * 「排最後」由 `registry.middleware.use(…, {})` 保證：這顆 middleware 在 `wrapModelCall` 的鏈上排在所有
 * 會附加文字的 plugin 與子代理自帶的 middleware 之後（測試在 `@nexus/harness` 的 `system-prompt-persona.test.ts`，
 * 取模型請求那一層實際送出的文字）。`last` 是 [#720](https://github.com/DemianLi/nexus-agent/issues/720) 加的位置旗標，
 * 理由見 `@nexus/core` 的 `MiddlewarePlacement`。
 *
 * **子代理也走這裡**：`createDeepAgent` 的 `systemPrompt` 只送到 root，子代理只能靠 middleware 拿到部署 persona
 * （卡上第 2 項）。逐委派指定 persona 遮蔽它是 [#328](https://github.com/DemianLi/nexus-agent/issues/328) 的事。
 *
 * ## 登記：`{{cwd}}` 是工具收的位址，不是主機路徑
 *
 * dsh 的 `cwd` 取自 session header，是主機上的絕對路徑（dsh `packages/core/agent-loop/src/index.ts:372`）。我們的檔案
 * 工具收的不是主機路徑：`/` 就是工作區根（有 `--workspace` 時），沒有時是基座的虛擬檔案系統，`/` 一樣是它的根。
 * 把主機路徑講給模型，等於給它一個工具收不下的位址（`@nexus/plugin-sandbox-policy` 檔頭記過，用到檔案工具的 30 輪
 * 裡 23 輪照著那個字串用了主機路徑）。所以組裝點交進來的 `cwd` 是 `/`。表達不出來的是 dsh 的那個形狀（工具收
 * 主機路徑）；退到最接近的實作，是把值換成工具的位址空間裡的根。
 *
 * @module
 */

import { taggedRouteOf } from '@nexus/core';
import type { NexusPlugin, PluginEntry, PluginRegistry } from '@nexus/core';
import { SystemMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { z } from 'zod';

/** 這個 middleware 的名字。排序斷言與錯誤訊息用得到。 */
export const SYSTEM_PROMPT_MIDDLEWARE_NAME = 'nexusSystemPrompt';

/**
 * 身分句。**寫死在這裡，不是設定**（dsh 同：文字在 `packages/core/system-prompt/src/index.ts:429`）：部署方想換說法，
 * 用 `personaPrefix`；想拿掉，用 `includeHarnessIdentity: false`。名字換成 nexus-agent，其餘照 dsh。
 */
export const HARNESS_IDENTITY_SENTENCE = 'You are an AI agent powered by nexus-agent.';

/**
 * 前後綴可以引用的變數。
 *
 * - `model`：這一次組裝的模型 id。
 * - `cwd`：檔案工具的位址空間裡的工作目錄；見檔頭的登記，是 `/`。
 */
export interface SystemPromptVariables {
  readonly model: string;
  readonly cwd: string;
}

/**
 * 變數這個服務的名字。**硬相依**：組裝點是唯一知道模型 id 的地方，由它交進來。沒有它，前後綴裡寫了 `{{model}}`
 * 的部署會拿到一個沒有值的變數——所以這顆 plugin 沒有它就載入失敗，不退到某個猜的值。
 */
export const SYSTEM_PROMPT_VARIABLES_SERVICE = 'systemPromptVariables';

declare module '@nexus/core' {
  interface NexusServices {
    /** 系統提示詞前後綴的變數。見 {@link SYSTEM_PROMPT_VARIABLES_SERVICE}。 */
    systemPromptVariables: SystemPromptVariables;
  }
}

/**
 * 設定。三格都選填；沒寫的格子回到 dsh 的預設（開身分句、前後綴空）。
 *
 * **patch 是整份取代 `config`**：只寫 `includeHarnessIdentity: false` 的話，前後綴也回到空——出貨那一列把三格全部
 * 寫出來，就是讓照著改的人手上有完整的一份可以抄。
 *
 * 插值的檢查**不在這個 schema 裡**（不用 `refine`）：那樣 `--dump-config-schema` 會把這一列標成不完整，而規格表要
 * 三格都完整。檢查在掛載當下。
 */
export const systemPromptConfigSchema = z.strictObject({
  includeHarnessIdentity: z
    .boolean()
    .default(true)
    .describe('最前面是否放一句 "You are an AI agent powered by nexus-agent."'),
  personaPrefix: z
    .string()
    .default('')
    .describe('身分句之後、其餘提示詞之前的一段。可以用 {{model}}、{{cwd}}。'),
  personaSuffix: z
    .string()
    .default('')
    .describe('整份系統提示詞的最後一段。可以用 {{model}}、{{cwd}}。'),
});

/** 驗過的設定。 */
export type SystemPromptConfig = z.infer<typeof systemPromptConfigSchema>;

/** 工廠收的東西：schema 的輸入面。 */
export type SystemPromptPluginOptions = z.input<typeof systemPromptConfigSchema>;

/** 變數的名字：寫在括號裡的樣子。 */
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/u;

/** 掃描位置上一組完整的 `{{…}}`（之後再驗名字）。 */
const GROUP_AT = /^\{\{([^{}]*)\}\}/u;

/** 前後綴插值壞掉時拋的錯。訊息指名是哪一格、哪個變數。 */
export class SystemPromptTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SystemPromptTemplateError';
  }
}

/**
 * 嚴格插值一段文字。照 dsh 的 `interpolate`（`packages/core/system-prompt/src/index.ts:319-360`）：
 *
 * - 完整的 `{{name}}` 才算引用，名字要合 `/^[a-z][a-z0-9_]*$/`，不合就拋。
 * - 後面還有 `}}` 卻不是完整一組（例如 `{{a b}}` 之外的殘缺形狀），算寫壞，拋；後面沒有 `}}` 的單獨 `{{` 是普通的字。
 * - 名字沒登記拋，登記了卻沒有值也拋。用 `Object.hasOwn`，不從原型鏈上解析。
 * - 代入進去的值不會再被掃一次。
 *
 * @param text - 前後綴的原文。
 * @param variables - 變數表。
 * @param field - 這段文字在設定裡叫什麼，錯誤訊息指名用。
 * @returns 代入完的文字。
 * @throws {SystemPromptTemplateError} 有未知、沒有值或寫壞的引用。
 */
export function interpolateStrict(
  text: string,
  variables: Readonly<Record<string, string | undefined>>,
  field: string,
): string {
  let result = '';
  let last = 0;
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', last)) {
    const group = GROUP_AT.exec(text.slice(open));
    if (group === null) {
      // 後面還有收尾的 `}}` 代表這是一組寫壞的引用；沒有的話就是普通的字。
      if (text.indexOf('}}', open + 2) >= 0) {
        throw new SystemPromptTemplateError(
          `system-prompt 的 ${field} 有寫壞的變數引用 "${text.slice(open, open + 16)}…"：引用是完整的 {{名字}}`,
        );
      }
      result += text.slice(last, open + 2);
      last = open + 2;
      continue;
    }
    const name = group[0].slice(2, -2);
    if (!VARIABLE_NAME.test(name)) {
      throw new SystemPromptTemplateError(
        `system-prompt 的 ${field} 有寫壞的變數引用 "{{${name}}}"：變數名要符合 ${String(VARIABLE_NAME)}`,
      );
    }
    if (!Object.hasOwn(variables, name)) {
      const known = Object.keys(variables);
      throw new SystemPromptTemplateError(
        `system-prompt 的 ${field} 引用了不存在的變數 "{{${name}}}"；可用的變數：${known.length > 0 ? known.join('、') : '（沒有）'}`,
      );
    }
    const value = variables[name];
    if (value === undefined) {
      throw new SystemPromptTemplateError(
        `system-prompt 的 ${field} 引用的變數 "{{${name}}}" 在這次組裝沒有值`,
      );
    }
    result += text.slice(last, open) + value;
    last = open + group[0].length;
  }
  return result + text.slice(last);
}

/** 算好的兩段：接在最前面的，與接在最後面的。空字串代表那一頭不加東西。 */
export interface SystemPromptParts {
  readonly head: string;
  readonly tail: string;
}

/**
 * 把設定與變數算成前後兩段。**空的段落不佔位**，段與段之間隔一個空行（dsh 的 `renderPrompt` 也是丟掉空段、以空行接）。
 *
 * @param config - 驗過的設定。
 * @param variables - 變數表。
 * @returns 前段（身分句加前綴）與後段（後綴）。
 * @throws {SystemPromptTemplateError} 前後綴的插值壞了。
 */
export function composeSystemPromptParts(
  config: SystemPromptConfig,
  variables: Readonly<Record<string, string | undefined>>,
): SystemPromptParts {
  const head = [
    config.includeHarnessIdentity ? HARNESS_IDENTITY_SENTENCE : '',
    interpolateStrict(config.personaPrefix, variables, 'personaPrefix'),
  ]
    .filter((part) => part.length > 0)
    .join('\n\n');
  const tail = interpolateStrict(config.personaSuffix, variables, 'personaSuffix');
  return { head, tail };
}

/**
 * 把一段文字接在系統訊息的最前面。內容可能是字串，也可能是內容區塊的陣列（提示詞快取那類會把它拆成區塊）。
 */
function prependText(message: SystemMessage, text: string): SystemMessage {
  const { content } = message;
  return new SystemMessage({
    content:
      typeof content === 'string'
        ? `${text}\n\n${content}`
        : [{ type: 'text', text: `${text}\n\n` }, ...content],
  });
}

/**
 * 把前後段接進一次模型請求。兩條入口是同一件事（照 sandbox-policy 那段註解）：`systemMessage` 在的時候改它，不在的時候
 * 由 `systemPrompt` 這個字串欄位承接；**基座兩個都讀，同一個請求裡不能同時改兩個**。
 */
function applyParts<Request extends { systemMessage?: SystemMessage; systemPrompt?: string }>(
  request: Request,
  { head, tail }: SystemPromptParts,
): Request {
  const { systemMessage } = request;
  if (systemMessage === undefined) {
    const body = request.systemPrompt ?? '';
    const text = [head, body, tail].filter((part) => part.length > 0).join('\n\n');
    return { ...request, systemPrompt: text };
  }
  let next = systemMessage;
  if (head.length > 0) next = prependText(next, head);
  if (tail.length > 0) next = next.concat(`\n\n${tail}`);
  return { ...request, systemMessage: next };
}

/**
 * 系統提示詞 plugin。
 *
 * **模組層級的一顆常數**，給 [#454](https://github.com/DemianLi/nexus-agent/issues/454) 從設定檔 import。設定走 `Config`
 * 進來，變數走 {@link SYSTEM_PROMPT_VARIABLES_SERVICE} 進來，所以同一顆可以被好幾次組裝各 `apply` 一次——**每次掛載才有
 * 的狀態一律活在 `apply` 裡**。
 */
export const systemPromptPlugin: NexusPlugin<SystemPromptConfig> = {
  name: 'system-prompt',
  Config: systemPromptConfigSchema,
  requires: [SYSTEM_PROMPT_VARIABLES_SERVICE],
  apply(registry: PluginRegistry, config: SystemPromptConfig): void {
    const variables = registry.services.use(SYSTEM_PROMPT_VARIABLES_SERVICE);
    // 在掛載當下算：寫壞的前後綴在這裡就拋，不會等到第一輪。
    const parts = composeSystemPromptParts(config, { ...variables });
    if (parts.head.length === 0 && parts.tail.length === 0) return;
    // `{{model}}` 跟著這一步實際用的模型走（#723，dsh 在每一步的 `system-prompt/assemble` 重新代入 provider／model）：
    // 只認明著貼過路由標籤的實例（組裝點建的模型實例都有），換模型之後提示詞才不會繼續說自己是原來那顆。
    // 沒貼標籤的（測試替身、子代理自帶的模型）維持組裝時定的那份。同一個 id 只算一次。
    const byModel = new Map<string, SystemPromptParts>();
    const partsFor = (model: unknown): SystemPromptParts => {
      const id = taggedRouteOf(model)?.model;
      if (id === undefined || id === variables.model) return parts;
      let cached = byModel.get(id);
      if (cached === undefined) {
        cached = composeSystemPromptParts(config, { ...variables, model: id });
        byModel.set(id, cached);
      }
      return cached;
    };
    registry.middleware.use(
      createMiddleware({
        name: SYSTEM_PROMPT_MIDDLEWARE_NAME,
        wrapModelCall: (request, handler) =>
          handler(applyParts(request, partsFor((request as { model?: unknown }).model))),
      }),
      // **排在其餘每一顆的內側**：洋蔥的外層先附加、內層後附加，後綴要排最後一段就得在所有會附加文字的
      // middleware（沙箱政策句、計劃模式、goal、子代理自帶的…）之後。前綴是前置，位置不影響它排在最前面。
      { last: true },
    );
  },
};

export default systemPromptPlugin;

/**
 * 建一個條目。**薄薄一層**：設定不在這裡驗，驗在載入的時候——那時候才有 id 可以指名。
 *
 * @param options - 設定，形狀見 {@link systemPromptConfigSchema}。
 * @returns 可以放進組裝點清單的條目。
 */
export function createSystemPromptPlugin(options: SystemPromptPluginOptions = {}): PluginEntry {
  return { plugin: systemPromptPlugin, config: options };
}
