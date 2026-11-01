/**
 * 測試用的拿鎖（#2253）：系統的 `perl` 繼承 fd 之後呼叫 `flock(2)`，是真的 kernel 鎖，結束碼同 spawner 的 `--flock`。
 * 一般測試不編 Rust，Mac 上也沒有 spawner。真的 spawner 在 `kernel-file-lock.integration.test.ts`。
 *
 * @module
 */

import { spawn, spawnSync } from 'node:child_process';

import type { spawnerFlock, TryLock } from './kernel-file-lock.js';

const PERL = 'perl';

const SCRIPT = `
use Fcntl qw(:flock);
open(my $f, '+<&=', 3) or do { print 0 + $!; exit 11 };
exit 0 if flock($f, LOCK_EX | LOCK_NB);
exit 10 if $!{EWOULDBLOCK};
print 0 + $!; exit 11;
`;

/**
 * 建一支測試用的 {@link TryLock}。`perl` 不在就拋：退到不鎖的話，測鎖的測試會在錯的地方紅。
 *
 * @param flock - 真的 `spawnerFlock`。由呼叫端傳：setup 在 `kernel-file-lock.js` 的 mock 裡呼叫這裡，這裡再 import 它會等到自己。
 */
export function perlFlock(flock: typeof spawnerFlock): TryLock {
  const probe = spawnSync(PERL, ['-e', 'exit 0']);
  if (probe.status !== 0) {
    throw new Error(`測試的鎖要系統的 perl：${probe.error?.message ?? String(probe.status)}`);
  }
  return flock(PERL, (binary, _args, options) => spawn(binary, ['-e', SCRIPT], options));
}
