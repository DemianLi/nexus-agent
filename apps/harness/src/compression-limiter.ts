/**
 * 圖片轉碼的併發上限（[#2033](https://github.com/DemianLi/nexus-agent/issues/2033)）。一台主機多人共用，同時湧進來的圖
 * 不能把 CPU 全拿去解碼與編碼，所以一份 `AttachmentStore` 一個限流器，超過上限的排隊。
 *
 * 先進先出；任務落定（成功或失敗）才放出名額、叫醒下一個；不是 `Error` 的拒絕包成 `Error`（{@link compressionFailure}）。
 *
 * @module
 */

/**
 * 保留 `Error` 原樣，把原生綁定拋出的非 `Error` 值包起來。
 *
 * @param reason - 轉碼任務拒絕的值。
 */
export function compressionFailure(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error('圖片轉碼的任務以非 Error 的值拒絕', { cause: reason });
}

/** 非同步轉碼工作的先進先出限流器。 */
export class CompressionLimiter {
  #active = 0;
  readonly #waiting: (() => void)[] = [];

  /** @param concurrency - 同時進行的任務上限，正整數。 */
  constructor(readonly concurrency: number) {}

  /** 現在正在跑的任務數（測試量峰值用）。 */
  get active(): number {
    return this.#active;
  }

  /**
   * 等到有名額再跑一個任務；任務落定之前一直佔著那個名額。
   *
   * @param task - 轉碼工作。
   * @returns 任務的結果。
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        this.#active += 1;
        const release = (): void => {
          this.#active -= 1;
          this.#waiting.shift()?.();
        };
        void Promise.resolve()
          .then(task)
          .then(
            (value) => {
              release();
              resolve(value);
            },
            (error: unknown) => {
              release();
              reject(compressionFailure(error));
            },
          );
      };
      if (this.#active < this.concurrency) start();
      else this.#waiting.push(start);
    });
  }
}
