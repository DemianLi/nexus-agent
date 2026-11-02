/**
 * 附件上傳的畫面狀態（[#733](https://github.com/DemianLi/nexus-agent/issues/733)）：每個草稿附件現在是未上傳、上傳中（進度）、
 * 還是已經上傳。**純 reducer**，上傳本身在 `lib/attachment-send.ts`，這裡只管卡片上畫什麼。
 *
 * 進度回呼的形狀照 dsh `file-upload`（`packages/client/file-upload/src/client/contract.ts`）：`{ loaded, total? }`，**`total` 可能沒有**
 * （瀏覽器不一定知道），沒有時畫不確定長度的進度條，不猜百分比。`loaded` 單調遞增：回頭的值（亂序、重送）丟掉，
 * 不讓進度條倒退；超過 `total` 的夾在 `total`。
 *
 * **只有一般檔案會上傳**：白名單內的圖內嵌在 `run.start` 裡（`attachment-send.ts`），不經上傳，所以卡片上沒有進度。
 *
 * **取消是整句取消**：收據一張只用一次、只在收下它的那條會話有效，這一句已經少了一個附件就送不出去了，所以按任何一張卡的取消
 * 都中止這一句裡還在跑的全部上傳，每張卡回到「未上傳」。重試就是再送一次——收據本來就要重傳（`attachment-send.ts`）。
 *
 * @module
 */

/** 一張卡現在的上傳狀態。沒有紀錄＝沒試過，畫法跟沒有這個功能時一樣。 */
export type UploadPhase =
  | {
      readonly kind: 'idle';
      /** 為什麼回到未上傳：取消了、或失敗了。沒試過的卡不會有紀錄。 */
      readonly reason: 'cancelled' | 'failed';
    }
  | { readonly kind: 'uploading'; readonly loaded: number; readonly total?: number }
  | { readonly kind: 'done' };

export type UploadStates = ReadonlyMap<string, UploadPhase>;

export const NO_UPLOADS: UploadStates = new Map();

export type UploadEvent =
  /** 這一句開始上傳這幾張。 */
  | { readonly type: 'start'; readonly ids: readonly string[] }
  | {
      readonly type: 'progress';
      readonly id: string;
      readonly loaded: number;
      readonly total?: number | undefined;
    }
  | { readonly type: 'done'; readonly id: string }
  /**
   * 這一句沒送成：還在上傳中或已上傳的卡回到未上傳，帶上原因（取消、上傳失敗）。**沒有原因**是上傳都成功了、
   * 是伺服器沒收下這一句（被拒）：卡片沒有哪裡出錯，清掉紀錄、照常畫。
   */
  | { readonly type: 'reset'; readonly reason?: 'cancelled' | 'failed' }
  /** 這些卡離開草稿了（送出成功被移掉）：不再留紀錄。 */
  | { readonly type: 'forget'; readonly ids: readonly string[] };

const isCount = (value: number): boolean => Number.isFinite(value) && value >= 0;

export function reduceUploads(states: UploadStates, event: UploadEvent): UploadStates {
  switch (event.type) {
    case 'start': {
      if (event.ids.length === 0) return states;
      const next = new Map(states);
      for (const id of event.ids) next.set(id, { kind: 'uploading', loaded: 0 });
      return next;
    }
    case 'progress': {
      const current = states.get(event.id);
      // 只有上傳中的卡收進度：完成、取消之後才到的回呼不能把卡片拉回上傳中。
      if (current?.kind !== 'uploading' || !isCount(event.loaded)) return states;
      const total =
        event.total !== undefined && isCount(event.total) && event.total > 0
          ? event.total
          : current.total;
      const loaded = Math.max(
        current.loaded,
        total === undefined ? event.loaded : Math.min(event.loaded, total),
      );
      if (loaded === current.loaded && total === current.total) return states;
      const next = new Map(states);
      next.set(event.id, { kind: 'uploading', loaded, ...(total === undefined ? {} : { total }) });
      return next;
    }
    case 'done': {
      if (states.get(event.id)?.kind !== 'uploading') return states;
      const next = new Map(states);
      next.set(event.id, { kind: 'done' });
      return next;
    }
    case 'reset': {
      let changed = false;
      const next = new Map(states);
      for (const [id, phase] of states) {
        if (phase.kind === 'idle') continue;
        if (event.reason === undefined) next.delete(id);
        else next.set(id, { kind: 'idle', reason: event.reason });
        changed = true;
      }
      return changed ? next : states;
    }
    case 'forget': {
      if (!event.ids.some((id) => states.has(id))) return states;
      const next = new Map(states);
      for (const id of event.ids) next.delete(id);
      return next;
    }
  }
}

/** 一張卡上要畫的字與進度條；`undefined` 是照常畫（沒試過）。 */
export interface UploadView {
  readonly phase: UploadPhase['kind'];
  /** 取代「副檔名 · 大小」那一行的字。 */
  readonly text: string;
  /** 0 到 100；`undefined` 是不確定長度（沒有 `total`）。只有上傳中才有進度條。 */
  readonly percent?: number | undefined;
}

export function uploadView(
  phase: UploadPhase | undefined,
  formatBytes: (bytes: number) => string,
): UploadView | undefined {
  if (phase === undefined) return undefined;
  switch (phase.kind) {
    case 'idle':
      return {
        phase: 'idle',
        text: phase.reason === 'cancelled' ? '未上傳（已取消）' : '未上傳（上傳失敗）',
      };
    case 'done':
      return { phase: 'done', text: '已上傳' };
    case 'uploading': {
      if (phase.total === undefined) {
        return {
          phase: 'uploading',
          text: phase.loaded === 0 ? '上傳中…' : `上傳中 ${formatBytes(phase.loaded)}`,
          percent: undefined,
        };
      }
      const percent = Math.min(100, Math.floor((phase.loaded / phase.total) * 100));
      return { phase: 'uploading', text: `上傳中 ${percent}%`, percent };
    }
  }
}
