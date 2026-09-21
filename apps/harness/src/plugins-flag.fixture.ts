/**
 * 一份**只有 echo，沒有 goal 的清單**——讓 `--plugins` 在被第三步刪掉之前還有真實覆蓋。
 *
 * **它存在的唯一理由**：`goal-driver-cli.test.ts` 第 400 行那條釘著「`--plugins` 換掉預設清單
 * 之後，那條路上就沒有 goal 域了」。它需要的是一個清單形狀、且沒有 goal 的模組。
 *
 * 換成 `--patch` 就問不到那件事了（patch 是疊上去的，goal 還在）。這一刀之後樹上一個清單形狀的
 * fixture 都不剩，所以要保留這一份——但當 #455 第三步連同 `--plugins` 旗標一起刪掉的時候，
 * 這份檔也一起刪（它已經沒有用處）。
 *
 * 別把那條測試改成 `--patch`，那會讓它變成一條還會綠、但在問別的問題的測試。
 *
 * @see goal-driver-cli.test.ts:400
 */

import type { PluginEntry } from '@nexus/core';
import { createEchoPlugin } from '@nexus/plugin-echo';

export default [createEchoPlugin()] satisfies PluginEntry[];
