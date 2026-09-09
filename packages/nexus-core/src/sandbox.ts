/**
 * 沙箱模式的**詞彙**。域住在 `@nexus/harness` 的 `contained-backend.ts`（那道 fence 自己）
 * 與 `sandbox-mode.ts`（那顆會被切的格子），這裡只放名字。
 *
 * ## 為什麼詞彙非搬到 core 不可
 *
 * 同 {@link ./commands.ts | CommandDefinition} 與 {@link ./goal.ts | GoalChangeMeta} 那一條：
 * **會話事件的酬載型別全部在 {@link ./session-log.ts | SessionEventMap} 上宣告**，而那張表
 * 住在 core。`sandbox/mode` 這一顆要帶的是模式本身，所以模式的聯集也得在 core——留在
 * harness 的話，酬載只能寫成 `string`，於是「哪三個字串合法」在寫入端與讀取端各有一份，
 * **而分岔的樣子是日誌裡出現一個沒有人認得的模式名，沒有任何測試會紅**。
 *
 * ## 名字為什麼不叫 `ContainmentMode`
 *
 * core 已經有一個 {@link ./containment.ts | containment}，它講的是**工具拋錯不要炸掉整場
 * run**——完全另一件事。兩個東西同名同一個套件裡，讀的人只能靠 import 路徑分辨。
 * 這裡改用 dsh 自己的字（`SandboxMode`，`packages/sandbox/sandbox-policy/src/index.ts`），
 * 而 `--sandbox` 這個旗標名本來就已經是這個字了。
 *
 * @module
 */

/**
 * 檔案效果政策：這個組裝的檔案工具**改得動哪裡**。
 *
 * 三格照 dsh 的 `SandboxMode`。要注意它管的是**寫得到哪裡**，不是**要不要問人**——後者
 * 是另一顆旋鈕（{@link ./fold.ts | ApprovalPolicy}）。兩顆各自獨立，dsh 用具名 preset 把
 * 它們捆起來給人選；我們今天只切得動前者，理由見 `apps/harness/src/sandbox-mode.ts`。
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/**
 * 三個模式的完整清單。**宣告順序沒有語義**——它只用來驗證外面來的字串（旗標、`/sandbox`
 * 的引數、將來的設定檔）。照 dsh 的 `SANDBOX_MODES` 存在的理由：型別擋不住執行期字串。
 */
export const SANDBOX_MODES: readonly SandboxMode[] = [
  'read-only',
  'workspace-write',
  'danger-full-access',
];

/**
 * 一個外面來的字串是不是認得的模式。
 *
 * @param raw - 未經檢查的字串。
 * @returns 是的話 narrow 成 {@link SandboxMode}。
 */
export function isSandboxMode(raw: string): raw is SandboxMode {
  return (SANDBOX_MODES as readonly string[]).includes(raw);
}
