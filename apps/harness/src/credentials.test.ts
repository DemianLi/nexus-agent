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
  describeKeySource,
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
  store = true,
) {
  // 用自己的 target 當「啟動環境」，載入完再交給服務。
  const target = { ...inherited };
  const launchEnv = loadLaunchEnv({ cwd, home, target, warn: () => undefined });
  return { credentials: createCredentialService({ home, launchEnv, store, warn }), target };
}

describe('parseCredentialsDocument', () => {
  it('version 與 refs', () => {
    const { refs, ignoredKeys } = parseCredentialsDocument(
      file,
      `version: 1\nrefs:\n  ${KEY}: ${SECRET}\n`,
    );
    expect(refs.get(KEY)).toBe(SECRET);
    expect(ignoredKeys).toEqual([]);
  });

  it('空檔與只有 version 都是「沒有憑證」', () => {
    expect(parseCredentialsDocument(file, '').refs.size).toBe(0);
    expect(parseCredentialsDocument(file, '  \n').refs.size).toBe(0);
    expect(parseCredentialsDocument(file, 'version: 1\n').refs.size).toBe(0);
    expect(parseCredentialsDocument(file, 'version: 1\nrefs:\n').refs.size).toBe(0);
  });

  /** 同 dsh：整份只有註解（`toJS()` 是 `null`）與空 mapping 都是空的倉庫，不要求 `version`（#1507）。 */
  it.each([
    ['只有註解', '# 只有註解\n'],
    ['註解加空白行', '# 把唯一一把 key 註解掉了\n# NVIDIA_API_KEY: x\n\n   \n'],
    ['文件標記加註解', '---\n# 只有註解\n'],
    ['空 mapping', '{}\n'],
  ])('%s：空的倉庫，不要求 version', (_label, text) => {
    expect(parseCredentialsDocument(file, text)).toEqual({ refs: new Map(), ignoredKeys: [] });
  });

  it('version、refs 之外的頂層鍵不擋：鍵名交回、refs 照解、值不在結果裡以外的任何地方（#1507）', () => {
    const parsed = parseCredentialsDocument(
      file,
      `version: 1\nnote: ${SECRET}\nrefs:\n  ${KEY}: ${SECRET}\nother:\n  - 1\n`,
    );
    expect(parsed.refs.get(KEY)).toBe(SECRET);
    expect(parsed.ignoredKeys).toEqual(['note', 'other']);
    // 外來的條目留在檔案裡、不解析出東西：它的值不在 refs 裡。
    expect([...parsed.refs.keys()]).toEqual([KEY]);
  });

  it('只有 version 加外來的鍵：沒有憑證，鍵名交回', () => {
    expect(parseCredentialsDocument(file, 'version: 1\ncomment: hi\n')).toEqual({
      refs: new Map(),
      ignoredKeys: ['comment'],
    });
  });

  /** `records` 是 dsh 的鍵、我們沒有這種憑證：放過它，使用者會以為存進去的東西有作用（偏離 dsh 的既有登記）。 */
  it('records 仍然拒絕，訊息講明 nexus 沒有這種憑證，不說成「不認得的頂層鍵」', () => {
    const text = `version: 1\nrecords:\n  a/b:\n    type: api-key\n    key: ${SECRET}\nrefs:\n  ${KEY}: ${SECRET}\n`;
    let message = '';
    try {
      parseCredentialsDocument(file, text);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('nexus 沒有 records 這種憑證');
    expect(message).not.toContain('不認得的頂層鍵');
    expect(message).not.toContain(SECRET);
    expect(() => parseCredentialsDocument(file, 'version: 1\nrecords: {}\n')).toThrow('records');
    expect(() => parseCredentialsDocument(file, 'version: 1\nrecords:\n')).toThrow('records');
  });

  /** 每一種拒絕都不能把值帶進訊息：YAML 解析器自己的訊息會引出錯那一行。 */
  it.each([
    ['根不是 mapping', `- ${SECRET}\n`],
    ['records', `version: 1\nrecords: {}\nrefs:\n  ${KEY}: ${SECRET}\n`],
    ['沒有 version、只有外來的鍵', `note: ${SECRET}\n`],
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

describe('解析順序（serve，掛受管檔）：受管檔 > 啟動環境 > 目前資料夾 .env > home .env', () => {
  it('四層各放一把不同的值，逐一拿掉最上面那層，拿到的依序是下一層（#1540）', () => {
    dotenv(home, `${KEY}=from-home-env\n`);
    dotenv(cwd, `${KEY}=from-project-env\n`);
    managed(`version: 1\nrefs:\n  ${KEY}: from-file\n`);

    // 受管檔在，啟動環境同名也輸：管理者寫進受管檔的 key 一定生效。
    expect(service({ [KEY]: 'from-process' }).credentials.resolve(KEY)).toEqual({
      value: 'from-file',
      source: 'file',
      path: file,
    });

    rmSync(file);
    expect(service({ [KEY]: 'from-process' }).credentials.resolve(KEY)).toEqual({
      value: 'from-process',
      source: 'env',
    });
    expect(service().credentials.resolve(KEY)).toEqual({
      value: 'from-project-env',
      source: 'project-env',
      path: join(cwd, '.env'),
    });

    rmSync(join(cwd, '.env'));
    expect(service().credentials.resolve(KEY)).toEqual({
      value: 'from-home-env',
      source: 'user-env',
      path: join(home, '.env'),
    });

    rmSync(join(home, '.env'));
    expect(service().credentials.resolve(KEY)).toBeUndefined();
  });

  it('受管檔裡沒有這一把（只有別的名字）：才輪到啟動環境', () => {
    managed(`version: 1\nrefs:\n  OTHER_KEY: x\n`);
    expect(service({ [KEY]: 'from-process' }).credentials.resolve(KEY)).toEqual({
      value: 'from-process',
      source: 'env',
    });
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

describe('一次性入口（CLI、eval、spike，不掛受管檔）：啟動環境 > 目前資料夾 .env > home .env（#1540）', () => {
  const oneShot = (inherited: NodeJS.ProcessEnv = {}) =>
    service(inherited, () => undefined, false).credentials;

  it('受管檔放著不用：三層各放一把不同的值，逐一拿掉最上面那層', () => {
    dotenv(home, `${KEY}=from-home-env\n`);
    dotenv(cwd, `${KEY}=from-project-env\n`);
    managed(`version: 1\nrefs:\n  ${KEY}: from-file\n`);

    expect(oneShot({ [KEY]: 'from-process' }).resolve(KEY)).toEqual({
      value: 'from-process',
      source: 'env',
    });
    expect(oneShot().resolve(KEY)).toMatchObject({ value: 'from-project-env' });
    rmSync(join(cwd, '.env'));
    expect(oneShot().resolve(KEY)).toMatchObject({ value: 'from-home-env' });
    rmSync(join(home, '.env'));
    // 只有受管檔有 key：這個入口找不到它。
    expect(oneShot().resolve(KEY)).toBeUndefined();
  });

  it('壞掉的受管檔（0644、壞 YAML）不擋：check 與 resolve 都不拋，也不讀它', () => {
    managed(`version: 1\nrefs:\n  ${KEY}: [壞的\n`, 0o644);
    dotenv(home, `${KEY}=from-home-env\n`);
    const credentials = oneShot();
    expect(() => credentials.check()).not.toThrow();
    expect(credentials.resolve(KEY)).toMatchObject({ value: 'from-home-env' });
    expect(credentials.store).toBe(false);
  });
});

describe('describeKeySource：啟動時講「來自哪一層」，不含值（#1540）', () => {
  it('各層一句話；只有名字與來源', () => {
    dotenv(home, `${KEY}=${SECRET}-home\n`);
    dotenv(cwd, `${KEY}=${SECRET}-project\n`);
    managed(`version: 1\nrefs:\n  ${KEY}: ${SECRET}\n`);
    const lines = [
      describeKeySource(service().credentials, KEY),
      describeKeySource(service({ [KEY]: SECRET }).credentials, KEY),
    ];
    expect(lines[0]).toBe(`${KEY}：來自受管檔 ${file}`);
    expect(lines[1]).toBe(`${KEY}：來自受管檔 ${file}`);
    rmSync(file);
    expect(describeKeySource(service({ [KEY]: SECRET }).credentials, KEY)).toBe(
      `${KEY}：來自啟動環境`,
    );
    expect(describeKeySource(service().credentials, KEY)).toBe(`${KEY}：來自${join(cwd, '.env')}`);
    rmSync(join(cwd, '.env'));
    expect(describeKeySource(service().credentials, KEY)).toBe(`${KEY}：來自${join(home, '.env')}`);
    rmSync(join(home, '.env'));
    expect(describeKeySource(service().credentials, KEY)).toBeUndefined();
  });

  it('一次性入口寫明「此入口不讀受管檔」；任何一行都不含值的前 6 個字元', () => {
    managed(`version: 1\nrefs:\n  ${KEY}: ${SECRET}\n`);
    dotenv(home, `${KEY}=${SECRET}-home\n`);
    const line = describeKeySource(service({}, () => undefined, false).credentials, KEY);
    expect(line).toBe(`${KEY}：來自${join(home, '.env')}（此入口不讀受管檔）`);
    for (const text of [line, describeKeySource(service().credentials, KEY)]) {
      expect(text).not.toContain(SECRET.slice(0, 6));
    }
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

describe('別的工具多放的頂層鍵、只剩註解的檔（#1507，對齊 dsh alpha.5）', () => {
  it('多一個頂層鍵：解得出 key，warn 恰好一次，訊息含鍵名、不含值；同一份檔再解析不再警告', () => {
    managed(`version: 1\nnote: ${SECRET}-note\nrefs:\n  ${KEY}: ${SECRET}\n`);
    const warned: string[] = [];
    const { credentials } = service({}, (line) => warned.push(line));

    expect(() => credentials.check()).not.toThrow();
    expect(credentials.resolve(KEY)?.value).toBe(SECRET);
    expect(credentials.resolve(KEY)?.value).toBe(SECRET);
    expect(credentials.resolve('OTHER')).toBeUndefined();

    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('"note"');
    expect(warned[0]).toContain(file);
    expect(warned.join('')).not.toContain(SECRET);
    // 不是「重載失敗」：那條路徑是壞檔才走的。
    expect(warned[0]).not.toContain('重載失敗');
  });

  it('鍵名用 JSON 跳脫印出：鍵名裡的換行偽造不出第二行日誌', () => {
    managed(`version: 1\n"a\\nFAKE: line": 1\nrefs:\n  ${KEY}: v\n`);
    const warned: string[] = [];
    service({}, (line) => warned.push(line)).credentials.check();
    expect(warned).toHaveLength(1);
    expect(warned[0]?.match(/\n/gu)).toHaveLength(1);
    expect(warned[0]).toContain('"a\\nFAKE: line"');
  });

  it('沒有外來的鍵就不警告', () => {
    managed(`version: 1\nrefs:\n  ${KEY}: v\n`);
    const warned: string[] = [];
    service({}, (line) => warned.push(line)).credentials.check();
    expect(warned).toEqual([]);
  });

  it('整份只有註解：check 不拋、沒有憑證，往下掉到 .env', () => {
    managed('# 把唯一一把 key 註解掉了，之後改用環境變數\n# NVIDIA_API_KEY: x\n');
    dotenv(home, `${KEY}=from-home-env\n`);
    const warned: string[] = [];
    const { credentials } = service({}, (line) => warned.push(line));

    expect(() => credentials.check()).not.toThrow();
    expect(credentials.resolve(KEY)).toMatchObject({ value: 'from-home-env', source: 'user-env' });
    expect(warned).toEqual([]);
  });

  it('執行期重載：多了未知頂層鍵加新值，下一次解析拿到新值；講的是外來的鍵，不是「重載失敗」', () => {
    managed(`version: 1\nrefs:\n  ${KEY}: first\n`);
    const warned: string[] = [];
    const { credentials } = service({}, (line) => warned.push(line));
    expect(credentials.resolve(KEY)?.value).toBe('first');
    expect(warned).toEqual([]);

    managed(`version: 1\ncomment: hi\nrefs:\n  ${KEY}: second-longer\n`);
    expect(credentials.resolve(KEY)?.value).toBe('second-longer');
    expect(credentials.resolve(KEY)?.value).toBe('second-longer');
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('"comment"');
    expect(warned.join('')).not.toContain('重載失敗');
  });

  it('執行期被改成只剩註解：那一層消失（空的倉庫），不是壞檔', () => {
    managed(`version: 1\nrefs:\n  ${KEY}: first\n`);
    dotenv(home, `${KEY}=fallback-layer\n`);
    const warned: string[] = [];
    const { credentials } = service({}, (line) => warned.push(line));
    expect(credentials.resolve(KEY)?.source).toBe('file');

    managed('# 註解掉了\n');
    expect(credentials.resolve(KEY)).toMatchObject({ source: 'user-env', value: 'fallback-layer' });
    expect(warned).toEqual([]);
  });

  it('外來的鍵之後又改壞 refs：保留最後一份好的並警告重載失敗（refs 裡面照舊嚴）', () => {
    managed(`version: 1\nrefs:\n  ${KEY}: good-value\n`);
    const warned: string[] = [];
    const { credentials } = service({}, (line) => warned.push(line));
    credentials.resolve(KEY);

    managed(`version: 1\ncomment: hi\nrefs:\n  ${KEY}: ""\n`);
    expect(credentials.resolve(KEY)?.value).toBe('good-value');
    expect(warned.join('')).toContain('重載失敗');
  });

  it('一次性入口（不掛受管檔）不讀它：外來的鍵不警告', () => {
    managed(`version: 1\ncomment: hi\nrefs:\n  ${KEY}: from-file\n`);
    const warned: string[] = [];
    service({}, (line) => warned.push(line), false).credentials.check();
    expect(warned).toEqual([]);
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
