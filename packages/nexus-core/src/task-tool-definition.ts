/**
 * 基座 `task` 在模型那一側的定義，由 core 逐字造出來（[#2415](https://github.com/DemianLi/nexus-agent/issues/2415)）。
 *
 * 字串與 schema 照基座 `createTaskTool`（`deepagents@1.13.1`，`dist/langsmith-zm0ILQsV.js` 的 `getTaskToolDescription` 與
 * `createTaskTool` 的 `schema`）。組裝點（`subAgentMiddleware`）不收 `taskDescription`、自己設 `generalPurposeAgent: false`，
 * 所以清單就是 fold 給的那幾個子代理。
 * `task-tool-definition.test.ts` 對著真的基座逐字比，基座升級改了字就紅在那裡。
 *
 * 換掉的只有模型看到的那一份；執行找的仍是基座那顆（LangGraph 子圖）。組裝點（`agent-assembly.ts` 的 `subAgentMiddleware`）
 * 在基座那一格的 `wrapModelCall` 先套 {@link taskToolOverride}，再交給基座原本的那一支。
 *
 * @module
 */

import { context } from 'langchain';

import type { ToolOverride } from './tool-resolution.js';

/** 基座委派工具的名字。 */
export const TASK_TOOL_NAME = 'task';

/** 清單上的一個子代理：基座描述裡用到的兩格。 */
export interface TaskSubagent {
  readonly name: string;
  readonly description: string;
}

function taskDescription(subagentDescriptions: readonly string[]): string {
  return context`
    Launch an ephemeral subagent to handle a complex, multi-step task in an isolated context window.

    Available agent types and the tools they have access to:
    ${subagentDescriptions.join('\n')}

    Specify subagent_type to select the agent. Usage notes:
    - Launch multiple agents concurrently when their tasks are independent, using a single message with multiple tool calls.
    - Each invocation is stateless: the agent sees only the prompt you give it and returns a single final report. Put full detail in the prompt and state exactly what it should return.
    - The agent's report is not shown to the user; relay a summary yourself.
    - Tell the agent whether to create content, analyze, or only research, since it cannot see the user's intent.
    - If an agent's description says to use it proactively, do so without waiting to be asked.
    - When only general-purpose is available, use it for any complex, context-heavy task; it has the same capabilities as the main agent.
  `;
}

/**
 * 模型看到的 `task`：OpenAI 形狀的一份定義，不是工具。帶一格不可列舉的 `name`：疊裡靠 `toolNameOf` 認工具的那幾格
 * （`ToolAdmission` 的放行、harness 背景委派找 `task`）才認得出它是 `task`；不可列舉，序列化進請求本體時不多一格。
 *
 * @param subagents - 交給基座的子代理清單，照先後。
 * @returns 那一份定義。
 */
export function taskToolDefinition(subagents: readonly TaskSubagent[]): object {
  const definition = {
    type: 'function',
    function: {
      name: TASK_TOOL_NAME,
      description: taskDescription(
        subagents.map((subagent) => `- ${subagent.name}: ${subagent.description}`),
      ),
      parameters: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'The task to execute with the selected agent',
          },
          subagent_type: {
            type: 'string',
            description: `Name of the agent to use. Available: ${subagents.map((subagent) => subagent.name).join(', ')}`,
          },
        },
        required: ['description', 'subagent_type'],
        additionalProperties: false,
      },
    },
  };
  Object.defineProperty(definition, 'name', { value: TASK_TOOL_NAME, enumerable: false });
  return definition;
}

/**
 * 把清單上的 `task` 換成 {@link taskToolDefinition}。定義只算一次，每次都交同一個物件。
 *
 * @param subagents - 交給基座的子代理清單，照先後。
 * @returns 這一格的覆寫。
 */
export function taskToolOverride(subagents: readonly TaskSubagent[]): ToolOverride {
  const definition = taskToolDefinition(subagents);
  return { override: (_tool, name) => (name === TASK_TOOL_NAME ? definition : undefined) };
}
