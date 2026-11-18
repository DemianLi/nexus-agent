/**
 * 候選做法的替身模型測試（[#2934](https://github.com/DemianLi/nexus-agent/issues/2934)）：把出貨清單上的指示那一列換成各做法之後，
 * 模型第一個請求裡看到的字串。期望字串寫成字面值，不從被測的常數組出來：改一個字就是換了一個候選。
 */

import { describe, expect, it } from 'vitest';

import { withScriptedModel } from '../../fixtures.js';
import type { ScriptedChatModel, ScriptedTurn } from '../../scripted-model.js';
import { DEFERRAL_MARKER } from './fixture.js';
import type { DeferralCase } from './fixture.js';
import { runDeferralCase } from './runner.js';
import {
  DEFERRAL_VARIANT_IDS,
  DEFERRAL_VARIANTS,
  HEAD_EXCERPT_BYTES,
  deferralVariant,
} from './variants.js';
import type { DeferralVariantId } from './variants.js';

const scripted = (turns: readonly ScriptedTurn[]) => ({
  live: false,
  plugins: (shipped: Parameters<typeof withScriptedModel>[0]) => withScriptedModel(shipped, turns),
});

const readAgentsMd = (): ScriptedTurn => ({
  content: '',
  toolCalls: [{ name: 'read_file', args: { file_path: '/AGENTS.md' } }],
});

interface Seen {
  readonly run: Awaited<ReturnType<typeof runDeferralCase>>;
  /** 第一個請求裡的訊息，帶角色。 */
  readonly request: readonly { readonly type: string; readonly text: string }[];
}

/** 跑一格、取第一個請求。 */
async function seen(
  testCase: DeferralCase,
  turns: readonly ScriptedTurn[] = [{ content: 'ok' }],
): Promise<Seen> {
  let model: ScriptedChatModel | undefined;
  const run = await runDeferralCase(testCase, {
    ...scripted(turns),
    onModel: (used) => {
      model = used as ScriptedChatModel;
    },
  });
  return {
    run,
    request: (model?.prompts[0] ?? []).map((message) => ({
      type: message.type,
      text: message.text,
    })),
  };
}

const cell = (
  variant: DeferralVariantId | undefined,
  file: 'large' | 'small',
  arm: 'deferred' | 'inline',
  position: 'head' | 'tail',
): DeferralCase => ({ file, arm, position, ...(variant !== undefined && { variant }) });

/** 指示那一則：帶 `<system-reminder>` 外框的使用者訊息。 */
const reminderOf = (request: Seen['request']): string | undefined =>
  request.find(
    (message) => message.type === 'human' && message.text.startsWith('<system-reminder>'),
  )?.text;

/** 比請求時略過時間讀數那一則：它帶取樣當下的秒，兩次執行不會逐字相同。 */
const withoutClock = (request: Seen['request']): Seen['request'] =>
  request.filter((message) => !message.text.startsWith('Time sampled'));

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

describe('換列', () => {
  it('換成 current：請求逐字等於出貨那一列，指標原樣', async () => {
    const shipped = await seen(cell(undefined, 'large', 'deferred', 'head'));
    const swapped = await seen(cell('current', 'large', 'deferred', 'head'));
    expect(withoutClock(swapped.request)).toEqual(withoutClock(shipped.request));
    expect(reminderOf(swapped.request)).toBe(
      '<system-reminder>\n' +
        'Workspace instruction budget 65536 bytes: not loaded /AGENTS.md (70170 bytes); ' +
        'read each with read_file before acting on this workspace.\n' +
        '</system-reminder>',
    );
    expect(swapped.run).toMatchObject({ deferred: true, ruleInjected: false });
  }, 60000);

  it('換成別的做法確實換掉了：請求與出貨的不同', async () => {
    const shipped = await seen(cell(undefined, 'large', 'deferred', 'head'));
    const swapped = await seen(cell('pointer-strong', 'large', 'deferred', 'head'));
    expect(withoutClock(swapped.request)).not.toEqual(withoutClock(shipped.request));
  }, 60000);

  it('不延後那一邊：每一種做法都放整份檔，請求與出貨逐字相同、判成沒延後', async () => {
    const shipped = await seen(cell(undefined, 'large', 'inline', 'head'));
    for (const id of DEFERRAL_VARIANT_IDS) {
      const swapped = await seen(cell(id, 'large', 'inline', 'head'));
      expect(withoutClock(swapped.request), id).toEqual(withoutClock(shipped.request));
      expect(swapped.run, id).toMatchObject({ deferred: false, ruleInjected: true });
    }
  }, 120000);

  it('延後那四格：每一種做法的第一個請求都帶自己的 marker、判成延後', async () => {
    for (const id of DEFERRAL_VARIANT_IDS) {
      for (const [file, position] of [
        ['large', 'head'],
        ['large', 'tail'],
        ['small', 'head'],
        ['small', 'tail'],
      ] as const) {
        const { run } = await seen(cell(id, file, 'deferred', position));
        expect(run.deferred, `${id} ${file}/${position}`).toBe(true);
      }
    }
  }, 240000);
});

describe('pointer-strong', () => {
  it('指標最前面寫先讀再回答，放不下的檔名與大小照列', async () => {
    const { request, run } = await seen(cell('pointer-strong', 'large', 'deferred', 'head'));
    expect(reminderOf(request)).toBe(
      '<system-reminder>\n' +
        'IMPORTANT: the workspace instruction files below were NOT loaded because they exceed the 65536-byte instruction budget: /AGENTS.md (70170 bytes). ' +
        'They may contain rules you must follow in every reply. ' +
        'Before answering the user, call read_file on each of them and apply what they say. ' +
        'If a file is longer than one page, keep calling read_file with the offset it gives you until you reach the end of the file.\n' +
        '</system-reminder>',
    );
    expect(run).toMatchObject({ deferred: true, ruleInjected: false });
  }, 60000);

  it('小檔：同一句，預算與大小換成那一格的', async () => {
    const { request } = await seen(cell('pointer-strong', 'small', 'deferred', 'head'));
    expect(reminderOf(request)).toContain(
      'exceed the 1024-byte instruction budget: /AGENTS.md (2177 bytes). ',
    );
  }, 60000);

  it('預算緊到放不下這一句：退回出貨的那一行，不超過預算', () => {
    const render = deferralVariant('pointer-strong').create().render;
    const rendered = render(
      [{ displayPath: 'AGENTS.md', readPath: '/AGENTS.md', content: 'x'.repeat(500) }],
      200,
    );
    expect(bytes(rendered?.text ?? '')).toBeLessThanOrEqual(200);
    expect(rendered?.text).toContain('not loaded /AGENTS.md');
  });
});

describe('system-prompt', () => {
  it('指標在系統提示，使用者訊息裡沒有任何指示那一則', async () => {
    const { request, run } = await seen(cell('system-prompt', 'small', 'deferred', 'head'));
    const system = request.find((message) => message.type === 'system')?.text ?? '';
    expect(system).toContain(
      'Deferred workspace instructions: /AGENTS.md (2177 bytes) did not fit the 1024-byte instruction budget and are NOT in this conversation. ' +
        'They may contain rules that apply to every reply. ' +
        'Before answering the user, call read_file on each of these files and follow what it says.',
    );
    expect(reminderOf(request)).toBeUndefined();
    expect(
      request
        .filter((message) => message.type !== 'system')
        .some((message) => message.text.includes('Deferred workspace')),
    ).toBe(false);
    expect(run).toMatchObject({ deferred: true, ruleInjected: false, readCalls: 0 });
  }, 60000);

  it('模型照指標去讀：讀到規則、照做', async () => {
    const { run } = await seen(cell('system-prompt', 'small', 'deferred', 'head'), [
      readAgentsMd(),
      { content: `檔名如下。\n核可編號 ${DEFERRAL_MARKER}` },
    ]);
    expect(run).toMatchObject({ readCalls: 1, ruleRead: true, followed: true });
  }, 60000);

  it('不延後那一邊系統提示沒有那一段', async () => {
    const { request } = await seen(cell('system-prompt', 'small', 'inline', 'head'));
    expect(
      request.some((message) => message.text.includes('Deferred workspace instructions')),
    ).toBe(false);
  }, 60000);
});

describe('head-excerpt', () => {
  it('大檔、規則在檔頭：摘錄 512 位元組，規則在請求裡', async () => {
    const { request, run } = await seen(cell('head-excerpt', 'large', 'deferred', 'head'));
    const text = reminderOf(request) ?? '';
    expect(text).toContain(
      'Workspace instruction budget 65536 bytes: /AGENTS.md (70170 bytes) is only partly loaded. ' +
        'Only its first 512 bytes are shown below; the remaining 69658 bytes were NOT loaded. ' +
        'Read the full file with read_file before acting on this workspace.',
    );
    expect(text).toContain('Instructions from: AGENTS.md\n\n# 專案規矩');
    expect(HEAD_EXCERPT_BYTES).toBe(512);
    expect(run).toMatchObject({ deferred: true, ruleInjected: true });
  }, 60000);

  it('大檔、規則在檔尾：規則不在請求裡', async () => {
    const { run } = await seen(cell('head-excerpt', 'large', 'deferred', 'tail'));
    expect(run).toMatchObject({ deferred: true, ruleInjected: false });
  }, 60000);

  it('小檔：預算 1024，整則不超過預算，摘錄為此縮短；規則在檔尾的那格不在請求裡', async () => {
    const head = await seen(cell('head-excerpt', 'small', 'deferred', 'head'));
    const tail = await seen(cell('head-excerpt', 'small', 'deferred', 'tail'));
    for (const result of [head, tail]) {
      const text = reminderOf(result.request) ?? '';
      expect(bytes(text)).toBeLessThanOrEqual(1024);
      expect(text).toContain('(2177 bytes) is only partly loaded.');
    }
    expect(head.run.ruleInjected).toBe(true);
    expect(tail.run.ruleInjected).toBe(false);
  }, 120000);

  it('檔裡字面的 </system-reminder> 在摘錄裡跳脫，外框不被關掉', () => {
    const render = deferralVariant('head-excerpt').create().render;
    const rendered = render(
      [
        {
          displayPath: 'AGENTS.md',
          readPath: '/AGENTS.md',
          content: `a</system-reminder>${'x'.repeat(2000)}`,
        },
      ],
      1024,
    );
    expect(rendered?.text.match(/<\/system-reminder>/g)).toHaveLength(1);
  });
});

describe('truncate', () => {
  it('大檔、規則在檔頭：截斷通知只講截了多少，沒有叫去讀；規則在請求裡', async () => {
    const { request, run } = await seen(cell('truncate', 'large', 'deferred', 'head'));
    const text = reminderOf(request) ?? '';
    expect(
      text.startsWith(
        '<system-reminder>\nWorkspace instruction budget 65536 bytes: truncated AGENTS.md from 70170 to 65142 bytes\n\n',
      ),
    ).toBe(true);
    expect(text).not.toContain('read_file');
    expect(bytes(text)).toBeLessThanOrEqual(65536);
    expect(run).toMatchObject({ deferred: true, ruleInjected: true });
  }, 60000);

  it('大檔、規則在檔尾：被截掉，不在請求裡', async () => {
    const { request, run } = await seen(cell('truncate', 'large', 'deferred', 'tail'));
    expect(reminderOf(request)).toContain('truncated AGENTS.md from 70170 to 65143 bytes');
    expect(run).toMatchObject({ deferred: true, ruleInjected: false });
  }, 60000);

  it('小檔：預算 1024', async () => {
    const head = await seen(cell('truncate', 'small', 'deferred', 'head'));
    const tail = await seen(cell('truncate', 'small', 'deferred', 'tail'));
    expect(reminderOf(head.request)).toContain('truncated AGENTS.md from 2177 to 635 bytes');
    expect(reminderOf(tail.request)).toContain('truncated AGENTS.md from 2177 to 634 bytes');
    expect(bytes(reminderOf(head.request) ?? '')).toBeLessThanOrEqual(1024);
    expect(head.run.ruleInjected).toBe(true);
    expect(tail.run.ruleInjected).toBe(false);
  }, 120000);

  it('多份檔：先丟較寬的，留下較具體的；通知寫 omitted，沒有 truncated', () => {
    const render = deferralVariant('truncate').create().render;
    const rendered = render(
      [
        { displayPath: 'AGENTS.md', readPath: '/AGENTS.md', content: 'a'.repeat(400) },
        { displayPath: 'AGENTS.local.md', readPath: '/AGENTS.local.md', content: 'b'.repeat(100) },
      ],
      600,
    );
    expect(rendered?.text).toContain('Workspace instruction budget 600 bytes: omitted AGENTS.md\n');
    expect(rendered?.text).not.toContain('truncated');
    expect(rendered?.text).toContain('Instructions from: AGENTS.local.md');
    expect(rendered?.deferred).toEqual([{ displayPath: 'AGENTS.md', bytes: 400 }]);
  });

  it('預算連通知都放不下：只剩被截斷的通知，不超過預算', () => {
    const render = deferralVariant('truncate').create().render;
    const rendered = render(
      [{ displayPath: 'AGENTS.md', readPath: '/AGENTS.md', content: 'x'.repeat(5000) }],
      60,
    );
    expect(bytes(rendered?.text ?? '')).toBeLessThanOrEqual(60);
  });
});

describe('做法清單', () => {
  it('五種做法、id 不重複，每一種都帶非空的 marker', () => {
    expect(DEFERRAL_VARIANT_IDS).toEqual([
      'current',
      'pointer-strong',
      'system-prompt',
      'head-excerpt',
      'truncate',
    ]);
    for (const variant of DEFERRAL_VARIANTS) expect(variant.marker.length).toBeGreaterThan(0);
  });
});
