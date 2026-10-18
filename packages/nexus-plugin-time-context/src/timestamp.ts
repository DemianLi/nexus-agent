/**
 * 讀數裡那個時間戳的格式。逐字照 dsh `packages/context/time-context/src/timestamp.ts`（`687f282e`）：同一個格式器、同一個補 `GMT` 的規則。
 *
 * @module
 */

type TimestampPart = 'day' | 'hour' | 'minute' | 'month' | 'second' | 'timeZoneName' | 'year';

/**
 * 建出一則讀數用的格式器：固定的數字欄位加上 `longOffset` 的偏移。
 *
 * @param timeZone - 明指的顯示時區；省略就用行程的時區。
 * @returns 格式器。`timeZone` 不是合法的 IANA 名時拋 `RangeError`。
 */
export function createTimestampFormatter(timeZone?: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    ...(timeZone === undefined ? {} : { timeZone }),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  });
}

/**
 * 把毫秒時間戳格式成帶偏移與 IANA 時區的 ISO 形狀，例如 `2026-10-18T09:00:00+08:00[Asia/Taipei]`。
 *
 * @param now - 要顯示的 epoch 毫秒。
 * @param formatter - 針對 `timeZone` 建的格式器。
 * @param timeZone - 放在方括號裡的時區名。
 * @returns 時間戳文字。
 */
export function formatTimestamp(
  now: number,
  formatter: Intl.DateTimeFormat,
  timeZone: string,
): string {
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map((part) => [part.type, part.value]),
  ) as Record<TimestampPart, string>;
  const offset = parts.timeZoneName.replace(/^GMT$/u, 'GMT+00:00').slice(3);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}[${timeZone}]`;
}
