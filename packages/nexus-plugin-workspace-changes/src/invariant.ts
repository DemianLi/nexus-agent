/**
 * `@nexus/plugin-workspace-changes` 的配套入口：**每一顆 `workspace/changes` 都落在一輪裡，而且那一輪跑過工具**。
 *
 * dsh 這個包不發佈配套入口（README：「不发布伴生入口」——記錄器同時擁有摘要與副本，沒有獨立的觀察會與它
 * 分歧）。我們的 gate 要求每個 `packages/*` 都有一個（`apps/harness/src/package-invariants.ts`），而這顆事件
 * 在日誌上有三條機械判得出來的關係，所以寫實的：
 *
 * 1. **落在一輪裡**：同一份日誌前面有一顆 `turn/start`。子代理的日誌沒有 `turn/start`，所以這一條同時擋住
 *    「寫進子代理那一份」——記錄器只接 root。
 * 2. **那一輪跑過工具**：從最近一顆不是 resume 的 `turn/start` 算起，至少有一顆 `tool/result`。記錄器在一輪
 *    沒有任何結果時不記（同 dsh 的 `lastToolResultSeq < 0`）。**web 認輪靠的就是事件在串流裡的位置**
 *    （`@nexus/wire` 的 `WorkspaceChangesEntry`），一顆落在錯的輪裡的事件會先在這裡露出來。
 * 3. **資料是空的**：不帶 `turn`（#443 第二則決議），也沒有別的欄。
 *
 * 「一輪一顆」**不是**不變量：同一輪先記一份、之後又改，dsh 會再寫一顆取代前一顆。
 *
 * @see [#443](https://github.com/DemianLi/nexus-agent/issues/443)
 * @module
 */

import type { InvariantInstaller, NexusPlugin, SessionEvent } from '@nexus/core';

/** 這個配套入口認領的 package 名。 */
export const WORKSPACE_CHANGES_INVARIANT_PACKAGE = '@nexus/plugin-workspace-changes';

/** 事件落在一輪裡、那一輪跑過工具、資料是空的。trace 放在 closure 裡：一份日誌一次安裝。 */
export const workspaceChangesInvariant: InvariantInstaller = (subject, fail) => {
  let started = false;
  /** 從最近一顆不是 resume 的 `turn/start` 起，有沒有過 `tool/result`。 */
  let toolResultInTurn = false;

  subject.observe((event: SessionEvent) => {
    switch (event.type) {
      case 'turn/start':
        started = true;
        if (event.data.kind !== 'resume') toolResultInTurn = false;
        break;
      case 'tool/result':
        toolResultInTurn = true;
        break;
      case 'workspace/changes':
        if (!started) {
          fail(`workspace/changes（seq ${event.seq}）前面沒有 turn/start：它只寫在 root 的一輪裡`);
        }
        if (!toolResultInTurn) {
          fail(`workspace/changes（seq ${event.seq}）所在的那一輪沒有任何 tool/result`);
        }
        if (Object.keys(event.data as object).length > 0) {
          fail(`workspace/changes（seq ${event.seq}）的資料要是空的`);
        }
        break;
      default:
        // 別人的事件種類歸別人的擁有者。
        break;
    }
  });
};

/**
 * 把這個配套入口掛上去。
 *
 * @returns 註冊 `@nexus/plugin-workspace-changes` 配套入口的 plugin。
 */
export function createWorkspaceChangesInvariantPlugin(): NexusPlugin {
  return {
    name: 'workspace-changes-invariant',
    apply(registry) {
      registry.invariants.register(WORKSPACE_CHANGES_INVARIANT_PACKAGE, workspaceChangesInvariant);
    },
  };
}
