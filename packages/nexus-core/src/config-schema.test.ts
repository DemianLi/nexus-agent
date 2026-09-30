import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { configToJsonSchema } from './config-schema.js';

describe('configToJsonSchema', () => {
  it('沒有 Config：absent，欄位未知，不是禁止設定', () => {
    expect(configToJsonSchema(undefined)).toEqual({
      status: 'absent',
      schema: undefined,
      losses: [],
    });
  });

  it('普通的 strictObject：complete，輸入的形狀——有預設值的欄位不是必填，未知欄位不收，說明帶著', () => {
    const result = configToJsonSchema(
      z.strictObject({
        name: z.string().min(1).describe('名字'),
        retries: z.number().int().min(0).default(3),
        mode: z.enum(['a', 'b']).optional(),
      }),
    );
    expect(result.status).toBe('complete');
    expect(result.losses).toEqual([]);
    expect(result.schema).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, description: '名字' },
        // `.int()` 在 zod 裡帶安全整數的上界，照實輸出。
        retries: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 3 },
        mode: { type: 'string', enum: ['a', 'b'] },
      },
      required: ['name'],
      additionalProperties: false,
    });
    // 一份文件只在根上宣告一次 `$schema`，單顆的不帶。
    expect(result.schema).not.toHaveProperty('$schema');
  });

  it('內建的檢查（min／max／regex）轉得出來，不算不完整', () => {
    const result = configToJsonSchema(
      z.strictObject({ id: z.string().regex(/^[a-z]+$/), n: z.number().max(5) }),
    );
    expect(result.status).toBe('complete');
  });

  const cases: readonly [string, z.ZodType, string, readonly string[]][] = [
    ['refine', z.strictObject({ a: z.string().refine((v) => v.length > 1) }), 'refine', ['a']],
    [
      'superRefine',
      z.strictObject({ a: z.string().superRefine(() => undefined) }),
      'refine',
      ['a'],
    ],
    ['custom', z.strictObject({ a: z.custom<string>(() => true) }), 'custom', ['a']],
    ['transform', z.strictObject({ a: z.string().transform((v) => v.length) }), 'transform', ['a']],
    ['preprocess', z.strictObject({ a: z.preprocess((v) => v, z.string()) }), 'preprocess', ['a']],
    ['pipe', z.strictObject({ a: z.string().pipe(z.string().min(2)) }), 'pipe', ['a']],
    [
      '不分帶不帶檢查：不做任何事的 transform 也標',
      z.strictObject({ a: z.string().transform((v) => v) }),
      'transform',
      ['a'],
    ],
    ['根上的 refine', z.strictObject({ a: z.string() }).refine(() => true), 'refine', []],
    [
      '包在 optional／default／array／union 底下也找得到',
      z.strictObject({
        a: z
          .array(
            z.union([
              z.string(),
              z
                .string()
                .refine(() => true)
                .default('x'),
            ]),
          )
          .optional(),
      }),
      'refine',
      ['a', '[]'],
    ],
    [
      'record 的值',
      z.strictObject({
        a: z.record(
          z.string(),
          z.string().transform((v) => v),
        ),
      }),
      'transform',
      ['a', '{}'],
    ],
    ['函式型別', z.strictObject({ a: z.function() }), 'unrepresentable', ['a']],
  ];
  it.each(cases)('%s：partial，而且指名種類與位置', (_name, schema, kind, path) => {
    const result = configToJsonSchema(schema);
    expect(result.status).toBe('partial');
    expect(result.losses).toContainEqual({ kind, path });
    // partial 的輸出仍然是一份可用的文件。
    expect(result.schema).toBeDefined();
  });

  it('refine 只是被丟掉的檢查：輸出的 schema 比真正的驗證寬，所以一定要標', () => {
    const schema = z.strictObject({ a: z.string().refine((v) => v.length > 5) });
    // 對照組：zod 自己不會講。
    expect(z.toJSONSchema(schema, { io: 'input' })).not.toHaveProperty('properties.a.minLength');
    expect(configToJsonSchema(schema).status).toBe('partial');
  });

  it('每一處都報，不是只報第一處', () => {
    const result = configToJsonSchema(
      z.strictObject({
        a: z.string().refine(() => true),
        b: z.string().transform((v) => v),
        c: z.strictObject({ d: z.custom<number>(() => true) }),
      }),
    );
    expect(result.losses).toEqual([
      { kind: 'refine', path: ['a'] },
      { kind: 'transform', path: ['b'] },
      { kind: 'custom', path: ['c', 'd'] },
    ]);
  });

  it('自我參照（lazy）不會無窮遞迴', () => {
    type Node = { child?: Node | undefined; v: string };
    const node: z.ZodType<Node> = z.lazy(() =>
      z.strictObject({ child: node.optional(), v: z.string().refine(() => true) }),
    );
    const result = configToJsonSchema(z.strictObject({ root: node }));
    expect(result.status).toBe('partial');
    expect(result.losses.filter((loss) => loss.kind === 'refine')).toHaveLength(1);
  });
});
