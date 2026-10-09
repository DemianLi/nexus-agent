/**
 * 模型那一側的升級：`request_sandbox_escalation`，**在工具本體裡問人**。
 *
 * [#238](https://github.com/DemianLi/nexus-agent/issues/238) 第 2 項。載體是**另開一顆工具**
 * （甲），偏離登記在那張卡上：langchain 在 `wrapModelCall` 回程上拒絕同名不同實例的工具
 * （`AgentNode.ts:601-609`），所以 dsh 攤進 `write`／`edit` schema 的那兩個欄位在我們這側
 * 沒有地方掛。那條基座行為的絆索在 `escalation-carrier.test.ts`。
 *
 * ## 照 dsh 的六條
 *
 * 出處都是 `references/deepseek-harness/packages/sandbox/sandbox/src/escalation.ts`。
 *
 * 0. **問人在工具本體裡，fail-closed**（[#700](https://github.com/DemianLi/nexus-agent/issues/700)）。
 *    dsh 的 `resolvePolicy` 先驗欄位（`packages/fs/tool-fs/src/sandbox.ts:88`），再
 *    `await approveEscalation(...)`：不加寬就拋、沒有核准服務就拋、最後才問人（`escalation.ts:171-208`）。
 *    核准在工具自己的路徑上，所以 pre-execute 的 listener 怎麼排都跳不過它。以前這裡是另一個註冊點上
 *    一顆只認這個名字的核准閘門，排在它前面、回 `allow` 又不呼叫 `next()` 的閘門會把它
 *    整個短路掉，工具照樣回「核准了」。中斷照 `@nexus/plugin-ask-user` 的先例在本體裡 `interrupt()`，
 *    酬載與核准閘門同形（`@nexus/core` 的 `approval.ts`），web 那側一行都不用動。
 * 1. **嚴格加寬是執行期檢查，不是 schema 約束。** schema 的 enum 是封閉的目標詞彙
 *    {@link ESCALATION_TARGETS}，**不隨當前模式收窄**；「比現在寬」在本體裡對這一刻的模式判。
 *    理由照 dsh：schema 是全域的，當前模式是逐次呼叫的事實。收窄 enum 會讓一個被 `/sandbox`
 *    切窄的 session 連升級的槓桿都看不到。enum 外的值（含 `read-only`）在 schema 那一關就被擋，
 *    走不到本體，同 dsh 的 schema-pinned。
 * 2. **不加寬的請求不問人。** 本體在發中斷之前就回拒絕，核准卡一張都不掛。
 * 3. **欄位要齊、理由不能是空白。** dsh 的 `validateEscalationArgs`。
 * 4. **理由的消費者是人。** 它原樣進核准卡的那句話（dsh：`escalate sandbox to ${mode}: ${justification}`）。
 * 5. **被擋的當下就講得出能升級。** 指引騎在拒絕上（{@link SANDBOX_ESCALATION_HINT}，對應
 *    dsh 的 `escalationHintMarker`），不靠模型記得工具描述。
 *
 * ## fail-closed 的出口，各有各的話
 *
 * 依本體判的先後排。**全部由這裡說**，照 dsh 的 `approveEscalation` 自己寫一套，不借核准閘門的話：
 *
 * | 出口 | 這裡的哪一句 | 人被問到了嗎 |
 * | --- | --- | --- |
 * | 沒指名檔案、理由空白 | {@link MISSING_TARGET_REFUSAL}、{@link BLANK_JUSTIFICATION_REFUSAL} | 沒有 |
 * | 不加寬 | {@link nonWideningRefusal} | 沒有 |
 * | 子代理 | {@link unaskedRefusal}（`delegated`） | 沒有 |
 * | 這個 session 關掉了人工核准 | {@link unaskedRefusal}（`policy-never`） | 沒有 |
 * | 沒有 checkpointer | {@link unaskedRefusal}（`no-channel`） | 沒有 |
 * | 組裝點沒提供核准管道 | {@link unaskedRefusal}（`no-service`） | 沒有 |
 * | 被拒 | 人給的理由，或 {@link rejectedRefusal} | 有 |
 *
 * 沒提供核准管道那一條是 dsh 的「no approval service is composed」：**讀不到就當作沒有人可問**，不像
 * `ask_user_question` 退到 `{ kind: 'human' }`。dsh 的 `cancelled` 在我們這側**沒有對應物**（`approval.ts`
 * 的 `ApprovalChannel` 那段記過）；dsh 的「沒有 agent 可以路由」也沒有——我們每一次工具呼叫都在某個 agent 裡。
 *
 * **子代理怎麼拒**：照 #324，子代理不問人升級（dsh 把核准政策 `'never'` 帶進子代理，那條在 `ask` 裡回 `rejected`）；
 * 本體在委派快照裡（{@link SandboxModeController.delegatedMode} 有值）就拒。[#328](https://github.com/DemianLi/nexus-agent/issues/328) 第 1 項
 * 之後前景子代理的**一般**核准會交給使用者，升級卻不跟：控制器在委派裡 `grant` 不做事（下一節），人核准了也認領不到，
 * 問了就是騙人。所以理由不再是「政策關掉了」，是 {@link UnaskedReason} 的 `delegated`。判在加寬**之後**，同 dsh 的先後：不加寬的請求在子代理裡照樣拿到不加寬那句。
 * 不用 `rootOnly` 的拒絕樁，因為樁會把整顆工具換掉、連加寬都不判。
 *
 * ## 偏離：grant 綁目標、跨兩顆呼叫
 *
 * dsh 把核准來的模式**蓋在同一顆呼叫上**；我們的請求與重試是兩顆，中間隔著一顆一次性的
 * grant，而它**綁住模型指名的那個檔，也綁住那個檔剛被擋下的那一次**（操作與內容摘要，
 * [#254](https://github.com/DemianLi/nexus-agent/issues/254)）。為什麼兩樣都要綁，見
 * `@nexus/core` 的 `SandboxGrant`（fence 與這顆格子之間的合約）：綁檔是因為基座的摘要器也會走 `write`；綁那一次是
 * 因為升級卡上看不到內容，而 `write_file` 的重試沒有自己的卡——在 dsh，人核准的那顆就是
 * 會執行的那顆，這裡要靠綁住才成立。
 *
 * **grant 不會過期。** 它只蓋一個 canonical 目標、用過一次就沒了；沒被用掉的那顆會一直等到
 * 下一顆打到同一個檔、而且被擋下的變更。要有時效是另一顆機制，今天沒做。
 *
 * **subagent 拿不到 grant**（[#326](https://github.com/DemianLi/nexus-agent/issues/326)）：子代理的升級在本體裡
 * 被當成 `delegated` 拒掉（上一節）；root 手上那顆也認領不到——控制器在委派裡 `grant` 不做事、`peekGrant`
 * 回空、`recordDenial` 不寫（見 `sandbox-mode.ts`）。本體判「加寬」讀 `controller.current`，在子代理裡就是
 * 委派那一刻拍下的那一格。
 *
 * @module
 */

import { tool } from '@langchain/core/tools';
import { interrupt } from '@langchain/langgraph';
import type { ApprovalChannel, ApprovalPolicySource, NexusPlugin } from '@nexus/core';
import {
  APPROVAL_INTERRUPT_KIND,
  APPROVAL_POLICY_SERVICE,
  APPROVAL_REJECTED_BY_USER,
  approvalDenied,
  CHANNEL_SERVICE,
  toolCallIdOf,
  toolRefusal,
} from '@nexus/core';
import { z } from 'zod';

import type { SandboxMode, ToolErrorInfo } from '@nexus/core';
import type { SandboxModeController } from './sandbox-mode.js';

/** 模型看到的工具名。核准卡（中斷酬載的 `actionRequests[].name`）帶的就是這個字串，所以它是導出的。 */
export const SANDBOX_ESCALATION_TOOL_NAME = 'request_sandbox_escalation';

/**
 * 升級的封閉目標詞彙：任何一次呼叫**可能**升到的每一格。`read-only` 是地板，沒有人升到它。
 *
 * 照 dsh 的 `ESCALATION_TARGETS`：公告時不隨當前模式收窄，理由見模組註解第 1 條。
 */
export const ESCALATION_TARGETS = ['workspace-write', 'danger-full-access'] as const;

/** 嚴格加寬表：鍵是這一刻的模式，值是它能升到的那幾格。照 dsh 的 `WIDER_MODES`。 */
export const WIDER_MODES: Readonly<Record<SandboxMode, readonly SandboxMode[]>> = {
  'read-only': ['workspace-write', 'danger-full-access'],
  'workspace-write': ['danger-full-access'],
  'danger-full-access': [],
};

/**
 * `requested` 是不是比 `current` 嚴格更寬。
 *
 * 收 `unknown` 是防守：本體拿到的參數已經過 schema 的 enum，但這個判準不靠它——一個認不得的
 * 字串在這裡就是「不加寬」。
 *
 * @param current - 這一刻的模式。
 * @param requested - 模型要的那一格，未驗證。
 * @returns 嚴格更寬時為真。
 */
export function isStrictlyWider(
  current: SandboxMode,
  requested: unknown,
): requested is SandboxMode {
  return WIDER_MODES[current].some((mode) => mode === requested);
}

/**
 * 被擋下時接在拒絕後面的那一行。對應 dsh 的 `escalationHintMarker`：
 * 「retry this exact operation once with sandbox_permissions + justification; the approval
 * prompt asks the user」。多出來的是 `file_path`——grant 綁目標，見模組註解。
 *
 * 開頭跟拒絕共用 `[containment]`：同一條政策在模型眼裡只有一套詞彙（#238 第 3 項）。
 */
export const SANDBOX_ESCALATION_HINT =
  `[containment] 可以升級：呼叫 ${SANDBOX_ESCALATION_TOOL_NAME}，file_path 填這一個檔、` +
  'sandbox_permissions 選夠用的最窄那一格、justification 寫一句給人看的理由；核准卡會去問人。' +
  '核准之後把這一次操作原樣重試一次——只蓋這個檔的這一次操作、只蓋一次，內容改了就不算。';

/**
 * 不加寬的請求的那句話。
 * @param requested - 模型要的那一格，未驗證。
 * @param current - 這一刻的模式。
 * @returns 給模型的拒絕。
 */
export function nonWideningRefusal(requested: unknown, current: SandboxMode): string {
  return (
    `升級到 ${JSON.stringify(requested)} 並不比這次呼叫現在的 "${current}" 更寬，` +
    '所以沒有去問人。'
  );
}

/** 沒指名檔案的那句話。 */
export const MISSING_TARGET_REFUSAL =
  'file_path 是空的——升級只蓋一個檔，要指名剛才被擋下的那一個，所以沒有去問人。';

/** 理由空白的那句話。 */
export const BLANK_JUSTIFICATION_REFUSAL =
  'justification 是空的——一張沒有理由的升級核准卡是壞掉的請求，所以沒有去問人。';

/**
 * 沒有人可問的原因：核准管道的兩格非人、組裝點根本沒提供管道，加上**核准政策是 `never`**
 * （[#437](https://github.com/DemianLi/nexus-agent/issues/437)：有人在，但使用者選了不問）。
 */
export type UnaskedReason =
  Exclude<ApprovalChannel['kind'], 'human'> | 'no-service' | 'approval-never' | 'delegated';

/**
 * 加寬、但沒有人可問的那句話。**三種原因各說各的**，同核准閘門的紀律（`approval.ts` 的
 * `ApprovalChannel` 那段）：模型要分得出「沒有人被問到」與「有人拒絕了」。
 * @param reason - 為什麼沒有人可問。
 * @param requested - 模型要的那一格。
 * @returns 給模型的拒絕。
 */
export function unaskedRefusal(reason: UnaskedReason, requested: SandboxMode): string {
  const head = `升級到 "${requested}" 要人核准，`;
  switch (reason) {
    case 'policy-never':
      return (
        `${head}但這個 session 關掉了人工核准，所以沒有去問人。` +
        '這不是有人拒絕了它——是沒有人被問到。'
      );
    case 'no-channel':
      return (
        `${head}但這次組裝沒有 checkpointer，核准之後接不回來，所以沒有去問人。` +
        '這不是有人拒絕了它——是沒有可用的核准管道。'
      );
    case 'approval-never':
      return (
        `${head}但這個 session 的核准政策是不問（never），所以沒有去問人。` +
        '這不是有人拒絕了它——是沒有人被問到。'
      );
    case 'delegated':
      return (
        `${head}但子代理拿不到升級的核准——升級只在主對話生效，所以沒有去問人。` +
        '這不是有人拒絕了它——是沒有人被問到。需要的話，在回覆裡說明，讓委派你的 agent 處理。'
      );
    case 'no-service':
      return (
        `${head}但這次組裝沒有提供核准管道，所以沒有去問人。` +
        '這不是有人拒絕了它——是組裝點沒接上問人的那條路。'
      );
  }
}

/**
 * 人按了拒絕、又沒給理由時的那句話。照 dsh：它照舊被擋，停下來說明，不要繞路。
 * @param target - 模型指名的檔。
 * @param requested - 模型要的那一格。
 * @returns 給模型的拒絕。
 */
export function rejectedRefusal(target: string, requested: SandboxMode): string {
  return (
    `有人看過並拒絕了把 ${JSON.stringify(target)} 升到 ${requested}。` +
    '它照舊被擋，停下來說明，不要換條路繞過去。'
  );
}

/**
 * 核准卡上的那句話。**理由原樣放進去**，它的讀者是人（模組註解第 4 條）。
 * @param target - 模型指名的檔。
 * @param mode - 要升到的那一格。
 * @param justification - 模型的理由。
 * @returns 核准卡的描述。
 */
export function escalationReason(target: string, mode: SandboxMode, justification: string): string {
  return `把 ${JSON.stringify(target)} 的檔案政策升到 ${mode}，只蓋這一次：${justification}`;
}

/**
 * 工具描述。**命令句**：軟提示壓不動模型（#231 第 1 項），而這顆工具最貴的失敗是被拒絕之後
 * 換一條路再寫一次。
 */
export const SANDBOX_ESCALATION_DESCRIPTION =
  '檔案變更被圍堵擋下來、而這件事真的需要更寬的權限時，用這個工具請人核准一次升級。' +
  '**只在剛被擋下之後用**，file_path 填被擋的那個檔；核准之後把那一次操作原樣重試一次。' +
  '一次核准只蓋被擋下的那一次操作：同一個檔、同樣的內容、只蓋一次；改了內容就要重新升級。' +
  '被拒絕時不要換個路徑再寫，去問人為什麼。';

const escalationSchema = z.object({
  file_path: z.string().describe('剛才被擋下的那個檔，照被擋的那次呼叫的寫法填。'),
  sandbox_permissions: z.enum(ESCALATION_TARGETS).describe('要升到哪一格。選夠用的最窄那一格。'),
  justification: z.string().describe('一句話，給按核准的人看：為什麼這一次操作需要更寬的權限。'),
});

/** 這次執行拿到的 runtime。只用得到一格，所以不整包相依基座的型別。 */
interface ToolRuntimeLike {
  readonly toolCall?: { readonly id?: string };
}

/** 人回來的東西。形狀與核准閘門收的相同（`approval.ts`）。 */
interface EscalationVerdict {
  readonly decisions?: readonly { readonly type?: string; readonly message?: string }[];
}

/**
 * @param controller - 這次組裝那一格。
 * @param channel - 這次組裝有沒有人可以按核准；組裝點沒提供時是 `undefined`，當作沒有人可問。
 * @param approvalPolicy - 核准政策的來源（#437），**每次問人之前讀一次**；`never` 就不問。沒有提供時當作 `ask`。
 */
function createEscalationTool(
  controller: SandboxModeController,
  channel: ApprovalChannel | undefined,
  approvalPolicy: ApprovalPolicySource | undefined,
) {
  return tool(
    async (args: z.infer<typeof escalationSchema>, runtime: ToolRuntimeLike) => {
      // 回拒絕，不拋：中斷之後才落定的那幾條出口，拋出去會在 resume 那一輪逸出成整場 run 死掉
      // （`@nexus/plugin-ask-user` 量過）。核准閘門的 `denial()` 也是這個形狀。
      const refuse = (message: string, error?: ToolErrorInfo) =>
        toolRefusal(message, {
          callId: toolCallIdOf(runtime) ?? '',
          name: SANDBOX_ESCALATION_TOOL_NAME,
          ...(error === undefined ? {} : { error }),
        });
      const { file_path: target, sandbox_permissions: requested, justification } = args;
      // **順序照 dsh**：先驗欄位（`validateEscalationArgs`），再判加寬，最後才看有沒有人可問。
      if (target.trim() === '') return refuse(MISSING_TARGET_REFUSAL);
      if (justification.trim() === '') return refuse(BLANK_JUSTIFICATION_REFUSAL);
      // resume 時本體整個重跑，所以這一格在**人按下去之後**又判一次：人看卡片的那段時間裡，
      // `/sandbox` 可能已經換過格子。
      const current = controller.current;
      if (!isStrictlyWider(current, requested)) {
        return refuse(nonWideningRefusal(requested, current));
      }
      // 子代理不問人升級（#324／#328），見模組註解「子代理怎麼拒」。
      const unasked: UnaskedReason | undefined =
        controller.delegatedMode !== undefined
          ? 'delegated'
          : channel === undefined
            ? 'no-service'
            : channel.kind !== 'human'
              ? channel.kind
              : // 升級的核准是這個政策管的核准：切到 `never` 之後，這條路也要跟著回絕，不然只改了閘門、模型換條路還是問得到人。
                approvalPolicy?.() === 'never'
                ? 'approval-never'
                : undefined;
      if (unasked !== undefined) return refuse(unaskedRefusal(unasked, requested));

      // `interrupt` 用拋例外傳播，**不能包在 try/catch 裡**
      // （`@langchain/langgraph@1.4.12`，`dist/pregel/runnable_types.d.ts:56-57`）。
      const answer = (await interrupt({
        kind: APPROVAL_INTERRUPT_KIND,
        actionRequests: [
          {
            name: SANDBOX_ESCALATION_TOOL_NAME,
            args,
            description: escalationReason(target, requested, justification),
            // pump 記 `approval/asked` 要配得上 `tool/call`（#1029），同核准閘門的酬載。
            ...(toolCallIdOf(runtime) === undefined ? {} : { callId: toolCallIdOf(runtime) }),
          },
        ],
        reviewConfigs: [
          { actionName: SANDBOX_ESCALATION_TOOL_NAME, allowedDecisions: ['approve', 'reject'] },
        ],
      })) as EscalationVerdict | undefined;

      const verdict = answer?.decisions?.[0];
      if (verdict?.type === 'reject') {
        // 人按了拒絕：碼同核准閘門（#1029）。這條工具本體裡的其他拒絕（政策關掉、沒有管道）不寫 `approval/*`，
        // 因為沒有走核准閘門——見 `approval.ts` 的檔頭。
        return refuse(
          verdict.message ?? rejectedRefusal(target, requested),
          approvalDenied(APPROVAL_REJECTED_BY_USER),
        );
      }
      if (verdict?.type !== 'approve') {
        return refuse(
          `核准回覆看不懂：${JSON.stringify(answer)}。` +
            '這一格只收 { decisions: [{ type: "approve" | "reject" }] }，所以沒有升級。',
        );
      }
      // 綁的是**這一刻**最近被擋下的那一次。同一則訊息裡另有平行的變更也被擋的話，綁到的
      // 可能是它——那時候對不上的一邊認領不到，是 fail-closed 的方向（見控制器的 `#denial`）。
      controller.grant({ mode: requested, target, denied: controller.lastDenial });
      return (
        `核准了：${JSON.stringify(target)} 剛才被擋下的那一次操作可以在 ` +
        `${requested} 之下跑一次。現在把它原樣重試——操作或內容改了就不算。`
      );
    },
    {
      name: SANDBOX_ESCALATION_TOOL_NAME,
      description: SANDBOX_ESCALATION_DESCRIPTION,
      schema: escalationSchema,
    },
  );
}

/**
 * 掛上升級：工具（問人在它的本體裡），並告訴控制器「這個組裝有升級」。
 *
 * **兩件放在同一步**：拆開的失敗方式是「指引在、工具不在」（fence 叫模型去呼叫一顆不存在的工具）。
 * 以前還有第三件——一顆只認這個名字的核准閘門——[#700](https://github.com/DemianLi/nexus-agent/issues/700)
 * 照 dsh 把問人搬進本體之後拿掉了，留著的話同一次升級會問兩次。
 *
 * **問人沒有開關**：這顆工具存在的意義就是讓人看過。
 *
 * @param registry - plugin 拿到的註冊表。核准管道從 {@link CHANNEL_SERVICE} 讀（軟相依，讀不到就 fail-closed）。
 * @param controller - 這次組裝那一格，grant 發在它身上、fence 從它身上認領。
 */
export function registerSandboxEscalation(
  registry: Parameters<NexusPlugin['apply']>[0],
  controller: SandboxModeController,
): void {
  registry.tools.register(
    createEscalationTool(
      controller,
      registry.services.get(CHANNEL_SERVICE),
      registry.services.get(APPROVAL_POLICY_SERVICE)?.source,
    ),
  );
  controller.enableEscalation(SANDBOX_ESCALATION_HINT);
}
