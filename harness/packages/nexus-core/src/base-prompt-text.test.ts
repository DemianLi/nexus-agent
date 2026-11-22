/**
 * `base-prompt-text.ts` 照抄的文字跟基座逐位元組相同：同一份資料，交給基座自己的 middleware 渲染一次、這裡渲染一次，比兩段字。
 * 基座的 `wrapModelCall` 在它自己沒掃過時讀 `request.state`，所以把資料放在那裡就拿得到它的渲染。
 */

import { SystemMessage } from '@langchain/core/messages';
import { createMemoryMiddleware, createSkillsMiddleware, StateBackend } from 'deepagents';
import { describe, expect, it } from 'vitest';

import {
  renderMemorySection,
  renderMemorySectionWithin,
  renderSkillsSection,
  renderSkillsSectionWithin,
} from './base-prompt-text.js';
import type { SkillListing } from './base-prompt-text.js';

type Wrap = (request: unknown, handler: (request: unknown) => unknown) => unknown;

/** 基座那顆 middleware 接上去的那一段。 */
function baseSection(middleware: unknown, state: Record<string, unknown>): string {
  let sent: SystemMessage | undefined;
  (middleware as { wrapModelCall: Wrap }).wrapModelCall(
    { systemMessage: new SystemMessage(''), state },
    (request) => {
      sent = (request as { systemMessage: SystemMessage }).systemMessage;
    },
  );
  const content = sent!.content;
  if (typeof content === 'string') return content;
  const last = (content as { text?: string }[]).at(-1);
  return last?.text ?? '';
}

const backend = () => new StateBackend();

const SKILLS: Record<string, readonly SkillListing[]> = {
  空清單: [],
  一般: [
    { name: 'web-research', description: '上網查資料。', path: '/skills/web-research/SKILL.md' },
  ],
  全欄位: [
    {
      name: 'deploy',
      description: '部署。',
      path: '/skills/deploy/SKILL.md',
      license: 'MIT',
      compatibility: 'node 22',
      allowedTools: ['read_file', 'execute'],
      module: 'index.ts',
    },
    {
      name: 'only-license',
      description: '只有授權。',
      path: '/a/only-license/SKILL.md',
      license: 'Apache-2.0',
    },
  ],
};

describe('skills 那一段跟基座逐位元組相同', () => {
  for (const sources of [['/skills/'], ['/user/skills/', '/project/.skills'], ['/']]) {
    for (const [label, skills] of Object.entries(SKILLS)) {
      it(`${label}，來源 ${sources.join(' ')}`, () => {
        const base = createSkillsMiddleware({ backend, sources });
        expect(renderSkillsSection(skills, sources)).toBe(
          baseSection(base, { skillsMetadata: skills }),
        );
      });
    }
  }
});

describe('記憶那一段跟基座逐位元組相同', () => {
  const sources = ['/PROJECT.md', '/AGENTS.md'];
  it.each([
    ['沒有讀到', {}],
    ['兩個來源', { '/AGENTS.md': '代號是胡桃。', '/PROJECT.md': '用 pnpm。' }],
    ['只有一個', { '/AGENTS.md': '代號是胡桃。' }],
    ['不在來源上的鍵', { '/OTHER.md': '不該出現。' }],
  ])('%s', (_label, contents: Record<string, string>) => {
    const base = createMemoryMiddleware({ backend, sources });
    expect(renderMemorySection(contents, sources)).toBe(
      baseSection(base, { memoryContents: contents }),
    );
  });
});

describe('整段不超過上限（#2777）', () => {
  const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
  const skill = (name: string): SkillListing =>
    ({ name, description: `${name} 的說明。`, path: `/skills/${name}/SKILL.md` }) as SkillListing;
  const skills = ['alpha', 'beta', 'gamma', 'delta'].map(skill);
  const sources = ['/skills/'];

  it('skills：放得下就跟不設上限的那一段逐位元組相同', () => {
    const full = renderSkillsSection(skills, sources);
    expect(renderSkillsSectionWithin(skills, sources, bytes(full))).toEqual({
      text: full,
      deferredBytes: 0,
    });
  });

  it('skills：放不下時從尾端往前留，前面的整條不列，最後一行說幾條沒列、怎麼找', () => {
    const full = renderSkillsSection(skills, sources);
    const entryBytes = bytes(
      '- **alpha**: alpha 的說明。\n  → Read `/skills/alpha/SKILL.md` for full instructions',
    );
    // 後兩條加指標那一行（一百多位元組）放得下，再多一條就超過。
    const budget = bytes(renderSkillsSection(skills.slice(2), sources)) + 160;
    const { text, deferredBytes } = renderSkillsSectionWithin(skills, sources, budget);
    expect(bytes(full)).toBeGreaterThan(budget);
    expect(bytes(text)).toBeLessThanOrEqual(budget);
    expect(text).not.toContain('**alpha**');
    expect(text).not.toContain('**beta**');
    expect(text).toContain('- **gamma**: gamma 的說明。');
    expect(text).toContain(
      `- **delta**: delta 的說明。\n  → Read \`/skills/delta/SKILL.md\` for full instructions\n` +
        `- (2 more skills not listed: skills section budget ${budget} bytes. List \`/skills/\` with ls and read a SKILL.md with read_file.)`,
    );
    expect(deferredBytes).toBe(
      entryBytes +
        bytes('- **beta**: beta 的說明。\n  → Read `/skills/beta/SKILL.md` for full instructions'),
    );
  });

  it('skills：一條都留不下，仍是固定文字加那一行（可能超過上限）', () => {
    const { text, deferredBytes } = renderSkillsSectionWithin(skills.slice(0, 1), sources, 1);
    expect(text).toContain('- (1 more skill not listed: skills section budget 1 bytes.');
    expect(text).not.toContain('**alpha**');
    expect(deferredBytes).toBeGreaterThan(0);
  });

  it('記憶：放得下就跟不設上限的那一段逐位元組相同', () => {
    const contents = { '/a.md': '甲。' };
    const full = renderMemorySection(contents, ['/a.md']);
    expect(renderMemorySectionWithin(contents, ['/a.md'], bytes(full))).toEqual({
      text: full,
      deferredBytes: 0,
    });
  });

  it('記憶：放了會超過的那一份整份不放、原地留一行，後面較小的照樣放', () => {
    const contents = { '/big.md': '大'.repeat(1000), '/small.md': '小的記憶。' };
    const order = ['/big.md', '/small.md'];
    const budget = bytes(renderMemorySection({ '/small.md': contents['/small.md'] }, order)) + 200;
    const { text, deferredBytes } = renderMemorySectionWithin(contents, order, budget);
    expect(bytes(text)).toBeLessThanOrEqual(budget);
    expect(text).toContain(
      `/big.md\n(Not loaded: 3000 bytes, memory section budget ${budget} bytes. Read it with read_file when you need it.)\n\n/small.md\n小的記憶。`,
    );
    expect(text).not.toContain('大大');
    expect(deferredBytes).toBe(3000);
  });
});
