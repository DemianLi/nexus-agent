/**
 * 量每次模型呼叫裡日誌全掃佔多少時間（見 `session-scan.ts`）。不進 CI。
 *
 * ```bash
 * pnpm --filter @nexus/harness exec tsx --tsconfig ../../tsconfig.runtime.json src/measure/session-scan-cli.ts
 * # 剪刀那一列關掉（不剪新的，記過的剪法照樣每次讀日誌套用，#1567 N0780）：
 * pnpm --filter @nexus/harness exec tsx --tsconfig ../../tsconfig.runtime.json src/measure/session-scan-cli.ts --off tool-result-pruner
 * # 摘要那一列的保留量換成固定 token 數（非出廠）。出廠的保留量封在 tokens 門檻的兩成（20,000）；夾具每 10 輪那顆
 * # 10,000 字的工具結果是往前累加跨過 20,000 的那一則時，切點就停在它的工具呼叫前面，之後幾輪的摘要只取代上一顆摘要、
 * # 不比它小，被 `SummaryNotSmallerError` 擋下。保留量小到每輪的新訊息就夠，切點每次都往前，摘要才提交得了：
 * pnpm --filter @nexus/harness exec tsx --tsconfig ../../tsconfig.runtime.json src/measure/session-scan-cli.ts --retain-tokens 200
 * ```
 */

import { parseArgs } from 'node:util';
import { loadavg } from 'node:os';
import { stringify } from 'yaml';
import { composeEntries } from '../plugin-config.js';
import { measureSessionScans } from './session-scan.js';

const { values } = parseArgs({
  options: {
    checkpoints: { type: 'string', default: '500,1000,2000,5000' },
    window: { type: 'string', default: '10' },
    sampling: { type: 'string', default: '100' },
    off: { type: 'string', multiple: true, default: [] },
    'retain-tokens': { type: 'string' },
  },
});

const integer = (name: string, raw: string): number => {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`--${name} 要非負整數：${raw}`);
  return value;
};

/** 以出貨的摘要那一列為底，`retainRatio` 換成 `retainTokens`（兩者擇一；patch 整份替換 `config`）。 */
const summarizationRow = (retainTokens: number): string => {
  const row = composeEntries().find((entry) => entry.id === 'summarization');
  if (row?.config === undefined) throw new Error('出貨清單裡找不到 summarization 那一列');
  const { retainRatio: _ratio, ...config } = structuredClone(row.config) as Record<string, unknown>;
  return stringify([{ id: 'summarization', config: { ...config, retainTokens } }]).trimEnd();
};

const patchExtra = [
  ...values.off!.map((id) => `- id: ${id}\n  disabled: true`),
  ...(values['retain-tokens'] === undefined
    ? []
    : [summarizationRow(integer('retain-tokens', values['retain-tokens']))]),
].join('\n');
const startLoad = loadavg();
const startedAt = Date.now();
const results = await measureSessionScans({
  checkpoints: values.checkpoints!.split(',').map((raw) => integer('checkpoints', raw)),
  window: integer('window', values.window!),
  samplingMicros: integer('sampling', values.sampling!),
  patchExtra,
});
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
for (const r of results) {
  const micro = Object.entries(r.microMicros)
    .map(([name, us]) => `${name}=${us.toFixed(1)}µs`)
    .join(' ');
  const by = Object.entries(r.profiledShareBy)
    .filter(([, share]) => share > 0)
    .map(([name, share]) => `${name}=${pct(share)}`)
    .join(' ');
  console.log(
    [
      `events=${r.events} turns=${r.turns} requests=${r.requests} aux=${r.auxRequests} summaries=${r.summaries}`,
      `  每次請求 median=${r.perRequestMs.median.toFixed(2)}ms p95=${r.perRequestMs.p95.toFixed(2)}ms`,
      `  每次請求複製 events ${r.copiesPerRequest.toFixed(2)} 次、${r.copyMsPerRequest.toFixed(3)}ms`,
      `  剖析：全掃佔非閒置樣本 ${pct(r.profiledShare)}（${by || '無'}）`,
      `  微基準（單次）：${micro}`,
      `  端點解析一次請求 body：${(r.endpointParseMicros / 1000).toFixed(3)}ms`,
    ].join('\n'),
  );
}
console.log(
  `off=[${values.off!.join(',')}] retain-tokens=${values['retain-tokens'] ?? '出廠'} 歷時 ${((Date.now() - startedAt) / 1000).toFixed(0)}s，` +
    `負載 ${startLoad.map((v) => v.toFixed(2)).join(' ')} → ${loadavg()
      .map((v) => v.toFixed(2))
      .join(' ')}`,
);
