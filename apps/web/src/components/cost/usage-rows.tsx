/**
 * 用量的兩欄清單（`dl`、`tabular-nums`）：頂列的用量鈕（`session-usage.tsx`）與右側欄的成本分頁（`panel.tsx`）共用。
 * 獨立成檔，成本分頁才不必為了它 import 用量鈕、再繞回右側欄。
 */
export function Rows({ rows }: { rows: readonly (readonly [string, string])[] }) {
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 tabular-nums">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
