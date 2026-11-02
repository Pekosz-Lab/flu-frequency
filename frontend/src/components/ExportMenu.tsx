import { useEffect, useRef, useState } from "react";
import { download, IS_WEB } from "../api";
import type { CompareResult, Selection } from "../types";

const ITEMS: [string, string, string][] = [
  ["Figure", "PNG (300 dpi)", "figure?fmt=png"],
  ["Figure", "SVG", "figure?fmt=svg"],
  ["Figure", "PDF", "figure?fmt=pdf"],
  ["Data", "Trajectories CSV", "data?what=trajectories&fmt=csv"],
  ["Data", "Trajectories TSV", "data?what=trajectories&fmt=tsv"],
  ["Data", "Native-pivot trajectories CSV", "data?what=native_trajectories&fmt=csv"],
  ["Data", "Local vs global CSV", "data?what=comparison&fmt=csv"],
  ["Data", "Local vs global TSV", "data?what=comparison&fmt=tsv"],
  ["Data", "Snapshot table CSV", "data?what=snapshot&fmt=csv"],
  ["Data", "Analysis + settings JSON", "data?what=analysis&fmt=json"],
  ["Report", "Summary report (HTML)", "report"],
];

export default function ExportMenu({ sel, result }: { sel: Selection; result: CompareResult | null }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  let lastGroup = "";
  return (
    <div className="export" ref={ref}>
      <button className="primary" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {busy ? "Preparing…" : "Download ▾"}
      </button>
      {open && (
        <div className="menu" role="menu">
          {ITEMS.filter(([, label]) => !(IS_WEB && label === "PDF")).map(([group, label, path]) => {
            const head = group !== lastGroup ? <div className="menu-group">{group}</div> : null;
            lastGroup = group;
            return (
              <div key={path}>
                {head}
                <button
                  role="menuitem"
                  onClick={async () => {
                    setBusy(label);
                    setErr(null);
                    try {
                      await download(path, sel, sel.view, result);
                    } catch (e: any) {
                      setErr(String(e.message ?? e));
                    } finally {
                      setBusy(null);
                      setOpen(false);
                    }
                  }}
                >
                  {label}
                </button>
              </div>
            );
          })}
          <p className="hint">Current view, with build labels, dates, filters and caveat.{IS_WEB ? " PDF: local app only." : ""}</p>
        </div>
      )}
      {err && <p className="hint warn">{err}</p>}
    </div>
  );
}
