export interface Step<TContext> {
  readonly name: string;
  run(context: TContext): Promise<TContext> | TContext;
}

export interface RunResult<TContext> {
  readonly context: TContext;
  readonly executed: readonly string[];
}

/**
 * 依序執行一連串 step，把 context 從上一個 step 傳到下一個。
 * 任何 step 拋錯就中止，並在錯誤訊息中標示是哪一個 step。
 */
export function createHarness<TContext>(steps: readonly Step<TContext>[]) {
  return {
    async run(initial: TContext): Promise<RunResult<TContext>> {
      const executed: string[] = [];
      let context = initial;

      for (const step of steps) {
        try {
          context = await step.run(context);
        } catch (cause) {
          throw new Error(`step "${step.name}" 執行失敗`, { cause });
        }
        executed.push(step.name);
      }

      return { context, executed };
    },
  };
}
