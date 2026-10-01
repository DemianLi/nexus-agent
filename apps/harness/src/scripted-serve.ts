/**
 * **在真的 `runServe` 上起一台、模型換成腳本提供者**，給要在產品路徑上跑一條自訂工具回合的測試
 * （[#670](https://github.com/DemianLi/nexus-agent/issues/670)）。
 *
 * 做法就是 `serve-scripted-provider.test.ts` 示範的那一份 patch：`insert` 一列腳本提供者
 * （`#settings/scripted-model`，腳本當 config）、把 `agent-default-model` 指過去，形狀照 dsh 的 headless e2e
 * （`source-tool.built.e2e.ts:36-42`）。其餘一律是真的——`runServe`、每條 thread 的 `createCliAgent`、
 * 出貨清單、wire handler——唯一換掉的是模型。
 *
 * **零憑證、零外部連線**：腳本是資料，工作區由呼叫端給（暫存目錄）。
 *
 * @module
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ScriptedTurn } from './scripted-model.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

/** 腳本提供者那一列的 id。 */
export const SCRIPTED_PROVIDER_ID = 'test-script';

/**
 * 把腳本寫成 patch 文字：`insert` 提供者那一列、再把選擇列指過去。腳本用 JSON 寫（YAML 的子集），
 * 不必自己處理引號與縮排。
 *
 * @param turns - 腳本。
 * @param extraRows - 同一份 patch 裡接在後面的其餘列（YAML 文字，例如調某一列的 config）。
 * @returns patch 檔的內容。
 */
export function scriptedPatchText(turns: readonly ScriptedTurn[], extraRows = ''): string {
  return `- insert:
    - id: ${SCRIPTED_PROVIDER_ID}
      name: '#settings/scripted-model'
      config: ${JSON.stringify({ turns })}
- id: agent-default-model
  config:
    provider: ${SCRIPTED_PROVIDER_ID}
${extraRows}`;
}

/** 一台換了腳本模型的 serve，和用完要收的東西。 */
export interface ScriptedServe {
  readonly running: RunningServe;
  /** 收掉 server 與 patch 檔所在的暫存目錄。 */
  close(): Promise<void>;
}

/**
 * 起一台 serve，模型是這份腳本。
 *
 * @param turns - 腳本。每條 thread 的 `createCliAgent` 各建一顆新模型，所以腳本**每條 thread 從第一輪開始吃**。
 * @param options - `workspace` 是 `--workspace`（省略即沒有，跑在虛擬檔案系統）；`extraRows` 見 {@link scriptedPatchText}；
 *   `argv` 接在後面的其餘旗標。
 * @returns 跑著的 serve 與收尾函式。
 */
export async function startScriptedServe(
  turns: readonly ScriptedTurn[],
  options: {
    readonly workspace?: string;
    readonly extraRows?: string;
    readonly argv?: readonly string[];
  } = {},
): Promise<ScriptedServe> {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-scripted-serve-'));
  const patch = join(dir, 'scripted.patch.yml');
  await writeFile(patch, scriptedPatchText(turns, options.extraRows), 'utf8');
  const running = (await runServe({
    argv: [
      '--port',
      '0',
      ...(options.workspace === undefined ? [] : ['--workspace', options.workspace]),
      '--patch',
      patch,
      ...(options.argv ?? []),
    ],
    log: () => undefined,
    env: {},
  })) as RunningServe;
  return {
    running,
    close: async () => {
      await running.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
