// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { catalogToolNames } from '@/test/tool-catalog';

import {
  INPUT_MAX_CHARS,
  SUMMARY_MAX_CHARS,
  classifyTool,
  firstLine,
  isKnownTool,
  toolInputBody,
  toolSummary,
  toolTitle,
} from '@/lib/tool-view';

/**
 * `classifyTool` 涵蓋 nexus 每一個實際工具名（#406 驗收）。工具名**從 `docs/tool-catalog.md` 讀**（模型實際收到的那一份，
 * 含基座與 plugin；由 harness 產生、CI 驗新鮮度，#442／#666）：新增一個出廠的工具而沒在 `lib/tool-view.ts` 分類，這裡紅。
 *
 * 目錄涵蓋 CLI 與 serve 兩條出廠組裝（含 serve 出廠的背景續行子代理四顆，以及選配的 `list_subagent_models`，#1133），
 * 只有 `execute` 不在裡面，所以手列：今天產品路徑上沒有 shell，基座不綁它；web 先分類好，絆索在 harness 的
 * `execute-not-bound.test.ts`。
 */

const catalogNames = catalogToolNames();

const NOT_IN_CATALOG_TOOL_NAMES = ['execute'];

describe('classifyTool', () => {
  it('讀得到目錄裡的工具名（量具本身沒壞）', () => {
    expect(catalogNames).toEqual(
      expect.arrayContaining([
        'ls',
        'task',
        'echo',
        'ask_user_question',
        'run_javascript',
        'request_sandbox_escalation',
        'subagent',
        'list_subagent_models',
      ]),
    );
    expect(new Set(catalogNames).size).toBe(catalogNames.length);
  });

  it.each([...catalogNames, ...NOT_IN_CATALOG_TOOL_NAMES])('%s 在表上有明寫', (name) => {
    expect(isKnownTool(name)).toBe(true);
    expect(toolTitle(name)).not.toBe('工具');
  });

  it.each([
    ['ls', 'read'],
    ['read_file', 'read'],
    ['glob', 'search'],
    ['grep', 'search'],
    ['write_file', 'write'],
    ['edit_file', 'edit'],
    ['execute', 'bash'],
    ['run_javascript', 'code'],
    ['delete', 'others'],
    ['task', 'others'],
    ['subagent', 'others'],
    ['list_agents', 'others'],
    ['interrupt_agent', 'others'],
    ['send_message', 'others'],
    ['list_subagent_models', 'others'],
    ['todo_write', 'others'],
  ] as const)('%s → %s', (name, variant) => {
    expect(classifyTool(name)).toBe(variant);
  });

  it('`subagent` 跟 `task` 同標題（都是委派子代理）', () => {
    expect(toolTitle('subagent')).toBe('委派子代理');
    expect(toolTitle('subagent')).toBe(toolTitle('task'));
  });

  it.each([
    ['list_agents', '列出子代理'],
    ['interrupt_agent', '停止子代理'],
    ['send_message', '傳訊給子代理'],
    ['list_subagent_models', '列出可選的子代理模型'],
  ])('背景子代理的管理工具 %s 有自己的標題', (name, title) => {
    expect(isKnownTool(name)).toBe(true);
    expect(toolTitle(name)).toBe(title);
  });

  it('不認得的工具（例如 MCP 的）走通用卡', () => {
    expect(classifyTool('mcp__github__create_issue')).toBe('others');
    expect(isKnownTool('mcp__github__create_issue')).toBe(false);
    expect(toolTitle('mcp__github__create_issue')).toBe('工具');
  });
});

describe('摘要與展開內容', () => {
  it('摘要照類別挑欄位，只取第一行', () => {
    expect(toolSummary('read_file', '{"file_path":"src/App.tsx","limit":20}')).toBe('src/App.tsx');
    expect(toolSummary('execute', '{"command":"pnpm test\\npnpm build"}')).toBe('pnpm test');
    expect(toolSummary('grep', '{"pattern":"TODO","path":"src"}')).toBe('TODO');
    expect(toolSummary('mcp__x__y', '{"n":1,"q":"找這個"}')).toBe('找這個');
  });

  it('刪檔有自己的標題，摘要是那個路徑（#672）', () => {
    expect(toolTitle('delete')).toBe('刪除檔案');
    expect(toolSummary('delete', '{"file_path":"/a.md"}')).toBe('/a.md');
  });

  it('壞 JSON 退回原字串', () => {
    expect(toolSummary('read_file', '{"file_path":"src/Ap')).toBe('{"file_path":"src/Ap');
    expect(toolInputBody('read_file', '{"file_path":"src/Ap')).toEqual({
      text: '{"file_path":"src/Ap',
      lang: 'text',
    });
  });

  it('執行程式展開是那段程式、執行指令是那行指令，其他是排好的 JSON', () => {
    expect(toolInputBody('run_javascript', '{"code":"1 + 1"}')).toEqual({
      text: '1 + 1',
      lang: 'js',
    });
    expect(toolInputBody('execute', '{"command":"ls -la"}')).toEqual({
      text: 'ls -la',
      lang: 'bash',
    });
    expect(toolInputBody('echo', '{"message":"嗨"}')).toEqual({
      text: '{\n  "message": "嗨"\n}',
      lang: 'json',
    });
    expect(toolInputBody('echo', '')).toBeUndefined();
  });
});

/** #958：收合那一行摘要有字元上限，展開後參數的上限常數另有人用。 */
describe('摘要的字元上限', () => {
  it('第一行沒超過（含剛好）上限時原樣', () => {
    const line = 'x'.repeat(SUMMARY_MAX_CHARS);
    expect(firstLine(`${line}\n第二行`)).toBe(line);
    expect(toolSummary('echo', JSON.stringify({ message: line }))).toBe(line);
  });

  it('超過就截在上限、尾巴換成「…」；只看第一行，換行以後的不算', () => {
    const line = 'x'.repeat(SUMMARY_MAX_CHARS + 1);
    expect(firstLine(line)).toBe(`${'x'.repeat(SUMMARY_MAX_CHARS)}…`);
    expect(firstLine(`短\n${line}`)).toBe('短');
    expect(toolSummary('echo', JSON.stringify({ message: 'y'.repeat(527_000) }))).toBe(
      `${'y'.repeat(SUMMARY_MAX_CHARS)}…`,
    );
  });

  it('參數不是 JSON 時（原文的第一行）也受上限管', () => {
    expect(toolSummary('echo', 'z'.repeat(10_000))).toBe(`${'z'.repeat(SUMMARY_MAX_CHARS)}…`);
  });

  it('不把代理對剖開', () => {
    const summary = firstLine(`${'a'.repeat(SUMMARY_MAX_CHARS - 1)}😀😀`);
    expect(summary).toBe(`${'a'.repeat(SUMMARY_MAX_CHARS - 1)}…`);
  });

  it('展開後參數的上限是個正整數', () => {
    expect(Number.isInteger(INPUT_MAX_CHARS) && INPUT_MAX_CHARS > 0).toBe(true);
    // 摘要那一行永遠比展開的上限短，兩者不會顛倒。
    expect(SUMMARY_MAX_CHARS).toBeLessThan(INPUT_MAX_CHARS);
  });
});
