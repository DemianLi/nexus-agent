/**
 * 檔案工具裡 `execute`、`delete` 放不放行，看這一次模型呼叫解析出來的 backend 有沒有那個能力（[#2415](https://github.com/DemianLi/nexus-agent/issues/2415)）。
 *
 * 判法照基座 `FilesystemMiddleware` 的 `wrapModelCall`（`deepagents@1.13.1`，`dist/langsmith-zm0ILQsV.js` 的 `isSandboxBackend`、
 * `supportsDelete`）。組裝點把基座那一顆的 `wrapModelCall` 換成 {@link filesystemModelCallWrap}：先套這份決定（{@link filesystemToolListStep}），再交給基座原本的
 * `wrapModelCall`，基座自己那份過濾因此什麼都不拿掉；系統提示與搬走人話的截斷照舊由基座做。
 *
 * @module
 */

import { isSandboxBackend, resolveBackend } from 'deepagents';

import { admittedTools } from './tool-resolution.js';
import type { ToolAdmission } from './tool-resolution.js';
import { wrapModelCallWith } from './tool-list-step.js';
import type { ToolListRequest, ToolListStep } from './tool-list-step.js';

/**
 * 這個 backend 下 `execute`、`delete` 放不放行；其餘名字一律放行。
 *
 * 基座比的是 `delete` 工具的物件身分，這裡比名字。前提是同名的只有基座那一顆：harness 在進 fold 之前用
 * `assertNoBaseToolNameCollision`（`apps/harness/src/agent-factory.ts`）擋下佔用基座工具名的註冊；不經 harness 直接組裝的呼叫端要自己守。
 *
 * @param resolved - `resolveBackend` 解析出來的 backend。
 * @returns 放行決定。
 */
export function filesystemToolAdmission(resolved: unknown): ToolAdmission {
  const supportsExecution = isSandboxBackend(resolved as never);
  const supportsDelete = typeof (resolved as { delete?: unknown }).delete === 'function';
  return {
    admits: (name) =>
      (supportsExecution || name !== 'execute') && (supportsDelete || name !== 'delete'),
  };
}

/**
 * 基座那一格的工具清單那一步：每次呼叫解析 backend、套 {@link filesystemToolAdmission}；一顆都沒拿掉時不換。
 *
 * @param backend - 建基座那一顆時交的 backend（實例或工廠）。
 * @returns 這一步。
 */
export function filesystemToolListStep(backend: unknown): ToolListStep {
  return async (request) => {
    const resolved = await resolveBackend(
      backend as never,
      { ...request.runtime, state: request.state } as never,
    );
    const tools = admittedTools(request.tools, filesystemToolAdmission(resolved));
    return tools.length === request.tools.length ? undefined : tools;
  };
}

/**
 * 基座那一格的 `wrapModelCall`：先套 {@link filesystemToolListStep}，再交給基座原本的那一支。一顆都沒拿掉時交下原本的請求物件。
 *
 * @param backend - 建基座那一顆時交的 backend（實例或工廠）。
 * @param inner - 基座原本的 `wrapModelCall`。
 * @returns 換上去的 `wrapModelCall`。
 */
export function filesystemModelCallWrap<R extends ToolListRequest, H, T>(
  backend: unknown,
  inner: (request: R, handler: H) => T | Promise<T>,
): (request: R, handler: H) => Promise<T> {
  return wrapModelCallWith(filesystemToolListStep(backend), inner) as (
    request: R,
    handler: H,
  ) => Promise<T>;
}
