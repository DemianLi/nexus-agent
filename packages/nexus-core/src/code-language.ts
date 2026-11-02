/**
 * 讀檔 meta 的 `lang`：由副檔名推語法上色的提示（[#617](https://github.com/DemianLi/nexus-agent/issues/617) 決定 3）。
 *
 * **逐字照抄 dsh 的 `@deepseek-ai/dsh-util-code-language`**（`packages/util/code-language/src/index.ts`，`477b4f4`），
 * 只留讀檔要用的 `readLangHintForPath` 與它讀的四張表；web 的預覽用的 `languageForPath`、
 * `CODE_HIGHLIGHT_EXTENSIONS` 不抄——harness 沒有消費者。**值是 web 的卡讀的**，dsh 的註解說它們一旦進了
 * 日誌就不能改，所以改表之前先改 dsh 那份、再照抄。英文註解是原文。
 *
 * @module
 */

/**
 * Recognized extensions per canonical language id. Values are lowercase
 * extensions without the dot; the id names the grammar rather than a display
 * label. The set covers common source, config, script, data, and markup
 * extensions a line-numbered code view or preview benefits from highlighting; it
 * is deliberately not an exhaustive linguist registry. Extensions whose Shiki
 * grammar does not exist map to the nearest available grammar
 * (`properties` to `ini`, whose registration carries the `properties` alias) or
 * stay unlisted. Certificate and lock extensions (`pem`, `crt`, `key`, `cer`,
 * `lock`) stay unlisted. Preview registries order specialized viewers before
 * Code so CSV can default to Spreadsheet while retaining syntax highlighting.
 * `makefile` covers only the suffix
 * (`foo.makefile`); the extensionless `Makefile` name stays unlisted.
 */
const LANGUAGE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  typescript: ['ts', 'tsx', 'mts', 'cts'],
  javascript: ['js', 'jsx', 'mjs', 'cjs'],
  shellscript: ['sh', 'bash', 'zsh'],
  fish: ['fish'],
  json: ['json', 'jsonc', 'jsonl', 'ndjson', 'ipynb'],
  csv: ['csv'],
  python: ['py', 'pyw', 'pyi'],
  ruby: ['rb', 'rake', 'gemspec'],
  go: ['go'],
  rust: ['rs'],
  java: ['java'],
  c: ['c', 'h'],
  cpp: ['cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx'],
  csharp: ['cs'],
  kotlin: ['kt', 'kts'],
  swift: ['swift'],
  php: ['php'],
  yaml: ['yaml', 'yml'],
  toml: ['toml'],
  ini: ['ini', 'conf', 'cfg', 'properties'],
  dotenv: ['env'],
  log: ['log'],
  diff: ['diff', 'patch'],
  http: ['http'],
  markdown: ['md', 'markdown'],
  mdx: ['mdx'],
  rst: ['rst'],
  latex: ['tex', 'sty', 'cls'],
  bibtex: ['bib'],
  asciidoc: ['adoc'],
  html: ['html', 'htm', 'xhtml'],
  css: ['css'],
  scss: ['scss'],
  less: ['less'],
  sql: ['sql'],
  xml: ['xml', 'xsd', 'xsl', 'xslt', 'plist', 'svg'],
  lua: ['lua'],
  bat: ['bat', 'cmd'],
  powershell: ['ps1', 'psm1', 'psd1'],
  r: ['r'],
  julia: ['jl'],
  dart: ['dart'],
  scala: ['scala'],
  clojure: ['clj', 'cljs', 'edn'],
  erlang: ['erl', 'hrl'],
  elixir: ['ex', 'exs'],
  haskell: ['hs'],
  fsharp: ['fs', 'fsi', 'fsx'],
  vb: ['vb'],
  perl: ['pl', 'pm'],
  verilog: ['v'],
  'system-verilog': ['sv', 'svh'],
  graphql: ['graphql', 'gql'],
  proto: ['proto'],
  hcl: ['tf', 'tfvars', 'hcl'],
  nix: ['nix'],
  vue: ['vue'],
  svelte: ['svelte'],
  make: ['makefile', 'mk'],
  cmake: ['cmake'],
  groovy: ['gradle', 'groovy'],
};

/**
 * Lowercase extension to canonical language id. A Map, not an object: a filename
 * whose extension is an `Object.prototype` key (`foo.constructor`,
 * `foo.__proto__`) must miss instead of resolving the inherited member, which
 * would otherwise reach callers as a non-string language value.
 */
const LANGUAGES = new Map(
  Object.entries(LANGUAGE_EXTENSIONS).flatMap(([language, extensions]) =>
    extensions.map((extension) => [extension, language] as const),
  ),
);

/**
 * Persisted `lang` values a language-level short id cannot express, keyed by the
 * suffix that produced them. Everything else falls back to
 * {@link SHORT_BY_LANGUAGE}, so only a suffix whose own name is the better label
 * appears here. Each value is the exact string recorded sessions already hold
 * and must not change; the byte-level expectation for every suffix lives in the
 * read consumer's test.
 */
const READ_LANG_BY_EXTENSION = new Map<string, string>([
  // The two JSX flavors keep their own suffix; every other persisted value is
  // the language's short name, or an extension naming itself better than its
  // language does (`tf` rather than `hcl`, `gradle` rather than `groovy`).
  ['tsx', 'tsx'],
  ['jsx', 'jsx'],
  ['tf', 'tf'],
  ['tfvars', 'tfvars'],
  ['gradle', 'gradle'],
]);

/**
 * The short `lang` id the read card persists, keyed by canonical language id.
 * Keys are exactly the languages in {@link LANGUAGE_EXTENSIONS}: where
 * {@link READ_LANG_BY_EXTENSION} does not already fix a suffix's value, this
 * table supplies the language's short name (`powershell` to `ps1`, `hcl` to
 * `tf`, `system-verilog` to `sv`) rather than the grammar id. Keys are canonical
 * ids, not untrusted extensions, so an object lookup cannot reach an
 * `Object.prototype` member the way the extension tables can.
 */
const SHORT_BY_LANGUAGE: Readonly<Record<string, string>> = {
  typescript: 'ts',
  javascript: 'js',
  shellscript: 'sh',
  fish: 'fish',
  json: 'json',
  csv: 'csv',
  python: 'py',
  ruby: 'rb',
  go: 'go',
  rust: 'rs',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  csharp: 'cs',
  kotlin: 'kotlin',
  swift: 'swift',
  php: 'php',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  dotenv: 'env',
  log: 'log',
  diff: 'diff',
  http: 'http',
  markdown: 'md',
  mdx: 'mdx',
  rst: 'rst',
  latex: 'tex',
  bibtex: 'bib',
  asciidoc: 'adoc',
  html: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  sql: 'sql',
  xml: 'xml',
  lua: 'lua',
  bat: 'bat',
  powershell: 'ps1',
  r: 'r',
  julia: 'jl',
  dart: 'dart',
  scala: 'scala',
  clojure: 'clj',
  erlang: 'erl',
  elixir: 'ex',
  haskell: 'hs',
  fsharp: 'fs',
  vb: 'vb',
  perl: 'pl',
  verilog: 'v',
  'system-verilog': 'sv',
  graphql: 'graphql',
  proto: 'proto',
  hcl: 'hcl',
  nix: 'nix',
  vue: 'vue',
  svelte: 'svelte',
  make: 'make',
  cmake: 'cmake',
  groovy: 'groovy',
};

function extensionForPath(path: string): string | undefined {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const base = path.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  return dot < 0 ? undefined : base.slice(dot + 1).toLowerCase();
}

/**
 * Derive the Host read card's persisted `lang` hint from a read path's
 * extension. The value is the language's short name; for some languages that name
 * is also the grammar id (`kotlin`, `swift`, `java`, `yaml`, `json`), and
 * {@link READ_LANG_BY_EXTENSION} overrides it where the suffix names itself
 * better (`tsx`, `tf`, `gradle`). A suffix a recorded session already holds keeps
 * its persisted value. An unrecognized suffix stays `undefined`, so the card
 * renders as plain text.
 * @param path - the model-facing path the read reported.
 * @returns the persisted language hint, or `undefined` when the extension maps to none.
 */
export function readLangHintForPath(path: string): string | undefined {
  const extension = extensionForPath(path);
  if (extension === undefined) return undefined;
  const canonical = LANGUAGES.get(extension);
  return canonical === undefined
    ? undefined
    : (READ_LANG_BY_EXTENSION.get(extension) ?? SHORT_BY_LANGUAGE[canonical]);
}
