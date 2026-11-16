// @vitest-environment node
import { normalizeCommandDefinition } from '@nexus/core';
import type { CommandDefinition } from '@nexus/core';
import { parseCommand } from '@nexus/plugin-commands';
import type { SlashDescriptor } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { commandArm, commandToken } from '@/shared/connection/command-line';

/** 照伺服器的寫法登記命令：同一份定義產生 `slash.list` 送的 descriptor。 */
function command(name: string, input = true) {
  const definition: CommandDefinition = {
    name,
    description: `${name} 的說明`,
    ...(input ? { input: { hint: '<參數>' } } : {}),
    handler: () => ({ kind: 'success' }),
  };
  return normalizeCommandDefinition(definition);
}
// 出貨的命令都宣告了 `input`（`/goal`、`/plan` 收參數）；`compact` 是沒宣告的 bare 命令（#1971），只有第三方會登記這種。
const COMMANDS: readonly SlashDescriptor[] = [
  command('goal'),
  command('plan'),
  command('demo'),
  command('compact', false),
].map((r) => r.descriptor);

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
