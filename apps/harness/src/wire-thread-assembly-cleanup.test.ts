/**
 * serve 組一條 thread 時，在 `attachSessions` **之後**、`ready.set` **之前**失敗，已經接上的東西要收掉
 * （[#1467](https://github.com/DemianLi/nexus-agent/issues/1467)，#1463 備註第 2 點）。
 *
 * 手搭 `ThreadAgent`：每一樣接上去的東西（會話接線、落盤、標題、列檔索引）都記一筆「現在還活著」，
 * 然後讓 `attachSessions` 之後的某一步拋。收乾淨的證據是活著的集合回到空，而不是「收尾函式被叫過」。
 *
 * 紅燈設計：每個測試都先確認失敗**真的發生在** `attachSessions` 之後（`attached` 已記到），
 * 否則「什麼都沒接上所以什麼都沒漏」也會綠。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SessionRegistry } from '@nexus/core';
import { createWireClient } from '@nexus/wire';
import { createDeepAgent, StateBackend } from 'deepagents';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { emptyCommandPoint, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { WorkspaceFileSearch } from './file-references.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { ThreadAgent } from './wire-handler.js';

// `createCommandExecutor` 是 `attachSessions` 之後最後一個會拋的步驟，模組內的函式沒有地方可以注入，
// 所以只在這個檔裡把它包一層：旗標沒開時原樣轉給真的。
const executorFault = vi.hoisted(() => ({ fail: false }));
vi.mock('@nexus/plugin-commands', async (importOriginal) => {
  const original = await importOriginal<typeof import('@nexus/plugin-commands')>();
  return {
    ...original,
    createCommandExecutor: (...args: Parameters<typeof original.createCommandExecutor>) => {
      if (executorFault.fail) throw new Error('指令執行器建不起來');
      return original.createCommandExecutor(...args);
    },
  };
});

const BASE_URL = 'http://wire.test';
const THREAD = 'assembly-cleanup';

/** 一次組裝接上的東西，以及它們現在還活不活。 */
interface Rig {
  /** 依序記下每一樣接上去的東西（只增不減）。 */
  readonly attached: string[];
  /** 現在還活著的（收掉就移出）。 */
  readonly live: Set<string>;
  /** 收的順序。 */
  readonly order: string[];
  /** `threadAgent.dispose()` 被叫過幾次。 */
  agentDisposed: number;
}

interface Faults {
  /** `attachPersistence` 拋。 */
  persistence?: boolean;
  /** `attachTitle` 拋。 */
  title?: boolean;
  /** 收 `attachSessions` 的那一步（`detach`）拋——收尾本身出錯。 */
  detach?: boolean;
  /** 收落盤那一步拋。 */
  persistenceDispose?: boolean;
}

function scriptedAgent(): PumpAgent {
  return createDeepAgent({
    model: new ScriptedChatModel({ turns: [{ content: '好。' }] }),
    tools: [],
    backend: new StateBackend(),
  }) as unknown as PumpAgent;
}

const workspaces: string[] = [];
afterEach(() => {
  executorFault.fail = false;
  vi.restoreAllMocks();
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 組一份 `ThreadAgent`，每接一樣就記一筆。 */
function threadAgentFor(rig: Rig, faults: Faults, workspaceRoot: string | undefined): ThreadAgent {
  const agent = scriptedAgent();
  return {
    agent,
    commands: emptyCommandPoint(),
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    attachSessions: (_sessions: SessionRegistry) => {
      rig.attached.push('sessions');
      rig.live.add('sessions');
      return {
        detach: async () => {
          rig.order.push('sessions');
          rig.live.delete('sessions');
          if (faults.detach === true) throw new Error('會話接線收不掉');
        },
      };
    },
    attachPersistence: () => {
      if (faults.persistence === true) throw new Error('落盤接不上');
      rig.attached.push('persistence');
      rig.live.add('persistence');
      return {
        flush: async () => {},
        dispose: async () => {
          rig.order.push('persistence');
          rig.live.delete('persistence');
          if (faults.persistenceDispose === true) throw new Error('落盤收不掉');
        },
      };
    },
    attachTitle: () => {
      if (faults.title === true) throw new Error('標題接不上');
      rig.attached.push('title');
      rig.live.add('title');
      return async () => {
        rig.order.push('title');
        rig.live.delete('title');
      };
    },
    dispose: async () => {
      rig.order.push('agent');
      rig.agentDisposed += 1;
    },
  };
}

function newRig(): Rig {
  return { attached: [], live: new Set(), order: [], agentDisposed: 0 };
}

/** 連上一個 handler，第一次組裝帶 `first` 的故障，之後都不帶。回每一次組裝的 rig。 */
function connect(first: Faults, workspaceRoot?: string) {
  const rigs: Rig[] = [];
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: async () => {
      const rig = newRig();
      rigs.push(rig);
      return threadAgentFor(rig, rigs.length === 1 ? first : {}, workspaceRoot);
    },
  });
  const client = createWireClient({
    baseUrl: BASE_URL,
    fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
  });
  return { handler, client, rigs };
}

/** 開一條下行，回它（成功）或錯誤訊息（建不起來）。 */
async function open(client: ReturnType<typeof createWireClient>): Promise<string | undefined> {
  const events = await client.openEvents(THREAD).catch((error: unknown) => error as Error);
  if (events instanceof Error) return events.message;
  await events.return?.(undefined);
  return undefined;
}

describe('thread 組到一半失敗：已接上的要收掉（#1467）', () => {
  it('落盤接不上（attachSessions 已接）：會話接線、agent 都收掉，同 id 下一次組得起來、只有新的活著', async () => {
    const { handler, client, rigs } = connect({ persistence: true });

    const failure = await open(client);
    expect(failure).toContain('落盤接不上');
    // 失敗真的發生在 attachSessions 之後，而且之前的東西是接上過的。
    expect(rigs[0]?.attached).toEqual(['sessions']);
    expect(rigs[0]?.live.size).toBe(0);
    expect(rigs[0]?.agentDisposed).toBe(1);

    // 同一個 thread id 的下一次請求：組得起來，而且只有新的那一份活著。
    expect(await open(client)).toBeUndefined();
    expect(rigs).toHaveLength(2);
    expect(rigs[0]?.live.size).toBe(0);
    expect([...(rigs[1]?.live ?? [])].sort()).toEqual(['persistence', 'sessions', 'title']);
    await handler.close();
  });

  it('標題接不上（落盤已接）：落盤與會話接線都收掉，順序是落盤、會話之前的先收、agent 最後', async () => {
    const { handler, client, rigs } = connect({ title: true });

    expect(await open(client)).toContain('標題接不上');
    expect(rigs[0]?.attached).toEqual(['sessions', 'persistence']);
    expect(rigs[0]?.live.size).toBe(0);
    // 成功路徑 `state.dispose` 的順序：會話接線 → 落盤 → agent。
    expect(rigs[0]?.order).toEqual(['sessions', 'persistence', 'agent']);

    expect(await open(client)).toBeUndefined();
    expect(rigs[0]?.live.size).toBe(0);
    expect([...(rigs[1]?.live ?? [])].sort()).toEqual(['persistence', 'sessions', 'title']);
    await handler.close();
  });

  it('指令執行器建不起來（標題、列檔索引都已接）：四樣都收掉，順序同成功路徑', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'nexus-assembly-cleanup-'));
    workspaces.push(workspace);
    const disposeFileSearch = vi.spyOn(WorkspaceFileSearch.prototype, 'dispose');
    executorFault.fail = true;
    const { handler, client, rigs } = connect({}, workspace);

    expect(await open(client)).toContain('指令執行器建不起來');
    expect(rigs[0]?.attached).toEqual(['sessions', 'persistence', 'title']);
    expect(rigs[0]?.live.size).toBe(0);
    // 標題最先、列檔索引接著、再會話接線、落盤、agent（成功路徑 `state.dispose` 的順序）。
    expect(rigs[0]?.order).toEqual(['title', 'sessions', 'persistence', 'agent']);
    expect(disposeFileSearch).toHaveBeenCalledTimes(1);

    executorFault.fail = false;
    expect(await open(client)).toBeUndefined();
    expect(rigs[0]?.live.size).toBe(0);
    expect([...(rigs[1]?.live ?? [])].sort()).toEqual(['persistence', 'sessions', 'title']);
    await handler.close();
  });

  it('收尾本身拋錯：對外回的仍是原本那個錯，而且後面的步驟照收（一步出錯不跳過其餘）', async () => {
    const { handler, client, rigs } = connect({ title: true, detach: true });

    const failure = await open(client);
    // 對外是原本的錯，不是收尾的錯。
    expect(failure).toContain('標題接不上');
    expect(failure).not.toContain('會話接線收不掉');
    // 會話接線的 detach 拋了，落盤與 agent 仍然收了。
    expect(rigs[0]?.order).toEqual(['sessions', 'persistence', 'agent']);
    expect(rigs[0]?.live.size).toBe(0);
    expect(rigs[0]?.agentDisposed).toBe(1);
    await handler.close();
  });

  it('收尾裡落盤的 dispose 拋：同樣不蓋過原本的錯，agent 仍收', async () => {
    const { handler, client, rigs } = connect({ title: true, persistenceDispose: true });

    const failure = await open(client);
    expect(failure).toContain('標題接不上');
    expect(failure).not.toContain('落盤收不掉');
    expect(rigs[0]?.order).toEqual(['sessions', 'persistence', 'agent']);
    expect(rigs[0]?.agentDisposed).toBe(1);
    await handler.close();
  });

  it('成功路徑不變：close() 收的順序是標題、會話接線、落盤、agent', async () => {
    const { handler, client, rigs } = connect({});
    expect(await open(client)).toBeUndefined();
    expect(rigs[0]?.live.size).toBe(3);
    await handler.close();
    expect(rigs[0]?.order).toEqual(['title', 'sessions', 'persistence', 'agent']);
    expect(rigs[0]?.live.size).toBe(0);
  });

  it('attachSessions 本身拋：之前沒有東西接上，agent 照收（既有行為）', async () => {
    const rigs: Rig[] = [];
    const handler = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      createAgent: async () => {
        const rig = newRig();
        rigs.push(rig);
        return {
          ...threadAgentFor(rig, {}, undefined),
          attachSessions: () => {
            throw new Error('會話接線接不上');
          },
        };
      },
    });
    const client = createWireClient({
      baseUrl: BASE_URL,
      fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
    });
    expect(await open(client)).toContain('會話接線接不上');
    expect(rigs[0]?.agentDisposed).toBe(1);
    expect(rigs[0]?.live.size).toBe(0);
    await handler.close();
  });
});
