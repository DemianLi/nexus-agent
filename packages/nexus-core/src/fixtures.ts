/**
 * 測試用的假 plugin 與假擴充內容。只給本套件的測試用，不從 `index.ts` 對外匯出。
 *
 * 衝突單測用的一次性假 plugin 全部留在這裡——真的 workspace plugin（證明契約沒有
 * 偷偷要求你伸手進 harness 內部的那一個）是 `packages/nexus-plugin-echo` 的事。
 */

import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import type { SubAgent } from 'deepagents';
import { z } from 'zod';
import type { NexusPlugin, PluginRegistry } from './index.js';

/**
 * 一個什麼都不做、只有名字有意義的工具。
 * @param name - 工具名。
 * @returns 可註冊的工具。
 */
export function fakeTool(name: string): StructuredTool {
  return tool(() => `${name} 跑過了`, {
    name,
    description: `測試用的 ${name}`,
    schema: z.object({}),
  });
}

/**
 * 一個只有名字與描述的 subagent。
 * @param name - subagent 名。
 * @returns 可註冊的 subagent。
 */
export function fakeSubAgent(name: string): SubAgent {
  return { name, description: `測試用的 ${name}` };
}

/**
 * 包一個 plugin。
 * @param name - plugin 名，不必唯一。
 * @param apply - 註冊內容。
 * @param requires - 需要的能力。
 * @returns 可載入的 plugin。
 */
export function fakePlugin(
  name: string,
  apply: (registry: PluginRegistry) => void | Promise<void>,
  requires?: string[],
): NexusPlugin {
  return requires === undefined ? { name, apply } : { name, requires, apply };
}
