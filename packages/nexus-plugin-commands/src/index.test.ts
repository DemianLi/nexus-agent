/**
 * 解析與執行。**斷言的是日誌裡留下什麼**——那份日誌是配對不變量唯一看得到的東西，
 * 所以「有沒有記」跟「回了什麼」一樣重要。
 *
 * 對應 [#118](https://github.com/DemianLi/nexus-agent/issues/118)。
 */

import { describe, expect, it, vi } from 'vitest';
import { SessionLog, createRegistry } from '@nexus/core';
import type { CommandDefinition, PluginOrigin, SessionEvent } from '@nexus/core';
import { createCommandExecutor, parseCommand } from './index.js';

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
  const sessionLog = new SessionLog('t');
  const events: SessionEvent[] = [];
  sessionLog.subscribe((event) => events.push(event));
  const onWarn = vi.fn();
  const executor = createCommandExecutor({
    commands: commandsOf(...definitions),
    sessionLog,
    onWarn,
  });
  return { executor, events, onWarn, signal: new AbortController().signal };
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

  it('**`/planning` 不是 `/plan`**——命令名後面要嘛是結尾、要嘛是空白', () => {
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
