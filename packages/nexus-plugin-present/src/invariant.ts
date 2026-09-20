/**
 * `@nexus/plugin-present` 的不變量配套入口：**每一筆交付都對得上一次成功的 `present` 呼叫**。
 *
 * dsh 的 `tool-present` 不發布配套入口（README：「不发布伴生入口」）。我們這邊的 gate 要求每個
 * `packages/*` 都有一個（`apps/harness/src/package-invariants.ts`），而這個套件擁有一條機械判得出來的
 * 跨筆關係，所以寫實的，不寫只帶說明標記的空 installer：
 *
 * 1. **有配對的呼叫**：同一份日誌裡，前面有一顆同 `callId` 的 `tool/call`，工具名是 `present`。
 * 2. **那次呼叫成功了**：它最後一顆 `tool/result` 在這一筆之前，而且 `isError` 為否。這一條就是
 *    檔頭那個「落定成功才寫」的時刻——一筆落在結果之前、或跟著一次失敗的，都是有人繞過了工具。
 * 3. **一次呼叫只交付一次**。
 * 4. **形狀**：`files` 非空，每個 `path` 是去掉空白後非空的字串，`description` 有的話是字串。
 *
 * 規則寫在日誌的內容上，不看這份是 root 還是子代理的——兩種都合法（呼叫者自己那一份），規則一樣。
 *
 * @see [#441](https://github.com/DemianLi/nexus-agent/issues/441)
 * @module
 */

import type {
  InvariantFailure,
  InvariantInstaller,
  NexusPlugin,
  PluginEntry,
  SessionEvent,
} from '@nexus/core';

import { PRESENT_TOOL_NAME } from './index.js';

/** 這個配套入口認領的 package 名。 */
export const PRESENT_INVARIANT_PACKAGE = '@nexus/plugin-present';

/**
 * 驗一筆交付的形狀。`fail` 會拋，第一條壞掉的就停在那裡。
 * @param files - 這一筆帶的檔案。
 * @param seq - 它在日誌裡的位置。
 * @param fail - 違規回報器。
 */
function validateFiles(files: unknown, seq: number, fail: InvariantFailure): void {
  if (!Array.isArray(files) || files.length === 0) {
    fail(`deliverables/presented（seq ${seq}）的 files 要是非空陣列`);
  }
  for (const file of files as readonly unknown[]) {
    if (typeof file !== 'object' || file === null) {
      fail(`deliverables/presented（seq ${seq}）的檔案不是物件`);
    }
    const { path, description } = file as Record<string, unknown>;
    if (typeof path !== 'string' || path.trim().length === 0) {
      fail(`deliverables/presented（seq ${seq}）有一個檔案的 path 是空的或不是字串`);
    }
    if (description !== undefined && typeof description !== 'string') {
      fail(`deliverables/presented（seq ${seq}）有一個檔案的 description 不是字串`);
    }
  }
}

/**
 * 交付與它那次呼叫的關係，加上形狀。trace 放在 closure 裡：一份日誌一次安裝。
 */
export const presentDeliveryInvariant: InvariantInstaller = (subject, fail) => {
  /** 每個 `callId` 叫的是哪顆工具。 */
  const calls = new Map<string, string>();
  /** 每個 `callId` 最後一顆結果是不是錯誤。 */
  const results = new Map<string, boolean>();
  /** 已經交付過的 `callId`。 */
  const delivered = new Set<string>();

  subject.observe((event: SessionEvent) => {
    switch (event.type) {
      case 'tool/call':
        calls.set(event.data.callId, event.data.name);
        break;
      case 'tool/result':
        results.set(event.data.callId, event.data.isError);
        break;
      case 'deliverables/presented': {
        const { callId, files } = event.data;
        validateFiles(files, event.seq, fail);
        if (calls.get(callId) !== PRESENT_TOOL_NAME) {
          fail(
            `deliverables/presented（seq ${event.seq}）的 ${callId} 前面沒有一顆 present 的 tool/call`,
          );
        }
        const isError = results.get(callId);
        if (isError === undefined) {
          fail(
            `deliverables/presented（seq ${event.seq}）的 ${callId} 還沒有 tool/result 就交付了`,
          );
        }
        if (isError === true) {
          fail(`deliverables/presented（seq ${event.seq}）的 ${callId} 那次呼叫的結果是錯誤`);
        }
        if (delivered.has(callId)) {
          fail(`deliverables/presented（seq ${event.seq}）的 ${callId} 已經交付過一次`);
        }
        delivered.add(callId);
        break;
      }
      default:
        // 別人的事件種類歸別人的擁有者。
        break;
    }
  });
};

/**
 * 把交付的配套入口掛上去。
 *
 * @returns 掛著它的條目，註冊 `@nexus/plugin-present` 配套入口的 plugin。
 */
export function createPresentInvariantPlugin(): PluginEntry {
  return { plugin: presentInvariantPlugin };
}

/**
 * 模組層級的那一顆。不收設定，所以沒有 `Config`；
 * [#454](https://github.com/DemianLi/nexus-agent/issues/454) 從設定檔 import 的就是它。
 */
export const presentInvariantPlugin: NexusPlugin = {
  name: 'present-invariant',
  apply(registry) {
    registry.invariants.register(PRESENT_INVARIANT_PACKAGE, presentDeliveryInvariant);
  },
};
