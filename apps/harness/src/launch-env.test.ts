/**
 * 兩層 `.env` 的啟動環境（[#730](https://github.com/DemianLi/nexus-agent/issues/730)）。
 *
 * 全部用暫存資料夾與自己的 `target` 物件，**不碰 `process.env`、不碰真的 home**。
 * 舊位置那一條例外：它是程式碼資料夾根目錄的固定路徑，有沒有檔取決於這台機器，所以只驗「判準怎麼走」——
 * 見最後一組。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { legacyEnvFileFor, legacyEnvMovedError, loadLaunchEnv } from './launch-env.js';

let root: string;
let cwd: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'launch-env-'));
  cwd = join(root, 'project');
  home = join(root, 'home');
  mkdirSync(cwd);
  mkdirSync(home);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function env(dir: string, text: string): void {
  writeFileSync(join(dir, '.env'), text);
}

function load(target: NodeJS.ProcessEnv, extra: { warn?: (line: string) => void } = {}) {
  return loadLaunchEnv({ cwd, home, target, warn: extra.warn ?? (() => undefined) });
}

describe('層的優先序', () => {
  it('繼承的 > 目前資料夾 > home；每個名字記著來自哪一層', () => {
    env(cwd, 'A=project\nB=project\n');
    env(home, 'A=home\nB=home\nC=home\n');
    const target: NodeJS.ProcessEnv = { A: 'process' };

    const snapshot = load(target);

    expect(target).toMatchObject({ A: 'process', B: 'project', C: 'home' });
    expect(snapshot.get('A')?.source).toBe('process');
    expect(snapshot.get('B')).toEqual({
      value: 'project',
      source: 'project-env',
      path: resolve(cwd, '.env'),
    });
    expect(snapshot.get('C')).toEqual({
      value: 'home',
      source: 'user-env',
      path: resolve(home, '.env'),
    });
  });

  /** 憑證服務要能只問某幾層（受管檔排在 process 與 `.env` 之間）。 */
  it('get 可以限定看哪幾層；空字串算沒有', () => {
    env(cwd, 'A=\nB=project\n');
    env(home, 'A=home\nB=home\n');
    const snapshot = load({});

    expect(snapshot.get('A')?.value).toBe('home');
    expect(snapshot.get('B', ['user-env'])?.value).toBe('home');
    expect(snapshot.get('B', ['process'])).toBeUndefined();
  });

  it('沒有任何檔：不拋，也不動 target', () => {
    const target: NodeJS.ProcessEnv = { A: '1' };
    const snapshot = load(target);
    expect(target).toEqual({ A: '1' });
    expect(snapshot.layers.map((layer) => layer.source)).toEqual(['process']);
  });

  it('目前資料夾就是 home：只讀一次，記成專案那一層', () => {
    env(cwd, 'A=1\n');
    const snapshot = loadLaunchEnv({ cwd, home: cwd, target: {}, warn: () => undefined });
    expect(snapshot.layers.map((layer) => layer.source)).toEqual(['process', 'project-env']);
  });

  /** 快照是載入那一刻的：之後 target 怎麼變，這份不跟著變。 */
  it('快照的繼承層是載入之前的環境，不含 .env 套用進去的', () => {
    env(cwd, 'A=project\n');
    const target: NodeJS.ProcessEnv = {};
    const snapshot = load(target);
    expect(target.A).toBe('project');
    expect(snapshot.get('A', ['process'])).toBeUndefined();
  });
});

describe('只有啟動環境能設的名字', () => {
  it.each(['PATH', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'GIT_SSH_COMMAND', 'path'])(
    '%s 出現在目前資料夾的 .env：失敗，訊息指名檔案與變數',
    (name) => {
      env(cwd, `${name}=x\n`);
      expect(() => load({})).toThrow(resolve(cwd, '.env'));
      expect(() => load({})).toThrow(`"${name}"`);
    },
  );

  it('出現在 home 的 .env 一樣失敗（代理以外）', () => {
    env(home, 'NODE_OPTIONS=--require=x\n');
    expect(() => load({})).toThrow(resolve(home, '.env'));
  });

  it.each(['NEXUS_AGENT_HOME', 'NEXUS_AGENT_ANYTHING', 'XDG_CONFIG_HOME', 'DYLD_LIBRARY_PATH'])(
    '前綴 %s 兩份都拒絕（dsh 的 DSH_ 換成 NEXUS_AGENT_）',
    (name) => {
      env(home, `${name}=x\n`);
      expect(() => load({})).toThrow(`"${name}"`);
    },
  );

  it('代理只有 home 那份可以設；目前資料夾那份失敗，且訊息說得出出路', () => {
    env(home, 'HTTPS_PROXY=http://proxy.internal:3128\n');
    const target: NodeJS.ProcessEnv = {};
    load(target);
    expect(target.HTTPS_PROXY).toBe('http://proxy.internal:3128');

    env(cwd, 'HTTPS_PROXY=http://evil:1\n');
    expect(() => load({})).toThrow(resolve(home, '.env'));
  });

  /**
   * **小寫的代理名也算**（[#746](https://github.com/DemianLi/nexus-agent/issues/746)）：代理政策讀名字是小寫優先，
   * 只擋大寫等於留了一個洞——目前資料夾的 `.env` 寫 `https_proxy` 會成為實際生效的那個值。
   */
  it.each(['https_proxy', 'http_proxy', 'all_proxy', 'no_proxy'])(
    '小寫的 %s：目前資料夾那份拒絕，home 那份放行',
    (name) => {
      env(cwd, `${name}=http://evil:1\n`);
      expect(() => load({})).toThrow(resolve(home, '.env'));
      rmSync(resolve(cwd, '.env'));

      env(home, `${name}=http://proxy.internal:3128\n`);
      const target: NodeJS.ProcessEnv = {};
      load(target);
      expect(target[name]).toBe('http://proxy.internal:3128');
    },
  );

  it('CA／TLS 在 home 那份也拒絕：它們改的是信任誰，不是往哪走', () => {
    env(home, 'NODE_TLS_REJECT_UNAUTHORIZED=0\n');
    expect(() => load({})).toThrow('NODE_TLS_REJECT_UNAUTHORIZED');
  });

  /** 兩份都先檢查、都過了才套用：被拒絕的那一份不能留下另一份的半套。 */
  it('一份被拒絕：另一份也沒有套用', () => {
    env(cwd, 'GOOD=1\n');
    env(home, 'PATH=/x\n');
    const target: NodeJS.ProcessEnv = {};
    expect(() => load(target)).toThrow('PATH');
    expect(target).toEqual({});
  });

  /** 啟動環境自己設的 PATH 當然可以：限制的是 .env，不是行程。 */
  it('啟動環境裡本來就有的 PATH 不受影響', () => {
    env(cwd, 'GOOD=1\n');
    const target: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    load(target);
    expect(target).toEqual({ PATH: '/usr/bin', GOOD: '1' });
  });
});

describe('讀不了的檔', () => {
  it('不是「不存在」的讀取失敗走 warn，其餘層照常載入', () => {
    mkdirSync(join(cwd, '.env'));
    env(home, 'A=home\n');
    const warned: string[] = [];
    const target: NodeJS.ProcessEnv = {};

    load(target, { warn: (line) => warned.push(line) });

    expect(warned.join('')).toContain(resolve(cwd, '.env'));
    expect(target.A).toBe('home');
  });
});

describe('舊位置（程式碼資料夾根目錄的 .env）', () => {
  function legacy(text = 'NVIDIA_API_KEY=legacy-key\n'): string {
    const dir = join(root, 'repo-root');
    mkdirSync(dir);
    env(dir, text);
    return join(dir, '.env');
  }

  function withLegacy(file: string, target: NodeJS.ProcessEnv = {}) {
    return loadLaunchEnv({ cwd, home, target, warn: () => undefined, legacyFile: file });
  }

  /** 從 `apps/harness` 啟動、key 只在舊位置：舊檔沒被讀；缺 key 時給搬家訊息，指名舊路徑、新位置與變數名。 */
  it('key 只在舊位置：舊檔沒被讀，搬家訊息指名舊路徑、新位置與變數名', () => {
    const file = legacy();
    const target: NodeJS.ProcessEnv = {};

    const snapshot = withLegacy(file, target);
    const moved = legacyEnvMovedError(snapshot, 'NVIDIA_API_KEY', { cwd, home });

    expect(target).toEqual({});
    expect(snapshot.legacyEnvFile).toBe(file);
    expect(moved?.message).toContain(file);
    expect(moved?.message).toContain(resolve(home, '.env'));
    expect(moved?.message).toContain('NVIDIA_API_KEY');
  });

  it('新位置有 key：舊檔還在，舊檔不被讀', () => {
    const file = legacy('NVIDIA_API_KEY=legacy-key\nOTHER=x\n');
    env(home, 'NVIDIA_API_KEY=new-key\n');
    const target: NodeJS.ProcessEnv = {};

    const snapshot = withLegacy(file, target);

    expect(target).toEqual({ NVIDIA_API_KEY: 'new-key' });
    expect(snapshot.legacyEnvFile).toBe(file);
  });

  it('目前資料夾就是舊檔所在（從程式碼根目錄啟動）：那是專案層，不是舊位置', () => {
    env(cwd, 'NVIDIA_API_KEY=k\n');
    const target: NodeJS.ProcessEnv = {};

    const snapshot = withLegacy(join(cwd, '.env'), target);

    expect(target.NVIDIA_API_KEY).toBe('k');
    expect(snapshot.legacyEnvFile).toBeUndefined();
    expect(legacyEnvMovedError(snapshot, 'NVIDIA_API_KEY', { cwd, home })).toBeUndefined();
  });

  it('沒有舊檔：沒有搬家訊息（缺值留給模型建構當場講缺哪一個）', () => {
    const snapshot = withLegacy(join(root, '不存在', '.env'));
    expect(snapshot.legacyEnvFile).toBeUndefined();
    expect(legacyEnvMovedError(snapshot, 'X', { cwd, home })).toBeUndefined();
  });
});

/**
 * 舊位置只對原始碼樹有意義（[#1671](https://github.com/DemianLi/nexus-agent/issues/1671)）。兩種形狀都在暫存目錄裡造，
 * 不碰這台機器上真的 `/opt`：安裝樹是 `<前綴>/nexus-agent/<版本>/lib`（連結解開之後），`lib` 往上三層就是 `<前綴>`，
 * 那裡放一份不相干的 `.env`；原始碼樹是 `<repo>/apps/harness/src`，往上三層是 repo 根。
 */
describe('舊位置：安裝樹與原始碼樹', () => {
  /** 安裝樹：往上三層有 `.env`，產物根有（或沒有）建置戳記。回 `lib` 與那份 `.env`。 */
  function installedTree(stamp: string | undefined): { moduleDir: string; strayEnv: string } {
    const prefix = join(root, 'opt');
    const release = join(prefix, 'nexus-agent', 'v1');
    const moduleDir = join(release, 'lib');
    mkdirSync(moduleDir, { recursive: true });
    env(prefix, 'NVIDIA_API_KEY=unrelated\n');
    if (stamp !== undefined) writeFileSync(join(release, 'build-stamp.json'), stamp);
    return { moduleDir, strayEnv: join(prefix, '.env') };
  }

  function sourceTree(): { moduleDir: string; repoEnv: string } {
    const repo = join(root, 'repo');
    const moduleDir = join(repo, 'apps', 'harness', 'src');
    mkdirSync(moduleDir, { recursive: true });
    env(repo, 'NVIDIA_API_KEY=old\n');
    return { moduleDir, repoEnv: join(repo, '.env') };
  }

  const STAMP = JSON.stringify({
    commit: '1234567890abcdef1234567890abcdef12345678',
    dirty: false,
  });

  it('安裝樹：往上三層有 .env，也沒有舊位置，缺 key 時不給搬家訊息', () => {
    const { moduleDir } = installedTree(STAMP);

    expect(legacyEnvFileFor(moduleDir)).toBeUndefined();
    const snapshot = loadLaunchEnv({ cwd, home, target: {}, warn: () => undefined, moduleDir });
    expect(snapshot.legacyEnvFile).toBeUndefined();
    expect(legacyEnvMovedError(snapshot, 'NVIDIA_API_KEY', { cwd, home })).toBeUndefined();
  });

  it('安裝樹：不讀那份 .env（值不會進環境）', () => {
    const { moduleDir } = installedTree(STAMP);
    const target: NodeJS.ProcessEnv = {};

    loadLaunchEnv({ cwd, home, target, warn: () => undefined, moduleDir });

    expect(target).toEqual({});
  });

  it('安裝樹的戳記壞了（不是 JSON）仍是安裝樹：判準是戳記在不在，不是它讀不讀得懂', () => {
    const { moduleDir } = installedTree('not json');
    expect(legacyEnvFileFor(moduleDir)).toBeUndefined();
  });

  it('原始碼樹（沒有戳記）：舊位置是 repo 根的 .env，缺 key 時照舊給搬家訊息', () => {
    const { moduleDir, repoEnv } = sourceTree();

    expect(legacyEnvFileFor(moduleDir)).toBe(repoEnv);
    const snapshot = loadLaunchEnv({ cwd, home, target: {}, warn: () => undefined, moduleDir });
    expect(snapshot.legacyEnvFile).toBe(repoEnv);
    expect(legacyEnvMovedError(snapshot, 'NVIDIA_API_KEY', { cwd, home })?.message).toContain(
      repoEnv,
    );
  });

  it('同一份 .env、同樣往上三層，只差產物根的戳記：有戳記沒有舊位置，沒有戳記有', () => {
    const prefix = join(root, 'opt');
    const lib = join(prefix, 'a', 'b', 'src');
    mkdirSync(lib, { recursive: true });
    env(prefix, 'NVIDIA_API_KEY=x\n');
    // `lib` 的上一層是 `b`，戳記放那裡才是「產物根」。
    expect(legacyEnvFileFor(lib)).toBe(join(prefix, '.env'));
    writeFileSync(join(prefix, 'a', 'b', 'build-stamp.json'), STAMP);
    expect(legacyEnvFileFor(lib)).toBeUndefined();
  });
});
