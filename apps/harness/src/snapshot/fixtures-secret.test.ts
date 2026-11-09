/**
 * **已提交的快照夾具不帶金鑰、授權標頭與帳號**（[#1556](https://github.com/DemianLi/nexus-agent/issues/1556) C077）：用錄製寫入前核的同一個
 * {@link SECRET_LIKE} 掃 `scenarios/**` 的每一個檔。錄製那一關只看它自己寫的；這一條守的是之後手改或 refresh 寫回的。
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SCENARIOS_DIR, SECRET_LIKE, listScenarios } from './harness.js';

describe('已提交的快照夾具', () => {
  it('沒有像金鑰、授權標頭或帳號的字串', async () => {
    const files = (await readdir(SCENARIOS_DIR, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
    // 每個場景至少有輸入、錄製紀錄與夾具三個檔：目錄讀錯時 `files` 是空的，整條照樣綠。
    const scenarios = await listScenarios();
    expect(scenarios.length).toBeGreaterThan(0);
    expect(files.length).toBeGreaterThanOrEqual(scenarios.length * 3);
    const hits: string[] = [];
    for (const file of files) {
      for (const [index, line] of (await readFile(file, 'utf8')).split('\n').entries()) {
        const match = SECRET_LIKE.exec(line);
        if (match !== null)
          hits.push(`${file.slice(SCENARIOS_DIR.length)}:${String(index + 1)}：${match[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
