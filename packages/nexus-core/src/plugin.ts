/**
 * NexusPlugin 契約本身：plugin 的形狀、它的 manifest 驗證，以及「是誰註冊的」這個身分。
 */

import { z } from 'zod';
import type { PluginRegistry } from './registry.js';

/**
 * 一個 plugin。`apply` 是命令式註冊——plugin 拿到 registry，自己決定往哪幾個
 * 擴充點放東西，而不是交出一份靜態宣告讓 harness 去解讀。
 */
export interface NexusPlugin {
  /**
   * 純標籤，唯一用途是錯誤訊息指名。**不唯一**：同一個 plugin 工廠掛載多次是
   * 合法的（`createMcpPlugin({ server: 'github' })` 與
   * `createMcpPlugin({ server: 'linear' })` 都叫 `mcp`），真撞了會撞在它們註冊
   * 的東西那一層，不是在這裡。
   */
  name: string;
  /**
   * 需要的能力名，不是 plugin 名。只做存在性檢查、不排序——載入順序由清單決定，
   * `requires` 不參與。
   */
  requires?: string[];
  apply(registry: PluginRegistry): void | Promise<void>;
}

/**
 * manifest 只驗 `name` 與 `requires`。擴充內容不驗：那些東西的合法性由各註冊點
 * 自己的規則守（同名 tool、同名 subagent），驗兩次只會讓規則有兩個出處。
 */
export const pluginManifestSchema = z.object({
  name: z.string().min(1, 'plugin 的 name 不能是空字串'),
  requires: z.array(z.string().min(1, 'requires 裡的能力名不能是空字串')).optional(),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

/**
 * 某次註冊的來源。`name` 不唯一，所以指名靠的是清單位置——`index` 才是那個
 * 「哪一次掛載」的答案。
 */
export interface PluginOrigin {
  /** 在載入清單裡的位置。 */
  index: number;
  /** 該 plugin 的 `name`。 */
  name: string;
}

/** 錯誤訊息裡指名一次掛載的寫法，例如 `plugins[1] (mcp)`。 */
export function formatOrigin(origin: PluginOrigin): string {
  return `plugins[${origin.index}] (${origin.name})`;
}

/**
 * 驗一個 plugin 的 manifest，並把 zod 的錯誤翻成指得出是清單裡哪一個的訊息。
 * @param plugin - 待驗的 plugin。
 * @param index - 它在載入清單裡的位置。
 * @returns 通過驗證的 manifest。
 */
export function parsePluginManifest(plugin: NexusPlugin, index: number): PluginManifest {
  if (typeof plugin?.apply !== 'function') {
    throw new TypeError(`plugins[${index}] 沒有 apply 方法，不是一個 NexusPlugin`);
  }
  const result = pluginManifestSchema.safeParse(plugin);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new TypeError(`plugins[${index}] 的 manifest 不合法 — ${detail}`);
  }
  return result.data;
}
