/**
 * 評估結果檔 —— **零憑證**，一個位元組都不出境。
 *
 * 主張有三個：
 *
 * 1. **版本識別改了就變**（題庫、評分程式）。一個改了程式它卻不會自己變的識別，比沒有更糟。
 * 2. **從檔案重算出的彙總，跟當次跑出來的彙總一模一樣。** 報表是 `summarize` 的函式，
 *    所以比的是 `summarize` 的輸出；測試用 `runTier` 配 `ScriptedChatModel` 產生真的報告，
 *    不手建 `TierReport`。
 * 3. **憑證形狀的東西不會進檔案。**
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentModel } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScriptedChatModel, type ScriptedTurn } from '../scripted-model.js';
import { compareTiers, evalModelRounds, summarize, type TierOutcome } from './compare.js';
import { BENCHMARK, EASY_CASE_COUNT, type BenchmarkCase } from './dataset.js';
import type { ModelUnderTest } from './model-under-test.js';
import {
  EVAL_RESULT_FORMAT_VERSION,
  SCORER_SOURCE_FILES,
  buildHeader,
  datasetVersion,
  defaultResultDir,
  describeSettings,
  openResultFile,
  parseResultFile,
  readGitProvenance,
  redactMessage,
  reportsFromResult,
  scorerVersion,
  systemPromptVersion,
  type GitProbe,
} from './result-file.js';

const ECHO_CASE = BENCHMARK[0] as BenchmarkCase;

const PERFECT: readonly ScriptedTurn[] = [
  {
    content: '我來回聲。',
    toolCalls: [{ name: 'echo', args: { message: '接線測試' } }],
    usage: { inputTokens: 100, outputTokens: 10 },
  },
  { content: '回聲：接線測試', usage: { inputTokens: 120, outputTokens: 6 } },
];

const GOOD: ModelUnderTest & { measuredOn: string } = {
  label: 'good',
  modelId: 'fake/good',
  measuredOn: '2026-01-01',
};
const BROKEN: ModelUnderTest = { label: 'broken', modelId: 'fake/broken' };

const CLEAN_GIT: GitProbe = (args) =>
  args[0] === 'rev-parse' ? 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n' : '';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eval-results-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function headerFor(models: readonly ModelUnderTest[], provenance = readGitProvenance(CLEAN_GIT)) {
  return buildHeader({
    tool: 'eval:compare',
    startedAt: new Date('2026-10-04T12:34:56.789Z'),
    argv: ['--samples', '2'],
    provenance,
    cases: [ECHO_CASE],
    settings: describeSettings({
      samples: 2,
      recursionLimit: 40,
      deadlineMs: 300_000,
      temperature: 1,
      topP: 0.95,
    }),
    models,
  });
}

describe('datasetVersion：題庫改了識別就變', () => {
  it('同一份題庫算兩次一樣', () => {
    expect(datasetVersion()).toBe(datasetVersion());
    expect(datasetVersion()).toMatch(/^[0-9a-f]{12}$/);
  });

  it.each([
    ['題面改一個字', (c: BenchmarkCase) => ({ ...c, prompt: `${c.prompt}。` })],
    [
      '期望的參數改了',
      (c: BenchmarkCase) => ({
        ...c,
        expected: {
          ...c.expected,
          toolCalls: c.expected.toolCalls.map((call) => ({ ...call, args: { message: '別句' } })),
        },
      }),
    ],
    ['id 改了', (c: BenchmarkCase) => ({ ...c, id: 'renamed' })],
  ])('%s', (_name, change) => {
    const edited = BENCHMARK.map((entry, at) => (at === 0 ? change(entry) : entry));
    expect(datasetVersion(edited)).not.toBe(datasetVersion());
  });

  it('順序、題數、易題與難題的分界都算', () => {
    expect(datasetVersion([...BENCHMARK].reverse())).not.toBe(datasetVersion());
    expect(datasetVersion(BENCHMARK.slice(0, -1))).not.toBe(datasetVersion());
    // 分界不在題目裡，但 eval:survey 的「難題」那組數字是照它切的。
    expect(datasetVersion(BENCHMARK, EASY_CASE_COUNT + 1)).not.toBe(datasetVersion());
  });
});

describe('scorerVersion：評分程式改了識別就變', () => {
  const source =
    (overrides: Record<string, string> = {}) =>
    (name: string) =>
      overrides[name] ?? `// ${name} 的原始碼`;

  it('內容相同就相同', () => {
    expect(scorerVersion(source())).toBe(scorerVersion(source()));
  });

  it.each(SCORER_SOURCE_FILES)('%s 的內容改了就變', (name) => {
    expect(scorerVersion(source({ [name]: '// 改過' }))).not.toBe(scorerVersion(source()));
  });

  it('預設讀的是真的原始碼，而且涵蓋兩個檔', () => {
    expect(SCORER_SOURCE_FILES).toEqual(['scorers.ts', 'runner.ts']);
    expect(scorerVersion()).toMatch(/^[0-9a-f]{12}$/);
    const realRunner = readFileSync(
      join(fileURLToPath(new URL('.', import.meta.url)), 'runner.ts'),
      'utf8',
    );
    // 拿真的 runner.ts 內容換進去，識別要跟預設那份一樣；換成別的內容就不一樣。
    const realScorers = readFileSync(
      join(fileURLToPath(new URL('.', import.meta.url)), 'scorers.ts'),
      'utf8',
    );
    expect(scorerVersion((n) => (n === 'scorers.ts' ? realScorers : realRunner))).toBe(
      scorerVersion(),
    );
  });

  it('讀不到原始碼就拋，不回「不明」', () => {
    expect(() =>
      scorerVersion(() => {
        throw new Error('ENOENT');
      }),
    ).toThrow(/ENOENT/);
  });
});

describe('readGitProvenance', () => {
  it('乾淨的工作樹：記 commit，dirty 是 false', () => {
    expect(readGitProvenance(CLEAN_GIT)).toEqual({
      commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      dirty: false,
    });
  });

  it('有未提交的改動：dirty 是 true —— 只記 SHA 會說謊', () => {
    const probe: GitProbe = (args) => (args[0] === 'rev-parse' ? 'abc\n' : ' M apps/x.ts\n?? y\n');
    expect(readGitProvenance(probe).dirty).toBe(true);
  });

  it('拿不到就是 null，不是 "unknown" 字串', () => {
    expect(readGitProvenance(() => undefined)).toEqual({ commit: null, dirty: null });
    expect(readGitProvenance(() => '')).toEqual({ commit: null, dirty: false });
  });
});

describe('describeSettings', () => {
  it('輪數用跟 CLI 同一個換算；沒讀到的取樣設定是 null 不是預設值', () => {
    const settings = describeSettings({ samples: 3, recursionLimit: 40, deadlineMs: 300_000 });
    expect(settings.modelRounds).toBe(evalModelRounds(40));
    expect(settings.modelRounds).toBe(13);
    expect(settings.temperature).toBeNull();
    expect(settings.topP).toBeNull();
    expect(settings.systemPromptVersion).toBe(systemPromptVersion());
  });
});

describe('redactMessage', () => {
  it.each([
    [
      'proxy 帶帳密的 URL',
      'connect ECONNREFUSED http://user:hunter2@proxy.local:8080/x',
      'hunter2',
    ],
    ['Authorization 標頭', 'got 401 with Authorization: Bearer abc123.def456', 'abc123'],
    ['nvapi 金鑰', 'invalid key nvapi-AbCdEf_123-xyz', 'AbCdEf'],
    ['sk 金鑰', 'invalid key sk-proj-ZZZ999', 'ZZZ999'],
  ])('%s 不會留在訊息裡', (_name, message, secret) => {
    const out = redactMessage(message);
    expect(out).not.toContain(secret);
    expect(out).toContain('***');
  });

  it('沒有憑證形狀的訊息原樣留下', () => {
    expect(redactMessage('HTTP 400: Tool use has not been enabled')).toBe(
      'HTTP 400: Tool use has not been enabled',
    );
  });

  it('太長的截斷', () => {
    const out = redactMessage('x'.repeat(500));
    expect(out.length).toBeLessThan(250);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('結果檔：寫出去再讀回來', () => {
  /** 兩個模型：一個跑得完（兩次取樣），一個每次都拋帶憑證的錯。 */
  async function runReports() {
    const created: TierOutcome[] = [];
    const reports = await compareTiers([GOOD, BROKEN], {
      createModel: (modelId) => {
        if (modelId === 'fake/broken') {
          throw Object.assign(
            new Error('proxy http://u:hunter2@p.local failed, key nvapi-SECRET1'),
            {
              status: 400,
            },
          );
        }
        return new ScriptedChatModel({ turns: PERFECT }) as unknown as AgentModel;
      },
      cases: [ECHO_CASE],
      samples: 2,
      onOutcome: (_tier, outcome) => void created.push(outcome),
    });
    return { reports, created };
  }

  it('重算出的彙總與當次跑出的一模一樣（含失敗那一類）', async () => {
    vi.stubEnv('NVIDIA_API_KEY', 'nvapi-ENVSECRET');
    const { reports } = await runReports();

    const writer = openResultFile({ dir, header: headerFor([GOOD, BROKEN]) });
    for (const report of reports) {
      for (const outcome of report.outcomes) writer.append(report.tier, outcome);
    }
    const saved = writer.finish();
    expect(saved).toEqual({ outcomes: 4, writeFailed: false });

    const text = readFileSync(writer.path, 'utf8');
    const parsed = parseResultFile(text);
    expect(parsed.complete).toBe(true);

    const replayed = reportsFromResult(parsed);
    expect(replayed.map((report) => summarize(report))).toEqual(
      reports.map((report) => summarize(report)),
    );
    // 對照組：這份比對不是空轉 —— 兩邊都有東西可比。
    expect(summarize(reports[0]!).scored).toBe(2);
    expect(summarize(reports[1]!).failures).toEqual({ rejected: 2 });
  });

  it('header 記下這一輪的條件：版本、來源、設定、模型（清單自己的欄位原樣留著）', async () => {
    const writer = openResultFile({ dir, header: headerFor([GOOD, BROKEN]) });
    writer.finish();
    const { header } = parseResultFile(readFileSync(writer.path, 'utf8'));

    expect(header.formatVersion).toBe(EVAL_RESULT_FORMAT_VERSION);
    expect(header.tool).toBe('eval:compare');
    expect(header.startedAt).toBe('2026-10-04T12:34:56.789Z');
    expect(header.argv).toEqual(['--samples', '2']);
    expect(header.provenance).toEqual({
      commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      dirty: false,
    });
    expect(header.dataset).toEqual({ version: datasetVersion(), caseIds: [ECHO_CASE.id] });
    expect(header.scorer).toEqual({ version: scorerVersion(), files: SCORER_SOURCE_FILES });
    expect(header.settings).toEqual({
      samples: 2,
      recursionLimit: 40,
      modelRounds: 13,
      deadlineMs: 300_000,
      temperature: 1,
      topP: 0.95,
      systemPromptVersion: systemPromptVersion(),
    });
    expect(header.models).toEqual([GOOD, BROKEN]);
  });

  it('scored 那一筆帶著評分器當時看到的原始觀測', async () => {
    const { reports } = await runReports();
    const writer = openResultFile({ dir, header: headerFor([GOOD, BROKEN]) });
    for (const outcome of reports[0]!.outcomes) writer.append(GOOD, outcome);
    writer.finish();

    const [first] = parseResultFile(readFileSync(writer.path, 'utf8')).outcomes;
    expect(first?.outcome.kind).toBe('scored');
    if (first?.outcome.kind !== 'scored') return;
    expect(first.outcome.run.toolCalls).toEqual([{ name: 'echo', args: { message: '接線測試' } }]);
    expect(first.outcome.run.finalText).toBe('回聲：接線測試');
    expect(first.outcome.run.usage).toBeDefined();
  });

  it('憑證形狀的東西不進檔案：失敗訊息被遮、環境變數根本不讀', async () => {
    vi.stubEnv('NVIDIA_API_KEY', 'nvapi-ENVSECRET');
    const { reports } = await runReports();
    const writer = openResultFile({ dir, header: headerFor([GOOD, BROKEN]) });
    for (const report of reports) for (const o of report.outcomes) writer.append(report.tier, o);
    writer.finish();

    const text = readFileSync(writer.path, 'utf8');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('SECRET1');
    expect(text).not.toContain('ENVSECRET');
    // 遮掉的是訊息，不是整筆：失敗的類別與狀態碼還在。
    expect(text).toContain('"reason":"rejected"');
    expect(text).toContain('"status":400');
  });

  it('同一個模型同一題的取樣編號從 0 遞增', async () => {
    const { reports } = await runReports();
    const writer = openResultFile({ dir, header: headerFor([GOOD, BROKEN]) });
    for (const outcome of reports[0]!.outcomes) writer.append(GOOD, outcome);
    writer.finish();
    const samples = parseResultFile(readFileSync(writer.path, 'utf8')).outcomes.map(
      (e) => e.sample,
    );
    expect(samples).toEqual([0, 1]);
  });

  it('沒有 footer 的檔是沒跑完的；footer 的筆數對不上也是', async () => {
    const { reports } = await runReports();
    const writer = openResultFile({ dir, header: headerFor([GOOD, BROKEN]) });
    for (const outcome of reports[0]!.outcomes) writer.append(GOOD, outcome);
    // 還沒 finish：跑到一半被砍。
    expect(parseResultFile(readFileSync(writer.path, 'utf8')).complete).toBe(false);

    writer.finish();
    const text = readFileSync(writer.path, 'utf8');
    expect(parseResultFile(text).complete).toBe(true);
    // 中間少一行（模擬某次 append 失敗）。
    const lines = text.trimEnd().split('\n');
    const missingOne = [lines[0], ...lines.slice(2)].join('\n');
    expect(parseResultFile(missingOne).complete).toBe(false);
  });

  it('檔名帶工具、時間、commit 前 7 碼；工作樹髒就標 -dirty', () => {
    const clean = openResultFile({ dir, header: headerFor([GOOD]) });
    expect(clean.path).toMatch(/eval-compare-20261004T123456Z-a1b2c3d\.jsonl$/);

    const dirty = openResultFile({
      dir,
      header: headerFor([GOOD], { commit: 'a1b2c3d4e5f6', dirty: true }),
    });
    expect(dirty.path).toMatch(/-a1b2c3d-dirty\.jsonl$/);

    const nogit = openResultFile({ dir, header: headerFor([GOOD], { commit: null, dirty: null }) });
    expect(nogit.path).toMatch(/-nogit\.jsonl$/);
  });

  it('不覆蓋已經存在的結果檔', () => {
    openResultFile({ dir, header: headerFor([GOOD]) });
    expect(() => openResultFile({ dir, header: headerFor([GOOD]) })).toThrow(/EEXIST/);
  });

  it('中途 append 失敗不殺掉整輪：警告一次、finish 回報 writeFailed', () => {
    const errors: unknown[] = [];
    const writer = openResultFile({
      dir,
      header: headerFor([GOOD]),
      onWriteError: (error) => errors.push(error),
    });
    // 把結果檔換成同名的目錄，後續 append 一律拋 EISDIR。
    rmSync(writer.path);
    mkdirSync(writer.path);
    const outcome: TierOutcome = {
      kind: 'failed',
      caseId: ECHO_CASE.id,
      reason: 'transport',
      message: 'x',
      seconds: 0,
    };
    writer.append(GOOD, outcome);
    writer.append(GOOD, outcome);

    expect(errors).toHaveLength(1);
    expect(writer.finish()).toEqual({ outcomes: 0, writeFailed: true });
  });
});

describe('parseResultFile 拒絕不認得的東西', () => {
  it('空檔、第一行不是 header、格式版號不同，都當場拋', () => {
    expect(() => parseResultFile('')).toThrow(/空的/);
    expect(() => parseResultFile('{"type":"outcome"}')).toThrow(/不是 header/);
    expect(() => parseResultFile('{"type":"header","formatVersion":99}')).toThrow(/格式版號是 99/);
  });

  it('outcome 指到 header 沒列的模型，重建報告時拋', () => {
    const writer = openResultFile({ dir, header: headerFor([GOOD]) });
    writer.append(BROKEN, {
      kind: 'failed',
      caseId: ECHO_CASE.id,
      reason: 'transport',
      message: 'x',
      seconds: 0,
    });
    writer.finish();
    const parsed = parseResultFile(readFileSync(writer.path, 'utf8'));
    expect(() => reportsFromResult(parsed)).toThrow(/broken/);
  });
});

describe('預設目錄', () => {
  it('在 apps/harness/eval-results/，而且被 .gitignore 擋住（結果檔不進版控）', () => {
    expect(defaultResultDir().replace(/\\/g, '/')).toMatch(/apps\/harness\/eval-results\/$/);
    const gitignore = readFileSync(
      fileURLToPath(new URL('../../../../.gitignore', import.meta.url)),
      'utf8',
    );
    expect(gitignore.split('\n')).toContain('eval-results/');
  });
});
