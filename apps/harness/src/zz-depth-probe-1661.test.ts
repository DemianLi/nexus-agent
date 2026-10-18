// 暫時的量測檔（#1661）：走真的 JSONL 後端（append → flush → resume），二分搜尋事件在幾層開始寫不出去或讀不回來。
// console 會被吞，所以故意丟錯把數字帶到報告上。量完就撤。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attachSessionPersistence, SessionRegistry } from '@nexus/core';
import { it } from 'vitest';

import { openJsonlSessionStore } from './jsonl-session-store.js';

type Shape = 'object' | 'array' | 'mixed';
const build: Record<Shape, (n: number) => unknown> = {
  object: (n) => {
    let v: unknown = 'leaf';
    for (let i = 0; i < n; i++) v = { next: v };
    return v;
  },
  array: (n) => {
    let v: unknown = 'leaf';
    for (let i = 0; i < n; i++) v = [v];
    return v;
  },
  mixed: (n) => {
    let v: unknown = 'leaf';
    for (let i = 0; i < n; i++) v = i % 2 ? { next: v } : [v];
    return v;
  },
};

/** meta 有 n 層巢狀的那一顆 tool/result：寫得出去、續接讀得回來，才算過。 */
async function roundTrips(shape: Shape, n: number): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-depth-probe-'));
  try {
    const sessions = new SessionRegistry('root');
    const persistence = attachSessionPersistence(
      sessions,
      openJsonlSessionStore({ directory: dir }),
      {
        warn: () => {},
      },
    );
    sessions.root.append('tool/result', { callId: 'before', isError: false });
    sessions.root.append('tool/result', { callId: 'deep', isError: false, meta: build[shape](n) });
    sessions.root.append('tool/result', { callId: 'after', isError: false });
    try {
      await persistence.flush();
    } catch {
      return false;
    } finally {
      await persistence.dispose().catch(() => {});
    }
    const resumed = await openJsonlSessionStore({ directory: dir }).resume('root');
    try {
      return resumed.events.filter((event) => event.type === 'tool/result').length === 3;
    } finally {
      await resumed.stored.close();
    }
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function limit(test: (n: number) => Promise<boolean>, hi: number): Promise<string> {
  let lo = 0;
  if (await test(hi)) return `>=${hi}`;
  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await test(mid)) lo = mid;
    else hi = mid;
  }
  return String(lo);
}

it('量測：JSONL 後端寫得出去、讀得回來的 meta 層數（暫時）', async () => {
  const rows = [`node ${process.version} ${process.platform} ${process.arch}`];
  for (const shape of ['object', 'array', 'mixed'] as const) {
    const store = await limit((n) => roundTrips(shape, n), 20_000);
    let native = 0;
    {
      let lo = 0;
      let hi = 20_000;
      const ok = (n: number) => {
        try {
          JSON.stringify(build[shape](n));
          return true;
        } catch {
          return false;
        }
      };
      if (ok(hi)) lo = hi;
      while (lo < hi - 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (ok(mid)) lo = mid;
        else hi = mid;
      }
      native = lo;
    }
    rows.push(`${shape} jsonl-roundtrip-meta=${store} native-unfrozen-stringify=${native}`);
  }
  throw new Error(`DEPTH-PROBE-1661 ${rows.join(' | ')}`);
}, 600_000);
