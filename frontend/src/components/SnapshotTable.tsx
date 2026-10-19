import { useMemo, useState } from "react";
import type { CompareResult, Selection } from "../types";

type SortKey = "local_enrich" | "global_enrich" | "local_freq" | "global_freq" | "alpha";

const SORTS: [SortKey, string][] = [
  ["local_enrich", "Largest local enrichment"],
  ["global_enrich", "Largest global enrichment"],
  ["local_freq", "Highest local frequency"],
  ["global_freq", "Highest global frequency"],
  ["alpha", "Alphabetical"],
];

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export default function SnapshotTable({
  result,
  sel,
  update,
  highlight,
  setHighlight,
}: {
  result: CompareResult;
  sel: Selection;
  update: (p: Partial<Selection>) => void;
  highlight: string | null;
  setHighlight: (t: string | null) => void;
}) {
  const [sort, setSort] = useState<SortKey>("local_enrich");
  const [q, setQ] = useState("");
  const snap = result.snapshot;
  const rows = useMemo(() => {
    const r = snap.rows.filter((x) => x.taxon.toLowerCase().includes(q.toLowerCase()));
    const d = (x: (typeof r)[number]) => x.difference_pp ?? 0;
    const cmp: Record<SortKey, (a: (typeof r)[number], b: (typeof r)[number]) => number> = {
      local_enrich: (a, b) => d(b) - d(a),
      global_enrich: (a, b) => d(a) - d(b),
      local_freq: (a, b) => b.local_frequency - a.local_frequency,
      global_freq: (a, b) => b.global_frequency - a.global_frequency,
      alpha: (a, b) => a.taxon.localeCompare(b.taxon, undefined, { numeric: true }),
    };
    return [...r].sort(cmp[sort]);
  }, [snap.rows, sort, q]);
  const maxAbs = Math.max(5, ...snap.rows.map((r) => Math.abs(r.difference_pp ?? 0)));
  const first = rows[0];

  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h2>Snapshot comparison</h2>
          <p className="sub">{snap.label ? `${snap.mode === "point" ? "Timepoint" : "Range"}: ${snap.label}` : "No timepoint with data in both datasets in the selected range."}</p>
        </div>
        <div className="row wrap">
          <div className="seg-toggle small">
            <button className={sel.snapshotMode === "range" ? "on" : ""} onClick={() => update({ snapshotMode: "range", snapshotTime: null })}>
              Selected range (mean)
            </button>
            <button className={sel.snapshotMode === "point" ? "on" : ""} onClick={() => update({ snapshotMode: "point", snapshotTime: sel.snapshotTime ?? result.timepoints.shared.at(-1) ?? null })}>
              Single timepoint
            </button>
          </div>
          {sel.snapshotMode === "point" && (
            <select aria-label="Snapshot timepoint" value={sel.snapshotTime ?? ""} onChange={(e) => update({ snapshotTime: e.target.value })}>
              {result.timepoints.shared.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          )}
          <select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            {SORTS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          <input aria-label="Search taxa" placeholder="Find taxon" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </header>
      <div className="table-wrap">
        <table className="snap">
          <thead>
            <tr>
              <th>Taxon</th>
              <th className="num">Local frequency</th>
              <th className="num">Global frequency</th>
              <th className="diffcol">Difference (percentage points)</th>
              <th className="num">Local N</th>
              <th className="num">Global N</th>
              <th>Present in</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const d = r.difference_pp;
              const w = d == null ? 0 : (Math.abs(d) / maxAbs) * 50;
              return (
                <tr
                  key={r.taxon}
                  className={highlight === r.taxon ? "hl" : ""}
                  onClick={() => setHighlight(highlight === r.taxon ? null : r.taxon)}
                  title="Click to highlight this taxon in the chart"
                >
                  <td>
                    <span className="swatch" style={{ background: result.colors[r.taxon] ?? "#999" }} />
                    {r.taxon}
                  </td>
                  <td className="num">{pct(r.local_frequency)}</td>
                  <td className="num">{pct(r.global_frequency)}</td>
                  <td className="diffcol">
                    <div className="diffbar">
                      <span className="mid" />
                      {d != null && <span className={d >= 0 ? "pos" : "neg"} style={d >= 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }} />}
                    </div>
                    <span className="num dv">{d == null ? "n/a" : Math.abs(d) < 0.05 ? "0.0" : `${d > 0 ? "+" : ""}${d.toFixed(1)}`}</span>
                  </td>
                  <td className="num">{r.local_n.toLocaleString()}</td>
                  <td className="num">{r.global_n.toLocaleString()}</td>
                  <td>
                    <span className={`badge ${r.presence.replace(" ", "-")}`}>{r.presence}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {first && (
        <p className="hint">
          Frequencies are KDE-smoothed relative frequencies {snap.mode === "range" ? "averaged over shared timepoints" : "at the timepoint"}; N counts sequences collected in the
          period (local denominator {first.local_denominator.toLocaleString()}, global {first.global_denominator.toLocaleString()}). Positive differences: higher relative
          frequency in JHH local surveillance. Click a row to highlight it in the chart.
        </p>
      )}
    </section>
  );
}
