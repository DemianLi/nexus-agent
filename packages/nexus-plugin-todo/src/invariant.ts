/**
 * `@nexus/plugin-todo` 的不變量配套入口：**耐久待辦快照的合法性**。
 *
 * 形狀照 dsh 的 `@deepseek-ai/dsh-tool-todo/invariant`
 * （`references/deepseek-harness/packages/todo/tool-todo/src/invariant.ts`，對讀日期
 * 2026-09-01，版本 `0a53fb55bea101816fa226bb964ae2bed71c343b`）：條目畸形、content 空或
 * 重複、未知狀態，加上**歸屬**——`todo/write` 只能落在開著的輪裡。
 *
 * ## 兩條照抄的，與一條改了寫法的
 *
 * **照抄的第一條：不管有幾條 `in_progress`。** 那是工具按部署拍的政策
 * （`TodoPluginOptions.allowParallelInProgress`），不是耐久資料規則。綁上去的話，一份在
 * 允許並行時寫下的日誌，會在政策收緊之後變成違規——**回放不了自己的歷史**。
 *
 * **照抄的第二條：content 必須已經去過空白。** 工具那側 `trim()` 過才寫，所以帶空白的
 * 條目代表有另一個生產者繞過了工具。
 *
 * **改了寫法的那一條：歸屬。** dsh 寫的是「不在開著的輪裡就報」，無條件。**我們照抄會
 * 讓每一次 subagent 的 `todo_write` 都變成違規**——subagent 的日誌上永遠不會有
 * `turn/start`：發 turn 事件的是進入點（`thread-pump.ts` 的 `#runOnce`、`cli.ts` 的
 * `runTurn`），而 subagent 不經過進入點。那是
 * [#137](https://github.com/DemianLi/nexus-agent/issues/137) 釘下來的約定，不是缺陷
 * （`apps/harness/src/subagent-session-consumers.test.ts` 的「輪的擁有者是進入點」那一組）。
 *
 * 所以規則改成**看這份日誌自己有沒有輪**：見過 `turn/start` 的日誌要守配對，沒見過的
 * 就是沒有輪這個概念，這條規則對它沒有指涉對象。
 *
 * **這個寫法是選的，不是將就。** 另一條路是讓配套入口拿得到
 * {@link @nexus/core!SessionAddress}（`sessions` 通道的參與者拿得到，配套入口拿不到），
 * 然後 `kind === 'subagent'` 就跳過。兩件事讓這一條勝出：
 *
 * 1. **它自己會跟上。** 哪天 subagent 的日誌真的長出輪，這條檢查當場開始檢它；看身分的
 *    那個寫法會繼續跳過，而且是靜默的。
 * 2. **它更接近 dsh。** dsh 的 `Session` 帶得出 `header.origin`，而它的 todo 配套入口
 *    **刻意不看**——規則寫在日誌的內容上。它不需要分支是因為它那側每一個 session 都有輪。
 *
 * 代價講明白：**一顆落在這份日誌第一顆 `turn/start` 之前的 `todo/write` 檢不到**。那個
 * 缺口有鄰居補——進入點若真的漏發 `turn/start`，它收工時那顆 `turn/end` 會讓
 * `@nexus/core` 的 turn 配對當場報（`packages/nexus-core/src/invariant.ts`）。
 *
 * @see [#132](https://github.com/DemianLi/nexus-agent/issues/132)
 * @module
 */

import type { InvariantFailure, InvariantInstaller, NexusPlugin, SessionEvent } from '@nexus/core';
import { TODO_STATUSES } from '@nexus/core';

/** 這個配套入口認領的 package 名。 */
export const TODO_INVARIANT_PACKAGE = '@nexus/plugin-todo';

const KNOWN_STATUSES = new Set<string>(TODO_STATUSES);

/**
 * 驗一份整表快照的形狀。
 *
 * **`fail` 會拋**，所以第一條壞掉的就停在那裡——同 `@nexus/plugin-goal` 的配套入口，
 * 一筆事件報一個理由。
 *
 * @param todos - 這一筆帶的清單。
 * @param seq - 它在日誌裡的位置，訊息要指得出是哪一筆。
 * @param fail - 違規回報器。
 */
function validateTodos(todos: unknown, seq: number, fail: InvariantFailure): void {
  if (!Array.isArray(todos)) fail(`todo/write（seq ${seq}）的 todos 不是陣列`);
  const seen = new Set<string>();
  for (const item of todos as readonly unknown[]) {
    if (typeof item !== 'object' || item === null) fail(`todo/write（seq ${seq}）的條目不是物件`);
    const { content, status } = item as Record<string, unknown>;
    if (typeof content !== 'string' || content.length === 0 || content.trim() !== content) {
      fail(`todo/write（seq ${seq}）的 content 必須非空、而且已經去過頭尾空白`);
    }
    if (seen.has(content as string)) {
      fail(`todo/write（seq ${seq}）重複了 content ${JSON.stringify(content)}`);
    }
    seen.add(content as string);
    if (typeof status !== 'string' || !KNOWN_STATUSES.has(status)) {
      fail(`todo/write（seq ${seq}）帶了不認得的狀態 ${JSON.stringify(status)}`);
    }
  }
}

/**
 * 耐久待辦快照的兩條關係：形狀，與歸屬。
 *
 * trace 放在 closure 裡：一份日誌一次安裝——同 `@nexus/core` 的 turn 配對。
 */
export const todoSnapshotInvariant: InvariantInstaller = (subject, fail) => {
  /** 這份日誌見過輪嗎。沒見過的話「開著的輪」對它沒有指涉對象，見檔頭。 */
  let hasTurns = false;
  /** 現在有沒有一輪開著。 */
  let open = false;

  subject.observe((event: SessionEvent) => {
    switch (event.type) {
      case 'turn/start': {
        hasTurns = true;
        open = true;
        break;
      }
      case 'turn/end':
      case 'turn/failed': {
        open = false;
        break;
      }
      case 'todo/write': {
        validateTodos(event.data.todos, event.seq, fail);
        if (hasTurns && !open) fail(`todo/write（seq ${event.seq}）落在任何開著的輪之外`);
        break;
      }
      default:
        // 別人的事件種類歸別人的擁有者，同 `@nexus/core` 的 turn 配對。
        break;
    }
  });
};

/**
 * 把待辦快照的配套入口掛上去。
 *
 * @returns 註冊 `@nexus/plugin-todo` 配套入口的 plugin。
 */
export function createTodoInvariantPlugin(): NexusPlugin {
  return {
    name: 'todo-invariant',
    apply(registry) {
      registry.invariants.register(TODO_INVARIANT_PACKAGE, todoSnapshotInvariant);
    },
  };
}
