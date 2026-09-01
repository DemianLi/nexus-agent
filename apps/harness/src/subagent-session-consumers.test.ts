/**
 * **subagent 的那份日誌，三個消費者一個都不能少**——
 * [#137](https://github.com/DemianLi/nexus-agent/issues/137) 的第四條驗收。
 *
 * 一份日誌今天被三樣東西訂閱：不變量 runner、`sessions` 參與者 runner、遙測協調器。
 * 在會話註冊表出現之前，接線是**組裝點手做的一步，一次接一份**——所以第二份日誌不重接
 * 就沒有檢查、沒有參與者、也不進遙測，而**三件事都是靜默的**。這一檔就是那三個靜默失敗
 * 的絆索。
 *
 * **它們不是三個政策決定。** dsh 那側沒有「要不要接」這個問題：消費者訂的是 session
 * 註冊表，不是一份 session（`packages/core/session/src/invariant.ts:218-220` 的
 * `for (const session of ctx.sessions.list())` 加 `ctx.on('session/created', …)`；遙測的
 * coordinator 檔頭寫的是 “subscribes to the session firehose”）。我們把那個結構補起來，
 * 三題就一起消失了。調研見 `.docs/subagent-session-log-survey.md`。
 *
 * **零憑證、零外部連線**：後端是測試自己的假貨，模型是 `ScriptedChatModel`。
 */

import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SessionRegistry } from '@nexus/core';
import type { NexusPlugin, SessionTelemetryRecord, SessionTelemetryService } from '@nexus/core';
import { createNexusAgent } from './agent-factory.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

const WRITER_TOOL_NAME = 'writer_tool';
const ROOT_ID = 'consumers';

/** 三位消費者各自看到的 `(日誌 id, 事件種類)`。 */
interface Seen {
  readonly invariants: string[];
  readonly participants: string[];
  readonly telemetry: SessionTelemetryRecord[];
}

function collectingSink(records: SessionTelemetryRecord[]): SessionTelemetryService {
  return {
    sharing: 'full',
    emit: (record) => void records.push(record),
    shutdown: () => Promise.resolve(),
  };
}

/**
 * 一個 plugin 掛上全部四樣：會寫日誌的工具、一個 subagent，以及三位消費者。
 *
 * **四樣掛在同一個 `apply` 裡是刻意的**：這一檔問的正是「同一次組裝裡，後來才出生的那份
 * 日誌有沒有被同一批消費者接上」。拆成四個 plugin 問的是另一個問題。
 */
function observingPlugin(seen: Seen): NexusPlugin {
  return {
    name: 'observing',
    apply(registry) {
      registry.tools.register(
        tool(
          ({ note }: { note: string }, config?: unknown) => {
            const found = registry.sessions.forCall(config);
            if (found.kind !== 'ok') return `寫不進去：${found.kind}`;
            found.log.append('turn/failed', { message: note });
            return '記了一筆。';
          },
          {
            name: WRITER_TOOL_NAME,
            description: '把一句話記進會話日誌。',
            schema: z.object({ note: z.string() }),
          },
        ),
      );
      registry.subagents.register({ name: 'worker', description: '幹活的。' });

      registry.invariants.register('@nexus/observing', (subject) => {
        subject.observe(
          (event) => void seen.invariants.push(`${subject.log.sessionId}/${event.type}`),
        );
      });
      registry.sessions.join((subject) => {
        subject.observe(
          (event) => void seen.participants.push(`${subject.log.sessionId}/${event.type}`),
        );
      });
      registry.telemetry.use(collectingSink(seen.telemetry));
    },
  };
}

describe('subagent 的日誌與三個消費者', () => {
  it('三個都自動接上了——沒有人記得替第二份日誌重接', async () => {
    const model = new ScriptedChatModel({
      turns: [
        { content: '根記一筆。', toolCalls: [{ name: WRITER_TOOL_NAME, args: { note: '根' } }] },
        {
          content: '委派。',
          toolCalls: [{ name: 'task', args: { description: '幹活', subagent_type: 'worker' } }],
        },
        {
          content: '子代理記一筆。',
          toolCalls: [{ name: WRITER_TOOL_NAME, args: { note: '子代理' } }],
        },
        { content: '子代理收工。' },
        { content: '根收工。' },
        { content: '根再收一次。' },
      ],
    });
    const seen: Seen = { invariants: [], participants: [], telemetry: [] };
    const { agent, attachTelemetry, attachInvariants, attachSession, dispose } =
      await createNexusAgent({
        model,
        checkpointer: new MemorySaver(),
        plugins: [observingPlugin(seen)],
      });
    const sessions = new SessionRegistry(ROOT_ID);
    // 順序同兩條進入點：遙測、不變量、參與者。
    const detachTelemetry = attachTelemetry(sessions);
    const detachInvariants = attachInvariants(sessions);
    const detachSession = attachSession(sessions);

    try {
      await agent.invoke(toAgentInvocation('跑。'), { configurable: { thread_id: ROOT_ID } });
    } finally {
      detachSession();
      detachInvariants?.();
      await detachTelemetry?.();
      await dispose();
    }

    const subagent = sessions.list().find((entry) => entry.address.kind === 'subagent');
    expect(subagent).toBeDefined();
    const subagentId = subagent!.log.sessionId;

    // **不變量**：接了才擋得住 subagent 寫壞狀態；不接就是一個沒有檢查的角落。
    expect(seen.invariants).toContain(`${subagentId}/turn/failed`);
    // **參與者**：接了才有人在摺 subagent 那份日誌的狀態。
    expect(seen.participants).toContain(`${subagentId}/turn/failed`);
    // **遙測**：接了 subagent 的事件才出得去。
    expect(
      seen.telemetry
        .filter((record) => record.channel === 'ledger')
        .map((record) => record.attributes['session.id']),
    ).toContain(subagentId);

    // 三個都同時看得到 root 那份——新結構不是把 root 換成 subagent，是兩份都有。
    expect(seen.invariants).toContain(`${ROOT_ID}/turn/failed`);
    expect(seen.participants).toContain(`${ROOT_ID}/turn/failed`);
  });
});
