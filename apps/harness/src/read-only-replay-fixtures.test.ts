/**
 * 只讀推回對得上深拷的那一支（[#2117](https://github.com/DemianLi/nexus-agent/issues/2117)）：拿 `fixtures/session-format/` 裡各版出貨寫入器寫的夾具，
 * 比 `replayConversation` 開不開 `readOnly`、`toolCallIds` 與直接深拷推回的工具呼叫 id。store 交出的事件是凍過、共用的（`shareStoredEvents`），
 * 跟讀方實際拿到的是同一種輸入。
 */

import { cp, mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AIMessage } from '@langchain/core/messages';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fromLoggedMessage, replayConversation, toolCallIds } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';

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

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'nexus-read-only-replay-'));
  // 舊格式的回覆只有 `additional_kwargs.tool_calls`，LangChain 的建構子會印一行升級提醒。
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

function summary(replay: ReturnType<typeof replayConversation>): unknown {
  return replay.kind === 'replayed'
    ? { kind: replay.kind, messages: replay.messages.map((message) => message.toDict()) }
    : { kind: replay.kind, reason: replay.reason, seq: replay.seq };
}

function copiedCallIds(event: SessionEvent<'assistant/message'>): string[] {
  const message = fromLoggedMessage(event.data.message);
  if (!AIMessage.isInstance(message)) return [];
  return (message.tool_calls ?? []).flatMap((call) =>
    typeof call.id === 'string' && call.id !== '' ? [call.id] : [],
  );
}

describe.each(names)('夾具 %s', (name) => {
  it.each(idsOf(name))('%s：只讀推回跟深拷的一樣', async (id) => {
    const directory = join(scratch, name);
    await cp(join(FIXTURES, name), directory, { recursive: true });
    const events = await (await openJsonlSessionStore({ directory }).open(id, 'read')).read();
    expect(Object.isFrozen(events[0]?.data)).toBe(true);
    expect(summary(replayConversation(events, { readOnly: true }))).toEqual(
      summary(replayConversation(events)),
    );
    const replies = events.filter(
      (event): event is SessionEvent<'assistant/message'> => event.type === 'assistant/message',
    );
    for (const reply of replies) expect(toolCallIds(reply)).toEqual(copiedCallIds(reply));
  });
});
