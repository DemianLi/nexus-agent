/**
 * skills 與記憶這兩段的文字（[#2414](https://github.com/DemianLi/nexus-agent/issues/2414)）。
 *
 * 模板與格式化逐字照 `deepagents@1.13.1`（`dist/langsmith-zm0ILQsV.js` 的 `SKILLS_SYSTEM_PROMPT`、`formatSkillsLocations`、
 * `formatSkillsList`、`formatSkillAnnotations`、`MEMORY_SYSTEM_PROMPT`、`formatMemoryContents`）：基座不匯出它們，模型看到的位元組
 * 又不能變。`base-prompt-text.test.ts` 拿基座自己的 middleware 渲染同一份資料逐位元組比，基座升版改了措辭會紅。
 *
 * @module
 */

import { context } from 'langchain';

/** 一個技能在清單上用得到的欄位，形狀同基座掃出來的 `skillsMetadata` 一筆。 */
export interface SkillListing {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly license?: string | null;
  readonly compatibility?: string | null;
  readonly allowedTools?: readonly string[];
  readonly module?: string;
}

/** 基座叫模型讀技能檔時給的行數。 */
const SKILL_READ_LINE_LIMIT = 1e3;

const SKILLS_SYSTEM_PROMPT = context`
  ## Skills System

  You have access to a skills library that provides specialized capabilities and domain knowledge.

  {skills_locations}

  **Available Skills:**

  {skills_list}

  **How to Use Skills (Progressive Disclosure):**

  Skills follow a **progressive disclosure** pattern - you know they exist (name + description above), but you only read the full instructions when needed:

  1. **Recognize when a skill applies**: Check if the user's task matches any skill's description
  2. **Read the skill's full instructions**: Use \`read_file\` on the path shown in the skill list above.
     Pass \`limit=${SKILL_READ_LINE_LIMIT}\` since the default of ${100} lines is too small for most skill files.
  3. **Follow the skill's instructions**: SKILL.md contains step-by-step workflows, best practices, and examples
  4. **Access supporting files**: Skills may include scripts, configs, or reference docs - use absolute paths

  **When to Use Skills:**
  - When the user's request matches a skill's domain (e.g., "research X" → web-research skill)
  - When you need specialized knowledge or structured workflows
  - When a skill provides proven patterns for complex tasks
  **Skills are Self-Documenting:**
  - Each SKILL.md tells you exactly what the skill does and how to use it
  - The skill list above shows the full path for each skill's SKILL.md file

  **Executing Skill Scripts:**
  Skills may contain scripts or other executable files. Always use absolute paths from the skill list.

  **Example Workflow:**

  User: "Can you research the latest developments in quantum computing?"

  1. Check available skills above → See "web-research" skill with its full path
  2. Read the full skill file: \`read_file(file_path, limit=${SKILL_READ_LINE_LIMIT})\`
  3. Follow the skill's research workflow (search → organize → synthesize)
  4. Use any helper scripts with absolute paths

  Remember: Skills are tools to make you more capable and consistent. When in doubt, check if a skill exists for the task!
`;

const MEMORY_SYSTEM_PROMPT = context`
  <agent_memory>
  {memory_contents}
  </agent_memory>

  <memory_guidelines>
      The above <agent_memory> was loaded in from files in your filesystem. As you learn from your interactions with the user, you can save new knowledge by calling the \`edit_file\` tool.

      **Learning from feedback:**
      - One of your MAIN PRIORITIES is to learn from your interactions with the user. These learnings can be implicit or explicit. This means that in the future, you will remember this important information.
      - When you need to remember something, updating memory must be your FIRST, IMMEDIATE action - before responding to the user, before calling other tools, before doing anything else. Just update memory immediately.
      - When user says something is better/worse, capture WHY and encode it as a pattern.
      - Each correction is a chance to improve permanently - don't just fix the immediate issue, update your instructions.
      - A great opportunity to update your memories is when the user interrupts a tool call and provides feedback. You should update your memories immediately before revising the tool call.
      - Look for the underlying principle behind corrections, not just the specific mistake.
      - The user might not explicitly ask you to remember something, but if they provide information that is useful for future use, you should update your memories immediately.

      **Asking for information:**
      - If you lack context to perform an action (e.g. send a Slack DM, requires a user ID/email) you should explicitly ask the user for this information.
      - It is preferred for you to ask for information, don't assume anything that you do not know!
      - When the user provides information that is useful for future use, you should update your memories immediately.

      **When to update memories:**
      - When the user explicitly asks you to remember something (e.g., "remember my email", "save this preference")
      - When the user describes your role or how you should behave (e.g., "you are a web researcher", "always do X")
      - When the user gives feedback on your work - capture what was wrong and how to improve
      - When the user provides information required for tool use (e.g., slack channel ID, email addresses)
      - When the user provides context useful for future tasks, such as how to use tools, or which actions to take in a particular situation
      - When you discover new patterns or preferences (coding styles, conventions, workflows)

      **When to NOT update memories:**
      - When the information is temporary or transient (e.g., "I'm running late", "I'm on my phone right now")
      - When the information is a one-time task request (e.g., "Find me a recipe", "What's 25 * 4?")
      - When the information is a simple question that doesn't reveal lasting preferences (e.g., "What day is it?", "Can you explain X?")
      - When the information is an acknowledgment or small talk (e.g., "Sounds good!", "Hello", "Thanks for that")
      - When the information is stale or irrelevant in future conversations
      - Never store API keys, access tokens, passwords, or any other credentials in any file, memory, or system prompt.
      - If the user asks where to put API keys or provides an API key, do NOT echo or save it.

      **Examples:**
      Example 1 (remembering user information):
      User: Can you connect to my google account?
      Agent: Sure, I'll connect to your google account, what's your google account email?
      User: john@example.com
      Agent: Let me save this to my memory.
      Tool Call: edit_file(...) -> remembers that the user's google account email is john@example.com

      Example 2 (remembering implicit user preferences):
      User: Can you write me an example for creating a deep agent in LangChain?
      Agent: Sure, I'll write you an example for creating a deep agent in LangChain <example code in Python>
      User: Can you do this in JavaScript
      Agent: Let me save this to my memory.
      Tool Call: edit_file(...) -> remembers that the user prefers to get LangChain code examples in JavaScript
      Agent: Sure, here is the JavaScript example<example code in JavaScript>

      Example 3 (do not remember transient information):
      User: I'm going to play basketball tonight so I will be offline for a few hours.
      Agent: Okay I'll add a block to your calendar.
      Tool Call: create_calendar_event(...) -> just calls a tool, does not commit anything to memory, as it is transient information
  </memory_guidelines>
`;

function formatSkillsLocations(sources: readonly string[]): string {
  if (sources.length === 0) return '**Skills Sources:** None configured';
  const lines: string[] = [];
  for (let i = 0; i < sources.length; i++) {
    const sourcePath = sources[i]!;
    const name =
      sourcePath
        .replace(/[/\\]$/, '')
        .split(/[/\\]/)
        .filter(Boolean)
        .pop()
        ?.replace(/^./, (c) => c.toUpperCase()) || 'Skills';
    const suffix = i === sources.length - 1 ? ' (higher priority)' : '';
    lines.push(`**${name} Skills**: \`${sourcePath}\`${suffix}`);
  }
  return lines.join('\n');
}

function formatSkillAnnotations(skill: SkillListing): string {
  const parts: string[] = [];
  if (skill.license) parts.push(`License: ${skill.license}`);
  if (skill.compatibility) parts.push(`Compatibility: ${skill.compatibility}`);
  return parts.join(', ');
}

function formatSkillsList(skills: readonly SkillListing[], sources: readonly string[]): string {
  if (skills.length === 0) {
    return `(No skills available yet. You can create skills in ${sources.map((s) => `\`${s}\``).join(' or ')})`;
  }
  const lines: string[] = [];
  for (const skill of skills) {
    const annotations = formatSkillAnnotations(skill);
    let descLine = `- **${skill.name}**: ${skill.description}`;
    if (annotations) descLine += ` (${annotations})`;
    lines.push(descLine);
    if (skill.allowedTools && skill.allowedTools.length > 0) {
      lines.push(`  → Allowed tools: ${skill.allowedTools.join(', ')}`);
    }
    lines.push(`  → Read \`${skill.path}\` for full instructions`);
    if (skill.module !== undefined) {
      lines.push(`  → Import: \`await import("@/skills/${skill.name}")\``);
    }
  }
  return lines.join('\n');
}

/**
 * skills 那一段：來源目錄與技能清單。
 *
 * @param skills - 清單上的技能，照掃描的先後。
 * @param sources - 來源目錄，照登記的先後。
 */
export function renderSkillsSection(
  skills: readonly SkillListing[],
  sources: readonly string[],
): string {
  return SKILLS_SYSTEM_PROMPT.replace('{skills_locations}', formatSkillsLocations(sources)).replace(
    '{skills_list}',
    formatSkillsList(skills, sources),
  );
}

/**
 * 記憶那一段：各來源的內容照登記的先後，加上叫模型自己維護記憶的指引。
 *
 * @param contents - 來源路徑 → 內容。讀不到、空檔都不在裡面。
 * @param sources - 來源路徑，照登記的先後。
 */
export function renderMemorySection(
  contents: Readonly<Record<string, string>>,
  sources: readonly string[],
): string {
  let formatted = '(No memory loaded)';
  if (Object.keys(contents).length > 0) {
    const sections: string[] = [];
    for (const path of sources) if (contents[path]) sections.push(`${path}\n${contents[path]}`);
    if (sections.length > 0) formatted = sections.join('\n\n');
  }
  return MEMORY_SYSTEM_PROMPT.replace('{memory_contents}', formatted);
}
