import { describe, expect, it, vi } from 'vitest';

import type { Adjudication, SendRejected } from '@/shared/connection/use-conversation';

import { createSubmitMachine } from './machine';
import type { PreparedAttachments, SubmitOptions } from './machine';
import type { SubmitReport } from './report';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const flush = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

type Item = { readonly id: string };

function setup(overrides: Partial<SubmitOptions<Item>> = {}) {
  const send = vi.fn<SubmitOptions<Item>['send']>(() => Promise.resolve(undefined));
  const report = vi.fn<(r: SubmitReport | undefined) => void>();
  const options: SubmitOptions<Item> = {
    send,
    allowed: () => true,
    enabled: true,
    mode: (gesture) => (gesture === 'accelerated' ? 'steer' : 'queue'),
    report,
    ...overrides,
  };
  const machine = createSubmitMachine(() => options);
  return { machine, send, report, options };
}
const type = (machine: ReturnType<typeof setup>['machine'], text: string) => machine.setDraft(text);
const draftOf = (machine: ReturnType<typeof setup>['machine']) => machine.getSnapshot().draft;
const agent = { id: 'explore', name: 'explore', description: '' };

describe('一般句子', () => {
  it('收下：草稿清掉、照手勢定的 mode 送、沒認命令時 route 是 undefined、先叫 report(undefined)', async () => {
    const adjudicate = vi.fn<(line: string) => Promise<Adjudication>>();
    const { machine, send, report } = setup({ commands: { adjudicate, names: () => false } });
    type(machine, '你好');
    machine.submit('accelerated');
    expect(draftOf(machine)).toBe('');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.slice(0, 4)).toEqual(['你好', 'steer', undefined, undefined]);
    expect(send.mock.calls[0]?.[5]).toBeUndefined();
    expect(report).toHaveBeenCalledWith(undefined);
    expect(adjudicate).not.toHaveBeenCalled();
    await flush();
    expect(draftOf(machine)).toBe('');
  });

  it('沒收下：草稿放回去並說原因', async () => {
    const reply = deferred<SendRejected | undefined>();
    const { machine, send, report } = setup();
    send.mockReturnValueOnce(reply.promise);
    type(machine, '你好');
    machine.submit('enter');
    reply.resolve({ message: '伺服器忙線' });
    await flush();
    expect(draftOf(machine)).toBe('你好');
    expect(report).toHaveBeenLastCalledWith({ kind: 'rejected', message: '伺服器忙線' });
  });

  it('沒收下時人已經開始打下一句：不蓋掉', async () => {
    const reply = deferred<SendRejected | undefined>();
    const { machine, send, report } = setup();
    send.mockReturnValueOnce(reply.promise);
    type(machine, '第一句');
    machine.submit('enter');
    type(machine, '第二');
    reply.resolve({ message: '失敗' });
    await flush();
    expect(draftOf(machine)).toBe('第二');
    expect(report).toHaveBeenLastCalledWith({ kind: 'rejected', message: '失敗' });
  });

  it('不確定有沒有送到：報 uncertain', async () => {
    const { machine, send, report } = setup();
    send.mockResolvedValueOnce({ message: 'Failed to fetch', uncertain: true });
    type(machine, '你好');
    machine.submit('enter');
    await flush();
    expect(report).toHaveBeenLastCalledWith({ kind: 'uncertain', message: 'Failed to fetch' });
    expect(draftOf(machine)).toBe('你好');
  });

  it('原樣重送沿用請求編號，改字後換新的，收下後也換新的', async () => {
    const { machine, send } = setup();
    send.mockResolvedValueOnce({ message: 'x', uncertain: true });
    type(machine, '你好');
    machine.submit('enter');
    await flush();
    machine.submit('enter');
    await flush();
    const [first, second] = send.mock.calls.map((call) => call[4]);
    expect(first).toBeTypeOf('string');
    expect(second).toBe(first);

    send.mockResolvedValueOnce({ message: 'x' });
    type(machine, '你好嗎');
    machine.submit('enter');
    await flush();
    const third = send.mock.calls[2]?.[4];
    expect(third).not.toBe(first);

    // 第三句沒收下、原樣再送，編號與第三句同；收下之後再送同一句又是新的。
    machine.submit('enter');
    await flush();
    expect(send.mock.calls[3]?.[4]).toBe(third);
    type(machine, '你好嗎');
    machine.submit('enter');
    await flush();
    expect(send.mock.calls[4]?.[4]).not.toBe(third);
  });

  it('不允許時不送；停用時不送', () => {
    const closed = setup({ allowed: () => false });
    type(closed.machine, 'a');
    closed.machine.submit('enter');
    expect(closed.send).not.toHaveBeenCalled();
    const disabled = setup({ enabled: false });
    type(disabled.machine, 'a');
    disabled.machine.submit('enter');
    expect(disabled.send).not.toHaveBeenCalled();
    expect(draftOf(disabled.machine)).toBe('a');
  });

  it('先攔一行：攔下就清草稿，回 false 留著，不送', () => {
    const intercept = vi.fn<(line: string) => boolean | undefined>();
    const { machine, send } = setup({ intercept });
    intercept.mockReturnValueOnce(true);
    type(machine, '/model');
    machine.submit('enter');
    expect(draftOf(machine)).toBe('');
    intercept.mockReturnValueOnce(false);
    type(machine, '/model 找不到');
    machine.submit('enter');
    expect(draftOf(machine)).toBe('/model 找不到');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('認命令', () => {
  const names = (line: string) => line.startsWith('/goal');
  function commandSetup(verdict: Deferred<Adjudication>) {
    const adjudicate = vi.fn((_line: string) => verdict.promise);
    return { adjudicate, ...setup({ commands: { adjudicate, names } }) };
  }

  it('認的期間鎖住、草稿不動；released 什麼都不說', async () => {
    const verdict = deferred<Adjudication>();
    const { machine, send, report } = commandSetup(verdict);
    type(machine, '/goal x');
    machine.submit('enter');
    expect(machine.getSnapshot().locked).toBe(true);
    expect(draftOf(machine)).toBe('/goal x');
    verdict.resolve({ kind: 'released' });
    await flush();
    expect(machine.getSnapshot().locked).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    expect(draftOf(machine)).toBe('/goal x');
  });

  it('failed：說原因，草稿、標記沒動', async () => {
    const verdict = deferred<Adjudication>();
    const { machine, send, report } = commandSetup(verdict);
    machine.selectAgent(agent);
    type(machine, '/goal x');
    machine.submit('enter');
    verdict.resolve({ kind: 'failed', message: '抓不到清單' });
    await flush();
    expect(report).toHaveBeenCalledWith({ kind: 'rejected', message: '抓不到清單' });
    expect(send).not.toHaveBeenCalled();
    expect(draftOf(machine)).toBe('/goal x');
    expect(machine.getSnapshot().mentionedAgent).toBe(agent);
  });

  it('sentence：照一句話送、route 是 sentence，標記照帶', async () => {
    const verdict = deferred<Adjudication>();
    const { machine, send } = commandSetup(verdict);
    machine.selectAgent(agent);
    type(machine, '/deploy 今天');
    machine.submit('enter');
    verdict.resolve({ kind: 'sentence' });
    await flush();
    expect(send.mock.calls[0]?.[3]).toEqual({ kind: 'subagent', name: 'explore' });
    expect(send.mock.calls[0]?.[5]).toBe('sentence');
    expect(draftOf(machine)).toBe('');
    expect(machine.getSnapshot().mentionedAgent).toBeUndefined();
  });

  it('光打 /feedback 不認、直接當走一般流程', () => {
    const verdict = deferred<Adjudication>();
    const { machine, adjudicate, send } = commandSetup(verdict);
    type(machine, '/feedback');
    machine.submit('enter');
    expect(adjudicate).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('command 有 input：在途鎖住、不帶標記；收下後只清送出的那段', async () => {
    const verdict = deferred<Adjudication>();
    const reply = deferred<SendRejected | undefined>();
    const { machine, send } = commandSetup(verdict);
    send.mockReturnValueOnce(reply.promise);
    machine.selectAgent(agent);
    type(machine, '/goal x');
    machine.submit('enter');
    verdict.resolve({ kind: 'command', detached: false });
    await flush();
    expect(send.mock.calls[0]).toEqual([
      '/goal x',
      'queue',
      undefined,
      undefined,
      undefined,
      'command',
    ]);
    expect(machine.getSnapshot().locked).toBe(true);
    expect(draftOf(machine)).toBe('/goal x');
    expect(machine.getSnapshot().mentionedAgent).toBe(agent);
    // 鎖著時多打的字不跟著消失。
    machine.setDraft('/goal x 多打');
    reply.resolve(undefined);
    await flush();
    expect(machine.getSnapshot().locked).toBe(false);
    expect(draftOf(machine)).toBe(' 多打');
  });

  it('command 沒收下：草稿原樣、不跳報告', async () => {
    const verdict = deferred<Adjudication>();
    const { machine, send, report } = commandSetup(verdict);
    send.mockResolvedValueOnce({ message: '命令回錯誤' });
    type(machine, '/goal x');
    machine.submit('enter');
    verdict.resolve({ kind: 'command', detached: false });
    await flush();
    expect(draftOf(machine)).toBe('/goal x');
    expect(machine.getSnapshot().locked).toBe(false);
    expect(report).not.toHaveBeenCalled();
  });

  it('detached：當場清草稿、不進在途、不鎖', async () => {
    const verdict = deferred<Adjudication>();
    const reply = deferred<SendRejected | undefined>();
    const { machine, send } = commandSetup(verdict);
    send.mockReturnValueOnce(reply.promise);
    type(machine, '/goal');
    machine.submit('enter');
    verdict.resolve({ kind: 'command', detached: true });
    await flush();
    expect(draftOf(machine)).toBe('');
    expect(machine.getSnapshot().locked).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    reply.resolve({ message: '沒收下' });
    await flush();
    expect(draftOf(machine)).toBe('');
  });

  it('同一個 tick 的第二下被擋：認的期間與命令在途', async () => {
    const verdict = deferred<Adjudication>();
    const { machine, adjudicate, send } = commandSetup(verdict);
    send.mockReturnValueOnce(new Promise(() => {}));
    type(machine, '/goal x');
    machine.submit('enter');
    machine.submit('enter');
    expect(adjudicate).toHaveBeenCalledTimes(1);
    verdict.resolve({ kind: 'command', detached: false });
    await flush();
    machine.submit('enter');
    expect(send).toHaveBeenCalledTimes(1);
    expect(machine.runCommand('/goal y')).toBe(false);
  });

  it('標記在鎖住期間不放回：前一句晚到的拒收不改寫鎖住的畫面', async () => {
    const verdict = deferred<Adjudication>();
    const first = deferred<SendRejected | undefined>();
    const { machine, send } = commandSetup(verdict);
    send.mockReturnValueOnce(first.promise);
    machine.selectAgent(agent);
    type(machine, '第一句');
    machine.submit('enter');
    expect(machine.getSnapshot().mentionedAgent).toBeUndefined();
    type(machine, '/goal x');
    machine.submit('enter'); // 認命令，鎖住
    first.resolve({ message: '失敗' });
    await flush();
    expect(machine.getSnapshot().mentionedAgent).toBeUndefined();
    expect(draftOf(machine)).toBe('/goal x');
  });

  it('標記沒鎖時放回；已經選了別的就不蓋', async () => {
    const first = deferred<SendRejected | undefined>();
    const { machine, send } = setup();
    send.mockReturnValueOnce(first.promise);
    machine.selectAgent(agent);
    type(machine, '一句');
    machine.submit('enter');
    first.resolve({ message: '失敗' });
    await flush();
    expect(machine.getSnapshot().mentionedAgent).toBe(agent);

    const second = deferred<SendRejected | undefined>();
    send.mockReturnValueOnce(second.promise);
    machine.submit('enter');
    const other = { id: 'x', name: 'x', description: '' };
    machine.selectAgent(other);
    second.resolve({ message: '失敗' });
    await flush();
    expect(machine.getSnapshot().mentionedAgent).toBe(other);
  });
});

describe('從選單執行一行', () => {
  it('送出去；先攔的照攔；鎖著不收；不允許不收', () => {
    const intercept = vi.fn<(line: string) => boolean | undefined>(() => undefined);
    const { machine, send, options } = setup({ intercept });
    expect(machine.runCommand('/permission x')).toBe(true);
    expect(send).toHaveBeenCalledWith('/permission x');
    intercept.mockReturnValueOnce(false);
    expect(machine.runCommand('/model 無')).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    const closed = createSubmitMachine(() => ({ ...options, allowed: () => false }));
    expect(closed.runCommand('/x')).toBe(false);
  });
});

describe('附件', () => {
  const picked: Item[] = [{ id: 'a1' }, { id: 'a2' }];
  function attachSetup(prepared: Deferred<PreparedAttachments>) {
    const onRefused = vi.fn();
    const onAccepted = vi.fn();
    const prepare = vi.fn((_items: readonly Item[]) => prepared.promise);
    const ctx = setup({
      attachments: { items: () => picked, prepare, onRefused, onAccepted },
    });
    return { ...ctx, onRefused, onAccepted, prepare };
  }

  it('取消：不送、草稿放回、說已取消、結算 cancelled', async () => {
    const prepared = deferred<PreparedAttachments>();
    const { machine, send, report, onRefused, onAccepted } = attachSetup(prepared);
    type(machine, '看圖');
    machine.submit('enter');
    expect(machine.getSnapshot().removalLocked).toBe(true);
    prepared.resolve({ kind: 'cancelled' });
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(onRefused).toHaveBeenCalledWith('cancelled');
    expect(onAccepted).not.toHaveBeenCalled();
    expect(report).toHaveBeenLastCalledWith({
      kind: 'cancelled',
      message: '附件還在，再按送出會重新上傳。',
    });
    expect(draftOf(machine)).toBe('看圖');
    expect(machine.getSnapshot().removalLocked).toBe(false);
  });

  it('上傳失敗：說原因、結算 failed', async () => {
    const prepared = deferred<PreparedAttachments>();
    const { machine, send, report, onRefused } = attachSetup(prepared);
    type(machine, '看圖');
    machine.submit('enter');
    prepared.resolve({ kind: 'failed', message: '太大' });
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(onRefused).toHaveBeenCalledWith('failed');
    expect(report).toHaveBeenLastCalledWith({ kind: 'rejected', message: '太大' });
    expect(draftOf(machine)).toBe('看圖');
  });

  it('收下：附件帶上、移掉這一批', async () => {
    const prepared = deferred<PreparedAttachments>();
    const { machine, send, onAccepted, onRefused } = attachSetup(prepared);
    type(machine, '');
    machine.setDraft('看圖');
    machine.submit('enter');
    const receipts = [{ type: 'file' }] as never;
    prepared.resolve({ kind: 'ok', attachments: receipts });
    await flush();
    expect(send.mock.calls[0]?.[2]).toBe(receipts);
    expect(onAccepted).toHaveBeenCalledWith(['a1', 'a2']);
    expect(onRefused).not.toHaveBeenCalled();
    expect(draftOf(machine)).toBe('');
    expect(machine.getSnapshot().removalLocked).toBe(false);
  });

  it('上傳成功、伺服器沒收下：附件全留著，結算不帶原因', async () => {
    const prepared = deferred<PreparedAttachments>();
    const { machine, send, onAccepted, onRefused, report } = attachSetup(prepared);
    send.mockResolvedValueOnce({ message: '模型不收圖' });
    type(machine, '看圖');
    machine.submit('enter');
    prepared.resolve({ kind: 'ok', attachments: [] });
    await flush();
    expect(onAccepted).not.toHaveBeenCalled();
    expect(onRefused).toHaveBeenCalledWith();
    expect(report).toHaveBeenLastCalledWith({ kind: 'rejected', message: '模型不收圖' });
    expect(draftOf(machine)).toBe('看圖');
  });

  it('送出中第二下被擋；沒附件、沒打字也要靠 allowed 放行', async () => {
    const prepared = deferred<PreparedAttachments>();
    const { machine, prepare } = attachSetup(prepared);
    type(machine, '看圖');
    machine.submit('enter');
    type(machine, '又打');
    machine.submit('enter');
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('光打 /feedback 不帶附件', () => {
    const prepared = deferred<PreparedAttachments>();
    const { machine, prepare, send } = attachSetup(prepared);
    type(machine, '/feedback');
    machine.submit('enter');
    expect(prepare).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('嵌入版的選項', () => {
  it('不認命令：開頭是 / 也是一句話，route 固定 sentence；mode 固定；帶 context 與 hostTools', async () => {
    const context = { label: '訂單 12' } as never;
    const hostTools = [{ name: 'open' }] as never;
    const { machine, send, report } = setup({
      mode: () => 'queue',
      context,
      hostTools,
    });
    type(machine, '/help');
    machine.submit('accelerated');
    expect(send).toHaveBeenCalledTimes(1);
    const call = send.mock.calls[0]!;
    expect(call.slice(0, 4)).toEqual(['/help', 'queue', undefined, undefined]);
    expect(call[4]).toBeTypeOf('string');
    expect(call[5]).toBe('sentence');
    expect(call[6]).toBe(context);
    expect(call[7]).toBe(hostTools);
    expect(report).toHaveBeenCalledWith(undefined);
    expect(machine.getSnapshot().locked).toBe(false);
  });

  it('沒收下：放回草稿並報告', async () => {
    const { machine, send, report } = setup();
    send.mockResolvedValueOnce({ message: '連不上', uncertain: true });
    type(machine, '嗨');
    machine.submit('enter');
    await flush();
    expect(draftOf(machine)).toBe('嗨');
    expect(report).toHaveBeenLastCalledWith({ kind: 'uncertain', message: '連不上' });
  });
});

describe('訂閱', () => {
  it('狀態變了才通知；取消訂閱後不再通知', () => {
    const { machine } = setup();
    const listener = vi.fn();
    const off = machine.subscribe(listener);
    machine.setDraft('a');
    machine.setDraft('a');
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    machine.setDraft('b');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
