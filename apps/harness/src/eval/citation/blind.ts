/**
 * 盲標：把兩批以上的記錄混在一起洗牌，藏起版本，標完再對回去
 * （[#1345](https://github.com/DemianLi/nexus-agent/issues/1345)）。
 *
 * 為什麼要有：同一個人標自己知道是「基線」還是「新版」的答案，會往預期的方向偏。#1344 的標註是我知道組別時標的，
 * 拿來比新舊版不公平，所以兩版一起洗牌、標的人只看得到問題、工具回了什麼、呼叫了哪些工具、答案全文。
 *
 * **藏得住的是版本，藏不住的是組別**：標捏造要知道工具回了什麼（A 的正文是界線），而工具回的內容就等於組別。
 * 這是判準要求的，不是疏漏；組別不影響「新舊版」的比較，因為兩版在同一組內洗牌、同一組內比。
 *
 * 純函式、種子固定，所以同一批輸入洗出同一份，打包可以重做。
 *
 * @module
 */

import { linksFor, textFor } from './fixture.js';
import type { Group } from './fixture.js';
import type { Label, RunRecord } from './report.js';

/** 標的人看到的一筆。沒有 id、組別名、版本、耗時。 */
export interface BlindItem {
  readonly blindId: string;
  readonly question: string;
  /** 工具回了什麼（依組別重建；標捏造要以它為界）。 */
  readonly toolResult: string;
  readonly toolCalls: readonly string[];
  readonly status: string;
  readonly answer: string;
  readonly askText: string;
}

/** 打包後留給自己的對照表，標完才用。 */
export type BlindKey = Readonly<Record<string, { readonly version: string; readonly id: string }>>;

/** 一批：版本名（例如 `baseline`、`new`）與它的記錄。 */
export interface VersionedRecords {
  readonly version: string;
  readonly records: readonly RunRecord[];
}

/** mulberry32：小型、可重現的亂數。 */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const next = random(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** 工具回給模型的內容，依組別重建（文字加連結的名稱與網址）。 */
export function toolResultFor(group: Group): string {
  const links = linksFor(group).map((link) => {
    const title = 'title' in link ? `（${link.title}）` : '';
    return `resource_link：${link.name}${title} ${link.uri}`;
  });
  return [textFor(group), ...links].join('\n');
}

/**
 * 只有失敗的執行（`error`）不進盲標：它們沒有答案可標。
 *
 * @param sets - 要混的幾批。
 * @param seed - 洗牌種子；同一批輸入同一個種子洗出同一份。
 */
export function packBlind(
  sets: readonly VersionedRecords[],
  seed: number,
): { items: BlindItem[]; key: BlindKey } {
  const flat = sets.flatMap(({ version, records }) =>
    records.filter((record) => record.error === undefined).map((record) => ({ version, record })),
  );
  // 先按 (version, id) 排穩定，再洗牌：輸入順序不同也洗出同一份。
  flat.sort((a, b) => `${a.version}/${a.record.id}`.localeCompare(`${b.version}/${b.record.id}`));
  const items: BlindItem[] = [];
  const key: Record<string, { version: string; id: string }> = {};
  shuffled(flat, seed).forEach(({ version, record }, index) => {
    const blindId = `x${String(index + 1).padStart(3, '0')}`;
    key[blindId] = { version, id: record.id };
    items.push({
      blindId,
      question: record.question,
      toolResult: toolResultFor(record.group),
      toolCalls: record.toolCalls,
      status: record.status,
      answer: record.answer,
      askText: record.askText,
    });
  });
  return { items, key };
}

/**
 * 把盲標的結果依版本拆回去。標的 id 對不上對照表、或有 id 沒標到，都丟錯，不靜靜略過。
 */
export function unpackLabels(
  blindLabels: Readonly<Record<string, Label>>,
  key: BlindKey,
): Record<string, Record<string, Label>> {
  const unknown = Object.keys(blindLabels).filter((id) => key[id] === undefined);
  if (unknown.length > 0) throw new Error(`標註裡有對照表沒有的 id：${unknown.join('、')}`);
  const missing = Object.keys(key).filter((id) => blindLabels[id] === undefined);
  if (missing.length > 0)
    throw new Error(`對照表裡有 ${missing.length} 筆沒標到：${missing.slice(0, 5).join('、')}…`);
  const out: Record<string, Record<string, Label>> = {};
  for (const [blindId, label] of Object.entries(blindLabels)) {
    const target = key[blindId];
    if (target === undefined) continue;
    (out[target.version] ??= {})[target.id] = label;
  }
  return out;
}
