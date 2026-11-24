/**
 * `thread-list-cli.ts` 造的假日誌（[#742](https://github.com/DemianLi/nexus-agent/issues/742)）。規矩寫在那支腳本的檔頭；
 * 讀方讀不讀得懂這份資料由 `thread-list-data.test.ts` 擋，不然量到的是「全部讀不懂」的時間（#2959）。
 *
 * @module
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { ToolMessage } from '@langchain/core/messages';
import { SESSION_LOG_FORMAT_VERSION, toLoggedMessage } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import { openJsonlSessionStore, sessionPathsIn } from '../jsonl-session-store.js';

/** 一行工具輸出的大小。#812 之後單則工具結果進日誌最多約 56 KB，這裡取 32 KB 上下的長行。 */
const LINE_BYTES = 32 * 1024;

/** 一格：幾份日誌、每份大約多大。 */
export interface Cell {
  readonly count: number;
  readonly fileBytes: number;
}

/** 一份日誌的內容：`turn/start` 與 `session/title` 夾在工具呼叫與長的工具結果之間，總大小約 `fileBytes`。 */
function buildBody(index: number, fileBytes: number): { body: string; id: string } {
  const lines: string[] = [];
  const base = 1_700_000_000_000 + index * 60_000;
  let seq = 0;
  let bytes = 0;
  const push = (type: string, data: unknown, time: number): void => {
    const line = JSON.stringify({ type, seq, time, data });
    lines.push(line);
    bytes += line.length + 1;
    seq += 1;
  };
  push(
    'turn/start',
    { kind: 'message', text: `第 ${index} 份的第一句話 ${randomBytes(4).toString('hex')}` },
    base,
  );
  push('session/title', { title: `會話 ${index}` }, base + 1);
  let t = base + 2;
  let round = 0;
  while (bytes < fileBytes) {
    const room = fileBytes - bytes;
    const size = Math.min(LINE_BYTES, Math.max(64, room - 300));
    // base64 每 3 位元組變 4 字元，先取 3/4 再轉；每行都是新的隨機位元組。
    const payload = randomBytes(Math.ceil((size * 3) / 4))
      .toString('base64')
      .slice(0, size);
    round += 1;
    // 每十行工具輸出夾一則人打的話與一顆 turn/end，其餘是一組工具呼叫與它的結果。
    if (round % 10 === 0) {
      push('turn/end', {}, t);
      t += 1;
      push('turn/start', { kind: 'message', text: `第 ${round} 輪的問題` }, t);
    } else {
      const callId = `call-${round}`;
      push('tool/call', { callId, name: 'read_file', arguments: '{}' }, t);
      push(
        'tool/result',
        {
          callId,
          isError: false,
          message: toLoggedMessage(new ToolMessage({ content: payload, tool_call_id: callId })),
        },
        t,
      );
    }
    t += 1;
  }
  return { body: `${lines.join('\n')}\n`, id: `m742-${String(index).padStart(5, '0')}` };
}

/**
 * 造一格的資料，先清空 `dir`。第 0 份走 `openJsonlSessionStore`，其餘直接寫同格式。
 *
 * @returns 實寫的日誌位元組數（不含 header）。
 */
export async function generate(dir: string, cell: Cell, cwd: string): Promise<number> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const store = openJsonlSessionStore({ directory: dir });
  let total = 0;
  for (let index = 0; index < cell.count; index += 1) {
    const { body, id } = buildBody(index, cell.fileBytes);
    if (index === 0) {
      const session = store.create({
        version: SESSION_LOG_FORMAT_VERSION,
        id,
        createdAt: 1_700_000_000_000,
        cwd,
      });
      const events = body
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as SessionEvent);
      await session.append(events);
      await session.close();
    } else {
      const header = {
        version: SESSION_LOG_FORMAT_VERSION,
        id,
        createdAt: 1_700_000_000_000 + index * 60_000,
        cwd,
      };
      // 寫方的佈局（#1594 ③）：會話目錄裡的世代檔，第一行是 header 行；舊路徑留墓碑，列表要多讀的那一項也量進去。
      const paths = sessionPathsIn(dir, id);
      const headerLine = `${JSON.stringify({ type: 'session', ...header })}\n`;
      await mkdir(paths.sessionDirectory, { recursive: true });
      await writeFile(paths.log, `${headerLine}${body}`);
      await writeFile(paths.tombstone, headerLine);
    }
    total += body.length;
  }
  return total;
}
