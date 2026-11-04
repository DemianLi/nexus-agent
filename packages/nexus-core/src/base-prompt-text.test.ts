/**
 * `base-prompt-text.ts` 照抄的文字跟基座逐位元組相同：同一份資料，交給基座自己的 middleware 渲染一次、這裡渲染一次，比兩段字。
 * 基座的 `wrapModelCall` 在它自己沒掃過時讀 `request.state`，所以把資料放在那裡就拿得到它的渲染。
 */

import { SystemMessage } from '@langchain/core/messages';
import { createMemoryMiddleware, createSkillsMiddleware, StateBackend } from 'deepagents';
import { describe, expect, it } from 'vitest';

import { renderMemorySection, renderSkillsSection } from './base-prompt-text.js';
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
