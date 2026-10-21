/**
 * 模型讀附件的路由只露出**這條 thread 的日誌引用過的檔案**（[#1773](https://github.com/DemianLi/nexus-agent/issues/1773)）。
 *
 * 前半是 backend 層：真的 `AttachmentStore`（檔案真的存在 `files/` 底下），scope 是可變的事件陣列，逐個動作（`read`、`readRaw`、
 * `downloadFiles`、`ls`、`glob`、`grep`）量「看得到／看不到」，以及「看不到」跟「不存在」逐字一樣。後半是產品路徑：真的
 * `createNexusAgent`＋`ThreadPump`，兩條 thread 共用同一個儲存，A 的前景子代理讀得到 A 引用過的檔，B 的讀不到。
 *
 * 突變（各自單獨做，做完還原，結果記在 PR）：
 *
 * 1. `ThreadScopedAttachmentBackend.read` 的可見判斷拿掉（一律交給 super）→ 「B 讀不到 A 的檔」紅。
 * 2. `ls`／`glob` 的 `filter` 拿掉 → 「ls／glob 只剩引用過的」紅。
 * 3. `grep` 的 `visible.files.has(match.path)` 拿掉 → 「grep 只搜得到引用過的」紅。
 * 4. `createAttachmentScope` 的 `events` 改成綁定當下快取一份 → 「呼叫當下才判」紅。
 * 5. `referencedFilePaths` 不比檔名（只用雜湊找同目錄的所有別名）→ 「檔名別名各自一條」紅。
 * 6. `agent-factory.ts` 的 `attachmentScope.bind(sessions.root)` 拿掉 → 產品路徑「A 的子代理讀得到」紅（綁不上就什麼都不露出）。
 * 7. `readRaw`、`downloadFiles` 的可見判斷各自拿掉 → 對應的「跟不存在逐字一樣」紅。
 *
 * **零憑證、零外部連線**：模型是腳本，儲存放 `/var/tmp`。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import type { AttachmentRef, SessionEvent } from '@nexus/core';
import type { Event } from '@nexus/wire';
import { GENERAL_PURPOSE_SUBAGENT } from 'deepagents';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { createAttachmentScope, ThreadScopedAttachmentBackend } from './attachment-route.js';
import { AttachmentStore, attachmentsRootOf, ATTACHMENTS_PREFIX } from './attachment-store.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const event = (type: string, data: unknown): SessionEvent =>
  ({ type, seq: 0, time: 0, data }) as unknown as SessionEvent;

const turnStart = (...refs: object[]) =>
  event('turn/start', { kind: 'message', text: 't', attachments: refs });

let home: string;
let store: AttachmentStore;

beforeEach(async () => {
  home = await mkdtemp(join('/var/tmp', 'nexus-attachment-route-'));
  store = new AttachmentStore(attachmentsRootOf(home));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** 存一份檔案，回日誌上的檔案參照與它在路由底下的路徑。 */
async function put(text: string, name: string) {
  const saved = await store.save({ data: Buffer.from(text), name });
  const ref = { type: 'file' as const, ...saved };
  return { ref, path: store.modelPathOf(saved).slice(ATTACHMENTS_PREFIX.length) };
}

/** 一個綁在可變事件陣列上的路由。 */
async function routeOver(events: SessionEvent[]) {
  const scope = createAttachmentScope();
  const unbind = scope.bind({ events });
  return { route: await store.readOnlyRoute(scope), unbind, scope };
}

describe('路由只露出這條 thread 日誌引用過的檔', () => {
  it('A 引用過的檔 B 讀不到，B 引用過的 A 讀不到；各自讀得到自己的', async () => {
    const a = await put('alpha-secret\n', 'a.txt');
    const b = await put('beta-secret\n', 'b.txt');
    const forA = await routeOver([turnStart(a.ref)]);
    const forB = await routeOver([turnStart(b.ref)]);

    expect(JSON.stringify(await forA.route.read(a.path))).toContain('alpha-secret');
    expect(JSON.stringify(await forB.route.read(b.path))).toContain('beta-secret');
    expect((await forB.route.read(a.path)).error).toBeDefined();
    expect(JSON.stringify(await forB.route.read(a.path))).not.toContain('alpha-secret');
    expect((await forA.route.read(b.path)).error).toBeDefined();
  });

  it('沒引用過的路徑，read、readRaw、downloadFiles 的回覆與「檔不存在」逐字相同', async () => {
    const a = await put('alpha-secret\n', 'a.txt');
    const hidden = await routeOver([]);
    const before = {
      read: await hidden.route.read(a.path),
      readRaw: await hidden.route.readRaw(a.path).then(
        () => 'resolved',
        (error: unknown) => (error as Error).message,
      ),
      download: await hidden.route.downloadFiles([a.path]),
    };

    // 同一個路徑，檔真的被刪掉、日誌引用它：基座自己回的「不存在」。
    await rm(store.pathOf(a.ref), { force: true });
    const gone = await routeOver([turnStart(a.ref)]);
    const after = {
      read: await gone.route.read(a.path),
      readRaw: await gone.route.readRaw(a.path).then(
        () => 'resolved',
        (error: unknown) => (error as Error).message,
      ),
      download: await gone.route.downloadFiles([a.path]),
    };

    expect(before.read.error).toBeDefined();
    expect(before).toEqual(after);
  });

  it('ls／glob 只剩引用過的條目；沒引用過的目錄 ls 是空的', async () => {
    const a = await put('alpha\n', 'a.txt');
    const b = await put('beta\n', 'b.txt');
    const { route } = await routeOver([turnStart(a.ref)]);

    const top = await route.ls('/');
    expect(top.files?.map((f) => f.path)).toEqual([`/${a.path.split('/')[1]}/`]);
    const hexDir = a.path.split('/').slice(0, 3).join('/');
    expect((await route.ls(hexDir)).files?.map((f) => f.path)).toEqual([a.path]);
    // B 的目錄：不存在的目錄 ls 是空的，沒引用過的存在的目錄一樣。
    expect((await route.ls(b.path.split('/').slice(0, 3).join('/'))).files).toEqual([]);
    expect((await route.ls(b.path)).files).toEqual([]);

    const globbed = await route.glob('**/*');
    expect(globbed.files?.filter((f) => f.is_dir !== true).map((f) => f.path)).toEqual([a.path]);
  });

  it('grep 只搜得到引用過的；沒引用過的檔再多命中也不吃掉上限', async () => {
    const a = await put('needle once\n', 'a.txt');
    // 同樣的位元組、另一個檔名：落在同一個 /前兩碼/hex 目錄，目錄會被搜到，但這條別名沒被引用過。
    const alias = await put('needle once\n', 'alias.txt');
    expect(alias.path.split('/')[2]).toBe(a.path.split('/')[2]);
    await put('needle\n'.repeat(20), 'b.txt');
    const { route } = await routeOver([turnStart(a.ref)]);

    const found = await route.grep('needle', '/');
    expect(found.matches?.map((m) => m.path)).toEqual([a.path]);
    const capped = await route.grep('needle', '/', null, 2);
    expect(capped.matches?.map((m) => m.path)).toEqual([a.path]);
    // 搜尋起點直接是一份看得到的檔案，與一份看不到的。
    expect((await route.grep('needle', a.path)).matches?.map((m) => m.path)).toEqual([a.path]);
  });

  it('grep 引用了 200 份檔也只起一次 rg；結果與截斷照引用集算（#1782）', async () => {
    const refs: AttachmentRef[] = [];
    const paths: string[] = [];
    // 二十份一批並行存：一份一份存要 6 秒多（每份都落盤），一次全開又怕撞檔案描述符上限。
    for (let batch = 0; batch < 10; batch += 1) {
      const saved = await Promise.all(
        Array.from({ length: 20 }, (_, k) => {
          const i = batch * 20 + k;
          return put(`needle ${String(i)}\n`, `f${String(i)}.txt`);
        }),
      );
      for (const one of saved) {
        refs.push(one.ref);
        paths.push(one.path);
      }
    }
    // 沒被引用的檔：同樣含 needle，不該出現在結果裡。
    await put('needle hidden\n', 'hidden.txt');
    const spawns: (readonly string[])[] = [];
    const scope = createAttachmentScope();
    scope.bind({ events: [turnStart(...refs)] });
    const route = new ThreadScopedAttachmentBackend({
      rootDir: store.filesDir,
      scope,
      ripgrep: { onSpawn: (argv) => spawns.push(argv) },
    });

    const all = await route.grep('needle', '/');
    expect(spawns).toHaveLength(1);
    expect(all.matches?.map((m) => m.path).sort()).toEqual([...paths].sort());
    expect(all.truncated).toBeUndefined();

    spawns.length = 0;
    const capped = await route.grep('needle', '/', null, 5);
    expect(spawns).toHaveLength(1);
    expect(capped.matches).toHaveLength(5);
    expect(capped.truncated).toBe(true);
  }, 30000);

  it('起點裡有一個不存在就略過它、其餘照搜；0 份引用時一次 rg 都不起（#1782）', async () => {
    const a = await put('needle a\n', 'a.txt');
    const b = await put('needle b\n', 'b.txt');
    const spawns: (readonly string[])[] = [];
    const routeFor = (events: SessionEvent[]) => {
      const scope = createAttachmentScope();
      scope.bind({ events });
      return new ThreadScopedAttachmentBackend({
        rootDir: store.filesDir,
        scope,
        ripgrep: { onSpawn: (argv) => spawns.push(argv) },
      });
    };

    // thread 引用過 b，但 b 的目錄後來被刪掉了：a 的命中照樣回、也只起一次 rg。
    const route = routeFor([turnStart(a.ref, b.ref)]);
    await rm(dirname(store.pathOf(b.ref)), { recursive: true, force: true });
    const found = await route.grep('needle', '/');
    expect(found.error).toBeUndefined();
    expect(found.matches?.map((m) => m.path)).toEqual([a.path]);
    expect(spawns).toHaveLength(1);

    // 引用的目錄全都不存在：回空、不起 rg（不是 rg 對不存在的路徑報錯）。
    spawns.length = 0;
    await rm(dirname(store.pathOf(a.ref)), { recursive: true, force: true });
    expect(await route.grep('needle', '/')).toEqual({ matches: [] });
    expect(spawns).toHaveLength(0);

    // 0 份引用：同一個結果、同樣不起 rg。
    expect(await routeFor([]).grep('needle', '/')).toEqual({ matches: [] });
    expect(spawns).toHaveLength(0);
  });

  it('呼叫當下才判：同一個路由，日誌之後才引用的檔，之後就讀得到', async () => {
    const a = await put('alpha-secret\n', 'a.txt');
    const events: SessionEvent[] = [];
    const { route } = await routeOver(events);

    expect((await route.read(a.path)).error).toBeDefined();
    events.push(turnStart(a.ref));
    expect(JSON.stringify(await route.read(a.path))).toContain('alpha-secret');
    expect((await route.ls('/')).files).toHaveLength(1);
  });

  it('呼叫當下才判，來源每次回一份新陣列也一樣（綁定當下不能把 events 存下來）（#1782）', async () => {
    // `SessionRegistry.root.events` 是每次問都組一份新陣列的 getter：就地 push 的測試分不出「綁定時存了參照」與「每次重讀」。
    const a = await put('alpha-secret\n', 'a.txt');
    const backing: SessionEvent[] = [];
    const scope = createAttachmentScope();
    scope.bind({
      get events() {
        return [...backing];
      },
    });
    const route = await store.readOnlyRoute(scope);

    expect((await route.read(a.path)).error).toBeDefined();
    backing.push(turnStart(a.ref));
    expect(JSON.stringify(await route.read(a.path))).toContain('alpha-secret');
    expect((await route.grep('alpha', '/')).matches?.map((m) => m.path)).toEqual([a.path]);
  });

  it('還沒綁日誌、或已解綁：什麼都不露出（fail closed）', async () => {
    const a = await put('alpha-secret\n', 'a.txt');
    const unbound = createAttachmentScope();
    const route = await store.readOnlyRoute(unbound);
    expect((await route.read(a.path)).error).toBeDefined();
    expect((await route.ls('/')).files).toEqual([]);
    expect((await route.glob('**/*')).files).toEqual([]);
    expect((await route.grep('alpha', '/')).matches).toEqual([]);

    const bound = await routeOver([turnStart(a.ref)]);
    expect(JSON.stringify(await bound.route.read(a.path))).toContain('alpha-secret');
    bound.unbind();
    expect((await bound.route.read(a.path)).error).toBeDefined();
  });

  it('後綁的取代先綁的；舊的晚解綁不清掉新的', async () => {
    const a = await put('alpha-secret\n', 'a.txt');
    const scope = createAttachmentScope();
    const route = await store.readOnlyRoute(scope);
    const unbindOld = scope.bind({ events: [] });
    scope.bind({ events: [turnStart(a.ref)] });
    unbindOld();
    expect(JSON.stringify(await route.read(a.path))).toContain('alpha-secret');
  });

  it('引用的每一種事件都算：inbox/spliced、user/message 與 tool/result 的 nexus-file 區塊', async () => {
    const a = await put('alpha-secret\n', 'a.txt');
    const { type: _type, ...bare } = a.ref;
    const block = { type: 'nexus-file', attachment: bare };
    const message = { type: 'human', data: { content: [block] } };
    for (const events of [
      [
        event('inbox/spliced', {
          target: 'next-turn',
          start: 0,
          inserted: [{ id: 'q', text: '', source: { kind: 'user' }, attachments: [a.ref] }],
        }),
      ],
      [event('user/message', { message })],
      [event('tool/result', { callId: 'c', isError: false, message })],
    ]) {
      const { route } = await routeOver(events);
      expect(JSON.stringify(await route.read(a.path)), events[0]!.type).toContain('alpha-secret');
    }
  });

  it('檔名別名各自一條：同樣的位元組、另一個檔名，沒引用那個名字就讀不到；自己上傳的那一條讀得到', async () => {
    const a = await put('same bytes\n', 'a.txt');
    const other = await put('same bytes\n', 'other.txt');
    expect(other.path.split('/')[2]).toBe(a.path.split('/')[2]);

    const forA = await routeOver([turnStart(a.ref)]);
    expect(JSON.stringify(await forA.route.read(a.path))).toContain('same bytes');
    expect((await forA.route.read(other.path)).error).toBeDefined();
    expect((await forA.route.ls(a.path.split('/').slice(0, 3).join('/'))).files).toHaveLength(1);

    // B 自己上傳了位元組完全相同的檔：B 讀得到它自己的那一條（內容定址的結果，不算外漏）。
    const forB = await routeOver([turnStart(other.ref)]);
    expect(JSON.stringify(await forB.route.read(other.path))).toContain('same bytes');
    expect((await forB.route.read(a.path)).error).toBeDefined();
  });

  it('圖的參照不開任何檔案路徑；跑出根的路徑也讀不到', async () => {
    const a = await put('alpha-secret\n', 'a.txt');
    const image = {
      type: 'image',
      attachmentId: a.ref.attachmentId,
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
    };
    const { route } = await routeOver([turnStart(image)]);
    expect((await route.read(a.path)).error).toBeDefined();
    expect((await route.ls('/')).files).toEqual([]);

    const withFile = await routeOver([turnStart(a.ref)]);
    const digest = a.ref.attachmentId.slice('sha256:'.length);
    expect(
      (await withFile.route.read(`/../file-objects/${digest.slice(0, 2)}/${digest}`)).error,
    ).toBeDefined();
    expect((await withFile.route.read('/../file-objects')).error).toBeDefined();
  });

  it('參照陣列裡有 undefined：路由不拋——引用過的照讀、沒引用過的是「不存在」（#1782）', async () => {
    const a = await put('alpha-secret\n', 'a.txt');
    const b = await put('beta-secret\n', 'b.txt');
    const { route } = await routeOver([turnStart(undefined as unknown as object, a.ref)]);
    expect(JSON.stringify(await route.read(a.path))).toContain('alpha-secret');
    expect((await route.read(b.path)).error).toMatch(/ENOENT/u);
    expect((await route.ls('/')).files).toHaveLength(1);

    const onlyHoles = await routeOver([turnStart(undefined as unknown as object)]);
    expect((await onlyHoles.route.read(a.path)).error).toMatch(/ENOENT/u);
    expect((await onlyHoles.route.ls('/')).files).toEqual([]);
  });

  it('寫、改、刪都擋；引用過的檔也一樣', async () => {
    const a = await put('alpha\n', 'a.txt');
    const { route } = await routeOver([turnStart(a.ref)]);
    expect((await route.write(a.path, 'x')).error).toBeDefined();
    expect((await route.edit(a.path, 'alpha', 'x')).error).toBeDefined();
  });
});

describe('產品路徑：兩條 thread 共用一個儲存，前景子代理跟著 root 的日誌', () => {
  const GP = GENERAL_PURPOSE_SUBAGENT.name;
  const SECRET = 'KOHAKU-5520';

  async function until(predicate: () => boolean, ms = 5000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > ms) throw new Error('等太久了');
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  /** 一條 thread：root 委派給子代理，子代理 `read_file` 讀 `readPath`。回傳子代理讀到的 tool 訊息文字。 */
  async function subagentReads(
    threadId: string,
    readPath: string,
    attachments: readonly AttachmentRef[],
  ): Promise<string> {
    const turns: ScriptedTurn[] = [
      {
        content: '委派。',
        toolCalls: [{ name: 'task', args: { description: '讀檔', subagent_type: GP } }],
      },
      { content: '', toolCalls: [{ name: 'read_file', args: { file_path: readPath } }] },
      { content: '讀完了。' },
      { content: '收到。' },
    ];
    const model = new ScriptedChatModel({ turns });
    const built = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      plugins: [],
      attachments: store,
      summarization: false,
      observationPolicy: false,
    });
    const pump = new ThreadPump(built.agent as unknown as PumpAgent, threadId);
    const detach = built.attachSession(pump.sessions);
    const frames: Event[] = [];
    const line = new AbortController();
    const draining = (async () => {
      for await (const frame of pump.subscribe(['lifecycle'], line.signal)) frames.push(frame);
    })();
    try {
      await pump.submit({ kind: 'message', text: '讀', attachments: [...attachments] });
      await until(() => model.prompts.length >= 4);
      await pump.whenIdle();
      // 子代理第二輪的 prompt 裡有 read_file 的結果。
      const subagentPrompt = model.prompts[2] as readonly BaseMessage[];
      return subagentPrompt
        .filter((m) => m.getType() === 'tool')
        .map((m) => JSON.stringify(m.content))
        .join('\n');
    } finally {
      pump.close();
      line.abort();
      await draining;
      detach();
      await built.dispose();
    }
  }

  it('A 把檔案附在訊息上：A 的子代理讀得到；B 沒引用過，B 的子代理讀不到', async () => {
    const f = await put(`${SECRET}\n第二行\n`, 'notes.txt');
    const modelPath = `${ATTACHMENTS_PREFIX}${f.path}`;

    const readByA = await subagentReads('thread-a', modelPath, [f.ref]);
    expect(readByA).toContain(SECRET);

    const readByB = await subagentReads('thread-b', modelPath, []);
    expect(readByB).not.toContain(SECRET);
    expect(readByB).toMatch(/ENOENT|not found|Error/iu);
  }, 30000);
});
