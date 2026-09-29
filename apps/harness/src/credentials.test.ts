/**
 * 憑證服務與受管檔（[#730](https://github.com/DemianLi/nexus-agent/issues/730) 的 B 段）。
 *
 * 全部用暫存資料夾與自己的 `target`／快照，**不碰 `process.env`、不碰真的 home**。
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ambientCredentials,
  CREDENTIALS_FILE,
  createCredentialService,
  parseCredentialsDocument,
} from './credentials.js';
import { loadLaunchEnv } from './launch-env.js';

const KEY = 'NVIDIA_API_KEY';
/** 測試用的假秘密：訊息與日誌裡出現它就是洩漏。 */
const SECRET = 'nvapi-secret-value-that-must-not-leak';

let root: string;
let cwd: string;
let home: string;
let file: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'credentials-'));
  cwd = join(root, 'project');
  home = join(root, 'home');
  file = join(home, CREDENTIALS_FILE);
  mkdirSync(cwd);
  mkdirSync(home);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function managed(text: string, mode = 0o600): void {
  writeFileSync(file, text, { mode });
  chmodSync(file, mode);
}

function dotenv(dir: string, text: string): void {
  writeFileSync(join(dir, '.env'), text);
}

function service(
  inherited: NodeJS.ProcessEnv = {},
  warn: (line: string) => void = () => undefined,
) {
  // 用自己的 target 當「啟動環境」，載入完再交給服務。
  const target = { ...inherited };
  const launchEnv = loadLaunchEnv({ cwd, home, target, warn: () => undefined });
  return { credentials: createCredentialService({ home, launchEnv, warn }), target };
}

describe('parseCredentialsDocument', () => {
  it('version 與 refs', () => {
    const refs = parseCredentialsDocument(file, `version: 1\nrefs:\n  ${KEY}: ${SECRET}\n`);
    expect(refs.get(KEY)).toBe(SECRET);
  });

  it('空檔與只有 version 都是「沒有憑證」', () => {
    expect(parseCredentialsDocument(file, '').size).toBe(0);
    expect(parseCredentialsDocument(file, '  \n').size).toBe(0);
    expect(parseCredentialsDocument(file, 'version: 1\n').size).toBe(0);
    expect(parseCredentialsDocument(file, 'version: 1\nrefs:\n').size).toBe(0);
  });

  /** 每一種拒絕都不能把值帶進訊息：YAML 解析器自己的訊息會引出錯那一行。 */
  it.each([
    ['根不是 mapping', `- ${SECRET}\n`],
    ['未知頂層鍵', `version: 1\nrecords: {}\nrefs:\n  ${KEY}: ${SECRET}\n`],
    ['version 不對', `version: 2\nrefs:\n  ${KEY}: ${SECRET}\n`],
    ['沒有 version', `refs:\n  ${KEY}: ${SECRET}\n`],
    ['refs 不是 mapping', `version: 1\nrefs:\n  - ${SECRET}\n`],
    ['鍵不是環境變數形狀', `version: 1\nrefs:\n  "bad key": ${SECRET}\n`],
    ['值不是字串', `version: 1\nrefs:\n  ${KEY}: 12345\n  OTHER: ${SECRET}\n`],
    ['值是空字串', `version: 1\nrefs:\n  ${KEY}: ""\n  OTHER: ${SECRET}\n`],
    ['重複鍵', `version: 1\nrefs:\n  ${KEY}: ${SECRET}\n  ${KEY}: other\n`],
    ['壞掉的 YAML', `version: 1\nrefs: {${KEY}: ${SECRET}\n`],
  ])('%s：拒絕，訊息指名檔案、不含秘密', (_label, text) => {
    let message = '';
    try {
      parseCredentialsDocument(file, text);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(file);
    expect(message).not.toContain(SECRET);
  });
});

describe('解析順序：啟動環境 > 受管檔 > 目前資料夾 .env > home .env', () => {
  it('四層各放一把不同的值，逐一拿掉最上面那層，拿到的依序是下一層', () => {
    dotenv(home, `${KEY}=from-home-env\n`);
    dotenv(cwd, `${KEY}=from-project-env\n`);
    managed(`version: 1\nrefs:\n  ${KEY}: from-file\n`);

    expect(service({ [KEY]: 'from-process' }).credentials.resolve(KEY)).toEqual({
      value: 'from-process',
      source: 'env',
    });
    expect(service().credentials.resolve(KEY)).toEqual({ value: 'from-file', source: 'file' });

    rmSync(file);
    expect(service().credentials.resolve(KEY)).toEqual({
      value: 'from-project-env',
      source: 'project-env',
    });

    rmSync(join(cwd, '.env'));
    expect(service().credentials.resolve(KEY)).toEqual({
      value: 'from-home-env',
      source: 'user-env',
    });

    rmSync(join(home, '.env'));
    expect(service().credentials.resolve(KEY)).toBeUndefined();
  });

  /** 受管檔存在的意義：內容不進行程的環境變數。 */
  it('受管檔的值不會被寫進 target', () => {
    managed(`version: 1\nrefs:\n  ${KEY}: ${SECRET}\n`);
    const { credentials, target } = service();

    expect(credentials.resolve(KEY)?.value).toBe(SECRET);
    expect(target[KEY]).toBeUndefined();
    expect(JSON.stringify(target)).not.toContain(SECRET);
  });

  it('沒有受管檔：正常，只是沒有那一層', () => {
    dotenv(home, `${KEY}=v\n`);
    expect(() => service().credentials.check()).not.toThrow();
    expect(service().credentials.resolve(KEY)?.source).toBe('user-env');
  });
});

describe('權限', () => {
  it('0644：check 拒絕，訊息帶路徑與 chmod 600；改成 0600 就過', () => {
    managed(`version: 1\nrefs:\n  ${KEY}: ${SECRET}\n`, 0o644);
    const { credentials } = service();

    expect(() => credentials.check()).toThrow(file);
    expect(() => credentials.check()).toThrow(`chmod 600 ${file}`);
    expect(() => credentials.resolve(KEY)).toThrow('chmod 600');

    chmodSync(file, 0o600);
    expect(() => credentials.check()).not.toThrow();
    expect(credentials.resolve(KEY)?.value).toBe(SECRET);
  });

  it.each([0o640, 0o604, 0o660, 0o666])('%o 也拒絕（group 或 other 任何一位）', (mode) => {
    managed(`version: 1\n`, mode);
    expect(() => service().credentials.check()).toThrow('chmod 600');
  });

  it('啟動環境已經有值時仍然檢查（check 是完整檢查，不看這次解析會不會用到它）', () => {
    managed(`version: 1\n`, 0o644);
    expect(() => service({ [KEY]: 'x' }).credentials.check()).toThrow('chmod 600');
  });
});

describe('重載：每次解析先 stat，變了才重讀', () => {
  it('改了檔，下一次解析就是新的', () => {
    managed(`version: 1\nrefs:\n  ${KEY}: first\n`);
    const { credentials } = service();
    expect(credentials.resolve(KEY)?.value).toBe('first');

    managed(`version: 1\nrefs:\n  ${KEY}: second-longer\n`);
    expect(credentials.resolve(KEY)?.value).toBe('second-longer');
  });

  it('同樣大小、只改內容：靠修改時間', () => {
    managed(`version: 1\nrefs:\n  ${KEY}: aaaa\n`);
    const { credentials } = service();
    expect(credentials.resolve(KEY)?.value).toBe('aaaa');

    managed(`version: 1\nrefs:\n  ${KEY}: bbbb\n`);
    const later = new Date(statSync(file).mtimeMs + 5000);
    utimesSync(file, later, later);
    expect(credentials.resolve(KEY)?.value).toBe('bbbb');
  });

  it('檔案被刪掉：那一層消失，往下掉到 .env', () => {
    dotenv(home, `${KEY}=fallback-layer\n`);
    managed(`version: 1\nrefs:\n  ${KEY}: from-file\n`);
    const { credentials } = service();
    expect(credentials.resolve(KEY)?.source).toBe('file');

    rmSync(file);
    expect(credentials.resolve(KEY)?.source).toBe('user-env');
  });

  it('執行期改壞：保留最後一份可用的，警告一次，不拖垮請求', () => {
    managed(`version: 1\nrefs:\n  ${KEY}: good-value\n`);
    const warned: string[] = [];
    const { credentials } = service({}, (line) => warned.push(line));
    expect(credentials.resolve(KEY)?.value).toBe('good-value');

    managed(`version: 1\nrefs:\n  ${KEY}: [壞的\n`);
    expect(credentials.resolve(KEY)?.value).toBe('good-value');
    expect(credentials.resolve(KEY)?.value).toBe('good-value');
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(file);

    managed(`version: 1\nrefs:\n  ${KEY}: repaired\n`);
    expect(credentials.resolve(KEY)?.value).toBe('repaired');
  });

  it('執行期權限被放寬：一樣保留最後一份並警告', () => {
    managed(`version: 1\nrefs:\n  ${KEY}: good-value\n`);
    const warned: string[] = [];
    const { credentials } = service({}, (line) => warned.push(line));
    credentials.resolve(KEY);

    chmodSync(file, 0o644);
    expect(credentials.resolve(KEY)?.value).toBe('good-value');
    expect(warned.join('')).toContain('chmod 600');
  });

  it('一開始就是壞的：第一次解析就拋（沒有「最後一份」可以保留）', () => {
    managed(`version: 1\nrefs:\n  ${KEY}: [壞的\n`);
    expect(() => service().credentials.resolve(KEY)).toThrow(resolve(file));
  });
});

describe('ambientCredentials（沒掛憑證服務時的退路）', () => {
  it('每次解析都重讀給定的環境；空字串算沒有', () => {
    const env: NodeJS.ProcessEnv = {};
    const ambient = ambientCredentials(env);
    expect(ambient.resolve(KEY)).toBeUndefined();
    env[KEY] = 'k1';
    expect(ambient.resolve(KEY)).toEqual({ value: 'k1', source: 'env' });
    env[KEY] = '';
    expect(ambient.resolve(KEY)).toBeUndefined();
  });
});
