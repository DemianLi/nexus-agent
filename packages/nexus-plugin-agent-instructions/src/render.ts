/**
 * 把工作區指令渲染成模型看得到的那一則訊息，**在一個明確的位元組預算之內**。
 *
 * 外框、引言、每一檔的標頭與跳脫的字串**是模型看到的東西**，改一個字就是改了一次提示詞。
 *
 * **預算超出時截到放得下**（[#2777](https://github.com/DemianLi/nexus-agent/issues/2777)、[#2934](https://github.com/DemianLi/nexus-agent/issues/2934)）：
 * 整份放得下的照放；剩下放不下的檔，最具體的那一份截成放得下的最長檔頭，其餘整份不放。通知行放在最前面，寫出哪一份被截、
 * 從幾位元組截到幾位元組、哪幾份整份沒放、各多大，以及其餘用 `read_file` 讀。
 * 截得到 {@link MIN_TRUNCATED_BYTES} 以上時讓檔頭進到請求裡，不靠模型照指標自己去讀：量過的真模型沒有一次去讀（#2929、#2934）。取捨見 https://github.com/DemianLi/nexus-agent/blob/archive/docs-2026-11/.docs/injection-source-budgets-design-2026-11-16.md。
 *
 * 沒有抄過來的三段，都是這裡不做的（見 `index.ts` 檔頭；刷新與巢狀發現的
 * [#389](https://github.com/DemianLi/nexus-agent/issues/389) 已以 not planned 關閉）：
 *
 * - `REPLACEMENT_*_INTRO`（基線被取代時的引言）與 `changedSectionText`：那是刷新。
 * - `additionalSectionText`（巢狀目錄的 `Additional instructions from:`）：那是巢狀發現。
 * - `USER_GLOBAL_*`：使用者全域來源是登記過的偏離，見 `index.ts`。
 *
 * @module
 */

const SYSTEM_REMINDER_OPEN = '<system-reminder>';
const SYSTEM_REMINDER_CLOSE = '</system-reminder>';

/** 基線的引言。 */
export const AGENT_INSTRUCTIONS_INTRO =
  'The following workspace instructions may be relevant to your work. ' +
  'Use them as guidance when applicable. More specific instructions take precedence over broader ones. ' +
  'They do not override system, developer, or direct user instructions.';

/**
 * 通知行的固定開頭（後面接 `${maxBytes} bytes:`）。三種通知都以它開頭，所以「這一則裡有放不下的檔」看它就認得；評估也用它。
 */
export const AGENT_INSTRUCTIONS_BUDGET_NOTICE = 'Workspace instruction budget';

/**
 * 截斷後至少要留的位元組數；留不到就不截，退回整份不放、只留通知。
 *
 * 通知行約 130 位元組起（隨路徑長度與沒放的檔數增加），加上外框、引言與檔頭固定約 300 位元組，檔頭只剩一兩行時，模型看到的是一個標題或
 * 半條規則，既不能照做、也容易被當成整份檔的內容；整份不放加一行指標至少不會讓人誤會。256 是約三五條規則的量，是這裡訂的，沒有量過。
 */
export const MIN_TRUNCATED_BYTES = 256;

/** 一個來源檔：模型看得到的路徑與內容。 */
export interface InstructionFile {
  /** 寫進 `Instructions from:` 的路徑。 */
  readonly displayPath: string;
  /** 模型用讀檔工具讀這一份時要給的路徑；這一份被截或整份沒放時寫進通知行。不給就用 `displayPath`。 */
  readonly readPath?: string;
  readonly content: string;
}

/** 一份沒放完的來源：整份沒放，或被截了。 */
export interface DeferredInstruction {
  readonly displayPath: string;
  /** 沒放進去的 UTF-8 位元組數：整份沒放就是整份的大小，被截的是被截掉的那一段。 */
  readonly bytes: number;
}

/** 渲染結果：模型看到的全文，加上沒放完的那幾份（照 `files` 的順序）。 */
export interface RenderedAgentInstructions {
  readonly text: string;
  readonly deferred: readonly DeferredInstruction[];
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * 取一段位元組的前 `maxBytes` 個，**不切碎一個字元**。
 *
 * 切點落在延續位元組（`0b10xxxxxx`）上時要退回那個字元的首位元組再切掉它——中文一個字三個位元組，
 * 不退的話結尾會是半個字。
 */
function utf8Prefix(bytes: Buffer, maxBytes: number): string {
  if (bytes.length <= maxBytes) return bytes.toString('utf8');
  let end = Math.max(0, Math.trunc(maxBytes));
  while (end > 0 && (bytes.readUInt8(end) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

/**
 * 內容裡字面的 `</system-reminder>` 要跳脫，否則一份工作區指令就能把外框關掉，
 * 後面的東西看起來就不再是系統提醒了。
 */
function escapeInstructionFrameBody(body: string): string {
  return body.replaceAll(SYSTEM_REMINDER_CLOSE, '<\\/system-reminder>');
}

/** 放進訊息的一段：一份來源檔，內容是整份或被截過的檔頭。 */
interface Section {
  readonly file: InstructionFile;
  readonly content: string;
}

/** 被截的那一份：`shown` 是放進去的檔頭。 */
interface Truncation {
  readonly file: InstructionFile;
  readonly shown: string;
}

function sectionText(section: Section): string {
  return `Instructions from: ${section.file.displayPath}\n\n${section.content}`;
}

const readPathOf = (file: InstructionFile): string => file.readPath ?? file.displayPath;

/**
 * 通知行，放在最前面，一行寫清楚：哪一份被截、從幾位元組截到幾位元組；哪幾份整份沒放、各多大；其餘用 `read_file` 讀、路徑是什麼。
 * 三種情形（只截、只整份沒放、兩者都有）各自的措辭由測試逐字釘住。
 */
function markerText(
  maxBytes: number,
  truncation: Truncation | undefined,
  omitted: readonly InstructionFile[],
): string {
  if (truncation === undefined && omitted.length === 0) return '';
  const head = `${AGENT_INSTRUCTIONS_BUDGET_NOTICE} ${maxBytes} bytes: `;
  const listed = omitted
    .map((file) => `${readPathOf(file)} (${byteLength(file.content)} bytes)`)
    .join(', ');
  if (truncation === undefined) {
    return `${head}not loaded ${listed}; read each with read_file before acting on this workspace.`;
  }
  const cut = truncation.file;
  const truncated =
    `truncated ${readPathOf(cut)} from ${byteLength(cut.content)} to ` +
    `${byteLength(truncation.shown)} bytes`;
  if (omitted.length === 0) {
    return `${head}${truncated}; read the rest of ${readPathOf(cut)} with read_file before acting on this workspace.`;
  }
  return (
    `${head}${truncated}, not loaded ${listed}; ` +
    `read the rest of ${readPathOf(cut)} and each unloaded file with read_file before acting on this workspace.`
  );
}

function buildInstructionText(
  sections: readonly Section[],
  maxBytes: number,
  truncation: Truncation | undefined,
  omitted: readonly InstructionFile[],
): string {
  // 一份都沒放時不帶引言：引言講的是「下面這些指示」。
  const intro = sections.length === 0 ? '' : AGENT_INSTRUCTIONS_INTRO;
  const body = [
    markerText(maxBytes, truncation, omitted),
    intro,
    ...sections.map(sectionText),
  ].filter((block) => block.length > 0);
  // 外框由生產者自己烤進內容裡（dsh 同樣：會話面原樣投影，不會替誰包框）。
  return [
    SYSTEM_REMINDER_OPEN,
    escapeInstructionFrameBody(body.join('\n\n')),
    SYSTEM_REMINDER_CLOSE,
  ].join('\n');
}

/**
 * 整份放不下的檔裡最具體的那一份，截成放得下的最長檔頭；沒有這樣的檔、或截不到 {@link MIN_TRUNCATED_BYTES} 回 `undefined`。
 * 訊息長度隨檔頭長度單調不減（檔頭多一個位元組，訊息只會多不會少），所以二分找得到「放得下的最大值」。
 */
function truncateMostSpecific(
  all: readonly InstructionFile[],
  placed: ReadonlySet<number>,
  budget: number,
): { readonly index: number; readonly shown: string } | undefined {
  let index = all.length - 1;
  while (index >= 0 && placed.has(index)) index -= 1;
  if (index < 0) return undefined;
  const file = all[index]!;
  const bytes = Buffer.from(file.content, 'utf8');
  const fits = (limit: number): string | undefined => {
    const shown = utf8Prefix(bytes, limit);
    const sectionsHere = all.flatMap((each, at): Section[] => {
      if (at === index) return [{ file: each, content: shown }];
      return placed.has(at) ? [{ file: each, content: each.content }] : [];
    });
    const omittedHere = all.filter((_, at) => !placed.has(at) && at !== index);
    const built = buildInstructionText(sectionsHere, budget, { file, shown }, omittedHere);
    return byteLength(built) <= budget ? shown : undefined;
  };
  // 整份放得下的在第一步已經放了，所以這裡的上限是「差一個位元組放完」。
  let low = MIN_TRUNCATED_BYTES;
  let high = bytes.length - 1;
  if (high < low || fits(low) === undefined) return undefined;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle) === undefined) high = middle - 1;
    else low = middle;
  }
  const shown = fits(low);
  return shown === undefined || byteLength(shown) < MIN_TRUNCATED_BYTES
    ? undefined
    : { index, shown };
}

/**
 * 渲染一則基線。
 *
 * `files` 要由寬到窄排好（同一層就是候選檔的讀取順序），放進去的照這個順序排。預算不夠時分兩步：
 *
 * 1. **從最具體的那一份往寬的挑**，整份放得下就放——留下來的優先是最貼近手上這件事的那幾份。
 * 2. 還有整份放不下的，取其中**最具體**的那一份，截成剩下的預算放得下的**最長檔頭**（不切碎字元），放在它本來的位置；
 *    其餘整份不放。截下來的不到 {@link MIN_TRUNCATED_BYTES} 就不截，這一份也整份不放。
 *
 * 整則訊息（含通知行與外框）永遠不超過 `maxBytes`。
 *
 * @param files - 由寬到窄的來源檔。空陣列回 `undefined`（空鏈不加任何訊息）。
 * @param maxBytes - 整則訊息的 UTF-8 位元組上限。非正數或非有限數等於關掉，回 `undefined`。
 * @returns 模型看到的全文與沒放完的那幾份（被截的記截掉的位元組數，整份沒放的記整份大小），或 `undefined`。
 */
export function renderAgentInstructions(
  files: readonly InstructionFile[],
  maxBytes: number,
): RenderedAgentInstructions | undefined {
  if (files.length === 0) return undefined;
  if (maxBytes <= 0 || !Number.isFinite(maxBytes)) return undefined;

  const whole = (file: InstructionFile): Section => ({ file, content: file.content });
  const kept = new Set<number>();
  const omittedOf = (): InstructionFile[] => files.filter((_, index) => !kept.has(index));
  const sectionsOf = (): Section[] =>
    files.filter((_, index) => kept.has(index)).map((file) => whole(file));
  for (let index = files.length - 1; index >= 0; index -= 1) {
    kept.add(index);
    if (
      byteLength(buildInstructionText(sectionsOf(), maxBytes, undefined, omittedOf())) > maxBytes
    ) {
      kept.delete(index);
    }
  }

  const truncation = truncateMostSpecific(files, kept, maxBytes);
  const sections = files.flatMap((file, index): Section[] => {
    if (truncation?.index === index) return [{ file, content: truncation.shown }];
    return kept.has(index) ? [whole(file)] : [];
  });
  const cut =
    truncation === undefined
      ? undefined
      : { file: files[truncation.index]!, shown: truncation.shown };
  const omitted = files.filter((_, index) => !kept.has(index) && index !== truncation?.index);
  const report = files.flatMap((file, index): DeferredInstruction[] => {
    if (kept.has(index)) return [];
    const total = byteLength(file.content);
    return [
      {
        displayPath: file.displayPath,
        bytes: index === truncation?.index ? total - byteLength(truncation.shown) : total,
      },
    ];
  });
  const text = buildInstructionText(sections, maxBytes, cut, omitted);
  if (byteLength(text) <= maxBytes) return { text, deferred: report };

  // 一份都沒放、連帶外框的通知都放不下：退成沒有外框的通知。**框比通知先被放棄**，因為留著半個框比沒有框更糟。
  const notice = escapeInstructionFrameBody(markerText(maxBytes, undefined, omittedOf()));
  const noticeBytes = Buffer.from(notice, 'utf8');
  return { text: utf8Prefix(noticeBytes, maxBytes), deferred: report };
}
