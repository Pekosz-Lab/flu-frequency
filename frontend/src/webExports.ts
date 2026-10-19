// Client-side exports for the website (port of ffc/exports.py, minus PDF).
import Plotly from "plotly.js-dist-min";
import { buildFigure } from "./components/FrequencyChart";
import CONFIG from "./engine/web-config.json";
import type { CompareResult, Selection, View } from "./types";

const T = CONFIG.text;
const GROUPING: Record<string, string> = { clade: "Clade", subclade: "Subclade", genotype: "Genotype" };
const v = (p: Record<string, any>, k: string) => p[k]?.value;
const filtersText = (f?: Record<string, string[]>) => {
  const e = Object.entries(f ?? {}).filter(([, x]) => x.length);
  return e.length ? e.map(([k, x]) => `${k} = ${x.join(", ")}`).join("; ") : "none";
};

export function metadataLines(r: CompareResult, sel: Selection): string[] {
  const pl = r.provenance.local, pg = r.provenance.global, pc = r.provenance.comparison;
  const [s, e] = r.date_ranges.selected;
  const geno = pc.genotype_definition;
  const lines = [
    `Subtype: ${v(pl, "subtype")}   Segment: ${v(pl, "segment")}   Grouping: ${GROUPING[pc.grouping] ?? pc.grouping}${geno ? ` (${geno})` : ""}   Date range: ${s ?? "start of data"} to ${e ?? "end of data"}`,
    `Local: ${v(pl, "build_label")} [${v(pl, "remote")}], JSON updated ${v(pl, "updated_date")}, latest sample ${v(pl, "most_recent_sample_date")}, tips ${v(pl, "tips_after_filtering")}/${v(pl, "total_tips")}, frequencies: ${v(pl, "frequency_source")}. Local-only filters: ${filtersText(sel.localFilters)}`,
    `Global: ${v(pg, "build_label")} [${v(pg, "remote")}], JSON updated ${v(pg, "updated_date")}, latest sample ${v(pg, "most_recent_sample_date")}, tips ${v(pg, "tips_after_filtering")}/${v(pg, "total_tips")}, frequencies: ${v(pg, "frequency_source")}. Global-only filters: ${filtersText(sel.globalFilters)}`,
    `Builds fetched from nextstrain.org (public datasets) at ${pc.data_processing_timestamp} UTC; figure generated ${new Date().toISOString().slice(0, 19)} UTC.`,
  ];
  const sf = (pc.shared_filters ?? []) as any[];
  if (sf.length)
    lines.splice(1, 0, "Filters on both datasets: " + sf.map((x) => `${x.label} = ${x.values.join(", ")} (local '${x.local_field}', global '${x.global_field}')`).join("; "));
  if (pc.alignment_detail) lines.push("Time alignment: " + pc.alignment_detail);
  if (pc.colours) lines.push("Colours: " + pc.colours);
  if (r.grouped_into_other.length) lines.push(`'Other' groups ${r.grouped_into_other.length} less frequent taxa.`);
  return lines;
}

function wrap(s: string, n: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const w of s.split(" ")) {
    if ((line + " " + w).trim().length > n) {
      out.push(line.trim());
      line = w;
    } else line += " " + w;
  }
  if (line.trim()) out.push(line.trim());
  return out;
}

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Figure with title, provenance block and caveat footnote, rendered off-screen. */
async function figureDataUrl(r: CompareResult, sel: Selection, view: View, format: "png" | "svg"): Promise<string> {
  const { traces, layout } = buildFigure(r, { ...sel, view }, null, T);
  const meta = metadataLines(r, sel).flatMap((l) => wrap(l, 175));
  const foot = wrap("Note: " + T.footnote, 185);
  const W = 1650, plotH = 640, metaH = (meta.length + foot.length + 1) * 15 + 30;
  const H = 110 + plotH + metaH;
  const pc = r.provenance.comparison;
  const pl = r.provenance.local;
  const title = `${v(pl, "subtype")} ${v(pl, "segment")} ${String(GROUPING[pc.grouping] ?? "").toLowerCase()} frequencies: JHH local vs Nextstrain global`;
  const L = { ...layout };
  L.width = W;
  L.height = H;
  L.margin = { l: 80, r: 220, t: 110, b: metaH + 50 };
  L.paper_bgcolor = "#ffffff";
  L.plot_bgcolor = "#ffffff";
  L.title = { text: `<b>${title}</b><br><span style="font-size:13px">Relative frequencies of taxa in the supplied public builds.</span>`, x: 0.01, xanchor: "left", y: 0.985, yanchor: "top", font: { size: 20 } };
  const ann = [...(L.annotations ?? [])];
  let y = -((40 + 18) / plotH);
  for (const line of meta) {
    ann.push({ xref: "paper", yref: "paper", x: 0, y, xanchor: "left", yanchor: "top", showarrow: false, align: "left", text: line.replace(/</g, "&lt;"), font: { size: 11, color: "#222" } });
    y -= 15 / plotH;
  }
  y -= 8 / plotH;
  for (const line of foot) {
    ann.push({ xref: "paper", yref: "paper", x: 0, y, xanchor: "left", yanchor: "top", showarrow: false, align: "left", text: `<i>${line.replace(/</g, "&lt;")}</i>`, font: { size: 11, color: "#444" } });
    y -= 15 / plotH;
  }
  L.annotations = ann;
  const div = document.createElement("div");
  div.style.cssText = "position:fixed;left:-99999px;top:0;width:1650px";
  document.body.appendChild(div);
  try {
    await Plotly.newPlot(div, traces, L, { staticPlot: true });
    return await Plotly.toImage(div, { format, width: W, height: H, scale: format === "png" ? 2 : 1 });
  } finally {
    Plotly.purge(div);
    div.remove();
  }
}

const csvCell = (x: any, sep: string) => {
  const s = x === null || x === undefined ? "" : String(x);
  return s.includes(sep) || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
};
function table(rows: Record<string, any>[], sep: string, header: string): string {
  if (!rows.length) return header;
  const cols = Object.keys(rows[0]);
  return header + [cols.join(sep), ...rows.map((r) => cols.map((c) => csvCell(r[c], sep)).join(sep))].join("\n") + "\n";
}

function trajectories(r: CompareResult) {
  const al = r.aligned;
  const out: Record<string, any>[] = [];
  for (const [side, name] of [["local", "JHH local"], ["global", "Nextstrain global"]] as const) {
    const s = al[side];
    if (!s) continue;
    for (const [t, ser] of Object.entries(s.series))
      al.dates.forEach((d, i) => {
        if (!s.present[i]) return;
        const f = ser.frequency[i];
        out.push({ dataset: name, build_id: r[side].build_id, taxon: t, timepoint: d, pivot_date_used: s.pivot_dates[i], pivot_offset_days: s.offset_days[i], relative_frequency: f, percent: f == null ? null : Math.round(f * 1e6) / 1e4, numerator_count: ser.numerator[i], denominator_count: s.denominator[i] });
      });
  }
  return out;
}

function nativeTrajectories(r: CompareResult) {
  const out: Record<string, any>[] = [];
  for (const [side, name] of [["local", "JHH local"], ["global", "Nextstrain global"]] as const) {
    const s = r[side];
    for (const [t, ser] of Object.entries(s.series))
      s.dates.forEach((d, i) => out.push({ dataset: name, build_id: s.build_id, taxon: t, pivot_date: d, relative_frequency: ser.frequency[i], percent: ser.frequency[i] == null ? null : Math.round((ser.frequency[i] as number) * 1e6) / 1e4, numerator_count: ser.numerator[i], denominator_count: s.denominator[i] }));
  }
  return out;
}

function comparison(r: CompareResult) {
  const d = r.difference;
  return Object.entries(d.series).flatMap(([t, s]) =>
    d.dates.map((m, i) => ({ taxon: t, timepoint: m, local_relative_frequency: s.local[i], global_relative_frequency: s.global[i], difference_percentage_points: s.difference_pp[i], local_numerator_count: s.local_n[i], global_numerator_count: s.global_n[i] })),
  );
}

const fileBase = (r: CompareResult, sel: Selection, what: string) => `${sel.subtype}_${sel.segment}_${sel.grouping}_${r.global.build_id}_${what}`;

export async function webDownload(path: string, sel: Selection, view: View, result: CompareResult | null) {
  if (!result) throw new Error("Nothing to export yet.");
  const u = new URL(path, "https://x.invalid");
  const fmt = u.searchParams.get("fmt") ?? "png";
  const what = u.searchParams.get("what") ?? "";
  if (u.pathname.endsWith("/figure")) {
    if (fmt === "pdf") throw new Error("PDF export is available in the local app (ffc serve).");
    const url = await figureDataUrl(result, sel, view, fmt as "png" | "svg");
    const blob = await (await fetch(url)).blob();
    return save(blob, `${fileBase(result, sel, view)}.${fmt}`);
  }
  const header = [...metadataLines(result, sel), "Caveat: " + T.caveat, "Alignment: " + T.alignment, "Counts: " + T.counts].map((l) => `# ${l}\n`).join("");
  if (u.pathname.endsWith("/report")) {
    const svgUrl = await figureDataUrl(result, sel, view, "svg");
    const svg = decodeURIComponent(svgUrl.split(",")[1]);
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    const rows = [...result.snapshot.rows].sort((a, b) => (b.difference_pp ?? 0) - (a.difference_pp ?? 0));
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Frequency comparison report</title>
<style>body{font-family:system-ui,sans-serif;max-width:1100px;margin:24px auto;padding:0 16px;color:#1d2433}table{border-collapse:collapse;width:100%;font-size:14px}td,th{border-bottom:1px solid #ddd;padding:4px 8px;text-align:right}td:first-child,th:first-child{text-align:left}.caveat{background:#fff7e6;border-left:4px solid #e0a200;padding:8px 12px}svg{width:100%;height:auto}</style></head><body>
<h1>Local vs global relative frequency comparison</h1><p class="caveat">${esc(T.caveat)}</p>
<h2>Settings and provenance</h2><ul>${metadataLines(result, sel).map((l) => `<li>${esc(l)}</li>`).join("")}</ul>${svg.slice(svg.indexOf("<svg"))}
<h2>Snapshot: ${esc(String(result.snapshot.label))}</h2><table><tr><th>Taxon</th><th>Local frequency</th><th>Global frequency</th><th>Difference (pp)</th><th>Local N</th><th>Global N</th><th>Present in</th></tr>
${rows.map((r) => `<tr><td>${esc(r.taxon)}</td><td>${pct(r.local_frequency)}</td><td>${pct(r.global_frequency)}</td><td>${r.difference_pp == null ? "" : (r.difference_pp > 0 ? "+" : "") + r.difference_pp.toFixed(1)}</td><td>${r.local_n}</td><td>${r.global_n}</td><td>${r.presence}</td></tr>`).join("")}</table>
<h2>Methods and caveats</h2><ul>${T.caveat_points.map((c: string) => `<li>${esc(c)}</li>`).join("")}<li>${esc(T.alignment)}</li><li>${esc(T.counts)}</li></ul><p><em>${esc(T.footnote)}</em></p></body></html>`;
    return save(new Blob([html], { type: "text/html" }), `${fileBase(result, sel, "report")}.html`);
  }
  if (what === "analysis" || fmt === "json") {
    const payload = { generated: new Date().toISOString(), settings: sel, caveat: T.caveat, caveat_points: T.caveat_points, figure_footnote: T.footnote, result };
    return save(new Blob([JSON.stringify(payload, null, 1)], { type: "application/json" }), `${fileBase(result, sel, "analysis")}.json`);
  }
  const sep = fmt === "tsv" ? "\t" : ",";
  const rows =
    what === "native_trajectories" ? nativeTrajectories(result) : what === "comparison" ? comparison(result) : what === "snapshot" ? result.snapshot.rows : trajectories(result);
  return save(new Blob([table(rows as any, sep, header)], { type: fmt === "tsv" ? "text/tab-separated-values" : "text/csv" }), `${fileBase(result, sel, what || "trajectories")}.${fmt}`);
}
