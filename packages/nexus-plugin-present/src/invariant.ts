/**
 * `@nexus/plugin-present` 的不變量配套入口：**每一筆交付都對得上一次成功的 `present` 呼叫**。
 *
 * dsh 的 `tool-present` 不發布配套入口（README：「不发布伴生入口」）。我們這邊只有擁有可檢關係的
 * package 才發布一個（空 installer 會被 `apps/harness/src/package-invariants.ts` 擋下來，#974），
 * 而這個套件擁有一條機械判得出來的跨筆關係，所以寫實的：
 *
 * 1. **有配對的呼叫**：同一份日誌裡，前面有一顆同 `callId` 的 `tool/call`，工具名是 `present`。
 * 2. **那次呼叫沒有失敗**：配對的 `tool/result` 要是有，不論在這一筆之前或之後，`isError` 都要為否。
 *    工具在 `tools/result` 說結果不是錯誤的當下同步寫（#1286，同 dsh），所以新日誌的次序是
 *    `tool/call → deliverables/presented → tool/result`；#1286 之前的日誌是交付在結果之後。**兩種次序都合法**——
 *    次序不是這條不變量要擋的；要擋的是「跟著一次失敗的」，那是有人繞過了工具。結果還沒落定（沒有 `tool/result`）
 *    也合法：新次序下交付寫的時候結果本來就還沒記。
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
  /** 每個 `callId` 最後一顆結果是不是錯誤（結果還沒到就沒有這個 key）。 */
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
        // 新次序：交付先到，結果後到。後到的結果是錯誤，就是跟著一次失敗的交付。
        if (event.data.isError && delivered.has(event.data.callId)) {
          fail(`${event.data.callId} 已經交付了，但那次呼叫的 tool/result（seq ${event.seq}）是錯誤`);
        }
        break;
      case 'deliverables/presented': {
        const { callId, files } = event.data;
        validateFiles(files, event.seq, fail);
        if (calls.get(callId) !== PRESENT_TOOL_NAME) {
          fail(
            `deliverables/presented（seq ${event.seq}）的 ${callId} 前面沒有一顆 present 的 tool/call`,
          );
        }
        // 沒有結果（`undefined`）合法：新次序下交付寫的時候結果還沒記。
        if (results.get(callId) === true) {
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

export default presentInvariantPlugin;
