/**
 * **`Error: ` 前綴只有一個主人**——[#318](https://github.com/DemianLi/nexus-agent/issues/318) 的絆索。
 *
 * 模型分辨一次呼叫成沒成功，在我們唯一的 live 供應商（Chat Completions）上只看得到文字：轉換器不送
 * `status`（`@langchain/openai@1.5.10` `converters/completions.js:475-479`）。所以「這次沒生效」的
 * 文字要照 dsh 的 `toolErrorResult` 帶 `Error: `，而加它的只有 `@nexus/core` 的 `toolRefusal`。
 * 作者自己寫好的回饋（dsh 的第二條政策）走 `toolFeedback`，原樣。
 *
 * 單一出口的文字各在自己的測試；這一份擋的是**下一個新出口**：它若自己 `new ToolMessage({ status:
 * 'error' })`，前綴就不會有；它若自己拼 `'Error: '`，遲早有一句帶兩次。兩件都從原始碼上數。
 *
 * **只掃 `src/`、測試明著排除、註解行不算**，理由同 `session-resume-doors.test.ts` 的門 B：
 * 量的是產品程式碼，不是測試怎麼寫、也不是散文怎麼寫。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** 掃哪些原始碼。 */
const SOURCE_ROOTS = ['apps/harness/src', 'apps/web/src', 'packages'] as const;

/** 遞迴列出 `.ts`／`.tsx`，跳過測試、fixture 與建置產物。 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/u.test(entry.name)) continue;
    if (/\.test\.tsx?$/u.test(entry.name) || entry.name.endsWith('.fixture.ts')) continue;
    out.push(full);
  }
  return out;
}

/** 全樹原始碼裡、不是註解的那幾行中，命中 `pattern` 的每一處，`路徑: 那一行`。 */
function codeLinesMatching(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const root of SOURCE_ROOTS) {
    for (const file of sourceFiles(join(REPO_ROOT, root))) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const code = line.trim();
        if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) continue;
        if (pattern.test(code)) found.push(`${relative(REPO_ROOT, file)}: ${code}`);
      }
    }
  }
  return found.sort();
}

describe('Error: 前綴只有一個主人', () => {
  /**
   * 手寫 `status: 'error'` 的只剩三處：錯誤結果唯一的建構點（`tool-error-codes.ts` 的 `errorResultFields`，`toolRefusal`／`toolFeedback`
   * 與推導端補的那兩句共用），
   * `fs-tool-errors.ts` 包基座文字的那一則（文字不是我們寫的，可能是文字塊陣列），與 native loop 找不到工具時那一則
   * （`native-loop/invalid-tool.ts`）：逐字照 langchain `ToolNode` 的 `getInvalidToolError`，兩個 loop 才回同一句。
   *
   * 2026-09-14 在改之前的 develop（`473d12a`）上數到 10 處、10 個檔：圍堵、核准、先讀後改、輸出 schema、
   * fs-tool-errors、ask-user、submit_record、sandbox-escalation、pump 的 `#withdraw`，與 `tool-events.ts`
   * 自己。其中 8 處是 #318 補前綴的出口，全部改走 `toolRefusal`。
   */
  it('手寫 error 狀態的只有錯誤結果的建構點、fs-tool-errors 與 native 照抄 langchain 的那一則', () => {
    expect(codeLinesMatching(/status:\s*['"]error['"]/u)).toEqual([
      "packages/nexus-core/src/fs-tool-errors.ts: status: 'error',",
      "packages/nexus-core/src/native-loop/invalid-tool.ts: status: 'error',",
      "packages/nexus-core/src/tool-error-codes.ts: return { content, tool_call_id: options.callId, name: options.name, status: 'error' as const };",
    ]);
  });

  /**
   * 自己拼 `'Error: '` 的只剩前綴的定義本身，與 native loop 照抄 langchain 的那一句（見上一條）。todo、goal 的前綴常數，中止的兩句與
   * 壞參數那一句都不能自己帶前綴：`toolRefusal` 已經加了，再帶就是 `Error: Error: `。
   *
   * 期望值裡那一行是原始碼逐字，所以**前綴的值也被這條釘住**：改成別的字，這裡當場紅。
   */
  it('字串裡寫 Error: 的只有前綴的定義與 native 照抄 langchain 的那一句', () => {
    expect(codeLinesMatching(/['"`]Error: /u)).toEqual([
      "packages/nexus-core/src/native-loop/invalid-tool.ts: content: `Error: ${call.name} is not a valid tool, try one of [${available.join(', ')}].`,",
      "packages/nexus-core/src/tool-events.ts: export const TOOL_ERROR_PREFIX = 'Error: ';",
    ]);
  });

  /**
   * 不帶前綴的那條路（dsh 的第二條政策）只有一個生產者：推模型歷史時補的那兩句（`conversation-replay.ts` 的 `closer`），
   * 逐字抄 dsh `repair.ts`，直接拿建構點的欄位；請求端的 `toolFeedback` 留給作者自己寫好的回饋，今天沒有呼叫者。
   * **多一個呼叫者是一個決定，不是預設**——拒絕走這條，前綴就悄悄不見了，而上面兩條都數不到。
   * 其餘幾行是定義與 `errorResult`（`toolRefusal`／`toolFeedback` 共用）那一處。
   */
  it('不帶前綴的那條路只有推模型歷史在走', () => {
    expect(codeLinesMatching(/\b(?:toolFeedback|errorResultFields)\(/u)).toEqual([
      'packages/nexus-core/src/conversation-replay.ts: ...errorResultFields(started ? TOOL_OUTCOME_UNKNOWN_TEXT : TOOL_NOT_STARTED_TEXT, {',
      'packages/nexus-core/src/tool-error-codes.ts: export function errorResultFields(',
      'packages/nexus-core/src/tool-events.ts: const message = new ToolMessage(errorResultFields(content, options));',
      'packages/nexus-core/src/tool-events.ts: export function toolFeedback(content: string, options: ErrorResultOptions): ToolMessage {',
    ]);
  });
});
