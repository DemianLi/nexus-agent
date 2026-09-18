/**
 * 一條 thread 的評分在畫面這一側的狀態（[#382](https://github.com/DemianLi/nexus-agent/issues/382)）。
 *
 * 照 dsh 的 `MessageFeedbackController`（`packages/client/ui-message-feedback/src/client/controller.ts`，
 * `ddefc45`）：
 *
 * - **讀一次餵滿整個會話**：`list` 只在第一次需要時讀（{@link RatingsController.ensure}），畫面把它掛在讚踩的
 *   第一次滑過或聚焦上，不在載入時讀。所以重新整理之後、滑過去之前，讚踩是空心的。
 * - **修改逐筆排隊**：每一次修改都拿「前一次修改落定之後」的版本去比，兩次連點不會拿同一個舊版本各送一次。
 * - **重連時的重讀也排在修改後面**（{@link RatingsController.resync}）：不排的話，一份在修改之前發出、
 *   之後才回來的清單會把剛寫進去的版本蓋回舊的。
 */

import type {
  FeedbackOutcome,
  FeedbackDeleteCommand,
  FeedbackDeleteResult,
  FeedbackListResult,
  FeedbackPutCommand,
  FeedbackPutResult,
  WireFeedbackCategory,
  WireFeedbackItem,
  WireFeedbackRating,
} from '@nexus/wire';

import { FEEDBACK_COPY, failureCopy } from '@/lib/feedback';

/** `list` 那一次讀的狀態。 */
export type RatingsStatus = 'cold' | 'loading' | 'ready' | 'failed';

export interface RatingsView {
  readonly status: RatingsStatus;
  /** 訊息 id → 目前那一筆。 */
  readonly items: ReadonlyMap<string, WireFeedbackItem>;
}

/** 一次操作的結果。失敗時帶畫面上要講的那句話。 */
export type RatingsResult =
  { readonly ok: true } | { readonly ok: false; readonly failure: string };

/** 這條 thread 的三個回饋 method。 */
export interface RatingsRemote {
  list(): Promise<FeedbackOutcome<FeedbackListResult>>;
  put(params: FeedbackPutCommand['params']): Promise<FeedbackOutcome<FeedbackPutResult>>;
  delete(params: FeedbackDeleteCommand['params']): Promise<FeedbackOutcome<FeedbackDeleteResult>>;
}

const OK: RatingsResult = { ok: true };

function failed(failure: string): RatingsResult {
  return { ok: false, failure };
}

/** 線收不下（`rejected`）或根本沒送到（拋了）：講通用那句，後面接原因。 */
function carrierFailure(reason: unknown): RatingsResult {
  const message = reason instanceof Error ? reason.message : String(reason);
  return failed(`${FEEDBACK_COPY.generic}：${message}`);
}

export class RatingsController {
  #view: RatingsView = { status: 'cold', items: new Map() };
  #loading: Promise<RatingsResult> | null = null;
  /** 上一次修改落定的那一刻。**永遠不 reject**：每一次操作都把失敗收成 {@link RatingsResult}。 */
  #tail: Promise<unknown> = Promise.resolve();

  /**
   * @param remote - 這條 thread 的回饋 method。
   * @param onChange - 狀態換了就叫，畫面據它重畫。
   */
  constructor(
    private readonly remote: RatingsRemote,
    private readonly onChange: (view: RatingsView) => void,
  ) {}

  get view(): RatingsView {
    return this.#view;
  }

  /** 讀過了就不再讀；讀失敗的下次再試。 */
  ensure(): Promise<RatingsResult> {
    if (this.#view.status === 'ready') return Promise.resolve(OK);
    return this.refresh();
  }

  /**
   * 重讀一次，同時來的共用同一次。**不排隊**：只給還沒讀過時用，那時不會有修改在路上
   * （修改都先 {@link ensure}）。重連要用 {@link resync}。
   */
  refresh(): Promise<RatingsResult> {
    if (this.#loading !== null) return this.#loading;
    this.#publish({ status: 'loading', items: this.#view.items });
    const pending = this.#load().finally(() => {
      this.#loading = null;
    });
    this.#loading = pending;
    return pending;
  }

  /** 重連之後重讀，**排在路上的修改後面**。 */
  resync(): Promise<RatingsResult> {
    return this.#mutate(() => this.refresh(), false);
  }

  /** 新建或換掉一則回覆的評分，拿目前看到的版本去比；衝突的話畫上目前那筆。 */
  rate(
    messageId: string,
    rating: WireFeedbackRating,
    entry: { readonly note?: string; readonly category?: WireFeedbackCategory } = {},
  ): Promise<RatingsResult> {
    return this.#mutate(async () => {
      const outcome = await this.remote.put({
        messageId,
        rating,
        ...entry,
        ifVersion: this.#view.items.get(messageId)?.version ?? null,
      });
      if (outcome.kind === 'rejected') return carrierFailure(outcome.message);
      if (outcome.result.ok) {
        this.#commit(messageId, outcome.result.value);
        return OK;
      }
      const { error } = outcome.result;
      if (error.code === 'version-conflict') this.#commit(messageId, error.current);
      return failed(failureCopy(error.code));
    });
  }

  /**
   * 收回一則回覆的那個評分。**排到了才重看一次**：前面的操作已經改掉或收掉它的話就什麼都不做，
   * 舊的收回不會變成別的東西。
   */
  retract(messageId: string, rating: WireFeedbackRating): Promise<RatingsResult> {
    return this.#mutate(async () => {
      const observed = this.#view.items.get(messageId);
      if (observed?.rating !== rating) return OK;
      const outcome = await this.remote.delete({ messageId, ifVersion: observed.version });
      if (outcome.kind === 'rejected') return carrierFailure(outcome.message);
      if (outcome.result.ok) {
        this.#commit(messageId, null);
        return OK;
      }
      const { error } = outcome.result;
      if (error.code === 'version-conflict') this.#commit(messageId, error.current);
      return failed(failureCopy(error.code));
    });
  }

  async #load(): Promise<RatingsResult> {
    let outcome: FeedbackOutcome<FeedbackListResult>;
    try {
      outcome = await this.remote.list();
    } catch (error) {
      this.#publish({ status: 'failed', items: this.#view.items });
      return carrierFailure(error);
    }
    if (outcome.kind === 'rejected') {
      this.#publish({ status: 'failed', items: this.#view.items });
      return carrierFailure(outcome.message);
    }
    const items = new Map<string, WireFeedbackItem>();
    for (const item of outcome.result.value.items) items.set(item.messageId, item);
    this.#publish({ status: 'ready', items });
    return OK;
  }

  #mutate(operation: () => Promise<RatingsResult>, seed = true): Promise<RatingsResult> {
    const guarded = async (): Promise<RatingsResult> => {
      try {
        if (seed) {
          const loaded = await this.ensure();
          if (!loaded.ok) return loaded;
        }
        return await operation();
      } catch (error) {
        return carrierFailure(error);
      }
    };
    const result = this.#tail.then(guarded, guarded);
    this.#tail = result;
    return result;
  }

  #commit(messageId: string, item: WireFeedbackItem | null): void {
    const items = new Map(this.#view.items);
    if (item === null) items.delete(messageId);
    else items.set(messageId, item);
    this.#publish({ status: 'ready', items });
  }

  #publish(view: RatingsView): void {
    this.#view = view;
    this.onChange(view);
  }
}
