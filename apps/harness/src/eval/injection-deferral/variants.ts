/**
 * 注入源延後評估的候選做法（[#2934](https://github.com/DemianLi/nexus-agent/issues/2934)）：指示檔放不進預算時，怎麼讓模型照做。
 *
 * 每一種做法只換「怎麼呈現沒放進去的那一份」，其餘（讀檔、預算、注入的位置、日誌）與出貨共用同一份 listener；
 * 出貨的 `agent-instructions` 那一列在評估組裝裡被原位換成帶候選渲染的相容層插件，id 不變。這個檔不進產品路徑。
 *
 * 模型看得到的字串都是提示詞，寫成常數並由 `variants.test.ts` 釘住；改一個字就是換了一個候選。
 */

import { MIDDLE_SECTION_ORDERS, summaryCutoffsOf } from '@nexus/core';
import type { NexusPlugin, PluginEntry } from '@nexus/core';
import {
  agentInstructionsConfigSchema,
  AGENT_INSTRUCTIONS_INTRO,
  AGENT_INSTRUCTIONS_MIDDLEWARE_NAME,
  createAgentInstructionsListener,
  renderAgentInstructions,
} from '@nexus/plugin-agent-instructions';
import type {
  AgentInstructionsLimits,
  AgentInstructionsRender,
  InstructionFile,
  RenderedAgentInstructions,
} from '@nexus/plugin-agent-instructions';

import { nextContextWindowOf } from '../../model-selection-host.js';
import { createPreStepMiddleware } from '../../pre-step-middleware.js';
import { registryFsLookup } from '../../registry-fs-lookup.js';

export type DeferralVariantId =
  'current' | 'pointer-strong' | 'system-prompt' | 'head-excerpt' | 'truncate';

/** 一次掛載裡的渲染，以及（有的話）要登記進系統提示的那一段。狀態活在這裡，不跨掛載。 */
export interface VariantInstance {
  readonly render: AgentInstructionsRender;
  /** 系統提示的一段，每次模型呼叫現算；回 `''` 是這一次不接。 */
  readonly promptSection?: () => string;
}

export interface DeferralVariant {
  readonly id: DeferralVariantId;
  /** 只要檔沒整份放進請求就一定出現在第一個請求裡、不延後時不會出現的一段字。 */
  readonly marker: string;
  /** 每次掛載建一份，讓逐掛載的狀態不外漏。 */
  create(): VariantInstance;
}

/** `head-excerpt` 留的檔頭位元組數：小檔延後那一格的預算只有 1024，要比它小得多才不會變成整份放進去。 */
export const HEAD_EXCERPT_BYTES = 512;

/** `pointer-strong` 的通知；模型看到的是這一整段。 */
export const POINTER_STRONG_MARKER = 'were NOT loaded because they exceed';
export function pointerStrongText(maxBytes: number, listed: string): string {
  return (
    `IMPORTANT: the workspace instruction files below ${POINTER_STRONG_MARKER} the ${maxBytes}-byte instruction budget: ${listed}. ` +
    'They may contain rules you must follow in every reply. ' +
    'Before answering the user, call read_file on each of them and apply what they say. ' +
    'If a file is longer than one page, keep calling read_file with the offset it gives you until you reach the end of the file.'
  );
}

/** `system-prompt` 的那一段。 */
export const SYSTEM_PROMPT_MARKER = 'Deferred workspace instructions:';
export function systemPromptText(maxBytes: number, listed: string): string {
  return (
    `${SYSTEM_PROMPT_MARKER} ${listed} did not fit the ${maxBytes}-byte instruction budget and are NOT in this conversation. ` +
    'They may contain rules that apply to every reply. ' +
    'Before answering the user, call read_file on each of these files and follow what it says.'
  );
}

/** `head-excerpt` 的通知。 */
export const HEAD_EXCERPT_MARKER = 'is only partly loaded';
export function headExcerptNotice(
  maxBytes: number,
  path: string,
  totalBytes: number,
  shownBytes: number,
): string {
  return (
    `Workspace instruction budget ${maxBytes} bytes: ${path} (${totalBytes} bytes) ${HEAD_EXCERPT_MARKER}. ` +
    `Only its first ${shownBytes} bytes are shown below; the remaining ${totalBytes - shownBytes} bytes were NOT loaded. ` +
    'Read the full file with read_file before acting on this workspace.'
  );
}

/** `truncate` 的通知，同 {@link truncateNotice} 的格式。 */
export const TRUNCATE_MARKER = 'Workspace instruction budget';

const SYSTEM_REMINDER_OPEN = '<system-reminder>';
const SYSTEM_REMINDER_CLOSE = '</system-reminder>';

const byteLength = (value: string): number => Buffer.byteLength(value, 'utf8');

/** 截到 `maxBytes` 個 UTF-8 位元組，不切碎一個字元。 */
function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  let end = Math.max(0, Math.trunc(maxBytes));
  while (end > 0 && (bytes.readUInt8(end) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

const escapeFrameBody = (body: string): string =>
  body.replaceAll(SYSTEM_REMINDER_CLOSE, '<\\/system-reminder>');

const frame = (blocks: readonly string[]): string =>
  [
    SYSTEM_REMINDER_OPEN,
    escapeFrameBody(blocks.filter((block) => block.length > 0).join('\n\n')),
    SYSTEM_REMINDER_CLOSE,
  ].join('\n');

const sectionOf = (file: InstructionFile): string =>
  `Instructions from: ${file.displayPath}\n\n${file.content}`;

const readPathOf = (file: InstructionFile): string => file.readPath ?? file.displayPath;

const listedOf = (files: readonly InstructionFile[]): string =>
  files.map((file) => `${readPathOf(file)} (${byteLength(file.content)} bytes)`).join(', ');

/** 出貨渲染挑出的、整份沒放進去的那幾份。 */
function deferredFiles(
  files: readonly InstructionFile[],
  shipped: RenderedAgentInstructions,
): { readonly kept: InstructionFile[]; readonly deferred: InstructionFile[] } {
  const paths = new Set(shipped.deferred.map((item) => item.displayPath));
  return {
    kept: files.filter((file) => !paths.has(file.displayPath)),
    deferred: files.filter((file) => paths.has(file.displayPath)),
  };
}

const deferredReport = (files: readonly InstructionFile[]) =>
  files.map((file) => ({ displayPath: file.displayPath, bytes: byteLength(file.content) }));

/** 出貨的做法：整份延後，留一行指標。 */
const current: DeferralVariant = {
  id: 'current',
  marker: 'not loaded /AGENTS.md',
  create: () => ({ render: renderAgentInstructions }),
};

/** 指標寫得更強、更具體，並且明寫先讀再回答。 */
const pointerStrong: DeferralVariant = {
  id: 'pointer-strong',
  marker: POINTER_STRONG_MARKER,
  create: () => ({
    render(files, maxBytes) {
      const shipped = renderAgentInstructions(files, maxBytes);
      if (shipped === undefined || shipped.deferred.length === 0) return shipped;
      const { kept, deferred } = deferredFiles(files, shipped);
      const intro = kept.length === 0 ? '' : AGENT_INSTRUCTIONS_INTRO;
      const text = frame([
        pointerStrongText(maxBytes, listedOf(deferred)),
        intro,
        ...kept.map(sectionOf),
      ]);
      // 比出貨的通知長，預算緊到放不下時退回出貨的那一行，不讓請求超過預算。
      return byteLength(text) <= maxBytes ? { text, deferred: shipped.deferred } : shipped;
    },
  }),
};

/** 指標放進系統提示，使用者訊息裡不留任何東西。 */
const systemPrompt: DeferralVariant = {
  id: 'system-prompt',
  marker: SYSTEM_PROMPT_MARKER,
  create() {
    let pointer = '';
    return {
      render(files, maxBytes) {
        const shipped = renderAgentInstructions(files, maxBytes);
        pointer = '';
        if (shipped === undefined) return undefined;
        if (shipped.deferred.length === 0) return shipped;
        const { kept, deferred } = deferredFiles(files, shipped);
        pointer = systemPromptText(maxBytes, listedOf(deferred));
        return kept.length === 0 ? undefined : renderAgentInstructions(kept, maxBytes);
      },
      promptSection: () => pointer,
    };
  },
};

/** 延後時留檔頭的一段，其餘留指標。 */
const headExcerpt: DeferralVariant = {
  id: 'head-excerpt',
  marker: HEAD_EXCERPT_MARKER,
  create: () => ({
    render(files, maxBytes) {
      const shipped = renderAgentInstructions(files, maxBytes);
      if (shipped === undefined || shipped.deferred.length === 0) return shipped;
      const { kept, deferred } = deferredFiles(files, shipped);
      const build = (excerptBytes: number): string => {
        const parts = deferred.map((file) => {
          const excerpt = truncateUtf8(file.content, excerptBytes);
          return {
            notice: headExcerptNotice(
              maxBytes,
              readPathOf(file),
              byteLength(file.content),
              byteLength(excerpt),
            ),
            section: sectionOf({ ...file, content: excerpt }),
          };
        });
        return frame([
          ...parts.map((part) => part.notice),
          AGENT_INSTRUCTIONS_INTRO,
          ...kept.map(sectionOf),
          ...parts.map((part) => part.section),
        ]);
      };
      let excerptBytes = HEAD_EXCERPT_BYTES;
      let text = build(excerptBytes);
      // 外框與通知佔掉的位元組要從摘錄扣：整則不能超過預算。
      const over = byteLength(text) - maxBytes;
      if (over > 0) {
        excerptBytes = Math.max(0, excerptBytes - over - 32);
        text = build(excerptBytes);
      }
      return byteLength(text) <= maxBytes ? { text, deferred: shipped.deferred } : shipped;
    },
  }),
};

/** 截斷最具體的那一份並留通知，沒有叫模型去讀。 */
export function truncateNotice(
  maxBytes: number,
  omitted: readonly InstructionFile[],
  truncated: readonly { displayPath: string; originalBytes: number; includedBytes: number }[],
): string {
  if (omitted.length === 0 && truncated.length === 0) return '';
  const parts: string[] = [];
  if (omitted.length > 0)
    parts.push(`omitted ${omitted.map((file) => file.displayPath).join(', ')}`);
  if (truncated.length > 0) {
    parts.push(
      `truncated ${truncated.map((item) => `${item.displayPath} from ${item.originalBytes} to ${item.includedBytes} bytes`).join(', ')}`,
    );
  }
  return `${TRUNCATE_MARKER} ${maxBytes} bytes: ${parts.join('; ')}`;
}

/**
 * 沒有做緊湊引言那一層（連截到零位元組、帶完整引言都放不下時換短引言）：預算小到那個程度，這個評估的格子都碰不到；
 * 也沒有做「通知加空標題」那一層，最後一層直接退成只有通知。
 */
function renderTruncated(
  files: readonly InstructionFile[],
  maxBytes: number,
): RenderedAgentInstructions | undefined {
  if (files.length === 0 || maxBytes <= 0 || !Number.isFinite(maxBytes)) return undefined;
  const build = (
    included: readonly InstructionFile[],
    omitted: readonly InstructionFile[],
    truncated: Parameters<typeof truncateNotice>[2],
  ): string =>
    frame([
      truncateNotice(maxBytes, omitted, truncated),
      AGENT_INSTRUCTIONS_INTRO,
      ...included.map(sectionOf),
    ]);
  const fits = (text: string): boolean => byteLength(text) <= maxBytes;

  const full = build(files, [], []);
  if (fits(full)) return { text: full, deferred: [] };

  // 先丟較寬的：留下的優先是最貼近手上這件事的那幾份。
  for (let start = 1; start < files.length; start += 1) {
    const omitted = files.slice(0, start);
    const text = build(files.slice(start), omitted, []);
    if (fits(text)) return { text, deferred: deferredReport(omitted) };
  }

  const last = files[files.length - 1]!;
  const omitted = files.slice(0, -1);
  const originalBytes = byteLength(last.content);
  const candidate = (includedBytes: number): InstructionFile => ({
    ...last,
    content: truncateUtf8(last.content, includedBytes),
  });
  const textFor = (includedBytes: number): string => {
    const file = candidate(includedBytes);
    return build([file], omitted, [
      { displayPath: last.displayPath, originalBytes, includedBytes: byteLength(file.content) },
    ]);
  };
  let low = 0;
  let high = originalBytes;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (fits(textFor(mid))) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  const includedBytes = byteLength(candidate(best).content);
  const dropped = [
    ...deferredReport(omitted),
    { displayPath: last.displayPath, bytes: originalBytes - includedBytes },
  ];
  const text = textFor(best);
  if (fits(text)) return { text, deferred: dropped };
  const notice = escapeFrameBody(
    truncateNotice(maxBytes, omitted, [
      { displayPath: last.displayPath, originalBytes, includedBytes: 0 },
    ]),
  );
  return { text: truncateUtf8(notice, maxBytes), deferred: dropped };
}

const truncate: DeferralVariant = {
  id: 'truncate',
  marker: TRUNCATE_MARKER,
  create: () => ({ render: renderTruncated }),
};

export const DEFERRAL_VARIANTS: readonly DeferralVariant[] = [
  current,
  pointerStrong,
  systemPrompt,
  headExcerpt,
  truncate,
];

/** 認得的做法名，`--variant` 驗值用。 */
export const DEFERRAL_VARIANT_IDS: readonly DeferralVariantId[] = DEFERRAL_VARIANTS.map(
  (variant) => variant.id,
);

export function deferralVariant(id: DeferralVariantId): DeferralVariant {
  const found = DEFERRAL_VARIANTS.find((variant) => variant.id === id);
  if (found === undefined) throw new Error(`沒有這個做法：${id}`);
  return found;
}

/** 掛在系統提示的那一段的名字。 */
const PROMPT_SECTION_NAME = 'deferred-instructions';

function variantPlugin(variant: DeferralVariant, limits: AgentInstructionsLimits): NexusPlugin {
  return {
    name: 'agent-instructions',
    apply(registry) {
      const instance = variant.create();
      const lookup = registryFsLookup(registry);
      const cutoffs = summaryCutoffsOf(registry);
      registry.middleware.use(
        createPreStepMiddleware(
          AGENT_INSTRUCTIONS_MIDDLEWARE_NAME,
          createAgentInstructionsListener(
            limits,
            { fs: (invocation) => lookup(invocation) },
            instance.render,
          ),
          registry.sessions,
          (config, messages) => cutoffs.lookup(config, messages),
          () => nextContextWindowOf(registry),
        ),
      );
      const section = instance.promptSection;
      if (section !== undefined) {
        registry.prompt.section({
          name: PROMPT_SECTION_NAME,
          order: MIDDLE_SECTION_ORDERS.PLUGIN_POLICY,
          text: () => section(),
        });
      }
    },
  };
}

/**
 * 把出貨清單上的 `agent-instructions` 那一列原位換成帶這種做法的相容層插件。id 與清單上的位置不變：
 * 注入訊息的相對順序（在技能叫用與時間讀數之前）靠位置。上限取自那一列自己的設定，所以評估對上限的蓋掉照樣生效。
 *
 * @param shipped - 出貨清單（可以已經換過模型）。
 * @param variant - 要換成的做法。
 * @returns 換好的清單，原清單不動。
 * @throws {Error} 清單上找不到那一列：出貨清單改了名，這裡要跟著改。
 */
export function withInstructionVariant(
  shipped: readonly PluginEntry[],
  variant: DeferralVariant,
): PluginEntry[] {
  let replaced = false;
  const rows = shipped.map((entry): PluginEntry => {
    if (entry.id !== 'agent-instructions') return entry;
    replaced = true;
    const limits = agentInstructionsConfigSchema.parse(entry.config ?? {});
    return { id: entry.id, plugin: variantPlugin(variant, limits) as NexusPlugin<unknown> };
  });
  if (!replaced) throw new Error('清單上沒有 agent-instructions 那一列，換不了做法');
  return rows;
}
