/**
 * 技能的調用策略與掃描（[#1574](https://github.com/DemianLi/nexus-agent/issues/1574) 刀 1）。
 *
 * ## 為什麼要自己解析
 *
 * SKILL.md 的 `disable-model-invocation`／`user-invocable` 兩個旗標，基座（`deepagents@1.13.1`）一個都不讀：
 * `parseSkillMetadataFromContent` 只取 `name`、`description`、`metadata`、`license`、`compatibility`、`allowed-tools`、
 * `module`，掃到的全部印進 system prompt。所以標成「只給人叫」的技能今天照樣列給模型，旗標寫錯值的也一樣。
 *
 * dsh 的做法：提供者解析旗標，舊鍵或不在值表上的值整份不收（fail-closed，`skill-filesystem/src/index.ts:831-837`，
 * `687f282e`）；不合規的根本不成為候選（`discoverRoot`，`:730-756`），同名由 rank 決勝（`skill/src/index.ts:78-79`、`:808`）；
 * `tool-skill` 再只把 `isModelInvocable` 的列給模型。
 * 這裡照它解析、照它決勝，模型那一側由 {@link modelVisibleSkillsBackend} 讓基座看不到（偏離登記在 `skills-middleware.ts` 檔頭）。
 *
 * ## 掃描形狀照基座
 *
 * 來源路徑的兩種形狀（父目錄、單一技能）、`SKILL.md` 路徑的拼法、讀檔方式（有 `downloadFiles` 先用它）、frontmatter 正規式、
 * `yaml.parse`、同名後者贏，逐條照基座的 `listSkillsFromBackend`／`readFileFromBackend`／`parseSkillMetadataFromContent`
 * （`langsmith-zm0ILQsV.js:4314-4436`）。兩邊對同一個目錄要判得一樣，視圖濾掉的才正好是基座會列的那一份。
 *
 * @module
 */

import { adaptBackendProtocol, resolveBackend } from 'deepagents';
import type {
  AnyBackendProtocol,
  BackendFactory,
  BackendProtocolV2,
  BackendRuntime,
  LsResult,
} from 'deepagents';
import { parse as parseYaml } from 'yaml';

/** 一份技能誰叫得到。兩格都照 dsh 的 `SkillInvocationPolicy`。 */
export interface SkillInvocationPolicy {
  /** `disable-model-invocation: true` 就是 `false`：模型看不到它。 */
  readonly modelInvocable: boolean;
  /** `user-invocable: false` 就是 `false`：人打 `/名字` 叫不出來。 */
  readonly userInvocable: boolean;
}

/** 掃到的一份技能。`path` 是 backend 命名空間的路徑，不是磁碟路徑。 */
export interface SkillCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly path: string;
  readonly invocation: SkillInvocationPolicy;
  /** frontmatter 之後的正文，去掉頭尾空白（同 dsh `parsed.body.trim()`）。 */
  readonly body: string;
}

/**
 * 從 frontmatter 讀調用策略，逐條照 dsh `parseInvocationPolicy`（`skill-filesystem/src/index.ts:1007-1023`）。
 *
 * @param frontmatter - `yaml.parse` 出來的那個物件。
 * @returns 兩格都有值：沒寫的旗標取預設（模型叫得到、人叫得到）。
 * @throws {Error} 寫了舊鍵（`disableModelInvocation`、`modelInvocable`、`userInvocable`）。
 * @throws {TypeError} 旗標的值不在值表上（見 {@link frontmatterBoolean}）。
 */
export function parseSkillInvocation(frontmatter: Record<string, unknown>): SkillInvocationPolicy {
  rejectLegacyInvocationKey(frontmatter, 'disableModelInvocation', 'disable-model-invocation');
  rejectLegacyInvocationKey(frontmatter, 'modelInvocable', 'disable-model-invocation');
  rejectLegacyInvocationKey(frontmatter, 'userInvocable', 'user-invocable');
  const disableModelInvocation = frontmatterBoolean(frontmatter, 'disable-model-invocation');
  const userInvocable = frontmatterBoolean(frontmatter, 'user-invocable');
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false,
  };
}

function rejectLegacyInvocationKey(
  data: Record<string, unknown>,
  legacy: string,
  canonical: string,
): void {
  if (Object.hasOwn(data, legacy)) {
    throw new Error(`frontmatter 的 "${legacy}" 不支援，改用 "${canonical}"`);
  }
}

/**
 * 一個布林旗標。值表照 dsh `frontmatterBoolean`（`:1025-1044`）：布林、`1`／`0`（數字或字串）、
 * `true`／`yes`／`on` 與 `false`／`no`／`off`（不分大小寫）。沒寫回 `undefined`，其餘一律拋。
 */
function frontmatterBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined;
  const value = data[key];
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true':
      case 'yes':
      case 'on':
        return true;
      case 'false':
      case 'no':
      case 'off':
        return false;
    }
  }
  throw new TypeError(`frontmatter 的 "${key}" 要是布林值`);
}

/** 同基座 `parseSkillMetadataFromContent` 的上限與正規式。 */
const MAX_SKILL_FILE_LENGTH = 10485760;
const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*\n/;
const MAX_SKILL_DESCRIPTION_LENGTH = 1024;

/**
 * 一個 `SKILL.md` 讀出來的結果。
 *
 * - `skill`：基座會收的那一份，調用策略也解析過了；
 * - `invalid`：基座會收，但旗標解析拋錯。dsh 整份不收，**也不參與同名決勝**；
 * - `ignored`：讀不到、太大、沒有 frontmatter、YAML 壞了、缺 `name`／`description`。基座自己也跳過（並自己 warn），這裡不表態；
 * - `unreadable`：基座讀不讀得到不知道，這一側讀失敗了。視圖照 fail-closed 拿掉它。
 */
type SkillFileOutcome =
  | { readonly kind: 'skill'; readonly entry: SkillCatalogEntry }
  | { readonly kind: 'invalid'; readonly name: string }
  | { readonly kind: 'ignored' }
  | { readonly kind: 'unreadable' };

/** 掃到的一個 `SKILL.md`：路徑的拼法同基座，視圖靠它對回 `ls` 的那一列。 */
interface ScannedSkillFile {
  readonly skillMdPath: string;
  readonly outcome: SkillFileOutcome;
}

/** 同基座 `readFileFromBackend`（`:4374-4386`）。讀不到回 `null`；拋的往上拋。 */
async function readSkillFile(backend: BackendProtocolV2, path: string): Promise<string | null> {
  if (backend.downloadFiles) {
    const results = await backend.downloadFiles([path]);
    if (results.length !== 1) return null;
    const response = results[0]!;
    if (response.error != null || response.content == null) return null;
    return new TextDecoder().decode(response.content);
  }
  const result = await backend.read(path);
  if (result.error) return null;
  if (typeof result.content !== 'string') return null;
  return result.content;
}

async function readSkillOutcome(
  backend: BackendProtocolV2,
  skillMdPath: string,
): Promise<SkillFileOutcome> {
  let content: string | null;
  try {
    content = await readSkillFile(backend, skillMdPath);
  } catch {
    return { kind: 'unreadable' };
  }
  if (content === null) return { kind: 'ignored' };
  if (content.length > MAX_SKILL_FILE_LENGTH) return { kind: 'ignored' };
  const match = content.match(FRONTMATTER);
  if (!match) return { kind: 'ignored' };
  let data: unknown;
  try {
    data = parseYaml(match[1]!);
  } catch {
    return { kind: 'ignored' };
  }
  if (!data || typeof data !== 'object') return { kind: 'ignored' };
  const frontmatter = data as Record<string, unknown>;
  const name = String(frontmatter['name'] ?? '').trim();
  const description = String(frontmatter['description'] ?? '').trim();
  if (!name || !description) return { kind: 'ignored' };
  let invocation: SkillInvocationPolicy;
  try {
    invocation = parseSkillInvocation(frontmatter);
  } catch (error) {
    // 同 dsh `:831-837`：整份不收、帶路徑記一筆。
    console.warn(
      `技能檔 ${skillMdPath} 不收：調用旗標不合規則：${error instanceof Error ? error.message : String(error)}`,
    );
    return { kind: 'invalid', name };
  }
  const whenToUse = frontmatter['whenToUse'];
  return {
    kind: 'skill',
    entry: {
      name,
      description: description.slice(0, MAX_SKILL_DESCRIPTION_LENGTH),
      ...(typeof whenToUse === 'string' && whenToUse.length > 0 && { whenToUse }),
      path: skillMdPath,
      invocation,
      body: content.slice(match[0].length).trim(),
    },
  };
}

/** 同基座 `listSkillsFromBackend` 的路徑正規化（`:4403-4404`）。 */
function normalizeSource(sourcePath: string): { readonly dir: string; readonly sep: string } {
  const sep = sourcePath.includes('\\') ? '\\' : '/';
  const dir =
    sourcePath.endsWith('/') || sourcePath.endsWith('\\') ? sourcePath : `${sourcePath}${sep}`;
  return { dir, sep };
}

/** 同基座 `:4414`：`ls` 一列的最後一段。 */
function entryName(path: string): string {
  return (
    path
      .replace(/[/\\]$/, '')
      .split(/[/\\]/)
      .pop() || ''
  );
}

/** 同基座 `:4417`：列表裡有 `SKILL.md` 這個檔，來源就是單一技能。`is_dir` 沒給的算檔案。 */
function isSingleSkill(files: NonNullable<LsResult['files']>): boolean {
  return files.some((info) => !info.is_dir && entryName(info.path) === 'SKILL.md');
}

/** 掃一個來源。`ls` 失敗回空，同基座（`:4405-4412`）。 */
async function scanSource(
  backend: BackendProtocolV2,
  sourcePath: string,
): Promise<ScannedSkillFile[]> {
  const { dir, sep } = normalizeSource(sourcePath);
  let files: NonNullable<LsResult['files']>;
  try {
    const listed = await backend.ls(dir);
    if (listed.error || !listed.files) return [];
    files = listed.files;
  } catch {
    return [];
  }
  if (isSingleSkill(files)) {
    const skillMdPath = `${dir}SKILL.md`;
    return [{ skillMdPath, outcome: await readSkillOutcome(backend, skillMdPath) }];
  }
  const scanned: ScannedSkillFile[] = [];
  for (const info of files) {
    if (!info.is_dir) continue;
    const skillMdPath = `${dir}${entryName(info.path)}${sep}SKILL.md`;
    scanned.push({ skillMdPath, outcome: await readSkillOutcome(backend, skillMdPath) });
  }
  return scanned;
}

async function scanAll(
  backend: BackendProtocolV2,
  sources: readonly string[],
): Promise<ScannedSkillFile[]> {
  const scanned: ScannedSkillFile[] = [];
  for (const source of sources) scanned.push(...(await scanSource(backend, source)));
  return scanned;
}

/** 同名後者贏（基座 `allSkills.set` 的順序；dsh 的 rank 在 nexus 就是來源順序）。不合規的不參與。 */
function winners(scanned: readonly ScannedSkillFile[]): Map<string, SkillCatalogEntry> {
  const byName = new Map<string, SkillCatalogEntry>();
  for (const { outcome } of scanned) {
    if (outcome.kind === 'skill') byName.set(outcome.entry.name, outcome.entry);
  }
  return byName;
}

/**
 * 掃這組來源裡的技能，同名後者贏，旗標不合規的整份不收。
 *
 * @param backend - 這條 thread 的檔案 backend（實例，不收工廠）。
 * @param sources - 技能來源路徑，順序就是優先序（後者贏）。
 * @returns 每個名字一份，照第一次出現的順序。
 */
export async function scanSkills(
  backend: AnyBackendProtocol,
  sources: readonly string[],
): Promise<SkillCatalogEntry[]> {
  return [...winners(await scanAll(adaptBackendProtocol(backend), sources)).values()];
}

/**
 * 讓基座的 skills 中介層看不到模型不該看的技能：包住 `ls`，把那幾個技能目錄從列表裡拿掉。
 *
 * 拿掉的是：
 * - **同名勝出的那一份是 `disable-model-invocation: true`** 的名字，所有來源裡同名的目錄一起拿掉。只拿勝出那一份的話，
 *   順位較低的同名技能會露出來；dsh 是先決勝、再過濾，模型那一側整個名字都看不到；
 * - **旗標不合規**的目錄（fail-closed）。它在 dsh 不成為候選，所以同名、順位較低的合規技能照常列；
 * - **這一側讀失敗**的目錄（fail-closed）。照常情況基座也讀不到、本來就不列，位元組不受影響。
 *
 * 沒有旗標的技能不動，基座的解析與格式化一行都不碰，prompt 位元組跟沒包時一樣。
 *
 * 判斷在第一次 `ls` 時掃完全部來源（同名決勝要看全部），之後同一個解開的 backend 共用那一份結果。
 *
 * @param backend - 交給基座的那一個；是工廠就先用基座的 `resolveBackend` 解開再包。
 * @param sources - 同交給基座的 `sources`。
 * @returns 跟 `backend` 同一種（實例或工廠）的 backend。
 */
export function modelVisibleSkillsBackend(
  backend: AnyBackendProtocol | BackendFactory,
  sources: readonly string[],
): AnyBackendProtocol | BackendFactory {
  if (typeof backend === 'function') {
    return async (runtime: BackendRuntime) =>
      withVisibleLs(await resolveBackend(backend, runtime), sources);
  }
  return withVisibleLs(adaptBackendProtocol(backend), sources);
}

function withVisibleLs(inner: BackendProtocolV2, sources: readonly string[]): BackendProtocolV2 {
  let hidden: Promise<ReadonlySet<string>> | undefined;
  const hiddenPaths = (): Promise<ReadonlySet<string>> => {
    hidden ??= scanAll(inner, sources).then((scanned) => {
      const won = winners(scanned);
      const paths = new Set<string>();
      for (const { skillMdPath, outcome } of scanned) {
        if (outcome.kind === 'invalid' || outcome.kind === 'unreadable') paths.add(skillMdPath);
        if (
          outcome.kind === 'skill' &&
          won.get(outcome.entry.name)?.invocation.modelInvocable === false
        ) {
          paths.add(skillMdPath);
        }
      }
      return paths;
    });
    return hidden;
  };
  return {
    ...inner,
    async ls(path: string): Promise<LsResult> {
      const listed = await inner.ls(path);
      if (listed.error || !listed.files) return listed;
      const paths = await hiddenPaths();
      const { dir, sep } = normalizeSource(path);
      if (isSingleSkill(listed.files)) {
        return paths.has(`${dir}SKILL.md`) ? { ...listed, files: [] } : listed;
      }
      return {
        ...listed,
        files: listed.files.filter(
          (info) => !info.is_dir || !paths.has(`${dir}${entryName(info.path)}${sep}SKILL.md`),
        ),
      };
    },
  };
}
