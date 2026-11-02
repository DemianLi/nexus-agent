// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

/**
 * tokens.generated、theme、motion、index 四個檔裡 nexus 獨有的自訂屬性（#1689 驗收）：只准這些，每一個寫明理由。多一個或少一個都紅。
 * `shiki.css` 的 `--shiki-*` 是 shiki 的主題介面，不在此列。
 */
const NEXUS_ONLY: Readonly<Record<string, string>> = {
  '--animate-in': '機制：拿掉之後 reduced-motion 無聲失效（#1687）',
  '--animate-out': '機制：同 --animate-in',
  '--font-weight-semibold': '保險：vendor 同步上游寫了 font-semibold 也落在 500',
  '--font-weight-bold': '保險：同 --font-weight-semibold',
  '--text-tip': '字級四階（#1827 G1）：SG 沒有這組語意名，規格 §5 只走這四階',
  '--text-tip--line-height': '字級四階（#1827 G1）：SG 沒有這組語意名，規格 §5 只走這四階',
  '--text-ui': '字級四階（#1827 G1）：SG 沒有這組語意名，規格 §5 只走這四階',
  '--text-ui--line-height': '字級四階（#1827 G1）：SG 沒有這組語意名，規格 §5 只走這四階',
  '--text-body': '字級四階（#1827 G1）：SG 沒有這組語意名，規格 §5 只走這四階',
  '--text-body--line-height': '字級四階（#1827 G1）：SG 沒有這組語意名，規格 §5 只走這四階',
  '--text-micro': '字級四階（#1827 G1）：SG 沒有這組語意名，規格 §5 只走這四階',
  '--text-micro--line-height': '字級四階（#1827 G1）：SG 沒有這組語意名，規格 §5 只走這四階',
  '--radius-row': 'SG 3xl 的算式減掉內距 4：換成 rounded-2xl 差 1.6px，不同心',
  '--beam-width': '邊框光：亮暗不同的靜態值，SG 沒有對應',
  '--beam-glow': '邊框光：同 --beam-width',
  '--beam-glow-size': '邊框光：同 --beam-width',
  '--beam-pulse-min': '邊框光：同 --beam-width',
};

function customProperties(...files: readonly string[]): Set<string> {
  const names = files.flatMap((file) => {
    const css = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    return [...css.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((match) => match[1] as string);
  });
  return new Set(names);
}

describe('token 只留允許清單上的', () => {
  test('四個檔定義的、SG 沒有的自訂屬性，等於允許清單', () => {
    const sg = customProperties(
      'vendor/solid-glass/solid-glass.css',
      'vendor/solid-glass/shadcn/tailwind.css',
    );
    const ours = customProperties(
      'styles/tokens.generated.css',
      'styles/theme.css',
      'styles/motion.css',
      'index.css',
    );
    expect([...ours].filter((name) => !sg.has(name)).sort()).toEqual(
      Object.keys(NEXUS_ONLY).sort(),
    );
  });
});
