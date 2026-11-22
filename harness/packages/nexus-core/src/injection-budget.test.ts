import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  INJECTION_SOURCE_BUDGETS,
  injectionLimitFor,
  type InjectionSourceId,
} from './injection-budget.js';

const ids = Object.keys(INJECTION_SOURCE_BUDGETS) as InjectionSourceId[];

describe('注入源的預算表', () => {
  it('表上的值', () => {
    expect(INJECTION_SOURCE_BUDGETS).toEqual({
      'agent-instructions': { kind: 'deferrable', maxBytes: 65536, contextFraction: 0.1 },
      'skill-catalog': { kind: 'deferrable', maxBytes: 32768, contextFraction: 0.05 },
      'skill-invocation': { kind: 'deferrable', maxBytes: 65536, contextFraction: 0.1 },
      memory: { kind: 'deferrable', maxBytes: 32768, contextFraction: 0.05 },
      'system-prompt-prefix': { kind: 'required', maxBytes: 16384 },
      'system-prompt-suffix': { kind: 'required', maxBytes: 16384 },
      'plan:policy': { kind: 'required', maxBytes: 16384 },
      'mcp:servers': { kind: 'per-server', maxBytes: 32768 },
    });
  });

  it('只有可延後的源有窗口比例', () => {
    for (const id of ids) {
      const budget: { kind: string; contextFraction?: number } = INJECTION_SOURCE_BUDGETS[id];
      expect(budget.contextFraction !== undefined, id).toBe(budget.kind === 'deferrable');
    }
  });

  it('大窗口：絕對上限生效', () => {
    expect(injectionLimitFor('agent-instructions', 784_369)).toBe(65_536);
    expect(injectionLimitFor('skill-catalog', 784_369)).toBe(32_768);
  });

  it('窗口 32,768：可延後的源照比例縮小，必帶項與 MCP 不看窗口', () => {
    expect(injectionLimitFor('agent-instructions', 32_768)).toBe(13_107);
    expect(injectionLimitFor('skill-invocation', 32_768)).toBe(13_107);
    expect(injectionLimitFor('skill-catalog', 32_768)).toBe(6_553);
    expect(injectionLimitFor('memory', 32_768)).toBe(6_553);
    expect(injectionLimitFor('system-prompt-prefix', 32_768)).toBe(16_384);
    expect(injectionLimitFor('plan:policy', 32_768)).toBe(16_384);
    expect(injectionLimitFor('mcp:servers', 32_768)).toBe(32_768);
  });

  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    '窗口取不到或不是正的有限數（%s）：用絕對上限',
    (contextWindow) => {
      for (const id of ids) {
        expect(injectionLimitFor(id, contextWindow), id).toBe(
          INJECTION_SOURCE_BUDGETS[id].maxBytes,
        );
      }
    },
  );
});

describe('文件上的預算表', () => {
  it('`docs/operations.md` 的表跟 `INJECTION_SOURCE_BUDGETS` 逐列相同', () => {
    const doc = readFileSync(new URL('../../../../docs/operations.md', import.meta.url), 'utf8');
    const table =
      /<!-- injection-source-budgets:start -->([\s\S]*?)<!-- injection-source-budgets:end -->/.exec(
        doc,
      )?.[1];
    expect(table).toBeDefined();
    const kinds = { 可延後: 'deferrable', 必帶: 'required', 每台: 'per-server' } as const;
    const rows = [
      ...(table ?? '').matchAll(/^\| `([^`]+)` \| [^|]+ \| (\S+) \| ([\d,]+) \| (\S+) \|$/gm),
    ];
    const documented = Object.fromEntries(
      rows.map(([, id, kind, maxBytes, fraction]) => [
        id,
        {
          kind: kinds[kind as keyof typeof kinds],
          maxBytes: Number(maxBytes?.replaceAll(',', '')),
          ...(fraction === '—'
            ? {}
            : { contextFraction: Number.parseInt(fraction ?? '', 10) / 100 }),
        },
      ]),
    );
    expect(documented).toEqual(INJECTION_SOURCE_BUDGETS);
  });
});
