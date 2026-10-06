/**
 * 工具 schema 目錄的產生器（[#442](https://github.com/DemianLi/nexus-agent/issues/442)）：把**模型實際收到的**每個工具的
 * 名稱、描述、參數 schema 列成一份提交進 repo 的 `docs/tool-catalog.md`。描述一改，review 時 diff 裡就看得到；
 * 目錄過期，[`tool-catalog.test.ts`](./tool-catalog.test.ts) 在 CI 裡就紅。
 *
 * 照 dsh 的 `scripts/gen-tool-catalog.ts`（`5badb15`）：**不從原始碼靜態推**——schema 靜態看不出來（拼接的描述、由
 * 設定決定的名稱）——而是真的把工具組出來、讀它們交給模型的那一份；每個套件都要在清單裡有一列，漏了就讓產生器失敗
 * （`assertManifestComplete`），清單說有工具的套件載入後零個工具也失敗（dsh 的 `assertToolsHarvested`）。
 *
 * ## 與 dsh 的偏離
 *
 * - **不是每個套件各自用預設 Config 單獨啟動。** dsh 的 Config 都有 schema 預設值，單獨啟動得出合法設定；我們好幾個
 *   plugin 的設定欄位是必填（`todo` 的 `allowParallelInProgress`、`workspace-changes` 的 `root`…），出廠值寫在
 *   `apps/harness/cordis.yml` 的條目上，而且有的要別的 plugin 先提供服務（`sandbox-policy`、`system-prompt`）。所以出廠
 *   清單**一次**載進產品組裝，工具各自歸給註冊它的 plugin（`registry.tools` 的 `origin`）。不在出廠清單裡的套件
 *   （選配或由外部決定工具的），清單裡明寫是哪一種，選配的用清單上給的設定單獨載。
 * - **目錄讀的是 `bindTools` 收到的那一份**（`convertToOpenAITool` 轉出來的線上形狀），不是 plugin 註冊時的原物件：
 *   中間隔著圍堵與 middleware，模型看到的才是要審的東西。
 * - **基座的工具也列**（dsh 的 `dsh-tools` 也在它的目錄裡）：零 plugin 組裝綁到的那些，來源標成基座。
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { loadPlugins } from '@nexus/core';
import type { PluginEntry } from '@nexus/core';
import { createNexusAgent } from './agent-factory.js';
import { createCliAgent } from './assembly-root.js';
import { shippedPlugins, withSystemPromptVariables } from './fixtures.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

/** 一個工具在目錄裡的一列。 */
export interface CatalogTool {
  readonly name: string;
  readonly description: string;
  /** 送給供應商的 `parameters`（JSON Schema）。 */
  readonly parameters: unknown;
}

/** 一個來源底下的工具。 */
export interface CatalogSection {
  /** 來源名：plugin 的 `name`，或 {@link BASE_SOURCE}、{@link ASSEMBLY_SOURCE}。 */
  readonly source: string;
  /** 一句話交代這個來源是什麼（套件路徑、為什麼這樣列）。 */
  readonly note: string;
  readonly tools: readonly CatalogTool[];
}

/** 基座（deepagents）自己的工具：零 plugin 組裝綁到的那些。 */
export const BASE_SOURCE = '基座（deepagents）';
/** 組裝點自己加的、不經 plugin 註冊點的工具（背景子代理那一組等）。 */
export const ASSEMBLY_SOURCE = '組裝點（harness）';

/** 清單上一個套件的預期。 */
export type PackageExpectation =
  | { readonly kind: 'shipped'; readonly reason: string }
  | {
      readonly kind: 'standalone';
      readonly reason: string;
      /** 不在出廠清單裡的選配 plugin 單獨載入用的設定。 */
      readonly config: unknown;
    }
  | { readonly kind: 'external'; readonly reason: string }
  | {
      readonly kind: 'assembly';
      readonly reason: string;
      /** 這個套件的工具不經出廠清單，由 `createCliAgent` 在某些條件下掛上，列在「組裝點」一節；這裡寫它們的名字。 */
      readonly tools: readonly string[];
    }
  | { readonly kind: 'none'; readonly reason: string };

/**
 * `packages/nexus-plugin-*` 每一個套件都要在這裡有一列，說它**預期**怎麼貢獻工具：
 *
 * - `shipped`：在出廠清單裡，註冊至少一個工具；
 * - `standalone`：不在出廠清單裡，用這一列給的設定單獨載入，要有至少一個工具；
 * - `external`：工具由設定指到的外部 server 決定，目錄列不出；
 * - `assembly`：工具由組裝點在某些條件下掛上（例如給了 `--workspace`），列在「組裝點」一節，名字寫在這一列；
 * - `none`：沒有工具（理由要寫）。
 *
 * 預期與實際對不上（清單說有工具卻零個、說沒有卻冒出工具、套件沒列、列了卻沒有這個套件）都讓產生器失敗。
 */
export const PACKAGE_MANIFEST: Readonly<Record<string, PackageExpectation>> = {
  'nexus-plugin-agent-instructions': { kind: 'none', reason: '只把專案指令注入系統提示詞。' },
  'nexus-plugin-ask-user': { kind: 'shipped', reason: '`ask_user_question`。' },
  'nexus-plugin-commands': {
    kind: 'none',
    reason: '命令解析與執行的函式庫，不是 plugin（沒有預設匯出的 plugin）。',
  },
  'nexus-plugin-echo': { kind: 'shipped', reason: '`echo`，出廠清單上的示範工具。' },
  'nexus-plugin-feedback': {
    kind: 'none',
    reason: '評分與評語走 `/feedback` 命令與 wire，不是模型的工具。',
  },
  'nexus-plugin-goal': { kind: 'shipped', reason: '`get_goal`、`create_goal`、`update_goal`。' },
  'nexus-plugin-mcp': {
    kind: 'external',
    reason:
      '工具由設定指到的外部 MCP server 決定，以 `mcp__<server>__<tool>` 註冊；沒有 server 就沒有工具。',
  },
  'nexus-plugin-memory': { kind: 'none', reason: '只把記憶注入系統提示詞。' },
  'nexus-plugin-plan-mode': { kind: 'shipped', reason: '`exit_plan_mode`。' },
  'nexus-plugin-present': { kind: 'shipped', reason: '`present`。' },
  'nexus-plugin-quickjs': {
    kind: 'standalone',
    reason: '`run_javascript`；不在出廠清單（選配），用預設設定單獨載入。',
    config: {},
  },
  'nexus-plugin-sandbox-policy': {
    kind: 'assembly',
    reason: '`request_sandbox_escalation` 由 `createCliAgent` 在給了 `--workspace` 時掛上。',
    tools: ['request_sandbox_escalation'],
  },
  'nexus-plugin-skills': { kind: 'none', reason: '只把技能清單注入系統提示詞。' },
  'nexus-plugin-submit-record': { kind: 'shipped', reason: '`submit_record`。' },
  'nexus-plugin-system-prompt': { kind: 'none', reason: '只組系統提示詞。' },
  'nexus-plugin-telemetry-otel': { kind: 'none', reason: '遙測匯出，不是模型的工具。' },
  'nexus-plugin-todo': { kind: 'shipped', reason: '`todo_write`。' },
  'nexus-plugin-token-meter': { kind: 'none', reason: '用量投影，給畫面看。' },
  'nexus-plugin-trajectory': { kind: 'none', reason: '軌跡投影，給畫面看。' },
  'nexus-plugin-workspace-changes': { kind: 'none', reason: '每一輪的改動摘要，給畫面看。' },
};

/** 一個 plugin 套件的實況。 */
export interface PackageFacts {
  /** 套件目錄名，例如 `nexus-plugin-goal`。 */
  readonly dir: string;
  /** 預設匯出的 plugin 的 `name`；套件沒有預設匯出的 plugin（例如純函式庫）就沒有。 */
  readonly pluginName: string | undefined;
}

/**
 * 完整性檢查，純函式（給突變與單測用）。
 *
 * @param packages - 磁碟上的套件。
 * @param manifest - 清單。
 * @param contributed - 載入後每個 plugin `name` 實際貢獻的工具名。
 * @param assemblyTools - 組裝點自己加的工具名（不經 plugin 註冊點的那些）。
 * @throws {Error} 任何一種預期與實際對不上，訊息指名是哪個套件、哪一種。
 */
export function assertManifestComplete(
  packages: readonly PackageFacts[],
  manifest: Readonly<Record<string, PackageExpectation>>,
  contributed: ReadonlyMap<string, readonly string[]>,
  assemblyTools: ReadonlySet<string> = new Set(),
): void {
  const problems: string[] = [];
  const onDisk = new Set(packages.map((pkg) => pkg.dir));
  for (const pkg of packages) {
    const expectation = manifest[pkg.dir];
    const tools = pkg.pluginName === undefined ? [] : (contributed.get(pkg.pluginName) ?? []);
    if (expectation === undefined) {
      problems.push(
        `${pkg.dir} 不在 PACKAGE_MANIFEST 裡：要列它是 shipped、standalone、external 還是 none（附理由）；` +
          `出廠組裝裡它註冊了：${tools.length === 0 ? '（沒有工具）' : tools.join('、')}` +
          (pkg.pluginName === undefined ? '；它沒有預設匯出的 plugin' : ''),
      );
      continue;
    }
    if (
      (expectation.kind === 'shipped' || expectation.kind === 'standalone') &&
      tools.length === 0
    ) {
      problems.push(
        `${pkg.dir} 清單說有工具（${expectation.kind}），載入後一個工具都沒有——壞掉的啟動，或清單過期`,
      );
    }
    if (expectation.kind === 'assembly') {
      for (const name of expectation.tools) {
        if (!assemblyTools.has(name)) {
          problems.push(
            `${pkg.dir} 清單說組裝點會掛 ${name}，組裝出來卻沒有它——清單過期，或那個條件沒被走到`,
          );
        }
      }
    }
    if (expectation.kind === 'none' && tools.length > 0) {
      problems.push(`${pkg.dir} 清單說沒有工具，載入後卻註冊了 ${tools.join('、')}——清單過期`);
    }
  }
  for (const dir of Object.keys(manifest)) {
    if (!onDisk.has(dir))
      problems.push(`PACKAGE_MANIFEST 列了 ${dir}，磁碟上沒有這個套件——清單過期`);
  }
  if (problems.length > 0)
    throw new Error(`工具目錄的套件清單對不上：\n- ${problems.join('\n- ')}`);
}

/** `packages/` 底下有 `package.json` 的 `nexus-plugin-*`，依目錄名排序。 */
export function pluginPackageDirs(packagesRoot: string): readonly string[] {
  return readdirSync(packagesRoot)
    .filter(
      (dir) =>
        dir.startsWith('nexus-plugin-') && existsSync(join(packagesRoot, dir, 'package.json')),
    )
    .sort();
}

async function packageFacts(packagesRoot: string, dir: string): Promise<PackageFacts> {
  const name = (
    JSON.parse(readFileSync(join(packagesRoot, dir, 'package.json'), 'utf8')) as { name: string }
  ).name;
  const mod = (await import(name)) as { default?: unknown };
  const candidate = mod.default as { name?: unknown; apply?: unknown } | undefined;
  const isPlugin = candidate !== undefined && typeof candidate.apply === 'function';
  return { dir, pluginName: isPlugin ? String(candidate.name) : undefined };
}

type BoundTool = { name: string; description?: string };

/** 一次組裝裡模型實際綁到的工具，依名字索引；`parameters` 是送出去的那一份。 */
function boundCatalogTools(bound: readonly unknown[]): Map<string, CatalogTool> {
  const tools = new Map<string, CatalogTool>();
  for (const candidate of bound) {
    const openai = convertToOpenAITool(candidate as BoundTool);
    tools.set(openai.function.name, {
      name: openai.function.name,
      description: openai.function.description ?? '',
      parameters: openai.function.parameters,
    });
  }
  return tools;
}

/** 腳本模型答一句就收，只為了讓基座對模型 `bindTools` 一次。 */
const scripted = () => new ScriptedChatModel({ turns: [{ content: '好。' }] });

/** 零 plugin 組裝：基座與組裝點在沒有任何 plugin 時綁給模型的工具。 */
async function baseTools(): Promise<Map<string, CatalogTool>> {
  const model = scripted();
  const built = await createNexusAgent({ model, plugins: [] });
  try {
    await built.agent.invoke(toAgentInvocation('看一下。'), {
      configurable: { thread_id: 'tool-catalog-base' },
    });
    return boundCatalogTools(model.boundTools);
  } finally {
    await built.dispose();
  }
}

/**
 * 出廠清單的產品組裝：模型實際綁到的工具，加上各工具是哪個 plugin 註冊的。
 *
 * 組裝**兩種**：沒給 `--workspace`，與給了（有它才掛 `request_sandbox_escalation` 那一類）。兩邊都有的工具名，描述與
 * schema 必須逐字相同——不同就是目錄寫不出「模型看到的」那一個，直接失敗。
 */
async function shippedTools(
  tempRoot: string,
): Promise<{ bound: Map<string, CatalogTool>; origins: Map<string, string> }> {
  const shipped = await shippedPlugins();
  const bound = new Map<string, CatalogTool>();
  for (const workspace of [undefined, tempRoot]) {
    const assembled = await createCliAgent(
      { live: false, ...(workspace !== undefined && { workspace }) },
      shipped,
      tempRoot,
    );
    try {
      await assembled.agent.invoke(toAgentInvocation('看一下。'), {
        configurable: { thread_id: 'tool-catalog-shipped' },
      });
      for (const [name, tool] of boundCatalogTools(
        (assembled.model as ScriptedChatModel).boundTools,
      )) {
        const seen = bound.get(name);
        if (seen !== undefined && JSON.stringify(seen) !== JSON.stringify(tool)) {
          throw new Error(
            `工具 ${name} 在有無 --workspace 兩種組裝下描述或 schema 不同，目錄只能列一個`,
          );
        }
        bound.set(name, tool);
      }
    } finally {
      await assembled.dispose();
    }
  }
  // 歸屬另載一次：產品組裝不交出註冊表。載入同一份清單、同一組補的服務，`origin` 就是註冊那一列的 plugin。
  const { registry, dispose } = await loadPlugins(withSystemPromptVariables(shipped));
  try {
    const origins = new Map<string, string>();
    for (const name of registry.tools.effective().keys()) {
      const origin = registry.tools.resolve(name)?.origin.name;
      if (origin !== undefined) origins.set(name, origin);
    }
    return { bound, origins };
  } finally {
    await dispose();
  }
}

/** 不在出廠清單的選配 plugin，用清單上的設定單獨載入，回它註冊的工具。 */
async function standaloneTools(
  packagesRoot: string,
  dir: string,
  config: unknown,
): Promise<Map<string, CatalogTool>> {
  const name = (
    JSON.parse(readFileSync(join(packagesRoot, dir, 'package.json'), 'utf8')) as { name: string }
  ).name;
  const plugin = ((await import(name)) as { default: PluginEntry['plugin'] }).default;
  const { registry, dispose } = await loadPlugins(
    withSystemPromptVariables([{ plugin, config } as PluginEntry]),
  );
  try {
    return boundCatalogTools([...registry.tools.effective().values()].map((entry) => entry.value));
  } finally {
    await dispose();
  }
}

/**
 * 產生目錄的資料。
 *
 * @param repoRoot - repo 根（找 `packages/`）。
 * @returns 依來源排序的區段，區段內依工具名排序。
 * @throws {Error} 完整性檢查沒過，見 {@link assertManifestComplete}。
 */
export async function collectToolCatalog(repoRoot: string): Promise<readonly CatalogSection[]> {
  const packagesRoot = join(repoRoot, 'packages');
  const dirs = pluginPackageDirs(packagesRoot);
  const facts = await Promise.all(dirs.map((dir) => packageFacts(packagesRoot, dir)));

  const base = await baseTools();
  const tempRoot = mkdtempSync(join(tmpdir(), 'nexus-tool-catalog-'));
  let shipped: Awaited<ReturnType<typeof shippedTools>>;
  try {
    shipped = await shippedTools(tempRoot);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
  const { bound, origins } = shipped;

  const byPlugin = new Map<string, CatalogTool[]>();
  const contributed = new Map<string, string[]>();
  const record = (pluginName: string, tool: CatalogTool): void => {
    byPlugin.set(pluginName, [...(byPlugin.get(pluginName) ?? []), tool]);
    contributed.set(pluginName, [...(contributed.get(pluginName) ?? []), tool.name]);
  };

  const assembly: CatalogTool[] = [];
  for (const [name, tool] of bound) {
    if (base.has(name)) continue;
    const origin = origins.get(name);
    if (origin === undefined) assembly.push(tool);
    else record(origin, tool);
  }

  for (const pkg of facts) {
    const expectation = PACKAGE_MANIFEST[pkg.dir];
    if (expectation?.kind !== 'standalone' || pkg.pluginName === undefined) continue;
    for (const tool of (
      await standaloneTools(packagesRoot, pkg.dir, expectation.config)
    ).values()) {
      record(pkg.pluginName, tool);
    }
  }

  assertManifestComplete(
    facts,
    PACKAGE_MANIFEST,
    contributed,
    new Set(assembly.map((tool) => tool.name)),
  );

  const byName = (left: CatalogTool, right: CatalogTool): number =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  const sections: CatalogSection[] = [
    {
      source: BASE_SOURCE,
      note: '零 plugin 組裝時基座與組裝點綁給模型的工具。',
      // 模型實際收到的是出廠組裝那一份（例如 `task` 的描述帶著出廠清單上的子代理）；零 plugin 組裝只決定「哪些算基座」。
      tools: [...base.values()].map((tool) => bound.get(tool.name) ?? tool).sort(byName),
    },
  ];
  if (assembly.length > 0) {
    sections.push({
      source: ASSEMBLY_SOURCE,
      note: '出廠組裝多綁的、不經 plugin 註冊點的工具。',
      tools: assembly.sort(byName),
    });
  }
  for (const pluginName of [...byPlugin.keys()].sort()) {
    const dir = facts.find((pkg) => pkg.pluginName === pluginName)?.dir;
    sections.push({
      source: pluginName,
      note: dir === undefined ? 'plugin' : `plugin，套件 packages/${dir}`,
      tools: [...(byPlugin.get(pluginName) ?? [])].sort(byName),
    });
  }
  return sections;
}

/** 目錄檔頭，也是「怎麼重新產生」的唯一出處。 */
export const CATALOG_REGEN_COMMAND = 'pnpm --filter @nexus/harness run gen-tool-catalog';

/**
 * 把區段排成 markdown。輸出只由工具資料決定：排序固定、沒有時間或路徑。
 *
 * @param sections - {@link collectToolCatalog} 的結果。
 * @returns 整份目錄的文字，結尾一個換行。
 */
export function renderToolCatalog(sections: readonly CatalogSection[]): string {
  const total = sections.reduce((sum, section) => sum + section.tools.length, 0);
  const lines: string[] = [
    '# 工具 schema 目錄',
    '',
    `模型實際收到的每個工具的名稱、描述與參數 schema（共 ${String(total)} 個）。**這份檔案由程式產生，不要手改**：`,
    '',
    '```bash',
    CATALOG_REGEN_COMMAND,
    '```',
    '',
    '`apps/harness/src/tool-catalog.test.ts` 在 CI 裡驗它沒有過期；改了工具的名稱、描述或參數，重新產生並一起提交，',
    'review 時就看得到模型看到的字變了什麼。範圍與做法見 `apps/harness/src/tool-catalog.ts` 的檔頭（#442）。',
    '',
  ];
  for (const section of sections) {
    lines.push(`## ${section.source}`, '', section.note, '');
    for (const tool of section.tools) {
      lines.push(
        `### \`${tool.name}\``,
        '',
        '描述：',
        '',
        '```text',
        tool.description,
        '```',
        '',
        '參數：',
        '',
        '```json',
        JSON.stringify(tool.parameters, null, 2),
        '```',
        '',
      );
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
