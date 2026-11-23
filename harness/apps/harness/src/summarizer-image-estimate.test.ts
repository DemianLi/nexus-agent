/**
 * **摘要器的 token 估算不含已省略的圖**——[#1376](https://github.com/DemianLi/nexus-agent/issues/1376)
 * （[#1375](https://github.com/DemianLi/nexus-agent/pull/1375) 的附帶觀察，#1378 搬順序之後的驗證）。
 *
 * ## 疑點
 *
 * 摘要器與基座同名、被原地換進基座 core 段，原本一定排在 `imageOffload`（#1270）外面：它估算門檻時看到的是**還沒標上省略**
 * 的請求，而 `token-estimate.ts` 的 `imageCount` 只對標了 `offloaded` 的圖不算，所以已省略的圖每張照算 `IMAGE_TOKENS`
 * （3,166）。後果是有被省略的圖的會話摘要比該觸發的時候更早觸發。#1378 把 `IMAGE_OFFLOAD_MIDDLEWARE_NAME` 搬到預設疊前面
 * （`agent-assembly.ts` 的 `OUTSIDE_DEFAULTS`），疑點預期不成立。
 *
 * ## 量法
 *
 * 兩次一模一樣的三輪對話（第一、二輪各帶一張圖，第三輪沒圖），只差有沒有圖片額度：
 *
 * - A：沒有額度——兩張圖都留著，第三輪請求帶兩張圖；
 * - B：額度一張——第二張圖進來時最舊的那張被省略（日誌上有 `image/offload`），第三輪請求帶一張留著、一張標了省略的圖。
 *
 * 預算層寫在日誌上的 `context/measure.approxTokens`（`summarization.ts:1017` 那一格）就是摘要器對第三輪請求估到的 token。
 * 兩次的訊息、系統提示與工具都一樣，所以 **A − B 必須正好是一張圖：`IMAGE_TOKENS` 加它送出時前面那一行把手**
 * （[#1566](https://github.com/DemianLi/nexus-agent/issues/1566)）：被省略的那張兩樣都不算。摘要器若在 `imageOffload` 外面（修之前），
 * B 的估算看到的是還沒標省略的請求，兩者相等，差是 0。
 *
 * 不拿「摘要器內側探針看到的請求」當對照：探針在摘要器內側，系統提示被更內層的 middleware 補過，絕對值對不上
 * （實測差 110 token，與圖無關）；拿差值才與那一段無關。剪刀的壓力判斷（`summarization.ts:519`）與預算層在同一個最外層，
 * 拿到的是同一份進來的 `request`，所以不另量。
 *
 * **零憑證、零外部連線**，模型是腳本。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySaver } from '@langchain/langgraph';
import { estimateTextTokens, IMAGE_TOKENS, requestImageHandleText } from '@nexus/core';
import type { AttachmentRef, SessionEvent } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { ScriptedChatModel } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const imageRef = (
  letter: string,
  name: string,
): Extract<AttachmentRef, { readonly type: 'image' }> => ({
  type: 'image',
  attachmentId: `sha256:${letter.repeat(64)}`,
  mediaType: 'image/png',
  bytes: 90,
  width: 3,
  height: 2,
  name,
});
const FIRST = imageRef('a', 'one.png');
const SECOND = imageRef('b', 'two.png');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-1376-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const measures = (events: readonly SessionEvent[]) =>
  events.filter(
    (event): event is SessionEvent<'context/measure'> => event.type === 'context/measure',
  );

/** 三輪對話；回第三輪那一次預算層估到的 token 與日誌上的 `image/offload` 筆數。 */
async function threeRounds(maxImages: number | undefined) {
  const model = new ScriptedChatModel({
    turns: [{ content: '一' }, { content: '二' }, { content: '三' }],
    ...(maxImages === undefined ? {} : { imageBudget: { maxImages } }),
  });
  const built = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    backend: new ContainedFilesystemBackend({ rootDir: dir, mode: 'workspace-write' }),
    plugins: [],
    // 有型錄（`modelLimits`）才掛 `imageOffload` 那兩顆；窗口夠大，這個測試不讓摘要真的觸發。
    modelLimits: () => ({ contextWindow: 700_045, maxOutputTokens: 16_384 }),
  });
  const pump = new ThreadPump(
    built.agent as unknown as PumpAgent,
    'summarizer-image-estimate',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    built.stepInbox,
  );
  const detach = built.attachSession(pump.sessions);
  try {
    await pump.submit({ kind: 'message', text: '看這張', id: 'm1', attachments: [FIRST] });
    await pump.whenIdle();
    await pump.submit({ kind: 'message', text: '再看這張', id: 'm2', attachments: [SECOND] });
    await pump.whenIdle();
    const before = measures(pump.sessionLog.events).length;
    await pump.submit({ kind: 'message', text: '只是問個問題', id: 'm3' });
    await pump.whenIdle();
    const events = pump.sessionLog.events;
    const third = measures(events).slice(before);
    expect(third).toHaveLength(1);
    return {
      approxTokens: third[0]!.data.approxTokens,
      offloads: events.filter((event) => event.type === 'image/offload').length,
    };
  } finally {
    pump.close();
    detach();
    await built.dispose();
  }
}

describe('摘要器的估算不含已省略的圖（#1376）', () => {
  it('被省略的那張不算：兩張都留著的估算比省略一張的正好多一張圖（IMAGE_TOKENS 加它的把手）', async () => {
    const kept = await threeRounds(undefined);
    const omitted = await threeRounds(1);
    // 前提：B 真的省略了一張，A 沒有（不然這個差什麼都沒量）。
    expect(kept.offloads).toBe(0);
    expect(omitted.offloads).toBe(1);
    // 正確的行為：差一張圖（最舊的 FIRST）。摘要器在 `imageOffload` 外面時這裡是 0（被省略的圖照算）。
    expect(kept.approxTokens - omitted.approxTokens).toBe(
      IMAGE_TOKENS + estimateTextTokens(requestImageHandleText(FIRST)),
    );
  }, 30_000);
});
