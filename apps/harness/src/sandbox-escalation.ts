/**
 * 模型那一側的升級：`request_sandbox_escalation`，與一道只認它的核准閘門。
 *
 * [#238](https://github.com/DemianLi/nexus-agent/issues/238) 第 2 項。載體是**另開一顆工具**
 * （甲），偏離登記在那張卡上：langchain 在 `wrapModelCall` 回程上拒絕同名不同實例的工具
 * （`AgentNode.ts:601-609`），所以 dsh 攤進 `write`／`edit` schema 的那兩個欄位在我們這側
 * 沒有地方掛。那條基座行為的絆索在 `escalation-carrier.test.ts`。
 *
 * ## 照 dsh 的五條
 *
 * 出處都是 `references/deepseek-harness/packages/sandbox/sandbox/src/escalation.ts`。
 *
 * 1. **嚴格加寬是執行期檢查，不是 schema 約束。** schema 的 enum 是封閉的目標詞彙
 *    {@link ESCALATION_TARGETS}，**不隨當前模式收窄**；「比現在寬」在閘門上對這一刻的模式判。
 *    理由照 dsh：schema 是全域的，當前模式是逐次呼叫的事實。收窄 enum 會讓一個被 `/sandbox`
 *    切窄的 session 連升級的槓桿都看不到。
 * 2. **不加寬的請求不問人。** 閘門在 `ask` 之前就回 `deny`，核准卡一張都不掛。
 * 3. **欄位要齊、理由不能是空白。** dsh 的 `validateEscalationArgs`。
 * 4. **理由的消費者是人。** 它原樣進核准卡的那句話（dsh：`escalate sandbox to ${mode}: ${justification}`）。
 * 5. **被擋的當下就講得出能升級。** 指引騎在拒絕上（{@link SANDBOX_ESCALATION_HINT}，對應
 *    dsh 的 `escalationHintMarker`），不靠模型記得工具描述。
 *
 * ## fail-closed 的出口，各有各的話
 *
 * | 出口 | 誰說的 | 人被問到了嗎 |
 * | --- | --- | --- |
 * | 不加寬（含認不得的模式） | 這裡的 {@link nonWideningRefusal} | 沒有 |
 * | 沒指名檔案、理由空白 | 這裡 | 沒有 |
 * | 被拒 | `@nexus/core` 的核准閘門（`approval.ts`） | 有 |
 * | 這個 session 關掉了人工核准 | 同上（`policy-never`） | 沒有 |
 * | 沒有 checkpointer | 同上（`no-channel`） | 沒有 |
 *
 * 後三條**不是這裡寫的**，而且它們本來就各說各的（`approval.ts` 的 `ApprovalChannel` 那段）。
 * dsh 的 `cancelled` 在我們這側**沒有對應物**，那段也已經記過；dsh 的「沒有 agent 可以路由」
 * 也沒有——我們每一次工具呼叫都在某個 agent 裡。
 *
 * ## 偏離：grant 綁目標、跨兩顆呼叫
 *
 * dsh 把核准來的模式**蓋在同一顆呼叫上**；我們的請求與重試是兩顆，中間隔著一顆一次性的
 * grant，而它**綁住模型指名的那個檔**。為什麼一定要綁，見 `contained-backend.ts` 的
 * `SandboxGrant`（基座的摘要器也會走 `write`）。
 *
 * **grant 不會過期。** 它只蓋一個 canonical 目標、用過一次就沒了；沒被用掉的那顆會一直等到
 * 下一顆打到同一個檔、而且被擋下的變更。要有時效是另一顆機制，今天沒做。
 *
 * **subagent 沒有另外處理**：這顆工具跟 `submit_record`、`ask_user_question` 一樣不標
 * root-only，核准閘門也注進了 subagent（`fold.ts`），fence 是同一道。但 subagent 裡「被擋 →
 * 升級 → 核准 → 重試」那一整圈**沒有單獨驗過**。
 *
 * @module
 */

import { ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import type { NexusPlugin } from '@nexus/core';
import { z } from 'zod';

import type { SandboxMode } from './contained-backend.js';
import type { SandboxModeController } from './sandbox-mode.js';

/** 模型看到的工具名。**閘門認的就是這個字串**，所以它是導出的。 */
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
 * 收 `unknown` 是因為閘門拿到的是**模型原始的參數**（zod 驗證在工具那一側、在閘門之後），
 * 一個認不得的字串在這裡就是「不加寬」。
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
  '核准之後把這一次操作原樣重試一次——只蓋這個檔、只蓋一次。';

/**
 * 不加寬的請求的那句話。閘門與工具本體共用，兩邊擋下的是同一件事。
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
  '一次核准只蓋那一個檔的下一次變更。被拒絕時不要換個路徑再寫，去問人為什麼。';

const escalationSchema = z.object({
  file_path: z.string().describe('剛才被擋下的那個檔，照被擋的那次呼叫的寫法填。'),
  sandbox_permissions: z.enum(ESCALATION_TARGETS).describe('要升到哪一格。選夠用的最窄那一格。'),
  justification: z.string().describe('一句話，給按核准的人看：為什麼這一次操作需要更寬的權限。'),
});

/** 這次執行拿到的 runtime。只用得到一格，所以不整包相依基座的型別。 */
interface ToolRuntimeLike {
  readonly toolCall?: { readonly id?: string };
}

function createEscalationTool(controller: SandboxModeController) {
  return tool(
    (args: z.infer<typeof escalationSchema>, runtime: ToolRuntimeLike) => {
      // **核准之後再判一次**：人看卡片的那段時間裡，`/sandbox` 可能已經換過格子。
      const current = controller.current;
      if (!isStrictlyWider(current, args.sandbox_permissions)) {
        return new ToolMessage({
          content: nonWideningRefusal(args.sandbox_permissions, current),
          tool_call_id: runtime?.toolCall?.id ?? '',
          name: SANDBOX_ESCALATION_TOOL_NAME,
          status: 'error',
        });
      }
      controller.grant({ mode: args.sandbox_permissions, target: args.file_path });
      return (
        `核准了：${JSON.stringify(args.file_path)} 的下一次變更會在 ` +
        `${args.sandbox_permissions} 之下跑，只有一次。現在把剛才被擋下的那次操作原樣重試。`
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
 * 掛上升級：工具、只認它的閘門，並告訴控制器「這個組裝有升級」。
 *
 * **三件放在同一步**，理由同 `@nexus/plugin-submit-record` 把工具與閘門放在一起：拆開的失敗
 * 方式是「工具在、閘門沒掛」（模型自己升級，一張卡都不出現），或「指引在、工具不在」
 * （fence 叫模型去呼叫一顆不存在的工具）。
 *
 * **閘門沒有開關**，同 `submit_record`：這顆工具存在的意義就是讓人看過。
 *
 * @param registry - plugin 拿到的註冊表。
 * @param controller - 這次組裝那一格，grant 發在它身上、fence 從它身上認領。
 */
export function registerSandboxEscalation(
  registry: Parameters<NexusPlugin['apply']>[0],
  controller: SandboxModeController,
): void {
  registry.tools.register(createEscalationTool(controller));
  registry.approvals.gate((exec, next) => {
    if (exec.name !== SANDBOX_ESCALATION_TOOL_NAME) return next();
    const { file_path: target, sandbox_permissions: requested, justification } = exec.args;
    // 順序照 dsh：先判加寬，再判欄位。不加寬的請求連欄位齊不齊都不必看。
    const current = controller.current;
    if (!isStrictlyWider(current, requested)) {
      return { kind: 'deny', reason: nonWideningRefusal(requested, current) };
    }
    if (typeof target !== 'string' || target.trim() === '') {
      return { kind: 'deny', reason: MISSING_TARGET_REFUSAL };
    }
    if (typeof justification !== 'string' || justification.trim() === '') {
      return { kind: 'deny', reason: BLANK_JUSTIFICATION_REFUSAL };
    }
    return { kind: 'ask', reason: escalationReason(target, requested, justification) };
  });
  controller.enableEscalation(SANDBOX_ESCALATION_HINT);
}
