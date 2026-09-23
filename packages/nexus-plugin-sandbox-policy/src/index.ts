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
 * 沒選它，是因為那等於改圍堵的路徑解析：fence 判準、`workspace-changes` 的路徑正規化
 * （`packages/nexus-plugin-workspace-changes/src/paths.ts`）都假設虛擬路徑。為了一句提示詞
 * 去動擋寫入的那一層，換錯的代價比說錯一句話大。
 * 給人看的 `/sandbox` 輸出照舊報主機路徑：命令不進模型（`@nexus/core` 的 `commands.ts`），
 * 而人要的正是磁碟上的位址。
 *
 * ## 這個 plugin 只在真的有圍堵時才掛
 *
 * dsh 的 `ctx.fs.sandboxMode` 在沒掛圍堵 backend 時是 `undefined`，於是升級欄位不宣告、
 * 政策段落也不貢獻。我們這側對應的事實是 `--workspace`：沒給就沒有
 * `ContainedFilesystemBackend`，檔案跑在基座的 `StateBackend` 裡，**一格圍堵都沒有**。
 * 那種組裝底下講「目前的檔案政策：workspace-write」是**對模型說謊**——它會以為根外被擋著，
 * 而其實整道 fence 不在路徑上。所以掛不掛這個 plugin 由組裝點判，不是由這個檔案判。
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
 * 一格模式對模型講的那一段話。
 *
 * **不收可寫根的主機路徑**：`workspace-write` 那一句用工具的位址空間指名它（`/`），理由見模組註解的登記。
 *
 * @param mode - 這一刻的圍堵強度。
 * @returns 接到 system prompt 後面的那段話。
 */
export function sandboxPolicySentence(mode: SandboxMode): string {
  switch (mode) {
    case 'read-only':
      return (
        '目前的檔案政策：read-only。這個組裝的檔案工具改不動任何檔案。' +
        '**不要只憑這一條就拒絕使用者要的修改**：照常去呼叫工具，被擋下來時照它回的拒絕與升級指引決定下一步。'
      );
    case 'workspace-write':
      return (
        '目前的檔案政策：workspace-write。檔案工具的路徑一律從 `/` 寫起，`/` 就是工作區根' +
        '（例如 `/src/index.ts`、`/notes/todo.md`）；工作區根之下的變更直接放行，不會另外問人。' +
        '不要把磁碟上的絕對路徑傳給檔案工具，那會被當成工作區根底下的一條子路徑。'
      );
    case 'danger-full-access':
      return '目前的檔案政策：danger-full-access。這道圍堵不限制檔案變更。';
  }
}

/**
 * 圍堵政策這個服務的名字。**硬相依**：宣告在 {@link sandboxPolicyPlugin} 的 `requires` 上，
 * 沒人提供就載入失敗——沒有控制器的話這顆 plugin 一件事都做不了。
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

declare module '@nexus/core' {
  interface NexusServices {
    /** 圍堵政策的協作者。見 {@link SANDBOX_POLICY_SERVICE}。 */
    sandboxPolicy: SandboxPolicyService;
  }
}

/**
 * 掌管圍堵模式的 plugin：**把政策講給模型聽、把它記進日誌、讓人切得動它、讓模型
 * 請得到一次升級**。
 *
 * **只在掛了 `ContainedFilesystemBackend` 的組裝上掛它**，理由見模組註解——而那條理由
 * 現在管到三樣東西而不只提示句。**`/sandbox` 也一樣不能在沒有 fence 的組裝上出現**：
 * 一個報告「目前的檔案政策：workspace-write」的命令，在整道 fence 不在路徑上的時候，
 * 說的謊跟那句提示一模一樣，而且它還讓人以為自己切了什麼東西。
 *
 * **模組層級的一顆常數**（[#459](https://github.com/DemianLi/nexus-agent/issues/459)）：
 * 控制器與可寫根走 {@link SANDBOX_POLICY_SERVICE} 注入，所以同一顆可以被好幾次組裝各
 * `apply` 一次——**每次掛載才有的狀態一律活在 `apply` 裡**。
 */
export const sandboxPolicyPlugin: NexusPlugin = {
  name: 'sandbox-policy',
  // **真正擋下來的是下面那行 `use()`**，不是這條宣告：`assertRequires` 跑在每個 `apply`
  // 之後，而 `use()` 在 `apply` 當下就拋。這條是照 dsh 的 `inject` 把相依寫明著——它同時
  // 是把 `use()` 改成 `get()` 那天的第二道網。
  requires: [SANDBOX_POLICY_SERVICE],
  apply(registry) {
    const { controller, rootDir } = registry.services.use(SANDBOX_POLICY_SERVICE);
    const resolveMode = controller.source;
    {
      // **這顆在，工作區就在**：它只在有圍堵的組裝裡掛。`present` 據它回答「有沒有工作區」（#441），
      // 見 `@nexus/core` 的 `WORKSPACE_CAPABILITY`。
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
      // **升級跟著 fence 掛**，同上面那條理由：沒有圍堵的組裝沒有東西可以升。它也是
      // read-only 那句「照升級指引做」成立的前提——這個 plugin 在，那句話就不是空頭支票。
      registerSandboxEscalation(registry, controller);
      registry.commands.register({
        name: SANDBOX_COMMAND_NAME,
        description: SANDBOX_COMMAND_DESCRIPTION,
        input: { hint: SANDBOX_COMMAND_HINT },
        handler: ({ rawInput }) => executeSandboxCommand(controller, rootDir, rawInput),
      });
      registry.middleware.use(
        createMiddleware({
          name: SANDBOX_POLICY_MIDDLEWARE_NAME,
          wrapModelCall: (request, handler) => {
            // 子代理也走這裡（#327），而且講的是**委派那一格**：子代理整個跑在 `task` 的 handler 裡、在下面那顆
            // `wrapToolCall` 包的 ALS 之內，`controller.source` 先讀快照。同 dsh 讀子代理自己 session 上那顆
            // `sandbox/mode { source: 'delegation' }`。
            const sentence = sandboxPolicySentence(resolveMode());
            // 兩條路是同一件事的兩個入口，照抄 plan-mode 那段註解：`systemMessage` 在的
            // 時候接在它後面，不在的時候由 `systemPrompt` 這個字串欄位承接。基座兩個都讀，
            // 給錯那一個等於沒講。
            const { systemMessage } = request;
            return handler(
              systemMessage === undefined
                ? { ...request, systemPrompt: sentence }
                : { ...request, systemMessage: systemMessage.concat(`\n${sentence}`) },
            );
          },
          // **委派那一刻拍下這一格**（#326）：子代理整個在 `task` 那一次呼叫的 handler 裡跑，所以包住
          // handler，子代理的 fence、升級閘門、日誌開啟都讀得到快照。**同步拍**，照 dsh 在子代理啟動的
          // 第一個 await 之前拍（`captureDelegatedPolicyOverrides`）。這顆 middleware 也掛在子代理上（#327），
          // 但子代理手上沒有 `task`（基座的子代理 stack 沒有委派工具），所以這一半只在 root 上作用——拍照本來就是
          // 父代理那側的事。
          wrapToolCall: (request, handler) =>
            resolveToolName(request) === DELEGATION_TOOL_NAME
              ? controller.delegate(() => handler(request))
              : handler(request),
        }),
      );
    }
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
  SANDBOX_ESCALATION_HINT,
  SANDBOX_ESCALATION_TOOL_NAME,
} from './sandbox-escalation.js';
