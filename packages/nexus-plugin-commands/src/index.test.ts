/**
 * 解析與執行。**斷言的是日誌裡留下什麼**——那份日誌是配對不變量唯一看得到的東西，
 * 所以「有沒有記」跟「回了什麼」一樣重要。
 *
 * 對應 [#118](https://github.com/DemianLi/nexus-agent/issues/118)。
 */

import { describe, expect, it, vi } from 'vitest';
import { SessionLog, createRegistry } from '@nexus/core';
import type { AttachmentRef, CommandDefinition, PluginOrigin, SessionEvent } from '@nexus/core';
import { CommandAttachmentRejected, createCommandExecutor, parseCommand } from './index.js';
import type { CommandAttachmentSubmission } from './index.js';

const origin: PluginOrigin = { id: 'alpha#0', name: 'alpha' };

/** 一份只有這幾個命令的註冊表視圖。 */
function commandsOf(...definitions: CommandDefinition[]) {
  const registry = createRegistry();
  const leave = registry.enter(origin);
  for (const definition of definitions) registry.commands.register(definition);
  leave();
  return registry.commands;
}

/** 日誌 ＋ 一個現成的執行器。 */
function harness(...definitions: CommandDefinition[]) {
  return harnessWith({}, ...definitions);
}

/** 同上，另外可以給執行器選項（`acceptSteer`）。 */
function harnessWith(
  extra: { acceptSteer?: (text: string) => void },
  ...definitions: CommandDefinition[]
) {
  const sessionLog = new SessionLog('t');
  const events: SessionEvent[] = [];
  sessionLog.subscribe((event) => events.push(event));
  const onWarn = vi.fn();
  const executor = createCommandExecutor({
    commands: commandsOf(...definitions),
    sessionLog,
    onWarn,
    ...extra,
  });
  return { executor, events, onWarn, sessionLog, signal: new AbortController().signal };
}

function ok(name: string, handler: CommandDefinition['handler']): CommandDefinition {
  return { name, description: `${name} 做的事`, handler };
}

describe('parseCommand', () => {
  it('只有命令名時 rawInput 是空字串', () => {
    expect(parseCommand('/plan')).toEqual({ name: 'plan', rawInput: '' });
  });

  it('rawInput 含分隔的空白，不做 trim——要不要 trim 是 handler 的文法決定的', () => {
    expect(parseCommand('/plan  off ')).toEqual({ name: 'plan', rawInput: '  off ' });
  });

  // 這一條**不是 lookahead 的守衛**：拿掉 lookahead 它照綠（2026-10-11 實測）。它只是把「名字吃到底」這個性質說出來。
  // lookahead 的守衛是下面「解析不出命令」那組的路徑、標點與大寫四行（拿掉之後四行都紅）。
  it('名字整個吃到底：`/planning` 的名字是 `planning`，不會被截成較短的 `/plan`', () => {
    expect(parseCommand('/planning')).toEqual({ name: 'planning', rawInput: '' });
  });

  it('tab 與換行也算分隔', () => {
    expect(parseCommand('/plan\toff')).toEqual({ name: 'plan', rawInput: '\toff' });
    expect(parseCommand('/plan\noff')).toEqual({ name: 'plan', rawInput: '\noff' });
  });

  it.each([
    ['沒有斜線', 'plan'],
    ['斜線前有空白', ' /plan'],
    ['大寫', '/Plan'],
    ['數字開頭', '/1plan'],
    ['只有一條斜線', '/'],
    ['路徑不是命令', '/usr/bin/env'],
    ['名字後緊接標點', '/plan.md'],
    ['名字後緊接冒號', '/plan:off'],
    ['名字後緊接大寫', '/planOff'],
  ])('%s 解析不出命令', (_label, line) => {
    expect(parseCommand(line)).toBeUndefined();
  });

  it('連字號與底線在名字裡是合法的', () => {
    expect(parseCommand('/plan-mode')?.name).toBe('plan-mode');
    expect(parseCommand('/plan_mode')?.name).toBe('plan_mode');
  });
});

describe('收不下的行不留痕跡', () => {
  it('不是命令的行回 undefined，日誌零筆', async () => {
    const { executor, events, signal } = harness(ok('plan', () => ({ kind: 'success' })));
    await expect(executor.execute('說點什麼', signal)).resolves.toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it('**名字不認得也回 undefined，日誌一樣零筆**——它從來沒進過 handler', async () => {
    const { executor, events, signal } = harness(ok('plan', () => ({ kind: 'success' })));
    await expect(executor.execute('/nope 隨便', signal)).resolves.toBeUndefined();
    expect(events).toHaveLength(0);
  });
});

describe('認得的命令：一對事件', () => {
  it('run 在前 done 在後，args 是原文', async () => {
    const { executor, events, signal } = harness(
      ok('plan', () => ({ kind: 'success', text: '關掉了' })),
    );
    const execution = await executor.execute('/plan off', signal);

    expect(execution?.result).toEqual({ kind: 'success', text: '關掉了' });
    expect(events.map((event) => event.type)).toEqual(['command/run', 'command/done']);
    expect(events[0]?.data).toEqual({
      commandId: execution?.commandId,
      name: 'plan',
      args: ' off',
      source: { kind: 'user' },
    });
    expect(events[1]?.data).toEqual({
      commandId: execution?.commandId,
      kind: 'success',
      text: '關掉了',
    });
  });

  it('handler 收得到 rawInput 與配對 id', async () => {
    const seen: unknown[] = [];
    const { executor, signal } = harness(
      ok('plan', (invocation) => {
        seen.push({ commandId: invocation.commandId, rawInput: invocation.rawInput });
        return { kind: 'success' };
      }),
    );
    const execution = await executor.execute('/plan  兩個空白', signal);
    expect(seen).toEqual([{ commandId: execution?.commandId, rawInput: '  兩個空白' }]);
  });

  it('handler 收到的 sessionLog 就是建執行器時給的那一份（#688）', async () => {
    const seen: unknown[] = [];
    const { executor, sessionLog, signal } = harness(
      ok('plan', (invocation) => {
        seen.push(invocation.sessionLog);
        return { kind: 'success' };
      }),
    );
    await executor.execute('/plan', signal);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(sessionLog);
  });

  it('**沒話說的成功不放 text 這個 key**——放 `undefined` 會讓 append 當場拋', async () => {
    const { executor, events, signal } = harness(ok('plan', () => ({ kind: 'success' })));
    await executor.execute('/plan', signal);
    expect(events[1]?.data).not.toHaveProperty('text');
  });

  it('async handler 等得到', async () => {
    const { executor, signal } = harness(
      ok('plan', async () => Promise.resolve({ kind: 'success' as const, text: '好了' })),
    );
    await expect(executor.execute('/plan', signal)).resolves.toMatchObject({
      result: { text: '好了' },
    });
  });

  it('配對 id 在同一個執行器裡不重複', async () => {
    const { executor, signal } = harness(ok('plan', () => ({ kind: 'success' })));
    const first = await executor.execute('/plan', signal);
    const second = await executor.execute('/plan', signal);
    expect(first?.commandId).not.toBe(second?.commandId);
  });
});

describe('失敗路徑也要落定', () => {
  it('handler 拋錯：往外拋，但日誌裡已經是 kind error', async () => {
    const { executor, events, signal } = harness(
      ok('plan', () => {
        throw new Error('handler 壞了');
      }),
    );
    await expect(executor.execute('/plan', signal)).rejects.toThrow('handler 壞了');
    expect(events.map((event) => event.type)).toEqual(['command/run', 'command/done']);
    expect(events[1]?.data).toMatchObject({ kind: 'error', text: 'handler 壞了' });
  });

  it('handler 回了不是 CommandResult 的東西：當場拋，日誌落成 error', async () => {
    const { executor, events, signal } = harness(
      ok('plan', () => '一個字串' as unknown as { kind: 'success' }),
    );
    await expect(executor.execute('/plan', signal)).rejects.toThrow(/CommandResult/);
    expect(events[1]?.data).toMatchObject({ kind: 'error' });
  });

  it('error 的 text 是空字串也不收——報錯不說原因等於沒報', async () => {
    const { executor, signal } = harness(ok('plan', () => ({ kind: 'error', text: '   ' })));
    await expect(executor.execute('/plan', signal)).rejects.toThrow(/非空字串/);
  });

  it('**已經中止就不開一次執行**——日誌零筆，不會留下一對描述沒發生過的事的記錄', async () => {
    const { executor, events } = harness(ok('plan', () => ({ kind: 'success' })));
    const controller = new AbortController();
    controller.abort(new Error('使用者取消'));
    await expect(executor.execute('/plan', controller.signal)).rejects.toThrow('使用者取消');
    expect(events).toHaveLength(0);
  });

  it('執行到一半被中止：不等 handler，日誌落成 error', async () => {
    const controller = new AbortController();
    const { executor, events } = harness(
      ok('plan', async () => {
        controller.abort(new Error('中途取消'));
        // 這個 handler 不理會 signal，永遠不 resolve——`withAbort` 就是為它存在的。
        return new Promise<{ kind: 'success' }>(() => {});
      }),
    );
    await expect(executor.execute('/plan', controller.signal)).rejects.toThrow('中途取消');
    expect(events[1]?.data).toMatchObject({ kind: 'error', text: '中途取消' });
  });

  it('**落定本身又失敗時圍堵，並且講出來**——handler 原本的錯誤不能被寫日誌的錯誤蓋掉', async () => {
    const onWarn = vi.fn();
    const brokenLog = {
      append(type: string) {
        if (type === 'command/done') throw new Error('日誌滿了');
        return undefined;
      },
    };
    const executor = createCommandExecutor({
      commands: commandsOf(
        ok('plan', () => {
          throw new Error('handler 壞了');
        }),
      ),
      sessionLog: brokenLog as unknown as SessionLog,
      onWarn,
    });
    await expect(executor.execute('/plan', new AbortController().signal)).rejects.toThrow(
      'handler 壞了',
    );
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('日誌滿了'));
  });
});

/**
 * `steer`（[#776](https://github.com/DemianLi/nexus-agent/issues/776)）：命令請宿主在落定後送一句話。
 * **走真的執行器**——結果正規化只複製 `kind` 與 `text`，用替身會看不到新欄位被丟掉。
 */
describe('steer', () => {
  it('依呼叫順序交給宿主，而且日誌上一個字都不多', async () => {
    const { executor, events, signal } = harness(
      ok('plan', ({ steer }) => {
        steer('第一句');
        steer('第二句');
        return { kind: 'success', text: '好' };
      }),
    );

    const execution = await executor.execute('/plan', signal);
    expect(execution?.steers).toEqual([{ text: '第一句' }, { text: '第二句' }]);
    expect(events.map((event) => event.type)).toEqual(['command/run', 'command/done']);
    expect(events[1]?.data).toEqual({
      commandId: execution?.commandId,
      kind: 'success',
      text: '好',
    });
  });

  it('沒呼叫就是空的', async () => {
    const { executor, signal } = harness(ok('plan', () => ({ kind: 'success' })));
    expect((await executor.execute('/plan', signal))?.steers).toEqual([]);
  });

  it('命令回 error：已經收下的話一起作廢', async () => {
    const { executor, signal } = harness(
      ok('plan', ({ steer }) => {
        steer('不該送');
        return { kind: 'error', text: '沒成' };
      }),
    );
    expect((await executor.execute('/plan', signal))?.steers).toEqual([]);
  });

  /** 宿主拒收的例外從 `steer` 冒出去，命令照拋錯的路徑落定成 error，什麼都沒送。 */
  it('宿主拒收：例外冒出 handler，command/done 是 error', async () => {
    const { executor, events, signal } = harnessWith(
      {
        acceptSteer: () => {
          throw new Error('這句話不收');
        },
      },
      ok('plan', ({ steer }) => {
        steer('幫我');
        return { kind: 'success' };
      }),
    );

    await expect(executor.execute('/plan', signal)).rejects.toThrow('這句話不收');
    expect(events[1]?.data).toMatchObject({ kind: 'error', text: '這句話不收' });
  });

  it('acceptSteer 看到的是命令給的原文', async () => {
    const seen: string[] = [];
    const { executor, signal } = harnessWith(
      { acceptSteer: (text) => void seen.push(text) },
      ok('plan', ({ steer }) => {
        steer('幫我 @x');
        return { kind: 'success' };
      }),
    );
    await executor.execute('/plan', signal);
    expect(seen).toEqual(['幫我 @x']);
  });

  it('空字串不收', async () => {
    const { executor, events, signal } = harness(
      ok('plan', ({ steer }) => {
        steer('  ');
        return { kind: 'success' };
      }),
    );
    await expect(executor.execute('/plan', signal)).rejects.toThrow('非空字串');
    expect(events[1]?.data).toMatchObject({ kind: 'error' });
  });

  /** 命令結束後才叫：宿主已經不看了，靜靜丟掉比拋錯更糟。 */
  it('命令結束之後再叫會拋', async () => {
    let late: (() => void) | undefined;
    const { executor, signal } = harness(
      ok('plan', ({ steer }) => {
        late = () => steer('太晚了');
        return { kind: 'success' };
      }),
    );
    await executor.execute('/plan', signal);
    expect(() => late?.()).toThrow('已經結束');
  });
});

/**
 * 附件（[#732](https://github.com/DemianLi/nexus-agent/issues/732)）。**斷言的是順序與沒被碰的東西**：沒宣告的命令，收下（`admit`）
 * 一次都不該被呼叫；error 要把收據放回去；`steer` 只能帶這次收下的。
 */
describe('附件', () => {
  const sha = (c: string) => `sha256:${c.repeat(64)}`;
  const image: AttachmentRef = {
    type: 'image',
    attachmentId: sha('a'),
    mediaType: 'image/png',
    bytes: 3,
    width: 1,
    height: 1,
  };
  const file: AttachmentRef = { type: 'file', attachmentId: sha('b'), name: 'a.txt', bytes: 1 };

  /** 一個假的收下：記錄呼叫與放回。 */
  function submission(attachments: readonly AttachmentRef[] = [image, file]) {
    const calls = { admit: 0, rollback: 0 };
    const value: CommandAttachmentSubmission = {
      admit: async () => {
        calls.admit += 1;
        return {
          attachments,
          rollback: () => {
            calls.rollback += 1;
          },
        };
      },
    };
    return { value, calls };
  }
  const accepting = (handler: CommandDefinition['handler']): CommandDefinition => ({
    name: 'goal',
    description: '目標',
    input: { hint: '[<目標>]', attachments: true },
    handler,
  });

  it('宣告收附件：handler 收到收下之後的參照（照選取順序、凍過），成功時不放回', async () => {
    let seen: readonly AttachmentRef[] | undefined;
    const { executor, signal } = harness(
      accepting((invocation) => {
        seen = invocation.attachments;
        return { kind: 'success' };
      }),
    );
    const { value, calls } = submission();
    const execution = await executor.execute('/goal 目標', signal, value);
    expect(execution?.result).toEqual({ kind: 'success' });
    expect(seen).toEqual([image, file]);
    expect(Object.isFrozen(seen)).toBe(true);
    expect(calls).toEqual({ admit: 1, rollback: 0 });
  });

  it('沒帶附件：handler 收到空陣列', async () => {
    let seen: readonly AttachmentRef[] | undefined;
    const { executor, signal } = harness(
      accepting((invocation) => {
        seen = invocation.attachments;
        return { kind: 'success' };
      }),
    );
    await executor.execute('/goal 目標', signal);
    expect(seen).toEqual([]);
  });

  it('**沒宣告的命令**：在收下與 handler 之前落定成 error，日誌有一對，沒有任何東西被收', async () => {
    const handler = vi.fn(() => ({ kind: 'success' as const }));
    const { executor, events, signal } = harness(ok('plan', handler));
    const { value, calls } = submission();
    const execution = await executor.execute('/plan x', signal, value);
    expect(execution?.result).toEqual({ kind: 'error', text: '命令 "/plan" 不收附件。' });
    expect(handler).not.toHaveBeenCalled();
    expect(calls).toEqual({ admit: 0, rollback: 0 });
    expect(events.map((event) => event.type)).toEqual(['command/run', 'command/done']);
    expect(events[1]?.data).toMatchObject({ kind: 'error', text: '命令 "/plan" 不收附件。' });
  });

  it('宣告 attachments:false 等於沒宣告', async () => {
    const { executor, signal } = harness({
      name: 'x',
      description: 'x',
      input: { hint: 'h', attachments: false },
      handler: () => ({ kind: 'success' }),
    });
    const { value, calls } = submission();
    const execution = await executor.execute('/x', signal, value);
    expect(execution?.result.kind).toBe('error');
    expect(calls.admit).toBe(0);
  });

  it('宿主拒收（CommandAttachmentRejected）：訊息就是結果文字，handler 沒跑，不往外拋', async () => {
    const handler = vi.fn(() => ({ kind: 'success' as const }));
    const { executor, events, signal } = harness(accepting(handler));
    const value: CommandAttachmentSubmission = {
      admit: async () => {
        throw new CommandAttachmentRejected('目前的模型不收圖片');
      },
    };
    const execution = await executor.execute('/goal x', signal, value);
    expect(execution?.result).toEqual({ kind: 'error', text: '目前的模型不收圖片' });
    expect(handler).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual(['command/run', 'command/done']);
  });

  it('收下時的別種錯誤：落定成 error 之後往外拋', async () => {
    const { executor, events, signal } = harness(accepting(() => ({ kind: 'success' })));
    const value: CommandAttachmentSubmission = {
      admit: async () => {
        throw new Error('磁碟壞了');
      },
    };
    await expect(executor.execute('/goal x', signal, value)).rejects.toThrow('磁碟壞了');
    expect(events[1]?.data).toMatchObject({ kind: 'error', text: '磁碟壞了' });
  });

  it('**命令回 error 或拋錯：收據放回去**（輸入框留著草稿與附件）', async () => {
    const erroring = harness(accepting(() => ({ kind: 'error', text: '不成立' })));
    const a = submission();
    await erroring.executor.execute('/goal x', erroring.signal, a.value);
    expect(a.calls).toEqual({ admit: 1, rollback: 1 });

    const throwing = harness(
      accepting(() => {
        throw new Error('炸了');
      }),
    );
    const b = submission();
    await expect(throwing.executor.execute('/goal x', throwing.signal, b.value)).rejects.toThrow(
      '炸了',
    );
    expect(b.calls).toEqual({ admit: 1, rollback: 1 });
  });

  it('steer 帶附件：交給宿主的是 { text, attachments }；空陣列等於沒帶；error 時作廢', async () => {
    const { executor, signal } = harness(
      accepting(({ steer, attachments }) => {
        steer('帶圖', attachments);
        steer('不帶', []);
        return { kind: 'success' };
      }),
    );
    const execution = await executor.execute('/goal x', signal, submission().value);
    expect(execution?.steers).toEqual([
      { text: '帶圖', attachments: [image, file] },
      { text: '不帶' },
    ]);
  });

  it('**steer 只能帶這次收下的附件**：憑空造的參照與形狀壞的都拋，目標命令落定成 error', async () => {
    const forged: AttachmentRef = { ...file, attachmentId: sha('c') };
    const { executor, events, signal } = harness(
      accepting(({ steer }) => {
        steer('偷渡', [forged]);
        return { kind: 'success' };
      }),
    );
    await expect(executor.execute('/goal x', signal, submission().value)).rejects.toThrow(
      '只能帶這次呼叫收下的附件',
    );
    expect(events[1]?.data).toMatchObject({ kind: 'error' });
  });

  it('沒帶附件的呼叫 steer 帶附件：一樣拋（沒有收下的東西可以帶）', async () => {
    const { executor, signal } = harness(
      accepting(({ steer }) => {
        steer('x', [image]);
        return { kind: 'success' };
      }),
    );
    await expect(executor.execute('/goal x', signal)).rejects.toThrow('只能帶這次呼叫收下的附件');
  });

  it('發派的請求在收下期間中止：往外拋，晚到的收下結果把收據放回去', async () => {
    const controller = new AbortController();
    const { executor } = harness(accepting(() => ({ kind: 'success' })));
    let resolveAdmit: (() => void) | undefined;
    const calls = { rollback: 0 };
    const value: CommandAttachmentSubmission = {
      admit: () =>
        new Promise((resolve) => {
          resolveAdmit = () =>
            resolve({
              attachments: [image],
              rollback: () => {
                calls.rollback += 1;
              },
            });
        }),
    };
    const pending = executor.execute('/goal x', controller.signal, value);
    controller.abort(new Error('關掉了'));
    await expect(pending).rejects.toThrow('關掉了');
    resolveAdmit?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.rollback).toBe(1);
  });
});
