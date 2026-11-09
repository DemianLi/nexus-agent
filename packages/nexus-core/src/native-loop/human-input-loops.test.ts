/**
 * 兩個 loop 在停下來問人時要一樣的三件事（[#2358](https://github.com/DemianLi/nexus-agent/issues/2358)）：
 *
 * - **併發名額**：一顆在問人時讓出名額，排在上限後面的呼叫照樣起跑。`langgraph` 是那顆中斷了就收掉；`native` 是 `ask` 期間把名額還回去。
 *   上限 1 時 LangGraph 會把第一顆之後的呼叫丟掉（`apps/harness/src/settings/agent-loop.ts` 檔頭偏離 0），所以量上限 2、一批三顆。
 * - **工具逾時**：等人的時間不算進工具自己宣告的時限。`langgraph` 接回時從頭重跑、時限重給；`native` 等人時停表、接回後給剩下的。
 *   逾時那一句的「等了多久」兩邊都只算跑的時間。
 * - **中斷 id**：同一顆呼叫問好幾次，id 不變；同一批兩顆各自不同。
 */

import { AIMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { fakeModel } from 'langchain';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { askHuman, interruptIds, LOOPS, loopRun } from './human-input-loops.fixture.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 跑 `ms` 毫秒，把起訖記進 `log`。 */
const worker = (log: string[], name: string, ms: number, safe: boolean) =>
  tool(
    async () => {
      log.push(`${name}:start`);
      await sleep(ms);
      log.push(`${name}:end`);
      return `${name} 好了`;
    },
    {
      name,
      description: name,
      schema: z.object({}),
      ...(safe && { metadata: { concurrencySafe: true } }),
    },
  );

const asker = (log: string[], safe: boolean) =>
  tool(
    async (_input, config) => {
      log.push('ask:start');
      const answer = await askHuman(config, { kind: 'question' });
      log.push(`ask:end(${String(answer)})`);
      return `答覆：${String(answer)}`;
    },
    {
      name: 'ask_it',
      description: '問人。',
      schema: z.object({}),
      ...(safe && { metadata: { concurrencySafe: true } }),
    },
  );

const threeCalls = () =>
  fakeModel()
    .respondWithTools([
      { name: 'ask_it', args: {}, id: 'a' },
      { name: 'slow_b', args: {}, id: 'b' },
      { name: 'slow_c', args: {}, id: 'c' },
    ])
    .respond(new AIMessage('收完'));

describe.each(LOOPS)('%s：併發上限 2、同一批三顆，第一顆問人', (loop) => {
  it('可並行：第三顆在第二顆收完之前就起跑（問人的那顆讓出名額），停住之前兩顆都收完', async () => {
    const log: string[] = [];
    const run = await loopRun(
      loop,
      [asker(log, true), worker(log, 'slow_b', 80, true), worker(log, 'slow_c', 20, true)],
      threeCalls(),
      { maxConcurrency: 2 },
    );
    const parked = await run.start('動手');
    const [id] = interruptIds(parked);
    expect(id).toBeDefined();
    expect(log.indexOf('slow_c:start')).toBeGreaterThan(-1);
    expect(log.indexOf('slow_c:start')).toBeLessThan(log.indexOf('slow_b:end'));
    expect(log).toContain('slow_b:end');
    expect(log).toContain('slow_c:end');

    const resumed = await run.resume({ [id!]: 'A' });
    expect(JSON.stringify(resumed)).toContain('收完');
    expect(log.at(-1)).toBe('ask:end(A)');
  });

  it('獨佔：後兩顆在屏障上等，答完之後照呼叫的先後跑', async () => {
    const log: string[] = [];
    const run = await loopRun(
      loop,
      [asker(log, false), worker(log, 'slow_b', 20, false), worker(log, 'slow_c', 20, false)],
      threeCalls(),
      { maxConcurrency: 2 },
    );
    const parked = await run.start('動手');
    expect(log).toEqual(['ask:start']);
    const [id] = interruptIds(parked);

    const resumed = await run.resume({ [id!]: 'A' });
    expect(JSON.stringify(resumed)).toContain('收完');
    expect(log.slice(log.indexOf('ask:end(A)'))).toEqual([
      'ask:end(A)',
      'slow_b:start',
      'slow_b:end',
      'slow_c:start',
      'slow_c:end',
    ]);
  });
});

/** 宣告 100ms 時限；問人之前跑 `before` 毫秒、答完再跑 `after` 毫秒，`ask: false` 就不問人。 */
const timed = (before: number, after: number, ask = true) =>
  tool(
    async (_input, config) => {
      await sleep(before);
      const answer = ask ? await askHuman(config, { kind: 'question' }) : '沒問';
      await sleep(after);
      return `答覆：${String(answer)}`;
    },
    {
      name: 'timed',
      description: '有時限。',
      schema: z.object({}),
      defaultConfig: { timeout: 100 },
    },
  );

const oneCall = () =>
  fakeModel()
    .respondWithTools([{ name: 'timed', args: {}, id: 't1' }])
    .respond(new AIMessage('收完'));

/** 對話裡逾時那一句，與它講的「等了多久」。 */
function timeoutOf(
  contents: readonly unknown[],
): { sentence: string; elapsedMs: number } | undefined {
  for (const content of contents) {
    const match =
      typeof content === 'string' ? /工具 timed 超時：等了 (\d+)ms.*/.exec(content) : null;
    if (match !== null) return { sentence: match[0], elapsedMs: Number(match[1]) };
  }
  return undefined;
}

/** 跑到收尾：停住就等 `waitMs` 再答，回存檔點上的對話。 */
async function runTimed(
  loop: (typeof LOOPS)[number],
  tool_: ReturnType<typeof timed>,
  waitMs: number,
): Promise<unknown[]> {
  const run = await loopRun(loop, [tool_], oneCall());
  const [id] = interruptIds(await run.start('動手'));
  if (id !== undefined) {
    await sleep(waitMs);
    await run.resume({ [id]: 'A' });
  }
  return run.contents();
}

describe.each(LOOPS)('%s：工具時限 100ms', (loop) => {
  it('問人、300ms 後才答：照常收完，拿到答覆', async () => {
    const contents = await runTimed(loop, timed(0, 0), 300);
    expect(timeoutOf(contents)).toBeUndefined();
    expect(contents).toContain('答覆：A');
  });

  it('對照：不問人、跑 300ms：逾時，講出宣告的預算', async () => {
    const timeout = timeoutOf(await runTimed(loop, timed(300, 0, false), 0));
    expect(timeout?.sentence).toContain('超過它宣告的 100ms 預算');
    expect(timeout!.elapsedMs).toBeGreaterThanOrEqual(100);
  });

  it('問人之前跑 60ms、答完再跑 60ms：逾時；「等了多久」只算跑的那一段，不含等人的 150ms', async () => {
    const timeout = timeoutOf(await runTimed(loop, timed(60, 60), 150));
    expect(timeout?.sentence).toContain('超過它宣告的 100ms 預算');
    expect(timeout!.elapsedMs).toBeGreaterThanOrEqual(100);
    expect(timeout!.elapsedMs).toBeLessThan(200);
  });
});

/** 問兩次。 */
const askTwice = (name: string) =>
  tool(
    async (_input, config) => {
      const first = await askHuman(config, { kind: 'question', n: 1 });
      const second = await askHuman(config, { kind: 'question', n: 2 });
      return `${name}：${String(first)}${String(second)}`;
    },
    { name, description: name, schema: z.object({}), metadata: { concurrencySafe: true } },
  );

describe.each(LOOPS)('%s：中斷 id', (loop) => {
  it('同一批兩顆各自不同；同一顆問第二次沿用第一次的 id', async () => {
    const run = await loopRun(
      loop,
      [askTwice('twice_a'), askTwice('twice_b')],
      fakeModel()
        .respondWithTools([
          { name: 'twice_a', args: {}, id: 'a' },
          { name: 'twice_b', args: {}, id: 'b' },
        ])
        .respond(new AIMessage('收完')),
    );
    const first = interruptIds(await run.start('動手'));
    expect(first).toHaveLength(2);
    expect(new Set(first).size).toBe(2);

    const second = interruptIds(await run.resume({ [first[0]!]: '1', [first[1]!]: '1' }));
    expect(new Set(second)).toEqual(new Set(first));

    const done = await run.resume({ [second[0]!]: '2', [second[1]!]: '2' });
    expect(interruptIds(done)).toEqual([]);
    expect(JSON.stringify(done)).toContain('收完');
  });
});
