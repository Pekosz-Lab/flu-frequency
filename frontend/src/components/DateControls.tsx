import type { CompareResult, RangeMode, Selection } from "../types";

const PRESETS: [RangeMode, string, string][] = [
  ["overlap", "Overlap", "Every date where both datasets have data (default)"],
  [6, "6 mo", "Last 6 months of the overlap"],
  [12, "12 mo", "Last 12 months of the overlap"],
  [24, "24 mo", "Last 24 months of the overlap"],
  ["all", "All", "Every date in either dataset, including dates with data from one dataset only"],
];

/** Range presets (relative to the period both datasets cover) and exact start/end dates. */
export default function DateControls({ sel, update, result }: { sel: Selection; update: (p: Partial<Selection>) => void; result: CompareResult | null }) {
  const dr = result?.date_ranges;
  return (
    <div className="dates">
      <div className="presets" role="group" aria-label="Date range">
        {PRESETS.map(([mode, label, title]) => (
          <button
            key={label}
            className={sel.range === mode ? "on" : ""}
            aria-pressed={sel.range === mode}
            disabled={typeof mode === "number" && !dr?.shared}
            title={title}
            onClick={() => update({ range: mode, ...(mode === "all" ? { start: null, end: null } : {}) })}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="row date-inputs">
        <input type="date" aria-label="Start date" value={sel.start ?? ""} onChange={(e) => update({ start: e.target.value || null, range: "custom" })} />
        <span className="muted">–</span>
        <input type="date" aria-label="End date" value={sel.end ?? ""} onChange={(e) => update({ end: e.target.value || null, range: "custom" })} />
      </div>
    </div>
  );
}
