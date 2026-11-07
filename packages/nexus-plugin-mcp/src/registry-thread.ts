/**
 * 把相容層的 registry 包成一條 `ToolThread`。**只給還沒搬的測試和 cli-mcp 手動夾具用，#2535 拿掉**；不從套件入口匯出。
 *
 * @module
 */

// eslint-disable-next-line no-restricted-imports -- 相容層暫時路徑，#2535 拿掉
import { admittedTools, createToolListStepMiddleware } from '@nexus/core';
// eslint-disable-next-line no-restricted-imports -- 相容層暫時路徑，#2535 拿掉
import type { PluginRegistry } from '@nexus/core';
import type { ToolThread } from '@nexus/tools';

/** 暫時路徑的 `shared`：一次組裝一份 registry，以它為鍵。 */
// eslint-disable-next-line no-restricted-syntax -- 相容層暫時路徑，以 registry 為鍵、registry 收掉就回收；#2535 拿掉
const sharedByRegistry = new WeakMap<PluginRegistry, object>();

/**
 * 把相容層的 registry 包成一條 {@link ToolThread}。
 *
 * 跟宿主的 `threadSource` 不同的地方：`services.get` 不檢查宣告、什麼都給；`shared` 以 registry 為範圍，不分插件；`onDispose`
 * 直接交給 `registry.lifecycle`，這一列 `apply` 失敗時被 rollback 撤掉、不跑；`apply` 結束之後再叫各方法不拋。
 *
 * @param registry - 這一次組裝的 registry。
 * @returns 包好的 thread。
 */
export function registryThread(registry: PluginRegistry): ToolThread {
  let shared = sharedByRegistry.get(registry);
  if (shared === undefined) {
    shared = {};
    sharedByRegistry.set(registry, shared);
  }
  let admissions = 0;
  return {
    services: { get: (service) => registry.services.get(service) },
    register: (tool, options) =>
      registry.tools.register(
        tool as Parameters<PluginRegistry['tools']['register']>[0],
        options as Parameters<PluginRegistry['tools']['register']>[1],
      ),
    gate: (listener) => registry.approvals.gate(listener),
    admit(admission, options) {
      admissions += 1;
      return registry.middleware.use(
        createToolListStepMiddleware(
          options?.name ?? `mcp:admit:${String(admissions)}`,
          (request) => {
            const admitted = admittedTools(request.tools, admission);
            return admitted.length === request.tools.length ? undefined : admitted;
          },
        ),
      );
    },
    section: (section) => registry.prompt.section(section),
    onDispose(dispose) {
      registry.lifecycle.onDispose(dispose);
    },
    logger: registry.logger.bind(),
    shared,
  };
}
