/**
 * 外溢層的預算算術（[#719](https://github.com/DemianLi/nexus-agent/issues/719)）：不管內容長什麼樣，換過的那一則
 * **含通知在內不超過預算**，頭尾的暗號留得住，儲存拋錯就原樣交出。組裝與日誌那一半在 `apps/harness/src/spill-policy.test.ts`。
 */

import { ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import {
  createSpillPolicyMiddleware,
  formatSpillNotice,
  SPILL_RETRIEVAL_HINT,
} from './spill-policy.js';
import type { SpillSaveRequest, SpillStore } from './spill-policy.js';
import { estimateTextTokens } from './token-estimate.js';

const HEAD = 'HEAD-9931';
const TAIL = 'TAIL-4407';

interface Saved {
  readonly requests: SpillSaveRequest[];
}

function fakeStore(): SpillStore & Saved {
  const requests: SpillSaveRequest[] = [];
  return {
    requests,
    saveText: (request) => {
      requests.push(request);
      return Promise.resolve({
        locator: `/large_tool_results/abc123def456-${request.toolName}.txt`,
        retrievalHint: SPILL_RETRIEVAL_HINT,
      });
    },
  };
}

type Wrap = (
  request: { toolCall: { name: string; id: string; args: object } },
  handler: (request: unknown) => Promise<unknown>,
) => Promise<unknown>;

async function through(
  store: SpillStore,
  maxInlineTokens: number,
  result: ToolMessage,
  toolName = 'bulk',
  warn?: (message: string) => void,
): Promise<unknown> {
  const middleware = createSpillPolicyMiddleware({
    maxInlineTokens,
    store,
    ...(warn === undefined ? {} : { warn }),
  });
  const wrap = (middleware as unknown as { wrapToolCall: Wrap }).wrapToolCall;
  return wrap({ toolCall: { name: toolName, id: 'call_1', args: {} } }, () =>
    Promise.resolve(result),
  );
}

function message(content: ToolMessage['content'], status?: 'error' | 'success'): ToolMessage {
  return new ToolMessage({
    content,
    tool_call_id: 'call_1',
    name: 'bulk',
    ...(status ? { status } : {}),
  });
}

const SHAPES: readonly (readonly [string, string])[] = [
  [
    '英文多行',
    Array.from({ length: 4_000 }, (_, i) => `line ${i} alpha beta ${i * 7919}`).join('\n'),
  ],
  ['中文', '這是一段很長的中文說明，用來確認每個字約佔零點九個 token。'.repeat(2_000)],
  ['單一超長行', 'abcdefghij'.repeat(10_000)],
  ['大量空白與換行', `x${' \n\t'.repeat(60_000)}y`],
  ['表情符號（代理對）', '🙂🙃😀😃'.repeat(2_500)],
  ['JSON', JSON.stringify(Array.from({ length: 5_000 }, (_, i) => ({ id: i, name: `item-${i}` })))],
];

describe('不管內容長什麼樣，換過的那一則不超過預算', () => {
  it.each(SHAPES)('%s', async (_, body) => {
    const store = fakeStore();
    const text = `${HEAD}\n${body}\n${TAIL}`;
    const budget = 2_000;
    expect(estimateTextTokens(text)).toBeGreaterThan(budget);
    const out = (await through(store, budget, message(text))) as ToolMessage;
    const seen = out.content as string;
    expect(estimateTextTokens(seen)).toBeLessThanOrEqual(budget);
    expect(seen).toContain(HEAD);
    expect(seen).toContain(TAIL);
    expect(seen).toContain('Full formatted result stored at: /large_tool_results/');
    expect(store.requests).toHaveLength(1);
    expect(store.requests[0]?.content).toBe(text);
    // 代理對不能被切成兩半：留下的字串要能無損轉成 UTF-8 再轉回來。
    expect(Buffer.from(seen, 'utf8').toString('utf8')).toBe(seen);
  });

  it('通知裡的略過位元組數是對的', async () => {
    const store = fakeStore();
    const text = `${HEAD}\n${SHAPES[0]![1]}\n${TAIL}`;
    const out = (await through(store, 1_500, message(text))) as ToolMessage;
    const seen = out.content as string;
    const omitted = Number(/Omitted (\d+) bytes\./u.exec(seen)?.[1]);
    const [head, rest] = seen.split('\n\n[...]\n\n') as [string, string];
    const tail = rest.slice(0, rest.lastIndexOf('\n\n('));
    expect(omitted).toBe(
      Buffer.byteLength(text, 'utf8') -
        Buffer.byteLength(head, 'utf8') -
        Buffer.byteLength(tail, 'utf8'),
    );
  });
});

describe('原樣交出的情形', () => {
  const big = `${HEAD}\n${SHAPES[0]![1]}`;

  it('預算內', async () => {
    const store = fakeStore();
    const result = message('短短的');
    expect(await through(store, 2_000, result)).toBe(result);
    expect(store.requests).toHaveLength(0);
  });

  it('read_file 放過', async () => {
    const store = fakeStore();
    const result = message(big);
    expect(await through(store, 500, result, 'read_file')).toBe(result);
    expect(store.requests).toHaveLength(0);
  });

  it('失敗的結果（status: error）不處理', async () => {
    const store = fakeStore();
    const result = message(big, 'error');
    expect(await through(store, 500, result)).toBe(result);
  });

  it('有非文字區塊', async () => {
    const store = fakeStore();
    const result = message([
      { type: 'text', text: big },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
    expect(await through(store, 500, result)).toBe(result);
    expect(store.requests).toHaveLength(0);
  });

  it('儲存拋錯：保留原結果並講一聲', async () => {
    const warnings: string[] = [];
    const store: SpillStore = { saveText: () => Promise.reject(new Error('磁碟滿了')) };
    const result = message(big);
    expect(await through(store, 500, result, 'bulk', (m) => warnings.push(m))).toBe(result);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('磁碟滿了');
  });

  it('算預覽超過時限：保留原結果並講一聲', async () => {
    const warnings: string[] = [];
    const result = message(big);
    const middleware = createSpillPolicyMiddleware({
      maxInlineTokens: 500,
      store: fakeStore(),
      timeBudgetMs: 0,
      warn: (m) => warnings.push(m),
    });
    const wrap = (middleware as unknown as { wrapToolCall: Wrap }).wrapToolCall;
    expect(
      await wrap({ toolCall: { name: 'bulk', id: 'call_1', args: {} } }, () =>
        Promise.resolve(result),
      ),
    ).toBe(result);
    expect(warnings[0]).toContain('算預覽花太久');
  });

  it('預算小到連通知都放不下：保留原結果，而且不留下白存的檔以外的東西', async () => {
    const store = fakeStore();
    const result = message(big);
    expect(await through(store, 20, result)).toBe(result);
  });
});

describe('通知措辭', () => {
  it('逐字照 dsh 的 formatSpillNotice', () => {
    expect(
      formatSpillNotice(1234, { locator: '/large_tool_results/x.txt', retrievalHint: 'HINT' }),
    ).toBe(
      '(Omitted 1234 bytes. Full formatted result stored at: /large_tool_results/x.txt. HINT)',
    );
  });
});
