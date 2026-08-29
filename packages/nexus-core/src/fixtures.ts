/**
 * 測試用的假 plugin 與假擴充內容。只給本套件的測試用，不從 `index.ts` 對外匯出。
 *
 * 衝突單測用的一次性假 plugin 全部留在這裡——真的 workspace plugin（證明契約沒有
 * 偷偷要求你伸手進 harness 內部的那一個）是 `packages/nexus-plugin-echo` 的事。
 */

import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import type { AnyBackendProtocol, SubAgent } from 'deepagents';
import { z } from 'zod';
import type {
  AgentMiddleware,
  NexusPlugin,
  PluginRegistry,
  SessionTelemetryRecord,
  SessionTelemetryService,
  SessionTelemetrySharingStatus,
} from './index.js';

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

/**
 * 一個只有身分、沒有行為的 backend。
 *
 * fold 只把 backend 當值搬運，基座的 `CompositeBackend` 也只在真的做檔案操作時才
 * 碰它的方法，所以測試不需要一個會動的 backend——需要的是一個認得出來的東西。
 * @param id - 認得出是哪一個用的標記。
 * @returns 可以掛上去的假 backend。
 */
export function fakeBackend(id: string): AnyBackendProtocol {
  return { nexusFakeBackend: id } as unknown as AnyBackendProtocol;
}

/**
 * 一個只有名字的 middleware。
 * @param name - middleware 名。
 * @returns 可以註冊的假 middleware。
 */
export function fakeMiddleware(name: string): AgentMiddleware {
  return { name } as unknown as AgentMiddleware;
}

/** 記下收到什麼的假後端，加上一支看得到關機次數的計數。 */
export interface FakeSink extends SessionTelemetryService {
  readonly records: SessionTelemetryRecord[];
  readonly flushes: { count: number };
  readonly shutdowns: { count: number };
}

/**
 * 一個只會把記錄收進陣列的後端。
 *
 * `emit` 契約上要求非阻塞入隊——push 進陣列正是那個形狀，所以這個假貨在時序上跟真的
 * 一樣，不會替被測程式掩蓋掉「同步呼叫」這件事。
 *
 * @param options - `emit` / `shutdown` 要不要拋，用來驗圍堵。
 * @returns 可以掛上去的假後端。
 */
export function fakeSink(
  options: {
    readonly onEmit?: () => void;
    readonly onFlush?: () => void;
    readonly onShutdown?: () => void;
    readonly sharing?: SessionTelemetrySharingStatus;
  } = {},
): FakeSink {
  const records: SessionTelemetryRecord[] = [];
  const flushes = { count: 0 };
  const shutdowns = { count: 0 };
  return {
    records,
    flushes,
    shutdowns,
    sharing: options.sharing ?? 'full',
    emit(record) {
      options.onEmit?.();
      records.push(record);
    },
    flush() {
      flushes.count += 1;
      options.onFlush?.();
    },
    shutdown() {
      shutdowns.count += 1;
      options.onShutdown?.();
      return Promise.resolve();
    },
  };
}
