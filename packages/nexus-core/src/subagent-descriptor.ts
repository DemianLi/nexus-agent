/**
 * 子代理**自己日誌裡的身分與組成**：`subagent/descriptor`
 * （[#1271](https://github.com/DemianLi/nexus-agent/issues/1271)，缺口源自 [#737](https://github.com/DemianLi/nexus-agent/issues/737)）。
 *
 * ## 為什麼要有：重啟之後只剩日誌
 *
 * 背景子代理是 continuable：跑完一輪不消失，之後還收得到話。它是誰（哪一種規格）、用哪一顆模型與推理等級，原本只活在 host 的記憶體裡
 * （`#known`、`#choices`）。行程一重啟這些就沒了，子日誌雖然還在磁碟上，卻沒有人說得出該用哪張圖把它叫醒。
 * 照 dsh（`packages/subagent/subagent/src/descriptor.ts`，`5badb15009a`）：**身分與可續接的組成記在子代理自己的日誌裡**，冷復活時只靠
 * 這一顆（加上 header 的 `parentSession`）重建，不靠父代理手上的任何東西。
 *
 * ## 照 dsh 的部分
 *
 * - 事件名與位置：子日誌上、第一個 `turn/start` 之前，只記一次（前面可以有別的參與者先寫的事件，例如 `sandbox/mode`）；
 *   折疊時**取第一顆為準**，後來的同種事件改不了組成。
 * - 嚴格驗：只認有版本號的載荷，版本不合視為「這個 runtime 分不出來」，欄位多一個、型別不對視為壞檔——不是靜靜忽略。
 * - 只記**明列的欄位**，不拷貝 merge 出來的整包選項：一個不相干的擴充值不會讓續接因為「不是 JSON」而失敗。
 * - 不記 `subagentDepth`（日誌 header 的血緣就是下限）與單次啟動的預算（`maxTokens` 之類）：續接時套新的預設，不還原舊的、也不繼承父代理當下的。
 *
 * ## 沒抄的部分
 *
 * - `provider`：我們沒有 provider 這一層（`ModelChoice` 的檔頭同一句話）。
 * - `label`：同 {@link ./subagent-catalog.ts} 不抄 `label` 的理由——我們的 `description` 是整段任務，不是標籤。
 * - `persona`、`toolFilter`：我們的子代理沒有「每個子代理各自的人設／工具過濾」，工具過濾是整份組裝的設定（`subagentToolFilter`），重啟後的
 *   組裝自己帶著，不需要記在每一份子日誌。
 * - `one-shot`：dsh 為每個 session-backed 子代理都記，one-shot 的只記身分、不能續接。我們只有背景子代理（continuable）會冷復活，前景子代理
 *   隨那一輪結束，不在 #1271 的範圍，所以只寫 continuable。
 *
 * ## 沙箱模式不記在這裡
 *
 * 背景子代理的沙箱模式在**它自己的日誌**上有一顆 `sandbox/mode { source: 'delegation' }`（派出時寫，之後每一輪由 `delegateFromLog` 讀回），
 * 日誌帶 seed 復活之後那一顆還在，所以這一顆不重複記。
 *
 * ## 升版，不標 `ignorable`
 *
 * 見 `session-store.ts` 的版本 44。
 *
 * @module
 */

import type { SessionEvent, SessionLog } from './session-log.js';

/** 目前的載荷版本。多支援一種組成輸入是刻意的版本變更，不是多一格欄位。 */
export const SUBAGENT_DESCRIPTOR_VERSION = 1;

/** `subagent/descriptor` 的載荷。 */
export interface SubagentDescriptorData {
  /** {@link SUBAGENT_DESCRIPTOR_VERSION}。 */
  readonly version: number;
  /** 收得到後續的話（可冷復活）。我們只為背景子代理寫，所以目前只有這一種。 */
  readonly mode: 'continuable';
  /** 子代理的種類名（規格名），冷復活時用它編圖。 */
  readonly subagent: string;
  /** 派出時指定的型錄 id；省略＝沿用主對話的。 */
  readonly model?: string;
  /** 派出時指定的推理等級；省略＝這顆模型的預設。 */
  readonly effort?: string;
}

/** 組成輸入：載荷去掉版本與模式（那兩格由這裡蓋）。 */
export interface SubagentDescriptorInput {
  readonly subagent: string;
  readonly model?: string;
  readonly effort?: string;
}

/**
 * 在子日誌上記身分。**呼叫的人保證只記一次、而且在第一個 `turn/start` 之前**（背景子代理的 `start` 在開日誌之後、送第一句話之前）。
 *
 * 記不進去**要拋**，不吞：沒有這一顆的子代理就是不能冷復活，而「派出成功卻默默不能續接」比「派出失敗」難查得多。
 *
 * @param child - 子代理那一份日誌。
 * @param input - 組成。
 * @returns 寫進去的那一顆。
 */
export function appendSubagentDescriptor(
  child: SessionLog,
  input: SubagentDescriptorInput,
): SessionEvent<'subagent/descriptor'> {
  return child.append('subagent/descriptor', {
    version: SUBAGENT_DESCRIPTOR_VERSION,
    mode: 'continuable',
    subagent: input.subagent,
    ...(input.model !== undefined && { model: input.model }),
    ...(input.effort !== undefined && { effort: input.effort }),
  });
}

/** {@link foldSubagentDescriptor} 的結果。 */
export type SubagentDescriptorFold =
  | { readonly kind: 'ok'; readonly descriptor: SubagentDescriptorData }
  /** 日誌上沒有這一顆：舊日誌（44 以前）、或前景子代理。分不出身分，不能冷復活。 */
  | { readonly kind: 'absent' }
  /** 版本不是這個 runtime 認得的那一版（比較新的寫的，或比較舊的）。 */
  | { readonly kind: 'unsupported-version'; readonly version: number }
  /** 載荷不合宣告的形狀。 */
  | { readonly kind: 'malformed'; readonly message: string };

const KNOWN_KEYS: ReadonlySet<string> = new Set(['version', 'mode', 'subagent', 'model', 'effort']);

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`子代理身分的 ${key} 要是非空字串`);
  }
  return value;
}

/** 驗一顆載荷。形狀不對拋。 */
function parseDescriptor(value: unknown): SubagentDescriptorData | { readonly version: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('子代理身分的載荷要是物件');
  }
  const record = value as Record<string, unknown>;
  const version = record['version'];
  if (typeof version !== 'number') throw new Error('子代理身分的 version 要是數字');
  if (version !== SUBAGENT_DESCRIPTOR_VERSION) return { version };
  const unknown = Object.keys(record).find((key) => !KNOWN_KEYS.has(key));
  if (unknown !== undefined) throw new Error(`子代理身分有不認得的欄位 "${unknown}"`);
  if (record['mode'] !== 'continuable') throw new Error('子代理身分的 mode 要是 "continuable"');
  const subagent = optionalString(record, 'subagent');
  if (subagent === undefined) throw new Error('子代理身分缺 subagent');
  const model = optionalString(record, 'model');
  const effort = optionalString(record, 'effort');
  return {
    version: SUBAGENT_DESCRIPTOR_VERSION,
    mode: 'continuable',
    subagent,
    ...(model !== undefined && { model }),
    ...(effort !== undefined && { effort }),
  };
}

/**
 * 把一份子日誌折成它的身分。**取第一顆為準**（寫的人只寫一次，後來的同種事件改不了組成，同 dsh）。
 *
 * @param events - 子日誌的全部事件（唯讀冷讀或帶 seed 的日誌都行）。
 * @returns 見 {@link SubagentDescriptorFold}。不拋：呼叫的人拿它決定「能不能復活、不能的話怎麼說」。
 */
export function foldSubagentDescriptor(events: readonly SessionEvent[]): SubagentDescriptorFold {
  const event = events.find((candidate) => candidate.type === 'subagent/descriptor');
  if (event === undefined) return { kind: 'absent' };
  try {
    const parsed = parseDescriptor(event.data);
    return 'subagent' in parsed
      ? { kind: 'ok', descriptor: parsed }
      : { kind: 'unsupported-version', version: parsed.version };
  } catch (error) {
    return { kind: 'malformed', message: error instanceof Error ? error.message : String(error) };
  }
}
