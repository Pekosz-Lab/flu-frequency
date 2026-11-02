import { useEffect, useRef, useState } from "react";
import embed from "vega-embed";
import type { View as VegaView } from "vega";
import type { CompareResult, Selection } from "../types";

/** Charts are Vega-Lite specs: the grammar Altair writes. `buildSpec` returns plain JSON, so a figure can be
 *  saved and reopened in Python with `altair.Chart.from_dict(spec)` or in the Vega editor. */

export const LOCAL = "#1f4f99";
export const GLOBAL = "#8a4b0f";
const INK = "#1d2433";
const MUTED = "#5f687a";
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const SIDE_NAME = { local: "JHH local", global: "Nextstrain global" } as const;

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

const pct = (x: number | null | undefined) => (x == null ? "–" : `${(x * 100).toFixed(1)}%`);
const pp = (x: number | null | undefined) => (x == null ? "" : ` (${x > 0 ? "+" : ""}${x.toFixed(1)} pp)`);
const fmtDate = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export interface SpecOptions {
  width: number; // pixels available for the whole figure
  compact: boolean; // phone layout
  highlight?: string | null;
}

/** Vega-Lite spec for the current view. Returns the parts so exports can wrap it with a caption. */
export function buildSpec(result: CompareResult, sel: Selection, text: Record<string, any>, o: SpecOptions) {
  const native = sel.timeAxis === "native";
  const { taxa, colors } = result;
  const order = new Map(taxa.map((t, i) => [t, i]));
  const colorScale = { domain: taxa, range: taxa.map((t) => colors[t] ?? "#999") };
  const groupLabel = sel.grouping === "genotype" ? "Genotype" : sel.grouping === "clade" ? "Clade" : "Subclade";
  const pl = result.provenance.local;
  const pg = result.provenance.global;
  const sides = { local: sideData(result, "local", native), global: sideData(result, "global", native) };
  const allDates = native ? [...sides.local.dates, ...sides.global.dates].sort() : result.aligned?.dates ?? [];
  const xDomain = allDates.length ? [allDates[0], allDates[allDates.length - 1]] : undefined;
  const snapX = sel.snapshotMode === "point" && sel.snapshotTime ? sel.snapshotTime : null;
  const legendRight = !o.compact;
  // plot width: room for the y axis, and for the legend when it sits on the right
  const plotW = Math.max(220, Math.round(o.width - (legendRight ? 200 : 70)));
  const dim = { test: "hl == null || datum.taxon == hl" };

  // "local vs global" readout for every taxon at each shared timepoint (crosshair tooltip)
  const d = result.difference;
  const keyOf = (j: number) => `k${j}`; // taxon names contain dots, which Vega-Lite reads as nested fields
  const hoverRows = d.dates.map((date, i) => {
    const row: Record<string, any> = { date, when: fmtDate(date) };
    taxa.forEach((t, j) => {
      const s = d.series[t];
      row[keyOf(j)] = s ? `${pct(s.local[i])} vs ${pct(s.global[i])}${pp(s.difference_pp[i])}` : "–";
    });
    return row;
  });
  const hoverTooltip = [{ field: "when", title: "Local vs global" }, ...taxa.map((t, j) => ({ field: keyOf(j), title: t }))];
  const hoverLayer = (name: string) => ({
    name,
    data: { name: "hover" },
    mark: { type: "rule", color: INK, strokeWidth: 1.2 },
    encoding: {
      x: { field: "date", type: "temporal" },
      opacity: { condition: { param: "hover", empty: false, value: 0.55 }, value: 0 },
      tooltip: hoverTooltip,
    },
  });
  const snapLayer = snapX
    ? [{ data: { values: [{ date: snapX }] }, mark: { type: "rule", color: INK, strokeDash: [5, 4], strokeWidth: 1.6 }, encoding: { x: { field: "date", type: "temporal" } } }]
    : [];
  const xAxis = (title: string | null, labels = true) => ({
    field: "date",
    type: "temporal",
    scale: xDomain ? { domain: xDomain } : {},
    axis: { title, format: "%b %Y", tickCount: o.compact ? 4 : 8, labels, grid: true, gridColor: "#eef0f4", labelFlush: true },
  });
  const taxonLegend = {
    title: groupLabel,
    orient: legendRight ? "right" : "bottom",
    columns: legendRight ? 1 : 3,
    symbolType: "square",
    symbolSize: 140,
  };
  const legendParam = { name: "legend_pick", select: { type: "point", fields: ["taxon"] }, bind: "legend" };
  const datasets: Record<string, any[]> = { hover: hoverRows };
  const params: any[] = [{ name: "hl", value: o.highlight ?? null }];
  let body: any;

  if (sel.view === "stacked") {
    const panelH = o.compact ? 200 : 235;
    const panel = (key: "local" | "global") => {
      const s = sides[key];
      const rows: any[] = [];
      for (const t of taxa) {
        const f = s.freq(t);
        if (!f) continue;
        const n = s.num(t);
        s.dates.forEach((date, i) =>
          rows.push({
            date,
            taxon: t,
            o: order.get(t),
            freq: f[i] ?? 0,
            n: n[i] ?? 0,
            den: s.den[i] ?? 0,
            note: !native && s.offset[i] ? `from this build's pivot on ${s.pivot[i]} (${s.offset[i]! > 0 ? "+" : ""}${s.offset[i]} days)` : "",
          }),
        );
      }
      datasets[key] = rows;
      const p = key === "local" ? pl : pg;
      return {
        title: {
          text: SIDE_NAME[key],
          subtitle: p.build_label?.value ?? "",
          color: key === "local" ? LOCAL : GLOBAL,
          fontSize: o.compact ? 16 : 18,
          subtitleFontSize: 12.5,
          subtitleColor: MUTED,
          anchor: "start",
          offset: 8,
        },
        width: plotW,
        height: panelH,
        layer: [
          {
            name: `${key}_area`,
            data: { name: key },
            ...(key === "local" ? { params: [legendParam] } : {}),
            mark: { type: "area", stroke: "#fff", strokeWidth: 0.5, cursor: "pointer" },
            encoding: {
              x: xAxis(native ? `time (${SIDE_NAME[key]} pivots)` : key === "global" ? null : null, key === "global" || native),
              y: { field: "freq", type: "quantitative", stack: "zero", scale: { domain: [0, 1] }, axis: { title: "Relative frequency", format: "%", tickCount: 5, gridColor: "#eef0f4" } },
              color: { field: "taxon", type: "nominal", scale: colorScale, sort: taxa, legend: taxonLegend },
              order: { field: "o", type: "quantitative" },
              opacity: { condition: { ...dim, value: 0.94 }, value: 0.18 },
              tooltip: [
                { field: "taxon", title: groupLabel },
                { field: "date", type: "temporal", title: SIDE_NAME[key], format: "%d %b %Y" },
                { field: "freq", type: "quantitative", title: "Relative frequency", format: ".1%" },
                { field: "n", title: "N in interval" },
                { field: "den", title: "of" },
                { field: "note", title: "Note" },
              ],
            },
          },
          hoverLayer(`${key}_hover`),
          ...snapLayer,
        ],
      };
    };
    body = { vconcat: [panel("local"), panel("global")], spacing: 22, resolve: { scale: { x: native ? "independent" : "shared" } } };
    params.push({ name: "hover", select: { type: "point", fields: ["date"], nearest: true, on: "pointerover", clear: "pointerout" }, views: ["local_hover", "global_hover"] });
  } else if (sel.view === "overlay") {
    // one small panel per taxon: JHH local (solid) against Nextstrain global (dashed), the gap between them shaded
    const rows: any[] = [];
    for (const key of ["local", "global"] as const) {
      const s = sides[key];
      for (const t of taxa) {
        const f = s.freq(t);
        if (!f) continue;
        s.dates.forEach((date, i) => f[i] != null && rows.push({ kind: "line", taxon: t, side: SIDE_NAME[key], date, freq: f[i] }));
      }
    }
    for (const t of taxa) {
      const s = d.series[t];
      if (!s) continue;
      d.dates.forEach((date, i) => {
        if (s.local[i] == null || s.global[i] == null) return;
        rows.push({
          kind: "band",
          taxon: t,
          date,
          l: s.local[i],
          g: s.global[i],
          dpp: s.difference_pp[i],
          nl: s.local_n[i],
          ng: s.global_n[i],
        });
      });
      if (snapX) rows.push({ kind: "snap", taxon: t, date: snapX });
    }
    datasets.bytaxon = rows;
    const cols = o.compact ? (o.width < 420 ? 1 : 2) : o.width > 1150 ? 4 : 3;
    const gap = 22;
    const cellW = Math.max(150, Math.floor((o.width - 60 - (cols - 1) * (gap + 46)) / cols));
    const x = { field: "date", type: "temporal", scale: xDomain ? { domain: xDomain } : {}, axis: { title: null, format: "%b %y", tickCount: 4, labelFontSize: 11, grid: true, gridColor: "#eef0f4" } };
    const y = { type: "quantitative", axis: { title: null, format: "%", tickCount: 4, labelFontSize: 11, gridColor: "#eef0f4" } };
    const fade = { condition: { ...dim, value: 1 }, value: 0.22 };
    body = {
      data: { name: "bytaxon" },
      facet: { field: "taxon", type: "nominal", sort: taxa, header: { title: null, labelFontSize: 14, labelFontWeight: "bold", labelAnchor: "start", labelColor: INK, labelPadding: 4 } },
      columns: cols,
      spacing: { row: 18, column: gap },
      resolve: { scale: { y: "independent" } },
      spec: {
        width: cellW,
        height: o.compact ? 120 : 130,
        layer: [
          {
            transform: [{ filter: "datum.kind == 'band'" }],
            mark: { type: "area", cursor: "pointer" },
            encoding: { x, y: { ...y, field: "l" }, y2: { field: "g" }, fill: { field: "taxon", type: "nominal", scale: colorScale, legend: null }, opacity: { condition: { ...dim, value: 0.3 }, value: 0.07 } },
          },
          {
            transform: [{ filter: "datum.kind == 'line'" }],
            mark: { type: "line", strokeWidth: 2.4, cursor: "pointer" },
            encoding: {
              x,
              y: { ...y, field: "freq" },
              color: { field: "side", type: "nominal", scale: { domain: [SIDE_NAME.local, SIDE_NAME.global], range: [LOCAL, GLOBAL] }, legend: { title: null, orient: "top", labelFontSize: 14, symbolStrokeWidth: 3, symbolSize: 300 } },
              strokeDash: { field: "side", type: "nominal", scale: { domain: [SIDE_NAME.local, SIDE_NAME.global], range: [[1, 0], [6, 4]] }, legend: null },
              opacity: fade,
            },
          },
          {
            transform: [{ filter: "datum.kind == 'band'" }],
            params: [{ name: "hover", select: { type: "point", fields: ["date"], nearest: true, on: "pointerover", clear: "pointerout" } }],
            mark: { type: "rule", color: INK, strokeWidth: 1.1 },
            encoding: {
              x,
              opacity: { condition: { param: "hover", empty: false, value: 0.5 }, value: 0 },
              tooltip: [
                { field: "taxon", title: groupLabel },
                { field: "date", type: "temporal", title: "Timepoint", format: "%d %b %Y" },
                { field: "l", type: "quantitative", title: SIDE_NAME.local, format: ".1%" },
                { field: "g", type: "quantitative", title: SIDE_NAME.global, format: ".1%" },
                { field: "dpp", type: "quantitative", title: "Local − global (pp)", format: "+.1f" },
                { field: "nl", title: "Local N" },
                { field: "ng", title: "Global N" },
              ],
            },
          },
          ...(snapX ? [{ transform: [{ filter: "datum.kind == 'snap'" }], mark: { type: "rule", color: INK, strokeDash: [5, 4], strokeWidth: 1.4 }, encoding: { x } }] : []),
        ],
      },
    };
  } else {
    const rows: any[] = [];
    let maxAbs = 5;
    for (const t of taxa) {
      const s = d.series[t];
      if (!s) continue;
      d.dates.forEach((date, i) => {
        const v = s.difference_pp[i];
        if (v == null) return;
        maxAbs = Math.max(maxAbs, Math.abs(v));
        rows.push({ taxon: t, date, dpp: v, l: s.local[i], g: s.global[i], nl: s.local_n[i], ng: s.global_n[i] });
      });
    }
    datasets.diff = rows;
    const lim = Math.ceil(maxAbs * 1.12);
    const dx = { ...xAxis("Shared timepoints"), scale: d.dates.length ? { domain: [d.dates[0], d.dates[d.dates.length - 1]] } : {} };
    const yScale = { domain: [-lim, lim] };
    body = {
      width: plotW,
      height: o.compact ? 300 : 430,
      layer: [
        { data: { values: [{ a: 0, b: lim }] }, mark: { type: "rect", color: LOCAL, opacity: 0.05 }, encoding: { y: { field: "a", type: "quantitative", scale: yScale }, y2: { field: "b" } } },
        { data: { values: [{ a: -lim, b: 0 }] }, mark: { type: "rect", color: GLOBAL, opacity: 0.06 }, encoding: { y: { field: "a", type: "quantitative", scale: yScale }, y2: { field: "b" } } },
        { data: { values: [{ z: 0 }] }, mark: { type: "rule", color: INK, strokeWidth: 1.3 }, encoding: { y: { field: "z", type: "quantitative", scale: yScale } } },
        {
          data: { name: "diff" },
          params: [legendParam],
          mark: { type: "line", strokeWidth: 2.4, point: { size: 36, filled: true }, cursor: "pointer" },
          encoding: {
            x: dx,
            y: { field: "dpp", type: "quantitative", scale: yScale, axis: { title: "Local − global (percentage points)", tickCount: 8, gridColor: "#eef0f4" } },
            color: { field: "taxon", type: "nominal", scale: colorScale, sort: taxa, legend: taxonLegend },
            opacity: { condition: { ...dim, value: 1 }, value: 0.15 },
            tooltip: [
              { field: "taxon", title: groupLabel },
              { field: "date", type: "temporal", title: "Timepoint", format: "%d %b %Y" },
              { field: "dpp", type: "quantitative", title: "Local − global (pp)", format: "+.1f" },
              { field: "l", type: "quantitative", title: SIDE_NAME.local, format: ".1%" },
              { field: "g", type: "quantitative", title: SIDE_NAME.global, format: ".1%" },
              { field: "nl", title: "Local N" },
              { field: "ng", title: "Global N" },
            ],
          },
        },
        { ...hoverLayer("diff_hover"), params: [{ name: "hover", select: { type: "point", fields: ["date"], nearest: true, on: "pointerover", clear: "pointerout" } }] },
        ...snapLayer,
      ],
    };
  }

  const config = {
    font: FONT,
    view: { stroke: null },
    axis: { labelFontSize: o.compact ? 11.5 : 12.5, titleFontSize: 13, titleFontWeight: 600, titleColor: MUTED, labelColor: INK, domainColor: "#c9cfdb", tickColor: "#c9cfdb" },
    legend: { labelFontSize: o.compact ? 12.5 : 13.5, titleFontSize: 13, titleFontWeight: 700, titleColor: MUTED, labelLimit: 220, rowPadding: 5 },
    title: { font: FONT, fontWeight: 700 },
    header: { labelFont: FONT },
  };
  return { body, datasets, params, config, text };
}

/** The complete spec as shown on screen. */
export function screenSpec(result: CompareResult, sel: Selection, text: Record<string, any>, o: SpecOptions) {
  const { body, datasets, params, config } = buildSpec(result, sel, text, o);
  return { $schema: "https://vega.github.io/schema/vega-lite/v6.json", ...body, params: [...(body.params ?? []), ...params], datasets, config, padding: { left: 4, right: 4, top: 4, bottom: 4 }, autosize: { type: "pad" } };
}

interface Props {
  result: CompareResult;
  sel: Selection;
  highlight: string | null;
  setHighlight: (t: string | null) => void;
  text: Record<string, any>;
  loading: boolean;
}

export default function FrequencyChart({ result, sel, highlight, setHighlight, text, loading }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const el = useRef<HTMLDivElement>(null);
  const view = useRef<VegaView | null>(null);
  const hl = useRef(highlight);
  hl.current = highlight;
  const setHl = useRef(setHighlight);
  setHl.current = setHighlight;
  const [width, setWidth] = useState(0);
  const taxaRef = useRef(result.taxa);
  taxaRef.current = result.taxa;
  const native = sel.timeAxis === "native";

  // follow the container width (desktop window resizes, phone rotation)
  useEffect(() => {
    const node = wrap.current;
    if (!node) return;
    let t = 0;
    const ro = new ResizeObserver(([e]) => {
      window.clearTimeout(t);
      t = window.setTimeout(() => setWidth(Math.round(e.contentRect.width)), 80);
    });
    ro.observe(node);
    setWidth(Math.round(node.getBoundingClientRect().width));
    return () => {
      ro.disconnect();
      window.clearTimeout(t);
    };
  }, []);

  useEffect(() => {
    if (!el.current || !width) return;
    let cancelled = false;
    const spec = screenSpec(result, sel, text, { width, compact: width < 640, highlight: hl.current });
    embed(el.current, spec as any, { actions: false, renderer: "svg", tooltip: { theme: "light" } }).then((res) => {
      if (cancelled) return res.finalize();
      view.current?.finalize();
      view.current = res.view;
      (el.current as any).__view = res.view; // used by the end-to-end tests
      res.view.addEventListener("click", (_e: any, item: any) => {
        const datum = item?.datum;
        const role: string = item?.mark?.role ?? "";
        const t: string | undefined = role.startsWith("legend") ? datum?.value : datum?.taxon;
        if (t && typeof t === "string" && taxaRef.current.includes(t)) setHl.current(hl.current === t ? null : t);
        else if (!item) setHl.current(null);
      });
    });
    return () => {
      cancelled = true;
    };
    // highlight is applied through a signal below, without rebuilding the chart
  }, [result, sel.view, sel.grouping, sel.snapshotMode, sel.snapshotTime, text, sel.localId, sel.globalId, sel.gene, sel.positions, sel.timeAxis, sel.start, sel.end, width]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    try {
      v.signal("hl", highlight ?? null).runAsync();
    } catch {
      /* chart not ready */
    }
  }, [highlight]);

  useEffect(
    () => () => {
      view.current?.finalize();
    },
    [],
  );

  const al = result.alignment;
  return (
    <div className={`chart-wrap ${loading ? "busy" : ""}`} ref={wrap}>
      {sel.view === "difference" && (
        <div className="diff-key">
          <span className="k-local">▲ Above 0: higher in JHH local</span>
          <span className="k-global">▼ Below 0: higher in Nextstrain global</span>
        </div>
      )}
      <div ref={el} className={`chart view-${sel.view}`} data-testid="frequency-chart" />
      {[...result.notes, ...result.local.notes, ...result.global.notes].map((n, i) => (
        <p key={i} className="hint warn">
          {n}
        </p>
      ))}
      <div className="chart-notes">
        <span className="chart-tip">Hover to compare local vs global at a timepoint · click a colour or the legend to highlight a taxon</span>
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
