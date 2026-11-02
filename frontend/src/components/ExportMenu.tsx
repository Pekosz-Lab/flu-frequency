import { useEffect, useRef, useState } from "react";
import { download, IS_WEB } from "../api";
import { screenSpec } from "./FrequencyChart";
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
  ["Data", "Chart spec (Vega-Lite / Altair)", "vega-spec"],
  ["Report", "Summary report (HTML)", "report"],
];

/** The on-screen chart as a Vega-Lite spec with its data: open in Python with `altair.Chart.from_dict(...)`. */
function saveSpec(sel: Selection, result: CompareResult, text: Record<string, any>) {
  const spec = { ...screenSpec(result, sel, text, { width: 1100, compact: false }), description: `${text.caveat} ${text.footnote ?? ""}`.trim() };
  const blob = new Blob([JSON.stringify(spec, null, 1)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${sel.subtype}_${sel.segment}_${sel.grouping}_${sel.view}_vega-lite.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export default function ExportMenu({ sel, result, text }: { sel: Selection; result: CompareResult | null; text: Record<string, any> }) {
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
                      if (path === "vega-spec") {
                        if (!result) throw new Error("Nothing to export yet.");
                        saveSpec(sel, result, text);
                      } else await download(path, sel, sel.view, result);
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
