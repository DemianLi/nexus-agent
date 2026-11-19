import { describe, expect, it } from 'vitest';

import { HostMcpClient, Reassembly } from './host-pool.js';
import type { HostCallOptionsLike, HostCaller } from './host-pool.js';
import { isRequestTimeout } from './connection.js';
import { isConnectionLost } from './index.js';

/** 照 `docs/host-mcp.md` 切塊：字串塊加摘要。 */
function pieces(
  text: string,
  size = 7,
): { chunks: string[]; summary: { chunks: number; bytes: number } } {
  const chunks: string[] = [];
  for (let at = 0; at < text.length; at += size) chunks.push(text.slice(at, at + size));
  return { chunks, summary: { chunks: chunks.length, bytes: Buffer.byteLength(text, 'utf8') } };
}

class HostError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Call {
  readonly method: string;
  readonly payload: Record<string, unknown>;
  readonly options: HostCallOptionsLike;
  /** 這個呼叫的編號。 */
  readonly id: number;
  reject(error: unknown): void;
}

/** 假宿主門面：`open` 送清單塊與 `ready` 後掛著不收尾；`call` 交給 `onCall`。 */
function fakeHost(options: {
  doc?: unknown;
  onCall?: (call: Call) => Promise<unknown> | undefined;
}) {
  const calls: Call[] = [];
  const state = { holdOpens: false };
  const held: (() => void)[] = [];
  const readyListeners = new Set<() => void>();
  let nextId = 10;
  const doc = options.doc ?? { tools: [], instructions: '', warning: null };
  const caller: HostCaller = {
    call(_service, method, payload, callOptions = {}) {
      const id = nextId++;
      callOptions.onId?.(id);
      return new Promise((resolve, reject) => {
        const call: Call = {
          method,
          payload: payload as Record<string, unknown>,
          options: callOptions,
          id,
          reject,
        };
        calls.push(call);
        callOptions.signal?.addEventListener('abort', () => {
          reject(new HostError('cancelled', '取消了'));
        });
        if (method === 'open') {
          const complete = (): void => {
            const { chunks, summary } = pieces(JSON.stringify(doc));
            for (const chunk of chunks) callOptions.onChunk?.(chunk);
            callOptions.onChunk?.({ ready: summary });
          };
          if (state.holdOpens) held.push(complete);
          else complete();
          return;
        }
        const handled = options.onCall?.(call);
        if (handled !== undefined) handled.then(resolve, reject);
      });
    },
    onReady(listener) {
      readyListeners.add(listener);
      return () => readyListeners.delete(listener);
    },
  };
  return {
    caller,
    calls,
    /** 之後的 `open` 不回 ready，等 `releaseOpens`（宿主還沒回來）。 */
    holdOpens: () => {
      state.holdOpens = true;
    },
    releaseOpens: () => {
      state.holdOpens = false;
      for (const complete of held.splice(0)) complete();
    },
    fireReady: () => {
      for (const listener of [...readyListeners]) listener();
    },
    opens: () => calls.filter((call) => call.method === 'open'),
  };
}

const server = { serverName: 'demo' };

/** 對一次 `call` 送結果塊並收尾。 */
function answer(call: Call, result: unknown): Promise<unknown> {
  const { chunks, summary } = pieces(JSON.stringify(result));
  for (const chunk of chunks) call.options.onChunk?.(chunk);
  return Promise.resolve(summary);
}

describe('Reassembly', () => {
  it('塊數或位元組數對不上就拼不回', () => {
    const whole = new Reassembly();
    whole.push('ab');
    whole.push('中');
    expect(whole.text({ chunks: 2, bytes: 5 })).toBe('ab中');
    expect(() => whole.text({ chunks: 3, bytes: 5 })).toThrow('拼不回');
    expect(() => whole.text({ chunks: 2, bytes: 4 })).toThrow('拼不回');
  });

  it('不是字串的塊拒絕', () => {
    expect(() => {
      new Reassembly().push({ a: 1 });
    }).toThrow('不是字串');
  });
});

describe('HostMcpClient.open', () => {
  it('拼回清單，指引去掉標頭（instructionsOf 會再加一次）', async () => {
    const host = fakeHost({
      doc: {
        tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
        instructions: '### MCP server: demo\n\n先讀說明',
        warning: null,
      },
    });
    const client = await HostMcpClient.open(host.caller, { server, elicitation: false });
    expect(await client.listTools()).toEqual({
      tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
    });
    expect(client.getInstructions()).toBe('先讀說明');
    expect(host.opens()[0]?.payload).toEqual({ server, elicitation: false });
  });

  it('宿主給了 warning（連不上、沒寫 failOnStartupError）就當連不上，訊息原樣', async () => {
    const host = fakeHost({ doc: { tools: [], instructions: '', warning: '連不上 demo' } });
    await expect(HostMcpClient.open(host.caller, { server, elicitation: false })).rejects.toThrow(
      '連不上 demo',
    );
  });

  it('ready 之前 open 就以錯結算，原樣丟出', async () => {
    const caller: HostCaller = {
      call: () => Promise.reject(new HostError('service', 'failOnStartupError 連不上')),
      onReady: () => () => undefined,
    };
    await expect(HostMcpClient.open(caller, { server, elicitation: false })).rejects.toThrow(
      'failOnStartupError 連不上',
    );
  });
});

describe('HostMcpClient 的呼叫', () => {
  it('call 指到 open 的編號，params 是 JSON 文字，結果拼回', async () => {
    const host = fakeHost({
      onCall: (call) => answer(call, { content: [{ type: 'text', text: '好' }] }),
    });
    const client = await HostMcpClient.open(host.caller, { server, elicitation: false });
    const result = await client.callTool({ name: 'echo', arguments: { a: 1 } });
    expect(result).toEqual({ content: [{ type: 'text', text: '好' }] });
    const call = host.calls.find((item) => item.method === 'call');
    expect(call?.payload).toEqual({
      open: host.opens()[0]?.id,
      method: 'tools/call',
      params: JSON.stringify({ name: 'echo', arguments: { a: 1 } }),
    });
  });

  it('resources 三個方法各走自己的 method', async () => {
    const host = fakeHost({ onCall: (call) => answer(call, { ok: call.payload.method }) });
    const client = await HostMcpClient.open(host.caller, { server, elicitation: false });
    await client.listResources({ cursor: 'c' });
    await client.listResourceTemplates();
    await client.readResource({ uri: 'u://x' });
    const methods = host.calls.filter((c) => c.method === 'call').map((c) => c.payload.method);
    expect(methods).toEqual(['resources/list', 'resources/templates/list', 'resources/read']);
  });

  it('呼叫端的 signal 中止就送取消', async () => {
    const host = fakeHost({ onCall: () => new Promise(() => undefined) });
    const client = await HostMcpClient.open(host.caller, { server, elicitation: false });
    const controller = new AbortController();
    const pending = client.callTool({ name: 'x', arguments: {} }, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(new Error('不要了'));
    await expect(pending).rejects.toThrow('不要了');
    expect(host.calls.at(-1)?.options.signal?.aborted).toBe(true);
  });

  it('結果拼不回就丟錯，不當成功', async () => {
    const host = fakeHost({
      onCall: (call) => {
        call.options.onChunk?.('{"content"');
        return Promise.resolve({ chunks: 2, bytes: 10 });
      },
    });
    const client = await HostMcpClient.open(host.caller, { server, elicitation: false });
    await expect(client.callTool({ name: 'x', arguments: {} })).rejects.toThrow('拼不回');
  });
});

describe('outputSchema 驗證（SDK 替我們做的，宿主給的是原文）', () => {
  const definition = {
    name: 'typed',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
  };

  it('structuredContent 對不上 schema 就丟錯', async () => {
    const host = fakeHost({
      onCall: (call) => answer(call, { content: [], structuredContent: { n: 'x' } }),
    });
    const client = await HostMcpClient.open(host.caller, { server, elicitation: false });
    await expect(
      client.callTool({ name: 'typed', arguments: {} }, { toolDefinition: definition as never }),
    ).rejects.toThrow('output schema');
  });

  it('沒有 structuredContent 也丟錯；isError 不驗；對得上就過', async () => {
    const results = [
      { content: [] },
      { content: [], isError: true },
      { content: [], structuredContent: { n: 1 } },
    ];
    const host = fakeHost({ onCall: (call) => answer(call, results.shift()) });
    const client = await HostMcpClient.open(host.caller, { server, elicitation: false });
    const options = { toolDefinition: definition as never };
    await expect(client.callTool({ name: 'typed', arguments: {} }, options)).rejects.toThrow(
      'did not return structured content',
    );
    await expect(client.callTool({ name: 'typed', arguments: {} }, options)).resolves.toMatchObject(
      {
        isError: true,
      },
    );
    await expect(client.callTool({ name: 'typed', arguments: {} }, options)).resolves.toMatchObject(
      {
        structuredContent: { n: 1 },
      },
    );
  });
});

describe('宿主連線斷了又連上', () => {
  it('送出去之後斷線（host_lost）：結果不明，不重送（M2）', async () => {
    const host = fakeHost({
      onCall: (call) => {
        call.reject(new HostError('host_lost', '呼叫送出之後宿主連線斷了，結果不明'));
        return undefined;
      },
    });
    const client = await HostMcpClient.open(host.caller, { server, elicitation: false });
    await expect(client.callTool({ name: 'pay', arguments: {} })).rejects.toThrow(
      'result is unknown',
    );
    expect(host.calls.filter((c) => c.method === 'call')).toHaveLength(1);
  });

  it('空窗裡的呼叫等重新 open 的綁定，用新的編號送（M3）', async () => {
    const host = fakeHost({ onCall: (call) => answer(call, { ok: true }) });
    const client = await HostMcpClient.open(host.caller, { server, elicitation: false });
    host.holdOpens();
    host.opens()[0]?.reject(new HostError('host_lost', '斷了'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const pending = client.callTool({ name: 'echo', arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(host.calls.filter((c) => c.method === 'call')).toHaveLength(0);
    host.releaseOpens();
    await expect(pending).resolves.toEqual({ ok: true });
    const second = host.opens()[1];
    expect(second).toBeDefined();
    expect(host.calls.find((c) => c.method === 'call')?.payload.open).toBe(second?.id);
  });

  it('等到期限（W）還沒有綁定：回 server is disconnected，不送出，之後綁定回來又能呼叫', async () => {
    const host = fakeHost({ onCall: (call) => answer(call, { ok: true }) });
    const client = await HostMcpClient.open(host.caller, {
      server,
      elicitation: false,
      rebindWaitMs: 30,
    });
    host.holdOpens();
    host.opens()[0]?.reject(new HostError('host_lost', '斷了'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const started = Date.now();
    await expect(client.callTool({ name: 'echo', arguments: {} })).rejects.toThrow(
      'server is disconnected',
    );
    expect(Date.now() - started).toBeLessThan(500);
    expect(host.calls.filter((c) => c.method === 'call')).toHaveLength(0);
    host.releaseOpens();
    await expect(client.callTool({ name: 'echo', arguments: {} })).resolves.toEqual({ ok: true });
  });

  it('重新 open 單飛：等綁定的多個呼叫與 onReady 只發一次 open', async () => {
    const host = fakeHost({ onCall: (call) => answer(call, { ok: true }) });
    const client = await HostMcpClient.open(host.caller, { server, elicitation: false });
    host.holdOpens();
    host.opens()[0]?.reject(new HostError('host_lost', '斷了'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const calls = [1, 2, 3].map(() => client.callTool({ name: 'echo', arguments: {} }));
    host.fireReady();
    host.fireReady();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(host.opens()).toHaveLength(2);
    host.releaseOpens();
    await Promise.all(calls);
    expect(host.opens()).toHaveLength(2);
  });

  it('重新 open 被宿主回錯：綁定留空，下一次呼叫再經同一入口試；舊清單不被蓋掉', async () => {
    const host = fakeHost({
      doc: {
        tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
        instructions: '',
        warning: null,
      },
      onCall: (call) => answer(call, { ok: true }),
    });
    const client = await HostMcpClient.open(host.caller, { server, elicitation: false });
    host.opens()[0]?.reject(new HostError('host_lost', '斷了'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    host.holdOpens();
    const first = client.callTool({ name: 'echo', arguments: {} }, {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    host.opens()[1]?.reject(new HostError('service', '宿主拒絕'));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(host.opens()).toHaveLength(3);
    host.releaseOpens();
    await expect(first).resolves.toEqual({ ok: true });
    expect(await client.listTools()).toMatchObject({ tools: [{ name: 'echo' }] });
  });

  it('宿主對已失效的編號回 BadPayload：當作沒送出，改送新綁定（舊編號不重送）', async () => {
    let attempts = 0;
    const host: ReturnType<typeof fakeHost> = fakeHost({
      onCall: (call) => {
        attempts += 1;
        if (attempts > 1) return answer(call, { ok: true });
        // 呼叫帶著舊編號出去之後、宿主的回覆到之前：宿主連線重起，舊綁定結算、新綁定 ready；宿主對舊編號回「沒有已經 ready 的綁定」。
        return (async () => {
          host.opens()[0]?.reject(new HostError('host_lost', '斷了'));
          await new Promise((resolve) => setTimeout(resolve, 5));
          host.fireReady();
          await new Promise((resolve) => setTimeout(resolve, 5));
          throw new HostError('BadPayload', '沒有已經 ready 的綁定');
        })();
      },
    });
    const client = await HostMcpClient.open(host.caller, { server, elicitation: false });
    const oldId = host.opens()[0]?.id;
    await expect(client.callTool({ name: 'echo', arguments: {} })).resolves.toEqual({ ok: true });
    const sent = host.calls.filter((c) => c.method === 'call').map((c) => c.payload.open);
    expect(sent).toEqual([oldId, host.opens()[1]?.id]);
  });

  it('宿主對當前編號回 BadPayload：照真錯回出去，不重送', async () => {
    const host = fakeHost({
      onCall: (call) => {
        call.reject(new HostError('BadPayload', 'params 不合法'));
        return undefined;
      },
    });
    const client = await HostMcpClient.open(host.caller, { server, elicitation: false });
    await expect(client.callTool({ name: 'echo', arguments: {} })).rejects.toThrow('params 不合法');
    expect(host.calls.filter((c) => c.method === 'call')).toHaveLength(1);
  });

  it('宿主路徑上不送 _meta（由宿主一家帶）', async () => {
    const host = fakeHost({ onCall: (call) => answer(call, { ok: true }) });
    const client = await HostMcpClient.open(host.caller, { server, elicitation: true });
    await client.callTool({ name: 'echo', arguments: {}, _meta: { capabilities: 1 } });
    const params = JSON.parse(
      String(host.calls.find((c) => c.method === 'call')?.payload.params),
    ) as Record<string, unknown>;
    expect(params).toEqual({ name: 'echo', arguments: {} });
  });

  it('server 層的連線字樣不被 isConnectionLost 認成掉線；逾時不算掉線', async () => {
    const host = fakeHost({
      onCall: (call) => {
        call.reject(new HostError('service', 'MCP error -32000: Connection closed'));
        return undefined;
      },
    });
    const client = await HostMcpClient.open(host.caller, { server, elicitation: false });
    const error = await client.callTool({ name: 'echo', arguments: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(isConnectionLost(error)).toBe(false);
    expect((error as Error).message).toContain('Connection closed'.toLowerCase());
    const waited = fakeHost({});
    const idle = await HostMcpClient.open(waited.caller, {
      server,
      elicitation: false,
      rebindWaitMs: 10,
    });
    waited.opens()[0]?.reject(new HostError('host_lost', '斷了'));
    waited.holdOpens();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const disconnected = await idle.callTool({ name: 'x', arguments: {} }).catch((e: unknown) => e);
    expect(isConnectionLost(disconnected)).toBe(false);
    expect(isRequestTimeout(disconnected)).toBe(false);
  });

  it('逾時由宿主算；門面只留一個比它晚 W 的保險計時，到了送取消並丟 REQUEST_TIMEOUT', async () => {
    const host = fakeHost({ onCall: () => new Promise(() => undefined) });
    const client = await HostMcpClient.open(host.caller, {
      server,
      elicitation: false,
      rebindWaitMs: 20,
    });
    const started = Date.now();
    const error = await client
      .callTool({ name: 'slow', arguments: {} }, { timeout: 20 })
      .catch((e: unknown) => e);
    expect(isRequestTimeout(error)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    expect(host.calls.at(-1)?.options.signal?.aborted).toBe(true);
  });

  it('從不叫 onclose：宿主重起不是 server 掉線，TS 的監督者不重連', async () => {
    const host = fakeHost({});
    const client = await HostMcpClient.open(host.caller, { server, elicitation: false });
    let closed = 0;
    client.onclose = () => {
      closed += 1;
    };
    host.opens()[0]?.reject(new HostError('host_lost', '斷了'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    host.fireReady();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(closed).toBe(0);
    expect(host.opens()).toHaveLength(2);
  });

  it('close 之後 onReady 不再重新 open，且取消 open 呼叫', async () => {
    const host = fakeHost({});
    const client = await HostMcpClient.open(host.caller, { server, elicitation: false });
    await client.close();
    expect(host.opens()[0]?.options.signal?.aborted).toBe(true);
    host.fireReady();
    expect(host.opens()).toHaveLength(1);
  });
});

describe('協定世代', () => {
  it('有反問旗標才當新協定帶 _meta', async () => {
    const host = fakeHost({});
    expect(
      (await HostMcpClient.open(host.caller, { server, elicitation: true })).getProtocolEra(),
    ).toBe('modern');
    expect(
      (await HostMcpClient.open(host.caller, { server, elicitation: false })).getProtocolEra(),
    ).toBe('legacy');
  });
});
