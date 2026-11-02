import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ManifestError,
  REQUIRED_FIELDS,
  effectiveReload,
  isStrictObjectSchema,
  validateManifest,
} from './manifest.js';
import { widgetManifest } from './fixtures/registry.js';

type Loose = Record<string, unknown>;

/** 去掉巢狀路徑上的一格，不動原物件。 */
function without(path: string): Loose {
  const base = widgetManifest();
  const copy: Loose = { ...base, reload: { ...base.reload } };
  const keys = path.split('.');
  let target: Loose = copy;
  for (const key of keys.slice(0, -1)) target = target[key] as Loose;
  delete target[keys.at(-1) as string];
  return copy;
}

function rejection(raw: unknown, row = 'row-1'): ManifestError {
  try {
    validateManifest(raw, row);
  } catch (error) {
    if (error instanceof ManifestError) return error;
    throw error;
  }
  throw new Error('應該被拒收卻通過了');
}

describe('validateManifest（驗收 A）', () => {
  it('合格的 manifest 原樣通過', () => {
    const manifest = widgetManifest();
    expect(validateManifest(manifest, 'row-1')).toEqual(manifest);
  });

  it('provides、consumes、capabilities 可以是空陣列：echo 不提供任何服務也不要任何特權', () => {
    const manifest = widgetManifest({ consumes: [], provides: [], capabilities: [] });
    expect(() => validateManifest(manifest, 'row-1')).not.toThrow();
  });

  it.each(REQUIRED_FIELDS)('缺 %s：拒收，指名列 id 與缺的欄位', (field) => {
    const error = rejection(without(field), 'row-echo');
    expect(error.missing).toEqual([field]);
    expect(error.invalid).toEqual([]);
    expect(error.row).toBe('row-echo');
    expect(error.message).toContain('列 row-echo');
    expect(error.message).toContain(`缺少必填欄位 ${field}`);
  });

  it('缺 id 時還是指名那一列；讀得到 id 時一併指名插件', () => {
    expect(rejection(without('id'), 'row-x').message).toMatch(/^列 row-x的 manifest/);
    expect(rejection(without('owner'), 'row-x').message).toContain('（插件 widget-consumer）');
  });

  it('同時缺好幾格：一條錯誤全列出來', () => {
    const raw = without('owner') as Loose;
    delete raw.capabilities;
    expect(rejection(raw).missing).toEqual(['owner', 'capabilities']);
  });

  it('不是物件（模組根本沒匯出 manifest）：全部算缺，仍指名那一列', () => {
    const error = rejection(undefined, 'row-none');
    expect(error.missing).toEqual([...REQUIRED_FIELDS]);
    expect(error.row).toBe('row-none');
  });

  it('config 不是 strictObject：拒收（未知鍵讓載入失敗是登記過的偏離）', () => {
    const error = rejection({ ...widgetManifest(), config: z.object({ label: z.string() }) });
    expect(error.invalid.map((issue) => issue.field)).toEqual(['config']);
    expect(isStrictObjectSchema(z.object({}).catchall(z.string()))).toBe(false);
    expect(isStrictObjectSchema(z.strictObject({}))).toBe(true);
    expect(isStrictObjectSchema(z.object({}).strict())).toBe(true);
  });

  it('version、range 與 reload 的值不合格：指名欄位', () => {
    const base = widgetManifest() as unknown as Loose;
    expect(rejection({ ...base, version: 'v1' }).invalid[0]?.field).toBe('version');
    expect(
      rejection({ ...base, consumes: [{ token: 'widgets', range: 'not-a-range' }] }).invalid[0]
        ?.field,
    ).toBe('consumes.0.range');
    expect(
      rejection({ ...base, reload: { code: 'restart', config: 'hot' } }).invalid[0]?.field,
    ).toBe('reload.config');
  });

  it('不認得的欄位：拒收，不靜默放過', () => {
    const error = rejection({ ...widgetManifest(), reloadd: 'x' });
    expect(error.invalid).toEqual([{ field: 'reloadd', reason: '不認得的欄位' }]);
  });

  it("code: 'coexist'：拒收並指名那一列與原因", () => {
    const error = rejection(
      widgetManifest({ reload: { code: 'coexist', config: 'next-thread' } }),
      'row-coexist',
    );
    expect(error.invalid.map((issue) => issue.field)).toEqual(['reload.code']);
    expect(error.message).toContain('列 row-coexist');
    expect(error.message).toContain("'coexist' 還不放行");
  });

  it("code: 'coexist' 與別的欄位問題一起報，不是修一輪再撞一輪", () => {
    const error = rejection({
      ...widgetManifest({ reload: { code: 'coexist', config: 'next-thread' } }),
      reloadd: 'x',
    });
    expect(error.invalid.map((issue) => issue.field).sort()).toEqual(['reload.code', 'reloadd']);
  });
});

describe('effectiveReload：取兩邊較嚴的那個', () => {
  const lax = { code: 'coexist', config: 'next-thread' } as const;
  const strict = { code: 'restart', config: 'restart' } as const;

  it('宿主沒意見：就是 manifest', () => {
    expect(effectiveReload(lax)).toEqual(lax);
    expect(effectiveReload(strict, {})).toEqual(strict);
  });

  it('宿主較嚴：宿主贏（manifest 說下一條 thread，宿主起動期就讀掉了 → restart）', () => {
    expect(effectiveReload(lax, { config: 'restart' })).toEqual({
      code: 'coexist',
      config: 'restart',
    });
  });

  it('manifest 較嚴：manifest 贏，宿主不能把它放寬', () => {
    expect(effectiveReload(strict, { code: 'coexist', config: 'next-thread' })).toEqual(strict);
  });

  it('兩軸各自取較嚴，不互相影響', () => {
    expect(
      effectiveReload(
        { code: 'restart', config: 'next-thread' },
        { code: 'coexist', config: 'restart' },
      ),
    ).toEqual({ code: 'restart', config: 'restart' });
  });
});
