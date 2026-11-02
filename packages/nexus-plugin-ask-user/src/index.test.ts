/**
 * `ask_user_question` 的單元面：**送出去的酬載**與**四條出口**，加上樹上這一列的接線（#1458）。
 *
 * `interrupt()` 在這裡是替身，因為這一層要驗的是「我們交給它什麼、拿回來怎麼解」，
 * 不是 LangGraph 的暫停機制——那條走真的線的在 `apps/harness/src/ask-user-wire.test.ts`。
 *
 * **工具是從真的 Loader 掛上來的**：行程級的工具登記處與答題管道各一列（真的提供者），`ask-user` 是函式插件模組本身。
 * 這裡自己塞一個替身服務的話，`inject` 與 `apply` 當下抓管道那一段就沒有人走過。
 */

import type { StructuredToolInterface } from '@langchain/core/tools';
import { createApprovalChannelProvider } from '@nexus/approval-channel/provider';
import type { ApprovalChannel } from '@nexus/approval-channel';
import { Context } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';
import { checkConformance } from '@nexus/sdk';
import { createToolsProvider } from '@nexus/tools/provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const interrupted: unknown[] = [];
let resumeWith: unknown;

vi.mock('@langchain/langgraph', () => ({
  interrupt: (payload: unknown) => {
    interrupted.push(payload);
    return resumeWith;
  },
}));

const askUser = await import('./index.js');
const {
  ASK_USER_OUTPUT_SCHEMA,
  ASK_USER_QUESTION_TOOL_NAME,
  CANCELLED_MESSAGE,
  DELEGATED_CALLER_ERROR,
  DELEGATED_CALLER_MESSAGE,
  NO_CHANNEL_MESSAGE,
} = askUser;

let opened: Context | undefined;
afterEach(async () => {
  await opened?.fiber.dispose();
  opened = undefined;
});

/** 掛上一棵小樹：工具登記處、答題管道（`channel` 是宿主給的值，`undefined` 是沒有指定）與 `ask-user` 那一列。 */
async function mount(channel: ApprovalChannel | undefined, row = 'ask-user') {
  const tools = createToolsProvider();
  const root = new Context();
  opened = root;
  await root.plugin(Loader);
  Object.assign(root.loader.builtins, {
    tools: tools.Provider,
    'approval-channel': createApprovalChannelProvider(channel).Provider,
    'ask-user': askUser,
  });
  const create = (options: { id: string; name: string; config?: unknown }) =>
    root.loader.create(options as never, null);
  await create({ id: 'tools', name: 'cordis:tools' });
  await create({ id: 'approval-channel', name: 'cordis:approval-channel' });
  await create({ id: row, name: 'cordis:ask-user', config: {} });
  await root.loader.await();
  return { root, tools };
}

async function toolOf(
  channelKind: 'human' | 'policy-never' | 'no-channel',
): Promise<StructuredToolInterface> {
  const { tools } = await mount({ kind: channelKind });
  const entry = tools.entries().find((item) => item.tool.name === ASK_USER_QUESTION_TOOL_NAME);
  if (entry === undefined) throw new Error('工具沒有註冊上去');
  return entry.tool;
}

/**
 * 從工具回傳值取出錯誤內容，**並且斷言它真的是一則 `status: 'error'`**。
 *
 * 只比對字串的話，把 ToolMessage 換成一個普通的字串回傳照樣綠——而那個差別正是模型會
 * 不會知道這次失敗了。
 */
async function errorTextOf(result: unknown): Promise<string> {
  const message = result as { status?: string; content?: unknown };
  expect(message.status).toBe('error');
  return String(message.content);
}

const ONE_QUESTION = {
  questions: [
    {
      id: 'q1',
      question: '哪一天？',
      header: '日期',
      options: [{ label: '週一', description: '比較早' }, { label: '週二' }],
      multi_select: true,
    },
  ],
};

beforeEach(() => {
  interrupted.length = 0;
  resumeWith = { answers: [{ id: 'q1', selected: ['週一'] }] };
});

describe('送出去的酬載', () => {
  it('**帶 `kind`，而且是問答那一個**——判別式缺了，折疊器會把它當核准畫出來', async () => {
    await (await toolOf('human')).invoke(ONE_QUESTION);
    expect((interrupted[0] as { kind: string }).kind).toBe('question');
  });

  it('五個欄位照抄 dsh，`multi_select` 在裡面變成 `multiSelect`', async () => {
    await (await toolOf('human')).invoke(ONE_QUESTION);
    expect(interrupted[0]).toEqual({
      kind: 'question',
      questions: [
        {
          id: 'q1',
          question: '哪一天？',
          header: '日期',
          options: [{ label: '週一', description: '比較早' }, { label: '週二' }],
          multiSelect: true,
        },
      ],
    });
  });

  it('沒給的可選欄位不會補成 undefined 混進去', async () => {
    await (await toolOf('human')).invoke({ questions: [{ id: 'q1', question: '姓名？' }] });
    expect(interrupted[0]).toEqual({
      kind: 'question',
      questions: [{ id: 'q1', question: '姓名？' }],
    });
  });
});

describe('四條出口', () => {
  it('人答了就把答案原樣交回去——空的 `selected` 是「跳過」，不補預設值', async () => {
    resumeWith = {
      answers: [
        { id: 'q1', selected: [] },
        { id: 'q2', selected: ['甲'], custom: '乙' },
      ],
    };
    const result = await (await toolOf('human')).invoke(ONE_QUESTION);
    expect(JSON.parse(result as string)).toEqual({
      answers: [
        { id: 'q1', selected: [] },
        { id: 'q2', selected: ['甲'], custom: '乙' },
      ],
    });
    // 宣告的 schema 收得下真的輸出——寫得太嚴的話，產品路徑上每一次成功都會被換成錯誤。
    expect(ASK_USER_OUTPUT_SCHEMA.safeParse(JSON.parse(result as string)).success).toBe(true);
  });

  it('輸出 schema 與 rootOnly 隨註冊帶（#252、#324、#1458 Q3）——宿主折進組裝時一起交給註冊點', async () => {
    const { tools } = await mount({ kind: 'human' });
    const entry = tools.entries().find((item) => item.tool.name === ASK_USER_QUESTION_TOOL_NAME);
    expect(entry?.options?.outputSchema).toBe(ASK_USER_OUTPUT_SCHEMA);
    // `rootOnly` 帶自己的句與碼（照 dsh 的 `DELEGATED_CALLER`），不是 `true`。
    expect(entry?.options?.rootOnly).toEqual({
      message: DELEGATED_CALLER_MESSAGE,
      error: DELEGATED_CALLER_ERROR,
    });
    expect(entry?.source).toBe('ask-user');
  });

  it('**放棄整組是錯誤，不是一份空答案**——模型要分得出「人不走這條路」與「每題都跳過」', async () => {
    resumeWith = { cancelled: true };
    expect(await errorTextOf(await (await toolOf('human')).invoke(ONE_QUESTION))).toBe(
      `Error: ${CANCELLED_MESSAGE}`,
    );
    // 而且它真的問過了——沒問就拋的話，這條測的只是參數檢查。
    expect(interrupted).toHaveLength(1);
  });

  it('沒有人在（policy-never）時**連問都不問**，回錯誤而不是靜默通過', async () => {
    expect(await errorTextOf(await (await toolOf('policy-never')).invoke(ONE_QUESTION))).toMatch(
      /沒有人在/,
    );
    expect(interrupted).toEqual([]);
  });

  it('沒有 checkpointer 時也一樣——理由與上一條刻意不同', async () => {
    expect(await errorTextOf(await (await toolOf('no-channel')).invoke(ONE_QUESTION))).toMatch(
      /接不回來/,
    );
    expect(interrupted).toEqual([]);
  });

  it('沒人提供答題管道（宿主給 undefined）時呼叫當下拒絕，載入照常、連問都不問（#669）', async () => {
    // 不掛 host-services 的組裝：以前這裡會退成 `{ kind: 'human' }`，工具停在一個沒人接的中斷上。
    const { tools } = await mount(undefined);
    const entry = tools.entries().find((item) => item.tool.name === ASK_USER_QUESTION_TOOL_NAME);
    if (entry === undefined) throw new Error('工具沒有註冊上去');
    expect(await errorTextOf(await entry.tool.invoke(ONE_QUESTION))).toBe(
      `Error: ${NO_CHANNEL_MESSAGE}`,
    );
    expect(interrupted).toEqual([]);
  });

  it('空的問題清單當場拋，不會送出一顆沒有問題的中斷', async () => {
    expect(await errorTextOf(await (await toolOf('human')).invoke({ questions: [] }))).toMatch(
      /至少要有一題/,
    );
    expect(interrupted).toEqual([]);
  });

  it('回覆形狀看不懂時拋，不會把 undefined 當成答案交給模型', async () => {
    resumeWith = { decisions: [{ type: 'approve' }] };
    expect(await errorTextOf(await (await toolOf('human')).invoke(ONE_QUESTION))).toMatch(/看不懂/);
  });
});

describe('樹上這一列（#1458）', () => {
  it('一致性套件全格通過：manifest、匯出形式、卸載後登記處回到空的、缺提供者停在 PENDING', async () => {
    let latest = createToolsProvider();
    const failures = await checkConformance({
      row: 'ask-user',
      module: askUser,
      providers: {
        tools: () => {
          latest = createToolsProvider();
          return latest.Provider;
        },
        approvalChannel: () => createApprovalChannelProvider({ kind: 'human' }).Provider,
      },
      residue: () => latest.entries().length,
    });
    expect(failures).toEqual([]);
  });

  it('manifest 宣告兩個必要依賴：tools（^1.1.0，要帶選項）與 approvalChannel（^1.0.0）；沒有 default 匯出', () => {
    expect(askUser.manifest.consumes).toEqual([
      { token: 'tools', range: '^1.1.0' },
      { token: 'approvalChannel', range: '^1.0.0' },
    ]);
    expect(askUser.manifest.provides).toEqual([]);
    expect(askUser.inject).toEqual({
      tools: { range: '^1.1.0' },
      approvalChannel: { range: '^1.0.0' },
    });
    expect('default' in askUser).toBe(false);
  });

  it('列卸載之後，抓進閉包的答題管道仍可問：已登記的那一份工具照樣問得到（驗收 D 的單元面）', async () => {
    const { root, tools } = await mount({ kind: 'human' });
    const entry = tools.entries().find((item) => item.tool.name === ASK_USER_QUESTION_TOOL_NAME);
    if (entry === undefined) throw new Error('工具沒有註冊上去');
    // 把答題管道那一列拿掉：root 上的服務撤了，但工具在 `apply` 當下抓住的那一份還在。
    await root.loader.resolve('approval-channel').fiber?.ctx.fiber.dispose();
    expect(root.get('approvalChannel', false)).toBeUndefined();
    await entry.tool.invoke(ONE_QUESTION);
    expect(interrupted).toHaveLength(1);
  });
});
