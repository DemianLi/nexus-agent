/**
 * 受管憑證檔的共用樣本（#2666）：TS 用 `parseCredentialsDocument` 跑 `native/sandbox-spawner/credentials-vectors.json`，
 * Rust 端若自己解析，跑同一份。契約見 `docs/credentials-file.md`。
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CREDENTIALS_DOCUMENT_VERSION,
  CREDENTIALS_FILE,
  createCredentialService,
  parseCredentialsDocument,
} from './credentials.js';
import { InvalidCredentialError } from './api-key.js';
import { loadLaunchEnv } from './launch-env.js';
import { assertUsableMcpCredential } from './mcp-credential.js';

interface AcceptVector {
  readonly name: string;
  readonly text: string;
  readonly refs: readonly (readonly [string, string])[];
  readonly ignoredKeys: readonly string[];
}

interface RejectVector {
  readonly name: string;
  readonly text: string;
  readonly reason: Reason;
  readonly code?: string;
  readonly secret?: string;
}

interface ModeVector {
  readonly mode: string;
  readonly accept: boolean;
}

/** MCP 憑證值的檢查（#2570）；Rust 的 `host/tests/mcp_redact.rs` 跑同一份。 */
interface McpValueVector {
  readonly name: string;
  readonly use: 'env' | 'header';
  readonly value: string;
  readonly accept: boolean;
  readonly trimmed?: string;
  readonly reason?: McpValueReason;
  readonly secret?: string;
}

/** MCP 憑證值的遮蔽。TS 的遮蔽器在 #2669，到那時才跑這一組；現在只釘格式，Rust 宿主已經跑它。 */
interface RedactVector {
  readonly name: string;
  readonly values: readonly string[];
  readonly text: string;
  readonly expect: string;
  readonly scope?: 'result' | 'error';
  readonly absent?: readonly string[];
}

const MCP_VALUE_REASONS = {
  empty: /是空白的/u,
  'too-short': /不到 8 個字元/u,
  nul: /含有 NUL 字元/u,
  'header-chars': /HTTP header 放不下的字元/u,
} as const;

type McpValueReason = keyof typeof MCP_VALUE_REASONS;

const VECTORS = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../native/sandbox-spawner/credentials-vectors.json', import.meta.url),
    ),
    'utf8',
  ),
) as {
  documentVersion: number;
  accept: AcceptVector[];
  reject: RejectVector[];
  modes: ModeVector[];
  mcpValue: McpValueVector[];
  redact: RedactVector[];
};

/**
 * 拒絕訊息 `受管憑證檔 <檔> 認不得：` 之後那一段 → reason code。粒度只到訊息分得出的程度。
 * 每個 code 一條、從開頭錨定；一則訊息對到兩條以上就是這張表寫錯了。
 */
const REASONS = {
  'not-mapping': /^根要是一個 mapping/u,
  version: /^version 要是 \d+$/u,
  records: /^nexus 沒有 records 這種憑證/u,
  'refs-not-mapping': /^refs 要是 mapping/u,
  'bad-name': /^refs 第 \d+ 行第 \d+ 欄的鍵不是環境變數形狀的名字/u,
  'not-string': /^refs 第 \d+ 行第 \d+ 欄那一把要是字串$/u,
  'empty-string': /^refs 第 \d+ 行第 \d+ 欄那一把是空字串/u,
  'duplicate-key': /^YAML 錯誤 DUPLICATE_KEY/u,
  yaml: /^YAML 錯誤 (?!DUPLICATE_KEY)[A-Z_]+/u,
} as const;

type Reason = keyof typeof REASONS;

const FILE = '/home/FAKE/.credentials.yaml';
const PREFIX = `受管憑證檔 ${FILE} 認不得：`;

function reasonOf(message: string): Reason[] {
  if (!message.startsWith(PREFIX)) return [];
  const why = message.slice(PREFIX.length);
  return (Object.keys(REASONS) as Reason[]).filter((code) => REASONS[code].test(why));
}

function rejection(text: string): string {
  try {
    parseCredentialsDocument(FILE, text);
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

describe('樣本檔本身', () => {
  it('文件版本跟解析器一致，三組都不是空的，每個 reason code 至少一條', () => {
    expect(VECTORS.documentVersion).toBe(CREDENTIALS_DOCUMENT_VERSION);
    expect(VECTORS.accept.length).toBeGreaterThan(0);
    expect(VECTORS.reject.length).toBeGreaterThan(0);
    expect(VECTORS.modes.length).toBeGreaterThan(0);
    expect(new Set(VECTORS.reject.map((v) => v.reason))).toEqual(new Set(Object.keys(REASONS)));
    expect(new Set(VECTORS.modes.map((v) => v.accept))).toEqual(new Set([true, false]));
  });

  it('名字不重複', () => {
    const names = [...VECTORS.accept, ...VECTORS.reject].map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('合法樣本', () => {
  it.each(VECTORS.accept.map((v) => [v.name, v] as const))('%s', (_name, vector) => {
    const parsed = parseCredentialsDocument(FILE, vector.text);
    expect([...parsed.refs]).toEqual(vector.refs);
    expect(parsed.ignoredKeys).toEqual(vector.ignoredKeys);
  });
});

describe('不合法樣本', () => {
  it.each(VECTORS.reject.map((v) => [v.name, v] as const))('%s', (_name, vector) => {
    const message = rejection(vector.text);
    expect(reasonOf(message)).toEqual([vector.reason]);
    if (vector.code !== undefined) expect(message).toContain(`${PREFIX}YAML 錯誤 ${vector.code}`);
    if (vector.secret !== undefined) expect(message).not.toContain(vector.secret);
  });
});

describe('權限位元', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'credentials-vectors-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it.runIf(process.platform !== 'win32').each(VECTORS.modes.map((v) => [v.mode, v] as const))(
    '%s',
    (_mode, vector) => {
      const file = join(home, CREDENTIALS_FILE);
      writeFileSync(file, 'version: 1\nrefs:\n  A: FAKE-mode\n');
      chmodSync(file, Number.parseInt(vector.mode, 8));
      const launchEnv = loadLaunchEnv({ cwd: home, home, target: {}, warn: () => undefined });
      const credentials = createCredentialService({ home, launchEnv, store: true, warn: () => {} });
      if (vector.accept) {
        expect(() => credentials.check()).not.toThrow();
      } else {
        expect(() => credentials.check()).toThrow(`chmod 600 ${file}`);
      }
    },
  );
});

describe('MCP 憑證值的檢查樣本', () => {
  it('每種拒絕原因至少一條，名字不重複', () => {
    expect(
      new Set(VECTORS.mcpValue.flatMap((v) => (v.reason === undefined ? [] : [v.reason]))),
    ).toEqual(new Set(Object.keys(MCP_VALUE_REASONS)));
    const names = [...VECTORS.mcpValue, ...VECTORS.redact].map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(VECTORS.mcpValue.map((v) => [v.name, v] as const))('%s', (_name, vector) => {
    const hit = { value: vector.value, source: 'file' as const, path: FILE };
    if (vector.accept) {
      expect(assertUsableMcpCredential('FAKE_NAME', hit, vector.use)).toBe(vector.trimmed);
      return;
    }
    let message = '';
    try {
      assertUsableMcpCredential('FAKE_NAME', hit, vector.use);
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidCredentialError);
      message = (error as Error).message;
    }
    const reasons = (Object.keys(MCP_VALUE_REASONS) as McpValueReason[]).filter((code) =>
      MCP_VALUE_REASONS[code].test(message),
    );
    expect(reasons).toEqual([vector.reason]);
    if (vector.secret !== undefined) expect(message).not.toContain(vector.secret);
  });
});

describe('MCP 憑證值的遮蔽樣本（格式）', () => {
  it.each(VECTORS.redact.map((v) => [v.name, v] as const))(
    '%s：欄位齊全、expect 只多出占位字串',
    (_name, vector) => {
      expect(vector.values.length).toBeGreaterThan(0);
      expect(typeof vector.text).toBe('string');
      expect(typeof vector.expect).toBe('string');
      for (const absent of vector.absent ?? []) expect(vector.expect).not.toContain(absent);
    },
  );
});
