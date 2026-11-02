/**
 * 執行中的 `@nexus/core` 的版本——**插件契約的版本**。
 *
 * 插件在自己的 `package.json` 用 `peerDependencies['@nexus/core']` 宣告它需要的範圍，載入器在 `import()` 之前拿這個版本去比
 * （[#1137](https://github.com/DemianLi/nexus-agent/issues/1137)，照 dsh `packages/boot/app-boot/src/plugin-compatibility.ts`：只讀 manifest，
 * 不 import 插件的程式碼）。
 *
 * **這個數字只有人守得住**：改了 registry 的形狀（欄位改名、註冊點簽章換形狀、聯集少一支）就要跟著升 `package.json` 的 `version`，
 * 不然範圍檢查會放行一個其實已經不相容的插件。目前沒有機械守著。
 */

import { readFileSync } from 'node:fs';

/** `@nexus/core` 的 `package.json` 裡的 `version`。 */
export const NEXUS_CORE_VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
