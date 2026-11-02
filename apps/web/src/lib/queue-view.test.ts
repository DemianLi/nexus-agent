// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeCommandDefinition } from '@nexus/core';
import type { CommandDefinition } from '@nexus/core';
import { parseCommand, runsWhileBusy } from '@nexus/plugin-commands';
import { SETTLE_REASONS } from '@nexus/wire';
import type { ConversationStatus, SlashDescriptor, WireQueuedInput } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import {
  canRunSlash,
  commandArm,
  commandToken,
  namesCommand,
  slashRunsWhileBusy,
  GOAL_CONTINUATION_TEXT,
  GOAL_CONTINUATION_WARNING,
  isGoalContinuation,
  isUnrecognizedSource,
  UNRECOGNIZED_SOURCE_TEXT,
  unrecognizedSourceKind,
  steerableItems,
  canSendText,
  AGENT_MESSAGE_QUEUED_TEXT,
  isAgentMessage,
  isQueueParked,
  isQueuedByAgent,
  isSettledNotice,
  queuedAgentText,
  settledNoticeText,
  QUEUE_PREVIEW_CHARS,
  queueHeading,
  queuePreview,
  SETTLED_NOTICE_TEXT,
  SETTLED_NOTICE_TIMED_OUT_TEXT,
  SETTLED_NOTICE_UNKNOWN_TEXT,
} from '@/lib/queue-view';

const STATUSES: readonly ConversationStatus[] = [
  'idle',
  'running',
  'awaiting-input',
  'stopped',
  'failed',
];

describe('isQueueParked（Q6）', () => {
  it.each(STATUSES)('%s：清單空的不算停住', (status) => {
    expect(isQueueParked(status, 0)).toBe(false);
  });

  it.each<[ConversationStatus, boolean]>([
    ['idle', true],
    ['running', false],
    ['awaiting-input', false],
    ['stopped', true],
    ['failed', true],
  ])('%s 且排著一件：%s', (status, parked) => {
    expect(isQueueParked(status, 1)).toBe(parked);
  });
});

describe('queuePreview', () => {
  it('空白攤成一格、頭尾去掉', () => {
    expect(queuePreview('  第一行\n\n\t第二行  ')).toBe('第一行 第二行');
  });

  it('上限以碼位算，不把 emoji 切半', () => {
    const exact = '字'.repeat(QUEUE_PREVIEW_CHARS);
    expect(queuePreview(exact)).toBe(exact);
    const long = '😀'.repeat(QUEUE_PREVIEW_CHARS + 1);
    expect(queuePreview(long)).toBe(`${'😀'.repeat(QUEUE_PREVIEW_CHARS)}…`);
  });
});

it('queueHeading 寫件數', () => {
  expect(queueHeading(3)).toBe('3 則排著的訊息');
});

describe('canSendText（Q2）', () => {
  it.each<[ConversationStatus, boolean]>([
    ['idle', true],
    ['running', true],
    ['awaiting-input', false],
    ['stopped', true],
    ['failed', true],
  ])('%s：%s', (status, allowed) => {
    expect(canSendText(true, status, '一句話')).toBe(allowed);
  });

  it('斷線或空白送不出去', () => {
    expect(canSendText(false, 'idle', '一句話')).toBe(false);
    expect(canSendText(true, 'idle', '   ')).toBe(false);
  });

  it('有附件時空白文字也放行（文字或附件至少一個）；斷線與停在核准點照擋', () => {
    expect(canSendText(true, 'idle', '', true)).toBe(true);
    expect(canSendText(true, 'running', '   ', true)).toBe(true);
    expect(canSendText(false, 'idle', '', true)).toBe(false);
    expect(canSendText(true, 'awaiting-input', '', true)).toBe(false);
    expect(canSendText(true, 'idle', '', false)).toBe(false);
  });
});

describe('canRunSlash', () => {
  it.each<[ConversationStatus, boolean]>([
    ['idle', true],
    ['running', false],
    ['awaiting-input', false],
    ['stopped', true],
    ['failed', true],
  ])('%s：/plan %s', (status, allowed) => {
    expect(canRunSlash(true, status, '/plan', '/feedback', [])).toBe(allowed);
  });

  it.each(STATUSES)('%s：/feedback 照樣放行', (status) => {
    expect(canRunSlash(true, status, ' /feedback ', '/feedback', [])).toBe(true);
  });

  it('斷線送不出去', () => {
    expect(canRunSlash(false, 'idle', '/plan', '/feedback', [])).toBe(false);
  });

  it.each<ConversationStatus>(['idle', 'running', 'awaiting-input'])(
    '%s：命令宣告過的 /goal pause 放行（#1517），/goal <目標> 與 /plan 跑著時照舊擋',
    (status) => {
      const busy = status !== 'idle';
      expect(canRunSlash(true, status, '/goal pause', '/feedback', COMMANDS)).toBe(true);
      expect(canRunSlash(true, status, ' /goal pause ', '/feedback', COMMANDS)).toBe(true);
      expect(canRunSlash(true, status, '/goal 把登入改好', '/feedback', COMMANDS)).toBe(!busy);
      expect(canRunSlash(true, status, '/plan', '/feedback', COMMANDS)).toBe(!busy);
    },
  );

  it('清單還沒到（空的）時跑著照舊擋：不知道的就不放行，跟伺服器一樣', () => {
    expect(canRunSlash(true, 'running', '/goal pause', '/feedback', [])).toBe(false);
  });
});

/** 照伺服器的寫法登記命令：同一份定義產生閘門查的 definition 與 `slash.list` 送的 descriptor。 */
function command(name: string, runWhileBusy?: readonly string[], input = true) {
  const definition: CommandDefinition = {
    name,
    description: `${name} 的說明`,
    ...(input ? { input: { hint: '<參數>' } } : {}),
    ...(runWhileBusy === undefined ? {} : { runWhileBusy }),
    handler: () => ({ kind: 'success' }),
  };
  return normalizeCommandDefinition(definition);
}
// 出貨的命令都宣告了 `input`（`/goal`、`/plan` 收參數）；`compact` 是沒宣告的 bare 命令（#1971），只有第三方會登記這種。
const REGISTERED = [
  command('goal', ['pause']),
  command('plan'),
  command('demo', ['a b', 'stop']),
  command('compact', undefined, false),
];
const COMMANDS: readonly SlashDescriptor[] = REGISTERED.map((r) => r.descriptor);
const FIND = {
  find: (name: string) => REGISTERED.find((r) => r.definition.name === name)?.definition,
};

describe('commandToken 跟伺服器的 parseCommand 同一套（#1929）', () => {
  // 拿 `@nexus/plugin-commands` 真的 `parseCommand` 對照同一批輸入：認命令的文法在 web 分岔了就紅。
  it.each([
    '/plan',
    ' /plan ',
    '/plan off',
    '/plan\toff',
    '/plan\noff',
    '/plan\u3000off',
    '/plan\u3000',
    '/planning',
    '/Plan',
    '/plan-b',
    '/plan_b',
    '/9plan',
    '/計劃',
    '/plan/off',
    '/usr/bin 是什麼',
    '/',
    '',
    'plan',
    '說 /plan',
  ])('%j', (line) => {
    expect(commandToken(line)).toBe(parseCommand(line.trim())?.name);
  });

  it('對照組裡兩種結果都有', () => {
    expect(commandToken('/plan off')).toBe('plan');
    expect(commandToken('/plan\u3000off')).toBe('plan');
    expect(commandToken('/planning')).toBe('planning');
    expect(commandToken('/計劃')).toBeUndefined();
  });
});

describe('namesCommand：開頭的字在命令清單上才是命令（#1929，Q2 (a)）', () => {
  it('清單上的名字是命令，前後空白不計', () => {
    expect(namesCommand(COMMANDS, '/plan')).toBe(true);
    expect(namesCommand(COMMANDS, ' /goal 把登入改好 ')).toBe(true);
  });

  it('清單上沒有的都不是：技能、打錯的、只差開頭的、大小寫不同、不在開頭的', () => {
    expect(namesCommand(COMMANDS, '/deploy 今天')).toBe(false);
    expect(namesCommand(COMMANDS, '/plna')).toBe(false);
    expect(namesCommand(COMMANDS, '/planning')).toBe(false);
    expect(namesCommand(COMMANDS, '/Plan')).toBe(false);
    expect(namesCommand(COMMANDS, '說 /plan')).toBe(false);
  });

  it('清單是空的：什麼都不是命令', () => {
    expect(namesCommand([], '/plan')).toBe(false);
  });

  it('沒宣告 input 的命令只有整行是 /名字 才是命令；帶了字就是一句話（#1971，dsh matchEnter `:361`）', () => {
    expect(namesCommand(COMMANDS, ' /compact ')).toBe(true);
    expect(namesCommand(COMMANDS, '/compact 留下最近三輪')).toBe(false);
  });
});

describe('commandArm：命令走哪一路（#1971，dsh matchEnter）', () => {
  it.each([
    ['/plan', 'claim'],
    ['/plan off', 'claim'],
    ['/plan\u3000off', 'claim'],
    [' /goal 把登入改好 ', 'claim'],
    ['/goal pause', 'claim'],
    ['/compact', 'detached'],
    [' /compact\t', 'detached'],
    ['/compact\u3000', 'detached'],
    ['/compact 留下最近三輪', undefined],
    ['/compact\n留下', undefined],
    ['/deploy 今天', undefined],
    ['/compacting', undefined],
    ['說 /compact', undefined],
  ] as const)('%j → %s', (line, arm) => {
    expect(commandArm(COMMANDS, line)).toBe(arm);
  });
});

describe('slashRunsWhileBusy 跟伺服器的閘門同一套（#1517）', () => {
  // 拿 `@nexus/plugin-commands` 真的 `runsWhileBusy` 對照同一批輸入：web 這一份分岔了就紅。
  it.each([
    '/goal pause',
    '/goal pause ',
    '/goal  pause',
    '/goal\tpause',
    '/goal\npause',
    '/goal\u3000pause',
    '/goal PAUSE',
    '/goal Pause',
    '/goal pause 1',
    '/goal pauses',
    '/goalpause',
    '/goal',
    '/goal ',
    '/goal edit 新的目標',
    '/plan',
    '/plan pause',
    '/feedback',
    '/demo a b',
    '/demo a  b',
    '/demo stop',
    '/Demo stop',
    '/nope pause',
    'goal pause',
    ' /goal pause',
    '/',
    '',
  ])('%j', (line) => {
    expect(slashRunsWhileBusy(COMMANDS, line)).toBe(runsWhileBusy(FIND, line));
  });

  it('對照組裡兩種結果都有，不是全部 false 碰巧一致', () => {
    expect(slashRunsWhileBusy(COMMANDS, '/goal pause')).toBe(true);
    expect(slashRunsWhileBusy(COMMANDS, '/demo a b')).toBe(true);
    expect(slashRunsWhileBusy(COMMANDS, '/goal PAUSE')).toBe(false);
  });

  it('產品碼不 import `@nexus/plugin-commands`：它只是測試用的對照，裡面有 Node 的模組', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const offenders = (readdirSync(root, { recursive: true }) as string[])
      .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file))
      .filter((file) =>
        /(?:from|import)\s*\(?\s*['"]@nexus\/plugin-commands/.test(
          readFileSync(join(root, file), 'utf8'),
        ),
      )
      .map((file) => relative(root, join(root, file)));
    expect(offenders).toEqual([]);
  });
});

describe('isSettledNotice（#851）', () => {
  const of = (source: WireQueuedInput['source']): WireQueuedInput => ({
    id: 'a',
    text: 't',
    source,
  });

  it('只有背景子代理結算的通知算；人排的不算', () => {
    expect(isSettledNotice(of({ kind: 'subagent-settled' }))).toBe(true);
    expect(isSettledNotice(of({ kind: 'user' }))).toBe(false);
  });
});

describe('不是人排的那一類（#861）', () => {
  const of = (source: WireQueuedInput['source']): WireQueuedInput => ({
    id: 'a',
    text: 't',
    source,
  });

  it('結算通知與來信各自認得，合起來是「不是人排的」；人排的都不是', () => {
    expect(isAgentMessage(of({ kind: 'agent-message' }))).toBe(true);
    expect(isAgentMessage(of({ kind: 'subagent-settled' }))).toBe(false);
    expect(isQueuedByAgent(of({ kind: 'agent-message' }))).toBe(true);
    expect(isQueuedByAgent(of({ kind: 'subagent-settled' }))).toBe(true);
    expect(isQueuedByAgent(of({ kind: 'user' }))).toBe(false);
  });

  it('佇列列上各寫各的一句，人排的沒有', () => {
    // 沒有 reason＝舊日誌：中性的一句，不是「已完成」
    expect(queuedAgentText(of({ kind: 'subagent-settled' }))).toBe(SETTLED_NOTICE_UNKNOWN_TEXT);
    expect(
      queuedAgentText(
        of({
          kind: 'subagent-settled',
          reason: 'aborted',
          cause: { kind: 'hook', reason: 'turn-timeout' },
        }),
      ),
    ).toBe(SETTLED_NOTICE_TIMED_OUT_TEXT);
    expect(queuedAgentText(of({ kind: 'subagent-settled', reason: 'aborted' }))).toBe(
      SETTLED_NOTICE_TEXT.aborted,
    );
    expect(queuedAgentText(of({ kind: 'agent-message' }))).toBe(AGENT_MESSAGE_QUEUED_TEXT);
    expect(queuedAgentText(of({ kind: 'user' }))).toBeUndefined();
  });
});

describe('settledNoticeText 分開講時間到（#1847）', () => {
  it('被停止而且時鐘到點：講超過時間上限', () => {
    expect(settledNoticeText('aborted', { kind: 'hook', reason: 'turn-timeout' })).toBe(
      SETTLED_NOTICE_TIMED_OUT_TEXT,
    );
  });

  it.each([
    [{ kind: 'user' }],
    [{ kind: 'parent' }],
    [{ kind: 'hook', reason: 'some-other-hook' }],
    [undefined],
  ] as const)('其餘的停法（%o）講被停止，不把原因字串印出來', (cause) => {
    expect(settledNoticeText('aborted', cause)).toBe(SETTLED_NOTICE_TEXT.aborted);
  });

  it('原因只在 aborted 時算數', () => {
    expect(settledNoticeText('completed', { kind: 'hook', reason: 'turn-timeout' })).toBe(
      SETTLED_NOTICE_TEXT.completed,
    );
  });
});

describe('settledNoticeText（#884）', () => {
  it('五種原因各一句，措辭釘死：不是都寫「已完成」', () => {
    expect(settledNoticeText('completed')).toBe('背景子代理已完成');
    expect(settledNoticeText('aborted')).toBe('背景子代理已被停止');
    expect(settledNoticeText('max-tokens')).toBe('背景子代理已達輸出上限，沒寫完');
    expect(settledNoticeText('error')).toBe('背景子代理失敗了');
    expect(settledNoticeText('refusal')).toBe('背景子代理沒有開工（會話已封存）');
  });

  it('wire 認得的每一種原因都有自己的一句，而且四句互不相同、都不是中性那句', () => {
    const texts = SETTLE_REASONS.map((reason) => settledNoticeText(reason));
    expect(new Set(texts).size).toBe(SETTLE_REASONS.length);
    expect(texts).not.toContain(SETTLED_NOTICE_UNKNOWN_TEXT);
  });

  it('沒有原因（格式 26 以前的舊日誌）與不認得的值：中性的「已結束」，不假裝成「已完成」', () => {
    expect(settledNoticeText(undefined)).toBe('背景子代理已結束');
    expect(settledNoticeText('exploded')).toBe('背景子代理已結束');
    expect(settledNoticeText(7)).toBe('背景子代理已結束');
    expect(SETTLED_NOTICE_UNKNOWN_TEXT).not.toBe(SETTLED_NOTICE_TEXT.completed);
  });
});

describe('目標續行的預約（#638）', () => {
  const human: WireQueuedInput = { id: 'h', text: '我說的', source: { kind: 'user' } };
  const goal: WireQueuedInput = { id: 'g', text: '給模型的續行提示詞', source: { kind: 'goal' } };

  it('只有 source.kind 是 goal 的才算；文字像不像不看', () => {
    expect(isGoalContinuation(goal)).toBe(true);
    expect(isGoalContinuation(human)).toBe(false);
    const lookalike: WireQueuedInput = { ...human, text: GOAL_CONTINUATION_TEXT };
    expect(isGoalContinuation(lookalike)).toBe(false);
  });

  it('整批插話只收人排的：目標續行濾掉，順序不變', () => {
    expect(steerableItems([human, goal, { ...human, id: 'h2' }]).map((item) => item.id)).toEqual([
      'h',
      'h2',
    ]);
    expect(steerableItems([goal])).toEqual([]);
  });

  it('措辭釘死：名字與後果各一句', () => {
    expect(GOAL_CONTINUATION_TEXT).toBe('目標續行');
    expect(GOAL_CONTINUATION_WARNING).toBe('刪除或編輯會暫停目標');
  });
});

describe('不認得來源的佇列件（#1247）', () => {
  const human: WireQueuedInput = { id: 'h', text: '我說的', source: { kind: 'user' } };
  const future: WireQueuedInput = {
    id: 'f',
    text: 'something for the model',
    source: { kind: 'unrecognized', original: 'future-kind' },
  };

  it('只有 source.kind 是 unrecognized 的才算，原種類取得出來', () => {
    expect(isUnrecognizedSource(future)).toBe(true);
    expect(isUnrecognizedSource(human)).toBe(false);
    expect(unrecognizedSourceKind(future)).toBe('future-kind');
    expect(unrecognizedSourceKind(human)).toBeUndefined();
  });

  it('整批插話只收人排的：不認得來源的也濾掉，跟目標續行並排也一樣', () => {
    const goal: WireQueuedInput = { id: 'g', text: 'x', source: { kind: 'goal' } };
    expect(steerableItems([human, future, goal]).map((item) => item.id)).toEqual(['h']);
    expect(steerableItems([future])).toEqual([]);
  });

  it('通用標籤措辭釘死，不是「目標續行」', () => {
    expect(UNRECOGNIZED_SOURCE_TEXT).toBe('系統排入的訊息');
    expect(UNRECOGNIZED_SOURCE_TEXT).not.toBe(GOAL_CONTINUATION_TEXT);
  });
});
