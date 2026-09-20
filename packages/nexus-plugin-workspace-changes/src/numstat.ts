/**
 * `git diff-tree --numstat -z` 的輸出解析。照 dsh `workspace-changes/src/numstat.ts`（`ddefc45`）逐條移植。
 *
 * @module
 */

/** 一筆 `--numstat` 紀錄；路徑一律斜線分隔、相對 repo 根。 */
export interface NumstatEntry {
  readonly path: string;
  /** 偵測到改名時，改名之前的路徑；沒改名的檔沒有這一格。 */
  readonly oldPath?: string;
  readonly added: number;
  readonly deleted: number;
  readonly binary: boolean;
}

/**
 * 解析以 NUL 結尾的 numstat 紀錄。改名的那一筆路徑是空的，後面接著舊路徑與新路徑。
 * @param output - `git diff-tree -r -M -z --numstat` 的完整 stdout。
 * @returns 照 git 輸出順序的紀錄。
 * @throws 有一筆壞掉時——那表示輸出被截斷了。
 */
export function parseNumstat(output: string): NumstatEntry[] {
  const queue = output.split('\0');
  if (queue.at(-1) !== '') throw new Error('numstat output is not NUL-terminated');
  queue.pop();
  const entries: NumstatEntry[] = [];
  while (queue.length > 0) {
    const record = queue.shift()!;
    // 只有前兩個 tab 是欄位分隔；檔名自己的 tab 照留。
    const first = record.indexOf('\t');
    const second = first < 0 ? -1 : record.indexOf('\t', first + 1);
    if (second < 0) throw new Error(`malformed numstat record: ${record}`);
    const added = record.slice(0, first);
    const deleted = record.slice(first + 1, second);
    let target = record.slice(second + 1);
    let oldPath: string | undefined;
    if (target === '') {
      oldPath = queue.shift();
      const renamed = queue.shift();
      if (oldPath === undefined || renamed === undefined) {
        throw new Error('malformed numstat rename record');
      }
      target = renamed;
    }
    const binary = added === '-';
    entries.push({
      path: target,
      ...(oldPath !== undefined && { oldPath }),
      added: binary ? 0 : Number(added),
      deleted: binary ? 0 : Number(deleted),
      binary,
    });
  }
  return entries;
}
