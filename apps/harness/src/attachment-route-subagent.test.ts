/**
 * 附件路由與子代理：**背景子代理**與**冷復活的子代理**讀的也是 root 日誌的引用集（[#1782](https://github.com/DemianLi/nexus-agent/issues/1782)，
 * 接 #1773）。前景子代理在 `attachment-route.test.ts` 的產品路徑那一格；這個檔補另外兩條派出路徑。
 *
 * **為什麼要各測一次**：三條路徑共用同一份 backend（`agent-factory.ts` 組裝時建一個 `attachmentScope`、`attachSession` 綁 root 日誌），
 * 但子代理的圖是各自編的、冷復活還要從落盤重建——哪一天有人替背景或冷復活的子代理另做一份 backend，前景的測試不會紅。
 *
 * 做法：兩個檔，`f` 被 root 的 `turn/start` 引用、`g` 沒有（等同「別條 thread 上傳的」）。子代理一輪同時 `read_file` 兩者：
 * 讀得到 `f`、讀不到 `g`（錯誤與不存在的檔相同）。**全走產品組裝**：`createNexusAgent`＋腳本模型＋`ThreadPump`＋`attachSession`；
 * 冷復活那一格另用真的 JSONL 存放處，第二個行程用全新的 `MemorySaver` 從落盤接回 root。
 *
 * 突變（各自單獨做，做完還原，結果記在 PR）：
 *
 * 1. `agent-factory.ts` 的 `attachmentScope.bind(sessions.root)` 拿掉 → 兩格的「讀得到 f」都紅。
 * 2. `ThreadScopedAttachmentBackend.read` 的可見判斷拿掉 → 兩格的「讀不到 g」都紅。
 *
 * **零憑證、零外部連線**：模型是腳本，儲存放 `/var/tmp`。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { attachSessionPersistence, resumeClosingInterruptedTurn, subagentLinks } from '@nexus/core';
import type { PluginEntry } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { AttachmentStore, attachmentsRootOf } from './attachment-store.js';
import { createColdChildStore } from './background-cold.js';
import { createJsonlSessionStore, openJsonlSessionStore } from './jsonl-session-store.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const ROOT = 'attachment-root';
const SECRET_F = 'KOHAKU-F-7731';
const SECRET_G = 'KOHAKU-G-9942';

let dir: string;
let store: AttachmentStore;
/** 第一個行程建出來的日誌目錄；之後的「行程」重新打開同一個。 */
let logDirectory: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join('/var/tmp', 'nexus-attachment-subagent-'));
  store = new AttachmentStore(attachmentsRootOf(dir));
  logDirectory = undefined;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function openLogs() {
  if (logDirectory === undefined) {
    const created = createJsonlSessionStore({ rootDir: join(dir, 'logs') });
    logDirectory = created.directory;
    return created;
  }
  return openJsonlSessionStore({ directory: logDirectory });
}

async function until(predicate: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** 存兩個檔：`f` 之後由 root 引用，`g` 不引用。 */
async function putBoth() {
  const save = async (text: string, name: string) => {
    const saved = await store.save({ data: Buffer.from(text), name });
    return {
      ref: { type: 'file' as const, ...saved },
      modelPath: store.modelPathOf(saved),
    };
  };
  return { f: await save(`${SECRET_F}\n`, 'f.txt'), g: await save(`${SECRET_G}\n`, 'g.txt') };
}

const worker = (model: ScriptedChatModel): PluginEntry => ({
  plugin: {
    name: 'attachment-worker-host',
    apply(registry) {
      registry.subagents.register({
        name: 'reader',
        description: '讀檔的。',
        systemPrompt: '你是 reader。',
        model: model as never,
      });
    },
  },
});

const delegate: ScriptedTurn = {
  content: '委派。',
  toolCalls: [
    {
      name: 'subagent',
      id: 'call-reader',
      args: { description: '讀檔', subagent_type: 'reader', run_in_background: true },
    },
  ],
};

const readBoth = (fPath: string, gPath: string): ScriptedTurn => ({
  content: '',
  toolCalls: [
    { name: 'read_file', id: 'read-f', args: { file_path: fPath } },
    { name: 'read_file', id: 'read-g', args: { file_path: gPath } },
  ],
});

/** 子代理模型最後一次收到的 prompt 裡，兩個 `read_file` 結果的文字（依呼叫編號）。 */
function toolTextByCall(prompt: readonly BaseMessage[]): Record<string, string> {
  const byCall: Record<string, string> = {};
  for (const message of prompt) {
    if (message.getType() !== 'tool') continue;
    const id = (message as unknown as { tool_call_id: string }).tool_call_id;
    byCall[id] = JSON.stringify(message.content);
  }
  return byCall;
}

function expectReadsFOnly(prompt: readonly BaseMessage[]): void {
  const results = toolTextByCall(prompt);
  expect(results['read-f']).toContain(SECRET_F);
  expect(results['read-g']).not.toContain(SECRET_G);
  expect(results['read-g']).toMatch(/ENOENT|not found|Error/iu);
}

interface Booted {
  readonly pump: ThreadPump;
  readonly detach: ReturnType<Awaited<ReturnType<typeof createNexusAgent>>['attachSession']>;
  readonly shutdown: () => Promise<void>;
}

async function boot(options: {
  readonly rootTurns: ScriptedTurn[];
  readonly workerModel: ScriptedChatModel;
  readonly persist?: { readonly resume: boolean };
}): Promise<Booted> {
  const logs = options.persist === undefined ? undefined : openLogs();
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns: options.rootTurns }),
    checkpointer: new MemorySaver(),
    plugins: [worker(options.workerModel)],
    attachments: store,
    summarization: false,
    observationPolicy: false,
    backgroundSubagents: {
      maxActive: 4,
      ...(logs !== undefined && { cold: createColdChildStore(logs) }),
    },
  });
  const resumed =
    logs !== undefined && options.persist?.resume === true
      ? await resumeClosingInterruptedTurn(logs, ROOT)
      : undefined;
  const pump = new ThreadPump(
    built.agent as unknown as PumpAgent,
    ROOT,
    undefined,
    resumed?.events,
  );
  const detach = built.attachSession(pump.sessions, {});
  const persistence =
    logs === undefined
      ? undefined
      : attachSessionPersistence(pump.sessions, logs, {
          ...(resumed !== undefined && {
            resumedRoot: { stored: resumed.stored, storedCount: resumed.events.length },
          }),
        });
  return {
    pump,
    detach,
    shutdown: async () => {
      await persistence?.dispose();
      detach();
      await built.dispose();
    },
  };
}

describe('附件路由跟著 root 日誌：背景與冷復活的子代理', () => {
  it('背景子代理：讀得到 root 引用過的 f，讀不到沒引用過的 g', async () => {
    const { f, g } = await putBoth();
    const workerModel = new ScriptedChatModel({
      turns: [readBoth(f.modelPath, g.modelPath), { content: '讀完了' }],
    });
    const run = await boot({
      rootTurns: [delegate, { content: '根收尾' }],
      workerModel,
    });
    try {
      await run.pump.submit({ kind: 'message', text: '讀', attachments: [f.ref] });
      await run.pump.whenIdle();
      const children = run.pump.sessions
        .list()
        .filter((entry) => entry.address.kind === 'subagent');
      expect(children).toHaveLength(1);
      await until(() =>
        children.every((entry) => entry.log.events.some((event) => event.type === 'turn/end')),
      );
      expectReadsFOnly(workerModel.lastPrompt);
    } finally {
      await run.shutdown();
    }
  }, 30000);

  it('冷復活的子代理：重啟後被叫醒，讀的是接回來的 root 日誌的引用集', async () => {
    const { f, g } = await putBoth();

    // 第一個行程：root 帶著 f 的引用派出背景子代理、跑到 idle、整個收掉（日誌落盤）。
    const first = await boot({
      rootTurns: [delegate, { content: '根收尾' }],
      workerModel: new ScriptedChatModel({ turns: [{ content: '待命' }] }),
      persist: { resume: false },
    });
    await first.pump.submit({ kind: 'message', text: '派', attachments: [f.ref] });
    await first.pump.whenIdle();
    const links = subagentLinks(first.pump.sessions.root.events);
    expect(links).toHaveLength(1);
    const runId = links[0]!.childId.slice(`${ROOT}/`.length);
    const children = first.pump.sessions
      .list()
      .filter((entry) => entry.address.kind === 'subagent');
    await until(() =>
      children.every((entry) => entry.log.events.some((event) => event.type === 'turn/end')),
    );
    await first.shutdown();

    // 第二個行程：全新的 MemorySaver 與模型，從落盤接回 root；對舊編號送話把冷的叫醒，它這一輪去讀兩個檔。
    const workerModel = new ScriptedChatModel({
      turns: [readBoth(f.modelPath, g.modelPath), { content: '讀完了' }],
    });
    const second = await boot({
      rootTurns: [{ content: '根' }],
      workerModel,
      persist: { resume: true },
    });
    try {
      // 還沒送話：冷的沒有被叫過。
      expect(workerModel.prompts).toEqual([]);
      await second.detach.background!.sendFromUser(runId, '讀檔');
      await until(() => workerModel.prompts.length >= 2);
      expectReadsFOnly(workerModel.lastPrompt);
    } finally {
      await second.shutdown().catch(() => undefined);
    }
  }, 30000);
});
