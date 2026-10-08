/**
 * 圍堵模式的 plugin：**講給模型聽、記進日誌、讓人切得動**。
 *
 * 提示句那一半是 dsh `sandbox:policy` 那條系統提示貢獻的對應物；另外兩半（`/sandbox`
 * 與 `sandbox/mode` 事件）的對應物是 dsh 的 `PermissionPresetService`。**那顆被切的格子
 * 本身住在 {@link ./sandbox-mode.ts | sandbox-mode.ts}**，連同「為什麼不做具名 preset」
 * 與「跨重啟為什麼交不出來」兩條登記。
 *
 * ## 為什麼這一句是承重的，不是裝飾
 *
 * 模式擋得下寫入，但**擋下來之後模型要知道發生了什麼**。不講的話，被擋只會讓它把同一件事
 * 再試一次（或者更糟：它去找一條沒被擋的路）。dsh 把這件事寫成一條每次請求前都貢獻的
 * `sandbox:policy` 段落（`references/deepseek-harness/packages/sandbox/sandbox-policy/src/index.ts:142`）。
 *
 * ## 三件照抄的事
 *
 * 1. **逐次算，不是組裝期算一次。** `text` 在 dsh 那邊是個函式，每次組 prompt 都跑一次。
 *    我們用 `wrapModelCall`，每一次模型呼叫重算——執行期切換那一刀落地時這裡不必動。
 * 2. **`read-only` 那一句明著叫模型「不要先拒絕」。** dsh 的原文是
 *    「Do not refuse a required modification from this policy alone: try an available tool
 *    normally and follow any denial and escalation guidance it returns.」少了這句，模型會
 *    把政策當成「這件事做不到」，於是連試都不試——**那是把一道圍堵變成一個能力謊報**。
 *    **後半句「and escalation guidance」曾經刻意沒抄**：那時我們一句升級指引都沒發，抄了
 *    就是指向一個不存在的東西。升級那一刀（`sandbox-escalation.ts`）落地之後補回來了——
 *    指引騎在拒絕上，這句話叫模型照著做。**模式名不進這一句**，升到哪幾格是工具 schema
 *    的 enum 的事，照 dsh 的分工。
 * 3. **`workspace-write` 那一句要指名可寫根。** 「在工作區之內」對模型不是一個位址。
 *
 * ## 登記：可寫根用工具的位址空間指名，不給主機路徑
 *
 * dsh 那一句給的是主機上的絕對路徑（`JSON.stringify(policy.workspaceRoot)`，
 * `references/deepseek-harness/packages/sandbox/sandbox-policy/src/index.ts:47`，SHA `ddefc45`）。
 * 在 dsh 這句成立，是因為它的檔案工具收的就是主機路徑。**我們的收的不是**：
 * `ContainedFilesystemBackend` 的圍堵靠基座 `FilesystemBackend` 的 `virtualMode: true`
 * （`apps/harness/src/contained-backend.ts`），在那個位址空間裡 `/` 就是工作區根。
 * 主機路徑傳進去會被當成根底下的一條子路徑。所以照抄那個字串，等於給了模型一個工具收不下的位址。
 * 第 2 階段 live 量到的後果：用到檔案工具的 30 輪裡，23 輪照著那個字串用了主機絕對路徑。
 * 工具回「找不到」，模型接著反覆 `ls`、回頭問人、寫到巢狀路徑。
 *
 * 所以只照抄「指名可寫根」這條紀律，位址改用工具收的那一種：`/`，並附一個例子。
 * 句子裡不留主機路徑，括號裡也不放。那個字串就是把模型帶偏的東西。
 *
 * **沒選的另一條路**：讓 backend 也收「主機根＋子路徑」，先剝掉前綴再交給基座，這樣就能維持 dsh 的形狀。
 * 沒選它，是因為那等於改圍堵的路徑解析：fence 判準、把工具路徑對到磁碟的共用規則（`@nexus/core`
 * 的 `virtualPathOf`／`hostPathOf`，present、交付讀檔路由、`workspace-changes` 都走它）都假設虛擬路徑。
 * 改了 backend 就要一起改那一份，`apps/harness/src/virtual-path.test.ts` 會紅著提醒。為了一句提示詞
 * 去動擋寫入的那一層，換錯的代價比說錯一句話大。
 * 給人看的 `/sandbox` 輸出照舊報主機路徑：命令不進模型（`@nexus/core` 的 `commands.ts`），
 * 而人要的正是磁碟上的位址。
 *
 * ## 這個 plugin 是出貨清單上的一列；「有沒有圍堵」是組裝點另外交的一格事實
 *
 * [#669](https://github.com/DemianLi/nexus-agent/issues/669) 之前，組裝點在程式碼裡判「有 `--workspace` 才掛」。現在它是
 * `apps/harness/cordis.yml` 的一列（`sandbox-policy`），掛不掛不再由組裝點的條件判，**分支搬進這個 plugin**，照 dsh：
 *
 * - **政策段落無條件貢獻**（dsh `packages/sandbox/sandbox-policy/src/index.ts:141-150`，`477b4f4`），措辭刻意不宣稱掛了哪些能力
 *   （同檔 `:41`）。**所以我們那句話改成不宣稱圍堵**——以前說「改不動任何檔案」「工作區根之下的變更直接放行」，是把「有一道 fence
 *   在擋」當前提；現在每一句都限定在「受檔案沙箱管的可用操作」（dsh 的措辭），有沒有圍堵都為真。
 * - **看「有沒有圍堵」的是消費端，而且各自反應不同**（dsh `packages/fs/tool-fs/src/sandbox.ts:7` 稱之為 capability fact，
 *   `ctx.fs.sandboxMode`）。我們對應的事實是組裝點經 host 服務交的 {@link FS_CONTAINMENT_SERVICE}：**不拿 `sandboxPolicy`
 *   服務在不在當訊號**——那是控制器，不是事實。有圍堵：控制器、可寫根、`WORKSPACE_CAPABILITY`、`sandbox/mode`、升級、`/sandbox`
 *   全部掛上。沒有圍堵：只貢獻那一句話，其餘一樣都不掛（沒有東西可以切、可以升、可以記）。
 * - **有圍堵卻缺 `sandboxPolicy` 服務：載入當場拋**，訊息指名缺什麼（dsh 的 `tool-str-replace-editor` 有圍堵卻缺政策時同樣當場拋，
 *   `packages/fs/tool-str-replace-editor/src/index.ts:71-74`）。不把「沒有圍堵」與「有圍堵但缺件」併成同一種無聲退路。
 * - **有圍堵時整列被關掉：組裝點起不來**（`apps/harness/src/assembly-root.ts`），同上，因為這時 fence 還在擋、模型卻不知道、也請不到升級。
 *
 * ### 登記：沒有圍堵時 `/sandbox` 不註冊，dsh 是拋錯
 *
 * dsh 的對應物是 permission-presets，它遇到不圍堵的 shell 是**載入就拋**、當設定錯誤（`packages/interaction/permission-presets/src/index.ts:219-220`）。
 * 我們照搬的話，這一列在沒有 `--workspace` 的 CLI 上也在，CLI 就起不來；要照 dsh 拋就得有「按入口參數關掉這一列」的覆寫，那是 #46 Out of
 * scope 的 profile 層。所以退到「不註冊」：淨效果與 dsh 出廠組合相同（沒有圍堵就沒有 `/sandbox`），但**這不是 dsh 的機制**。`/sandbox` 之後由
 * [#437](https://github.com/DemianLi/nexus-agent/issues/437) 的 `/permission` 取代，那張再決定這一格。
 *
 * ## 為什麼是 `wrapModelCall` 而不是 `beforeModel`
 *
 * 照 `@nexus/plugin-plan-mode` 的先例：`beforeModel` 是圖裡的一個節點，每輪多一格；
 * 而這裡要做的只是把一段話接到 system prompt 後面。**用 `concat` 不用取代**——記憶 plugin
 * 與基座的摘要器都在同一份 prompt 上加東西，取代會把它們吃掉。
 *
 * @module
 */

import type { NexusPlugin, PluginEntry } from '@nexus/core';
import { resolveToolName, WORKSPACE_CAPABILITY } from '@nexus/core';
import type { SandboxMode } from '@nexus/core';
import { createMiddleware } from 'langchain';

import { registerSandboxEscalation } from './sandbox-escalation.js';
import {
  executeSandboxCommand,
  SANDBOX_COMMAND_DESCRIPTION,
  SANDBOX_COMMAND_HINT,
  SANDBOX_COMMAND_NAME,
} from './sandbox-mode.js';
import type { SandboxModeController } from './sandbox-mode.js';

/** 這個 middleware 的名字。排序斷言與錯誤訊息用得到。 */
export const SANDBOX_POLICY_MIDDLEWARE_NAME = 'nexusSandboxPolicy';

/**
 * 基座的委派工具。**今天唯一的委派入口**：async 那組掛不上（見 `base-tools.ts`），`thread-pump.ts` 認的也是這個字。
 */
const DELEGATION_TOOL_NAME = 'task';

/**
 * 一格模式對模型講的那一段話，**照 dsh 的措辭：每一句只講「受檔案沙箱管的操作」**
 * （`packages/sandbox/sandbox-policy/src/index.ts` 的 `renderPolicyContext`，`5badb15`）。
 *
 * 這個限定是句子「不宣稱圍堵」的來源：沒有圍堵的組裝上，沒有任何操作受沙箱管，句子照樣為真，
 * 不會暗示根外被擋著。以前的措辭（「改不動任何檔案」「直接放行」）把一道 fence 當前提，沒有圍堵時是謊。
 *
 * **登記：可寫根用工具的位址空間指名（`/`），不給主機路徑**，理由見模組註解的登記。**沒有圍堵時不帶根**
 * （沒有一個「可寫根」可指名；也不能叫模型別傳主機路徑，那是 `virtualMode` 圍堵才有的位址規則）。「平台暫存區也可能可寫」照 dsh 抄那半句，
 * 是個「可能」，不是我們量到的承諾。
 *
 * @param mode - 這一刻的圍堵強度。
 * @param options - `contained`：這次組裝有沒有圍堵（預設有）。決定 `workspace-write` 帶不帶可寫根。
 * @returns 接到 system prompt 後面的那段話。
 */
export function sandboxPolicySentence(
  mode: SandboxMode,
  options: { readonly contained?: boolean } = {},
): string {
  const contained = options.contained ?? true;
  switch (mode) {
    case 'read-only':
      return (
        '目前的檔案政策：read-only。受檔案沙箱管的可用操作，在這個常態模式下不能變更檔案。' +
        '**不要只因這個政策就拒絕必要的修改**：照常去呼叫可用的工具，照它回的拒絕與升級指引決定下一步。'
      );
    case 'workspace-write':
      return (
        '目前的檔案政策：workspace-write。受檔案沙箱管的可用操作可以變更' +
        (contained
          ? '工作區根之下的檔案（檔案工具的路徑一律從 `/` 寫起，`/` 就是工作區根，例如 `/src/index.ts`、`/notes/todo.md`；' +
            '不要把磁碟上的絕對路徑傳給檔案工具，那會被當成工作區根底下的一條子路徑）。'
          : '工作區之下的檔案。') +
        '平台的暫存區也可能可寫。'
      );
    case 'danger-full-access':
      return '目前的檔案政策：danger-full-access。受檔案沙箱管的可用操作，檔案變更不受限制。';
  }
}

/**
 * 沒有圍堵的組裝講哪一格：出廠值。沒有 `--workspace` 就沒有 `--sandbox` 可給（`--sandbox` 要配 `--workspace`），
 * 也沒有控制器可切，所以只有這一格。
 */
export const UNCONTAINED_POLICY_MODE: SandboxMode = 'workspace-write';

/**
 * 圍堵政策這個服務的名字。**有圍堵時是硬相依**：{@link FS_CONTAINMENT_SERVICE} 在而它不在，{@link sandboxPolicyPlugin}
 * 載入當場拋。沒有圍堵時不需要它。
 */
export const SANDBOX_POLICY_SERVICE = 'sandboxPolicy';

/**
 * 圍堵政策的協作者：**這次組裝那一格，加上可寫根**。
 *
 * **傳控制器不傳值**：fence 跟它讀同一顆，兩邊各存一份快照的話，切換那天畫面上講的與
 * 實際擋的會是兩格。
 *
 * **登記：這個包裝物件是我們的，不是 dsh 的形狀。** dsh 的 `SandboxPolicyService` 自己
 * **就是**服務，`workspaceRoot` 是它身上的一個欄位
 * （`references/deepseek-harness/packages/sandbox/sandbox-policy/src/index.ts:110`、`:124`，
 * SHA `6b1808f`），而且控制器由那顆 plugin 自己擁有、Config 收 `{ mode, workspaceRoot }`。
 * 我們表達不出那個形狀：我們的 fence 是 `ContainedFilesystemBackend`，由組裝點建、經
 * `createNexusAgent({ backend })` 交出去，**比 `loadPlugins` 早**，而 deepagents 的
 * backend 是建構參數。所以退到最接近的實作——組裝點擁有控制器，連 `rootDir` 一起注入。
 */
export interface SandboxPolicyService {
  /** 這次組裝那一格。 */
  readonly controller: SandboxModeController;
  /** 可寫根在主機上的絕對路徑。只用在 `/sandbox` 報給人看；講給模型聽的那句不用它，理由見模組註解的登記。 */
  readonly rootDir: string;
}

/**
 * 「這次組裝的檔案系統有圍堵」這一格事實的服務名，對應 dsh 的 `ctx.fs.sandboxMode`（capability fact，
 * `packages/fs/tool-fs/src/sandbox.ts:7`）：**有就是有圍堵，沒有就是沒有**。由組裝點經 host 服務交，與
 * {@link SANDBOX_POLICY_SERVICE}（控制器）分開——訊號不能是控制器在不在。
 */
export const FS_CONTAINMENT_SERVICE = 'fsContainment';

/** 圍堵這件事實。**內容只是個標記**：誰在擋、擋在哪是 {@link SandboxPolicyService} 的事。 */
export interface FsContainment {
  readonly kind: 'contained-filesystem';
}

/** 組裝點交 {@link FS_CONTAINMENT_SERVICE} 時用的那顆值（組裝點與手掛測試共用，免得各自拼字面量）。 */
export const CONTAINED_FILESYSTEM: FsContainment = { kind: 'contained-filesystem' };

declare module '@nexus/core' {
  interface NexusServices {
    /** 圍堵政策的協作者。見 {@link SANDBOX_POLICY_SERVICE}。 */
    sandboxPolicy: SandboxPolicyService;
    /** 檔案系統有圍堵這件事實。見 {@link FS_CONTAINMENT_SERVICE}。 */
    fsContainment: FsContainment;
  }
}

/**
 * 把一格模式講成一段話、接到 system prompt 後面的 middleware。
 *
 * **用 `concat` 不用取代**，兩條入口（`systemMessage` 在、不在）見 plan-mode 那段註解。
 *
 * @param resolveMode - 每次模型呼叫問一次。
 */
function policyPromptMiddleware(
  resolveMode: () => SandboxMode,
  options: { readonly contained: boolean },
) {
  return {
    name: SANDBOX_POLICY_MIDDLEWARE_NAME,
    wrapModelCall: (
      request: Parameters<Parameters<typeof createMiddleware>[0]['wrapModelCall'] & object>[0],
      handler: Parameters<Parameters<typeof createMiddleware>[0]['wrapModelCall'] & object>[1],
    ) => {
      // 子代理也走這裡（#327），而且講的是**委派那一格**：子代理整個跑在 `task` 的 handler 裡、在 `wrapToolCall` 包的 ALS 之內，
      // `controller.source` 先讀快照。同 dsh 讀子代理自己 session 上那顆 `sandbox/mode { source: 'delegation' }`。
      const sentence = sandboxPolicySentence(resolveMode(), options);
      // 兩條路是同一件事的兩個入口，照抄 plan-mode 那段註解：`systemMessage` 在的時候接在它後面，不在的時候由
      // `systemPrompt` 這個字串欄位承接。基座兩個都讀，給錯那一個等於沒講。
      const { systemMessage } = request;
      return handler(
        systemMessage === undefined
          ? { ...request, systemPrompt: sentence }
          : { ...request, systemMessage: systemMessage.concat(`\n${sentence}`) },
      );
    },
  };
}

/**
 * 掌管圍堵模式的 plugin：**把政策講給模型聽；有圍堵時，再把它記進日誌、讓人切得動它、讓模型請得到一次升級**。
 *
 * **出貨清單上的一列**（[#669](https://github.com/DemianLi/nexus-agent/issues/669)），有沒有圍堵由組裝點交的
 * {@link FS_CONTAINMENT_SERVICE} 決定，分岔的理由與 dsh 的對照見模組註解。**`/sandbox` 不能在沒有 fence 的組裝上出現**：
 * 一個報告「目前的檔案政策」的命令，在整道 fence 不在路徑上的時候讓人以為自己切了什麼東西。
 *
 * **模組層級的一顆常數**（[#459](https://github.com/DemianLi/nexus-agent/issues/459)）：
 * 控制器與可寫根走 {@link SANDBOX_POLICY_SERVICE} 注入，所以同一顆可以被好幾次組裝各
 * `apply` 一次——**每次掛載才有的狀態一律活在 `apply` 裡**。
 */
export const sandboxPolicyPlugin: NexusPlugin = {
  name: 'sandbox-policy',
  // **沒有 `requires`**：相依只在有圍堵時成立，由下面的 `use()` 當場擋（`assertRequires` 是無條件的，沒有圍堵的組裝會被它誤殺）。
  apply(registry) {
    if (registry.services.get(FS_CONTAINMENT_SERVICE) === undefined) {
      // **沒有圍堵：只講那一句**。控制器、可寫根、能力、日誌事件、升級、`/sandbox` 一樣都不掛——沒有東西可以切、可以升、可以記。
      registry.middleware.use(
        createMiddleware(
          policyPromptMiddleware(() => UNCONTAINED_POLICY_MODE, { contained: false }),
        ),
      );
      return;
    }
    // 有圍堵卻沒有控制器：當場拋，訊息指名缺什麼。
    if (registry.services.get(SANDBOX_POLICY_SERVICE) === undefined) {
      throw new Error(
        `sandbox-policy：檔案系統有圍堵（${FS_CONTAINMENT_SERVICE} 服務在），卻沒有 ${SANDBOX_POLICY_SERVICE} 服務` +
          '——沒有控制器就沒有東西可以回報政策、切換或升級。組裝點要把這兩個服務一起提供。',
      );
    }
    const { controller, rootDir } = registry.services.use(SANDBOX_POLICY_SERVICE);
    const resolveMode = controller.source;
    // **這顆在，工作區就在**：`present` 據它回答「有沒有工作區」（#441），見 `@nexus/core` 的 `WORKSPACE_CAPABILITY`。
    registry.capabilities.provide(WORKSPACE_CAPABILITY);
    // **root 接控制器**：起始值與之後每一次切換都記。**子代理只記一顆委派那一刻拍下的那一格**
    // （#326，照 dsh `appendDelegatedPolicyOverrides`）：root 之後再切，子代理照舊，所以 root 的日誌
    // 答不出子代理跑在哪一格。子代理的日誌在它第一次 `forCall` 時才開，那一刻在 `task` 的 handler
    // 裡、讀得到快照；不在任何一次委派裡被開的話不寫——拿 root 當下那格去補，寫的就是錯的值。
    registry.sessions.join((subject) => {
      if (subject.address.kind === 'root') return controller.attach(subject.log);
      const mode = controller.delegatedMode;
      if (mode !== undefined) subject.log.append('sandbox/mode', { mode, source: 'delegation' });
      return undefined;
    });
    // **升級跟著 fence 掛**：沒有圍堵的組裝沒有東西可以升。它也是 read-only 那句「照升級指引做」成立的前提。
    registerSandboxEscalation(registry, controller);
    registry.commands.register({
      name: SANDBOX_COMMAND_NAME,
      description: SANDBOX_COMMAND_DESCRIPTION,
      input: { hint: SANDBOX_COMMAND_HINT },
      handler: ({ rawInput }) => executeSandboxCommand(controller, rootDir, rawInput),
    });
    registry.middleware.use(
      createMiddleware({
        ...policyPromptMiddleware(resolveMode, { contained: true }),
        // **委派那一刻拍下這一格**（#326）：子代理整個在 `task` 那一次呼叫的 handler 裡跑，所以包住
        // handler，子代理的 fence、升級工具、日誌開啟都讀得到快照。**同步拍**，照 dsh 在子代理啟動的
        // 第一個 await 之前拍（`captureDelegatedPolicyOverrides`）。這顆 middleware 也掛在子代理上（#327），
        // 但子代理手上沒有 `task`（基座的子代理 stack 沒有委派工具），所以這一半只在 root 上作用——拍照本來就是
        // 父代理那側的事。
        wrapToolCall: (request, handler) =>
          resolveToolName(request) === DELEGATION_TOOL_NAME
            ? controller.delegate(() => handler(request))
            : handler(request),
      }),
    );
  },
};

export default sandboxPolicyPlugin;

/**
 * 建一個條目。**薄薄一層**：控制器與可寫根不從這裡進去，由組裝點當服務提供
 * （見 {@link SANDBOX_POLICY_SERVICE}）。
 *
 * @returns 可以放進組裝點清單的條目。
 */
export function createSandboxPolicyPlugin(): PluginEntry {
  return { plugin: sandboxPolicyPlugin };
}

/**
 * 那顆會被切的格子，與讀它的兩個入口。
 *
 * **組裝點要 `SandboxModeController`**：它由組裝點建、經 {@link SANDBOX_POLICY_SERVICE}
 * 注進來（偏離登記見 {@link SandboxPolicyService}），所以建構那一步在 app 那側。
 * `recordedSandboxMode` 與 {@link SANDBOX_COMMAND_NAME} 則是 `--resume` 與 serve 那兩條
 * 路上讀日誌用的。
 */
export {
  executeSandboxCommand,
  recordedSandboxMode,
  SANDBOX_COMMAND_NAME,
  SandboxModeController,
} from './sandbox-mode.js';

/**
 * 升級那一半對外講的每一句話。
 *
 * 出成公開面是因為**驗收句要對著同一份字串**：走得到產品路徑的那些斷言住在
 * `@nexus/harness` 的 `sandbox-escalation.test.ts`（它們要跑得起一個 agent），
 * 各自複製一份措辭的話，改了話而忘了改測試就會靜靜地綠。
 */
export {
  BLANK_JUSTIFICATION_REFUSAL,
  escalationReason,
  MISSING_TARGET_REFUSAL,
  nonWideningRefusal,
  rejectedRefusal,
  SANDBOX_ESCALATION_HINT,
  SANDBOX_ESCALATION_TOOL_NAME,
  unaskedRefusal,
} from './sandbox-escalation.js';
export type { UnaskedReason } from './sandbox-escalation.js';

declare module '@nexus/core' {
  interface SessionEventMap {
    /**
     * 這個會話的**檔案效果政策**現在是哪一格。**每一筆帶整個值**，不是差異。
     *
     * ## 誰寫它
     *
     * `apps/harness/src/sandbox-mode.ts` 的 `SandboxModeController`：接上一份日誌的當下寫
     * 一顆**起始值**，之後每一次**真的變了**的切換各寫一顆。切到已經生效的那一格不寫
     * ——照 dsh 的「净变化为零的选择不追加任何内容」
     * （`packages/interaction/permission-presets/README.zh.md`）。
     *
     * **子代理的日誌只有一顆，帶 `source: 'delegation'`**（[#326](https://github.com/DemianLi/nexus-agent/issues/326)）：
     * 委派那一刻拍下的那一格，照 dsh 的 `appendDelegatedPolicyOverrides`
     * （`packages/subagent/subagent/src/child-agent.ts`，SHA `0d1f500`）。子代理之後一直照這一格判，root 再切
     * 也不會寫進子代理的日誌——所以 root 的日誌答不出子代理跑在哪一格，要記在這裡。
     *
     * **沒掛 fence 的組裝一顆都不寫。** 沒有 `--workspace` 就沒有
     * `ContainedFilesystemBackend`，沒有東西在擋——那種組裝底下記一顆「政策是
     * workspace-write」是**在日誌裡說謊**，與 `@nexus/plugin-sandbox-policy` 那句提示不貢獻是同一條理由。
     *
     * ## 今天誰讀它，以及誰還讀不到
     *
     * **讀的人是讀日誌的人**：有了它，一份日誌才答得出「這一輪跑的時候檔案政策是哪一格」
     * ——`command/run` 只記得住使用者打了什麼字，記不住生效的值，而 `--sandbox` 給的起始
     * 值在它之前就決定了，命令那條路上根本沒出現過。
     *
     * **它回得到執行期。** CLI 的 `--resume <run 目錄>` 與 serve 碰到以前寫過的 thread 都讀回
     * 那一份日誌，最後一顆就是起始那一格（`sandbox-mode.ts` 的 `recordedSandboxMode`）——
     * [#251](https://github.com/DemianLi/nexus-agent/issues/251) 的門 A。
     */
    'sandbox/mode': {
      readonly mode: SandboxMode;
      /** 委派那一刻拍進子代理日誌的那一顆；省略是 root 的起始值或一次切換。照 dsh 同名欄位。 */
      readonly source?: 'delegation';
    };
  }
}
