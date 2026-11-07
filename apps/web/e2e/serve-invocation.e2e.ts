import { describe, expect, it } from 'vitest';

import { e2eServeInvocation } from './serve';

/**
 * e2e 的 serve 怎麼起（#2341）：不起 serve、不開瀏覽器，只看組出來的參數、patch 與要不要先建 home。
 * 環境明確傳進去，不讀 `process.env`，CI 上設了 `NEXUS_E2E_PROCESS_MODEL` 也不影響這裡。
 */

const TURNS = [{ content: '你好。' }];
const PATCH_PATH = '/tmp/x/script.patch.yml';
const SCRIPT_ROWS = `- insert:
    - id: e2e-script
      name: '#settings/scripted-model'
      config: {"turns":[{"content":"你好。"}]}
- id: agent-default-model
  config:
    provider: e2e-script
`;
const SUPERVISOR = '/opt/nexus/native/nexus-supervisor';

function invoke(env: Record<string, string | undefined>, prepareHome = false, extraRows = '') {
  return e2eServeInvocation({ turns: TURNS, extraRows, prepareHome, patchPath: PATCH_PATH, env });
}

describe('e2eServeInvocation：沒設 NEXUS_E2E_PROCESS_MODEL', () => {
  it.each([
    ['沒設', {}],
    ['空字串', { NEXUS_E2E_PROCESS_MODEL: '' }],
    ['只給了監督行程', { NEXUS_SUPERVISOR_BIN: SUPERVISOR }],
  ])('%s：參數、patch 跟原本一樣，沒有 prepareHome 就不先建 home', (_name, env) => {
    const invocation = invoke(env);
    expect(invocation.args.slice(3)).toEqual(['--port', '0', '--patch', PATCH_PATH]);
    expect(invocation.args).not.toContain('--process-model');
    expect(invocation.patch).toBe(SCRIPT_ROWS);
    expect(invocation.createHome).toBe(false);
  });

  it('有 prepareHome 才先建 home；extraRows 接在腳本前面', () => {
    const extra = '- id: host-tools\n  config: {}\n';
    const invocation = invoke({}, true, extra);
    expect(invocation.createHome).toBe(true);
    expect(invocation.patch).toBe(`${extra}${SCRIPT_ROWS}`);
  });
});

describe('e2eServeInvocation：NEXUS_E2E_PROCESS_MODEL=per-thread', () => {
  const env = { NEXUS_E2E_PROCESS_MODEL: 'per-thread', NEXUS_SUPERVISOR_BIN: SUPERVISOR };

  it('加 --process-model per-thread、process-model 那一列帶監督行程的路徑、先建 home', () => {
    const invocation = invoke(env);
    expect(invocation.args.slice(3)).toEqual([
      '--port',
      '0',
      '--patch',
      PATCH_PATH,
      '--process-model',
      'per-thread',
    ]);
    expect(invocation.patch).toBe(`- id: process-model
  config:
    mode: per-thread
    supervisorBinary: "${SUPERVISOR}"
${SCRIPT_ROWS}`);
    expect(invocation.createHome).toBe(true);
  });

  it('extraRows 照樣接上', () => {
    const extra = '- id: host-tools\n  config: {}\n';
    expect(invoke(env, false, extra).patch).toContain(`${extra}${SCRIPT_ROWS}`);
  });

  it('沒給 NEXUS_SUPERVISOR_BIN：拋錯，講要設這個變數', () => {
    expect(() => invoke({ NEXUS_E2E_PROCESS_MODEL: 'per-thread' })).toThrow(
      /NEXUS_SUPERVISOR_BIN/u,
    );
    expect(() =>
      invoke({ NEXUS_E2E_PROCESS_MODEL: 'per-thread', NEXUS_SUPERVISOR_BIN: '' }),
    ).toThrow(/NEXUS_SUPERVISOR_BIN/u);
  });
});

describe('e2eServeInvocation：NEXUS_E2E_PROCESS_MODEL 是別的值', () => {
  it.each(['single', 'per_thread', 'PER-THREAD'])('%s：拋錯，不悄悄跑 single', (value) => {
    expect(() =>
      invoke({ NEXUS_E2E_PROCESS_MODEL: value, NEXUS_SUPERVISOR_BIN: SUPERVISOR }),
    ).toThrow(/NEXUS_E2E_PROCESS_MODEL/u);
  });
});
