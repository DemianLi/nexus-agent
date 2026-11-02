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
 * ## 形狀（#1477：第十一顆搬上 Cordis 樹的插件，第一顆必掛列）
 *
 * 函式插件，具名匯出 `name`／`inject`／`Config`／`manifest`／`apply`，**沒有 default**。相依只有 `@nexus/sdk` 與 `@nexus/system-prompt`
 * （服務的定義）：**沒有一行 `@nexus/core`**（決議 §3-4 第 17 條；#1420 的 lint 規則擋它）。
 *
 * - **提供一個服務**：`systemPrompt`（`@nexus/system-prompt` 1.0.0）。`apply` 裡 `new` 一個繼承 `ContractService` 的類別，建構時
 *   `provide`；用 `new` 不用 `ctx.plugin(Class)`（後者開子 fiber），歸屬（`.provider`）是這一列的 id，宿主據此只把服務折給 active 的這一列。
 *   照 dsh，**三格設定是服務自己的設定**：這個服務建好之後自己登記三段（`harness:identity`、`deployment:persona-prefix`、
 *   `deployment:persona-suffix`），日後 `plan-mode`、`sandbox-policy`、`goal` 遷移時對同一個服務登記它們自己的段。
 * - **宿主消費它，而且取的是快照**：宿主在組 thread 時 `assemble()` 一次，拿各段的原文，之後每次模型呼叫只代入變數、渲染成請求
 *   （`apps/harness/src/system-prompt-middleware.ts`）。所以服務的 `assemble()` 不碰 `this.ctx`，列卸載之後宿主手上的資料仍完整。
 *   前後綴**前置／附加**的渲染住在宿主那一側，不在這裡：渲染要訊息型別與 `wrapModelCall`，插件的 `src` 不 import `@nexus/core`，
 *   也不依賴 `langchain`。
 *
 * 舊的 `NexusPlugin` 外殼（`systemPromptPlugin`、`createSystemPromptPlugin`）不在這裡：它是測試夾具，住在 `apps/harness` 的
 * `system-prompt.fixture.ts`。
 *
 * ## 嚴格插值，而且在掛載當下驗
 *
 * 前後綴裡的 `{{variable}}` 是嚴格的（dsh `README.md:107`）：**未知的變數、註冊了卻沒有值的變數、寫壞的 `{{…}}`
 * 都拋**，不會把字面的 `{{…}}` 送給模型——一份寫壞的提示詞比一個大聲的失敗更糟。單獨一個 `{{` 而後面沒有 `}}`
 * 是普通的字；代入進去的值不會再被掃一次。
 *
 * **掛載當下驗語法與名字，值每次模型呼叫才取**（#1477 Q2 (a)）：這一列自己登記 `model`、`cwd` 兩個名字，`apply` 裡先用一組
 * 空值把前後綴走一遍，寫壞的設定（`{{modle}}`、`{{a b}}`）當場拋 → 這一列掉 → 必掛 → 起不來，跟 #720 一樣；訊息（`SystemPromptTemplateError`）
 * 逐字不變。dsh 在渲染時拋，是因為它的變數會隨每一輪變；我們的名字在掛載當下就全部知道，所以不必等到第一輪才全面失敗。
 * 值（`model`、`cwd`）是宿主每次呼叫交的：`model` 跟著那一步實際用的模型走（#723）。
 *
 * ## 為什麼是宿主那一顆 `wrapModelCall`，而且前綴前置、後綴附加
 *
 * 照 `@nexus/plugin-sandbox-policy` 的先例：`beforeModel` 是圖裡的一個節點，每輪多一格；這裡要做的只是改 system
 * prompt。前綴**前置**——基座與其他 plugin 都是往後 concat，前置是唯一讓它排在它們之前的做法。後綴**附加**，而
 * 「排最後」由宿主掛的 `registry.middleware.use(…, {last:true})` 保證：這顆 middleware 在 `wrapModelCall` 的鏈上排在所有
 * 會附加文字的 plugin 與子代理自帶的 middleware 之後（測試在 `@nexus/harness` 的 `system-prompt-persona.test.ts`，
 * 取模型請求那一層實際送出的文字）。`last` 是 [#720](https://github.com/DemianLi/nexus-agent/issues/720) 加的位置旗標，
 * 理由見 `@nexus/core` 的 `MiddlewarePlacement`。
 *
 * **子代理也走這裡**：`createDeepAgent` 的 `systemPrompt` 只送到 root，子代理只能靠 middleware 拿到部署 persona
 * （卡上第 2 項）。逐委派指定 persona 遮蔽它是 [#328](https://github.com/DemianLi/nexus-agent/issues/328) 的事。
 *
 * ## 登記：`{{cwd}}` 是工具收的位址，不是主機路徑；而且 dsh 沒有 `cwd` 變數
 *
 * **dsh 沒有 `cwd` 這個變數**：loop 只登記 `provider` 與 `model`（`packages/core/agent-loop/src/index.ts:389-390`），
 * `packages/core/system-prompt/README.md:78` 明寫自訂 persona 不可依賴內建的 `{{cwd}}`，目錄文字由 working-directory 服務當字面的
 * 使用者上下文送出。我們登記了 `cwd`，而且出貨的後綴（`cordis.yml`）引用它——**這是我們獨有的變數**（`@nexus/system-prompt` 偏離登記第 8 列）。
 * 要不要拿掉出貨文案裡的 `{{cwd}}` 不在 #1477。（先前這裡寫的「dsh 的 `cwd` 取自 session header，`agent-loop index.ts:372`」已經過時，
 * 那一行現在是 `validateConfiguredAgents`。）
 *
 * 我們的檔案工具收的不是主機路徑：`/` 就是工作區根（有 `--workspace` 時），沒有時是基座的虛擬檔案系統，`/` 一樣是它的根。
 * 把主機路徑講給模型，等於給它一個工具收不下的位址（`@nexus/plugin-sandbox-policy` 檔頭記過，用到檔案工具的 30 輪
 * 裡 23 輪照著那個字串用了主機路徑）。所以宿主交進來的 `cwd` 是 `/`。表達不出來的是 dsh 的那個形狀（工具收
 * 主機路徑）；退到最接近的實作，是把值換成工具的位址空間裡的根。
 *
 * @module
 */

import type { Context } from '@nexus/cordis';
import { ContractService, defineManifest, injectOf } from '@nexus/sdk';
import {
  assertSectionRegistrable,
  interpolateStrict,
  SECTION_ORDERS,
  SYSTEM_PROMPT_MIDDLEWARE_NAME,
  SYSTEM_PROMPT_SECTION_NAMES,
  SYSTEM_PROMPT_VARIABLE_NAMES,
  SystemPromptTemplateError,
  systemPromptToken,
  VARIABLE_NAME,
} from '@nexus/system-prompt';
import type {
  PromptSection,
  SystemPrompt,
  SystemPromptAssembly,
  SystemPromptVariables,
} from '@nexus/system-prompt';
import { z } from 'zod';

// 照舊從這個入口匯出（宿主與測試一直從這裡拿）；定義與實作的出處是 `@nexus/system-prompt`。
export {
  interpolateStrict,
  SYSTEM_PROMPT_MIDDLEWARE_NAME,
  SYSTEM_PROMPT_SECTION_NAMES,
  SYSTEM_PROMPT_VARIABLE_NAMES,
  SystemPromptTemplateError,
};
export type { SystemPromptVariables };

/**
 * 身分句。**寫死在這裡，不是設定**（dsh 同：文字在 `packages/core/system-prompt/src/index.ts:429`）：部署方想換說法，
 * 用 `personaPrefix`；想拿掉，用 `includeHarnessIdentity: false`。名字換成 nexus-agent，其餘照 dsh。
 */
export const HARNESS_IDENTITY_SENTENCE = 'You are an AI agent powered by nexus-agent.';

/**
 * 設定。三格都選填；沒寫的格子回到 dsh 的預設（開身分句、前後綴空）。
 *
 * **patch 是整份取代 `config`**：只寫 `includeHarnessIdentity: false` 的話，前後綴也回到空——出貨那一列把三格全部
 * 寫出來，就是讓照著改的人手上有完整的一份可以抄。
 *
 * 插值的檢查**不在這個 schema 裡**（不用 `refine`）：那樣 `--dump-config-schema` 會把這一列標成不完整，而規格表要
 * 三格都完整。檢查在掛載當下（{@link apply}）。
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

/**
 * 設定對應的三段：身分句（開著才有）、前綴、後綴。**前後綴是空字串也登記**（渲染時空的不佔位），這樣 `assemble()` 的結果
 * 永遠是這三格，不隨設定忽有忽無。
 *
 * @param config - 驗過的設定。
 * @returns 依 order 排好的段。
 */
export function systemPromptSectionsOf(config: SystemPromptConfig): readonly PromptSection[] {
  return [
    ...(config.includeHarnessIdentity
      ? [
          {
            name: SYSTEM_PROMPT_SECTION_NAMES.identity,
            order: SECTION_ORDERS.HARNESS_IDENTITY,
            text: HARNESS_IDENTITY_SENTENCE,
          },
        ]
      : []),
    {
      name: SYSTEM_PROMPT_SECTION_NAMES.prefix,
      order: SECTION_ORDERS.DEPLOYMENT_PERSONA_PREFIX,
      text: config.personaPrefix,
    },
    {
      name: SYSTEM_PROMPT_SECTION_NAMES.suffix,
      order: SECTION_ORDERS.DEPLOYMENT_PERSONA_SUFFIX,
      text: config.personaSuffix,
    },
  ];
}

/**
 * 掛載當下驗前後綴的語法與名字：用一組空值走一遍 {@link interpolateStrict}，寫壞的 `{{…}}`、不合法的名字、不是已登記變數的名字都拋
 * {@link SystemPromptTemplateError}，訊息指名是哪一格（`personaPrefix`／`personaSuffix`）與哪個變數。值不在這裡驗：每次模型呼叫才取。
 *
 * @param config - 驗過的設定。
 * @param names - 已登記的變數名字，依登記順序。
 * @throws {SystemPromptTemplateError} 前後綴的插值壞了。
 */
export function assertTemplatesValid(config: SystemPromptConfig, names: readonly string[]): void {
  const blank = Object.fromEntries(names.map((variable) => [variable, '']));
  interpolateStrict(config.personaPrefix, blank, 'personaPrefix');
  interpolateStrict(config.personaSuffix, blank, 'personaSuffix');
}

/** 插件在樹上的列用的名字（`ctx.fiber.runtime.name`，錯誤訊息、log 與相容層清單用）。 */
export const name = 'system-prompt';

/** 沒有要的服務：這一列是提供者，不消費別的接縫。 */
export const inject = injectOf();

/** 設定的 schema，與 {@link manifest}.config 是同一個物件（一致性套件比對）。 */
export const Config = systemPromptConfigSchema;

export const manifest = defineManifest({
  id: 'system-prompt',
  version: '1.0.0',
  owner: '平台團隊',
  provides: [{ token: systemPromptToken.name, version: systemPromptToken.version }],
  consumes: [],
  config: systemPromptConfigSchema,
  // 換程式碼要重啟行程；設定一改，下一條 thread 看到新的前後綴，開著的不動（#1405、決議 §3-2 第 6 條）。
  reload: { code: 'restart', config: 'next-thread' },
  capabilities: [],
});

/** {@link createSystemPromptService} 的回傳：服務，與登記筆數（一致性套件的 `residue` 用）。 */
export interface SystemPromptServiceHandle {
  readonly service: SystemPrompt;
  /** 目前登記的段與變數名的總數。 */
  registrations(): number;
}

/**
 * 造一份 `systemPrompt` 服務，**狀態活在這次呼叫的閉包裡**（兩列各掛一次各算各的；不是模組層級）。
 *
 * 方法是**原型上的方法、狀態在閉包的陣列**，不用 `#私有欄位`：宿主取到的是 traceable proxy，方法在 proxy 的 shadow 上執行，
 * 私有欄位在那個 receiver 上會拋。`section()`／`variable()` 用 `this.ctx.effect`，`this.ctx` 追蹤到呼叫者，所以登記隨**登記者那一列**撤；
 * `assemble()` 一律不碰 `this.ctx`（見檔頭）。
 *
 * @param ctx - 這一列的 Cordis context。
 */
export function createSystemPromptService(ctx: Context): SystemPromptServiceHandle {
  const sections: PromptSection[] = [];
  const variables: string[] = [];

  class SystemPromptService extends ContractService<SystemPrompt> implements SystemPrompt {
    constructor() {
      super(ctx, systemPromptToken);
    }

    section(section: PromptSection): () => void {
      assertSectionRegistrable(section);
      const entry: PromptSection = {
        name: section.name,
        order: section.order,
        text: section.text,
      };
      return this.ctx.effect(() => {
        if (sections.some((existing) => existing.name === entry.name)) {
          throw new Error(`systemPrompt 的段 ${entry.name} 已經登記過，不能再登記同名的段`);
        }
        sections.push(entry);
        return () => {
          const index = sections.indexOf(entry);
          if (index >= 0) sections.splice(index, 1);
        };
      }, 'systemPrompt.section()');
    }

    variable(variableName: string): () => void {
      if (typeof variableName !== 'string' || !VARIABLE_NAME.test(variableName)) {
        throw new TypeError(
          `systemPrompt.variable() 的名字 "${String(variableName)}" 不合規則：要符合 ${String(VARIABLE_NAME)}`,
        );
      }
      return this.ctx.effect(() => {
        if (variables.includes(variableName)) {
          throw new Error(`systemPrompt 的變數 ${variableName} 已經登記過，不能再登記同名的變數`);
        }
        variables.push(variableName);
        return () => {
          const index = variables.indexOf(variableName);
          if (index >= 0) variables.splice(index, 1);
        };
      }, 'systemPrompt.variable()');
    }

    async assemble(): Promise<SystemPromptAssembly> {
      // 只讀閉包裡的陣列，不碰 `this.ctx`：列卸載之後宿主手上那份資料仍完整，卸載之後再呼叫得到空的（登記已隨列撤掉）。
      return {
        sections: [...sections]
          .sort((left, right) => left.order - right.order)
          .map((s) => ({ ...s })),
        variables: [...variables],
      };
    }
  }

  return {
    service: new SystemPromptService(),
    registrations: () => sections.length + variables.length,
  };
}

/**
 * 掛上身分與 persona。{@link apply} 就是它；回傳 handle 是為了一致性套件量登記筆數。
 *
 * 順序：**先驗再建**。前後綴寫壞時，服務根本沒建起來（沒有任何東西需要撤）。
 *
 * @param ctx - 這一列的 Cordis context。
 * @param config - 驗過的設定。
 * @throws {SystemPromptTemplateError} 前後綴的插值壞了（語法、名字）。
 */
export function mount(ctx: Context, config: SystemPromptConfig): SystemPromptServiceHandle {
  assertTemplatesValid(config, SYSTEM_PROMPT_VARIABLE_NAMES);
  const handle = createSystemPromptService(ctx);
  for (const variable of SYSTEM_PROMPT_VARIABLE_NAMES) handle.service.variable(variable);
  for (const section of systemPromptSectionsOf(config)) handle.service.section(section);
  return handle;
}

/**
 * 掛上身分與 persona：提供 `systemPrompt` 服務，自己登記 `model`、`cwd` 兩個變數名與三段。
 *
 * **每次掛載才有的狀態一律活在這裡**：設定是這一次掛載的，服務建在 `apply` 裡。
 *
 * **單一佔位，重名當場拋**：同名服務由 Cordis 在 `provide` 當場拋，後掛的那一列掉在 `apply`。
 *
 * @param ctx - 這一列的 Cordis context。
 * @param config - 驗過的設定。
 */
export function apply(ctx: Context, config: SystemPromptConfig): void {
  mount(ctx, config);
}
