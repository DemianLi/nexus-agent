/**
 * **`ask_user_question` 讀到的答題管道，跟核准閘門是同一份**——[#670](https://github.com/DemianLi/nexus-agent/issues/670)
 * 的驗收，量在產品組裝上（`runCli`、`runServe`），模型換成清單上的腳本提供者。
 *
 * 管道在 `assembly-root.ts` 算一次（`deriveApprovalChannel`）、交給 host-services，`ask_user_question` 與核准閘門
 * 各自從那裡讀。以前這一條只有套件單元測試以手給的管道驗過；組裝點若把管道寫死成「有人在」，核准擋得下來、
 * 問答卻還掛在那裡，沒有任何一條測試會紅。
 *
 * - CLI：`runCli` 傳 `HEADLESS_APPROVALS`（關掉人工核准），管道是 `policy-never`，工具**當下拒絕**、不發中斷。
 *   工具結果前面會多一段前綴（`tool-events.ts` 的 `Error: `），所以比「含」不比「等於」。
 * - serve：沒傳 `approvals`，管道是 `human`，停在問答中斷、等人回答。
 *
 * 突變（量過）：`assembly-root.ts` 交給 host-services 那顆的 `channel,` 換成字面的 `{ kind: 'human' }`
 * → CLI 那條紅（問題真的發出去了，沒有被拒）；serve 那條照樣綠，它是對照組。
 *
 * **零憑證、零外部連線**：模型是腳本，工作區沒有給。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { ASK_USER_QUESTION_TOOL_NAME, noAnswererMessage } from '@nexus/plugin-ask-user';
import { isQuestionPending } from '@nexus/wire';
import type { ConversationState } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from './cli.js';
import { serveClient, foldTurn } from './fixtures.js';
import { scriptedPatchText, startScriptedServe } from './scripted-serve.js';
import type { ScriptedServe } from './scripted-serve.js';
import type { ScriptedTurn } from './scripted-model.js';

const QUESTIONS = [
  { id: 'day', question: '哪一天？', options: [{ label: '週一' }, { label: '週二' }] },
];

const ASK: readonly ScriptedTurn[] = [
  {
    content: '我先問。',
    toolCalls: [{ name: ASK_USER_QUESTION_TOOL_NAME, args: { questions: QUESTIONS } }],
  },
  { content: '收工。' },
];

const dirs: string[] = [];
let serve: ScriptedServe | undefined;

afterEach(async () => {
  await serve?.close();
  serve = undefined;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ask_user_question 的答題管道，在產品組裝上', () => {
  it('CLI（關掉人工核准）：工具當下拒絕，結果文字含 policy-never 那一句', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexus-ask-user-cli-'));
    dirs.push(dir);
    const patch = join(dir, 'scripted.patch.yml');
    await writeFile(patch, scriptedPatchText(ASK), 'utf8');
    const lines: string[] = [];
    const record = (...parts: unknown[]): void => void lines.push(parts.join(' '));

    await runCli({
      argv: ['--patch', patch, '問我一個問題。'],
      input: new PassThrough(),
      output: new PassThrough(),
      printer: { log: record, error: record },
      env: {},
    });

    const out = lines.join('\n');
    // 前提：腳本真的被用上了——工具跑過，輸出裡有那一輪的話。
    expect(out).toContain('收工。');
    expect(out).toContain(noAnswererMessage({ kind: 'policy-never' }));
  }, 60000);

  it('對照：serve（沒關人工核准）停在問答中斷，等人回答', async () => {
    serve = await startScriptedServe(ASK);
    const client = await serveClient(serve.running);
    const events = await client.openEvents('ask-user-assembly');
    await client.runStart('ask-user-assembly', '問我一個問題。');
    const state: ConversationState = await foldTurn(events);
    await events.return?.(undefined);

    const question = state.pendings[0];
    if (question === undefined) throw new Error('沒有掛出任何待回覆的東西');
    expect(isQuestionPending(question)).toBe(true);
  }, 60000);
});
