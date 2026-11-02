import type {
  CommandOutcome,
  ModelCatalogResult,
  PermissionCatalogResult,
  SubagentListResult,
  WireProjection,
} from '@nexus/wire';
import {
  THREAD_AT_CAPACITY,
  THREAD_HISTORY_TOO_DEEP,
  THREAD_LOG_BUSY,
  THREAD_LOG_TOO_LARGE,
  THREAD_ROOT_MISMATCH,
  THREAD_WRITER_HELD,
  UplinkTransportError,
} from '@nexus/wire';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAgentMention } from '@/hooks/use-agent-mention';
import { useModelSeat } from '@/hooks/use-model-seat';
import { useOpenRead, worthRereading } from '@/hooks/use-open-read';
import { usePermissionSeat } from '@/hooks/use-permission-seat';
import { UNWIRED_WIRE_CONTRACT } from '@/test/wire-contract';

afterEach(cleanup);

const CAPACITY = {
  kind: 'rejected',
  code: THREAD_AT_CAPACITY,
  message: 'thread 數已到上限 1／1；重啟 serve 才會釋放',
} as const;

describe('worthRereading（#1483）', () => {
  it.each([
    ['thread 數滿了', { code: THREAD_AT_CAPACITY }, true],
    ['thread 建不起來', { code: 'unknown_error' }, true],
    ['網路層拋錯', { thrown: new TypeError('Failed to fetch') }, true],
    ['載體層 5xx', { thrown: new UplinkTransportError(502, '') }, true],
    ['額度被別的會話佔滿（#2203）', { code: THREAD_LOG_BUSY }, true],
    ['被別的寫入者握著（#2214）', { code: THREAD_WRITER_HELD }, true],
    ['這個組裝沒有', { code: 'not_supported' }, false],
    ['紀錄太大，等也沒用（#2203）', { code: THREAD_LOG_TOO_LARGE }, false],
    ['開在別的 home，等也沒用（#2222）', { code: THREAD_ROOT_MISMATCH }, false],
    ['歷史太深、灌不回去（#1753）', { code: THREAD_HISTORY_TOO_DEEP }, false],
    ['沒有碼的拒絕', {}, false],
    [
      '舊 server 不認得這個 method（404）',
      { thrown: new UplinkTransportError(404, 'not found') },
      false,
    ],
  ] as const)('%s → %s', (_case, failure, expected) => {
    expect(worthRereading(failure)).toBe(expected);
  });
});

describe('useOpenRead（#1483）', () => {
  /** 依序回 `outcomes`（用完就重複最後一個）；`Error` 就拋。 */
  function reader(...outcomes: (CommandOutcome<string> | Error)[]) {
    let index = 0;
    return vi.fn(async (): Promise<CommandOutcome<string>> => {
      const next = outcomes[Math.min(index, outcomes.length - 1)]!;
      index += 1;
      if (next instanceof Error) throw next;
      return next;
    });
  }
  const OK = { kind: 'ok', result: '目錄' } as const;

  function mount(read: () => Promise<CommandOutcome<string>>) {
    return renderHook(({ connections }) => useOpenRead(read, connections), {
      initialProps: { connections: 0 },
    });
  }

  it('沒斷過：只讀一次；讀成功之後再接上幾次也不重讀', async () => {
    const read = reader(OK);
    const hook = mount(read);
    await waitFor(() => expect(hook.result.current).toBe('目錄'));
    hook.rerender({ connections: 1 });
    hook.rerender({ connections: 2 });
    await act(async () => undefined);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('滿了讀不到：下一次接上再讀，讀到了就畫', async () => {
    const read = reader(CAPACITY, OK);
    const hook = mount(read);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    expect(hook.result.current).toBeNull();

    hook.rerender({ connections: 1 });
    await waitFor(() => expect(hook.result.current).toBe('目錄'));
    expect(read).toHaveBeenCalledTimes(2);
    hook.rerender({ connections: 2 });
    await act(async () => undefined);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('網路層拋錯：同樣下一次接上再讀', async () => {
    const read = reader(new TypeError('Failed to fetch'), OK);
    const hook = mount(read);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    hook.rerender({ connections: 1 });
    await waitFor(() => expect(hook.result.current).toBe('目錄'));
  });

  it('這個組裝沒有（not_supported）：接上幾次都不重讀', async () => {
    const read = reader({ kind: 'rejected', code: 'not_supported', message: '沒有' });
    const hook = mount(read);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    hook.rerender({ connections: 1 });
    hook.rerender({ connections: 2 });
    await act(async () => undefined);
    expect(read).toHaveBeenCalledTimes(1);
    expect(hook.result.current).toBeNull();
  });

  it('歷史太深（thread_history_too_deep，#1753）：永久的，接上幾次都不重讀', async () => {
    const read = reader({
      kind: 'rejected',
      code: THREAD_HISTORY_TOO_DEEP,
      message: '這條 thread 建不起來：日誌第 3 顆事件有 3000 層，超過上限 600',
    });
    const hook = mount(read);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    hook.rerender({ connections: 1 });
    hook.rerender({ connections: 2 });
    await act(async () => undefined);
    expect(read).toHaveBeenCalledTimes(1);
    expect(hook.result.current).toBeNull();
  });

  it('又讀不到：再下一次接上再讀，不輪詢', async () => {
    const read = reader(CAPACITY, CAPACITY, OK);
    const hook = mount(read);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    hook.rerender({ connections: 1 });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await act(async () => undefined);
    expect(read).toHaveBeenCalledTimes(2);
    hook.rerender({ connections: 2 });
    await waitFor(() => expect(hook.result.current).toBe('目錄'));
    expect(read).toHaveBeenCalledTimes(3);
  });
});

/** 三樣各一條：開頁時滿了讀不到，下行接上之後重讀成功、畫得出來（驗收 A）。 */
describe('開頁時讀的三樣，接上之後重讀（#1483 驗收 A）', () => {
  /** 第一次回滿了，之後回 `ok`。 */
  function capacityOnce<T>(ok: T) {
    let calls = 0;
    return vi.fn(async (): Promise<CommandOutcome<T>> => {
      calls += 1;
      return calls === 1 ? CAPACITY : { kind: 'ok', result: ok };
    });
  }

  it('模型座', async () => {
    const result: ModelCatalogResult = {
      ok: true,
      value: {
        catalog: { default: { modelId: 'model-a' }, models: [{ id: 'model-a', name: 'Alpha' }] },
        selection: { next: null, lastUsed: null },
      },
    };
    const modelCatalog = capacityOnce(result);
    const client = { ...UNWIRED_WIRE_CONTRACT, modelCatalog };
    const hook = renderHook(
      ({ connections }) => useModelSeat(client, 't', undefined, connections),
      {
        initialProps: { connections: 0 },
      },
    );
    await waitFor(() => expect(modelCatalog).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    expect(hook.result.current).toBeNull();
    hook.rerender({ connections: 1 });
    await waitFor(() => expect(hook.result.current).not.toBeNull());
    expect(modelCatalog).toHaveBeenCalledTimes(2);
  });

  it('權限選單', async () => {
    const option = { value: 'read-only', name: '唯讀' };
    const result: PermissionCatalogResult = {
      ok: true,
      value: {
        catalog: { options: [option], defaultOptions: [option], defaultPreset: 'read-only' },
      },
    };
    const permissionCatalog = capacityOnce(result);
    const client = { ...UNWIRED_WIRE_CONTRACT, permissionCatalog };
    const projection: WireProjection = {
      version: 1,
      view: { currentValue: 'read-only' },
    };
    const hook = renderHook(
      ({ connections }) => usePermissionSeat(client, 't', projection, connections),
      { initialProps: { connections: 0 } },
    );
    await waitFor(() => expect(permissionCatalog).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    expect(hook.result.current).toBeNull();
    hook.rerender({ connections: 1 });
    await waitFor(() => expect(hook.result.current).not.toBeNull());
    expect(permissionCatalog).toHaveBeenCalledTimes(2);
  });

  it('@ 子代理清單', async () => {
    const result: SubagentListResult = {
      ok: true,
      value: { subagents: [{ name: 'explorer', description: '唯讀地探索程式碼' }] },
    };
    const subagentList = capacityOnce(result);
    const client = { ...UNWIRED_WIRE_CONTRACT, subagentList };
    const hook = renderHook(({ connections }) => useAgentMention(client, 't', connections), {
      initialProps: { connections: 0 },
    });
    await waitFor(() => expect(subagentList).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    expect(hook.result.current).toBeNull();
    hook.rerender({ connections: 1 });
    await waitFor(() =>
      expect(hook.result.current?.map((agent) => agent.name)).toEqual(['explorer']),
    );
    expect(subagentList).toHaveBeenCalledTimes(2);
  });
});
