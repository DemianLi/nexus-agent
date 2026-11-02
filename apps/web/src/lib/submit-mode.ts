import type { ConversationStatus, RunStartMode } from '@nexus/wire';

/**
 * 送出的那一句要排隊還是插話（[#710](https://github.com/DemianLi/nexus-agent/issues/710)）。照 dsh `resolveSubmitMode`
 * （`packages/client/ui-conversation/src/client/input/submission-policy.ts`，`477b4f4`）與它的按鍵
 * （`input/editor/keymap.ts:35`：只按 Enter 是一般送出，**剛好** Ctrl+Enter 或 Cmd+Enter 是加速）：
 *
 * - 這一輪沒在跑：一律排隊（閒著時排隊就是馬上開跑）。
 * - 跑著：Enter 與送出鈕排隊，Cmd/Ctrl+Enter 插話。
 *
 * **沒做 dsh 的偏好設定**（`busyEnter`，讓 Enter 改成插話）：它預設就是排隊，我們先只做預設。插話送出去之後這一輪
 * 不收插話了（按了停止、正在收尾），伺服器照 dsh 改排隊，所以這裡不必先猜。
 *
 * @module
 */

/** 送出的手勢：Enter（送出鈕同它），或加速的 Cmd/Ctrl+Enter。 */
export type SubmitGesture = 'enter' | 'accelerated';

export function resolveSubmitMode(
  status: ConversationStatus,
  gesture: SubmitGesture,
): RunStartMode {
  return status === 'running' && gesture === 'accelerated' ? 'steer' : 'queue';
}

/**
 * 這一下 Enter 是不是加速的：**剛好**多按 Ctrl 或 Cmd 其中一個，其餘修飾鍵都沒按。Ctrl 與 Cmd 同時按不算（dsh 的
 * 「exactly」）。
 */
export function isAcceleratedEnter(event: {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}): boolean {
  return (
    event.key === 'Enter' && event.ctrlKey !== event.metaKey && !event.shiftKey && !event.altKey
  );
}

/** 底列提示裡加速鍵怎麼寫：蘋果的平台寫 ⌘，其餘寫 Ctrl。 */
export function acceleratorLabel(userAgent: string): string {
  return /Mac|iPhone|iPad|iPod/.test(userAgent) ? '⌘' : 'Ctrl+';
}

/** 底列左邊那句提示。`wide` 那一段只在 640 以上畫：手機多半沒有實體鍵盤，擠進來會斷在字中間（390 寬實測）。 */
export interface SendHint {
  readonly text: string;
  readonly wide?: string;
}

/** 跑著時底列的提示：兩種送法各一句，加速鍵那一句窄螢幕不畫。 */
export function runningSendHint(userAgent: string): SendHint {
  return { text: 'Enter 排隊', wide: `・${acceleratorLabel(userAgent)}Enter 插話` };
}
