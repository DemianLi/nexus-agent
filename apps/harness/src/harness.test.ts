import { describe, expect, it } from 'vitest';
import { createHarness, type Step } from './harness.js';

const append = (value: string): Step<string[]> => ({
  name: `append:${value}`,
  run: (context) => [...context, value],
});

describe('createHarness', () => {
  it('依序執行 step 並串接 context', async () => {
    const harness = createHarness([append('a'), append('b')]);

    const result = await harness.run([]);

    expect(result.context).toEqual(['a', 'b']);
    expect(result.executed).toEqual(['append:a', 'append:b']);
  });

  it('沒有 step 時回傳原始 context', async () => {
    const result = await createHarness<string[]>([]).run(['unchanged']);

    expect(result.context).toEqual(['unchanged']);
    expect(result.executed).toEqual([]);
  });

  it('step 失敗時標示是哪一個 step', async () => {
    const boom: Step<string[]> = {
      name: 'boom',
      run: () => {
        throw new Error('原始錯誤');
      },
    };

    await expect(createHarness([append('a'), boom]).run([])).rejects.toThrow(
      'step "boom" 執行失敗',
    );
  });
});
