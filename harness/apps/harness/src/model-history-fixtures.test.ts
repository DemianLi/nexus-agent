/**
 * 增量推導對出貨寫入器寫的夾具（[#2349](https://github.com/DemianLi/nexus-agent/issues/2349)）：拿 `fixtures/session-format/` 裡的每一份會話，
 * 逐個前綴、以及只在每顆 `model/start` 之前（呼叫端實際的時機），比 {@link ModelHistoryCache} 與 `replayConversation`，三組選項各一次（不套、換預覽並套剪法與縮短、共用讀盤的事件）。
 * 事件從 store 讀回，是凍過、共用的那一種，跟讀方實際拿到的一樣。手寫日誌的對照與每種重建事件的紅燈在 core 的 `model-history.test.ts`。
 */

import { cp, mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelHistoryCache, replayConversation, toBaseMessage, toLoggedMessage } from '@nexus/core';
import type { DerivedConversation, ModelHistoryOptions } from '@nexus/core';

import { toolResultAsSeen } from './conversation-restore.js';
import { openJsonlSessionStore } from './jsonl-session-store.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/session-format/', import.meta.url));
const names = readdirSync(FIXTURES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const idsOf = (name: string): string[] =>
  Object.keys(
    (
      JSON.parse(readFileSync(join(FIXTURES, name, 'expected.json'), 'utf8')) as {
        sessions: Record<string, unknown>;
      }
    ).sessions,
  ).sort();

const OPTIONS: readonly (readonly [string, ModelHistoryOptions])[] = [
  ['不套', {}],
  [
    '送給模型的那一份',
    { toolResultAsSeen, applyPrunes: true, applyArgTruncations: true, applyImageOffloads: true },
  ],
  ['共用讀盤的事件', { shareStored: true }],
];

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'nexus-model-history-'));
  // 舊格式的回覆只有 `additional_kwargs.tool_calls`，LangChain 的建構子會印一行升級提醒。
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

function serialized(replay: ReturnType<typeof replayConversation> | DerivedConversation): unknown {
  return replay.kind === 'replayed'
    ? replay.messages.map((message) =>
        JSON.stringify(toLoggedMessage('data' in message ? toBaseMessage(message) : message)),
      )
    : replay;
}

describe.each(names)('夾具 %s', (name) => {
  it.each(idsOf(name))('%s：每個前綴，增量與整份重算逐則相同', async (id) => {
    const directory = join(scratch, name);
    await cp(join(FIXTURES, name), directory, { recursive: true });
    const events = await (await openJsonlSessionStore({ directory }).open(id, 'read')).read();
    const strides = {
      逐顆: events.map((_, k) => k).concat(events.length),
      'model/start 之前': events.flatMap((event, k) => (event.type === 'model/start' ? [k] : [])),
    };
    for (const [label, options] of OPTIONS) {
      for (const [stride, cuts] of Object.entries(strides)) {
        const cache = new ModelHistoryCache(options);
        for (const k of cuts) {
          const prefix = events.slice(0, k);
          expect(
            serialized(cache.derive(prefix)),
            `${label}，${stride}，前 ${String(k)} 顆`,
          ).toEqual(serialized(replayConversation(prefix, options)));
        }
      }
    }
  });
});
