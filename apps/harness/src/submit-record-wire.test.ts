/**
 * #231 的端到端驗收句：**問 → 補齊 → 核准 → 寫出 `.csv`**，走真的線、讀真的檔案。
 *
 * ## 為什麼一定要落在真實磁碟上
 *
 * 這條鏈有兩顆中斷、兩次 resume，而**線上的狀態很會假綠**：中斷本身就是一則
 * `status: 'failed'` 的 tool entry，`ToolEntry.status` 對一則錯誤的 ToolMessage 也是
 * `'done'`（見 `ask-user-wire.test.ts` 的兩段說明）。所以「有沒有寫出去」這一格不看線上
 * 的任何欄位，看 `fs.readFile`——**輪數數錯的假綠偽造不出檔案的位元組**。
 *
 * 拒絕那一側同理：檔案**不存在**才算數，而「什麼都沒發生」也長這樣，所以核准那一條就是
 * 它的對照組（#231 驗收句明著要求的那一條）。
 *
 * ## 兩種 backend 都要走一遍
 *
 * `--workspace` 給了就是真實磁碟（`ContainedFilesystemBackend`），**沒給就是
 * `StateBackend`**——而 `pnpm --filter @nexus/harness run serve` 預設就是沒給，所以那條
 * 是 web 那一側的常態路徑。兩者的差別不在檔案落在哪，在**工具要回什麼**：checkpoint
 * backend 的寫入靠 `write()` 回的那份 `filesUpdate` 進 state 才算數，所以工具得回一個
 * `Command`。漏掉那一支的樣子是「工具說寫好了、下一輪 `read_file` 讀不到」——**磁碟那一組
 * 測試對它一句話都不會說**。
 *
 * ## 這裡也是「閘門只認 submit_record」的正面
 *
 * 同一次組裝裡 `ask_user_question` 也經過同一個 `wrapToolCall` 閘門。它折出來的是一顆
 * **問答**而不是核准卡——那就是「別的工具走到鏈底 `allow`」的現場證據。最後那一組還多
 * 一個：基座自己的 `read_file` 在同一次組裝裡跑完，**一張卡都沒出現**。單元測試那側
 * （`@nexus/plugin-submit-record`）另有一條直接對 `runApprovalGate` 的否定面。
 */

import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemorySaver } from '@langchain/langgraph';
import { createAskUserPlugin, ASK_USER_QUESTION_TOOL_NAME } from '@nexus/plugin-ask-user';
import { createSubmitRecordPlugin, SUBMIT_RECORD_TOOL_NAME } from '@nexus/plugin-submit-record';
import type { ConversationState, Event, WireClient } from '@nexus/wire';
import {
  answerResponse,
  appendAnswers,
  appendDecision,
  appendHumanTurn,
  createWireClient,
  emptyConversation,
  isApprovalPending,
  isQuestionPending,
  reduceConversation,
  uniformDecisions,
} from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { emptyCommandPoint } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const BASE_URL = 'http://record.test';
const CSV_PATH = '/visitors.csv';
const QUESTIONS = [
  { id: 'name', question: '訪客姓名？', header: '姓名' },
  { id: 'day', question: '哪一天？', options: [{ label: '週一' }, { label: '週二' }] },
];
const RECORD = { 姓名: '阿明', 日期: '週二' };

const workspaces: string[] = [];

afterEach(() => {
  for (const root of workspaces.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Session {
  readonly client: WireClient;
  readonly events: AsyncGenerator<Event, void, undefined>;
  readonly threadId: string;
  /** 真實磁碟上的可寫根。驗收就讀這底下的檔案。 */
  readonly root: string;
  state: ConversationState;
  close(): Promise<void>;
}

/** 前兩輪對兩種 backend 都一樣：先問，再送出。 */
const ASK_THEN_SUBMIT = [
  {
    content: '缺兩格，我先問。',
    toolCalls: [{ name: ASK_USER_QUESTION_TOOL_NAME, args: { questions: QUESTIONS } }],
  },
  {
    content: '湊齊了，送出去。',
    toolCalls: [{ name: SUBMIT_RECORD_TOOL_NAME, args: { file_path: CSV_PATH, record: RECORD } }],
  },
];

/**
 * 接一條真的線。
 *
 * @param threadId - thread。
 * @param backend - 組裝點給的 backend。**`undefined` 就是沒給 `--workspace`**（基座的
 *   `StateBackend`），那條是 `serve` 的預設。
 * @param turns - 腳本模型這一次的輪。
 */
async function connect(
  threadId: string,
  backend: ContainedFilesystemBackend | undefined,
  turns: readonly { content: string; toolCalls?: { name: string; args: unknown }[] }[],
): Promise<Omit<Session, 'root'>> {
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns: turns as never }),
    checkpointer: new MemorySaver(),
    ...(backend !== undefined && { backend }),
    // **backend 給同一個物件**，就像 `cli.ts` 那樣。給兩個的失敗方式是兩個工具寫到兩個
    // 地方，而兩邊都會寫成功——所以這裡同時也在示範正確的接法。
    plugins: [
      createAskUserPlugin(),
      createSubmitRecordPlugin({ ...(backend !== undefined && { backend }) }),
    ],
  });
  const handler = createWireHandler({
    createAgent: async () => ({
      agent: built.agent as unknown as PumpAgent,
      commands: emptyCommandPoint(),
      dispose: built.dispose,
    }),
  });
  const client = createWireClient({
    baseUrl: BASE_URL,
    fetch: async (input, init) => handler.handle(new Request(input as string, init)),
  });
  const events = await client.openEvents(threadId);
  await client.runStart(threadId, '幫我登記一位訪客');
  return {
    client,
    events,
    threadId,
    state: appendHumanTurn(emptyConversation(), '幫我登記一位訪客'),
    close: () => handler.close(),
  };
}

/** 真實磁碟那一組：`--workspace` 指向一個 tmpdir。 */
async function open(threadId: string): Promise<Session> {
  const root = mkdtempSync(join(tmpdir(), 'nexus-record-'));
  workspaces.push(root);
  const backend = new ContainedFilesystemBackend({ rootDir: root });
  const session = await connect(threadId, backend, [...ASK_THEN_SUBMIT, { content: '收工。' }]);
  return { ...session, root };
}

async function until(
  session: Omit<Session, 'root'>,
  done: (session: Omit<Session, 'root'>) => boolean,
): Promise<void> {
  while (!done(session)) {
    const next = await session.events.next();
    if (next.done === true) break;
    session.state = reduceConversation(session.state, next.value);
  }
}

/**
 * 這條鏈真的走完了。
 *
 * **數的是模型講完幾輪話，不是 `status`**：中斷那一輪的 `lifecycle completed` 照樣會發，
 * 而這一條鏈停兩次，所以「idle」在三個不同的時刻都成立。腳本裡有三輪，走完就是三輪。
 */
function settledAfter(turns: number) {
  return (session: Pick<Session, 'state'>): boolean =>
    session.state.status === 'idle' &&
    session.state.entries.filter((entry) => entry.kind === 'ai' && !entry.streaming).length >=
      turns;
}

/** 磁碟那一組的腳本有三輪。 */
const settled = settledAfter(3);

/** 走到「答完問題、核准卡掛出來」那一刻。 */
async function untilApproval(session: Omit<Session, 'root'>) {
  await until(session, (s) => s.state.status === 'awaiting-input');
  const question = session.state.pendings[0];
  if (question === undefined || !isQuestionPending(question)) {
    throw new Error(`第一顆該是問答，實際是：${JSON.stringify(question)}`);
  }

  const answers = [
    { id: 'name', selected: [], custom: '阿明' },
    { id: 'day', selected: ['週二'] },
  ];
  session.state = appendAnswers(session.state, question.interruptId, answers);
  await session.client.inputRespond(session.threadId, {
    namespace: [...question.namespace],
    interrupt_id: question.interruptId,
    response: answerResponse(answers),
  });

  await until(
    session,
    (s) => s.state.status === 'awaiting-input' && s.state.pendings.some(isApprovalPending),
  );
  const approval = session.state.pendings.find(isApprovalPending);
  if (approval === undefined) throw new Error('第二顆核准卡沒有掛出來');
  return approval;
}

describe('問 → 補齊 → 核准 → 寫出 .csv', () => {
  it('**核准之後檔案真的在磁碟上，內容對得起來**', async () => {
    const session = await open('r1');
    const approval = await untilApproval(session);

    session.state = appendDecision(session.state, approval.interruptId, 'approve');
    await session.client.inputRespond('r1', {
      namespace: [...approval.namespace],
      interrupt_id: approval.interruptId,
      response: uniformDecisions(approval, 'approve'),
    });
    await until(session, settled);

    // **這一格是驗收句本身。** 讀的是真實磁碟，不是線上的任何欄位。
    expect(readFileSync(join(session.root, 'visitors.csv'), 'utf8')).toBe('姓名,日期\n阿明,週二\n');
    expect(session.state.pendings).toEqual([]);
    await session.close();
  });

  it('**核准卡顯示的是填好的欄位，不是一坨 CSV 字串**', async () => {
    // #231 第 5 項「送出自成一個工具」的三個理由之一。沒有這一條，那個理由就只是散文。
    const session = await open('r2');
    const approval = await untilApproval(session);

    expect(approval.actions).toHaveLength(1);
    const action = approval.actions[0];
    expect(action?.name).toBe(SUBMIT_RECORD_TOOL_NAME);
    expect(action?.args).toEqual({ file_path: CSV_PATH, record: RECORD });
    await session.close();
  });

  it('**拒絕之後檔案不存在**——而上面那條就是它的對照組', async () => {
    const session = await open('r3');
    const approval = await untilApproval(session);

    session.state = appendDecision(session.state, approval.interruptId, 'reject');
    await session.client.inputRespond('r3', {
      namespace: [...approval.namespace],
      interrupt_id: approval.interruptId,
      response: uniformDecisions(approval, 'reject'),
    });
    await until(session, settled);

    expect(existsSync(join(session.root, 'visitors.csv'))).toBe(false);
    await session.close();
  });
});

describe('基座在這條路上的一個不對稱', () => {
  it('**`readRaw` 對不存在的檔案是拋，`read` 是回 error**——工具那側的 try/catch 就是為它', async () => {
    // 這一條是**特徵化測試**：它釘的是 `deepagents@1.13.1` 的行為，不是我們的決定。
    // 少了 try/catch 的樣子不是「回一則錯誤」，是**整場 run 從 stream mux 死掉**——
    // 第一次寫這條路時就是這樣紅的，而檔案一個字都沒寫、線上什麼都沒說。
    //
    // 哪天基座把 `readRaw` 改成回結構化錯誤，這一條會紅。那時候該做的是**確認**工具那側
    // 的 try/catch 變成多餘（然後決定留不留），不是反過來把它拿掉——兩種回法都要接住，
    // 是因為 `submit_record` 收的是組裝點給的任何一種 backend。
    const root = mkdtempSync(join(tmpdir(), 'nexus-record-'));
    workspaces.push(root);
    const backend = new ContainedFilesystemBackend({ rootDir: root });

    await expect(backend.readRaw('/nope.csv')).rejects.toThrow('ENOENT');
    expect(await backend.read('/nope.csv')).toMatchObject({
      error: expect.stringContaining('ENOENT'),
    });
  });
});

describe('沒有 --workspace 的那條路（`serve` 的預設）', () => {
  it('**寫進去的東西下一輪讀得回來**——`filesUpdate` 沒包成 `Command` 的話這裡是空的', async () => {
    // 這一組不給 backend，走基座的 `StateBackend`。驗收不能讀磁碟（本來就沒有檔案），
    // 所以讓模型下一輪用基座自己的 `read_file` 去讀——**讀的人與寫的人是兩個不同的
    // 工具**，中間隔著 state，漏掉 `Command` 那一支就會在這裡露出來。
    const session = await connect('r4', undefined, [
      ...ASK_THEN_SUBMIT,
      {
        content: '我再確認一次。',
        toolCalls: [{ name: 'read_file', args: { file_path: CSV_PATH } }],
      },
      { content: '收工。' },
    ]);
    const approval = await untilApproval(session);

    session.state = appendDecision(session.state, approval.interruptId, 'approve');
    await session.client.inputRespond('r4', {
      namespace: [...approval.namespace],
      interrupt_id: approval.interruptId,
      response: uniformDecisions(approval, 'approve'),
    });
    await until(session, settledAfter(4));

    const read = session.state.entries.filter(
      (entry) => entry.kind === 'tool' && entry.name === 'read_file',
    );
    expect(read).toHaveLength(1);
    // `read_file` 會在每一行前面加行號，所以比對的是「這一列在裡面」而不是整份相等。
    expect(JSON.stringify(read[0])).toContain('阿明,週二');
    await session.close();
  });
});
