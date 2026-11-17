/**
 * 注入源延後評估的一次執行（[#2929](https://github.com/DemianLi/nexus-agent/issues/2929)）。
 *
 * 走產品的組裝：真的 `createCordisRoot`、出貨清單、`root.boot('serve')`，模型由呼叫端決定（CI 用照稿回話的替身，量測用真模型）。
 * 每一格一棵自己的樹、自己的 harness home 與工作區，跑完就清掉。
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { SessionRegistry } from '@nexus/core';
import type { PluginEntry } from '@nexus/core';

import { createCordisRoot, entryApprovalChannel } from '../../cordis-root.js';
import type { CredentialService } from '../../credentials.js';
import { HARNESS_HOME_ENV } from '../../harness-home.js';
import { toAgentInvocation } from '../../messages.js';
import { loadDefaultPlugins } from '../../plugin-config.js';
import {
  DEFERRAL_INLINE_MAX_BYTES,
  DEFERRAL_MARKER,
  DEFERRAL_TASK,
  deferralWorkspaceFiles,
} from './fixture.js';
import type { DeferralCase } from './fixture.js';

/** 一次執行最多幾個模型請求；到了就中止這一次。 */
export const DEFERRAL_MAX_REQUESTS = 8;

export interface DeferralRunOptions {
  /** 用真模型。 */
  readonly live: boolean;
  /** 真模型的憑證；`live` 時要給。 */
  readonly credentials?: CredentialService;
  /** 把出貨清單換成要跑的那一份（CI 在這裡換成替身模型）；省略即原樣。 */
  readonly plugins?: (shipped: readonly PluginEntry[]) => readonly PluginEntry[];
}

/** 一次執行看到的事。 */
export interface DeferralRun {
  readonly arm: DeferralCase['arm'];
  readonly position: DeferralCase['position'];
  /** 請求裡的指示檔是那一行指標（整份沒放）。 */
  readonly deferred: boolean;
  /** 規則隨指示檔直接放進了請求。 */
  readonly ruleInjected: boolean;
  /** 模型用 `read_file` 讀 `AGENTS.md` 的次數。 */
  readonly readCalls: number;
  /** 某一次讀回來的內容裡有那條規則。 */
  readonly ruleRead: boolean;
  /** 最後的回覆裡有規則要求的那一串。 */
  readonly followed: boolean;
  /** 模型請求數（有回覆的；不含傳輸重試）。 */
  readonly requests: number;
  /** 到了 {@link DEFERRAL_MAX_REQUESTS} 被中止。 */
  readonly capped: boolean;
  readonly finalText: string;
}

const textOf = (message: BaseMessage): string => message.text;

/**
 * 跑一格。
 *
 * @param testCase - 延後與否、規則的位置。
 * @param options - 模型從哪來。
 * @returns 這一次看到的事。
 */
export async function runDeferralCase(
  testCase: DeferralCase,
  options: DeferralRunOptions,
): Promise<DeferralRun> {
  const scratch = mkdtempSync(join(tmpdir(), 'nexus-injection-deferral-eval-'));
  chmodSync(scratch, 0o700);
  const home = join(scratch, 'home');
  const workspace = join(scratch, 'ws');
  for (const dir of [home, workspace]) mkdirSync(dir, { mode: 0o700 });
  if (testCase.arm === 'inline') {
    writeFileSync(
      join(home, 'cordis.patch.yml'),
      `- id: agent-instructions\n  config:\n    maxBytes: ${DEFERRAL_INLINE_MAX_BYTES}\n`,
      { mode: 0o600 },
    );
  }
  for (const [path, content] of Object.entries(deferralWorkspaceFiles(testCase.position))) {
    writeFileSync(join(workspace, path), content, 'utf8');
  }

  const root = createCordisRoot({ channel: entryApprovalChannel(undefined), contained: true });
  try {
    const loaded = await loadDefaultPlugins(
      { env: { [HARNESS_HOME_ENV]: home }, warn: () => {} },
      { tree: root.tree },
    );
    const assembly = await root.boot('serve', { plugins: loaded.plugins });
    const built = await assembly.create(
      {
        live: options.live,
        workspace,
        sandbox: 'workspace-write' as const,
        ...(options.credentials !== undefined && { credentials: options.credentials }),
      },
      { plugins: [...(options.plugins?.(loaded.plugins) ?? loaded.plugins)] },
    );
    const attachment = built.attachSessions(new SessionRegistry('deferral'));
    try {
      const abort = new AbortController();
      let started = 0;
      const callbacks = [
        {
          handleChatModelStart() {
            started += 1;
            if (started > DEFERRAL_MAX_REQUESTS) abort.abort();
          },
        },
      ];
      const invoke = (
        built.agent as unknown as {
          invoke(input: unknown, config: unknown): Promise<{ messages: BaseMessage[] }>;
        }
      ).invoke.bind(built.agent);
      let messages: readonly BaseMessage[] = [];
      let capped = false;
      try {
        ({ messages } = await invoke(toAgentInvocation(DEFERRAL_TASK), {
          configurable: { thread_id: 'deferral' },
          signal: abort.signal,
          callbacks,
        }));
      } catch (error) {
        if (!abort.signal.aborted) throw error;
        capped = true;
      }
      return { ...observe(testCase, messages), capped };
    } finally {
      await attachment.detach();
      await built.dispose();
    }
  } finally {
    await root.dispose().catch(() => {});
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * 從跑完的訊息串讀出這一次看到的事。
 *
 * @param testCase - 這一格。
 * @param messages - 最終的訊息串；被中止時是空的。
 */
export function observe(
  testCase: DeferralCase,
  messages: readonly BaseMessage[],
): Omit<DeferralRun, 'capped'> {
  const humans = messages.filter((message) => HumanMessage.isInstance(message)).map(textOf);
  const ai = messages.filter((message) => AIMessage.isInstance(message));
  const reads = ai
    .flatMap((message) => message.tool_calls ?? [])
    .filter(
      (call) => call.name === 'read_file' && JSON.stringify(call.args ?? {}).includes('AGENTS.md'),
    );
  const spoken = ai.filter((message) => message.text.trim() !== '');
  const finalText = spoken.at(-1)?.text ?? '';
  return {
    arm: testCase.arm,
    position: testCase.position,
    deferred: humans.some((text) => text.includes('not loaded /AGENTS.md')),
    ruleInjected: humans.some((text) => text.includes(DEFERRAL_MARKER)),
    readCalls: reads.length,
    ruleRead: messages
      .filter((message) => ToolMessage.isInstance(message))
      .some((message) => textOf(message).includes(DEFERRAL_MARKER)),
    followed: finalText.includes(DEFERRAL_MARKER),
    requests: ai.length,
    finalText,
  };
}
