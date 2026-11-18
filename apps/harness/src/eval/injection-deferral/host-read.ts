/**
 * `host-read` 候選（[#2934](https://github.com/DemianLi/nexus-agent/issues/2934)）：指示檔放不進預算時，宿主在第一個模型請求之前替模型
 * 讀一次，模型眼前出現一次 `read_file` 的呼叫與它的結果，使用者訊息裡不留指標。
 *
 * `PreStepInjection` 只能交使用者訊息，所以這一種自己建 middleware：讀檔、判斷放不放得下仍交給出貨的 listener
 * （`createAgentInstructionsListener`，渲染換成只回放得下的那幾份、順手記下放不下的）。結果字串由**真的 `read_file` 工具**產生：
 * 基座的工具、`recordReadExtent` 與 `readContinuationToolStep` 照 fold 的疊法疊起來，行號格式、頁的上限與續讀提示因此與模型自己叫時
 * 逐字相同，不在這裡另寫一份格式。
 *
 * 模型看到的歷史取自會話日誌（出貨的 `history-source: log`），所以助手訊息與工具結果除了進 state，也要依序寫進日誌。
 * 判斷「已經有了」看 state 裡有沒有帶指示記號的訊息，與出貨的 listener 同一個判準，不放在閉包。
 * 這是評估用的做法：摘要把它切掉之後 state 裡仍在，所以不會補第二次，產品化時要改看宿主交的可見歷史。
 */

import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { READ_LIMIT, createHookStepMiddleware, sourceKwargs, toLoggedMessage } from '@nexus/core';
import type { PluginRegistry } from '@nexus/core';
import { readContinuationToolStep, recordReadExtent } from '@nexus/core/src/read-continuation.js';
import {
  AGENT_INSTRUCTIONS_MARKER,
  AGENT_INSTRUCTIONS_MIDDLEWARE_NAME,
  INJECTION_DEFERRED_BYTES_KEY,
  createAgentInstructionsListener,
  renderAgentInstructions,
} from '@nexus/plugin-agent-instructions';
import type {
  AgentInstructionsLimits,
  InstructionFile,
  RenderedAgentInstructions,
} from '@nexus/plugin-agent-instructions';
import { createFilesystemMiddleware } from 'deepagents';
import type { AgentMiddleware } from 'langchain';

import { nextContextWindowOf } from '../../model-selection-host.js';
import { registryFsLookup } from '../../registry-fs-lookup.js';

/** 宿主做的那次讀，工具呼叫 id 的開頭。第一個請求裡認得出「這是宿主讀的」靠它。 */
export const HOST_READ_ID_PREFIX = 'host-read-';

/** 宿主做的助手訊息帶的記號（`additional_kwargs`）：`observe` 不把它算成模型自己去讀。 */
export const HOST_READ_KWARG = 'nexus.hostRead';

/** 這則助手訊息是宿主替模型做的那次讀。 */
export const isHostReadMessage = (message: BaseMessage): boolean =>
  message.additional_kwargs?.[HOST_READ_KWARG] === true;

const byteLength = (value: string): number => Buffer.byteLength(value, 'utf8');

/** 出貨渲染挑出放不下的，其餘照出貨渲染；放不下的那幾份記進 `deferred`。 */
function splitRender(
  files: readonly InstructionFile[],
  maxBytes: number,
  deferred: InstructionFile[],
): RenderedAgentInstructions | undefined {
  const shipped = renderAgentInstructions(files, maxBytes);
  if (shipped === undefined || shipped.deferred.length === 0) return shipped;
  const paths = new Set(shipped.deferred.map((item) => item.displayPath));
  deferred.push(...files.filter((file) => paths.has(file.displayPath)));
  const kept = files.filter((file) => !paths.has(file.displayPath));
  return kept.length === 0 ? undefined : renderAgentInstructions(kept, maxBytes);
}

/** 用真的 `read_file` 讀一份檔的第一頁（含行號與續讀提示）。 */
async function readFirstPage(
  backend: object,
  path: string,
  callId: string,
  configurable: unknown,
  signal: AbortSignal | undefined,
): Promise<ToolMessage> {
  const { tools } = createFilesystemMiddleware({ backend: recordReadExtent(backend) as never });
  const readTool = (tools ?? []).find((each) => each.name === 'read_file');
  if (readTool === undefined) throw new Error('基座的檔案工具裡沒有 read_file');
  const args = { file_path: path };
  const result = await readContinuationToolStep(READ_LIMIT)(
    { callId, name: 'read_file', args, tool: readTool, state: undefined, configurable, signal },
    (substitute) =>
      readTool.invoke({
        type: 'tool_call',
        id: callId,
        name: 'read_file',
        args: (substitute?.args as Record<string, unknown> | undefined) ?? args,
      }),
  );
  if (!ToolMessage.isInstance(result)) throw new Error(`宿主讀 ${path} 沒有得到工具訊息`);
  return result;
}

/** 把一則訊息記進這次呼叫的會話日誌；找不到日誌就不記（同 `pre-step-middleware.ts` 的注入）。 */
function logOf(registry: PluginRegistry, configurable: unknown) {
  const found = registry.sessions.forCall({ configurable });
  return found.kind === 'ok' ? found.log : undefined;
}

/**
 * 建 `host-read` 的 middleware，掛在出貨 `agent-instructions` 那一列的位置。
 *
 * @param registry - 這次組裝的 registry：fs 查找、會話日誌都從這裡拿。
 * @param limits - 渲染預算與單檔上限。
 * @returns 一顆 `beforeAgent` middleware。
 */
export function createHostReadMiddleware(
  registry: PluginRegistry,
  limits: AgentInstructionsLimits,
): AgentMiddleware {
  const lookup = registryFsLookup(registry);
  return createHookStepMiddleware({
    name: AGENT_INSTRUCTIONS_MIDDLEWARE_NAME,
    beforeAgent: async (state: unknown, hookRuntime: unknown) => {
      const runtime = hookRuntime as {
        readonly configurable?: unknown;
        readonly signal?: AbortSignal;
      };
      const current = (state as { messages?: readonly BaseMessage[] }).messages ?? [];
      const deferred: InstructionFile[] = [];
      let fs: ReturnType<typeof lookup> | undefined;
      const listener = createAgentInstructionsListener(
        limits,
        {
          fs: (invocation) => {
            fs = lookup(invocation);
            return fs;
          },
        },
        (files, maxBytes) => splitRender(files, maxBytes, deferred),
      );
      const contextWindow = nextContextWindowOf(registry);
      const injections = await listener(current, {
        configurable: runtime?.configurable,
        ...(runtime?.signal !== undefined && { signal: runtime.signal }),
        ...(contextWindow !== undefined && { contextWindow }),
      });
      const log = logOf(registry, runtime?.configurable);
      const messages: BaseMessage[] = [];

      for (const injection of injections ?? []) {
        const source = injection.source as {
          readonly kind: 'plugin';
          readonly plugin: string;
          readonly form?: 'instructions';
        };
        const message = new HumanMessage({
          content: injection.content,
          additional_kwargs: { ...injection.additionalKwargs, ...sourceKwargs(source) },
        });
        log?.append('user/message', { message: toLoggedMessage(message), source });
        messages.push(message);
      }

      if (deferred.length > 0 && fs?.kind === 'ok') {
        const backend = fs.fs.backend();
        if (backend !== undefined) {
          const calls = deferred.map((file, index) => ({
            id: `${HOST_READ_ID_PREFIX}${index + 1}`,
            file,
          }));
          const results = await Promise.all(
            calls.map(({ id, file }) =>
              readFirstPage(
                backend,
                file.readPath ?? file.displayPath,
                id,
                runtime?.configurable,
                runtime?.signal,
              ),
            ),
          );
          const requested = new AIMessage({
            content: '',
            tool_calls: calls.map(({ id, file }) => ({
              id,
              name: 'read_file',
              args: { file_path: file.readPath ?? file.displayPath },
              type: 'tool_call' as const,
            })),
            additional_kwargs: {
              [AGENT_INSTRUCTIONS_MARKER]: true,
              [HOST_READ_KWARG]: true,
              [INJECTION_DEFERRED_BYTES_KEY]: deferred.reduce(
                (sum, file) => sum + byteLength(file.content),
                0,
              ),
            },
          });
          log?.append('assistant/message', { message: toLoggedMessage(requested) });
          messages.push(requested);
          for (const result of results) {
            log?.append('tool/result', {
              callId: result.tool_call_id,
              isError: false,
              message: toLoggedMessage(result),
            });
            messages.push(result);
          }
        }
      }
      return messages.length === 0 ? undefined : { messages };
    },
  });
}
