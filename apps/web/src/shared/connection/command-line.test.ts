// @vitest-environment node
import { COMMAND_GRAMMAR_DESCRIPTORS, COMMAND_TOKEN_CASES } from '@nexus/wire';
import type { SlashDescriptor } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { commandArm, commandToken } from '@/shared/connection/command-line';

const COMMANDS: readonly SlashDescriptor[] = COMMAND_GRAMMAR_DESCRIPTORS;

describe('commandToken 跟伺服器的 parseCommand 同一套（#1929）', () => {
  it.each(COMMAND_TOKEN_CASES)('%j → %s', (line, name) => {
    expect(commandToken(line)).toBe(name);
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
