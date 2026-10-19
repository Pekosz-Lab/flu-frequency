import type { CompareResult, Selection } from "../types";

const PRESETS: [string, number | null][] = [
  ["3 mo", 3],
  ["6 mo", 6],
  ["12 mo", 12],
  ["24 mo", 24],
  ["Full", null],
];

function minusMonths(iso: string, n: number) {
  const d = new Date(iso + "T00:00:00");
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
}

export default function DateControls({ sel, update, result }: { sel: Selection; update: (p: Partial<Selection>) => void; result: CompareResult | null }) {
  const dr = result?.date_ranges;
  // anchor presets on the latest date available in either dataset
  const anchor = [dr?.local?.[1], dr?.global?.[1]].filter(Boolean).sort().pop() as string | undefined;
  const activePreset = (n: number | null) =>
    n === null ? !sel.start && !sel.end : !!anchor && sel.start === minusMonths(anchor, n) && !sel.end;
  return (
    <div className="dates">
      <div className="presets" role="group" aria-label="Date presets">
        {PRESETS.map(([label, n]) => (
          <button
            key={label}
            className={activePreset(n) ? "on" : ""}
            disabled={n !== null && !anchor}
            onClick={() => update(n === null ? { start: null, end: null } : { start: minusMonths(anchor!, n), end: null })}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="row">
        <input type="date" aria-label="Start date" value={sel.start ?? ""} onChange={(e) => update({ start: e.target.value || null })} />
        <span className="muted">to</span>
        <input type="date" aria-label="End date" value={sel.end ?? ""} onChange={(e) => update({ end: e.target.value || null })} />
      </div>
      {dr && (
        <dl className="ranges">
          <dt className="local">Local data</dt>
          <dd>{dr.local ? `${dr.local[0]} – ${dr.local[1]}` : "none"}</dd>
          <dt className="global">Global data</dt>
          <dd>{dr.global ? `${dr.global[0]} – ${dr.global[1]}` : "none"}</dd>
          <dt>Shared</dt>
          <dd>{dr.shared ? `${dr.shared[0]} – ${dr.shared[1]}` : "no overlap"}</dd>
        </dl>
      )}
      {dr && !dr.selection_has_both && <p className="hint warn">The selected range does not contain data from both datasets.</p>}
    </div>
  );
}
