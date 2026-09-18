/**
 * 程式碼區塊：先用等寬字型靜態呈現（#405）。
 *
 * **語法高亮留給 ⑥**（#406 引入 `shiki/core`，規格 §4.2 列 14）：介面先定好——`lang` 是 info string 的第一段
 * （同 dsh 的 `/^[\w-]+/`），`streaming` 表示這一塊還在長。⑥ 在這個元件裡換上高亮，markdown 那一層不用動。
 */
export function CodeBlock({
  code,
  lang,
  streaming,
}: {
  readonly code: string;
  readonly lang: string | undefined;
  readonly streaming: boolean;
}) {
  return (
    <div className="md-code" data-streaming={streaming || undefined}>
      {lang !== undefined && <div className="md-code-lang">{lang}</div>}
      <pre tabIndex={0}>
        <code className={lang === undefined ? undefined : `language-${lang}`}>{code}</code>
      </pre>
    </div>
  );
}
