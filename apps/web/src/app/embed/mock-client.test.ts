import type { Event } from '@nexus/wire';
import { describe, expect, test } from 'vitest';

import { createMockClient, MOCK_DEFAULT_REPLY, MOCK_UNSUPPORTED } from './mock-client';
import type { NexusChatMock } from './mock-client';

/** 模擬模式的劇本 client（#3175）：照劇本推的 frame 與交回的路徑。元件畫出來的樣子在真瀏覽器裡看過（PR 的截圖）。 */

type Data = Record<string, unknown>;

async function open(mock: NexusChatMock | undefined) {
  const client = createMockClient(() => mock);
  const events = await client.openEvents('t');
  const seen: Event[] = [];
  const next = async (predicate: (event: Event, data: Data) => boolean): Promise<Data> => {
    for (;;) {
      const { value } = await events.next();
      if (value === undefined) throw new Error('下行結束了');
      seen.push(value);
      const data = (value.params as { data: Data }).data;
      if (predicate(value, data)) return data;
    }
  };
  return { client, next, seen };
}

const isEvent = (method: string, event: string) => (frame: Event, data: Data) =>
  frame.method === method && data.event === event;
const isInterrupt = (frame: Event) => frame.method === 'input.requested';

describe('createMockClient', () => {
  test('回覆：領走那一句，畫一則回覆，這一輪收尾', async () => {
    const { client, next } = await open({ turns: [[{ say: '你好' }]] });
    await client.runStart('t', '嗨');
    const claimed = await next(
      (frame, data) => frame.method === 'custom' && 'claimed' in (data.payload as Data),
    );
    expect((claimed.payload as Data).claimed).toMatchObject({ text: '嗨' });
    const delta = await next(isEvent('messages', 'content-block-delta'));
    expect(delta.delta).toEqual({ type: 'text-delta', text: '你好' });
    await next(isEvent('lifecycle', 'completed'));
  });

  test('劇本用完回預設的一句', async () => {
    const { client, next } = await open(undefined);
    await client.runStart('t', '嗨');
    const delta = await next(isEvent('messages', 'content-block-delta'));
    expect(delta.delta).toEqual({ type: 'text-delta', text: MOCK_DEFAULT_REPLY });
  });

  test('宿主頁工具：先核准，再交給宿主頁，結果畫在工具卡上', async () => {
    const { client, next } = await open({
      reply: ({ text, context, hostTools }) => [
        { tool: 'focus_device', args: { id: `${text}|${context}|${hostTools.join()}` } },
      ],
    });
    await client.runStart('t', 'B-07', {
      context: { label: 'A-12' },
      hostTools: [{ name: 'focus_device', description: 'd', parameters: { type: 'object' } }],
    });
    const started = await next(isEvent('tools', 'tool-started'));
    expect(started).toMatchObject({ tool_name: 'page__focus_device' });
    const approval = await next(isInterrupt);
    expect(approval.payload).toMatchObject({
      actionRequests: [{ name: 'page__focus_device', args: { id: 'B-07|A-12|focus_device' } }],
    });
    await client.inputRespond('t', {
      namespace: [],
      interrupt_id: approval.interrupt_id as string,
      response: { decisions: [{ type: 'approve' }] },
    });
    const host = await next(isInterrupt);
    expect(host.payload).toEqual({
      kind: 'host_tool',
      name: 'focus_device',
      args: { id: 'B-07|A-12|focus_device' },
    });
    expect(
      await client.inputRespond('t', {
        namespace: [],
        interrupt_id: host.interrupt_id as string,
        response: { ok: true, result: { focused: 'B-07' } },
      }),
    ).toMatchObject({ type: 'success' });
    const finished = await next(isEvent('tools', 'tool-finished'));
    expect(finished).toMatchObject({ message: '{"focused":"B-07"}' });
    expect(finished.failed).toBeUndefined();
    await next(isEvent('lifecycle', 'completed'));
  });

  test('宿主頁 fail：工具卡標失敗、帶原因', async () => {
    const { client, next } = await open({
      turns: [[{ tool: 'focus_device', args: { id: 'X' }, approval: false }]],
    });
    await client.runStart('t', '轉');
    const host = await next(isInterrupt);
    await client.inputRespond('t', {
      namespace: [],
      interrupt_id: host.interrupt_id as string,
      response: { ok: false, error: '沒有設備 X' },
    });
    expect(await next(isEvent('tools', 'tool-finished'))).toMatchObject({
      failed: true,
      message: '沒有設備 X',
    });
  });

  test('拒絕核准：不交給宿主頁，工具卡標失敗', async () => {
    const { client, next, seen } = await open({ turns: [[{ tool: 'focus_device' }]] });
    await client.runStart('t', '轉');
    const approval = await next(isInterrupt);
    await client.inputRespond('t', {
      namespace: [],
      interrupt_id: approval.interrupt_id as string,
      response: { decisions: [{ type: 'reject' }] },
    });
    expect(await next(isEvent('tools', 'tool-finished'))).toMatchObject({ failed: true });
    await next(isEvent('lifecycle', 'completed'));
    expect(seen.filter(isInterrupt)).toHaveLength(1);
  });

  test('不認得的中斷回錯誤；不支援的方法說模擬模式不支援', async () => {
    const { client } = await open(undefined);
    expect(
      await client.inputRespond('t', { namespace: [], interrupt_id: 'nope', response: {} }),
    ).toMatchObject({ type: 'error' });
    expect(await client.uploadFile('t', new Blob(['x']) as File)).toMatchObject({
      message: MOCK_UNSUPPORTED,
    });
  });
});
