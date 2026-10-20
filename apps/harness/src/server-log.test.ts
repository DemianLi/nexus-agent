/**
 * 伺服器日誌的 exporter（[#1534](https://github.com/DemianLi/nexus-agent/issues/1534)）：門檻、等級名稱換算、一則一行 JSON、回放、
 * 樹上 dispose 拋的錯印得出來。接到 serve 的那一段（子行程、`--patch`）在 `serve-log-format.test.ts`。
 */

import { Context } from '@nexus/cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCordisRoot } from './cordis-root.js';
import {
  createServerLog,
  defaultLoggerConsoleConfig,
  LOG_LEVEL_NUMBERS,
  mountServerLog,
  resolveLevelNumbers,
} from './server-log.js';
import { LOG_LEVEL_NAMES, loggerConsoleConfigSchema } from './settings/logger-console.js';
import type { LoggerConsoleConfig } from './settings/logger-console.js';

function config(patch: Record<string, unknown> = {}): LoggerConsoleConfig {
  return loggerConsoleConfigSchema.parse(patch);
}

/** 四個等級各說一句。 */
function sayAll(logger: ReturnType<Context['logger']>): void {
  logger.error('e');
  logger.warn('w');
  logger.info('i');
  logger.debug('d');
}

function bodies(lines: readonly string[]): string[] {
  return lines.map((line) => line.replace(/^\[([EWID])\] \S+ /u, '$1:'));
}

describe('等級名稱換算：名稱 → vendor 的數字，對著 vendor 實際的門檻行為釘住', () => {
  it('表上的順序是上游 rc.11 的 ERROR 0、WARN 1、INFO 2、DEBUG 3', () => {
    expect(LOG_LEVEL_NUMBERS).toEqual({ error: 0, warn: 1, info: 2, debug: 3 });
    expect(Object.keys(LOG_LEVEL_NUMBERS)).toEqual([...LOG_LEVEL_NAMES]);
  });

  it.each([
    ['error', ['E:e']],
    ['warn', ['E:e', 'W:w']],
    ['info', ['E:e', 'W:w', 'I:i']],
    ['debug', ['E:e', 'W:w', 'I:i', 'D:d']],
  ] as const)('levels.default 設成 %s：vendor 的 logger 只交來這幾則', (level, expected) => {
    const ctx = new Context();
    const lines: string[] = [];
    mountServerLog(ctx, config({ levels: { default: level }, showTime: '' }), (line) =>
      lines.push(line),
    );
    sayAll(ctx.logger('probe'));
    expect(bodies(lines)).toEqual(expected);
  });

  it('單獨寫的 logger 名蓋過 default', () => {
    const ctx = new Context();
    const lines: string[] = [];
    mountServerLog(
      ctx,
      config({ levels: { default: 'warn', quiet: 'error', chatty: 'debug' }, showTime: '' }),
      (line) => lines.push(line),
    );
    sayAll(ctx.logger('quiet'));
    sayAll(ctx.logger('chatty'));
    sayAll(ctx.logger('other'));
    expect(bodies(lines)).toEqual(['E:e', 'E:e', 'W:w', 'I:i', 'D:d', 'E:e', 'W:w']);
  });

  it('不寫門檻就是 info（出廠）', () => {
    expect(defaultLoggerConsoleConfig().levels).toEqual({ default: 'info' });
    expect(resolveLevelNumbers({ default: 'info', x: 'debug' })).toEqual({ default: 2, x: 3 });
  });
});

describe('format: json：一則一行', () => {
  let ctx: Context;
  let lines: string[];
  beforeEach(() => {
    ctx = new Context();
    lines = [];
    mountServerLog(ctx, config({ format: 'json' }), (line) => lines.push(line));
  });

  it('含換行的訊息只多一行，JSON.parse 得動，msg 保有換行，level／ts／logger 都在', () => {
    ctx.logger('serve').warn('警告：1 列沒有掛上\n  todo（@nexus/plugin-todo）設定驗不過');
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      level: 'warn',
      logger: 'serve',
      msg: '警告：1 列沒有掛上\n  todo（@nexus/plugin-todo）設定驗不過',
    });
    expect(new Date(parsed['ts'] as string).toISOString()).toBe(parsed['ts']);
    expect(Object.keys(parsed).sort()).toEqual(['level', 'logger', 'msg', 'ts']);
  });

  it('錯誤物件放 stack 或 message，格式化 %s 與物件參數照 Logger.format', () => {
    ctx.logger('serve').error(new Error('boom'));
    ctx.logger('serve').info('thread %s 好了 %o', 'a', { n: 1 });
    const [first, second] = lines.map((line) => JSON.parse(line) as { msg: string; level: string });
    expect(first?.level).toBe('error');
    expect(first?.msg).toContain('boom');
    expect(second?.msg).toBe('thread a 好了 { n: 1 }');
  });

  it('帶 thread_id 的訊息多一格 thread_id（欄位先留好，填法由 #1536 決定）', () => {
    const logger = ctx.logger('serve');
    (logger as unknown as { meta: Record<string, unknown> }).meta = {
      ...(logger as unknown as { meta: Record<string, unknown> }).meta,
      thread_id: 't-1',
    };
    logger.info('hi');
    expect(JSON.parse(lines[0] as string)).toMatchObject({ thread_id: 't-1' });
  });

  it('JSON 一律不上色，即使 colors 設了', () => {
    const colored = new Context();
    const out: string[] = [];
    mountServerLog(colored, config({ format: 'json', colors: 3 }), (line) => out.push(line));
    colored.logger('serve').info('%C 好', '名字');
    expect(out[0]).not.toContain('\u001b');
    expect(JSON.parse(out[0] as string)).toMatchObject({ msg: '名字 好' });
  });

  it('maxLength 對 msg 每一行截斷，行尾接 ...', () => {
    const small = new Context();
    const out: string[] = [];
    mountServerLog(small, config({ format: 'json', maxLength: 5 }), (line) => out.push(line));
    small.logger('serve').info('123456789\nab');
    expect(JSON.parse(out[0] as string)).toMatchObject({ msg: '12345...\nab' });
  });
});

describe('format: text：照 dsh 的 render', () => {
  it('預設有時間前綴，showTime 設成空字串就沒有；多行訊息的續行縮排對齊', () => {
    const ctx = new Context();
    const lines: string[] = [];
    mountServerLog(ctx, config({ showTime: '' }), (line) => lines.push(line));
    ctx.logger('serve').warn('第一行\n第二行');
    expect(lines).toEqual(['[W] serve 第一行\n    第二行']);
    const timed = new Context();
    const out: string[] = [];
    mountServerLog(timed, config(), (line) => out.push(line));
    timed.logger('serve').info('好');
    expect(out[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[I\] serve 好$/u);
  });
});

describe('回放：exporter 晚掛上，之前記的話照樣印出來', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('掛上之前記的 warn 在掛上之後印出來；低於門檻的不印；只印一次', () => {
    const ctx = new Context();
    ctx.logger('serve').warn('先講的警告');
    ctx.logger('serve').info('先講的披露');
    const lines: string[] = [];
    mountServerLog(ctx, config({ levels: { default: 'warn' }, showTime: '' }), (line) =>
      lines.push(line),
    );
    ctx.logger('serve').warn('後講的警告');
    expect(bodies(lines)).toEqual(['W:先講的警告', 'W:後講的警告']);
  });

  it('回放的時間前綴是那則話當時的時間，不是回放的當下', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 2, 3, 4, 5));
    const ctx = new Context();
    ctx.logger('serve').warn('早先的話');
    vi.setSystemTime(new Date(2026, 5, 6, 7, 8, 9));
    const lines: string[] = [];
    mountServerLog(ctx, config(), (line) => lines.push(line));
    expect(lines).toEqual(['2026-01-02 03:04:05 [W] serve 早先的話']);
  });

  it('createServerLog：mount 只有第一次有效，之後的 mount／mountDefault 不會讓同一則印兩次', () => {
    const ctx = new Context();
    const lines: string[] = [];
    const serverLog = createServerLog(ctx, (line) => lines.push(line));
    serverLog.serve.warn('一則');
    serverLog.mount(config({ showTime: '' }));
    serverLog.mount(config({ format: 'json' }));
    serverLog.mountDefault();
    serverLog.serve.warn('兩則');
    expect(bodies(lines)).toEqual(['W:一則', 'W:兩則']);
  });

  it('mountDefault：還沒讀到設定就起不來時，緩衝裡的話用出廠設定印出來', () => {
    const ctx = new Context();
    const lines: string[] = [];
    const serverLog = createServerLog(ctx, (line) => lines.push(line));
    serverLog.serve.info('代理：…');
    serverLog.mountDefault();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\[I\] serve 代理：…$/u);
  });
});

describe('Cordis 樹上的錯誤印得出來', () => {
  it('樹上插件的 disposer 拋 Error("dispose probe")，根卸載之後有一行 error 等級帶它', async () => {
    const root = createCordisRoot();
    const ctx = await root.tree.context();
    const lines: string[] = [];
    const serverLog = createServerLog(ctx, (line) => lines.push(line));
    serverLog.mount(config({ levels: { default: 'warn' }, showTime: '' }));
    ctx.plugin(function probe(inner: Context) {
      inner.effect(() => () => {
        throw new Error('dispose probe');
      });
    });
    await ctx.loader.await();
    await root.dispose();
    const errors = lines.filter((line) => line.startsWith('[E] '));
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.join('\n')).toContain('dispose probe');
  });
});

describe('測試用的前綴剝除 serverLogBody（fixtures.ts）', () => {
  it('多行訊息：續行縮排算「時間＋[X]＋空格」，不含名字', async () => {
    const { serverLogBody } = await import('./fixtures.js');
    const ctx = new Context();
    const lines: string[] = [];
    mountServerLog(ctx, config(), (line) => lines.push(line));
    ctx.logger('serve').warn('第一行\n第二行\n第三行');
    expect(serverLogBody(lines[0] as string)).toBe('第一行\n第二行\n第三行');
    expect(serverLogBody('不是日誌的行')).toBe('不是日誌的行');
  });
});
