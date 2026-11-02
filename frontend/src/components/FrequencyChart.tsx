import { useEffect, useRef } from "react";
import Plotly from "plotly.js-dist-min";
import type { CompareResult, Selection } from "../types";

interface Props {
  result: CompareResult;
  sel: Selection;
  highlight: string | null;
  text: Record<string, any>;
  loading: boolean;
}

const FONT = { family: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", size: 12, color: "#1d2433" };

function rgba(hex: string, a: number) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function filtersText(f: Record<string, string[]>) {
  const e = Object.entries(f).filter(([, v]) => v.length);
  return e.length ? e.map(([k, v]) => `${k}=${v.join("|")}`).join("; ") : "none";
}

interface SideData {
  dates: string[];
  freq: (t: string) => (number | null)[] | null;
  num: (t: string) => (number | null)[];
  den: (number | null)[];
  pivot: (string | null)[];
  offset: (number | null)[];
}

/** One build's values: at the shared timepoints (default) or at its own pivots. */
function sideData(result: CompareResult, key: "local" | "global", native: boolean): SideData {
  if (native || !result.aligned?.[key]) {
    const s = result[key];
    return {
      dates: s.dates,
      freq: (t) => s.series[t]?.frequency ?? null,
      num: (t) => s.series[t]?.numerator ?? s.dates.map(() => 0),
      den: s.denominator,
      pivot: s.dates,
      offset: s.dates.map(() => 0),
    };
  }
  const al = result.aligned;
  const a = al[key]!;
  const keep = al.dates.map((_, i) => i).filter((i) => a.present[i]);
  return {
    dates: keep.map((i) => al.dates[i]),
    freq: (t) => (a.series[t] ? keep.map((i) => a.series[t].frequency[i]) : null),
    num: (t) => keep.map((i) => a.series[t]?.numerator[i] ?? 0),
    den: keep.map((i) => a.denominator[i]),
    pivot: keep.map((i) => a.pivot_dates[i]),
    offset: keep.map((i) => a.offset_days[i]),
  };
}

/** Traces and layout for the current view (used by the chart and by website exports). */
export function buildFigure(result: CompareResult, sel: Selection, highlight: string | null, text: Record<string, any>) {
  const native = sel.timeAxis === "native";
    const { taxa, colors } = result;
    const pl = result.provenance.local;
    const pg = result.provenance.global;
    const groupDef =
      sel.grouping === "genotype"
        ? result.provenance.comparison.genotype_definition
        : `${sel.grouping} (JSON field: local ${pl[sel.grouping + "_field"]?.value}, global ${pg[sel.grouping + "_field"]?.value})`;
    const dim = (t: string) => (highlight && highlight !== t ? 0.15 : 1);
    const traces: any[] = [];
    const shownInLegend = new Set<string>();
    const legendOnce = (t: string) => {
      if (shownInLegend.has(t)) return false;
      shownInLegend.add(t);
      return true;
    };
    const sides = {
      local: { d: sideData(result, "local", native), p: pl, name: "JHH local", filters: filtersText(sel.localFilters) },
      global: { d: sideData(result, "global", native), p: pg, name: "Nextstrain global", filters: filtersText(sel.globalFilters) },
    };
    const custom = (key: "local" | "global", t: string) => {
      const { d, p, name, filters } = sides[key];
      const f = d.freq(t) ?? [];
      const n = d.num(t);
      return d.dates.map((_, i) => [
        name,
        t,
        `${((f[i] ?? 0) * 100).toFixed(1)}%`,
        n[i] ?? "–",
        d.den[i] ?? "–",
        p.build_label.value,
        p.updated_date.value,
        filters,
        groupDef,
        native ? "" : d.offset[i] ? `<br>Value from this build's pivot on ${d.pivot[i]} (${d.offset[i]! > 0 ? "+" : ""}${d.offset[i]} days)` : "",
      ]);
    };
    const hover =
      "<b>%{customdata[1]}</b> · %{customdata[0]}<br>%{x|%d %b %Y}%{customdata[9]}<br>" +
      "Relative frequency: %{customdata[2]}<br>" +
      "N in interval: %{customdata[3]} of %{customdata[4]}<br>" +
      "Grouping: %{customdata[8]}<br>" +
      "Build: %{customdata[5]} (updated %{customdata[6]})<br>Filters: %{customdata[7]}<br>" +
      "<i>Composition of the supplied build, not prevalence.</i><extra></extra>";

    // identical x range for both panels: the shared timepoints (or the union of native pivots)
    const allDates = native ? [...sides.local.d.dates, ...sides.global.d.dates].sort() : result.aligned?.dates ?? [];
    const xRange = allDates.length ? [allDates[0], allDates[allDates.length - 1]] : undefined;
    const xCommon = { type: "date", range: xRange, autorange: !xRange, showgrid: true, gridcolor: "#eef0f4", ticks: "outside" };

    const layout: any = {
      font: FONT,
      margin: { l: 64, r: 16, t: 28, b: 44 },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      hovermode: "closest",
      hoverlabel: { font: { ...FONT, size: 12 }, bgcolor: "#fff", bordercolor: "#c9cfdb", align: "left" },
      showlegend: true,
      legend: { orientation: "v", x: 1.01, y: 1, font: { size: 11 }, itemclick: "toggle", itemdoubleclick: "toggleothers", title: { text: sel.grouping === "genotype" ? "Genotype" : sel.grouping === "clade" ? "Clade" : "Subclade" } },
      uirevision: `${sel.localId}|${sel.globalId}|${sel.grouping}|${sel.gene}|${sel.positions.join(",")}|${sel.view}|${sel.timeAxis}|${sel.start}|${sel.end}`,
      shapes: [] as any[],
      annotations: [] as any[],
    };
    const snapX = sel.snapshotMode === "point" && sel.snapshotTime ? sel.snapshotTime : null;

    if (sel.view === "stacked") {
      (["local", "global"] as const).forEach((key) => {
        const { d } = sides[key];
        const ax = key === "local" ? { xaxis: "x2", yaxis: "y2" } : { xaxis: "x", yaxis: "y" };
        taxa.forEach((t) => {
          const f = d.freq(t);
          if (!f) return;
          const c = colors[t] ?? "#999";
          traces.push({
            type: "scatter",
            mode: "lines",
            ...ax,
            x: d.dates,
            y: f,
            name: t,
            legendgroup: t,
            showlegend: legendOnce(t),
            stackgroup: key,
            line: { width: 0.6, color: "#fff" },
            fillcolor: rgba(c, 0.92 * dim(t)),
            hoveron: "points+fills",
            customdata: custom(key, t),
            hovertemplate: hover,
          });
        });
      });
      Object.assign(layout, {
        xaxis: { ...xCommon, anchor: "y", domain: [0, 1], title: { text: native ? "time (global build pivots)" : "time" } },
        xaxis2: native
          ? { ...xCommon, anchor: "y2", domain: [0, 1], showticklabels: true, title: { text: "time (local build pivots)", standoff: 2, font: { size: 11 } } }
          : { ...xCommon, anchor: "y2", matches: "x", showticklabels: false },
        yaxis: { domain: [0, native ? 0.42 : 0.46], range: [0, 1], title: { text: "proportion" }, tickformat: ".0%", gridcolor: "#eef0f4", zeroline: false },
        yaxis2: { domain: [native ? 0.6 : 0.54, 1], range: [0, 1], title: { text: "proportion" }, tickformat: ".0%", gridcolor: "#eef0f4", zeroline: false },
      });
      layout.annotations.push(
        { xref: "paper", yref: "paper", x: 0, y: 1.0, yanchor: "bottom", xanchor: "left", showarrow: false, text: `<b>${text.local_name}</b> · ${pl.build_label.value}`, font: { size: 12, color: "#1f4f99" } },
        { xref: "paper", yref: "paper", x: 0, y: native ? 0.42 : 0.46, yanchor: "bottom", xanchor: "left", showarrow: false, text: `<b>${text.global_name}</b> · ${pg.build_label.value}`, font: { size: 12, color: "#8a4b0f" } },
      );
      if (snapX) {
        for (const yref of ["y", "y2"]) layout.shapes.push({ type: "line", xref: yref === "y" ? "x" : "x2", yref, x0: snapX, x1: snapX, y0: 0, y1: 1, line: { color: "#1d2433", width: 1.2, dash: "dot" } });
      }
    } else if (sel.view === "overlay") {
      (["local", "global"] as const).forEach((key) => {
        const { d } = sides[key];
        taxa.forEach((t) => {
          const f = d.freq(t);
          if (!f) return;
          traces.push({
            type: "scatter",
            mode: "lines",
            x: d.dates,
            y: f,
            name: t,
            legendgroup: t,
            showlegend: legendOnce(t),
            opacity: dim(t),
            line: { color: colors[t] ?? "#999", width: key === "local" ? 2.4 : 2, dash: key === "local" ? "solid" : "dash" },
            customdata: custom(key, t),
            hovertemplate: hover,
          });
        });
      });
      Object.assign(layout, {
        xaxis: { ...xCommon, title: { text: "time" } },
        yaxis: { range: [0, 1], title: { text: "proportion" }, tickformat: ".0%", gridcolor: "#eef0f4" },
      });
      layout.annotations.push({ xref: "paper", yref: "paper", x: 0, y: 1.0, yanchor: "bottom", xanchor: "left", showarrow: false, text: "Solid: JHH local · Dashed: Nextstrain global", font: { size: 12, color: "#4a5263" } });
      if (snapX) layout.shapes.push({ type: "line", xref: "x", yref: "paper", x0: snapX, x1: snapX, y0: 0, y1: 1, line: { color: "#1d2433", width: 1.2, dash: "dot" } });
    } else {
      const d = result.difference;
      let maxAbs = 5;
      taxa.forEach((t) => {
        const ser = d.series[t];
        if (!ser) return;
        ser.difference_pp.forEach((v) => v != null && (maxAbs = Math.max(maxAbs, Math.abs(v))));
        traces.push({
          type: "scatter",
          mode: "lines+markers",
          x: d.dates,
          y: ser.difference_pp,
          name: t,
          legendgroup: t,
          showlegend: legendOnce(t),
          opacity: dim(t),
          line: { color: colors[t] ?? "#999", width: 2 },
          marker: { size: 5 },
          customdata: d.dates.map((m, i) => [
            t,
            m,
            ser.local[i] == null ? "–" : `${(ser.local[i]! * 100).toFixed(1)}%`,
            ser.global[i] == null ? "–" : `${(ser.global[i]! * 100).toFixed(1)}%`,
            ser.local_n[i] ?? "–",
            ser.global_n[i] ?? "–",
          ]),
          hovertemplate:
            "<b>%{customdata[0]}</b> · %{customdata[1]}<br>Difference: %{y:+.1f} percentage points<br>" +
            "JHH local: %{customdata[2]} (N %{customdata[4]})<br>Nextstrain global: %{customdata[3]} (N %{customdata[5]})<extra></extra>",
        });
      });
      const lim = maxAbs * 1.15;
      Object.assign(layout, {
        xaxis: { ...xCommon, range: d.dates.length ? [d.dates[0], d.dates[d.dates.length - 1]] : undefined, title: { text: "shared timepoints" } },
        yaxis: { range: [-lim, lim], title: { text: "local − global (percentage points)" }, gridcolor: "#eef0f4", zeroline: true, zerolinecolor: "#1d2433", zerolinewidth: 1.2 },
      });
      layout.shapes.push(
        { type: "rect", xref: "paper", yref: "y", x0: 0, x1: 1, y0: 0, y1: lim, fillcolor: "rgba(31,79,153,0.04)", line: { width: 0 }, layer: "below" },
        { type: "rect", xref: "paper", yref: "y", x0: 0, x1: 1, y0: -lim, y1: 0, fillcolor: "rgba(138,75,15,0.05)", line: { width: 0 }, layer: "below" },
      );
      layout.annotations.push(
        { xref: "paper", yref: "paper", x: 0.005, y: 0.99, xanchor: "left", yanchor: "top", showarrow: false, text: `▲ ${text.positive}`, font: { size: 11, color: "#1f4f99" } },
        { xref: "paper", yref: "paper", x: 0.005, y: 0.01, xanchor: "left", yanchor: "bottom", showarrow: false, text: `▼ ${text.negative}`, font: { size: 11, color: "#8a4b0f" } },
      );
      if (snapX) layout.shapes.push({ type: "line", xref: "x", yref: "paper", x0: snapX, x1: snapX, y0: 0, y1: 1, line: { color: "#1d2433", width: 1.2, dash: "dot" } });
    }
  return { traces, layout };
}

export default function FrequencyChart({ result, sel, highlight, text, loading }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const native = sel.timeAxis === "native";

  useEffect(() => {
    if (!el.current) return;
    const { traces, layout } = buildFigure(result, sel, highlight, text);
    Plotly.react(el.current, traces, layout, {
      responsive: true,
      displaylogo: false,
      modeBarButtonsToRemove: ["lasso2d", "select2d", "toImage"],
    });
  }, [result, sel.view, sel.grouping, sel.snapshotMode, sel.snapshotTime, highlight, text, sel.localFilters, sel.globalFilters, sel.localId, sel.globalId, sel.gene, sel.positions, sel.timeAxis, sel.start, sel.end, native]);

  useEffect(() => {
    const node = el.current;
    return () => {
      if (node) Plotly.purge(node);
    };
  }, []);

  const al = result.alignment;
  return (
    <div className={`chart-wrap ${loading ? "busy" : ""}`}>
      <div ref={el} className="chart" data-testid="frequency-chart" />
      {[...result.notes, ...result.local.notes, ...result.global.notes].map((n, i) => (
        <p key={i} className="hint warn">
          {n}
        </p>
      ))}
      <div className="chart-notes">
        {!native && al?.reference && (
          <span data-testid="alignment-note" title="Hover a point for the exact pivot date used">
            Both panels use the same timepoints ({al.reference === "local" ? "JHH local" : "Nextstrain global"} pivots, {al.step})
            {al.max_offset_days?.[al.reference === "local" ? "global" : "local"] != null &&
              `; ${al.reference === "local" ? "global" : "local"} values from its nearest pivot, ≤ ${al.max_offset_days[al.reference === "local" ? "global" : "local"]} days away`}
            .
          </span>
        )}
        {native && (
          <span className="warn">
            Native pivots: each panel at its own pivot dates (local every {al?.local_spacing_days ?? "?"} days, global every {al?.global_spacing_days ?? "?"} days), so points do not line up exactly.
          </span>
        )}
        {result.grouped_into_other.length > 0 && (
          <span title={result.grouped_into_other.join(", ")}>
            “Other” = {result.grouped_into_other.length} less frequent taxa: {result.grouped_into_other.join(", ")}.
          </span>
        )}
      </div>
    </div>
  );
}
