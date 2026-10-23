# 工具 schema 目錄

模型實際收到的每個工具的名稱、描述與參數 schema（共 24 個）。**這份檔案由程式產生，不要手改**：

```bash
pnpm --filter @nexus/harness run gen-tool-catalog
```

`apps/harness/src/tool-catalog.test.ts` 在 CI 裡驗它沒有過期；改了工具的名稱、描述或參數，重新產生並一起提交，
review 時就看得到模型看到的字變了什麼。範圍與做法見 `apps/harness/src/tool-catalog.ts` 的檔頭（#442）。

## 基座（deepagents）

零 plugin 組裝時基座與組裝點綁給模型的工具。

### `delete`

描述：

```text
Deletes a file or directory from the filesystem.

Usage:
- Permanently removes the file or directory at the given absolute path.
- Deleting a directory removes it and everything inside it, recursively. Prefer
  deleting a directory in one call over deleting each file individually.
- This cannot be undone, so only delete paths you are sure are no longer needed.
```

參數：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "file_path": {
      "type": "string",
      "description": "Absolute path to the file to delete. Must be absolute, not relative."
    }
  },
  "required": [
    "file_path"
  ],
  "additionalProperties": false
}
```

### `edit_file`

描述：

```text
Performs exact string replacements in files.

Usage:
- You must read the file before editing; this tool errors otherwise.
- Preserve the exact indentation from the read output, and never include line-number prefixes in old_string or new_string.
- Prefer editing an existing file over creating a new one.
- Only use emojis if the user explicitly requests it.
```

參數：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "file_path": {
      "type": "string",
      "description": "Absolute path to the file to edit"
    },
    "old_string": {
      "type": "string",
      "description": "String to be replaced (must match exactly)"
    },
    "new_string": {
      "type": "string",
      "description": "String to replace with"
    },
    "replace_all": {
      "default": false,
      "description": "Whether to replace all occurrences",
      "type": "boolean"
    }
  },
  "required": [
    "file_path",
    "old_string",
    "new_string",
    "replace_all"
  ],
  "additionalProperties": false
}
```

### `glob`

描述：

```text
Find files matching a glob pattern, returning absolute paths.

Supports `*` (any characters), `**` (any directories), `?` (single character), e.g. `**/*.py`, `*.txt`, `/subdir/**/*.md`.
```

參數：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string",
      "description": "Glob pattern to match files (e.g., '**/*.py', '*.txt', '/subdir/**/*.md')"
    },
    "path": {
      "description": "Base directory to search from. Defaults to the backend's default root.",
      "type": "string"
    }
  },
  "required": [
    "pattern"
  ],
  "additionalProperties": false
}
```

### `grep`

描述：

```text
Search for a LITERAL text pattern across files (NOT regex).

The pattern is matched verbatim: regex metacharacters are ordinary characters, not operators. To match any of several strings, run a separate grep for each; `grep(pattern="foo|bar")` searches for the literal text "foo|bar", and `.*` or `\\.` match those characters literally.

Returns matching files or content per `output_mode`. Offloaded large tool results live under the artifacts root (`/large_tool_results/` by default); grep that directory to search them when you do not know the exact path.
```

參數：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string",
      "description": "Literal text pattern to search for (not regex)"
    },
    "path": {
      "default": "/",
      "description": "Base path to search from (default: /)",
      "type": "string"
    },
    "glob": {
      "default": null,
      "description": "Optional glob pattern to filter files (e.g., '*.py')",
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    },
    "max_count": {
      "default": null,
      "description": "Optional cap on the total number of matches returned across all files. Leave unset to use the configured default. When the cap is hit, results are truncated and a note says so; narrow the pattern or path to see the rest.",
      "anyOf": [
        {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "output_mode": {
      "default": "content",
      "description": "Output format: 'files_with_matches' lists matching file paths, 'content' shows matching lines (default), 'count' shows match counts per file",
      "type": "string",
      "enum": [
        "files_with_matches",
        "content",
        "count"
      ]
    }
  },
  "required": [
    "pattern",
    "path",
    "glob",
    "max_count",
    "output_mode"
  ],
  "additionalProperties": false
}
```

### `ls`

描述：

```text
Lists all files in a directory.

This is useful for exploring the filesystem and finding the right file to read or edit.
You should almost ALWAYS use this tool before using the read_file or edit_file tools.
```

參數：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "path": {
      "default": "/",
      "description": "Directory path to list (default: /)",
      "type": "string"
    }
  },
  "required": [
    "path"
  ],
  "additionalProperties": false
}
```

### `read_file`

描述：

```text
Reads a file from the filesystem. Assume any path the user provides is valid; reading a missing file returns an error.

Usage:
- By default, it reads up to 2000 lines starting from the beginning of the file. Use `offset`/`limit` to page through large files instead of reading them whole.
- Results are returned with line numbers starting at `offset` + 1 (1 by default), then two spaces, then the source line. Never include these line-number prefixes when editing.
- Lines over 5,000 characters are split with continuation markers (e.g. 5.1, 5.2); `limit` counts source lines, so continuation rows do not consume the budget.
- Speculatively batch multiple `read_file` calls in one response when several files may be useful.
- An empty file returns a system-reminder warning in place of contents.
- Large tool results may be offloaded to a file; the tool message gives the path. Read that path here, paging with `offset`/`limit`.
- Images (`.png`, `.jpg`, etc.), audio, video, and PDFs return multimodal content blocks (https://docs.langchain.com/javascript/langchain/messages#multimodal).
- For images and PDFs, pagination via `offset`/`limit` is text-only - supply `file_path` only.
- Always read a file before editing it.
```

參數：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "file_path": {
      "type": "string",
      "description": "Absolute path to the file to read"
    },
    "offset": {
      "default": 0,
      "description": "Line offset to start reading from (0-indexed)",
      "type": "number"
    },
    "limit": {
      "type": "number",
      "description": "Maximum number of lines to return. Defaults to 2000."
    }
  },
  "required": [
    "file_path",
    "offset"
  ],
  "additionalProperties": false
}
```

### `task`

描述：

```text
Launch an ephemeral subagent to handle a complex, multi-step task in an isolated context window.

Available agent types and the tools they have access to:
- general-purpose: General-purpose agent for researching complex questions, searching for files and content, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you. This agent has access to all tools as the main agent.

Specify subagent_type to select the agent. Usage notes:
- Launch multiple agents concurrently when their tasks are independent, using a single message with multiple tool calls.
- Each invocation is stateless: the agent sees only the prompt you give it and returns a single final report. Put full detail in the prompt and state exactly what it should return.
- The agent's report is not shown to the user; relay a summary yourself.
- Tell the agent whether to create content, analyze, or only research, since it cannot see the user's intent.
- If an agent's description says to use it proactively, do so without waiting to be asked.
- When only general-purpose is available, use it for any complex, context-heavy task; it has the same capabilities as the main agent.
```

參數：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "description": {
      "type": "string",
      "description": "The task to execute with the selected agent"
    },
    "subagent_type": {
      "type": "string",
      "description": "Name of the agent to use. Available: general-purpose"
    }
  },
  "required": [
    "description",
    "subagent_type"
  ],
  "additionalProperties": false
}
```

### `write_file`

描述：

```text
Writes content to a file. Creates the file if it does not exist; replaces it entirely if it does.

Usage:
- Use this tool when you intend to create a new file or replace the whole file. You do not need to read the file first.
- Prefer to edit existing files (with the edit_file tool) over creating new ones when possible.
```

參數：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "file_path": {
      "type": "string",
      "description": "Absolute path where the file should be written. Must be absolute, not relative."
    },
    "content": {
      "type": "string",
      "description": "The text content to write to the file. This parameter is required."
    }
  },
  "required": [
    "file_path",
    "content"
  ],
  "additionalProperties": false
}
```

## 組裝點（harness）

出廠組裝多綁的、不經 plugin 註冊點的工具。

### `request_sandbox_escalation`

描述：

```text
檔案變更被圍堵擋下來、而這件事真的需要更寬的權限時，用這個工具請人核准一次升級。**只在剛被擋下之後用**，file_path 填被擋的那個檔；核准之後把那一次操作原樣重試一次。一次核准只蓋被擋下的那一次操作：同一個檔、同樣的內容、只蓋一次；改了內容就要重新升級。被拒絕時不要換個路徑再寫，去問人為什麼。
```

參數：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "file_path": {
      "type": "string",
      "description": "剛才被擋下的那個檔，照被擋的那次呼叫的寫法填。"
    },
    "sandbox_permissions": {
      "type": "string",
      "enum": [
        "workspace-write",
        "danger-full-access"
      ],
      "description": "要升到哪一格。選夠用的最窄那一格。"
    },
    "justification": {
      "type": "string",
      "description": "一句話，給按核准的人看：為什麼這一次操作需要更寬的權限。"
    }
  },
  "required": [
    "file_path",
    "sandbox_permissions",
    "justification"
  ],
  "additionalProperties": false
}
```

## 組裝點（harness）· 背景續行子代理（serve 出廠）

`serve` 出廠就是背景續行（`cordis.yml` 的 `background-subagents` 是 `continuable`）：模型看到的委派工具是 `subagent`，沒有基座的 `task`；CLI 不給這一組，委派用 `task`（列在基座那一節）。

### `interrupt_agent`

描述：

```text
Ask a subagent to stop its current work. This call returns without waiting for it to stop. You can continue a direct child's conversation later with send_message. Subagents it started will keep running.
```

參數：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "agent_id": {
      "type": "string",
      "description": "The id of an agent created under you: your direct child or a deeper descendant."
    }
  },
  "required": [
    "agent_id"
  ],
  "additionalProperties": false
}
```

### `list_agents`

描述：

```text
List subagents you started, with their ids, labels, and status. running means it is working; inactive means it is not currently working. You will be notified when a subagent finishes; there is no need to keep checking its status. Use send_message to continue the conversation.
```

參數：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

### `send_message`

描述：

```text
Send a message to an agent. A working agent receives it at its next step; an idle agent starts a new turn with it. Returns delivery confirmation, not the agent's answer.
```

參數：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "agent_id": {
      "type": "string",
      "description": "The id of one of your background subagents (from subagent or list_agents), or your direct parent when you are a resident continuable child."
    },
    "message": {
      "type": "string",
      "description": "The message to deliver to the agent."
    }
  },
  "required": [
    "agent_id",
    "message"
  ],
  "additionalProperties": false
}
```

### `subagent`

描述：

```text
Launch a subagent to handle a complex, multi-step task in an isolated context window.

Available agent types and the tools they have access to:
- general-purpose: General-purpose agent for researching complex questions, searching for files and content, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you. This agent has access to all tools as the main agent.

Specify subagent_type to select the agent. Usage notes:
- Launch multiple agents concurrently when their tasks are independent, using a single message with multiple tool calls.
- Each new delegation starts fresh: the agent sees only the prompt you give it, and reports its final result when it finishes. Put full detail in the prompt and state exactly what it should return.
- The agent's report is not shown to the user; relay a summary yourself.
- Tell the agent whether to create content, analyze, or only research, since it cannot see the user's intent.
- If an agent's description says to use it proactively, do so without waiting to be asked.
- When only general-purpose is available, use it for any complex, context-heavy task; it has the same capabilities as the main agent.

`run_in_background` 預設 true：子代理在背景跑，這次呼叫當場回它的編號，你可以接著做別的事。要等它的結果才能往下時傳 `false`，這次呼叫會等它跑完並回結果。
```

參數：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "description": {
      "type": "string",
      "description": "交給子代理的任務，寫清楚它需要的背景與期待的產出。"
    },
    "subagent_type": {
      "type": "string",
      "description": "要用哪一種子代理（見上面的清單）。"
    },
    "run_in_background": {
      "description": "預設 true：當場回子代理編號，你接著做別的事。要等結果才能往下時傳 false。",
      "type": "boolean"
    }
  },
  "required": [
    "description",
    "subagent_type"
  ],
  "additionalProperties": false
}
```

#### 選配打開之後的版本（出廠關著）

描述：

```text
Launch a subagent to handle a complex, multi-step task in an isolated context window.

Available agent types and the tools they have access to:
- general-purpose: General-purpose agent for researching complex questions, searching for files and content, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you. This agent has access to all tools as the main agent.

Specify subagent_type to select the agent. Usage notes:
- Launch multiple agents concurrently when their tasks are independent, using a single message with multiple tool calls.
- Each new delegation starts fresh: the agent sees only the prompt you give it, and reports its final result when it finishes. Put full detail in the prompt and state exactly what it should return.
- The agent's report is not shown to the user; relay a summary yourself.
- Tell the agent whether to create content, analyze, or only research, since it cannot see the user's intent.
- If an agent's description says to use it proactively, do so without waiting to be asked.
- When only general-purpose is available, use it for any complex, context-heavy task; it has the same capabilities as the main agent.

`run_in_background` 預設 true：子代理在背景跑，這次呼叫當場回它的編號，你可以接著做別的事。要等它的結果才能往下時傳 `false`，這次呼叫會等它跑完並回結果。

選模型是選填的：省略 `model` 與 `reasoning_effort` 就沿用你現在的模型。要指定時，先用 `list_subagent_models` 看可選的模型與它的推理等級；換了模型卻沒給推理等級，就用新模型的預設。選模型只在背景委派（`run_in_background` 為 true）時可用。
```

參數：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "description": {
      "type": "string",
      "description": "交給子代理的任務，寫清楚它需要的背景與期待的產出。"
    },
    "subagent_type": {
      "type": "string",
      "description": "要用哪一種子代理（見上面的清單）。"
    },
    "run_in_background": {
      "description": "預設 true：當場回子代理編號，你接著做別的事。要等結果才能往下時傳 false。",
      "type": "boolean"
    },
    "model": {
      "description": "子代理用哪一顆模型（型錄 id）。省略＝沿用你現在用的這顆。先用 list_subagent_models 看可選的。",
      "type": "string"
    },
    "reasoning_effort": {
      "description": "子代理在這顆模型上的推理等級。省略＝這顆模型的預設；換了模型卻沒給，也用新模型的預設。",
      "type": "string"
    }
  },
  "required": [
    "description",
    "subagent_type"
  ],
  "additionalProperties": false
}
```

## 組裝點（harness）· 選配（出廠關著）

出廠關著，設定打開才有（`subagent-model-selection` 的授權清單，#877）：新增這一個工具；同時 `subagent` 會多出選模型的兩格，那個版本接在 `subagent` 底下。

### `list_subagent_models`

描述：

```text
List the models a subagent may use, without changing your own. Call with no arguments to list the authorized models, or with `model` to see the reasoning efforts of that exact model. Use the returned ids with the `model` and `reasoning_effort` fields of the subagent tool.
```

參數：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "model": {
      "description": "Exact model id to inspect. Omit to list the authorized models.",
      "type": "string"
    }
  },
  "additionalProperties": false
}
```

## ask-user

plugin，套件 packages/nexus-plugin-ask-user

### `ask_user_question`

描述：

```text
需要確認、需要人在幾個選項裡挑一個，或者缺了你補不出來的資料時，用這個工具問人，不要自己猜。一次可以送多題，每一題給一個穩定的 id，答案會照那個 id 回來。有明確選項的時候把選項列出來；沒有選項時人可以自由作答。
```

參數：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "questions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "description": "這一題的穩定 id，答案會照它回來。"
          },
          "question": {
            "type": "string",
            "description": "要問的那句話，具體一點。"
          },
          "header": {
            "description": "可選的短標題，例如「確認」或「選模式」。",
            "type": "string"
          },
          "options": {
            "description": "可選的選項清單。你有推薦的就放第一個，並在標籤後面加上「（推薦）」。",
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "label": {
                  "type": "string",
                  "description": "選項的短標籤，直接顯示給人看。"
                },
                "description": {
                  "description": "一句話說明這個選項的取捨或後果。",
                  "type": "string"
                }
              },
              "required": [
                "label"
              ],
              "additionalProperties": false
            }
          },
          "multi_select": {
            "description": "人可不可以複選。預設單選。",
            "type": "boolean"
          }
        },
        "required": [
          "id",
          "question"
        ],
        "additionalProperties": false
      },
      "description": "繼續之前要問人的那幾題。"
    }
  },
  "required": [
    "questions"
  ],
  "additionalProperties": false
}
```

## echo

plugin，套件 packages/nexus-plugin-echo

### `echo`

描述：

```text
把收到的訊息原樣回聲，用來確認工具接線是通的。
```

參數：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "message": {
      "type": "string",
      "description": "要回聲的訊息"
    }
  },
  "required": [
    "message"
  ],
  "additionalProperties": false
}
```

## goal

plugin，套件 packages/nexus-plugin-goal

### `create_goal`

描述：

```text
Create the one long-running completion objective for this session, when the current direct human request is such an objective. You may infer that intent from the request in any language; the user does not have to say "create a goal". Do not create a goal for routine single-turn work. Requires a direct human turn on the top-level agent.
```

參數：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "objective": {
      "type": "string",
      "description": "The concrete completion objective inferred from the human request."
    },
    "max_goal_rounds": {
      "description": "Optional positive safe-integer limit on automatic continuation rounds.",
      "type": "number"
    }
  },
  "required": [
    "objective"
  ],
  "additionalProperties": false
}
```

### `get_goal`

描述：

```text
Read the current session goal: its exact id and revision, objective, phase, round cap, rounds started so far, and blocker reason when present. Returns {"goal":null} when there is none. Call this before update_goal and copy its exact goal_id and revision. After session resume, an active goal is disarmed: when a human asks to continue or resume in any wording or language, use update_goal action resume to rearm it. When automatic continuation is enabled, an active goal is given further rounds in this same session until it is completed, blocked, or reaches maxGoalRounds.
```

參數：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

### `update_goal`

描述：

```text
Update the exact current goal revision. Call get_goal first and copy its goal_id and revision. Mark complete only when the objective is actually achieved. Mark blocked only for a concrete blocking condition you report in blocked_reason; difficulty, uncertainty, or useful remaining work is not blocked. Inside a continuation round, mark blocked only after the same blocking condition has persisted for at least 3 consecutive rounds. Actions complete and blocked accept either a direct human turn or the current continuation round; edit, pause, and resume always require a direct human turn on the top-level agent.
```

參數：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "goal_id": {
      "type": "string",
      "description": "Exact id returned by get_goal."
    },
    "revision": {
      "type": "number",
      "description": "Exact positive revision returned by get_goal."
    },
    "action": {
      "type": "string",
      "enum": [
        "edit",
        "pause",
        "resume",
        "complete",
        "blocked"
      ],
      "description": "edit | pause | resume | complete | blocked"
    },
    "objective": {
      "description": "Replacement objective; valid only with action edit.",
      "type": "string"
    },
    "max_goal_rounds": {
      "description": "Replacement round cap; valid only with action edit. Raise it to give a goal that ran out of rounds more; see get_goal for roundsStarted.",
      "type": "number"
    },
    "blocked_reason": {
      "description": "Concrete blocking condition; required only with action blocked.",
      "type": "string"
    }
  },
  "required": [
    "goal_id",
    "revision",
    "action"
  ],
  "additionalProperties": false
}
```

## plan-mode

plugin，套件 packages/nexus-plugin-plan-mode

### `exit_plan_mode`

描述：

```text
只在計劃模式下使用。提交計劃供人評審，獲准後離開計劃模式。送完整的 Markdown 計劃，以一個為計劃命名的 # 標題開頭。對方可以批准（從你的下一步起執行），也可以要求你繼續規劃——那時反饋會從這個工具的結果回來，改完再提交一次。
```

參數：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "plan": {
      "type": "string",
      "description": "完整的計劃，Markdown，以一個為計劃命名的 # 標題開頭。"
    }
  },
  "required": [
    "plan"
  ],
  "additionalProperties": false
}
```

## present

plugin，套件 packages/nexus-plugin-present

### `present`

描述：

```text
Declare existing files as final deliverables for the user. Use it when the user needs a separate file, especially Office documents, spreadsheets, and slide decks; prefer your final response when that suffices. The user opens the current files; their contents are not copied.
```

參數：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "files": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Path of an existing regular file. Relative paths use the Session working directory."
          },
          "description": {
            "description": "Brief description for the user.",
            "type": "string"
          }
        },
        "required": [
          "path"
        ],
        "additionalProperties": false
      },
      "description": "Usually the 1-2 most important deliverables; at most 4 per call."
    }
  },
  "required": [
    "files"
  ],
  "additionalProperties": false
}
```

## quickjs

plugin，套件 packages/nexus-plugin-quickjs

### `run_javascript`

描述：

```text
在一個隔離的 QuickJS 直譯器裡求值一段 JavaScript，回傳最後一個運算式的值。VM 裡沒有檔案系統、沒有網路、沒有 require / import / process，只有標準的 ECMAScript。執行超過 1000 毫秒會被中斷。
```

參數：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "code": {
      "type": "string",
      "description": "要求值的 JavaScript。最後一個運算式的值就是回傳值。"
    }
  },
  "required": [
    "code"
  ],
  "additionalProperties": false
}
```

## submit-record

plugin，套件 packages/nexus-plugin-submit-record

### `submit_record`

描述：

```text
把湊齊的欄位寫成目標檔案的一列。**欄位缺了就先用 ask_user_question 問人，不要自己編、不要留空送出。**送出一定要經過人核准，所以你會停一下；被拒絕時不要換個路徑再送一次，去問人為什麼。欄名要跟檔案表頭一致；檔案不存在時會用你這次給的鍵當表頭建起來。
```

參數：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "file_path": {
      "type": "string",
      "description": "目標檔案的絕對路徑，例如 \"/visitors.csv\"。不存在就會被建出來。"
    },
    "record": {
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {
        "type": "string"
      },
      "description": "這一列的欄位，鍵是欄名、值是欄位內容。值一律是字串。"
    }
  },
  "required": [
    "file_path",
    "record"
  ],
  "additionalProperties": false
}
```

## todo

plugin，套件 packages/nexus-plugin-todo

### `todo_write`

描述：

```text
Record and update a structured task list for the current work. Send the ENTIRE list every call — it REPLACES the previous list (there are no partial updates, no per-item edits). Use it to plan multi-step work and show progress: add one todo per concrete step before you start. Mark every todo being actively worked on `in_progress` — several at once when work genuinely runs in parallel (e.g. concurrent subagents or background commands), one for sequential work; while work remains, at least one task should be `in_progress`. Mark a todo `completed` the moment it is done (do not batch completions), and allow no `in_progress` item only once all work is complete. Skip the list for trivial single-step tasks. Statuses: `pending` (not started), `in_progress` (being worked on now), `completed` (finished).
```

參數：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "todos": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "content": {
            "type": "string",
            "description": "What the task is — a short imperative line."
          },
          "status": {
            "type": "string",
            "enum": [
              "pending",
              "in_progress",
              "completed"
            ],
            "description": "pending (not started) | in_progress (now) | completed (done)."
          }
        },
        "required": [
          "content",
          "status"
        ],
        "additionalProperties": false
      },
      "description": "The COMPLETE task list, replacing any previous list."
    }
  },
  "required": [
    "todos"
  ],
  "additionalProperties": false
}
```
