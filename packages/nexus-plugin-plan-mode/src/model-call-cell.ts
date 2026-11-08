/**
 * 計劃模式留在相容層的那一格：`plan-mode-model-call` 那一列（`@nexus/plugin-plan-mode/model-call`），一顆只有 `wrapModelCall` 的 middleware。
 *
 * 它做兩件事，樹上都還沒有對應的接縫：
 *
 * - **交出待關**：`exit_plan_mode` 同意之後排的那一格（見 `./index.ts` 檔頭「模式在下一個模型步驟之前才關」），在請求組起來之前交出去，佔 dsh `agent/pre-step` 的邊界提交那半（`apps/harness/src/interception-index.test.ts` 第 2 列）。
 * - **補回 `name`**：core 拿掉 `exit_plan_mode` 結果的 `name`（`./index.ts` 的 `EXIT_PLAN_MODE_CONCLUDES_TURN`），送給模型之前補回去。
 *
 * 這是封閉的單一例外，歸 [#2358](https://github.com/DemianLi/nexus-agent/issues/2358)：這個檔不受 SDK lint 管（`eslint.config.js`），
 * `apps/harness/src/migrated-plugin-gate.test.ts` 列舉 plan-mode 的 import，多一個或少一個都紅。
 *
 * 狀態不在這裡：待關與模式由樹上那一列登記在 `./plan-mode-state.ts`，這一格只讀它。**這一列必須緊接在 `plan-mode` 之後**，
 * 兩列成對出現，由宿主在載入清單時檢查（`apps/harness/src/plugin-config.ts`）。
 *
 * @module
 */

import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { AgentMiddleware, NexusPlugin, PluginRegistry } from '@nexus/core';
import { withModelCallStep } from '@nexus/core';
import { createMiddleware } from 'langchain';

import { EXIT_PLAN_MODE_TOOL_NAME, PLAN_MODE_MIDDLEWARE_NAME } from './index.js';
import { settlePlanModeExit } from './plan-mode-state.js';

/**
 * middleware 的鉤子拿不到 handler 形狀的 config，只有 `runtime.configurable`；包回一層 `configurable` 就是 `registry.sessions.forCall`
 * 要的那份，同 `@nexus/core` 的 `model-usage.ts`。
 */
function callConfigOf(request: unknown): unknown {
  return {
    configurable: (request as { runtime?: { configurable?: unknown } }).runtime?.configurable,
  };
}

/**
 * 送給模型之前，把 `exit_plan_mode` 那些被 core 拿掉 `name` 的結果（沒標記收尾的那些，見 `./index.ts` 的 `EXIT_PLAN_MODE_CONCLUDES_TURN`）補回 `name`，
 * **送給模型的請求跟 core 沒拿掉 `name` 時逐位元組相同**（Chat Completions 的轉換器會把 `name` 送出去）。
 * 路由只看 state 裡的訊息，模型看的是這一份複本；沒有要補的就原物返回，不碰別的 middleware 看到的東西。
 */
function withExitToolNames<T extends { messages?: readonly BaseMessage[] }>(request: T): T {
  const messages = request.messages;
  if (messages === undefined) return request;
  const exitCalls = new Set<string>();
  for (const message of messages) {
    if (!AIMessage.isInstance(message)) continue;
    for (const call of message.tool_calls ?? []) {
      if (call.name === EXIT_PLAN_MODE_TOOL_NAME && call.id !== undefined) exitCalls.add(call.id);
    }
  }
  if (exitCalls.size === 0) return request;
  let changed = false;
  const named = messages.map((message) => {
    if (
      !ToolMessage.isInstance(message) ||
      message.name !== undefined ||
      !exitCalls.has(message.tool_call_id)
    ) {
      return message;
    }
    changed = true;
    return new ToolMessage({
      content: message.content,
      tool_call_id: message.tool_call_id,
      status: message.status,
      name: EXIT_PLAN_MODE_TOOL_NAME,
      ...(message.id === undefined ? {} : { id: message.id }),
      ...(message.artifact === undefined ? {} : { artifact: message.artifact }),
      additional_kwargs: message.additional_kwargs,
      response_metadata: message.response_metadata,
    });
  });
  return changed ? { ...request, messages: named } : request;
}

/**
 * 造這一格的 middleware：每次模型呼叫先交出呼叫者排著的待關，再補回 `name`。
 *
 * 指引不在這裡：它是樹上那一列經 `thread.section` 登記的段，fold 把它接在 `plugins.prepended` 的區尾——也就是這一顆交完待關之後，
 * 所以同一次呼叫裡，指引照交完的模式判。
 *
 * @param registry - 這條 thread 的 registry；只用它的 `sessions.forCall` 認呼叫者。
 */
function createPlanModeMiddleware(registry: PluginRegistry): AgentMiddleware {
  return withModelCallStep(
    (rawRequest, handler) => {
      const request = rawRequest as { readonly messages?: readonly BaseMessage[] };
      // 只認得出來的那一份：子代理的日誌不是計劃模式接著的 root，交不出 root 的待關。
      const found = registry.sessions.forCall(callConfigOf(request));
      if (found.kind === 'ok') settlePlanModeExit(found.log);
      return handler(withExitToolNames(request));
    },
    (wrapModelCall) =>
      createMiddleware({
        name: PLAN_MODE_MIDDLEWARE_NAME,
        wrapModelCall: wrapModelCall as never,
      }) as unknown as AgentMiddleware,
  );
}

/**
 * 相容層那一格。不收設定，所以沒有 `Config`。`plan-mode` 那一列不在時，表裡沒有任何一份日誌，交待關那一半什麼都不做；
 * 宿主仍拒絕這種清單（見檔頭）。
 */
export const planModeModelCallPlugin: NexusPlugin = {
  name: 'plan-mode-model-call',
  apply(registry: PluginRegistry): void {
    registry.middleware.use(createPlanModeMiddleware(registry), { prepend: true });
  },
};

export default planModeModelCallPlugin;
