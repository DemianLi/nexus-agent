/**
 * 「從日誌推回的歷史」對「實際送給模型的請求」的比對（#1299，承 #1159 的探針；量法與判定見
 * `log-derived-history.fixture.ts` 檔頭）。
 *
 * **這份測試的用途是 S2 的驗收工具，不是守現狀。** 今天兩邊有幾類差異（地圖 [#1298](https://github.com/DemianLi/nexus-agent/issues/1298)
 * 的 #1300–#1303）。它們列在各場景傳給 `expectDerivedHistory` 的已知差異清單裡，每一類對應一張卡（{@link CARD_OF}）；斷言是**觀察到的差異集合與那份清單
 * 完全相等**，兩個方向都會紅：
 *
 * - 某張卡修好了 → 那一格不再有差異 → 紅，訊息會點名要刪哪一條、是哪張卡。
 * - 冒出新的差異，或同一格換了一種 → 紅，附上第一個不同的位置與兩邊的樣子。
 *
 * 比對器本身被這些突變守住（#1299 實測，改壞夾具後各自會紅哪些）：
 *
 * - 分類一律回「沒有差異」：所有帶差異種類的場景（S8、S9、SH3、SH4、SV5、SV6）。S6 只列推導方式、不列種類，這個突變碰不到它。
 * - 分類一律回「有差異」：兩個對照場景與全部已知差異場景。
 * - 不偵測摘要事件的順序：S6、S8、SH3、SH4、SV6（有 `summary-after-reply` 的那幾個）。
 * - 重放時把系統訊息改一個字：所有場景（系統訊息相符的斷言）。
 * - SR2 比的是「重啟 vs 不重啟」，不經過比對器，上面四個突變碰不到它；它另有自己的前提斷言與突變（讓重啟那邊拿錯一次呼叫去比）。
 *
 * **SR2 有循環性**（同 `.docs/log-derived-history-vs-wire-2026-10-08.md` §二 對 SR1、SR3 的說明）：續接是從日誌推出歷史再灌回
 * LangGraph 狀態，之後每次請求剪刀與截斷照舊在請求端再套一次，所以它證明的是「今天重啟不改變請求」，不是「歷史可由日誌單獨推出」。
 * 不要把它當成推導的證據。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createEchoPlugin } from '@nexus/plugin-echo';
import type { SessionEvent } from '@nexus/core';

import {
  classify,
  compareToLog,
  LOW_SUMMARIZATION,
  mainOnly,
  PRUNE_MARKER,
  runAssembly,
  runServePhases,
  runShippedCli,
  stripModelName,
  systemText,
  TRUNCATE_MARKER,
} from './log-derived-history.fixture.js';
import type {
  Body,
  Derivation,
  DifferenceKind,
  Reply,
  Run,
  Script,
  Verdict,
} from './log-derived-history.fixture.js';

/** 每一類差異由哪張卡負責。`other` 沒有卡：出現就是新問題。 */
const CARD_OF: Readonly<Record<DifferenceKind | 'summary-after-reply', string>> = {
  prune: '#1302（工具結果剪刀進日誌）',
  truncate: '#1303（舊工具參數截斷進日誌）',
  'empty-assistant': '#1300（推導時丟掉空的助手訊息）',
  'summary-after-reply': '#1301（摘要事件排在用到它的呼叫之前）',
  other: '（沒有對應的卡——新問題）',
};

/** 一格已知差異。`derivation` 預設 `before-start`，`kinds` 預設沒有。 */
interface Known {
  readonly call: number;
  readonly derivation?: Derivation;
  readonly kinds?: readonly DifferenceKind[];
}

/** 觀察到的、不是「逐位元組相同且用預設推導」的那些格，形狀同 {@link Known}。 */
const observedOf = (verdicts: readonly Verdict[]): Known[] =>
  verdicts
    .filter((v) => v.kinds.length > 0 || v.derivation !== 'before-start')
    .map((v) => ({
      call: v.call,
      ...(v.derivation !== 'before-start' && { derivation: v.derivation }),
      ...(v.kinds.length > 0 && { kinds: v.kinds }),
    }));

const explain = (verdicts: readonly Verdict[]): string => {
  const lines = verdicts
    .filter((v) => v.kinds.length > 0 || v.derivation !== 'before-start' || !v.systemMatches)
    .map(
      (v) =>
        `呼叫 ${String(v.call)}：推導=${v.derivation} 種類=[${v.kinds.join(',')}] 系統訊息${v.systemMatches ? '相符' : '不符'}` +
        (v.detail === undefined ? '' : `\n  ${v.detail}`),
    );
  const cards = new Set<string>();
  for (const v of verdicts) {
    for (const kind of v.kinds) cards.add(CARD_OF[kind]);
    if (v.derivation === 'summary-after-reply') cards.add(CARD_OF['summary-after-reply']);
  }
  return `\n${lines.join('\n')}\n對應的卡：${[...cards].join('；') || '無'}`;
};

/**
 * 斷言一個場景：每一次主呼叫的系統訊息都相符，而且差異集合恰等於 `known`。
 *
 * @param name - 場景名，給訊息用。
 * @param run - 跑完的結果。
 * @param known - 已知差異；沒有就是預期逐位元組相同。
 * @returns 全部判定，讓呼叫端再做場景特有的檢查。
 */
async function expectDerivedHistory(
  name: string,
  run: Run,
  known: readonly Known[],
  minCalls: number,
): Promise<Verdict[]> {
  const verdicts = await compareToLog(run.events, run.mainBodies);
  // 比的呼叫數太少代表場景沒跑成預期的樣子（例如工具根本沒被叫），不是「沒有差異」。
  expect(verdicts.length, `${name}：主呼叫數`).toBeGreaterThanOrEqual(minCalls);
  expect(
    verdicts.filter((v) => !v.systemMatches).map((v) => v.call),
    `${name}：系統訊息與日誌 request/system 不符的呼叫${explain(verdicts)}`,
  ).toEqual([]);
  expect(observedOf(verdicts), `${name}：已知差異清單與觀察不一致${explain(verdicts)}`).toEqual(
    known,
  );
  return verdicts;
}

const big = (char: string, n: number) => char.repeat(n);
const echoCall = (id: string, message: string): Reply => ({
  tools: [{ id, name: 'echo', args: { message } }],
});
const writeCall = (id: string): Reply => ({
  tools: [{ id, name: 'write_file', args: { file_path: '/a.txt', content: big('abc', 2_000) } }],
});

beforeAll(() => {
  // runCli／runServe 的 `--live` 要有金鑰才肯組模型；端點是本機假的，這顆不會送到任何地方。
  vi.stubEnv('NVIDIA_API_KEY', 'nvapi-fake-for-log-derived-history');
});
afterAll(() => {
  vi.unstubAllEnvs();
});

describe('比對器本身', () => {
  const msg = (role: string, content: unknown, extra: object = {}) => ({ role, content, ...extra });

  it('逐位元組相同 → 沒有種類', () => {
    const wire = [msg('user', '嗨'), msg('assistant', '好。')];
    expect(classify(wire, wire)).toEqual({ kinds: [] });
  });

  it('線上的工具結果帶剪除標記、推導是全文 → prune，並附上不同的位置', () => {
    const actual = [msg('user', '嗨'), msg('tool', `頭${PRUNE_MARKER}尾`, { tool_call_id: 'c1' })];
    const derived = [msg('user', '嗨'), msg('tool', '頭中段尾', { tool_call_id: 'c1' })];
    const verdict = classify(actual, derived);
    expect(verdict.kinds).toEqual(['prune']);
    expect(verdict.detail).toContain('第 1 則');
  });

  it('線上的助手訊息帶截斷標記 → truncate', () => {
    const call = (args: string) => ({
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'write_file', arguments: args } },
      ],
    });
    const actual = [msg('assistant', null, call(`{"content":"a...(${TRUNCATE_MARKER})"}`))];
    const derived = [msg('assistant', null, call('{"content":"abcabc"}'))];
    expect(classify(actual, derived).kinds).toEqual(['truncate']);
  });

  it('推導多出一則空的助手訊息 → empty-assistant，且不把後面每一格都算成別的差異', () => {
    const actual = [msg('user', '嗨'), msg('user', '再來')];
    const derived = [msg('user', '嗨'), msg('assistant', ''), msg('user', '再來')];
    expect(classify(actual, derived)).toEqual({ kinds: ['empty-assistant'] });
  });

  it('其他任何不同 → other（沒有卡的新問題）', () => {
    expect(classify([msg('user', '甲')], [msg('user', '乙')]).kinds).toEqual(['other']);
  });

  it('助手訊息的 name: "model" 與系統訊息的區塊邊界被正規化，其他欄位不動', () => {
    expect(stripModelName(msg('assistant', '好。', { name: 'model' }))).toEqual(
      msg('assistant', '好。'),
    );
    expect(stripModelName(msg('assistant', '好。', { name: 'other' }))).toEqual(
      msg('assistant', '好。', { name: 'other' }),
    );
    expect(systemText([{ text: '甲' }, { text: '乙' }])).toBe('甲乙');
    expect(systemText('甲乙')).toBe('甲乙');
  });

  it('主呼叫數對不上 model/start 數 → 拋，不默默少比', async () => {
    const start = { seq: 1, type: 'model/start', data: {} } as unknown as SessionEvent;
    await expect(compareToLog([start], [])).rejects.toThrow('對不上');
  });
});

describe('對照場景：預期逐位元組相同', () => {
  it('組裝點，單一工具呼叫（非串流）', async () => {
    const script: Script = (i) => (i === 0 ? echoCall('call_a', '嗨') : {});
    const run = await runAssembly('叫工具\n再說\n/exit\n', script, [createEchoPlugin()]);
    await expectDerivedHistory('C1', run, [], 2);
  }, 60_000);

  it('serve，同一輪併發兩個工具呼叫（串流）', async () => {
    const run = await runServePhases(
      [['併發', '再問']],
      mainOnly((k) =>
        k === 0
          ? {
              tools: [
                { id: 'call_a', name: 'echo', args: { message: 'A' } },
                { id: 'call_b', name: 'echo', args: { message: 'B' } },
              ],
            }
          : {},
      ),
    );
    await expectDerivedHistory('C2', run, [], 3);
  }, 90_000);
});

describe('已知差異：每一類對應一張卡', () => {
  it('S6 壓縮摘要（#1301）', async () => {
    const script: Script = (i, body) => {
      if ((body.tools?.length ?? 0) === 0) return { content: '【摘要】之前聊了很多。' };
      return i === 1 ? echoCall('call_mid', big('中', 20_000)) : {};
    };
    const run = await runAssembly(
      '一\n二\n三\n四\n五\n六\n七\n/exit\n',
      script,
      [createEchoPlugin()],
      {
        trigger: [{ type: 'messages', value: 8 }],
        keep: { type: 'messages', value: 2 },
      },
    );
    expect(run.events.filter((e) => e.type === 'compaction/summary').length).toBeGreaterThan(0);
    await expectDerivedHistory(
      'S6',
      run,
      [
        { call: 4, derivation: 'summary-after-reply' },
        { call: 7, derivation: 'summary-after-reply' },
      ],
      7,
    );
  }, 90_000);

  it('S8 工具結果剪刀（#1302）', async () => {
    const script: Script = (i, body) => {
      if ((body.tools?.length ?? 0) === 0) return { content: '【不該有摘要】' };
      return i === 0 ? echoCall('call_mid', big('中', 20_000)) : {};
    };
    const run = await runAssembly(
      '大一點的結果\n再說一輪\n再一輪\n/exit\n',
      script,
      [createEchoPlugin()],
      {
        trigger: [{ type: 'tokens', value: 12_000 }],
        keep: { type: 'messages', value: 2 },
      },
    );
    expect(run.mainBodies.some((b) => JSON.stringify(b.messages).includes(PRUNE_MARKER))).toBe(
      true,
    );
    await expectDerivedHistory(
      'S8',
      run,
      [
        { call: 1, derivation: 'summary-after-reply', kinds: ['prune'] },
        { call: 2, kinds: ['prune'] },
        { call: 3, kinds: ['prune'] },
      ],
      4,
    );
  }, 90_000);

  it('S9 舊工具參數截斷（#1303）', async () => {
    const script: Script = (i) => (i === 0 ? writeCall('call_w') : {});
    const run = await runAssembly('寫檔\n二\n三\n四\n/exit\n', script, [], {
      trigger: [{ type: 'messages', value: 1000 }],
      keep: { type: 'messages', value: 2 },
      truncateArgs: {
        trigger: { type: 'messages', value: 4 },
        keep: { type: 'messages', value: 2 },
        maxLength: 100,
      },
    });
    expect(run.mainBodies.some((b) => JSON.stringify(b.messages).includes(TRUNCATE_MARKER))).toBe(
      true,
    );
    await expectDerivedHistory(
      'S9',
      run,
      [
        { call: 2, kinds: ['truncate'] },
        { call: 3, kinds: ['truncate'] },
        { call: 4, kinds: ['truncate'] },
      ],
      5,
    );
  }, 90_000);

  it('SH3 出貨 CLI：剪刀（門檻調低）', async () => {
    const script = mainOnly((k) => (k === 0 ? echoCall('call_mid', big('中', 10_000)) : {}));
    const run = await runShippedCli('中等結果\n二\n三\n四\n/exit\n', script, LOW_SUMMARIZATION);
    expect(run.mainBodies.some((b) => JSON.stringify(b.messages).includes(PRUNE_MARKER))).toBe(
      true,
    );
    await expectDerivedHistory(
      'SH3',
      run,
      [
        { call: 1, derivation: 'summary-after-reply', kinds: ['prune'] },
        { call: 2, derivation: 'summary-after-reply' },
      ],
      5,
    );
  }, 90_000);

  it('SH4 出貨 CLI：舊工具參數截斷（門檻調低）', async () => {
    const script = mainOnly((k) => (k === 0 ? writeCall('call_w') : {}));
    const run = await runShippedCli('寫檔\n二\n三\n四\n/exit\n', script, LOW_SUMMARIZATION);
    expect(run.mainBodies.some((b) => JSON.stringify(b.messages).includes(TRUNCATE_MARKER))).toBe(
      true,
    );
    await expectDerivedHistory(
      'SH4',
      run,
      [
        { call: 1, derivation: 'summary-after-reply' },
        { call: 2, kinds: ['truncate'] },
        { call: 3, kinds: ['truncate'] },
        { call: 4, kinds: ['truncate'] },
      ],
      5,
    );
  }, 90_000);

  it('SV5 serve：輸出撞上限帶工具呼叫 → 空的助手訊息（#1300）', async () => {
    const run = await runServePhases(
      [['被截斷', '再來']],
      mainOnly((k) =>
        k === 0
          ? {
              tools: [{ id: 'call_cut', name: 'echo', args: { message: '被切' } }],
              finish: 'length',
            }
          : {},
      ),
    );
    await expectDerivedHistory('SV5', run, [{ call: 1, kinds: ['empty-assistant'] }], 2);
  }, 90_000);

  it('SV6 serve：大結果與長參數，剪刀與截斷同時在場', async () => {
    const run = await runServePhases(
      [['大結果', '二', '三', '四']],
      mainOnly((k) =>
        k === 0
          ? {
              tools: [
                { id: 'call_mid', name: 'echo', args: { message: big('中', 10_000) } },
                {
                  id: 'call_w',
                  name: 'write_file',
                  args: { file_path: '/a.txt', content: big('abc', 2_000) },
                },
              ],
            }
          : {},
      ),
      LOW_SUMMARIZATION,
    );
    await expectDerivedHistory(
      'SV6',
      run,
      [
        { call: 1, derivation: 'summary-after-reply', kinds: ['prune'] },
        { call: 2, kinds: ['truncate'] },
        { call: 3, kinds: ['truncate'] },
        { call: 4, kinds: ['truncate'] },
      ],
      5,
    );
  }, 90_000);
});

describe('重啟後續接', () => {
  it('SR2 壓縮與剪刀、截斷發生之後重啟，下一次請求跟沒重啟的逐位元組相同', async () => {
    const script = () => mainOnly((k) => (k === 0 ? bigThenSmall() : {}));
    const texts = ['大結果', '二', '三', '四', '五', '重啟點之後的一句'];
    const control = await runServePhases([texts], script(), LOW_SUMMARIZATION);
    const restart = await runServePhases(
      [texts.slice(0, 5), texts.slice(5)],
      script(),
      LOW_SUMMARIZATION,
    );
    const last = (run: Run): Body => run.mainBodies.at(-1)!;
    // 重啟之前壓縮與截斷確實發生過，不然「相同」什麼都沒證明。
    const firstSummary = restart.events.find((e) => e.type === 'compaction/summary');
    const lastTurn = restart.events.findLast((e) => e.type === 'turn/start');
    expect(firstSummary, '重啟前就該壓縮過').toBeDefined();
    expect(firstSummary!.seq).toBeLessThan(lastTurn!.seq);
    expect(JSON.stringify(last(restart).messages)).toContain(TRUNCATE_MARKER);
    // 會話 id 每次不同，其他逐位元組比。
    const norm = (body: Body) =>
      body.messages
        .slice(1)
        .map((m) => JSON.stringify(m).replace(/session_[0-9a-f]{8}/g, 'session_X'));
    expect(norm(last(restart))).toEqual(norm(last(control)));
  }, 180_000);
});

const bigThenSmall = (): Reply => ({
  tools: [
    { id: 'call_mid', name: 'echo', args: { message: big('中', 10_000) } },
    { id: 'call_w', name: 'write_file', args: { file_path: '/a.txt', content: big('abc', 2_000) } },
  ],
});
