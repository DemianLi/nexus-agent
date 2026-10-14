/**
 * `@nexus/sdk/lint` 的測試（[#1420](https://github.com/DemianLi/nexus-agent/issues/1420) 驗收 A、B）。
 *
 * 違規碼放在記憶體裡、不落成檔：落地的違規夾具會被 `pnpm -r run lint`／typecheck／prettier 掃到，整棵樹變紅。
 * 用 `ESLint#lintText` 量，設定是 `typescript-eslint` 的 parser 加上要測的這一份。
 *
 * **斷言比的是訊息，不是 ruleId**：好幾條共用 `no-restricted-syntax` 這個 ruleId，只比 ruleId 的話，拿掉其中一個
 * selector，紅的不會只有它那條，驗收 G 就證明不了「對應的那一條」。所以每個夾具要求：報出來的訊息集合**正好**是它
 * 那一條的訊息——少了是這條規則沒接上去，多了是夾具撞到別條。
 */

import { fileURLToPath } from 'node:url';

import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

import {
  pluginLintConfig,
  pluginLintGlobalRestrictions,
  pluginLintImportRestrictions,
  pluginLintPropertyRestrictions,
  pluginLintSyntaxRestrictions,
} from './lint.js';

const CWD = fileURLToPath(new URL('..', import.meta.url));

const eslint = new ESLint({
  overrideConfigFile: true,
  cwd: CWD,
  overrideConfig: [
    { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
    ...pluginLintConfig,
  ] as unknown as Linter.Config[],
});

async function messagesOf(code: string, filePath = 'src/plugin.ts'): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${CWD}${filePath}` });
  const messages = result?.messages ?? [];
  const fatal = messages.filter((m) => m.fatal === true);
  expect(fatal.map((m) => m.message)).toEqual([]);
  return messages.map((m) => m.message);
}

/** 每一條規則一個違規夾具（同一條的各種寫法放在 `code` 陣列裡）。`id` 是 lint.ts 裡那一條的穩定名字。 */
interface Violation {
  readonly id: string;
  /** 訊息要指名的東西。 */
  readonly names: RegExp;
  /** 訊息要寫出的「改用什麼」。 */
  readonly suggests: RegExp;
  readonly code: readonly string[];
}

const IMPORT_CORE_MESSAGE = pluginLintImportRestrictions.patterns[0]!.message;

function messageOfSyntax(id: string): string {
  const found = pluginLintSyntaxRestrictions.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`lint.ts 沒有 id 為 ${id} 的語法限制`);
  return found.message;
}

function messageOfProperty(id: string): string {
  const found = pluginLintPropertyRestrictions.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`lint.ts 沒有 id 為 ${id} 的屬性限制`);
  return found.message;
}

function messageOfGlobal(id: string): string {
  const found = pluginLintGlobalRestrictions.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`lint.ts 沒有 id 為 ${id} 的全域限制`);
  return found.message;
}

const VIOLATIONS: readonly (Violation & { readonly expected: () => string })[] = [
  {
    id: 'ctx-root',
    names: /ctx\.root/,
    suggests: /inject.*ctx\.get\(token\)/,
    expected: () => messageOfSyntax('ctx-root'),
    code: [
      'export function apply(ctx: any) { return ctx.root; }',
      "export function apply(ctx: any) { return ctx['root']; }",
      'export function apply(ctx: any) { const { root } = ctx; return root; }',
      'export class P { ctx: any; run() { return this.ctx.root; } }',
      'export function apply(ctx: any) { return ctx?.root; }',
    ],
  },
  {
    id: 'ctx-registry',
    names: /ctx\.registry/,
    suggests: /ctx\.effect/,
    expected: () => messageOfSyntax('ctx-registry'),
    code: [
      'export function apply(ctx: any) { return ctx.registry; }',
      'export function apply(ctx: any) { const { registry } = ctx; return registry; }',
    ],
  },
  {
    id: 'internal-name',
    names: /internal\//,
    suggests: /ctx\.on/,
    expected: () => messageOfSyntax('internal-name'),
    code: [
      "export function apply(ctx: any) { ctx.on('internal/service', () => {}); }",
      'export function apply(ctx: any) { ctx.on(`internal/${1}`, () => {}); }',
      "export const names = ['internal/before-service'];",
    ],
  },
  {
    id: 'process-on',
    names: /行程層級的監聽器/,
    suggests: /ctx\.effect/,
    expected: () => messageOfProperty('process-on'),
    code: ["export function apply() { process.on('exit', () => {}); }"],
  },
  {
    id: 'process-once',
    names: /行程層級的監聽器/,
    suggests: /ctx\.effect/,
    expected: () => messageOfProperty('process-once'),
    code: ["export function apply() { process.once('exit', () => {}); }"],
  },
  {
    id: 'process-addListener',
    names: /行程層級的監聽器/,
    suggests: /ctx\.effect/,
    expected: () => messageOfProperty('process-addListener'),
    code: ["export function apply() { process.addListener('exit', () => {}); }"],
  },
  {
    id: 'process-prependListener',
    names: /行程層級的監聽器/,
    suggests: /ctx\.effect/,
    expected: () => messageOfProperty('process-prependListener'),
    code: ["export function apply() { process.prependListener('exit', () => {}); }"],
  },
  {
    id: 'setInterval',
    names: /setInterval/,
    suggests: /ctx\.effect/,
    expected: () => messageOfGlobal('setInterval'),
    code: ['export function apply() { setInterval(() => {}, 1000); }'],
  },
  {
    id: 'globalThis-setInterval',
    names: /setInterval/,
    suggests: /ctx\.effect/,
    expected: () => messageOfProperty('globalThis-setInterval'),
    code: ['export function apply() { globalThis.setInterval(() => {}, 1000); }'],
  },
  {
    id: 'global-setInterval',
    names: /setInterval/,
    suggests: /ctx\.effect/,
    expected: () => messageOfProperty('global-setInterval'),
    code: ['export function apply() { global.setInterval(() => {}, 1000); }'],
  },
  {
    id: 'import-setInterval',
    names: /setInterval/,
    suggests: /ctx\.effect/,
    // 具名 import 蓋過全域名稱，`no-restricted-globals` 看不到，要靠 `no-restricted-imports` 的 paths。
    expected: () => messageOfGlobal('setInterval'),
    code: [
      "import { setInterval } from 'node:timers'; export function apply() { setInterval(() => {}, 1); }",
    ],
  },
  {
    id: 'import-process-listener',
    names: /行程層級的監聽器/,
    suggests: /ctx\.effect/,
    expected: () => messageOfProperty('process-on'),
    code: ["import { on } from 'node:process'; export const x = on;"],
  },
  {
    id: 'top-level-let-var',
    names: /`let`／`var`/,
    suggests: /apply.*閉包/,
    expected: () => messageOfSyntax('top-level-let-var'),
    code: [
      'let counter = 0; export function apply() { counter += 1; }',
      'var counter = 0; export function apply() { counter += 1; }',
      'export let counter = 0;',
    ],
  },
  {
    id: 'top-level-collection',
    names: /new Map/,
    suggests: /ctx\.effect/,
    expected: () => messageOfSyntax('top-level-collection'),
    code: [
      'const cache = new Map<string, number>(); export const read = () => cache;',
      'const seen = new Set<string>(); export const read = () => seen;',
      'const weak = new WeakMap<object, number>(); export const read = () => weak;',
      'const weakSet = new WeakSet<object>(); export const read = () => weakSet;',
      'export const cache = new Map<string, number>();',
      'const cache = new Map() as Map<string, number>; export const read = () => cache;',
    ],
  },
  {
    id: 'import-nexus-core',
    names: /@nexus\/core/,
    suggests: /@nexus\/sdk/,
    expected: () => IMPORT_CORE_MESSAGE,
    code: [
      "import { PluginRegistry } from '@nexus/core'; export const x = PluginRegistry;",
      "import type { PluginRegistry } from '@nexus/core'; export type X = PluginRegistry;",
      "import { sessionAddressKey } from '@nexus/core/session-address'; export const x = sessionAddressKey;",
      "export { PluginRegistry } from '@nexus/core';",
    ],
  },
  {
    id: 'dynamic-import-nexus-core',
    names: /@nexus\/core/,
    suggests: /@nexus\/sdk/,
    expected: () => messageOfSyntax('dynamic-import-nexus-core'),
    code: ["export const load = () => import('@nexus/core');"],
  },
];

describe('lint.ts 的規則清單與夾具一一對上', () => {
  it('每一條限制都有夾具：新增或改名一條而沒補夾具，這裡紅', () => {
    const covered = new Set<string>();
    for (const violation of VIOLATIONS) covered.add(violation.id);
    // 屬性限制與語法限制的 id 直接對；全域與 import 限制由 `setInterval`／`import-*` 夾具覆蓋。
    const exported = [
      ...pluginLintSyntaxRestrictions.map((entry) => entry.id),
      ...pluginLintPropertyRestrictions.map((entry) => entry.id),
      ...pluginLintGlobalRestrictions.map((entry) => entry.id),
    ];
    expect(exported.filter((id) => !covered.has(id))).toEqual([]);
  });
});

describe('驗收 A：每一條規則各有違規夾具，lint 紅、訊息指名規則並寫出改用什麼', () => {
  for (const violation of VIOLATIONS) {
    for (const [index, code] of violation.code.entries()) {
      it(`${violation.id} #${index + 1}：${code.slice(0, 60)}`, async () => {
        const expected = violation.expected();
        const messages = await messagesOf(code);
        // 正好是這一條的訊息：少了＝規則沒接上，多了＝夾具撞到別條。ESLint 的內建規則會在訊息前面加一段
        // （`'process.on' is restricted from being used.`），所以比的是結尾。
        expect(messages.length).toBeGreaterThan(0);
        for (const message of messages) expect(message.endsWith(expected)).toBe(true);
        expect(expected).toMatch(violation.names);
        expect(expected).toMatch(violation.suggests);
      });
    }
  }
});

describe('驗收 B：合規的插件 lint 綠', () => {
  const COMPLIANT = `
import { tool } from '@langchain/core/tools';
import type { Context } from '@nexus/cordis';
import { defineManifest, injectOf, need, service } from '@nexus/sdk';
import { toolsToken } from '@nexus/tools';
import { z } from 'zod';

const PREFIX = '回聲';
const FROZEN = Object.freeze({ a: 1 });

export const inject = injectOf(need(toolsToken, '^1.0.0'));
export const manifest = defineManifest({} as never);

export function apply(ctx: Context): void {
  let local = 0;
  const cache = new Map<string, number>();
  const bag = new Set<string>();
  const tools = service(ctx, toolsToken);
  ctx.on('dispose', () => cache.clear());
  ctx.effect(() => {
    const timer = setTimeout(() => (local += 1), 10);
    return () => clearTimeout(timer);
  }, 'timer');
  void PREFIX; void FROZEN; void bag; void tool; void z; void tools; void process.env['X']; void crypto.randomUUID();
  process.off('exit', () => {});
}
`;

  it('用 ctx.effect／ctx.on／ctx.get、import @nexus/sdk 與定義套件；函式內的 let、Map 與 setTimeout 都放行', async () => {
    expect(await messagesOf(COMPLIANT)).toEqual([]);
  });

  it('訊息寫的「改用什麼」走得通：`ctx.effect` 裡加窄例外、成對撤除，lint 0 則訊息（沒用到的例外指令也會報，所以也證明例外有被用到）', async () => {
    const code = `
import type { Context } from '@nexus/cordis';

export function apply(ctx: Context): void {
  ctx.effect(() => {
    // eslint-disable-next-line no-restricted-globals -- 輪詢外部狀態，沒有不經全域的計時器服務
    const timer = setInterval(() => {}, 1000);
    return () => clearInterval(timer);
  }, 'poll');
  const onSignal = (): void => {};
  ctx.effect(() => {
    // eslint-disable-next-line no-restricted-properties -- 宿主沒有提供行程事件的服務
    process.on('SIGUSR2', onSignal);
    return () => process.off('SIGUSR2', onSignal);
  }, 'signal');
}
`;
    expect(await messagesOf(code)).toEqual([]);
  });

  it('`@nexus/cordis`、`@nexus/sdk`、`@nexus/tools` 不是 `@nexus/core`：前綴相近的不誤殺', async () => {
    const code =
      "import { a } from '@nexus/cordis'; import { b } from '@nexus/core-types'; export const x = [a, b];";
    expect(await messagesOf(code)).toEqual([]);
  });
});

describe('範圍：只管插件的 src，不含測試檔', () => {
  const VIOLATING = 'let counter = 0; export function apply() { setInterval(() => {}, 1); }';

  it('src 底下的檔會報', async () => {
    expect((await messagesOf(VIOLATING, 'src/plugin.ts')).length).toBeGreaterThan(0);
  });

  it('*.test.ts 不報：測試可以用假計時器、可以直接操作 fiber', async () => {
    expect(await messagesOf(VIOLATING, 'src/plugin.test.ts')).toEqual([]);
  });

  it('src 之外的檔不報（例如套件根的腳本）', async () => {
    expect(await messagesOf(VIOLATING, 'scripts/tool.ts')).toEqual([]);
  });
});
