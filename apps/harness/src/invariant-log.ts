/**
 * 不變量的量測記錄（[#976](https://github.com/DemianLi/nexus-agent/issues/976)）：一個
 * {@link InvariantTap}，把「每一份日誌裝上了哪幾個 package 的檢查」與「報了哪一條違規」各 append
 * 成一行 JSON。
 *
 * **它為第二刀的決策存在**（`.docs/invariant-companions-decision-2026-10-03.md` 第七節）：
 * 違規原本只進 `console.error`、沒有計數，所以「這八個檢查過去有沒有報過」答不了。**dsh 沒有這個
 * 記錄**（它已把整套運行時不變量移除），這是我們自己加的；第二刀若選全部拿掉，這個檔案、
 * `InvariantTap` 與 `invariantTap` 選項一起拿掉。
 *
 * **兩種行都要有，缺一不可。** 只記違規的話，「零違規」與「檢查根本沒掛上」長得一模一樣
 * （[#668](https://github.com/DemianLi/nexus-agent/issues/668) 那一類缺陷）；`installed` 那一行
 * 是分母。
 *
 * **記錄壞了不能影響產品。** 寫不進去（唯讀的 home、磁碟滿了）只講一次、之後靜默——runner 那一頭
 * 也一律吞掉旁路的拋錯，所以這裡的 catch 是為了讓使用者知道量測失效了，不是為了保護 runner。
 *
 * **訊息只留前 {@link MAX_MESSAGE_CHARS} 個字元。** 違規訊息可能帶事件裡的片段；本機的會話
 * jsonl 本來就是原文，這裡不要多開一個完整的複本。
 *
 * 檔案 `0600`、目錄 `0700`，同會話日誌。不輪替、不清理：一行約 300 位元組、一個會話一行，要清就
 * 直接刪檔。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { InvariantTap } from '@nexus/core';

/** 違規訊息最多留幾個字元；超過的截斷並加 `…`。 */
export const MAX_MESSAGE_CHARS = 500;

/** 記錄格式的版本，換形狀時加一。 */
export const INVARIANT_LOG_VERSION = 1;

/** 一行記錄，兩種之一。 */
export type InvariantLogLine =
  | {
      readonly v: typeof INVARIANT_LOG_VERSION;
      readonly ts: string;
      readonly kind: 'installed';
      readonly sessionId: string;
      readonly packages: readonly string[];
    }
  | {
      readonly v: typeof INVARIANT_LOG_VERSION;
      readonly ts: string;
      readonly kind: 'violation';
      readonly sessionId: string;
      readonly package: string;
      readonly message: string;
    };

/**
 * 建一個寫到 `path` 的 tap。
 *
 * @param path - 記錄檔的絕對路徑（見 `harnessInvariantLogPath`）。目錄第一次寫入時才建。
 * @param options.now - 取時間，測試用；省略即系統時鐘。
 * @param options.warn - 寫不進去時講一次的去處；省略即 `console.warn`。
 */
export function createInvariantLog(
  path: string,
  options: { readonly now?: () => Date; readonly warn?: (message: string) => void } = {},
): InvariantTap {
  const now = options.now ?? (() => new Date());
  const warn = options.warn ?? ((message: string) => console.warn(message));
  let warned = false;

  const append = (line: InvariantLogLine): void => {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    } catch (error: unknown) {
      if (warned) return;
      warned = true;
      warn(`不變量記錄：寫不進 ${path}，之後的違規與裝上的清單不會留下紀錄——${String(error)}`);
    }
  };

  return {
    installed({ sessionId, packages }) {
      append({
        v: INVARIANT_LOG_VERSION,
        ts: now().toISOString(),
        kind: 'installed',
        sessionId,
        packages: [...packages].sort(),
      });
    },
    violation({ sessionId, packageName, message }) {
      append({
        v: INVARIANT_LOG_VERSION,
        ts: now().toISOString(),
        kind: 'violation',
        sessionId,
        package: packageName,
        message: truncate(message),
      });
    },
  };
}

function truncate(message: string): string {
  const chars = [...message];
  return chars.length <= MAX_MESSAGE_CHARS
    ? message
    : `${chars.slice(0, MAX_MESSAGE_CHARS).join('')}…`;
}
