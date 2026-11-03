import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BaseMessage } from '@langchain/core/messages';
import type { ConversationState, Event, HostToolDeclaration, WireClient } from '@nexus/wire';
import {
  createWireClient,
  EMBED_PATH_PREFIX,
  emptyConversation,
  isApprovalPending,
  reduceConversation,
  uniformDecisions,
} from '@nexus/wire';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { approvalAt, exchangeServeToken, fetchWithCookie } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import { startScriptedServe } from './scripted-serve.js';
import type { ScriptedServe } from './scripted-serve.js';
import { sessionOf } from './session-files.fixture.js';

let served: ScriptedServe | undefined;
const temps: string[] = [];
let bound: string[][];
let prompts: BaseMessage[][];

beforeEach(() => {
  bound = [];
  prompts = [];
  const stream = ScriptedChatModel.prototype._streamResponseChunks;
  vi.spyOn(ScriptedChatModel.prototype, '_streamResponseChunks').mockImplementation(function (
    this: ScriptedChatModel,
    ...args
  ) {
    bound.push(this.boundTools.map((tool) => (tool as { name: string }).name));
    prompts.push(args[0]);
    return stream.apply(this, args);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await served?.close();
  served = undefined;
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const focus: HostToolDeclaration = {
  name: 'focus_device',
  description: '把鏡頭轉到指定設備',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

it('試驗：核准 → host_tool → 回應 → 接著回', async () => {
  const logs = mkdtempSync(join(tmpdir(), 'nexus-host-trial-'));
  temps.push(logs);
  served = await startScriptedServe(
    [
      { content: '轉。', toolCalls: [{ name: 'page__focus_device', args: { id: 'P-101' } }] },
      { content: '轉好了。' },
    ],
    { argv: ['--session-log', logs] },
  );
  const cookie = await exchangeServeToken(served.running.authenticatedUrl);
  const fetch = fetchWithCookie(cookie);
  const embed: WireClient = createWireClient({
    baseUrl: `${served.running.url}${EMBED_PATH_PREFIX}`,
    fetch,
  });
  const events = await embed.openEvents('e1');
  let state = emptyConversation();
  const until = async (done: (s: ConversationState) => boolean): Promise<void> => {
    while (!done(state)) {
      const next = await events.next();
      if (next.done === true) throw new Error('斷了');
      state = reduceConversation(state, next.value as Event);
    }
  };
  const sent = await embed.runStart('e1', '轉到 P-101', { hostTools: [focus] });
  console.log('sent', JSON.stringify(sent));
  expect(sent).not.toHaveProperty('error');
  await until((s) => s.pendings.some(isApprovalPending) || s.hostCalls.length > 0 || s.status === 'idle' && s.entries.length > 1);
  console.log('bound', JSON.stringify(bound));
  console.log('state1', JSON.stringify({ status: state.status, pendings: state.pendings, hostCalls: state.hostCalls }));
  const approval = approvalAt(state.pendings);
  await embed.inputRespond('e1', {
    namespace: [...approval.namespace],
    interrupt_id: approval.interruptId,
    response: uniformDecisions(approval, 'approve'),
  });
  await until((s) => s.hostCalls.length > 0);
  console.log('state2', JSON.stringify({ status: state.status, hostCalls: state.hostCalls }));
  const call = state.hostCalls[0]!;
  console.log('ids', approval.interruptId, call.interruptId);
  await embed.inputRespond('e1', {
    namespace: [...call.namespace],
    interrupt_id: call.interruptId,
    response: { ok: true, result: { focused: 'P-101' } },
  });
  await until(
    (s) =>
      s.status === 'idle' &&
      s.entries.filter((entry) => entry.kind === 'ai' && !entry.streaming).length >= 2,
  );
  await events.return(undefined);
  console.log('last prompt', JSON.stringify(prompts.at(-1)?.map((m) => [m.getType(), m.content])));
  await served.close();
  served = undefined;
  const log = await sessionOf(logs, 'e1');
  copyFileSync(log.logPath, '/private/tmp/claude-501/-Users-demian-Projects-vibecoding-project-nexus-agent--claude-worktrees-pm-dev-h2-c65143/5458547d-3dfe-4b30-a377-fe716199ffa7/scratchpad/trial-log.jsonl');
  const lines = readFileSync(log.logPath, 'utf8').trim().split('\n').slice(1);
  for (const line of lines) {
    const e = JSON.parse(line) as { type: string; data: unknown };
    if (/approval|interrupt|host-tools|tool\/|turn\//u.test(e.type))
      console.log('log', e.type, JSON.stringify(e.data).slice(0, 300));
  }
}, 60_000);
