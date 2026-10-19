import { useEffect, useMemo, useRef, useState } from "react";
import type { CompareResult, Selection } from "../types";

/** Timeline brush (date range) with data coverage bars and snapshot playback. */
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
    update({ start, end });
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

  return (
    <div className="timeline">
      <div className="tl-row">
        <span className="tl-label">Range</span>
        <div className="tl-track">
          <div className="cov local" style={bar(dr.local)} title={`Local data ${dr.local?.join(" – ")}`} />
          <div className="cov global" style={bar(dr.global)} title={`Global data ${dr.global?.join(" – ")}`} />
          <div className="cov shared" style={bar(dr.shared)} title={`Shared ${dr.shared?.join(" – ") ?? "none"}`} />
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
        <span className="tl-val">
          {months[lo]} → {months[hi]}
        </span>
      </div>
      <div className="tl-legend">
        <span className="k local" /> local data <span className="k global" /> global data <span className="k shared" /> shared comparable range
      </div>
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
            aria-label="Snapshot timepoint"
            min={0}
            max={shared.length - 1}
            value={snapI < 0 ? shared.length - 1 : snapI}
            onChange={(e) => update({ snapshotMode: "point", snapshotTime: shared[Number(e.target.value)] })}
          />
          <span className="tl-val">{sel.snapshotMode === "point" && sel.snapshotTime ? sel.snapshotTime : "whole range"}</span>
          {sel.snapshotMode === "point" && (
            <button className="link" onClick={() => update({ snapshotMode: "range", snapshotTime: null })}>
              use whole range
            </button>
          )}
        </div>
      )}
    </div>
  );
}
