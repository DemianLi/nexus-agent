/**
 * **PROTOTYPE，丟棄用，不進 develop。** #574「會話累計 token」擺在哪、時間那顆要不要做。
 *
 * 四種擺法都掛在真的頁面上，用 `?variant=A|B|C|D` 切，`&time=0` 關掉時間那一格；底部浮著切換列，←／→ 也能切。
 * 數字全是假的（STUB），畫面上的用量表在原型模式下也換成同一組假數字，兩邊對得起來。
 * 第一版不分快取（demian，2026-09-25）：只有輸入、輸出、總量。
 */

import { ChevronLeft, ChevronRight, Clock, Coins, Gauge } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { WireContextPressure } from '@nexus/wire';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { compact } from '@/lib/context-meter-view';

export const VARIANTS = {
  A: '輸入框底列並排兩顆（照 dsh）',
  B: '併進用量表的明細',
  C: '頂列一顆',
  D: '狀態列下一行字',
} as const;
export type Variant = keyof typeof VARIANTS;
const KEYS = Object.keys(VARIANTS) as Variant[];

/** 假的累計帳：4 輪、17 次 root 模型呼叫。總量是每一次呼叫的輸入加輸出，所以遠大於「目前大小」。 */
export const STUB_USAGE = { input: 412_380, output: 9_815 } as const;
export const STUB_TIME = {
  turns: 4,
  steps: 17,
  modelMs: 133_000,
  toolMs: 38_400,
  ttftMs: 1_800,
  tokensPerSecond: 42,
} as const;
/** 原型模式下用量表也吃假數字，跟累計帳同一場對話。 */
export const STUB_PRESSURE: WireContextPressure = {
  inputTokens: 38_212,
  measure: {
    approxTokens: 37_900,
    messageCount: 23,
    thresholds: [
      { type: 'tokens', value: 100_000 },
      { type: 'messages', value: 60 },
    ],
  },
};

const total = STUB_USAGE.input + STUB_USAGE.output;
const exact = (count: number) => `${count.toLocaleString('en-US')} token`;
const seconds = (ms: number) =>
  ms < 60_000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;

/** 讀網址上的原型參數；沒有 `variant` 就不是原型模式。 */
export function useProto(): { variant: Variant | null; time: boolean } {
  const read = () => {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('variant');
    return {
      variant: raw !== null && raw in VARIANTS ? (raw as Variant) : null,
      time: params.get('time') !== '0',
    };
  };
  const [state, setState] = useState(read);
  useEffect(() => {
    const sync = () => setState(read());
    window.addEventListener('proto-574', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('proto-574', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);
  return state;
}

function go(variant: Variant, time: boolean) {
  const params = new URLSearchParams(window.location.search);
  params.set('variant', variant);
  if (time) params.delete('time');
  else params.set('time', '0');
  window.history.replaceState(null, '', `${window.location.pathname}?${params}${window.location.hash}`);
  window.dispatchEvent(new Event('proto-574'));
}

// ── 共用的明細內容 ───────────────────────────────────────────────

function Rows({ rows }: { rows: readonly (readonly [string, string])[] }) {
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm tabular-nums">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function UsageSection() {
  return (
    <section className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <p className="text-muted-foreground text-xs">這條對話累計</p>
        <p className="text-sm font-medium tabular-nums">{exact(total)}</p>
      </div>
      <Rows
        rows={[
          ['輸入', exact(STUB_USAGE.input)],
          ['輸出', exact(STUB_USAGE.output)],
        ]}
      />
      <p className="text-muted-foreground text-xs">
        每一次模型呼叫的帳加起來，所以比「目前大小」大很多。不含子代理與自動摘要那幾次。
      </p>
    </section>
  );
}

export function TimeSection() {
  return (
    <section className="space-y-1.5">
      <p className="text-muted-foreground text-xs">時間</p>
      <Rows
        rows={[
          ['輪／模型呼叫', `${STUB_TIME.turns} 輪／${STUB_TIME.steps} 次`],
          ['模型時間', seconds(STUB_TIME.modelMs)],
          ['工具時間', seconds(STUB_TIME.toolMs)],
          ['平均首字', seconds(STUB_TIME.ttftMs)],
          ['輸出速度', `${STUB_TIME.tokensPerSecond} token/秒`],
        ]}
      />
    </section>
  );
}

const chip =
  'hover:bg-chip-hover active:bg-chip-pressed text-muted-foreground flex h-11 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs tabular-nums transition-colors lg:h-9';

function PopChip({
  label,
  icon,
  text,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  text: string;
  children: React.ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger aria-label={label} className={chip}>
        {icon}
        {text}
      </PopoverTrigger>
      <PopoverContent side="top" align="start" aria-label={label} className="w-72 space-y-3">
        {children}
      </PopoverContent>
    </Popover>
  );
}

// ── A：輸入框底列，用量表旁邊並排兩顆 ─────────────────────────────

export function VariantAPills({ time }: { time: boolean }) {
  return (
    <>
      {time && (
        <PopChip
          label="時間統計"
          icon={<Gauge className="size-4" />}
          text={`${STUB_TIME.turns} 輪 · ${STUB_TIME.tokensPerSecond} token/秒`}
        >
          <TimeSection />
        </PopChip>
      )}
      <PopChip label="累計用量" icon={<Coins className="size-4" />} text={`${compact(total)} token`}>
        <UsageSection />
      </PopChip>
    </>
  );
}

// ── B：不加新東西，塞進用量表的明細（App 那邊把 extra 傳給 ContextMeter） ──

export function VariantBExtra({ time }: { time: boolean }) {
  return (
    <>
      <hr className="border-border" />
      <UsageSection />
      {time && (
        <>
          <hr className="border-border" />
          <TimeSection />
        </>
      )}
    </>
  );
}

// ── C：頂列右邊一顆，點開兩段 ─────────────────────────────────────

export function VariantCHeader({ time }: { time: boolean }) {
  return (
    <Popover>
      <PopoverTrigger aria-label="這條對話的用量" className={chip}>
        <Coins className="size-4" />
        {compact(total)} token
        {time && (
          <>
            <span aria-hidden>·</span>
            <Clock className="size-4" />
            {STUB_TIME.turns} 輪
          </>
        )}
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-72 space-y-3">
        <UsageSection />
        {time && (
          <>
            <hr className="border-border" />
            <TimeSection />
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ── D：狀態列底下一行字，不能點 ─────────────────────────────────

export function VariantDLine({ time }: { time: boolean }) {
  return (
    <p className="text-muted-foreground text-xs tabular-nums">
      這條對話用了 {compact(total)} token（輸入 {compact(STUB_USAGE.input)}、輸出{' '}
      {compact(STUB_USAGE.output)}）
      {time &&
        ` · ${STUB_TIME.turns} 輪 · 模型 ${seconds(STUB_TIME.modelMs)} · ${STUB_TIME.tokensPerSecond} token/秒`}
    </p>
  );
}

// ── 切換列 ─────────────────────────────────────────────────────

export function ProtoSwitcher({ variant, time }: { variant: Variant; time: boolean }) {
  const index = KEYS.indexOf(variant);
  const step = (delta: number) => go(KEYS[(index + delta + KEYS.length) % KEYS.length]!, time);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable]')) return;
      if (event.key === 'ArrowLeft') step(-1);
      if (event.key === 'ArrowRight') step(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const button = 'rounded-full p-1.5 hover:bg-white/15';
  return (
    <div className="fixed top-2 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full bg-neutral-900 px-2 py-1 text-xs text-white shadow-lg ring-1 ring-white/20">
      <span className="rounded-full bg-amber-400 px-2 py-0.5 font-semibold text-neutral-900">原型</span>
      <button type="button" className={button} aria-label="上一個" onClick={() => step(-1)}>
        <ChevronLeft className="size-4" />
      </button>
      <span className="min-w-52 text-center">
        {variant}｜{VARIANTS[variant]}
      </span>
      <button type="button" className={button} aria-label="下一個" onClick={() => step(1)}>
        <ChevronRight className="size-4" />
      </button>
      <button
        type="button"
        className="ml-1 rounded-full px-2 py-1 ring-1 ring-white/30 hover:bg-white/15"
        onClick={() => go(variant, !time)}
      >
        時間：{time ? '開' : '關'}
      </button>
    </div>
  );
}
