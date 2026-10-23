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
 * `tool-skill` 再只把 `isModelInvocable` 的列給模型；讀檔或列目錄遇到「不存在」以外的錯誤，快照不完整，`tool-skill` 整份目錄不發
 * （`skill-filesystem/src/index.ts:864-865`、`:893-896`，`tool-skill/src/index.ts:227`）。
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
  FileDownloadResponse,
  LsResult,
  ReadResult,
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
 * - `ignored`：不存在、太大、沒有 frontmatter、YAML 壞了、缺 `name`／`description`。基座自己也跳過（並自己 warn），這裡不表態；
 * - `unreadable`：「不存在」以外的讀檔錯誤（權限、路徑不合法、backend 拋例外……）。不知道那份叫什麼名字，同名決勝做不了，
 *   所以這一次掃描算**不完整**（同 dsh `skill-filesystem/src/index.ts:864-865`、`:893-896` 拋錯）。
 */
type SkillFileOutcome =
  | { readonly kind: 'skill'; readonly entry: SkillCatalogEntry }
  | { readonly kind: 'invalid'; readonly name: string }
  | { readonly kind: 'ignored' }
  | { readonly kind: 'unreadable'; readonly reason: string };

/** 掃到的一個 `SKILL.md`：路徑的拼法同基座，視圖靠它對回 `ls` 的那一列。 */
interface ScannedSkillFile {
  readonly skillMdPath: string;
  readonly outcome: SkillFileOutcome;
}

/**
 * 一次掃描看到的原樣：每個來源 `ls` 回的那一份、每個 `SKILL.md` 讀回的那一份。視圖拿它回應基座，基座看到的就是掃描當時那一份，
 * 兩次讀之間的檔案變動與暫時性錯誤都碰不到。
 */
interface ScanSnapshot {
  readonly listings: Map<string, LsResult>;
  readonly downloads: Map<string, FileDownloadResponse>;
  readonly reads: Map<string, ReadResult>;
  readonly scanned: ScannedSkillFile[];
  /** 第一個讓掃描不完整的原因；`undefined` 就是完整。 */
  incomplete?: string;
}

function emptySnapshot(): ScanSnapshot {
  return { listings: new Map(), downloads: new Map(), reads: new Map(), scanned: [] };
}

/** `downloadFiles` 的錯誤碼裡算「不存在」的兩個（dsh `isAbsentSkillPathError` 加 `info.type !== 'file'`，`:720-724`、`:890`）。 */
const ABSENT_DOWNLOAD_ERRORS: ReadonlySet<string> = new Set(['file_not_found', 'is_directory']);

/**
 * `read` 的錯誤只是一段字串。基座 `FilesystemBackend.read` 對不是檔案的回 `File '<路徑>' not found`（`src-C9o7b5C6.js:676`、
 * `:693`），路徑不存在時 `stat` 拋的 `ENOENT`／`ENOTDIR` 包成 `Error reading file '<路徑>': <訊息>`（`:717`）。
 * 認得出這幾種的才算不存在（同 dsh `isAbsentSkillPathError`，`:720-724`），其餘照不完整處理。
 */
const ABSENT_READ_ERROR = /not found|ENOENT|ENOTDIR/i;

/**
 * 讀一個 `SKILL.md`，讀法同基座 `readFileFromBackend`（`:4374-4386`）：有 `downloadFiles` 先用它。原樣記進快照，視圖之後回給基座的
 * 就是這一份。
 */
async function readSkillFile(
  backend: BackendProtocolV2,
  path: string,
  snapshot: ScanSnapshot,
): Promise<{ readonly text: string } | { readonly absent: true } | { readonly error: string }> {
  if (backend.downloadFiles) {
    const results = await backend.downloadFiles([path]);
    if (results.length !== 1) return { error: `downloadFiles 回了 ${results.length} 筆` };
    const response = results[0]!;
    snapshot.downloads.set(path, response);
    if (response.error != null) {
      return ABSENT_DOWNLOAD_ERRORS.has(response.error)
        ? { absent: true }
        : { error: response.error };
    }
    if (response.content == null) return { absent: true };
    return { text: new TextDecoder().decode(response.content) };
  }
  const result = await backend.read(path);
  snapshot.reads.set(path, result);
  if (result.error)
    return ABSENT_READ_ERROR.test(result.error) ? { absent: true } : { error: result.error };
  if (typeof result.content !== 'string') return { absent: true };
  return { text: result.content };
}

async function readSkillOutcome(
  backend: BackendProtocolV2,
  skillMdPath: string,
  snapshot: ScanSnapshot,
): Promise<SkillFileOutcome> {
  let read: Awaited<ReturnType<typeof readSkillFile>>;
  try {
    read = await readSkillFile(backend, skillMdPath, snapshot);
  } catch (error) {
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }
  if ('error' in read) return { kind: 'unreadable', reason: read.error };
  if ('absent' in read) return { kind: 'ignored' };
  const content = read.text;
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

/**
 * 掃一個來源。`ls` 回 `error` 或拋例外，這一次掃描算不完整（dsh 列根目錄遇到「不存在」以外的錯誤會拋，`:766-773`）。
 * `FilesystemBackend.ls` 自己把所有錯誤吞成空列表（`src-C9o7b5C6.js:657-659`），那種失敗這一側看不出來；
 * 基座拿到的是快照裡同一份空列表，所以不會因此漏出該藏的技能。
 */
async function scanSource(
  backend: BackendProtocolV2,
  sourcePath: string,
  snapshot: ScanSnapshot,
): Promise<void> {
  const { dir, sep } = normalizeSource(sourcePath);
  let listed: LsResult;
  try {
    listed = await backend.ls(dir);
  } catch (error) {
    snapshot.incomplete ??= `${dir} 列不出來：${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  snapshot.listings.set(dir, listed);
  if (listed.error) {
    snapshot.incomplete ??= `${dir} 列不出來：${listed.error}`;
    return;
  }
  const files = listed.files ?? [];
  const skillMdPaths = isSingleSkill(files)
    ? [`${dir}SKILL.md`]
    : files
        .filter((info) => info.is_dir)
        .map((info) => `${dir}${entryName(info.path)}${sep}SKILL.md`);
  for (const skillMdPath of skillMdPaths) {
    const outcome = await readSkillOutcome(backend, skillMdPath, snapshot);
    if (outcome.kind === 'unreadable') {
      snapshot.incomplete ??= `${skillMdPath} 讀不到：${outcome.reason}`;
    }
    snapshot.scanned.push({ skillMdPath, outcome });
  }
}

async function scanAll(
  backend: BackendProtocolV2,
  sources: readonly string[],
): Promise<ScanSnapshot> {
  const snapshot = emptySnapshot();
  for (const source of sources) await scanSource(backend, source, snapshot);
  return snapshot;
}

/** 同名後者贏（基座 `allSkills.set` 的順序；dsh 的 rank 在 nexus 就是來源順序）。不合規的不參與。 */
function winners(scanned: readonly ScannedSkillFile[]): Map<string, SkillCatalogEntry> {
  const byName = new Map<string, SkillCatalogEntry>();
  for (const { outcome } of scanned) {
    if (outcome.kind === 'skill') byName.set(outcome.entry.name, outcome.entry);
  }
  return byName;
}

/** 一次掃描的結果，形狀照 dsh 的 `SkillCatalogSnapshot`（`skill/src/index.ts:230-236`）。 */
export interface SkillCatalogScan {
  /** 每個名字一份（同名後者贏），照第一次出現的順序。讀不到的那幾份不在這裡。 */
  readonly skills: readonly SkillCatalogEntry[];
  /**
   * 這次掃描完不完整：`ls` 或讀 `SKILL.md` 遇到「不存在」以外的錯誤就是 `false`。這時 `skills` 可能少了讀不到的那份，
   * 順位較低的同名技能會頂上來，所以消費端要自己決定能不能用。
   */
  readonly complete: boolean;
}

/**
 * 掃這組來源裡的技能，同名後者贏，旗標不合規的整份不收。
 *
 * @param backend - 這條 thread 的檔案 backend（實例，不收工廠）。
 * @param sources - 技能來源路徑，順序就是優先序（後者贏）。
 * @returns 掃到的技能與這次掃描完不完整，見 {@link SkillCatalogScan}。
 */
export async function scanSkills(
  backend: AnyBackendProtocol,
  sources: readonly string[],
): Promise<SkillCatalogScan> {
  const snapshot = await scanAll(adaptBackendProtocol(backend), sources);
  return {
    skills: [...winners(snapshot.scanned).values()],
    complete: snapshot.incomplete === undefined,
  };
}

/**
 * 把一份技能渲染成交給模型照做的那一段，逐字照 dsh `renderSkillContent`（`skill/src/index.ts:170-214`，`687f282e`）：
 * `<skill_content>` 裡先放資源的位置、再放正文。nexus 的技能都在 backend 的目錄裡，所以資源一律是 dsh 的 `directory` 那一種，
 * 基底是 `SKILL.md` 所在的目錄（dsh 的 `resourceBase: { kind: 'directory', path: locator.directory }`，
 * `skill-filesystem/src/index.ts:220`）。
 *
 * @param skill - 掃到的那一份。
 * @returns 給模型看的整段 `<skill_content>`。
 */
export function renderSkillInvocation(
  skill: Pick<SkillCatalogEntry, 'name' | 'path' | 'body'>,
): string {
  const directory = skill.path.replace(/[/\\]SKILL\.md$/, '');
  return [
    `<skill_content name="${escapeAttr(skill.name)}">`,
    '<skill_resources>',
    `Base directory for this skill: ${escapeText(directory)}`,
    'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
    '</skill_resources>',
    '',
    '<skill_instructions>',
    skill.body,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n');
}

/** 同 dsh `escapeAttr`（`skill/src/index.ts:216-218`）。 */
function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

/** 同 dsh `escapeText`（`skill/src/index.ts:226-228`）。 */
function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * 讓基座的 skills 中介層看不到模型不該看的技能。
 *
 * 回傳的一律是工廠：基座每次掃描都在 `beforeAgent` 裡用 `resolveBackend` 解開一次（`langsmith-zm0ILQsV.js:4529`），
 * 所以每次掃描都拿到一份新的視圖。視圖在基座第一次 `ls` 時先自己掃完全部來源（同名決勝要看全部），之後基座的 `ls` 與讀
 * `SKILL.md` 都由這份快照回應，不再碰 inner：
 *
 * - **完整**：拿掉同名勝出的那一份是 `disable-model-invocation: true` 的名字（所有來源裡同名的目錄一起拿掉；dsh 是先決勝、
 *   再過濾），以及旗標不合規的目錄（它在 dsh 不成為候選，所以同名、順位較低的合規技能照常列）；
 * - **不完整**（`ls` 或讀 `SKILL.md` 遇到「不存在」以外的錯誤）：每個來源都回空列表，這一次一份技能都不給模型。讀不到的那份
 *   叫什麼名字不知道，只藏它或它那個來源，順位較低的同名技能就會露出來；dsh 遇到不完整的快照也是整份目錄不發
 *   （`tool-skill/src/index.ts:227`）。記一行 warn，並經 `onScan` 告訴呼叫端，讓它別把這次的空結果當成定案。
 *
 * 沒有旗標的技能不動：快照回的是 inner 原樣的那一份，基座的解析與格式化一行都不碰，prompt 位元組跟沒包時一樣。
 *
 * @param backend - 交給基座的那一個，實例或工廠都可以。
 * @param sources - 同交給基座的 `sources`。
 * @param onScan - 每次掃描完叫一次，`complete` 是這次掃描完不完整。
 * @returns 交給基座的工廠。
 */
export function modelVisibleSkillsBackend(
  backend: AnyBackendProtocol | BackendFactory,
  sources: readonly string[],
  onScan?: (complete: boolean) => void,
): BackendFactory {
  return async (runtime: BackendRuntime) =>
    withSnapshot(await resolveBackend(backend, runtime), sources, onScan);
}

function withSnapshot(
  inner: BackendProtocolV2,
  sources: readonly string[],
  onScan: ((complete: boolean) => void) | undefined,
): BackendProtocolV2 {
  let view:
    Promise<{ readonly snapshot: ScanSnapshot; readonly hidden: ReadonlySet<string> }> | undefined;
  const scanned = () => {
    view ??= scanAll(inner, sources).then((snapshot) => {
      const won = winners(snapshot.scanned);
      const hidden = new Set<string>();
      for (const { skillMdPath, outcome } of snapshot.scanned) {
        if (outcome.kind === 'invalid') hidden.add(skillMdPath);
        if (
          outcome.kind === 'skill' &&
          won.get(outcome.entry.name)?.invocation.modelInvocable === false
        ) {
          hidden.add(skillMdPath);
        }
      }
      if (snapshot.incomplete !== undefined) {
        console.warn(`技能清單這一次不給模型：掃描不完整：${snapshot.incomplete}`);
      }
      onScan?.(snapshot.incomplete === undefined);
      return { snapshot, hidden };
    });
    return view;
  };
  const sourceDirs = new Set(sources.map((source) => normalizeSource(source).dir));
  const adapted: BackendProtocolV2 = {
    ...inner,
    async ls(path: string): Promise<LsResult> {
      if (!sourceDirs.has(path)) return inner.ls(path);
      const { snapshot, hidden } = await scanned();
      if (snapshot.incomplete !== undefined) return { files: [] };
      const listed = snapshot.listings.get(path)!;
      if (listed.error || !listed.files) return listed;
      const { dir, sep } = normalizeSource(path);
      if (isSingleSkill(listed.files)) {
        return hidden.has(`${dir}SKILL.md`) ? { ...listed, files: [] } : listed;
      }
      return {
        ...listed,
        files: listed.files.filter(
          (info) => !info.is_dir || !hidden.has(`${dir}${entryName(info.path)}${sep}SKILL.md`),
        ),
      };
    },
  };
  // 方法形狀跟 inner 一樣：inner 有 `downloadFiles` 才覆寫它，沒有才覆寫 `read`，基座的讀法不會因為包了一層而換路。
  if (inner.downloadFiles) {
    const download = inner.downloadFiles.bind(inner);
    adapted.downloadFiles = async (paths: string[]) => {
      const { snapshot } = await scanned();
      const cached = paths.map((path) => snapshot.downloads.get(path));
      if (cached.every((response) => response !== undefined))
        return cached as FileDownloadResponse[];
      return download(paths);
    };
  } else {
    const read = inner.read.bind(inner);
    adapted.read = async (path: string, offset?: number, limit?: number) => {
      if (offset === undefined && limit === undefined) {
        const cached = (await scanned()).snapshot.reads.get(path);
        if (cached !== undefined) return cached;
      }
      return read(path, offset, limit);
    };
  }
  return adapted;
}
