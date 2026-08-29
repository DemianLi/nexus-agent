/**
 * 手動驗證用的 plugin 清單：預設那組 ＋ `@nexus/core` 的不變量配套入口。
 *
 * ```
 * pnpm --filter @nexus/harness run cli --plugins src/cli-invariant.fixture.ts "回聲一下"
 * ```
 *
 * 它要證明的是單元測試不容易證明的那一件事：**在一個真的行程裡跑一輪真流量，配套入口
 * 一聲都不吭。** 會誤報的檢查比沒有檢查更糟，而誤報只有在真的序列上才看得出來。
 *
 * 違規印在 stderr（runner 預設的 `onViolation` 是 `console.error`），所以「沒有輸出」
 * 就是通過。
 */

import type { NexusPlugin } from '@nexus/core';
import { createSessionInvariantPlugin } from '@nexus/core';
import { createEchoPlugin } from '@nexus/plugin-echo';

export default [createEchoPlugin(), createSessionInvariantPlugin()] satisfies NexusPlugin[];
