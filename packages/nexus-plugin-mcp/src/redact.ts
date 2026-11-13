/**
 * MCP 連線手上已解析的憑證值，從送回對話行程的文字裡遮掉（[#2669](https://github.com/DemianLi/nexus-agent/issues/2669)、
 * [#2570](https://github.com/DemianLi/nexus-agent/issues/2570)）。規則、形式與樣本同 Rust 宿主的 `host/src/mcp/redact.rs`，
 * 兩邊跑同一份 `native/sandbox-spawner/credentials-vectors.json` 的 `redact[]`（見 `redact.test.ts`）。
 *
 * 做法：每個值連同它的幾種編碼形式，在原文上找出所有命中的區間，合併重疊與相鄰的，一次換成 `[redacted]`。
 * 不是逐值各換一次，所以兩個重疊的值不會漏，占位字串也不會被後面的值打中。
 *
 * **誰能呼叫：** {@link createRedactor} 是唯一入口，呼叫端交進「這一份連線手上所有已解析的值」；值的來源由呼叫端決定，這裡不分來源。
 * 值不修剪：要修剪的由呼叫端先做（`assertUsableMcpCredential` 回的就是修過的）。
 *
 * @module
 */

/** 占位字串。 */
export const PLACEHOLDER = '[redacted]';

/** 修剪後至少要有幾個 code point 才算「夠長」：同宿主的 `MIN_VALUE_CODE_POINTS`。 */
const MIN_LONG_VALUE_CODE_POINTS = 8;

/** 一組要遮的值。 */
export interface Redactor {
  /** 錯誤與診斷的文字：所有值都遮。 */
  scrubText(text: string): string;
  /** 成功結果裡的一段文字：只遮夠長的值（短的值在正常內容裡偶然撞上的機率高，遮了會把答案改壞）。 */
  redactText(text: string): string;
  /** 沒有任何值要遮（所以兩個函式都原樣回傳）。 */
  readonly empty: boolean;
}

/** 沒有值要遮的遮蔽器，給沒有憑證引用的連線。 */
export const NO_REDACTION: Redactor = {
  scrubText: (text) => text,
  redactText: (text) => text,
  empty: true,
};

/**
 * 收一組值。空字串丟掉；重複的併成一個。
 *
 * 憑證值短於門檻會在值檢查被拒，所以不到門檻的只可能是呼叫端另外交進來的字面值：它們只遮錯誤與診斷（{@link Redactor.scrubText}）。
 */
export function createRedactor(values: Iterable<string>): Redactor {
  const everywhere = new Set<string>();
  const errorsOnly = new Set<string>();
  const seen = new Set<string>();
  for (const value of values) {
    if (value === '' || seen.has(value)) continue;
    seen.add(value);
    const target = [...value].length >= MIN_LONG_VALUE_CODE_POINTS ? everywhere : errorsOnly;
    for (const form of formsOf(value)) target.add(form);
  }
  if (everywhere.size === 0 && errorsOnly.size === 0) return NO_REDACTION;
  const long = [...everywhere];
  const all = [...everywhere, ...errorsOnly];
  return {
    scrubText: (text) => replaceSpans(text, all),
    redactText: (text) => replaceSpans(text, long),
    empty: false,
  };
}

/** 一個值的比對形式：原值、`encodeURIComponent`、form 編碼（空白寫成 `+`）、JSON 字串裡的跳脫（含把 `/` 寫成 `\/` 的）。百分號與 `\u` 的十六進位只收全大寫與全小寫。 */
function formsOf(value: string): string[] {
  const out = new Set<string>([value]);
  for (const upper of [true, false]) {
    out.add(percent(value, upper, false));
    out.add(percent(value, upper, true));
    out.add(jsonEscaped(value, upper, false));
    out.add(jsonEscaped(value, upper, true));
  }
  // 別家的 JSON 編碼器（PHP 等）把 `/` 寫成 `\/`。
  for (const form of [...out]) if (form.includes('/')) out.add(form.replaceAll('/', '\\/'));
  out.delete('');
  return [...out];
}

const UNRESERVED = /^[A-Za-z0-9]$/u;
const encoder = new TextEncoder();

/** `encodeURIComponent`（`form` 為假）或 `application/x-www-form-urlencoded`（`form` 為真），十六進位大寫或小寫。 */
function percent(value: string, upper: boolean, form: boolean): string {
  const keepExtra = form ? '*-._' : "-_.!~*'()";
  let out = '';
  for (const byte of encoder.encode(value)) {
    const char = String.fromCharCode(byte);
    if (byte < 0x80 && (UNRESERVED.test(char) || keepExtra.includes(char))) {
      out += char;
    } else if (form && byte === 0x20) {
      out += '+';
    } else {
      const hex = byte.toString(16).padStart(2, '0');
      out += `%${upper ? hex.toUpperCase() : hex}`;
    }
  }
  return out;
}

/**
 * JSON 字串裡的樣子（不含兩側的引號）。`ascii` 為真時非 ASCII 字元也寫成 `\uXXXX`（補充平面用代理對）；
 * 為假時只跳脫 `"`、`\` 與控制字元，跟 `JSON.stringify` 一樣。
 */
function jsonEscaped(value: string, upper: boolean, ascii: boolean): string {
  const unit = (code: number): string => {
    const hex = code.toString(16).padStart(4, '0');
    return `\\u${upper ? hex.toUpperCase() : hex}`;
  };
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === '"') out += '\\"';
    else if (char === '\\') out += '\\\\';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (char === '\b') out += '\\b';
    else if (char === '\f') out += '\\f';
    else if (code < 0x20) out += unit(code);
    else if (ascii && code > 0x7f) {
      for (let i = 0; i < char.length; i++) out += unit(char.charCodeAt(i));
    } else out += char;
  }
  return out;
}

/** 找出所有樣式在 `text` 裡的命中區間（同一個樣式自己重疊的也找），合併重疊與相鄰的，每一段換成 {@link PLACEHOLDER}。 */
function replaceSpans(text: string, patterns: readonly string[]): string {
  const spans: [number, number][] = [];
  for (const pattern of patterns) {
    if (pattern === '') continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(pattern, from);
      if (at < 0) break;
      spans.push([at, at + pattern.length]);
      // 從命中處的下一個位置再找：`aa` 在 `aaa` 裡有兩處。
      from = at + 1;
    }
  }
  if (spans.length === 0) return text;
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const [start, end] of spans) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  let out = '';
  let at = 0;
  for (const [start, end] of merged) {
    out += text.slice(at, start) + PLACEHOLDER;
    at = end;
  }
  return out + text.slice(at);
}
