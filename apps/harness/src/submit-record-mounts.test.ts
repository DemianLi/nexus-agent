/**
 * **絆索：`submit_record` 拿到的 backend 與工具實際讀寫的那一個要是同一個。**
 *
 * `apps/harness/src/cli.ts` 把 backend 建成一個 const，一份給 `createNexusAgent`、一份給
 * `createSubmitRecordPlugin`。但那兩份**不是同一層**：`fold.ts` 交給 `createDeepAgent`
 * 的是**折後**的那一個，而只要有任何 plugin 呼叫 `registry.backend.mount()`，`foldBackend`
 * 就會把組裝點給的那個再包一層 `CompositeBackend`。plugin 收到的是折前的 default。
 *
 * 今天兩者是同一個物件，因為**生產程式碼裡零個 `backend.mount()` 呼叫點**。這一條就是在
 * 釘那個「零」——它不是恆真，是一個現況。
 *
 * **失敗的樣子**：某個 plugin 開始把 `/records/` 之類的前綴路由到別的 backend，之後
 * `write_file` 走路由、`submit_record` 走 default，兩個工具寫到兩個地方——**而且兩邊都會
 * 寫成功**。沒有這一條的話，第一個發現的人是看著檔案的那個人。
 *
 * **紅了要做什麼**：不是把這裡的數字加一。是讓 plugin 拿得到折後的那一個（或讓
 * `submit_record` 的目標路徑落在路由之外並在這裡寫明），然後才改這條。
 */

import { loadPlugins } from '@nexus/core';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PLUGINS } from './cli.js';

describe('注入的 backend 等不等於折出來的那一個', () => {
  it('**預設清單裡零個 `backend.mount()`**——所以折前折後是同一個物件', async () => {
    const { registry } = await loadPlugins(DEFAULT_PLUGINS);
    expect(registry.backend.mounts()).toEqual([]);
  });
});
