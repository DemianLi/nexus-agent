/**
 * 檔案工具裡 `execute`、`delete` 放不放行，看這一次模型呼叫解析出來的 backend 有沒有那個能力（[#2415](https://github.com/DemianLi/nexus-agent/issues/2415)）。
 *
 * 判法照基座 `FilesystemMiddleware` 的 `wrapModelCall`（`deepagents@1.13.1`，`dist/langsmith-zm0ILQsV.js` 的 `isSandboxBackend`、
 * `supportsDelete`）。組裝點把基座那一顆的 `wrapModelCall` 換成 {@link filesystemModelCallWrap}：先套這份決定，再交給基座原本的
 * `wrapModelCall`，基座自己那份過濾因此什麼都不拿掉；系統提示與搬走人話的截斷照舊由基座做。
 *
 * @module
 */

import { isSandboxBackend, resolveBackend } from 'deepagents';

import { admittedTools } from './tool-resolution.js';
import type { ToolAdmission } from './tool-resolution.js';

/**
 * 這個 backend 下 `execute`、`delete` 放不放行；其餘名字一律放行。
 *
 * 基座比的是 `delete` 工具的物件身分，這裡比名字：別的來源的同名工具在 fold 就撞名，到不了這一格。
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

/** {@link filesystemModelCallWrap} 收的請求：用得到的那幾格。 */
interface ModelCallRequest {
  readonly tools: readonly unknown[];
  readonly runtime?: object;
  readonly state?: unknown;
}

/**
 * 基座那一格的 `wrapModelCall`：每次呼叫解析 backend、套 {@link filesystemToolAdmission}，再交給基座原本的那一支。
 * 一顆都沒拿掉時交下原本的請求物件。
 *
 * @param backend - 建基座那一顆時交的 backend（實例或工廠）。
 * @param inner - 基座原本的 `wrapModelCall`。
 * @returns 換上去的 `wrapModelCall`。
 */
export function filesystemModelCallWrap<R extends ModelCallRequest, H, T>(
  backend: unknown,
  inner: (request: R, handler: H) => T | Promise<T>,
): (request: R, handler: H) => Promise<T> {
  return async (request, handler) => {
    const resolved = await resolveBackend(
      backend as never,
      { ...request.runtime, state: request.state } as never,
    );
    const tools = admittedTools(request.tools, filesystemToolAdmission(resolved));
    return inner(tools.length === request.tools.length ? request : { ...request, tools }, handler);
  };
}
