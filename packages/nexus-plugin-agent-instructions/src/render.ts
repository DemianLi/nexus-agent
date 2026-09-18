/**
 * 把工作區指令渲染成模型看得到的那一則訊息，**在一個明確的位元組預算之內**。
 *
 * 整份照抄 dsh `packages/context/agent-instructions/src/render.ts`（`ddefc45`）：外框、引言、
 * 每一檔的標頭、跳脫、預算超出時的通知文字、省略與截斷的順序，逐字同一份。抄的理由是這些字串與
 * 順序**是模型看到的東西**——改一個字就是改了一次提示詞，而那不該在移植的時候順便發生。
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

/** 基線的引言。dsh `render.ts:12-14` 逐字。 */
export const AGENT_INSTRUCTIONS_INTRO =
  'The following workspace instructions may be relevant to your work. ' +
  'Use them as guidance when applicable. More specific instructions take precedence over broader ones. ' +
  'They do not override system, developer, or direct user instructions.';

/** 預算逼得連引言都放不下時換上的短引言。dsh `render.ts:19` 逐字。 */
export const COMPACT_AGENT_INSTRUCTIONS_INTRO =
  'Workspace instructions were omitted or truncated to fit the configured byte budget.';

/** 一個來源檔：模型看得到的路徑與內容。 */
export interface InstructionFile {
  /** 寫進 `Instructions from:` 的路徑。 */
  readonly displayPath: string;
  readonly content: string;
}

/** 一筆被截斷的來源的位元組帳。 */
export interface TruncatedInstruction {
  readonly displayPath: string;
  readonly originalBytes: number;
  readonly includedBytes: number;
}

/** 渲染結果：模型看到的全文，加上被省略與被截斷的帳。 */
export interface RenderedAgentInstructions {
  readonly text: string;
  readonly omitted: readonly string[];
  readonly truncated: readonly TruncatedInstruction[];
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * 截到 `maxBytes` 個 UTF-8 位元組，**不切碎一個字元**。
 *
 * 切點落在延續位元組（`0b10xxxxxx`）上時要退回那個字元的首位元組再切掉它——中文一個字三個位元組，
 * 不退的話結尾會是半個字。dsh `render.ts:69-79` 同一份寫法。
 */
function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  let end = Math.max(0, Math.trunc(maxBytes));
  while (end > 0 && (bytes.readUInt8(end) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

/**
 * 內容裡字面的 `</system-reminder>` 要跳脫，否則一份工作區指令就能把外框關掉，
 * 後面的東西看起來就不再是系統提醒了。dsh `render.ts:81-83` 同一個替換字串。
 */
function escapeInstructionFrameBody(body: string): string {
  return body.replaceAll(SYSTEM_REMINDER_CLOSE, '<\\/system-reminder>');
}

function sectionText(file: InstructionFile): string {
  return `Instructions from: ${file.displayPath}\n\n${file.content}`;
}

/** 預算通知。dsh `render.ts:215-224` 逐字。 */
function markerText(
  maxBytes: number,
  omitted: readonly InstructionFile[],
  truncated: readonly TruncatedInstruction[],
): string {
  if (omitted.length === 0 && truncated.length === 0) return '';
  const parts: string[] = [];
  if (omitted.length > 0) {
    parts.push(`omitted ${omitted.map((file) => file.displayPath).join(', ')}`);
  }
  if (truncated.length > 0) {
    parts.push(
      `truncated ${truncated
        .map(
          (item) => `${item.displayPath} from ${item.originalBytes} to ${item.includedBytes} bytes`,
        )
        .join(', ')}`,
    );
  }
  return `Workspace instruction budget ${maxBytes} bytes: ${parts.join('; ')}`;
}

function buildInstructionText(
  files: readonly InstructionFile[],
  maxBytes: number,
  omitted: readonly InstructionFile[],
  truncated: readonly TruncatedInstruction[],
  intro: string,
): string {
  const marker = markerText(maxBytes, omitted, truncated);
  const body = [marker, intro, ...files.map(sectionText)].filter((block) => block.length > 0);
  // 外框由生產者自己烤進內容裡（dsh 同樣：會話面原樣投影，不會替誰包框）。
  return [
    SYSTEM_REMINDER_OPEN,
    escapeInstructionFrameBody(body.join('\n\n')),
    SYSTEM_REMINDER_CLOSE,
  ].join('\n');
}

function withTruncatedContent(file: InstructionFile, includedBytes: number): InstructionFile {
  return { ...file, content: truncateUtf8(file.content, includedBytes) };
}

/**
 * 二分搜出「塞得進預算」的最大截斷長度。
 *
 * 量的是**整則訊息**而不是這一檔的內容：通知文字自己也吃位元組，而它的長度隨截到幾個位元組而變。
 * dsh `render.ts:249-272` 同一個迴圈。
 */
function truncateToFit(
  file: InstructionFile,
  maxBytes: number,
  omitted: readonly InstructionFile[],
  intro: string,
): InstructionFile {
  const originalBytes = byteLength(file.content);
  let low = 0;
  let high = originalBytes;
  let best = withTruncatedContent(file, 0);
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = withTruncatedContent(file, mid);
    const truncated = [
      {
        displayPath: file.displayPath,
        originalBytes,
        includedBytes: byteLength(candidate.content),
      },
    ];
    const text = buildInstructionText([candidate], maxBytes, omitted, truncated, intro);
    if (byteLength(text) <= maxBytes) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/**
 * 渲染一則基線。
 *
 * **順序是承重的**：`files` 要由寬到窄排好（同一層就是候選檔的讀取順序）。預算不夠時**寬的先
 * 整份省略、最具體的最後才截斷**——留下來的要是最貼近手上這件事的那一份。
 *
 * @param files - 由寬到窄的來源檔。空陣列回 `undefined`（空鏈不加任何訊息）。
 * @param maxBytes - 整則訊息的 UTF-8 位元組上限。非正數或非有限數等於關掉，回 `undefined`。
 * @returns 模型看到的全文與位元組帳，或 `undefined`。
 */
export function renderAgentInstructions(
  files: readonly InstructionFile[],
  maxBytes: number,
): RenderedAgentInstructions | undefined {
  if (files.length === 0) return undefined;
  if (maxBytes <= 0 || !Number.isFinite(maxBytes)) return undefined;

  const intro = AGENT_INSTRUCTIONS_INTRO;
  const fullText = buildInstructionText(files, maxBytes, [], [], intro);
  if (byteLength(fullText) <= maxBytes) return { text: fullText, omitted: [], truncated: [] };

  for (let start = 1; start < files.length; start += 1) {
    const included = files.slice(start);
    const omitted = files.slice(0, start);
    const suffixText = buildInstructionText(included, maxBytes, omitted, [], intro);
    if (byteLength(suffixText) <= maxBytes) {
      return { text: suffixText, omitted: omitted.map((file) => file.displayPath), truncated: [] };
    }
  }

  const mostSpecific = files[files.length - 1];
  if (mostSpecific === undefined) return undefined;
  const omitted = files.slice(0, -1);
  const omittedPaths = omitted.map((file) => file.displayPath);
  const originalBytes = byteLength(mostSpecific.content);

  for (const candidateIntro of [intro, COMPACT_AGENT_INSTRUCTIONS_INTRO]) {
    const truncatedFile = truncateToFit(mostSpecific, maxBytes, omitted, candidateIntro);
    const includedBytes = byteLength(truncatedFile.content);
    const truncated = [{ displayPath: mostSpecific.displayPath, originalBytes, includedBytes }];
    const text = buildInstructionText(
      [truncatedFile],
      maxBytes,
      omitted,
      truncated,
      candidateIntro,
    );
    if (byteLength(text) <= maxBytes) {
      return { text, omitted: omittedPaths, truncated };
    }
  }

  // 連短引言都塞不下：退成一則沒有外框的通知。**框比通知先被放棄**，因為留著半個框比沒有框更糟。
  const truncated = [{ displayPath: mostSpecific.displayPath, originalBytes, includedBytes: 0 }];
  const notice = escapeInstructionFrameBody(markerText(maxBytes, omitted, truncated));
  const withHeading = escapeInstructionFrameBody(
    [notice, sectionText(withTruncatedContent(mostSpecific, 0))].join('\n\n'),
  );
  if (byteLength(withHeading) <= maxBytes) {
    return { text: withHeading, omitted: omittedPaths, truncated };
  }
  return {
    text: byteLength(notice) <= maxBytes ? notice : truncateUtf8(notice, maxBytes),
    omitted: omittedPaths,
    truncated,
  };
}
