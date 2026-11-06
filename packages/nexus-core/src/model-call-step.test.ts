import { describe, expect, it } from 'vitest';

import { modelCallStepOf, withModelCallStep, wrapModelCallFromStep } from './model-call-step.js';
import type { ModelCallStep } from './model-call-step.js';

describe('wrapModelCallFromStep', () => {
  it('handler 就是 next：改過的請求原樣交進去，結果原樣回來', () => {
    const seen: unknown[] = [];
    const wrap = wrapModelCallFromStep<{ n: number }, string>((request, next) =>
      next({ n: (request as { n: number }).n + 1 }),
    );
    expect(
      wrap({ n: 1 }, (request) => {
        seen.push(request);
        return 'ok';
      }),
    ).toBe('ok');
    expect(seen).toEqual([{ n: 2 }]);
  });

  it('next 可以叫好幾次，內層就跑好幾次；不叫就一次都不跑', () => {
    let calls = 0;
    const handler = () => (calls += 1);
    wrapModelCallFromStep((request, next) => {
      next(request);
      return next(request);
    })({}, handler);
    expect(calls).toBe(2);
    wrapModelCallFromStep(() => 'mine')({}, handler);
    expect(calls).toBe(2);
  });

  it('同步的一步同步回：中間沒有 await', () => {
    const result = wrapModelCallFromStep((request, next) => next(request))({}, () => 'now');
    expect(result).toBe('now');
  });
});

describe('withModelCallStep', () => {
  it('登記的就是造 wrapModelCall 的那一步；複製出來的物件查不到', () => {
    const step: ModelCallStep = (request, next) => next(request);
    const middleware = withModelCallStep(step, (wrapModelCall) => ({ name: 'm', wrapModelCall }));
    expect(modelCallStepOf(middleware)).toBe(step);
    expect(modelCallStepOf({ ...middleware })).toBeUndefined();
    expect(
      (middleware.wrapModelCall as (request: object, handler: () => string) => string)(
        {},
        () => 'inner',
      ),
    ).toBe('inner');
  });
});
