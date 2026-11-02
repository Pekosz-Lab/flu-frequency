import { useEffect, useMemo, useRef, useState } from "react";
import type { CompareResult, Selection } from "../types";
import DateControls from "./DateControls";

const fmtRange = (r: [string, string] | null) => (r ? `${r[0]} – ${r[1]}` : "none");

/** Date range (presets, brush over data coverage, exact dates) and snapshot playback. */
export default function Timeline({ result, sel, update }: { result: CompareResult; sel: Selection; update: (p: Partial<Selection>) => void }) {
  const dr = result.date_ranges;
  const months = useMemo(() => {
    const starts = [dr.local?.[0], dr.global?.[0]].filter(Boolean) as string[];
    const ends = [dr.local?.[1], dr.global?.[1]].filter(Boolean) as string[];
    if (!starts.length) return [] as string[];
    const s = starts.sort()[0].slice(0, 7);
    const e = ends.sort().reverse()[0].slice(0, 7);
    const out: string[] = [];
    let [y, m] = s.split("-").map(Number);
    const [ey, em] = e.split("-").map(Number);
    while (y < ey || (y === ey && m <= em)) {
      out.push(`${y}-${String(m).padStart(2, "0")}`);
      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
    }
    return out;
  }, [dr.local, dr.global]);

  const idx = (iso: string | null | undefined, fallback: number) => {
    if (!iso) return fallback;
    const i = months.indexOf(iso.slice(0, 7));
    return i < 0 ? (iso.slice(0, 7) < months[0] ? 0 : months.length - 1) : i;
  };
  const [lo, setLo] = useState(0);
  const [hi, setHi] = useState(0);
  useEffect(() => {
    setLo(idx(sel.start, 0));
    setHi(idx(sel.end, months.length - 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel.start, sel.end, months]);

  const commit = (l: number, h: number) => {
    const start = l <= 0 ? null : `${months[l]}-01`;
    const endM = months[h];
    let end: string | null = null;
    if (h < months.length - 1 && endM) {
      const [y, m] = endM.split("-").map(Number);
      end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    }
    if (start !== sel.start || end !== sel.end) update({ start, end, range: "custom" });
  };

  // snapshot playback over the shared timepoints
  const shared = result.timepoints.shared;
  const [playing, setPlaying] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!playing) return;
    timer.current = window.setInterval(() => {
      const cur = sel.snapshotTime && shared.includes(sel.snapshotTime) ? shared.indexOf(sel.snapshotTime) : -1;
      const next = cur + 1;
      if (next >= shared.length) {
        setPlaying(false);
        return;
      }
      update({ snapshotMode: "point", snapshotTime: shared[next] });
    }, 900);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [playing, shared, sel.snapshotTime, update]);

  if (!months.length) return null;
  const pct = (m: string | undefined) => (m ? (Math.max(0, months.indexOf(m.slice(0, 7))) / Math.max(1, months.length - 1)) * 100 : 0);
  const bar = (r: [string, string] | null) => (r ? { left: `${pct(r[0])}%`, width: `${Math.max(0.8, pct(r[1]) - pct(r[0]))}%` } : { display: "none" });
  const snapI = sel.snapshotTime ? shared.indexOf(sel.snapshotTime) : -1;
  const point = sel.snapshotMode === "point" && !!sel.snapshotTime;

  return (
    <div className="timeline">
      <div className="tl-row">
        <span className="tl-label">Dates</span>
        <DateControls sel={sel} update={update} result={result} />
      </div>
      <div className="tl-row">
        <span className="tl-label" />
        <div className="tl-track" title={`Local data ${fmtRange(dr.local)}\nGlobal data ${fmtRange(dr.global)}\nOverlap ${fmtRange(dr.shared)}`}>
          <div className="cov local" style={bar(dr.local)} />
          <div className="cov global" style={bar(dr.global)} />
          <div className="cov shared" style={bar(dr.shared)} />
          <div className="sel" style={{ left: `${(lo / Math.max(1, months.length - 1)) * 100}%`, width: `${((hi - lo) / Math.max(1, months.length - 1)) * 100}%` }} />
          <input
            type="range"
            aria-label="Range start"
            min={0}
            max={months.length - 1}
            value={lo}
            onChange={(e) => setLo(Math.min(Number(e.target.value), hi))}
            onMouseUp={() => commit(lo, hi)}
            onTouchEnd={() => commit(lo, hi)}
            onKeyUp={() => commit(lo, hi)}
          />
          <input
            type="range"
            aria-label="Range end"
            min={0}
            max={months.length - 1}
            value={hi}
            onChange={(e) => setHi(Math.max(Number(e.target.value), lo))}
            onMouseUp={() => commit(lo, hi)}
            onTouchEnd={() => commit(lo, hi)}
            onKeyUp={() => commit(lo, hi)}
          />
        </div>
        <span className="tl-legend">
          <span className="k local" /> local <span className="k global" /> global <span className="k shared" /> overlap
        </span>
      </div>
      {!dr.shared && <p className="hint warn tl-note">The two datasets have no dates in common.</p>}
      {dr.shared && !dr.selection_has_both && <p className="hint warn tl-note">The selected range does not contain data from both datasets.</p>}
      {shared.length > 0 && (
        <div className="tl-row">
          <span className="tl-label">Snapshot</span>
          <button
            className="play"
            aria-label={playing ? "Pause" : "Play through timepoints"}
            onClick={() => {
              if (!playing && (snapI < 0 || snapI >= shared.length - 1)) update({ snapshotMode: "point", snapshotTime: shared[0] });
              setPlaying(!playing);
            }}
          >
            {playing ? "❚❚" : "▶"}
          </button>
          <input
            type="range"
            className={point ? "" : "idle"}
            aria-label="Snapshot timepoint"
            min={0}
            max={shared.length - 1}
            value={snapI < 0 ? shared.length - 1 : snapI}
            onChange={(e) => update({ snapshotMode: "point", snapshotTime: shared[Number(e.target.value)] })}
          />
          <span className="tl-val">
            {point ? (
              <>
                {sel.snapshotTime}{" "}
                <button className="link" onClick={() => (setPlaying(false), update({ snapshotMode: "range", snapshotTime: null }))}>
                  whole range
                </button>
              </>
            ) : (
              <span className="muted">whole range · drag to pick a timepoint</span>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
