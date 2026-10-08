/**
 * MCP server 反問使用者（[#1098](https://github.com/DemianLi/nexus-agent/issues/1098)）：翻譯的單元判準，加上真的
 * `ThreadPump`＋新協議 stdio server 的整條路。
 *
 * 整條路的判準：
 *
 * 1. **要問人的**（root、有 `form`）：下行是問答卡（`kind: 'question'`），帶 `origin`（哪台 server、哪支工具、什麼參數）；
 *    接受／拒絕／放棄各自讓 server 收到 `accept`／`decline`／`cancel`，工具照常回傳，不是工具錯誤。
 * 2. **不問人的**（全是 `url`、子代理）：下行**沒有卡**，這一輪收尾後系統自動回絕，日誌記 `interrupt/system-answered`；
 *    人答的路不帶那顆事件。
 * 3. **混合**（`form`＋`url`）：卡上只有 `form` 的欄位；`url` 那個 key 由系統回絕，並記下來。
 * 4. **沒有人在的入口**（沒有 `human` 管道）：連線根本不開 elicitation，server 的反問在協商時就被拒。
 */

import { fileURLToPath } from 'node:url';
import { MemorySaver } from '@langchain/langgraph';
import { createHostServicesPlugin } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import { createMcpPlugin } from '@nexus/plugin-mcp';
import { GENERAL_PURPOSE_SUBAGENT } from 'deepagents';
import { afterEach, describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { shippedPlugins } from './fixtures.js';
import {
  answerElicitation,
  declineAll,
  parseMcpElicitation,
  questionPayloadOf,
  systemAnswerReasonOf,
} from './mcp-elicitation.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const SERVER = fileURLToPath(
  new URL('../../../packages/nexus-plugin-mcp/src/modern-stdio-server.ts', import.meta.url),
);

const FORM = {
  mode: 'form',
  message: '請填這份資料',
  requestedSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', title: '姓名' },
      color: { type: 'string', enum: ['紅', '藍'] },
      age: { type: 'integer', minimum: 0 },
      vip: { type: 'boolean' },
      tags: { type: 'array', items: { enum: ['a', 'b', 'c'] } },
    },
    required: ['name', 'color', 'age', 'vip'],
  },
} as const;
const URL_REQUEST = {
  mode: 'url',
  message: '請授權',
  url: 'https://example.test/authorize',
} as const;

const payload = (requests: Record<string, unknown>) => ({
  type: 'mcp_elicitation',
  server: 'srv',
  tool: 'ask_mixed',
  arguments: { x: 1 },
  requests,
});

describe('翻譯：酬載 ⇄ 問答卡', () => {
  it('認得 adapter 的形狀；缺欄位、模式不認得、空的 requests 都當作不是', () => {
    expect(parseMcpElicitation(payload({ profile: FORM }))).toBeDefined();
    expect(parseMcpElicitation(payload({}))).toBeUndefined();
    expect(parseMcpElicitation(payload({ a: { mode: 'weird', message: 'x' } }))).toBeUndefined();
    expect(parseMcpElicitation({ ...payload({ a: FORM }), type: 'other' })).toBeUndefined();
    expect(parseMcpElicitation({ kind: 'approval', actionRequests: [] })).toBeUndefined();
    expect(parseMcpElicitation(null)).toBeUndefined();
  });

  it('每個 form 欄位一題；message 放第一題的 detail；url 不出題；origin 帶 server／tool／參數', () => {
    const elicitation = parseMcpElicitation(payload({ profile: FORM, auth: URL_REQUEST }))!;
    const card = questionPayloadOf(elicitation);
    expect(card.kind).toBe('question');
    expect(card.origin).toEqual({
      kind: 'mcp-elicitation',
      server: 'srv',
      tool: 'ask_mixed',
      arguments: { x: 1 },
    });
    expect(card.questions.map((q) => q.id)).toEqual([
      'profile/name',
      'profile/color',
      'profile/age',
      'profile/vip',
      'profile/tags',
    ]);
    expect(card.questions[0]).toMatchObject({ question: '姓名', detail: '請填這份資料' });
    expect(card.questions[1]?.options?.map((o) => o.label)).toEqual(['紅', '藍']);
    expect(card.questions[1]?.detail).toBeUndefined();
    expect(card.questions[2]?.options).toBeUndefined();
    expect(card.questions[3]?.options?.map((o) => o.label)).toEqual(['是', '否']);
    expect(card.questions[4]).toMatchObject({ multiSelect: true });
  });

  it('答案換回型別：字串、列舉、布林、數字、多選；沒填的非必填欄位不放；url 的 key 回絕', () => {
    const elicitation = parseMcpElicitation(payload({ profile: FORM, auth: URL_REQUEST }))!;
    const result = answerElicitation(elicitation, {
      answers: [
        { id: 'profile/name', selected: [], custom: ' 阿明 ' },
        { id: 'profile/color', selected: ['藍'] },
        { id: 'profile/age', selected: [], custom: '3' },
        { id: 'profile/vip', selected: ['否'] },
        { id: 'profile/tags', selected: ['a', 'c'] },
      ],
    });
    expect(result).toEqual({
      responses: {
        profile: {
          action: 'accept',
          content: { name: '阿明', color: '藍', age: 3, vip: false, tags: ['a', 'c'] },
        },
        auth: { action: 'decline' },
      },
    });
    const sparse = answerElicitation(elicitation, {
      answers: [{ id: 'profile/name', selected: [], custom: 'x' }],
    });
    expect(sparse.responses['profile']).toEqual({ action: 'accept', content: { name: 'x' } });
  });

  it('不是數字的數字欄位原字串送過去，由 adapter 驗，不在這裡改寫', () => {
    const elicitation = parseMcpElicitation(payload({ profile: FORM }))!;
    const result = answerElicitation(elicitation, {
      answers: [{ id: 'profile/age', selected: [], custom: 'abc' }],
    });
    expect(result.responses['profile']?.content?.['age']).toBe('abc');
  });

  it('declined → 全部 decline；cancelled → 全部 cancel；看不懂的回覆拋錯', () => {
    const elicitation = parseMcpElicitation(payload({ profile: FORM, auth: URL_REQUEST }))!;
    expect(answerElicitation(elicitation, { declined: true })).toEqual(declineAll(elicitation));
    expect(answerElicitation(elicitation, { cancelled: true })).toEqual({
      responses: { profile: { action: 'cancel' }, auth: { action: 'cancel' } },
    });
    expect(() => answerElicitation(elicitation, { decisions: [{ type: 'approve' }] })).toThrow(
      '看不懂',
    );
    expect(() => answerElicitation(elicitation, 'yes')).toThrow('看不懂');
  });

  it('沒有欄位的表單：選「確認」才 accept', () => {
    const elicitation = parseMcpElicitation(
      payload({
        ok: {
          mode: 'form',
          message: '要繼續嗎？',
          requestedSchema: { type: 'object', properties: {} },
        },
      }),
    )!;
    const card = questionPayloadOf(elicitation);
    expect(card.questions).toEqual([
      { id: 'ok', question: '要繼續嗎？', options: [{ label: '確認' }] },
    ]);
    expect(answerElicitation(elicitation, { answers: [{ id: 'ok', selected: ['確認'] }] })).toEqual(
      {
        responses: { ok: { action: 'accept', content: {} } },
      },
    );
    expect(answerElicitation(elicitation, { answers: [{ id: 'ok', selected: [] }] })).toEqual({
      responses: { ok: { action: 'decline' } },
    });
  });

  it('誰代答：子代理一律；全是 url 一律；有 form 的 root 要問人', () => {
    const form = parseMcpElicitation(payload({ profile: FORM }))!;
    const urlOnly = parseMcpElicitation(payload({ auth: URL_REQUEST }))!;
    const mixed = parseMcpElicitation(payload({ profile: FORM, auth: URL_REQUEST }))!;
    expect(systemAnswerReasonOf(form, false)).toBeUndefined();
    expect(systemAnswerReasonOf(mixed, false)).toBeUndefined();
    expect(systemAnswerReasonOf(urlOnly, false)).toBe('url-mode');
    expect(systemAnswerReasonOf(form, true)).toBe('subagent');
  });
});

// ── 整條路 ──────────────────────────────────────────────────────────────────────────────

const shipped = await shippedPlugins();
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Rig {
  readonly pump: ThreadPump;
  readonly events: () => readonly SessionEvent[];
  readonly frames: { method: string; namespace: readonly string[]; data: unknown }[];
  readonly warnings: string[];
}

async function rig(turns: ScriptedTurn[], channel: 'human' | 'none' = 'human'): Promise<Rig> {
  const model = new ScriptedChatModel({ turns });
  const built = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    plugins: [
      ...(channel === 'human'
        ? [createHostServicesPlugin({ channel: { kind: 'human' } }, 'elicit-test-channel')]
        : []),
      ...shipped,
      createMcpPlugin({
        serverName: 'srv',
        connection: {
          transport: 'stdio',
          command: process.execPath,
          args: ['--import', 'tsx', SERVER],
        },
      }),
    ],
  });
  const warnings: string[] = [];
  const pump = new ThreadPump(
    built.agent as unknown as PumpAgent,
    `elicit-${String(Math.random())}`,
    undefined,
    undefined,
    undefined,
    undefined,
    (message) => warnings.push(message),
  );
  const detach = built.attachSession(pump.sessions);
  const line = new AbortController();
  const frames: Rig['frames'] = [];
  const draining = (async () => {
    for await (const frame of pump.subscribe(
      ['messages', 'tools', 'lifecycle', 'input'],
      line.signal,
    )) {
      const event = frame as { method: string; params: { namespace: string[]; data: unknown } };
      frames.push({
        method: event.method,
        namespace: event.params.namespace,
        data: event.params.data,
      });
    }
  })();
  cleanups.push(async () => {
    line.abort();
    await draining;
    detach();
    await built.dispose();
  });
  return { pump, events: () => pump.sessions.root.events, frames, warnings };
}

const typesOf = (rig: Rig) => rig.events().map((event) => event.type);
const dataOf = <T extends SessionEvent['type']>(rig: Rig, type: T) =>
  rig
    .events()
    .filter((event) => event.type === type)
    .map((event) => event.data as Record<string, unknown>);
const toolOutputs = (rig: Rig) => dataOf(rig, 'tool/result').map((data) => JSON.stringify(data));

const ASK = (name: string): ScriptedTurn => ({
  content: '問',
  toolCalls: [{ name: `mcp__srv__${name}`, args: {} }],
});

describe('整條路：root', () => {
  it('form：下行是帶 origin 的問答卡；接受 → server 收到 accept；人答的路沒有代答事件', async () => {
    const r = await rig([ASK('ask_form'), { content: '收工' }]);
    await r.pump.submit({ kind: 'message', text: '開工' });
    await r.pump.whenIdle();

    expect(r.pump.pendings).toHaveLength(1);
    const [pending] = r.pump.pendings;
    const requested = r.frames.filter((f) => f.method === 'input.requested');
    expect(requested).toHaveLength(1);
    const card = (requested[0]?.data as { payload: Record<string, unknown> }).payload;
    expect(card['kind']).toBe('question');
    expect(card['origin']).toMatchObject({
      kind: 'mcp-elicitation',
      server: 'srv',
      tool: 'ask_form',
    });
    expect((card['questions'] as { id: string }[]).map((q) => q.id)).toEqual([
      'profile/name',
      'profile/color',
      'profile/age',
      'profile/vip',
    ]);

    await r.pump.submit({
      kind: 'resume',
      interruptId: pending!.interruptId,
      response: {
        answers: [
          { id: 'profile/name', selected: [], custom: '阿明' },
          { id: 'profile/color', selected: ['紅'] },
          { id: 'profile/age', selected: [], custom: '3' },
          { id: 'profile/vip', selected: ['是'] },
        ],
      },
    });
    await r.pump.whenIdle();

    expect(r.pump.pendings).toHaveLength(0);
    expect(toolOutputs(r).join('\n')).toContain('profile=accept');
    expect(toolOutputs(r).join('\n')).toContain('阿明');
    expect(typesOf(r)).not.toContain('interrupt/system-answered');
    expect(r.warnings).toEqual([]);
  }, 60_000);

  it('form：拒絕 → decline；放棄 → cancel；都是 server 收到的動作，不是工具錯誤', async () => {
    for (const [response, expected] of [
      [{ declined: true }, 'profile=decline'],
      [{ cancelled: true }, 'profile=cancel'],
    ] as const) {
      const r = await rig([ASK('ask_form'), { content: '收工' }]);
      await r.pump.submit({ kind: 'message', text: '開工' });
      await r.pump.whenIdle();
      await r.pump.submit({
        kind: 'resume',
        interruptId: r.pump.pendings[0]!.interruptId,
        response,
      });
      await r.pump.whenIdle();
      const outputs = toolOutputs(r).join('\n');
      expect(outputs, expected).toContain(expected);
      expect(dataOf(r, 'tool/result').every((d) => d['isError'] !== true)).toBe(true);
    }
  }, 120_000);

  it('回覆看不懂：收下之前拒絕，掛著的那顆不動', async () => {
    const r = await rig([ASK('ask_form'), { content: '收工' }]);
    await r.pump.submit({ kind: 'message', text: '開工' });
    await r.pump.whenIdle();
    const id = r.pump.pendings[0]!.interruptId;
    await expect(
      r.pump.submit({
        kind: 'resume',
        interruptId: id,
        response: { decisions: [{ type: 'approve' }] },
      }),
    ).rejects.toThrow('看不懂');
    expect(r.pump.pendings.map((p) => p.interruptId)).toEqual([id]);
  }, 60_000);

  it('全是 url：下行沒有卡，這一輪收尾後自動回絕，日誌記 url-mode 代答', async () => {
    const r = await rig([ASK('ask_url'), { content: '收工' }]);
    await r.pump.submit({ kind: 'message', text: '開工' });
    await r.pump.whenIdle();

    expect(r.frames.filter((f) => f.method === 'input.requested')).toEqual([]);
    expect(r.pump.pendings).toHaveLength(0);
    expect(toolOutputs(r).join('\n')).toContain('auth=decline');
    const raised = dataOf(r, 'interrupt/raised');
    expect(raised).toHaveLength(1);
    expect(dataOf(r, 'interrupt/system-answered')).toEqual([
      { interruptId: raised[0]?.['interruptId'], reason: 'url-mode', keys: ['auth'] },
    ]);
    // 代答是回絕那一輪的 resume，落在 system-answered 之前。
    const types = typesOf(r);
    expect(types.indexOf('turn/start', types.indexOf('interrupt/raised'))).toBeLessThan(
      types.indexOf('interrupt/system-answered'),
    );
    expect(r.warnings.join('\n')).toContain('網址授權');
  }, 60_000);

  it('連問兩輪的 url：第二顆中斷帶著同一個 id 再來，照樣代答（不能被當成看過的）', async () => {
    const r = await rig([ASK('ask_twice'), { content: '收工' }]);
    await r.pump.submit({ kind: 'message', text: '開工' });
    await r.pump.whenIdle();
    expect(r.pump.pendings).toHaveLength(0);
    expect(toolOutputs(r).join('\n')).toContain('two=decline');
    expect(dataOf(r, 'interrupt/system-answered')).toMatchObject([
      { reason: 'url-mode', keys: ['one'] },
      { reason: 'url-mode', keys: ['two'] },
    ]);
  }, 60_000);

  it('form＋url：卡上只有 form 的欄位；答完 url 那個 key 由系統回絕並記下來', async () => {
    const r = await rig([ASK('ask_mixed'), { content: '收工' }]);
    await r.pump.submit({ kind: 'message', text: '開工' });
    await r.pump.whenIdle();
    const card = (
      r.frames.find((f) => f.method === 'input.requested')?.data as {
        payload: { questions: { id: string }[] };
      }
    ).payload;
    expect(card.questions.every((q) => q.id.startsWith('profile/'))).toBe(true);
    await r.pump.submit({
      kind: 'resume',
      interruptId: r.pump.pendings[0]!.interruptId,
      response: {
        answers: [
          { id: 'profile/name', selected: [], custom: 'x' },
          { id: 'profile/color', selected: ['藍'] },
          { id: 'profile/age', selected: [], custom: '1' },
          { id: 'profile/vip', selected: ['否'] },
        ],
      },
    });
    await r.pump.whenIdle();
    const outputs = toolOutputs(r).join('\n');
    expect(outputs).toContain('profile=accept');
    expect(outputs).toContain('auth=decline');
    expect(dataOf(r, 'interrupt/system-answered')).toMatchObject([
      { reason: 'url-mode', keys: ['auth'] },
    ]);
  }, 60_000);

  it('沒有 human 管道：連線不開 elicitation，server 的反問在協商時就被拒，沒有中斷', async () => {
    const r = await rig([ASK('ask_form'), { content: '收工' }], 'none');
    await r.pump.submit({ kind: 'message', text: '開工' });
    await r.pump.whenIdle();
    expect(r.pump.pendings).toHaveLength(0);
    expect(typesOf(r)).not.toContain('interrupt/raised');
    expect(r.frames.filter((f) => f.method === 'input.requested')).toEqual([]);
  }, 60_000);
});

describe('整條路：子代理', () => {
  it('前景子代理被反問：不問人、系統回絕，不拋錯；根代理照常收工', async () => {
    const r = await rig([
      {
        content: '委派',
        toolCalls: [
          {
            name: 'task',
            args: { description: '去問', subagent_type: GENERAL_PURPOSE_SUBAGENT.name },
          },
        ],
      },
      ASK('ask_form'),
      { content: '子收工' },
      { content: '根收工' },
    ]);
    await r.pump.submit({ kind: 'message', text: '開工' });
    await r.pump.whenIdle();

    expect(r.frames.filter((f) => f.method === 'input.requested')).toEqual([]);
    expect(r.pump.pendings).toHaveLength(0);
    // 同一顆中斷被看到兩次（子代理層與 root 層），只記一顆 raised、只代答一次。
    expect(dataOf(r, 'interrupt/raised')).toHaveLength(1);
    expect(dataOf(r, 'interrupt/system-answered')).toMatchObject([
      { reason: 'subagent', keys: ['profile'] },
    ]);
    expect(typesOf(r)).not.toContain('turn/failed');
    expect(r.warnings.join('\n')).toContain('子代理');
  }, 60_000);
});
