/**
 * 一致性套件：每顆插件的 CI 都跑（決議 §3-4 第 12 條）。
 *
 * **純函式，回結構化結果**：不相依 vitest，插件自己的測試只要 `expect(await checkConformance(...)).toEqual([])`。
 * 回傳「哪一格不合格、為什麼」比一個紅掉的 `it` 好用——後台、gate 與插件作者看的是同一份東西。
 *
 * 量的全部走真的 Loader 與 fiber（dsh 的三種測試寫法之一：經 Loader 開機的真組合測試，
 * `packages/AGENTS.md:7`），不手建 `ctx.plugin(...)`。
 *
 * ## 這一刀的四格
 *
 * | check | 量什麼 |
 * | --- | --- |
 * | `manifest` | manifest 在場、通過 {@link validateManifest} |
 * | `export-form` | 不能有 default 匯出；`name`／`apply` 在場；Loader 的 `unwrapExports` 取回的就是這個命名空間；`Config` 就是 manifest 的 `config`；`inject` 與 `consumes` 一致 |
 * | `unload` | 掛上後有貢獻、**經 fiber 卸載**（移除那一列）後活資源回到掛載前 |
 * | `missing` | 缺提供者時消費者停在 PENDING，等的服務名正好是 `consumes` 裡必要的那幾個 |
 *
 * 兩版並存與逾時留給版本路由那張卡。
 *
 * **只管樹上的函式插件。** 「不能有 default」是 Loader 的 `unwrapExports` 對函式插件的規則
 * （有 default 就取 default，具名的 `inject`／`Config` 會被丟掉）；還留在相容層的插件是
 * `NexusPlugin` 物件，照舊 default export，不在這裡的射程內。
 *
 * @module
 */

import { Context } from '@nexus/cordis';
import type { Fiber, Message } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';

import { ManifestError, validateManifest } from './manifest.js';
import type { Manifest } from './manifest.js';

/**
 * 上游 `FiberState` 的值（vendor/cordis/src/fiber.ts）。它是 `const enum`，nexus 開了 `verbatimModuleSyntax`，
 * 從宣告檔讀它會 TS2748，所以照值抄一份（`measure/cordis-1386/tree.ts` 同一個理由）。
 */
export const FIBER_STATE = {
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
} as const;

/** 一格的名字。 */
export type ConformanceCheck = 'manifest' | 'export-form' | 'unload' | 'missing';

/** 一格不合格。 */
export interface ConformanceFailure {
  readonly check: ConformanceCheck;
  readonly message: string;
}

/** 受測的插件與它需要的環境。 */
export interface ConformanceTarget {
  /** 掛上去時用的列 id；錯誤訊息指名它。 */
  readonly row: string;
  /** `import()` 得到的命名空間（或等價的物件）。 */
  readonly module: unknown;
  /**
   * 那一列的設定；省略就給 `{}`。Loader 對沒寫 `config` 的列交 `undefined`，`strictObject` 收不下它，
   * 所以建列的宿主要補 `{}`（`docs/plugin-contract.md`）。
   */
  readonly config?: unknown;
  /**
   * 先於受測插件掛上的提供者，以名字為鍵；值是 Cordis 插件（函式、類別或物件）。
   * 工廠形式（`() => plugin`）讓每次 boot 拿到一份新的狀態——受測的提供者通常帶著登記處，
   * 兩次 boot 共用同一份就量不到卸載。
   */
  readonly providers?: Readonly<Record<string, () => unknown>>;
  /**
   * 活資源的數量：受測插件透過接縫留在別處的東西（登記處裡的工具數、監聽器數⋯）。
   * 掛上後要比掛上前多，卸載後要回到掛上前；**沒有變多就是量不到卸載，同樣判不合格**。
   */
  readonly residue: () => number;
}

interface Tree {
  readonly root: Context;
  readonly loader: Loader;
  readonly errors: Message[];
}

async function boot(builtins: Record<string, unknown>): Promise<Tree> {
  const root = new Context();
  const errors: Message[] = [];
  root.logger.exporter({
    export: (message) => void (message.type === 'error' && errors.push(message)),
  });
  await root.plugin(Loader);
  Object.assign(root.loader.builtins, builtins);
  return { root, loader: root.loader, errors };
}

/**
 * 那一列真正的 Fiber。上游 `Entry.fiber` 存的是 `registry.plugin()` 回的 PromiseLike 包裝（dsh 本地修改第 20 條），
 * 要比身分得取 `.ctx.fiber`。
 */
export function fiberOf(loader: Loader, row: string): Fiber | undefined {
  return loader.resolve(row).fiber?.ctx.fiber;
}

/**
 * 一顆 fiber 還在等哪些服務：`inject` 裡有、但全域找不到（或不是 ACTIVE）的那幾個。
 * 啟動結算與一致性套件用同一個定義（`startup-audit.ts` 的 `auditTreeEntries` 是同一行）。
 */
export function missingServices(fiber: Fiber): string[] {
  return Object.keys(fiber.inject).filter((name) => fiber.ctx.get(name) === undefined);
}

function providerBuiltins(target: ConformanceTarget): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(target.providers ?? {}).map(([name, make]) => [name, make()]),
  );
}

async function mountProviders(tree: Tree, target: ConformanceTarget): Promise<void> {
  for (const name of Object.keys(target.providers ?? {})) {
    await tree.loader.create({ name: `cordis:${name}` });
  }
  await tree.loader.await();
}

function exportFormFailures(
  target: ConformanceTarget,
  manifest: Manifest | undefined,
  loader: Loader,
): string[] {
  const ns = target.module as Record<string, unknown> | null;
  if (typeof ns !== 'object' || ns === null) return ['模組不是物件'];
  const problems: string[] = [];
  if ('default' in ns) {
    problems.push(
      '不能有 default 匯出：Loader 的 unwrapExports 有 default 就取 default，具名的 name／inject／Config 會被丟掉',
    );
  }
  if (typeof ns.name !== 'string' || ns.name === '') problems.push('缺具名匯出 name');
  if (typeof ns.apply !== 'function') problems.push('缺具名匯出 apply');
  if (loader.unwrapExports(ns) !== ns) {
    problems.push('Loader 的 unwrapExports 取回的不是這個命名空間：掛上去的會是別的東西');
  }
  if (manifest === undefined) return problems;

  if (ns.Config !== manifest.config) {
    problems.push('具名匯出 Config 必須就是 manifest.config：設定的 schema 只能有一個出處');
  }
  const inject = (ns.inject ?? {}) as Record<string, { range?: string } | null> | string[];
  const injected = new Map<string, string | undefined>(
    Array.isArray(inject)
      ? inject.map((name) => [name, undefined])
      : Object.entries(inject).map(([name, value]) => [name, value?.range]),
  );
  for (const consume of manifest.consumes) {
    const has = injected.has(consume.token);
    if (consume.optional === true) {
      if (has) problems.push(`選配的 ${consume.token} 不該放進 inject（選配服務用 ctx.get 讀）`);
      continue;
    }
    if (!has) {
      problems.push(`manifest 宣告要 ${consume.token}，inject 裡沒有`);
    } else if (injected.get(consume.token) !== consume.range) {
      problems.push(
        `${consume.token} 的範圍兩邊不一致：manifest 是 ${consume.range}，inject 是 ${injected.get(consume.token) ?? '(沒寫)'}`,
      );
    }
  }
  const declared = new Set(manifest.consumes.map((consume) => consume.token));
  for (const name of injected.keys()) {
    if (!declared.has(name)) problems.push(`inject 有 ${name}，manifest 的 consumes 沒有`);
  }
  return problems;
}

/**
 * 對一顆插件跑全部格子。
 *
 * @returns 不合格的格子；空陣列代表全過。每一格不合格最多報一條，同一格的多個問題併在一條訊息裡。
 */
export async function checkConformance(target: ConformanceTarget): Promise<ConformanceFailure[]> {
  const failures: ConformanceFailure[] = [];
  const fail = (check: ConformanceCheck, message: string) =>
    failures.push({ check, message: `列 ${target.row}：${message}` });
  const ns = target.module as Record<string, unknown> | null;

  // ── manifest
  let manifest: Manifest | undefined;
  try {
    manifest = validateManifest(
      typeof ns === 'object' && ns !== null ? ns.manifest : undefined,
      target.row,
    );
  } catch (error) {
    if (!(error instanceof ManifestError)) throw error;
    failures.push({ check: 'manifest', message: error.message });
  }

  // ── export-form
  const form = await boot({});
  const formProblems = exportFormFailures(target, manifest, form.loader);
  await form.root.fiber.dispose();
  if (formProblems.length > 0) fail('export-form', formProblems.join('；'));

  // ── unload：掛上、移除那一列、看活資源
  const live = await boot({ ...providerBuiltins(target), target: target.module });
  try {
    await mountProviders(live, target);
    const before = target.residue();
    await live.loader.create({
      id: target.row,
      name: 'cordis:target',
      config: target.config ?? {},
    } as never);
    await live.loader.await();
    const fiber = fiberOf(live.loader, target.row);
    if (fiber?.state !== FIBER_STATE.ACTIVE) {
      fail('unload', `掛不上來（狀態 ${fiber?.state ?? '沒有 fiber'}），量不到卸載`);
    } else {
      const during = target.residue();
      if (during <= before) {
        fail(
          'unload',
          `掛上後活資源沒有變多（${before} → ${during}），這一格量不到卸載：residue 要指到插件貢獻的地方`,
        );
      }
      // 直接卸載那顆 fiber 並等它收斂（dsh「dispose the fiber and observe removal」）。不用 `loader.remove`：
      // 它發起卸載卻不等（`entry.fiber?.dispose()`），回來時 fiber 還在 UNLOADING；再呼叫一次 dispose 也只拿到
      // 「單次結果」而提早返回。
      await fiber.dispose();
      const after = target.residue();
      // `fiber.state` 的型別被前面的比較窄化成 ACTIVE，這裡要的是「之後的」狀態。
      const settled: number = fiber.state;
      if (settled !== FIBER_STATE.DISPOSED) {
        fail('unload', `移除那一列之後 fiber 沒有收斂到 DISPOSED（狀態 ${settled}）`);
      }
      if (after !== before) {
        fail(
          'unload',
          `卸載後活資源沒有回到掛載前：掛載前 ${before}、掛上後 ${during}、卸載後 ${after}`,
        );
      }
    }
  } finally {
    await live.root.fiber.dispose();
  }

  // ── missing：沒有提供者
  if (manifest !== undefined) {
    const required = manifest.consumes.filter((c) => c.optional !== true).map((c) => c.token);
    const bare = await boot({ target: target.module });
    try {
      await bare.loader.create({
        id: target.row,
        name: 'cordis:target',
        config: target.config ?? {},
      } as never);
      await bare.loader.await();
      const fiber = fiberOf(bare.loader, target.row);
      if (required.length === 0) {
        if (fiber?.state !== FIBER_STATE.ACTIVE) {
          fail(
            'missing',
            `沒有任何必要依賴，卻沒有直接起來（狀態 ${fiber?.state ?? '沒有 fiber'}）`,
          );
        }
      } else if (fiber?.state !== FIBER_STATE.PENDING) {
        fail(
          'missing',
          `缺 ${required.join('、')} 時應該停在 PENDING，實際狀態 ${fiber?.state ?? '沒有 fiber'}`,
        );
      } else {
        const missing = missingServices(fiber).sort();
        const expected = [...required].sort();
        if (missing.join() !== expected.join()) {
          fail(
            'missing',
            `等的服務是 ${missing.join('、') || '（空）'}，manifest 宣告的必要依賴是 ${expected.join('、')}`,
          );
        }
      }
    } finally {
      await bare.root.fiber.dispose();
    }
  }
  return failures;
}
