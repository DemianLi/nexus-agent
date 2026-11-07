/**
 * serve 的行程模型的**設定條目**（[#2341](https://github.com/DemianLi/nexus-agent/issues/2341)，設計 `.docs/supervisor-1947-design-2026-11-03.md` §八）。
 *
 * 形狀與載體同 [`./thread-title.ts`](./thread-title.ts) 的檔頭。這一顆自己的三件事：
 *
 * 1. **`mode`**：`single` 是一個行程放所有 thread；`per-thread` 是監督行程起一個前台、每條 thread 一個對話行程。
 *    預設 `single`，`--process-model` 旗標蓋過這一格。`per-thread` 只在 Linux 起得來。
 * 2. **`supervisorBinary`**：監督行程執行檔的絕對路徑。省略就從 harness 的位置往上找產物裡的 `native/nexus-supervisor`，
 *    同 spawner 的找法（`tool-launcher.ts` 的 `findSpawnerBinary`）。
 * 3. **消費者在任何組裝之前**：啟動器（`process-launcher.ts`）只疊層、不載模組（`composeDefaultEntries`），找到這一列就用這份
 *    schema 驗，再決定要不要換成監督行程。所以這一列的 `apply` 是空的，關掉它就是 `single`。
 *
 * @module
 */

import { isAbsolute } from 'node:path';

import { z } from 'zod';

import type { NexusPlugin, PluginRegistry } from '@nexus/core';

/** 這一列在訊息裡叫什麼。 */
export const PROCESS_MODEL_PLUGIN_NAME = 'process-model';

/** 清單上這一列的模組 specifier。 */
export const PROCESS_MODEL_ENTRY_NAME = '#settings/process-model';

export const PROCESS_MODELS = ['single', 'per-thread'] as const;

export type ProcessModel = (typeof PROCESS_MODELS)[number];

/** `strictObject`：多寫一個欄位是打錯字，同其他幾列。 */
export const processModelConfigSchema = z.strictObject({
  mode: z.enum(PROCESS_MODELS).default('single'),
  supervisorBinary: z
    .string()
    .refine((path) => isAbsolute(path), { message: 'supervisorBinary 要是絕對路徑' })
    .optional(),
});

/** 驗過的設定。 */
export type ProcessModelConfig = z.infer<typeof processModelConfigSchema>;

/** 只講設定的那一顆，見檔頭。 */
export const processModelPlugin: NexusPlugin<ProcessModelConfig> = {
  name: PROCESS_MODEL_PLUGIN_NAME,
  Config: processModelConfigSchema,
  apply: (_registry: PluginRegistry, _config: ProcessModelConfig): void => {
    // 空的：組裝期沒有消費者。
  },
};

export default processModelPlugin;
