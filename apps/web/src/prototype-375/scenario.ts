/**
 * PROTOTYPE #375 — 假資料劇本。形狀照 `@nexus/wire` 的 `ConversationEntry`／`PendingInput`，
 * 但**不經過折疊器**：這裡只管畫面要看到什麼，狀態怎麼折出來不是這張卡的問題。
 */

import { useCallback, useRef, useState } from 'react';

import type {
  Attribution,
  ConversationEntry,
  ConversationStatus,
  PendingApproval,
  PendingInput,
  PendingQuestion,
  ToolEntry,
} from '@nexus/wire';

export interface ProtoState {
  readonly entries: readonly ConversationEntry[];
  readonly status: ConversationStatus;
  readonly error?: string;
  readonly pendings: readonly PendingInput[];
}

type Step =
  | { readonly wait: number }
  | { readonly apply: (state: ProtoState) => ProtoState }
  | {
      readonly stream: {
        readonly id: string;
        readonly text: string;
        readonly attribution?: Attribution;
      };
    };

const ROOT: Attribution = { kind: 'root' };
const EXPLORE: Attribution = { kind: 'subagent', name: 'explore', callId: 'call-grep' };

export const EMPTY: ProtoState = { entries: [], status: 'idle', pendings: [] };

const add =
  (entry: ConversationEntry, patch: Partial<ProtoState> = {}) =>
  (state: ProtoState): ProtoState => ({ ...state, ...patch, entries: [...state.entries, entry] });

const patchTool =
  (id: string, patch: Partial<ToolEntry>, rest: Partial<ProtoState> = {}) =>
  (state: ProtoState): ProtoState => ({
    ...state,
    ...rest,
    entries: state.entries.map((entry) =>
      entry.kind === 'tool' && entry.id === id ? { ...entry, ...patch } : entry,
    ),
  });

const tool = (
  id: string,
  name: string,
  input: unknown,
  status: ToolEntry['status'],
  attribution: Attribution = ROOT,
): ToolEntry => ({
  kind: 'tool',
  id,
  callId: `call-${id}`,
  name,
  input: JSON.stringify(input),
  status,
  attribution,
});

export const APPROVAL: PendingApproval = {
  kind: 'approval',
  interruptId: 'interrupt-edit',
  namespace: [],
  allowedDecisions: ['approve', 'reject'],
  actions: [
    {
      name: 'edit_file',
      args: {
        file_path: 'apps/web/vite.config.ts',
        old_string: 'plugins: [react(), tailwindcss()],',
        new_string:
          "plugins: [react(), tailwindcss()],\n  build: {\n    rollupOptions: {\n      output: { manualChunks: { mermaid: ['mermaid'] } },\n    },\n  },",
      },
    },
  ],
};

export const QUESTION: PendingQuestion = {
  kind: 'question',
  interruptId: 'interrupt-ask',
  namespace: [],
  questions: [
    {
      id: 'q-split',
      header: '拆法',
      question: 'mermaid 要怎麼處理？',
      options: [
        { label: '拆成獨立 chunk', description: '第一次畫圖時才載入' },
        { label: '整個拿掉', description: '訊息裡的 mermaid 圖改顯示原始碼' },
        { label: '先不動' },
      ],
    },
    {
      id: 'q-also',
      header: '順便',
      question: '要不要一起處理這些？',
      multiSelect: true,
      options: [
        { label: 'shiki 語言按需載入' },
        { label: 'katex 改成 lazy' },
        { label: '在 CI 加 bundle 大小檢查' },
      ],
    },
    { id: 'q-limit', header: '門檻', question: '主 chunk 的上限要設多少 kB？' },
  ],
};

const EDIT_INPUT = APPROVAL.actions[0]?.args;

/** 從送出到停在核准點。 */
const OPENING: readonly Step[] = [
  {
    apply: () => ({
      ...EMPTY,
      status: 'running',
      entries: [
        {
          kind: 'human',
          id: 'h-1',
          text: '幫我看一下 apps/web 的 build 為什麼變這麼大，能拆就拆。',
        },
      ],
    }),
  },
  { wait: 500 },
  { stream: { id: 'a-1', text: '我先看 build 產物和 vite 設定，找出主 chunk 為什麼變大。' } },
  { wait: 250 },
  { apply: add(tool('read', 'read_file', { file_path: 'apps/web/vite.config.ts' }, 'running')) },
  { wait: 1100 },
  {
    apply: patchTool('read', {
      status: 'done',
      output:
        "export default defineConfig({\n  plugins: [react(), tailwindcss()],\n  server: { proxy: { '/threads': … } },\n})",
    }),
  },
  {
    apply: add(
      tool('grep', 'grep', { pattern: 'streamdown', path: 'apps/web/src' }, 'running', EXPLORE),
    ),
  },
  { wait: 1600 },
  {
    apply: patchTool('grep', {
      status: 'done',
      output: "src/components/ai-elements/message.tsx:3: import { Streamdown } from 'streamdown'",
    }),
  },
  { apply: add(tool('bash', 'bash', { command: 'pnpm build --report' }, 'running')) },
  { wait: 1200 },
  { apply: patchTool('bash', { status: 'failed', error: 'exit 1：Unknown option "--report"' }) },
  {
    stream: {
      id: 'a-2',
      text: '沒有 --report 這個選項，改直接看 dist：主 chunk 1,933 kB，mermaid 是 streamdown 在模組頂層 import 進來的。我打算在 vite.config.ts 加 manualChunks 把它拆出去。',
    },
  },
  { wait: 300 },
  {
    apply: add(tool('edit', 'edit_file', EDIT_INPUT, 'suspended'), {
      status: 'awaiting-input',
      pendings: [APPROVAL],
    }),
  },
];

const APPROVED: readonly Step[] = [
  {
    apply: (state) =>
      patchTool(
        'edit',
        { status: 'running' },
        { status: 'running', pendings: [] },
      )(add({ kind: 'decision', id: 'd-1', decision: 'approve', actions: ['edit_file'] })(state)),
  },
  { wait: 900 },
  {
    apply: patchTool('edit', { status: 'done', output: '已寫入 apps/web/vite.config.ts（+6 −1）' }),
  },
  { stream: { id: 'a-3', text: '改好了。接下來有三件事要你決定。' } },
  { wait: 250 },
  { apply: (state) => ({ ...state, status: 'awaiting-input', pendings: [QUESTION] }) },
];

const REJECTED: readonly Step[] = [
  {
    apply: (state) =>
      patchTool(
        'edit',
        { status: 'failed', error: '人拒絕了這次呼叫' },
        { status: 'running', pendings: [] },
      )(add({ kind: 'decision', id: 'd-1', decision: 'reject', actions: ['edit_file'] })(state)),
  },
  { wait: 400 },
  { stream: { id: 'a-4', text: '好，不動設定檔。想換別的拆法再告訴我。' } },
  { apply: (state) => ({ ...state, status: 'idle' }) },
];

export type Answer = { id: string; selected: string[]; custom?: string };

const answered = (answers: readonly Answer[] | 'cancel'): readonly Step[] => [
  {
    apply: add(
      answers === 'cancel'
        ? { kind: 'answer', id: 'ans-1', cancelled: true, answers: [] }
        : { kind: 'answer', id: 'ans-1', answers },
      { status: 'running', pendings: [] },
    ),
  },
  { wait: 500 },
  {
    stream: {
      id: 'a-5',
      text:
        answers === 'cancel'
          ? '好，這幾件先不決定。'
          : '收到，照你選的做。mermaid 拆出去之後主 chunk 回到 420 kB 左右。',
    },
  },
  { apply: (state) => ({ ...state, status: 'idle' }) },
];

const replyTo = (text: string): readonly Step[] => [
  {
    apply: (state) => ({
      ...state,
      status: 'running',
      entries: [...state.entries, { kind: 'human', id: `h-${Date.now()}`, text }],
    }),
  },
  { wait: 600 },
  {
    stream: {
      id: `a-${Date.now()}`,
      text: '（原型）這裡只有假資料，不會真的連 harness。想看完整一輪，按切換列的「重播」。',
    },
  },
  { apply: (state) => ({ ...state, status: 'idle' }) },
];

/** 不等、不逐字，直接算出劇本跑完的樣子。 */
function settle(state: ProtoState, steps: readonly Step[]): ProtoState {
  return steps.reduce<ProtoState>((current, step) => {
    if ('apply' in step) return step.apply(current);
    if ('stream' in step) {
      return add({
        kind: 'ai',
        id: step.stream.id,
        text: step.stream.text,
        streaming: false,
        attribution: step.stream.attribution ?? ROOT,
      })(current);
    }
    return current;
  }, state);
}

export const JUMPS = ['空白', '執行中', '核准', '提問', '失敗'] as const;
export type Jump = (typeof JUMPS)[number];

function jumpState(jump: Jump): ProtoState {
  switch (jump) {
    case '空白':
      return EMPTY;
    case '執行中': {
      // 停在 grep 跑到一半：工具卡、子代理、輸入框的執行中動效都在畫面上。
      const upToGrep = OPENING.slice(
        0,
        OPENING.findIndex((step) => 'wait' in step && step.wait === 1600),
      );
      return settle(EMPTY, upToGrep);
    }
    case '核准':
      return settle(EMPTY, OPENING);
    case '提問':
      return settle(settle(EMPTY, OPENING), APPROVED);
    case '失敗': {
      const upToBash = OPENING.slice(
        0,
        OPENING.findIndex((step) => 'stream' in step && step.stream.id === 'a-2'),
      );
      return {
        ...settle(EMPTY, upToBash),
        status: 'failed',
        error: '模型供應商回 429：這個小時的額度用完了',
      };
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function useScenario() {
  const [state, setState] = useState<ProtoState>(() => jumpState('核准'));
  const run = useRef(0);

  const play = useCallback(async (steps: readonly Step[]) => {
    const token = ++run.current;
    for (const step of steps) {
      if (run.current !== token) return;
      if ('wait' in step) {
        await sleep(step.wait);
      } else if ('apply' in step) {
        setState(step.apply);
      } else {
        const { id, text, attribution = ROOT } = step.stream;
        setState(add({ kind: 'ai', id, text: '', streaming: true, attribution }));
        for (let at = 2; at <= text.length + 1; at += 2) {
          await sleep(28);
          if (run.current !== token) return;
          const slice = text.slice(0, at);
          setState((current) => ({
            ...current,
            entries: current.entries.map((entry) =>
              entry.kind === 'ai' && entry.id === id ? { ...entry, text: slice } : entry,
            ),
          }));
        }
        setState((current) => ({
          ...current,
          entries: current.entries.map((entry) =>
            entry.kind === 'ai' && entry.id === id ? { ...entry, streaming: false } : entry,
          ),
        }));
      }
    }
  }, []);

  return {
    state,
    replay: () => void play(OPENING),
    jump: (jump: Jump) => {
      run.current++;
      setState(jumpState(jump));
    },
    decide: (decision: string) => void play(decision === 'approve' ? APPROVED : REJECTED),
    answer: (answers: readonly Answer[] | 'cancel') => void play(answered(answers)),
    send: (text: string) => void play(replyTo(text)),
    stop: () => {
      run.current++;
      setState((current) => ({
        ...current,
        status: 'stopped',
        pendings: [],
        entries: current.entries.map((entry) => {
          if (entry.kind === 'ai' && entry.streaming)
            return { ...entry, streaming: false, stopped: true };
          if (
            entry.kind === 'tool' &&
            (entry.status === 'running' || entry.status === 'suspended')
          ) {
            return { ...entry, status: 'failed', error: '這一輪被停止' };
          }
          return entry;
        }),
      }));
    },
  };
}
