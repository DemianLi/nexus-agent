import { describe, expect, it } from 'vitest';

import { emptyConversation, prependEntries, reduceAll } from './conversation.js';
import type { ConversationState } from './conversation.js';
import {
  decodeBinaryResult,
  DELIVERABLE_METHODS,
  DELIVERABLES_PRESENTED,
  encodeBinaryResult,
  isBinaryResponse,
  isDeliverableMethod,
} from './deliverables.js';
import type { DeliverablesPresentedPayload } from './deliverables.js';
import { INBOX } from './inbox.js';
import { commandPath, isRpcMethod } from './protocol.js';
import type { Event } from './protocol.js';

/**
 * 交付折成獨立的一格（[#441](https://github.com/DemianLi/nexus-agent/issues/441) 第二刀）。對著真的線的那一條在
 * `@nexus/harness` 的 `present-tool.test.ts`：即時與歷史各折出同一格。這裡驗那條路徑製造不出來的：認不得的
 * 名字與形狀、同一個 `callId` 重複、輪尾與狀態不受影響、往前翻頁接得上。
 */

const ROOT = ['model_request:1'];

let seq = 0;
function frame(method: string, namespace: readonly string[], data: unknown): Event {
  const current = seq++;
  return {
    type: 'event',
    seq: current,
    event_id: `t:${current}`,
    method,
    params: { namespace, timestamp: 0, data },
  } as Event;
}

const running = () => frame('lifecycle', [], { event: 'running', graph_name: 'root' });

/** 人說一句話：線上是 `inbox` 帶 `claimed` 的那一顆，接著才是 root 的 `running`。 */
const said = (text: string): Event =>
  frame('custom', [], { name: INBOX, payload: { items: [], claimed: { id: `q-${seq}`, text } } });
const completed = () => frame('lifecycle', [], { event: 'completed', graph_name: 'root' });

function reply(id: string, text: string): Event[] {
  return [
    frame('messages', ROOT, { event: 'message-start', id: `run-${id}`, run_id: id }),
    frame('messages', ROOT, {
      event: 'content-block-delta',
      index: 0,
      delta: { type: 'text-delta', text },
      run_id: id,
    }),
    frame('messages', ROOT, { event: 'message-finish', reason: 'stop', run_id: id }),
  ];
}

function tool(callId: string): Event[] {
  const namespace = [`tools:${callId}`];
  return [
    frame('tools', namespace, {
      event: 'tool-started',
      tool_call_id: callId,
      tool_name: 'present',
      input: '{}',
    }),
    frame('tools', namespace, {
      event: 'tool-finished',
      tool_call_id: callId,
      tool_name: 'present',
      output: 'Presented a.md',
    }),
  ];
}

function delivered(payload: DeliverablesPresentedPayload): Event {
  return frame('custom', [], { name: DELIVERABLES_PRESENTED, payload });
}

const FILES = [{ path: 'a.md', description: '報告' }, { path: 'b.md' }];

function kinds(state: ConversationState): string[] {
  return state.entries.map((entry) => entry.kind);
}

describe('交付', () => {
  it('落在串流裡它自己的位置，id 是確定值', () => {
    const state = reduceAll(emptyConversation(), [
      said('交付。'),
      running(),
      ...tool('c1'),
      delivered({ callId: 'c1', seq: 1, files: FILES }),
      ...reply('r1', '好了。'),
      completed(),
    ]);
    expect(kinds(state)).toEqual(['human', 'tool', 'deliverables', 'ai']);
    expect(state.entries[2]).toEqual({
      kind: 'deliverables',
      id: 'deliverables:c1',
      callId: 'c1',
      seq: 1,
      files: FILES,
    });
  });

  it('同一個 callId 第二次出現就略過', () => {
    const state = reduceAll(emptyConversation(), [
      delivered({ callId: 'c1', seq: 2, files: FILES }),
      delivered({ callId: 'c1', seq: 3, files: [{ path: 'other.md' }] }),
      delivered({ callId: 'c2', seq: 4, files: [{ path: 'c.md' }] }),
    ]);
    expect(state.entries.map((entry) => entry.id)).toEqual(['deliverables:c1', 'deliverables:c2']);
    // **`seq` 不同也照樣只長一格**：去重的鍵是 `callId`，不是座標。留著第一顆的 `seq`，
    // 因為那一顆才是真的被畫出來的那一格。
    expect(state.entries[0]).toMatchObject({ files: FILES, seq: 2 });
  });

  it('別的名字、壞掉的形狀一律略過，但 seq 照樣往前走', () => {
    const noise = [
      frame('custom', [], {
        name: 'something/else',
        payload: { callId: 'x', seq: 0, files: FILES },
      }),
      frame('custom', [], { payload: { callId: 'x', seq: 0, files: FILES } }),
      frame('custom', [], { name: DELIVERABLES_PRESENTED }),
      frame('custom', [], { name: DELIVERABLES_PRESENTED, payload: { seq: 0, files: FILES } }),
      frame('custom', [], { name: DELIVERABLES_PRESENTED, payload: { callId: 'x', seq: 0 } }),
      frame('custom', [], {
        name: DELIVERABLES_PRESENTED,
        payload: { callId: 'x', seq: 0, files: [{ path: 1 }] },
      }),
      frame('custom', [], {
        name: DELIVERABLES_PRESENTED,
        payload: { callId: 'x', seq: 0, files: [{ path: 'a.md', description: 2 }] },
      }),
      // **座標缺席或不合法的也略過**（#452）：沒有 `seq` 就指不到那顆事件，讀檔路由沒有東西可查。
      // 這三條跟 `workspace/changes` 那側共用同一個判準（`isSeq`）。
      frame('custom', [], { name: DELIVERABLES_PRESENTED, payload: { callId: 'x', files: FILES } }),
      frame('custom', [], {
        name: DELIVERABLES_PRESENTED,
        payload: { callId: 'x', seq: -1, files: FILES },
      }),
      frame('custom', [], {
        name: DELIVERABLES_PRESENTED,
        payload: { callId: 'x', seq: 1.5, files: FILES },
      }),
      frame('custom', [], null),
    ];
    const state = reduceAll(emptyConversation(), noise);
    expect(state.entries).toEqual([]);
    expect(state.lastSeq).toBe(noise.at(-1)!.seq);
  });

  it('不動狀態、不當輪尾：輪尾照樣標在最後一則有文字的回覆上', () => {
    const state = reduceAll(emptyConversation(), [
      said('交付。'),
      running(),
      ...reply('r1', '先寫。'),
      ...tool('c1'),
      delivered({ callId: 'c1', seq: 5, files: FILES }),
    ]);
    expect(state.status).toBe('running');
    expect(state.pendings).toEqual([]);
    const done = reduceAll(state, [completed()]);
    expect(done.status).toBe('idle');
    const tails = done.entries.filter((entry) => entry.kind === 'ai' && entry.turnTail === true);
    expect(tails.map((entry) => entry.id)).toEqual(['r1']);
    // 收尾之後才到的（只呼叫工具、沒有文字的一輪也一樣）不改動任何一格的輪尾。
    const late = reduceAll(done, [delivered({ callId: 'c2', seq: 6, files: FILES })]);
    expect(late.status).toBe('idle');
    expect(late.entries.slice(0, -1)).toEqual(done.entries);
  });

  it('往前翻頁：較早那一頁的交付原樣接在最前面', () => {
    const earlier = reduceAll(emptyConversation(), [
      ...tool('c1'),
      delivered({ callId: 'c1', seq: 7, files: FILES }),
    ]);
    const now = reduceAll(emptyConversation(), [...reply('r2', '後來。')]);
    const joined = prependEntries(now, earlier);
    expect(kinds(joined)).toEqual(['tool', 'deliverables', 'ai']);
    expect(joined.entries[1]).toBe(earlier.entries[1]);
  });
});

/**
 * 命令通道上的交付檔讀取（[#747](https://github.com/DemianLi/nexus-agent/issues/747)）的線上形狀。對著真 handler 的在
 * `@nexus/harness` 的 `deliverable-files.test.ts`；這裡驗編碼與解碼兩端各自的契約與壞回應。
 */
describe('交付檔讀取的方法與多段表單', () => {
  it('兩支方法是命令通道收得下的 method，路徑指名 method', () => {
    expect([...DELIVERABLE_METHODS]).toEqual(['deliverable.read', 'deliverable.readBytes']);
    for (const method of DELIVERABLE_METHODS) {
      expect(isDeliverableMethod(method)).toBe(true);
      expect(isRpcMethod(method)).toBe(true);
    }
    expect(isDeliverableMethod('deliverable.download')).toBe(false);
    expect(isRpcMethod('deliverable.download')).toBe(false);
    expect(commandPath('t', 'deliverable.readBytes')).toBe(
      '/threads/t/commands/deliverable.readBytes',
    );
  });

  const value = {
    path: 'a.bin',
    version: 'v1',
    bytes: 6,
    offset: 0,
    eof: true,
    data: new Uint8Array([0, 1, 2, 255, 254, 0x80]),
  };

  it('編了再解：位元組逐位元組回來，外殼不帶 data', async () => {
    const response = encodeBinaryResult(7, value);
    expect(isBinaryResponse(response)).toBe(true);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const form = await response.clone().formData();
    const metadata = JSON.parse(form.get('metadata') as string) as {
      result: { value: Record<string, unknown> };
    };
    expect('data' in metadata.result.value).toBe(false);

    const decoded = await decodeBinaryResult(response);
    expect(decoded.id).toBe(7);
    expect(decoded.result).toEqual({ ok: true, value });
  });

  it('JSON 回應不算二進位', () => {
    expect(isBinaryResponse(Response.json({ ok: true }))).toBe(false);
    expect(isBinaryResponse(new Response('x'))).toBe(false);
  });

  const formOf = (metadata: unknown, parts: Record<string, string | Blob> = {}): Response => {
    const form = new FormData();
    if (metadata !== undefined) form.set('metadata', JSON.stringify(metadata));
    for (const [name, part] of Object.entries(parts)) form.set(name, part);
    return new Response(form);
  };
  const envelope = (attachments: unknown, result: unknown = { ok: true, value: {} }) => ({
    type: 'success',
    id: 1,
    result,
    attachments,
  });
  const good = { path: ['value', 'data'], codec: 'bytes', part: 'bytes-0' };

  it('壞回應一律拋 TypeError，不悄悄回半截的東西', async () => {
    const blob = new Blob([new Uint8Array([1])]);
    const bad: [string, Response][] = [
      ['沒有 metadata', formOf(undefined, { 'bytes-0': blob })],
      ['metadata 不是字串', formOf(undefined, { metadata: blob, 'bytes-0': blob })],
      ['沒有附件', formOf(envelope([]), {})],
      ['外殼不是 success', formOf({ ...envelope([good]), type: 'error' }, { 'bytes-0': blob })],
      ['id 不是數字', formOf({ ...envelope([good]), id: 'x' }, { 'bytes-0': blob })],
      ['codec 不認得', formOf(envelope([{ ...good, codec: 'base64' }]), { 'bytes-0': blob })],
      ['path 是空的', formOf(envelope([{ ...good, path: [] }]), { 'bytes-0': blob })],
      ['指到的段不存在', formOf(envelope([good]), {})],
      ['指到的段是字串不是位元組', formOf(envelope([good]), { 'bytes-0': 'text' })],
      [
        '位置中間不是物件',
        formOf(envelope([{ ...good, path: ['nope', 'data'] }]), { 'bytes-0': blob }),
      ],
      ['多出沒人指到的段', formOf(envelope([good]), { 'bytes-0': blob, stray: blob })],
    ];
    for (const [name, response] of bad) {
      await expect(decodeBinaryResult(response), name).rejects.toBeInstanceOf(TypeError);
    }
  });

  it('欄位重複拋 TypeError', async () => {
    const form = new FormData();
    form.append('metadata', JSON.stringify(envelope([good])));
    form.append('bytes-0', new Blob([new Uint8Array([1])]));
    form.append('bytes-0', new Blob([new Uint8Array([2])]));
    await expect(decodeBinaryResult(new Response(form))).rejects.toBeInstanceOf(TypeError);
  });
});
