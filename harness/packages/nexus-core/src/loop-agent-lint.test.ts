import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const PACKAGES = {
  '@nexus/core': fileURLToPath(new URL('..', import.meta.url)),
  'apps/harness': fileURLToPath(new URL('../../../apps/harness/', import.meta.url)),
} as const;

const linters = Object.fromEntries(
  Object.entries(PACKAGES).map(([name, cwd]) => [
    name,
    new ESLint({ cwd, overrideConfigFile: `${cwd}eslint.config.js` }),
  ]),
) as Record<keyof typeof PACKAGES, ESLint>;

beforeAll(async () => {
  for (const [name, cwd] of Object.entries(PACKAGES)) {
    await linters[name as keyof typeof PACKAGES].lintText('', { filePath: `${cwd}src/warm.ts` });
  }
}, 60_000);

async function restricted(
  name: keyof typeof PACKAGES,
  code: string,
  file: string,
): Promise<string[]> {
  const [result] = await linters[name].lintText(code, { filePath: `${PACKAGES[name]}${file}` });
  const messages = result?.messages ?? [];
  expect(messages.filter((m) => m.fatal === true).map((m) => m.message)).toEqual([]);
  return messages.filter((m) => m.ruleId === 'no-restricted-syntax').map((m) => m.message);
}

const CASTS = [
  ['as LoopAgent', 'declare const x: unknown;\nexport const y = x as LoopAgent;\n'],
  [
    'as unknown as PumpAgent',
    'declare const x: unknown;\nexport const y = x as unknown as PumpAgent;\n',
  ],
  ['as BackgroundAgent', 'declare const x: unknown;\nexport const y = x as BackgroundAgent;\n'],
  ['as RestorableAgent', 'declare const x: unknown;\nexport const y = x as RestorableAgent;\n'],
  ['as NexusAgent', 'declare const x: unknown;\nexport const y = x as NexusAgent;\n'],
  ['<LoopAgent>x', 'declare const x: unknown;\nexport const y = <LoopAgent>x;\n'],
] as const;

describe.each(Object.keys(PACKAGES) as (keyof typeof PACKAGES)[])('%s 的 lint', (name) => {
  it.each(CASTS)('非測試檔 %s：紅', async (_label, code) => {
    expect((await restricted(name, code, 'src/violation.ts')).length).toBeGreaterThan(0);
  });

  it('測試檔與 fixture 檔同一行不紅', async () => {
    const [, code] = CASTS[0];
    expect(await restricted(name, code, 'src/violation.test.ts')).toEqual([]);
    expect(await restricted(name, code, 'src/violation.fixture.ts')).toEqual([]);
  });

  it('轉成別的型別、型別註記與 `satisfies` 不紅', async () => {
    const code = [
      'declare const x: unknown;',
      'export const a = x as string;',
      'export const b: LoopAgent = x as never;',
      'export const c = x as Record<string, LoopAgent>;',
      '',
    ].join('\n');
    expect(await restricted(name, code, 'src/ok.ts')).toEqual([]);
  });
});
