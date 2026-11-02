import { useMemo, useState } from "react";
import type { CompareResult, Selection } from "../types";

type Col = "taxon" | "local" | "global" | "diff" | "local_n" | "global_n";
type Row = CompareResult["snapshot"]["rows"][number];

const COLS: { key: Col; label: string; num?: boolean; title?: string }[] = [
  { key: "taxon", label: "Taxon" },
  { key: "local", label: "Local", num: true, title: "JHH local relative frequency" },
  { key: "global", label: "Global", num: true, title: "Nextstrain global relative frequency" },
  { key: "diff", label: "Local − global (pp)", title: "Difference in percentage points; positive = higher in JHH local" },
  { key: "local_n", label: "Local N", num: true, title: "Local sequences collected in the period" },
  { key: "global_n", label: "Global N", num: true, title: "Global sequences collected in the period" },
];

const VAL: Record<Col, (r: Row) => number | string> = {
  taxon: (r) => r.taxon,
  local: (r) => r.local_frequency,
  global: (r) => r.global_frequency,
  diff: (r) => r.difference_pp ?? 0,
  local_n: (r) => r.local_n,
  global_n: (r) => r.global_n,
};

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
  // default: largest local enrichment first; click a header to sort, again to reverse
  const [sort, setSort] = useState<{ col: Col; desc: boolean }>({ col: "diff", desc: true });
  const [q, setQ] = useState("");
  const snap = result.snapshot;
  const rows = useMemo(() => {
    const r = snap.rows.filter((x) => x.taxon.toLowerCase().includes(q.toLowerCase()));
    const f = VAL[sort.col];
    const cmp = (a: Row, b: Row) => {
      const x = f(a);
      const y = f(b);
      const c = typeof x === "string" ? x.localeCompare(y as string, undefined, { numeric: true }) : x - (y as number);
      return sort.desc ? -c : c;
    };
    return [...r].sort(cmp);
  }, [snap.rows, sort, q]);
  const maxAbs = Math.max(5, ...snap.rows.map((r) => Math.abs(r.difference_pp ?? 0)));
  const first = snap.rows[0];
  const point = snap.mode === "point";

  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h2>Snapshot</h2>{" "}
          <span className="sub inline">
            {snap.label ? (point ? `at ${snap.label}` : snap.label) : "no timepoint with data in both datasets in the selected range"}
            {point && (
              <>
                {" · "}
                <button className="link" onClick={() => update({ snapshotMode: "range", snapshotTime: null })}>
                  whole range
                </button>
              </>
            )}
            {!point && result.timepoints.shared.length > 0 && (
              <>
                {" · "}
                <button className="link" onClick={() => update({ snapshotMode: "point", snapshotTime: sel.snapshotTime ?? result.timepoints.shared.at(-1) ?? null })}>
                  single timepoint
                </button>
              </>
            )}
          </span>
        </div>
        <input className="search" aria-label="Search taxa" placeholder="Find taxon" value={q} onChange={(e) => setQ(e.target.value)} />
      </header>
      <div className="table-wrap">
        <table className="snap">
          <thead>
            <tr>
              {COLS.map((c) => (
                <th key={c.key} className={`${c.num ? "num" : ""} ${c.key === "diff" ? "diffcol" : ""}`} title={c.title} aria-sort={sort.col === c.key ? (sort.desc ? "descending" : "ascending") : "none"}>
                  <button className="th-sort" onClick={() => setSort((s) => ({ col: c.key, desc: s.col === c.key ? !s.desc : c.key !== "taxon" }))}>
                    {c.label}
                    <span className="arrow">{sort.col === c.key ? (sort.desc ? "▼" : "▲") : ""}</span>
                  </button>
                </th>
              ))}
              <th>In</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const d = r.difference_pp;
              const w = d == null ? 0 : (Math.abs(d) / maxAbs) * 50;
              return (
                <tr key={r.taxon} className={highlight === r.taxon ? "hl" : ""} onClick={() => setHighlight(highlight === r.taxon ? null : r.taxon)} title="Click to highlight in the chart">
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
          KDE-smoothed relative frequencies{point ? "" : ", averaged over shared timepoints"}. N = sequences collected in the period (of {first.local_denominator.toLocaleString()} local,{" "}
          {first.global_denominator.toLocaleString()} global). Click a row to highlight it.
        </p>
      )}
    </section>
  );
}
