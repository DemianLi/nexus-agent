/**
 * 重複工具呼叫的提醒——**建議，不阻止**。
 *
 * ## 為什麼要有這個檔
 *
 * 模型以同參數重複呼叫同一個工具（反覆跑失敗的命令、反覆讀沒變的檔）時白燒 token 卻
 * 沒有進展，而今天唯一會讓它停下來的是 `recursionLimit` 硬上限——那個上限**不分辨
 * 「在進展」與「在打轉」**，它只會在跑了夠久之後把整輪掐掉。
 *
 * dsh 的做法（`packages/guard/repeat-tool-reminder/`，SHA `4e84901`）是在選定的重複
 * 次數上送一條提醒給模型，要求它分析上一次結果、換方法或收工。**合理的重複一秒都不會
 * 被延遲**：提醒只是一則訊息，繼續或改變仍由模型決定。隨 dsh base 預設啟用，門檻
 * 3／5／8。
 *
 * ## 兩處偏離，都登記在這裡
 *
 * **一、鏈的狀態從 `state.messages` 推導，不放在 closure 裡。**
 *
 * dsh 把每個 agent 的鏈存在 `WeakMap<Agent, Chain>`（`src/index.ts:173`），以活著的
 * `Agent` 物件為鍵。我們這側**沒有那個鍵**：`wrapToolCall` 與 `beforeModel` 拿到的是
 * `state` 與 `runtime`，沒有任何 agent 身分。而共用一份 middleware 實例是會出事的
 * ——同一份 subagent 定義被並行呼叫兩次時共用同一個 closure（同型的實測見
 * {@link https://github.com/DemianLi/nexus-agent/pull/156} 裡摘要器的 `sessionId`）。
 *
 * 所以退到「每次都從 `state.messages` 現算」。`state` 本來就是逐 thread、逐 agent 各
 * 一份，隔離是結構上的而不是靠紀律。順帶兩個行為差，方向相反、兩個都講明白：
 *
 * - **恢復會話之後鏈還在**。dsh 明列「仅驻留内存，从持久化恢复的会话以全新链开始」；
 *   我們的鏈長在訊息裡，checkpointer 存什麼就恢復什麼。這一格我們比較好。
 * - **摘要之後鏈也還在**，跟 dsh 的「压缩不会重置链」同一個結果，但成因不同而且是查過的：
 *   基座的摘要器**不改寫 `state.messages`**，它只記一顆 `_summarizationEvent`，每次模型
 *   呼叫時由 `getEffectiveMessages` 現組出 `[summary, ...messages.slice(cutoffIndex)]`
 *   （`deepagents@1.13.1`，`dist/langsmith-zm0ILQsV.js:2697`，原文註解就寫著
 *   “This avoids full state rewrites”）。我們讀的是完整的 `state.messages`，所以剪裁
 *   看不到。**代價在另一邊**：落在 cutoff 之前的提醒模型那一輪就看不到了，它跟其他被
 *   摘掉的訊息一起進了摘要。
 *
 * **二、投遞掛在 `beforeModel`，不是 post-execute。**
 *
 * dsh 在 `tools/post-execute` 上計數，然後把提醒交給迴圈——由**迴圈**緩衝它，在該步驟
 * 的所有工具結果之後才附上去（README「提醒传递」段）。我們沒有那個迴圈的鉤子，但
 * LangGraph 裡「這一步的工具結果都回來了、模型還沒被叫」的那個縫**就是 `beforeModel`**，
 * 所以這是 dsh 投遞語義的忠實對應，不是另一種東西。
 *
 * 掛在 `wrapToolCall` 上反而不忠實：同一輪有多個工具呼叫時，逐次附訊息會排出
 * `AI(t1,t2) → Tool(t1) → Human(提醒) → Tool(t2)` 這種序列，而多數供應商要求同一批
 * tool result 必須連在一起。dsh 緩衝到步驟結束正是為了避開這件事。
 *
 * **順帶一件查過的事**：整份 `deepagents@1.13.1` 的 dist 裡 `beforeModel` 出現 0 次
 * （鉤子只用 `beforeAgent` 7、`wrapModelCall` 14、`wrapToolCall` 1、`afterAgent` 1），
 * 所以我們是那張圖裡唯一的 `beforeModel` 節點——每輪多一格的代價全歸這裡。
 *
 * **這個選擇有一個量得出來的代價，見 {@link createRepeatReminder}。**
 *
 * ## 被拒的呼叫也計數
 *
 * dsh 明列這條（偵測在 post-execute，被 `pre-execute` 拒掉的呼叫一樣經過它）。我們這側
 * 自動成立而且理由不同：鏈是從 `AIMessage.tool_calls` 推的，那是**模型提出了什麼**，
 * 跟工具跑了沒有、跑成什麼樣無關。核准閘門拒掉一次呼叫時 AI 那則訊息還在，所以照樣算。
 *
 * @module
 */

import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from './base-types.js';

/** 提醒 middleware 的名字。錯誤訊息與排序斷言用得到。 */
export const REPEAT_REMINDER_MIDDLEWARE_NAME = 'nexusRepeatToolReminder';

/**
 * 提醒訊息在 `additional_kwargs` 上的記號。
 *
 * **它承重**：提醒本身是一則 `HumanMessage`，而「新的使用者訊息清零計數」是 dsh 的
 * 規則之一——沒有記號的話，第 3 次那條提醒會把鏈重置成 1，第 5 次永遠到不了，而且
 * 第一條提醒照樣出現，看起來完全正常。形狀照基座自己標記合成 `HumanMessage` 的做法
 * （`deepagents@1.13.1`，`dist/langsmith-zm0ILQsV.js:2471` 的 `lc_evicted_to`）。
 */
export const REPEAT_REMINDER_MARKER = 'nexus_repeat_reminder';

/**
 * goal 收尾指示在 `additional_kwargs` 上的記號。
 *
 * ## 為什麼一個 goal 的記號住在這個檔案裡
 *
 * **這個記號的全部作用是讓底下那條鏈走訪跳過它。** 造它的人在
 * `@nexus/plugin-goal`，讀它的人只有這裡——記號跟著讀的人住，同一條紀律讓
 * {@link REPEAT_REMINDER_MARKER} 也住在這裡。`@nexus/core` 反向依賴插件是不可能的，
 * 所以詞彙落在這一側是唯一走得通的擺法。
 *
 * ## 它擋的是什麼
 *
 * 收尾指示是一則 `HumanMessage`，而「真的使用者訊息清零計數」會把它當成人插了話。
 * 那正好發生在**模型剛被告知不要再叫工具**的時候：它若無視收尾指示繼續打轉，門檻 3
 * 的提醒會晚兩次才到——方向跟收尾指示本身相反。
 *
 * **一輪的頭不標記。** 續行輪次的 `turn/start` 也是一則素的 `HumanMessage`
 * （`apps/harness` 的 `thread-pump.ts`），它清零是**對的**：新的物理輪次是真的新脈絡。
 * 差別在「一輪的頭」與「一輪內部的注入」，不在哪個套件造的。
 */
export const GOAL_WRAPUP_MARKER = 'nexus_goal_wrapup';

/** 一則提醒訊息在記號底下帶的東西，對應 dsh 的 `source.summary`（`<tool> × <count>`）。 */
export interface RepeatReminderMark {
  /** 重複的那個工具名。 */
  readonly tool: string;
  /** 這是連續第幾次。 */
  readonly count: number;
}

/** 提醒的門檻與射程。欄位照 dsh 的 `Config`（`src/index.ts:28`）。 */
export interface RepeatReminderSettings {
  /** 觸發提醒的連續重複次數。 */
  readonly thresholds: readonly number[];
  /** 只追蹤這些工具（`*` 萬用字元）。空陣列＝全部都追蹤。 */
  readonly include: readonly string[];
  /** 絕不追蹤這些工具。對它們的呼叫**既不計數也不重置**。 */
  readonly exclude: readonly string[];
  /** 詳細提醒裡引用參數的字數上限。 */
  readonly argumentsPreviewChars: number;
}

/** 預設值，逐格照 dsh 的 `Config` schema（`src/index.ts:45`）。 */
export const DEFAULT_REPEAT_REMINDER: RepeatReminderSettings = {
  thresholds: [3, 5, 8],
  include: [],
  exclude: [],
  argumentsPreviewChars: 500,
};

/**
 * 第一道門檻的溫和提醒。
 *
 * **原文照抄，不翻譯**：這是給模型看的字串，不是給人看的文件。以 `thresholds[0]` 為鍵
 * 而不是寫死 3，所以自訂第一道門檻時「先溫和、後詳細」的升級順序還在（照 dsh）。
 */
const GENTLE_REMINDER =
  'You are repeating the exact same tool call with identical arguments. ' +
  'Carefully analyze the previous result before calling again: if the task is ' +
  'not complete, try a different approach or different arguments instead of ' +
  'repeating the call.';

/**
 * 後續門檻的詳細提醒：點名工具、連續次數與參數。原文照抄。
 *
 * @param toolName - 重複的工具名。
 * @param count - 連續第幾次。
 * @param canonicalArguments - 規範化後（可能被截斷）的參數。
 * @returns 給模型看的提醒全文。
 */
function detailedReminder(toolName: string, count: number, canonicalArguments: string): string {
  return (
    'Repeated tool call detected:\n' +
    `- tool: ${toolName}\n` +
    `- consecutive_calls: ${count}\n` +
    `- arguments: ${canonicalArguments}\n` +
    'The repeated calls are not making progress. Do not call this tool with ' +
    'these exact arguments again. Inspect the latest result and choose a ' +
    'different action, different arguments, or finish the task if enough ' +
    'evidence has been gathered.'
  );
}

/**
 * 逐層對 key 排序，讓只差在屬性順序的兩份參數規範化成同一個字串。
 *
 * 參數是模型那側 `JSON.parse` 出來的，所以 JSON 的值域就是全部的輸入域——沒有 bigint、
 * 循環參照或 `undefined` 要處理，因為沒有一條輸入路徑產得出它們（照抄 dsh 的理由）。
 *
 * @param value - 已解析的 JSON 值。
 * @returns key 排序過的同一個值。
 */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = sortJsonValue(record[key]);
    return sorted;
  }
  return value;
}

/**
 * 一次呼叫的參數的規範字串：逐層排序後 stringify。
 *
 * @param argumentsValue - 已解析的參數。
 * @returns 可以直接拿來比對的字串。
 */
function canonicalize(argumentsValue: unknown): string {
  return JSON.stringify(sortJsonValue(argumentsValue));
}

/**
 * 把一個 `*` 萬用字元的樣式編成錨定的 RegExp（其餘 regex 元字元一律當字面處理）。
 *
 * @param pattern - 工具名樣式。
 * @returns 對整個名字錨定的 RegExp。
 */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`);
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`);
}

/**
 * 截斷詳細提醒裡引用的參數，並標明省略了多少。
 *
 * **只限制模型看到的文字，不影響偵測**：鏈的鍵永遠比對完整的規範字串。理由照 dsh：
 * 大 payload（一份 `write` 的內容、一條長命令）會原封不動搭上下一次請求，而那正好
 * 發生在迴圈情境裡。
 *
 * @param canonical - 完整的規範字串。
 * @param cap - 字數上限。
 * @returns 未超過就原樣；超過就截斷並附上省略字數。
 */
function previewArguments(canonical: string, cap: number): string {
  if (canonical.length <= cap) return canonical;
  return `${canonical.slice(0, cap)}… (+${canonical.length - cap} more chars)`;
}

/**
 * 逐格檢查設定並把門檻升冪排好。
 *
 * **設定錯了是當場拋，不是靜默改行為**（照 dsh 的 fail-loud 契約）。門檻排序在這裡做
 * 一次，因為升級規則讀的是 `thresholds[0]`。
 *
 * @param override - 要蓋上去的那幾格，省略即 {@link DEFAULT_REPEAT_REMINDER}。
 * @returns 驗過、門檻已升冪排序的設定。
 * @throws 門檻是空陣列、有非整數、有小於 2 的值、有重複值，或 `argumentsPreviewChars` 不是 ≥ 1 的整數。
 */
export function resolveRepeatReminderSettings(
  override?: Partial<RepeatReminderSettings>,
): RepeatReminderSettings {
  const merged: RepeatReminderSettings = { ...DEFAULT_REPEAT_REMINDER, ...override };

  if (merged.thresholds.length === 0)
    throw new Error(
      'repeatReminder.thresholds 是空陣列。那等於沒有提醒器——要那個效果請明著傳 ' +
        '`repeatReminder: false`。',
    );
  for (const threshold of merged.thresholds) {
    if (!Number.isInteger(threshold) || threshold < 2)
      throw new Error(
        `repeatReminder.thresholds 裡有 ${String(threshold)}，每一個門檻都要是 ≥ 2 的整數。` +
          '1 不是重複，是第一次呼叫。',
      );
  }
  if (new Set(merged.thresholds).size !== merged.thresholds.length)
    throw new Error(`repeatReminder.thresholds 有重複的值：${JSON.stringify(merged.thresholds)}。`);
  if (!Number.isInteger(merged.argumentsPreviewChars) || merged.argumentsPreviewChars < 1)
    throw new Error(
      `repeatReminder.argumentsPreviewChars 是 ${String(merged.argumentsPreviewChars)}，` +
        '要 ≥ 1 的整數。',
    );

  return { ...merged, thresholds: [...merged.thresholds].sort((a, b) => a - b) };
}

/** 一則訊息是不是我們自己插進去的提醒。索引存取可能是 `undefined`，一併吃掉。 */
function isReminder(message: BaseMessage | undefined): boolean {
  return (
    HumanMessage.isInstance(message) && message.additional_kwargs[REPEAT_REMINDER_MARKER] != null
  );
}

/**
 * 一則 `HumanMessage` 是不是**插進去的**，而不是人講的話。
 *
 * ## 為什麼這不是 {@link isReminder} 加寬一格
 *
 * 這兩個述詞問的是相反的問題，而下面有兩個呼叫點各要一個答案：
 *
 * - **重入護欄**問「這一輪的提醒貼過了嗎」，只有我們自己那則提醒算數。收尾指示注入
 *   之後正好落在最後一則 AI 訊息之後，把護欄的述詞加寬，那一輪的提醒就整個不發了。
 * - **鏈走訪**問「這是人插了話嗎」，兩種合成訊息都不算。
 *
 * 合成來源加進來時要加在這裡，不是加在 {@link isReminder}。
 *
 * @param message - 要判的那一則。
 * @returns 是我們插的就 `true`；不是 `HumanMessage` 也算 `false`。
 */
function isSynthetic(message: BaseMessage | undefined): boolean {
  if (isReminder(message)) return true;
  return (
    HumanMessage.isInstance(message) && message.additional_kwargs[GOAL_WRAPUP_MARKER] != null
  );
}

/** 一條鏈：上一次受追蹤呼叫的身分鍵，與它已經連續了幾次。 */
interface Chain {
  readonly key: string;
  readonly count: number;
}

/** 一次命中：{@link RepeatReminderMark} 再加上組詳細提醒要用的規範參數。 */
interface Hit extends RepeatReminderMark {
  /** 這次呼叫的規範化參數，完整不截斷。 */
  readonly canonical: string;
}

/**
 * 從一份訊息串現算出這一輪該送的提醒。
 *
 * 只為**最後一則 AI 訊息**的工具呼叫產出提醒——更早的那些在它們自己那一輪已經送過了。
 * 鏈本身則要從頭走，因為連續次數是跨輪累積的。
 *
 * @param messages - 目前的 `state.messages`。
 * @param settings - 已經驗過的設定。
 * @param tracked - 這個工具名參不參與鏈。
 * @returns 這一輪要附上的提醒全文，依呼叫順序；沒有就是空陣列。
 */
function pendingReminders(
  messages: readonly BaseMessage[],
  settings: RepeatReminderSettings,
  tracked: (toolName: string) => boolean,
): readonly Hit[] {
  let lastAi = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (AIMessage.isInstance(messages[i])) {
      lastAi = i;
      break;
    }
  }
  if (lastAi < 0) return [];
  // 這一輪的提醒已經貼上去了就不要再貼一次。`beforeModel` 正常情況下一輪只跑一次，
  // 這一格擋的是「有人讓圖跳回模型前」那種重入。
  for (let i = lastAi + 1; i < messages.length; i += 1) if (isReminder(messages[i])) return [];

  const thresholds = new Set(settings.thresholds);
  const hits: Hit[] = [];
  let chain: Chain | undefined;

  for (let i = 0; i <= lastAi; i += 1) {
    const message = messages[i];
    // 真的使用者訊息會清零：人插了話就換了脈絡，跨過它的重複不是打轉。**插進去的那些
    // 不算**——我們自己那則提醒，以及 goal 的收尾指示，見 {@link isSynthetic}。
    if (HumanMessage.isInstance(message) && !isSynthetic(message)) {
      chain = undefined;
      continue;
    }
    if (!AIMessage.isInstance(message)) continue;
    for (const call of message.tool_calls ?? []) {
      // 不受追蹤的呼叫對鏈**透明**：既不計數也不重置。所以 `a → todo_write → a` 在
      // `todo_write` 被排除時仍算連續兩次 `a`——穿插進迴圈的記錄類工具掩蓋不了迴圈。
      if (!tracked(call.name)) continue;
      const canonical = canonicalize(call.args);
      const key = JSON.stringify([call.name, canonical]);
      const count = chain !== undefined && chain.key === key ? chain.count + 1 : 1;
      chain = { key, count };
      if (i !== lastAi || !thresholds.has(count)) continue;
      hits.push({ tool: call.name, count, canonical });
    }
  }
  return hits;
}

/**
 * 造一份提醒 middleware。
 *
 * ## 它是無狀態的，所以可以共用同一份實例
 *
 * closure 裡只有設定與編好的樣式，鏈每次從 `state.messages` 現算。這跟摘要器**相反**
 * ——那個把 `sessionId` 放在 closure 裡，所以 fold 必須逐個 agent 各建一份
 * （[#156](https://github.com/DemianLi/nexus-agent/pull/156)）。這裡不必，而且不是
 * 「反正共用也還好」：`state` 本來就逐 thread、逐 agent 各一份，隔離是結構上的。
 *
 * ## 代價：每一輪多一個 super-step
 *
 * `beforeModel` 在 LangGraph 裡會變成迴圈裡的一個節點（`langchain@1.5.10`，
 * `dist/agents/ReactAgent.js:126-134`），所以掛上它之後每一輪是三格而不是兩格。
 * 2026-09-03 用 `LoopingChatModel` 在 `recursionLimit: 8` 上實測：裸組裝 3 輪、加上這個
 * middleware 之後 2 輪，換算從 `2 × 輪數 + 2` 變成 `3 × 輪數 + 2`。
 *
 * **後果是 `DEFAULT_RECURSION_LIMIT`（100）的預算從約 49 輪縮到 32 輪。** 方向是護欄
 * 變嚴不是變鬆，而它擋的那條線（正常基準任務最長 3 次工具呼叫 ≈ 8 個 super-step，
 * 換算後 ≈ 11）離 100 還很遠，所以那個常數沒有動。要拿回原本的預算就自己傳一個大的
 * `recursionLimit`，或明著傳 `repeatReminder: false`。
 *
 * @param settings - 已經 {@link resolveRepeatReminderSettings} 驗過的設定。
 * @returns 可以交給 `registry.middleware.use()` 或塞進 subagent 的 middleware。
 */
export function createRepeatReminder(settings: RepeatReminderSettings): AgentMiddleware {
  const includePatterns = settings.include.map(wildcardToRegExp);
  const excludePatterns = settings.exclude.map(wildcardToRegExp);
  const tracked = (toolName: string): boolean => {
    if (includePatterns.length > 0 && !includePatterns.some((p) => p.test(toolName))) return false;
    return !excludePatterns.some((p) => p.test(toolName));
  };

  return createMiddleware({
    name: REPEAT_REMINDER_MIDDLEWARE_NAME,
    beforeModel: (state: { messages: readonly BaseMessage[] }) => {
      const hits = pendingReminders(state.messages ?? [], settings, tracked);
      if (hits.length === 0) return undefined;
      return {
        messages: hits.map(({ tool, count, canonical }) => {
          const text =
            count === settings.thresholds[0]
              ? GENTLE_REMINDER
              : detailedReminder(
                  tool,
                  count,
                  previewArguments(canonical, settings.argumentsPreviewChars),
                );
          return new HumanMessage({
            content: text,
            additional_kwargs: { [REPEAT_REMINDER_MARKER]: { tool, count } },
          });
        }),
      };
    },
  }) as unknown as AgentMiddleware;
}
