/**
 * `/goal` 走**真的通道**：註冊表的 `commands` → handler → 域 → 會話日誌。
 *
 * 刻意不直接呼叫 {@link executeGoalCommand}：這張 PR 的宣稱是「人打得動目標」，而那句話
 * 裡最容易靜靜壞掉的一段，是「handler 找不找得到它要動的那一份服務」——那一段只有走
 * `registry.commands.find('goal')` 才驗得到。純文法的那幾條才直接打解析器。
 */

import { describe, expect, it } from 'vitest';

import { createRegistry, createSessionRunner, SessionLog } from '@nexus/core';
import type { CommandDefinition, CommandResult, GoalChangeMeta, PluginRegistry } from '@nexus/core';

import {
  createGoalPlugin,
  executeGoalCommand,
  GOAL_CLEARED_MESSAGE,
  GOAL_COMMAND_HINT,
  GOAL_COMMAND_NAME,
  GOAL_INVALID_EDIT_MESSAGE,
  GOAL_NONE_MESSAGE,
  GOAL_NOT_ATTACHED_MESSAGE,
  GOAL_NOTHING_TO_CLEAR_MESSAGE,
  GOAL_REJECTED_MESSAGE,
  goalAmbiguousMessage,
  goalMissingMessage,
  parseGoalCommand,
} from './index.js';
import type { GoalPluginOptions, GoalService } from './index.js';

/** 掛一次、接 `logs` 份日誌，回手上要用的每一個東西。 */
function mount(
  logs: number,
  options: GoalPluginOptions = {},
): {
  registry: PluginRegistry;
  command: CommandDefinition;
  logs: SessionLog[];
  serviceFor: (log: SessionLog) => GoalService;
  run: (rawInput: string) => CommandResult;
  detach: () => void;
} {
  const clock = 100;
  let serial = 0;
  const plugin = createGoalPlugin({
    now: () => clock,
    newGoalId: () => `goal-${(serial += 1)}`,
    ...options,
  });
  const registry = createRegistry();
  const exit = registry.enter({ id: 'goal#0', name: 'goal' });
  plugin.apply(registry);
  exit();

  const opened: SessionLog[] = [];
  const detachers: (() => void)[] = [];
  for (let index = 0; index < logs; index += 1) {
    const log = new SessionLog(`goal-${String(index)}`);
    opened.push(log);
    detachers.push(
      createSessionRunner({
        address: { kind: 'root' },
        log,
        installers: registry.sessions.installers(),
        warn: (message) => {
          throw new Error(`不該有 warn：${message}`);
        },
      }),
    );
  }

  const command = registry.commands.find(GOAL_COMMAND_NAME);
  if (command === undefined) throw new Error('apply 之後應該註冊得到 /goal');
  return {
    registry,
    command,
    logs: opened,
    serviceFor: (log) => {
      const service = plugin.serviceFor(log);
      if (service === undefined) throw new Error('接線之後應該找得到服務');
      return service;
    },
    run: (rawInput) => {
      const result = command.handler({
        commandId: 'cmd-test-1',
        rawInput,
        signal: new AbortController().signal,
      });
      if (result instanceof Promise) throw new TypeError('/goal 是同步的');
      return result;
    },
    detach: () => {
      for (const dispose of detachers.reverse()) dispose();
    },
  };
}

/** 成功結果的文字；不是 success 就當場失敗。 */
function successText(result: CommandResult): string {
  if (result.kind !== 'success') throw new Error(`預期 success，拿到 error：${result.text}`);
  return result.text ?? '';
}

/** 錯誤結果的文字；不是 error 就當場失敗。 */
function errorText(result: CommandResult): string {
  if (result.kind !== 'error') throw new Error(`預期 error，拿到 success：${result.text ?? ''}`);
  return result.text;
}

describe('文法', () => {
  it('空的是查看', () => {
    expect(parseGoalCommand('')).toEqual({ kind: 'show' });
    expect(parseGoalCommand('   ')).toEqual({ kind: 'show' });
  });

  it('控制詞填滿整串才算控制詞', () => {
    expect(parseGoalCommand('pause')).toEqual({ kind: 'pause' });
    expect(parseGoalCommand('  RESUME ')).toEqual({ kind: 'resume' });
    expect(parseGoalCommand('clear')).toEqual({ kind: 'clear' });
  });

  it('**控制詞當開頭的一句話是目標，不是控制詞**', () => {
    // 這是 dsh README 逐字點名的那個例子。守的是「人的一句話不會被吃掉一個詞」。
    expect(parseGoalCommand('pause after verification')).toEqual({
      kind: 'create',
      objective: 'pause after verification',
    });
    expect(parseGoalCommand('clear the build cache')).toEqual({
      kind: 'create',
      objective: 'clear the build cache',
    });
  });

  it('edit 要真的接著空白才是 edit', () => {
    expect(parseGoalCommand('edit 把測試修綠')).toEqual({
      kind: 'edit',
      objective: '把測試修綠',
    });
    expect(parseGoalCommand('EDIT\t把測試修綠')).toEqual({
      kind: 'edit',
      objective: '把測試修綠',
    });
    // `editorial` 不是 `edit` 的變形，它是一句話的開頭。
    expect(parseGoalCommand('editorial pass on the docs')).toEqual({
      kind: 'create',
      objective: 'editorial pass on the docs',
    });
  });

  it('裸 edit 是自己的一種錯誤，不是查看也不是建立', () => {
    expect(parseGoalCommand('edit')).toEqual({ kind: 'invalid-edit' });
    expect(parseGoalCommand('  edit  ')).toEqual({ kind: 'invalid-edit' });
  });
});

describe('註冊', () => {
  it('apply 之後 /goal 在清單上，帶著提示', () => {
    const { registry, detach } = mount(1);
    expect(registry.commands.list()).toEqual([
      {
        name: GOAL_COMMAND_NAME,
        description: expect.any(String) as unknown as string,
        input: { hint: GOAL_COMMAND_HINT },
      },
    ]);
    detach();
  });

  it('**提示裡沒有圖片**——附件那條水管不存在', () => {
    // 絆索：`CommandInvocation` 有 `attachments` 的那天，提示要跟著改，不然它在騙人。
    expect(GOAL_COMMAND_HINT).not.toContain('image');
    expect(GOAL_COMMAND_HINT).not.toContain('圖');
  });
});

describe('找得到要動的那一份', () => {
  it('**一份都沒接就說一份都沒接**，不是靜靜什麼都沒發生', () => {
    const { run, detach } = mount(0);
    expect(errorText(run(''))).toBe(GOAL_NOT_ATTACHED_MESSAGE);
    expect(errorText(run('把測試修綠'))).toBe(GOAL_NOT_ATTACHED_MESSAGE);
    detach();
  });

  it('**接了兩份就當場說分不出來**，不是讓後接的那份靜靜贏走', () => {
    // 這一條釘住的是 `commands.ts` 上那句「一份 registry 只接一份日誌」——它是
    // `/goal` 找得到目標的前提，而前提要可證偽。
    const { run, logs, detach } = mount(2);
    expect(errorText(run('把測試修綠'))).toBe(goalAmbiguousMessage(2));
    // 而且真的什麼都沒寫進去：分不出來的時候不該賭一份。
    for (const log of logs) {
      expect(log.events.filter((event) => event.type === 'goal/change')).toEqual([]);
    }
    detach();
  });

  it('收掉一份之後剩下的那一份就不再有歧義', () => {
    const plugin = createGoalPlugin();
    const registry = createRegistry();
    const exit = registry.enter({ id: 'goal#0', name: 'goal' });
    plugin.apply(registry);
    exit();
    const installers = registry.sessions.installers();
    const first = new SessionLog('a');
    const second = new SessionLog('b');
    const detachFirst = createSessionRunner({
      address: { kind: 'root' },
      log: first,
      installers,
    });
    const detachSecond = createSessionRunner({
      address: { kind: 'root' },
      log: second,
      installers,
    });
    const command = registry.commands.find(GOAL_COMMAND_NAME);
    if (command === undefined) throw new Error('應該註冊得到 /goal');
    const run = (rawInput: string): CommandResult =>
      command.handler({
        commandId: 'cmd-test-1',
        rawInput,
        signal: new AbortController().signal,
      }) as CommandResult;

    expect(errorText(run(''))).toBe(goalAmbiguousMessage(2));
    detachFirst();
    expect(successText(run(''))).toBe(GOAL_NONE_MESSAGE);
    // 而且剩下的是**沒被收掉的那一份**：寫進去的目標要落在 `second` 上。
    run('把測試修綠');
    expect(first.events.filter((event) => event.type === 'goal/change')).toEqual([]);
    expect(second.events.filter((event) => event.type === 'goal/change')).toHaveLength(1);
    detachSecond();
  });

  it('**兩次組裝不串台**——同一個 plugin 物件掛兩次，各自動各自的', () => {
    // 這是 `apply` 裡那一格存在的理由。放進工廠閉包的話，這裡的兩條 registry 會共用
    // 同一格，而 `serve.ts` 每個 thread 組裝一次。
    const plugin = createGoalPlugin();
    const mountOne = (name: string): { run: (input: string) => CommandResult; log: SessionLog } => {
      const registry = createRegistry();
      const exit = registry.enter({ id: `goal#${name}`, name: 'goal' });
      plugin.apply(registry);
      exit();
      const log = new SessionLog(name);
      createSessionRunner({
        address: { kind: 'root' },
        log,
        installers: registry.sessions.installers(),
      });
      const command = registry.commands.find(GOAL_COMMAND_NAME);
      if (command === undefined) throw new Error('應該註冊得到 /goal');
      return {
        log,
        run: (input) =>
          command.handler({
            commandId: 'cmd-test-1',
            rawInput: input,
            signal: new AbortController().signal,
          }) as CommandResult,
      };
    };
    const a = mountOne('a');
    const b = mountOne('b');

    expect(successText(a.run('把測試修綠'))).toContain('把測試修綠');
    // b 那條看不到 a 的目標——沒有串台就是這個樣子。
    expect(successText(b.run(''))).toBe(GOAL_NONE_MESSAGE);
    expect(successText(b.run('把文件補完'))).toContain('把文件補完');
    expect(successText(a.run(''))).toContain('把測試修綠');
    expect(a.log.events.filter((event) => event.type === 'goal/change')).toHaveLength(1);
    expect(b.log.events.filter((event) => event.type === 'goal/change')).toHaveLength(1);
  });
});

describe('六種輸入', () => {
  it('裸 /goal 而且沒有目標：成功，附用法', () => {
    const { run, logs, detach } = mount(1);
    expect(successText(run(''))).toBe(GOAL_NONE_MESSAGE);
    // 查看不寫日誌。
    expect(logs[0]?.events).toEqual([]);
    detach();
  });

  it('/goal <目標>：建起來、寫進日誌、渲染出整份狀態', () => {
    const { run, logs, detach } = mount(1);
    const text = successText(run('把測試修綠'));
    expect(text).toContain('目標建好了');
    expect(text).toContain('狀態：進行中');
    expect(text).toContain('目標：把測試修綠');
    expect(text).toContain('輪次：0/256');
    expect(text).toContain('續行授權：已授權');
    expect(text).toContain(`現在打得動：/${GOAL_COMMAND_NAME} edit <目標>`);
    expect(logs[0]?.events.filter((event) => event.type === 'goal/change')).toHaveLength(1);
    detach();
  });

  it('**渲染不吐 id 也不吐 revision**', () => {
    // dsh 在 README 與程式碼裡各講一次的那一條。branded id 更容易手滑印出來。
    const { run, detach } = mount(1);
    const created = successText(run('把測試修綠'));
    expect(created).not.toContain('goal-1');
    expect(created).not.toContain('revision');
    expect(created).not.toContain('修訂');
    detach();
  });

  it('/goal edit <目標>：改敘述，相位與授權都不動', () => {
    const { run, detach } = mount(1);
    run('把測試修綠');
    const text = successText(run('edit 把測試修綠並補上回歸'));
    expect(text).toContain('目標改好了');
    expect(text).toContain('目標：把測試修綠並補上回歸');
    expect(text).toContain('狀態：進行中');
    expect(text).toContain('續行授權：已授權');
    detach();
  });

  it('/goal pause 之後提示改成 resume，/goal resume 把它接回來', () => {
    const { run, detach } = mount(1);
    run('把測試修綠');
    const paused = successText(run('pause'));
    expect(paused).toContain('目標暫停了');
    expect(paused).toContain('狀態：暫停');
    expect(paused).toContain('續行授權：未授權');
    expect(paused).toContain(`/${GOAL_COMMAND_NAME} resume`);
    expect(paused).not.toContain(`/${GOAL_COMMAND_NAME} pause`);

    const resumed = successText(run('resume'));
    expect(resumed).toContain('目標續上了');
    expect(resumed).toContain('狀態：進行中');
    expect(resumed).toContain('續行授權：已授權');
    expect(resumed).toContain(`/${GOAL_COMMAND_NAME} pause`);
    detach();
  });

  it('/goal clear：清掉，而且歷史留著', () => {
    const { run, logs, detach } = mount(1);
    run('把測試修綠');
    expect(successText(run('clear'))).toBe(GOAL_CLEARED_MESSAGE);
    expect(successText(run(''))).toBe(GOAL_NONE_MESSAGE);
    // 墓碑也是一顆事件——清掉不是刪掉。
    expect(logs[0]?.events.filter((event) => event.type === 'goal/change')).toHaveLength(2);
    detach();
  });
});

describe('沒有目標時的四種回答，而且它們不一樣', () => {
  it('**clear 是成功，另外三個是錯誤**', () => {
    const { run, detach } = mount(1);
    // clear 要的結果是「之後沒有目標」，本來就沒有的時候那個結果已經成立了。
    expect(successText(run('clear'))).toBe(GOAL_NOTHING_TO_CLEAR_MESSAGE);
    // 另外三個要的是「改動現在這一個」，沒有主詞就做不成。
    expect(errorText(run('edit 把測試修綠'))).toBe(goalMissingMessage('edit'));
    expect(errorText(run('pause'))).toBe(goalMissingMessage('pause'));
    expect(errorText(run('resume'))).toBe(goalMissingMessage('resume'));
    detach();
  });

  it('裸 edit 說的是「要接一句新的目標」，不是「沒有目標」', () => {
    const { run, detach } = mount(1);
    expect(errorText(run('edit'))).toBe(GOAL_INVALID_EDIT_MESSAGE);
    run('把測試修綠');
    expect(errorText(run('edit'))).toBe(GOAL_INVALID_EDIT_MESSAGE);
    detach();
  });
});

describe('已經有一個目標的時候', () => {
  it('再打一句話不會靜靜蓋掉它，而且那句錯誤指得出下一步', () => {
    const { run, logs, detach } = mount(1);
    run('把測試修綠');
    const rejected = errorText(run('把文件補完'));
    expect(rejected).toContain('已經有一個進行中的目標');
    expect(rejected).toContain(`/${GOAL_COMMAND_NAME} edit <目標>`);
    expect(rejected).toContain(`/${GOAL_COMMAND_NAME} clear`);
    // 沒有第二顆事件——被擋下來的變更不該留痕。
    expect(logs[0]?.events.filter((event) => event.type === 'goal/change')).toHaveLength(1);
    // 目標還是原來那個。
    expect(successText(run(''))).toContain('目標：把測試修綠');
    detach();
  });

  it('**完成掉的可以直接換，而且回的是「建好了」不是「改好了」**', () => {
    const { run, logs, serviceFor, detach } = mount(1);
    run('把測試修綠');
    // `/goal` 沒有 complete 子命令（dsh 也沒有）——完成是域或模型工具那側的動作，
    // 所以這裡直接走服務把它推到 complete。
    const service = serviceFor(logs[0] as SessionLog);
    const current = service.get();
    if (current === undefined) throw new Error('剛建好應該有目標');
    service.complete({ id: current.id, revision: current.revision });

    const replaced = successText(run('edit 把文件補完'));
    expect(replaced).toContain('目標建好了');
    expect(replaced).toContain('目標：把文件補完');
    detach();
  });

  it('完成掉的也可以直接用一句話換掉，不必先 clear', () => {
    const { run, logs, serviceFor, detach } = mount(1);
    run('把測試修綠');
    const service = serviceFor(logs[0] as SessionLog);
    const current = service.get();
    if (current === undefined) throw new Error('剛建好應該有目標');
    service.complete({ id: current.id, revision: current.revision });

    const replaced = successText(run('把文件補完'));
    expect(replaced).toContain('目標建好了');
    expect(replaced).toContain('目標：把文件補完');
    expect(replaced).toContain('狀態：進行中');
    detach();
  });
});

describe('域的拒絕與域的壞掉分得出來', () => {
  it('可預期的拒絕變成固定那一句，不透出 code 也不透出 id', () => {
    const { run, detach } = mount(1);
    run('把測試修綠');
    // 已經是 active 而且已授權，再 resume 一次是 `GOAL_INVALID_TRANSITION`。
    const rejected = errorText(run('resume'));
    expect(rejected).toBe(GOAL_REJECTED_MESSAGE);
    expect(rejected).not.toContain('GOAL_');
    expect(rejected).not.toContain('goal-1');
    detach();
  });

  it('**折疊壞掉是往外拋，連裸 /goal 都拋**', () => {
    // 域那側扣住理由之後每一次讀都拒絕，而那個拒絕是裸 `Error` 不是 `GoalError`。
    // 兩條進入點都接得住（REPL 印到 stderr、wire 回一顆 error 封包），所以這裡要的
    // 就是「它真的往外拋」，不是被吞成一句「狀態不成立」。
    const { run, logs, detach } = mount(1);
    const log = logs[0] as SessionLog;
    log.append('goal/change', {
      kind: 'goal/change',
      version: 1,
      operation: 'nonsense',
    } as unknown as GoalChangeMeta);
    expect(() => run('')).toThrow(/goal 重放在會話事件/u);
    expect(() => run('把測試修綠')).toThrow(/goal 重放在會話事件/u);
    detach();
  });
});

describe('executeGoalCommand 直接呼叫', () => {
  it('空清單與多份清單的那兩句話由它自己決定', () => {
    expect(executeGoalCommand([], '')).toEqual({
      kind: 'error',
      text: GOAL_NOT_ATTACHED_MESSAGE,
    });
    const fake = [{}, {}, {}] as unknown as readonly GoalService[];
    expect(executeGoalCommand(fake, '')).toEqual({
      kind: 'error',
      text: goalAmbiguousMessage(3),
    });
  });
});
