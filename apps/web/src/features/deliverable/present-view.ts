/**
 * `present` 那張工具卡要知道的事（[#441](https://github.com/DemianLi/nexus-agent/issues/441) 第一刀）：模型宣告交付了哪幾個檔案。
 *
 * **只讀呼叫參數**，照 dsh `PresentRow`（`packages/client/ui-deliverables/src/client/PresentRow.tsx` 的 `fileNames`，
 * `ddefc45`）：參數形狀照 dsh `tool-present`，`{ files: [{ path, description? }] }`。工具卡畫的是「這顆呼叫說了什麼」；
 * **交付了沒有**要看結果——那是這一輪尾端的交付卡片，資料走 harness 只在成功時送的事件（#441 第二刀），不從這裡推。
 *
 * @module
 */

/** 模型看到的工具名（dsh `tool-present` 的 `name: 'present'`）。 */
export const PRESENT = 'present';

/** 一個宣告交付的檔案。路徑照模型給的原樣（相對路徑以工作目錄為準），不在前端解析。 */
export interface PresentedFile {
  readonly path: string;
  readonly description?: string;
}

/**
 * 呼叫參數裡的檔案。解不開或形狀不對就是 `undefined`，卡片退回參數原文——串流中途的參數是半截 JSON，
 * 照 dsh 在呼叫收完之前原文照樣看得到。路徑空白的那幾個略過（dsh 的工具本體會拒絕它們）。
 */
export function presentedFilesOf(input: string): PresentedFile[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return undefined;
  }
  const files = (parsed as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) return undefined;
  return files.flatMap((raw: unknown) => {
    const file = raw as { path?: unknown; description?: unknown } | null;
    if (typeof file?.path !== 'string' || file.path.trim() === '') return [];
    return [
      {
        path: file.path,
        ...(typeof file.description === 'string' && file.description.trim() !== ''
          ? { description: file.description }
          : {}),
      },
    ];
  });
}

/** 路徑最後一段：一眼認得出是哪個檔（照 dsh `presented.ts` 的 `basename`，兩種分隔符都認）。 */
export function basename(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return at === -1 ? path : path.slice(at + 1);
}

/** 收著時那一行：檔名接起來；多於一個時補總數。 */
export function presentSummary(files: readonly PresentedFile[]): string {
  if (files.length === 0) return '沒有檔案';
  const names = files.map((file) => basename(file.path)).join('、');
  return files.length > 1 ? `${names}（共 ${files.length} 個）` : names;
}
