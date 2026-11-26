/**
 * 評分要等落盤（[#1606](https://github.com/DemianLi/nexus-agent/issues/1606)）的 serve 那一半：驗收 D、E。真的 `runServe`（腳本模型）、
 * 真的 wire client，指名用的是折疊器折出來的 `AiEntry.messageId`。樹那一側的 A、B、C 在 `feedback-durability.test.ts`。
 *
 * - **E（落盤開著）**：put 回 ok，list 讀得到。入口沒把 store 交給樹（`bindDurableStore`）或樹上沒掛 `session-durability` 那一列時，
 *   這一格是 `unknown_error`／`not_supported`，所以它守的是 serve 這一側的接線。
 * - **E（清單把落盤關掉）**：put／list／delete 回 `not_supported`，訊息是拍板的那一句；評語與 `/feedback` 照常。
 * - **D**：同一則訊息兩個 `ifVersion: null` 同時送，恰好一個 ok、一個 `version-conflict`。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConversationState, WireClient } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { foldTurn, serveClient } from './fixtures.js';
import { startScriptedServe } from './scripted-serve.js';
import type { ScriptedServe } from './scripted-serve.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const PERSISTENCE_OFF_ROW = `- id: session-persistence
  disabled: true
`;

/** 一台 serve，跑完一輪，回 client 與那則回覆的訊息 id。 */
async function answered(
  thread: string,
  options: { persistence: boolean },
): Promise<{ client: WireClient; messageId: string }> {
  const sessionLog = await mkdtemp(join(tmpdir(), 'nexus-feedback-serve-'));
  cleanups.push(() => rm(sessionLog, { recursive: true, force: true }));
  // 關掉落盤時不能給 --session-log（serve 當場拒那個矛盾）。
  const serve: ScriptedServe = await startScriptedServe(
    [{ content: '答。' }],
    options.persistence
      ? { argv: ['--session-log', sessionLog] }
      : { extraRows: PERSISTENCE_OFF_ROW },
  );
  cleanups.push(() => serve.close());
  const client = await serveClient(serve.running);
  const events = await client.openEvents(thread);
  expect((await client.runStart(thread, '問。')).type).toBe('success');
  const state: ConversationState = await foldTurn(events);
  await events.return?.(undefined);
  const messageId = state.entries.flatMap((entry) =>
    entry.kind === 'ai' && entry.messageId !== undefined ? [entry.messageId] : [],
  )[0];
  if (messageId === undefined) throw new Error('這一輪沒有折出帶 messageId 的回覆');
  return { client, messageId };
}

describe('serve：落盤開著', () => {
  it('E：put 回 ok、list 讀得到（入口把 store 交給了樹、樹上掛著落盤確認）', async () => {
    const { client, messageId } = await answered('t-on', { persistence: true });
    const put = await client.feedbackPut('t-on', {
      messageId,
      rating: 'positive',
      ifVersion: null,
    });
    expect(put).toMatchObject({ kind: 'ok', result: { ok: true, value: { messageId } } });
    const listed = await client.feedbackList('t-on');
    expect(listed).toMatchObject({ kind: 'ok', result: { ok: true } });
    expect(listed.kind === 'ok' && listed.result.ok && listed.result.value.items).toHaveLength(1);
  });

  it('D：同一則兩個 ifVersion: null 同時送，恰好一個 ok、一個 version-conflict', async () => {
    const { client, messageId } = await answered('t-race', { persistence: true });
    const results = await Promise.all(
      (['positive', 'negative'] as const).map((rating) =>
        client.feedbackPut('t-race', { messageId, rating, ifVersion: null }),
      ),
    );
    const outcomes = results.map((result) => {
      if (result.kind !== 'ok') throw new Error(`被拒了：${result.message}`);
      return result.result.ok ? 'ok' : result.result.error.code;
    });
    expect(outcomes.sort()).toEqual(['ok', 'version-conflict']);
  });
});

describe('serve：清單把落盤關掉', () => {
  it('E：put／list／delete 回 not_supported（拍板那一句），評語與 /feedback 照常', async () => {
    const { client, messageId } = await answered('t-off', { persistence: false });
    const refused = {
      kind: 'rejected',
      code: 'not_supported',
      message: '這個組裝沒有掛落盤，評分存不住',
    };
    expect(
      await client.feedbackPut('t-off', { messageId, rating: 'positive', ifVersion: null }),
    ).toEqual(refused);
    expect(await client.feedbackList('t-off')).toEqual(refused);
    expect(await client.feedbackDelete('t-off', { messageId, ifVersion: 'v' })).toEqual(refused);

    expect(await client.feedbackRecord('t-off', { text: '還行' })).toMatchObject({
      kind: 'ok',
      result: { ok: true },
    });
    const listed = await client.slashList('t-off');
    if (listed.kind !== 'ok') throw new Error(`slash.list 失敗：${JSON.stringify(listed)}`);
    expect(listed.commands.map((command) => command.name)).toContain('feedback');
  });
});
