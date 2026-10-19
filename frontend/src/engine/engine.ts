// In-browser comparison engine: a port of ffc/engine.py that works on builds
// parsed in the browser (build.ts). Responses have the same shape as the local
// app's API, so the same dashboard UI renders both.
import { greyRamp, INVALID_STRINGS, nationalColors, UNKNOWN_COLOR } from "./colors";
import { addMonthsClamped, DAY_MS, isoOfMs, msOfIso } from "./dates";
import { genotypes, type Build } from "./build";
import CONFIG from "./web-config.json";

void greyRamp;
export const OTHER = "Other";
export const NOT_ASSIGNED = "Not assigned";
const OTHER_COLOR = "#E4E6EA";
const NOT_ASSIGNED_COLOR = UNKNOWN_COLOR;
const COLORBLIND_PALETTE = [
  "#0072B2", "#E69F00", "#009E73", "#CC79A7", "#56B4E9", "#D55E00", "#F0E442",
  "#332288", "#88CCEE", "#44AA99", "#117733", "#999933", "#DDCC77", "#CC6677",
  "#882255", "#AA4499", "#77AADD", "#EE8866", "#AAAA00", "#99DDFF",
];
const T = CONFIG.text;
const SUBTYPE_LABEL: Record<string, string> = Object.fromEntries(CONFIG.subtypes.map((s) => [s.id, s.label]));
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface CompareReq {
  local_build_id: string;
  global_build_id: string;
  grouping?: "clade" | "subclade" | "genotype";
  genotype?: { gene: string; positions: number[] } | null;
  local_filters?: Record<string, string[]>;
  global_filters?: Record<string, string[]>;
  shared_filters?: Record<string, string[]>;
  start?: string | null;
  end?: string | null;
  top_n?: number;
  snapshot?: { mode?: "range" | "point"; timepoint?: string | null };
  palette?: "nextstrain" | "colorblind";
  include_projection?: boolean;
}

interface Row {
  pivot_idx: number;
  date: string;
  month: string;
  is_projection: boolean;
  taxon: string;
  frequency: number;
  numerator: number;
  denominator: number;
}

interface Query {
  b: Build;
  grouping: string;
  geno: { gene: string; positions: number[] } | null;
  clauses: [string, string[]][];
}

const genoDef = (g: { gene: string; positions: number[] }) =>
  `${g.gene} position${g.positions.length > 1 ? "s" : ""} ${g.positions.join(", ")}`;

// ------------------------------------------------------------------ taxa & frequencies
function includedTips(q: Query): number[] {
  let keep = null as Set<number> | null;
  for (const [field, values] of q.clauses) {
    if (!values.length) continue;
    const idx = q.b.fieldIndex.get(field);
    const s = new Set<number>();
    if (idx) for (const v of values) for (const k of idx.get(String(v)) ?? []) s.add(k);
    keep = keep ? new Set([...keep].filter((k: number) => s.has(k))) : s;
  }
  return keep ? [...keep].sort((a, b) => a - b) : q.b.tips.map((_, k) => k);
}

function taxonFn(q: Query): [(k: number) => string, string[]] {
  const b = q.b;
  const notes: string[] = [];
  if (q.grouping === "clade" || q.grouping === "subclade") {
    const f = q.grouping === "clade" ? b.cladeField : b.subcladeField;
    return [
      (k) => {
        const v = f ? b.nodes[b.tips[k]].attrs[f] : undefined;
        if (v === undefined || v === null) return NOT_ASSIGNED;
        const s = String(v);
        return INVALID_STRINGS.has(s.toLowerCase()) ? NOT_ASSIGNED : s;
      },
      notes,
    ];
  }
  const g = q.geno;
  if (!g || !g.positions.length) throw new Error("Genotype grouping needs a gene and at least one position.");
  const gd = genotypes(b);
  const states: [number, string][] = [];
  const unknown: number[] = [];
  for (const p of g.positions) {
    const r = gd.roots[g.gene]?.get(p);
    const rs = b.rootSeq?.[g.gene];
    if (r !== undefined) states.push([p, r]);
    else if (typeof rs === "string" && p > 0 && p <= rs.length) states.push([p, rs[p - 1].toUpperCase()]);
    else {
      states.push([p, "?"]);
      unknown.push(p);
    }
  }
  if (unknown.length)
    notes.push(
      `Position(s) ${unknown.join(", ")} of ${g.gene} show no variation in this build and the build JSON has no root sequence, so the state is not available in the source JSON (shown as '?').`,
    );
  return [(k) => states.map(([p, root]) => `${p}${gd.tipStates[k][g.gene]?.get(p) ?? root}`).join(" "), notes];
}

function frequencies(q: Query): [Row[], { tips_included: number; notes: string[]; served_from: string }] {
  const b = q.b;
  const tips = includedTips(q);
  const [taxon, notes] = taxonFn(q);
  const tx = new Map(tips.map((k) => [k, taxon(k)]));
  const np = b.pivots.length;
  const w = new Map<string, Float64Array>();
  const seen = new Map<string, Uint8Array>();
  for (const k of tips) {
    const wk = b.weights[k];
    if (!wk) continue;
    const t = tx.get(k)!;
    if (!w.has(t)) {
      w.set(t, new Float64Array(np));
      seen.set(t, new Uint8Array(np));
    }
    const acc = w.get(t)!, s = seen.get(t)!;
    for (let p = 0; p < np; p++)
      if (wk[p] > 1e-9) {
        acc[p] += wk[p];
        s[p] = 1;
      }
  }
  const tot = new Float64Array(np);
  for (const [t, acc] of w) for (let p = 0; p < np; p++) if (seen.get(t)![p]) tot[p] += acc[p];
  const cnt = new Map<string, number>();
  const cntTot = new Float64Array(np);
  for (const k of tips) {
    const p = b.pivotBin[k];
    if (p < 0) continue;
    const key = `${p}\u0000${tx.get(k)}`;
    cnt.set(key, (cnt.get(key) ?? 0) + 1);
    cntTot[p] += 1;
  }
  const rows: Row[] = [];
  for (let p = 0; p < np; p++) {
    if (!(tot[p] > 0)) continue;
    for (const [t, acc] of [...w.entries()].sort((a, c) => cmp(a[0], c[0]))) {
      if (!seen.get(t)![p]) continue;
      rows.push({
        pivot_idx: p,
        date: b.pivotIso[p],
        month: b.pivotMonth[p],
        is_projection: b.isProjection[p],
        taxon: t,
        frequency: acc[p] / tot[p],
        numerator: cnt.get(`${p}\u0000${t}`) ?? 0,
        denominator: cntTot[p],
      });
    }
  }
  return [rows, { tips_included: tips.length, notes, served_from: "computed in browser" }];
}

function allTaxa(builds: Build[], grouping: string, geno: Query["geno"]): string[] {
  const s = new Set<string>();
  for (const b of builds) {
    const [fn] = taxonFn({ b, grouping, geno, clauses: [] });
    b.tips.forEach((_, k) => s.add(fn(k)));
  }
  return [...s].sort();
}

// ------------------------------------------------------------------ alignment (port of Engine.align)
interface PivotRow {
  pivot_idx: number;
  ms: number;
}

const pivotRows = (b: Build, includeProjection: boolean): PivotRow[] =>
  b.pivots.map((_, i) => ({ pivot_idx: i, ms: msOfIso(b.pivotIso[i]) })).filter((p) => includeProjection || !b.isProjection[p.pivot_idx]);

function spacingDays(ms: number[]): number {
  if (ms.length < 2) return 30;
  const s = [...ms].sort((a, b) => a - b);
  const d = s.slice(1).map((v, i) => (v - s[i]) / DAY_MS).sort((a, b) => a - b);
  const n = d.length;
  return n % 2 ? d[(n - 1) / 2] : (d[n / 2 - 1] + d[n / 2]) / 2;
}

interface GridInfo {
  reference: "local" | "global" | null;
  step_days: number | null;
  step?: string;
  local_spacing_days?: number | null;
  global_spacing_days?: number | null;
  max_offset_days?: { local: number | null; global: number | null };
  method?: string;
}

function buildGrid(lp: PivotRow[], gp: PivotRow[]): [number[], GridInfo] {
  const ls = spacingDays(lp.map((p) => p.ms)), gs = spacingDays(gp.map((p) => p.ms));
  if (!lp.length && !gp.length) return [[], { reference: null, step_days: null }];
  const ref: "local" | "global" = !lp.length || (gp.length && gs > 1.5 * ls) ? "global" : "local";
  const [refp, other] = ref === "local" ? [lp, gp] : [gp, lp];
  const step = spacingDays(refp.map((p) => p.ms));
  const monthly = step >= 26 && step <= 35;
  const anchor = refp[0].ms;
  const at = (k: number) => (monthly ? addMonthsClamped(anchor, k) : anchor + Math.round(step) * k * DAY_MS);
  const grid = refp.map((p) => p.ms);
  if (other.length) {
    const tol = (0.5 * spacingDays(other.map((p) => p.ms)) + 0.5) * DAY_MS;
    const lo = Math.min(...other.map((p) => p.ms)) - tol, hi = Math.max(...other.map((p) => p.ms)) + tol;
    for (let k = -1; ; k--) {
      const d = at(k);
      if (d < lo) break;
      if (d < grid[0]) grid.unshift(d);
    }
    for (let k = refp.length; ; k++) {
      const d = at(k);
      if (d > hi) break;
      if (d > grid[grid.length - 1]) grid.push(d);
    }
  }
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return [grid, {
    reference: ref,
    step_days: r1(step),
    step: monthly ? "monthly" : `every ${Math.round(step)} days`,
    local_spacing_days: lp.length ? r1(ls) : null,
    global_spacing_days: gp.length ? r1(gs) : null,
  }];
}

function matchGrid(grid: number[], piv: PivotRow[]): [number[], (number | null)[]] {
  const out = grid.map(() => -1);
  const dist: (number | null)[] = grid.map(() => null);
  if (!piv.length || !grid.length) return [out, dist];
  const pd = piv.map((p) => p.ms);
  const tol = 0.5 * spacingDays(pd) + 0.5;
  const best = new Map<number, [number, number]>();
  grid.forEach((g, i) => {
    let lo = 0, hi = pd.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pd[mid] < g) lo = mid + 1;
      else hi = mid;
    }
    const cands = [lo - 1, lo].filter((j) => j >= 0 && j < pd.length);
    if (!cands.length) return;
    const j = cands.reduce((a, c) => (Math.abs(pd[c] - g) < Math.abs(pd[a] - g) ? c : a), cands[0]);
    const d = (pd[j] - g) / DAY_MS;
    if (Math.abs(d) <= tol && (!best.has(j) || Math.abs(d) < Math.abs(best.get(j)![1]))) {
      if (best.has(j)) {
        out[best.get(j)![0]] = -1;
        dist[best.get(j)![0]] = null;
      }
      best.set(j, [i, d]);
      out[i] = piv[j].pivot_idx;
      dist[i] = d;
    }
  });
  return [out, dist];
}

export interface Aligned {
  grid: number[];
  rows: {
    gi: number;
    grid_ms: number;
    taxon: string;
    frequency_local: number | null;
    frequency_global: number | null;
    numerator_local: number;
    numerator_global: number;
    denominator_local: number;
    denominator_global: number;
    in_local: boolean;
    in_global: boolean;
    both: boolean;
    pivot_date_local: string | null;
    pivot_date_global: string | null;
    offset_days_local: number | null;
    offset_days_global: number | null;
    difference_pp: number | null;
  }[];
  info: GridInfo;
}

function align(ldf: Row[], gdf: Row[], lb: Build, gb: Build, lp: PivotRow[], gp: PivotRow[]): Aligned {
  const [grid, info] = buildGrid(lp, gp);
  const g = grid.length;
  if (!g) return { grid, rows: [], info };
  const edges: number[] = [];
  if (g === 1) {
    const half = (info.step_days ?? 30) * 0.5 * DAY_MS;
    edges.push(grid[0] - half, grid[0] + half);
  } else {
    edges.push(grid[0] - (grid[1] - grid[0]) / 2);
    for (let i = 0; i < g - 1; i++) edges.push(grid[i] + (grid[i + 1] - grid[i]) / 2);
    edges.push(grid[g - 1] + (grid[g - 1] - grid[g - 2]) / 2);
  }
  const side = (df: Row[], piv: PivotRow[], b: Build) => {
    const [match, dist] = matchGrid(grid, piv);
    const present = new Set(df.map((r) => r.pivot_idx));
    const pres = match.map((m) => m >= 0 && present.has(m));
    const byPivot = new Map<number, Row[]>();
    for (const r of df) {
      if (!byPivot.has(r.pivot_idx)) byPivot.set(r.pivot_idx, []);
      byPivot.get(r.pivot_idx)!.push(r);
    }
    const freq = new Map<string, number>(); // `${gi}|${taxon}`
    match.forEach((m, gi) => {
      if (m < 0) return;
      for (const r of byPivot.get(m) ?? []) freq.set(`${gi}\u0000${r.taxon}`, r.frequency);
    });
    const interval = new Map<number, number>();
    for (const p of piv) {
      let lo = 0, hi = edges.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (edges[mid] <= p.ms) lo = mid + 1;
        else hi = mid;
      }
      interval.set(p.pivot_idx, lo - 1);
    }
    const num = new Map<string, number>();
    const den = new Map<number, number>();
    const denSeen = new Set<number>();
    for (const r of df) {
      const gi = interval.get(r.pivot_idx);
      if (gi === undefined || gi < 0 || gi >= g) continue;
      const key = `${gi}\u0000${r.taxon}`;
      num.set(key, (num.get(key) ?? 0) + r.numerator);
      if (!denSeen.has(r.pivot_idx)) {
        denSeen.add(r.pivot_idx);
        den.set(gi, (den.get(gi) ?? 0) + r.denominator);
      }
    }
    const pdate = match.map((m) => (m >= 0 ? b.pivotIso[m] : null));
    return { freq, num, den, pres, pdate, dist };
  };
  const L = side(ldf, lp, lb), G = side(gdf, gp, gb);
  const keys = new Set<string>([...L.freq.keys(), ...G.freq.keys(), ...L.num.keys(), ...G.num.keys()]);
  const rows: Aligned["rows"] = [];
  for (const key of keys) {
    const [gis, taxon] = key.split("\u0000");
    const gi = +gis;
    const inL = L.pres[gi], inG = G.pres[gi];
    if (!inL && !inG) continue;
    const fl = inL ? L.freq.get(key) ?? 0 : null;
    const fg = inG ? G.freq.get(key) ?? 0 : null;
    const both = inL && inG;
    rows.push({
      gi,
      grid_ms: grid[gi],
      taxon,
      frequency_local: fl,
      frequency_global: fg,
      numerator_local: L.num.get(key) ?? 0,
      numerator_global: G.num.get(key) ?? 0,
      denominator_local: L.den.get(gi) ?? 0,
      denominator_global: G.den.get(gi) ?? 0,
      in_local: inL,
      in_global: inG,
      both,
      pivot_date_local: L.pdate[gi],
      pivot_date_global: G.pdate[gi],
      offset_days_local: L.dist[gi],
      offset_days_global: G.dist[gi],
      difference_pp: both && !taxon.includes("?") ? (fl! - fg!) * 100 : null,
    });
  }
  rows.sort((a, b) => a.grid_ms - b.grid_ms || cmp(a.taxon, b.taxon));
  const off = (s: "local" | "global") => {
    const v = rows.filter((r) => (s === "local" ? r.in_local : r.in_global)).map((r) => Math.abs((s === "local" ? r.offset_days_local : r.offset_days_global) ?? 0));
    return v.length ? Math.max(...v) : null;
  };
  info.max_offset_days = { local: off("local"), global: off("global") };
  info.method = T.alignment;
  return { grid, rows, info };
}

function gridText(info: GridInfo): string | null {
  if (!info.reference) return null;
  const ref = info.reference === "local" ? "JHH local" : "Nextstrain global";
  const other = info.reference === "local" ? "global" : "local";
  const mo = info.max_offset_days?.[other];
  const sp = (x: number | null | undefined) => (x == null ? "n/a" : `${x} days`);
  let txt = `Shared timepoints = the ${ref} build's frequency pivots (${info.step}), extended at the same spacing. Pivot spacing: local ${sp(info.local_spacing_days)}, global ${sp(info.global_spacing_days)}.`;
  if (mo != null) txt += ` ${other[0].toUpperCase()}${other.slice(1)} values come from its nearest pivot, at most ${mo} days away.`;
  return txt;
}

// ------------------------------------------------------------------ engine
export class BrowserEngine {
  builds = new Map<string, Build>();

  add(b: Build) {
    this.builds.set(b.spec.id, b);
  }

  get(id: string): Build {
    const b = this.builds.get(id);
    if (!b) throw new Error(`Build '${id}' is not loaded`);
    return b;
  }

  fields(id: string) {
    return this.get(id).fields.map((f) => ({ build_id: id, ...f }));
  }

  genotypeOptions(lid: string, gid: string) {
    const lb = this.get(lid), gb = this.get(gid);
    const lg = genotypes(lb), gg = genotypes(gb);
    const genes = [...new Set([...Object.keys(lb.genomeAnnotations), ...Object.keys(gb.genomeAnnotations)])].sort();
    const out = genes.map((gene) => {
      const la = lb.genomeAnnotations[gene], ga = gb.genomeAnnotations[gene];
      const lHas = !!lg.roots[gene]?.size, gHas = !!gg.roots[gene]?.size;
      const coords = !!(la && ga && la.start === ga.start && la.end === ga.end);
      let note: string | null = null;
      if (!la || !ga) note = `${gene} annotation present only in the ${la ? "local" : "global"} build JSON.`;
      else if (!coords) note = `${gene} coordinates differ between builds (local ${la.start}-${la.end}, global ${ga.start}-${ga.end}); positions may not refer to the same site.`;
      return {
        gene,
        label: gene === "nuc" ? "Nucleotide (nuc)" : `${gene} (amino acid)`,
        seq_type: gene === "nuc" ? "nuc" : "aa",
        available: !!(la && ga && (lHas || gHas)),
        coordinates_match: coords,
        note,
      };
    });
    out.sort((a, b) => Number(a.gene !== "nuc") - Number(b.gene !== "nuc") || cmp(a.gene, b.gene));
    const positions: Record<string, any[]> = {};
    for (const gene of new Set([...Object.keys(lg.positions), ...Object.keys(gg.positions)])) {
      const ps = new Set([...(lg.positions[gene]?.keys() ?? []), ...(gg.positions[gene]?.keys() ?? [])]);
      positions[gene] = [...ps].sort((a, b) => a - b).map((p) => {
        const l = lg.positions[gene]?.get(p), g = gg.positions[gene]?.get(p);
        return {
          position: p,
          variable_in_local: !!(l && l.nStates > 1),
          variable_in_global: !!(g && g.nStates > 1),
          local_nonroot: l ? l.nonroot : null,
          global_nonroot: g ? g.nonroot : null,
        };
      });
    }
    return { genes: out, positions };
  }

  sharedFilters(lid: string, gid: string) {
    const cfg = CONFIG.shared_filters as any;
    const lf = new Map(this.get(lid).fields.map((f) => [f.field_name, f]));
    const gf = new Map(this.get(gid).fields.map((f) => [f.field_name, f]));
    const vals = (f: any) => new Map<string, number>(f.allowed_values.map((v: any) => [v.value, v.count]));
    const available: any[] = [], unavailable: any[] = [];
    const used = new Set<string>();
    const make = (id: string, label: string, l: string, g: string, how: string) => {
      const lv = vals(lf.get(l)), gv = vals(gf.get(g));
      const values = [...new Set([...lv.keys(), ...gv.keys()])].map((v) => ({
        value: v, local_count: lv.get(v) ?? 0, global_count: gv.get(v) ?? 0, in_both: lv.has(v) && gv.has(v),
      }));
      values.sort((a, b) => Number(!a.in_both) - Number(!b.in_both) || b.local_count + b.global_count - (a.local_count + a.global_count) || cmp(a.value, b.value));
      return {
        id, label, local_field: l, global_field: g, matched_by: how,
        local_title: lf.get(l)!.field_title, global_title: gf.get(g)!.field_title,
        n_shared_values: values.filter((v) => v.in_both).length, values,
      };
    };
    const overlap = (l: string, g: string) => {
      const a = vals(lf.get(l)), b = vals(gf.get(g));
      return [...a.keys()].filter((k) => b.has(k)).length;
    };
    for (const d of cfg.pairs ?? []) {
      const cands: [string, string][] = [];
      for (const l of d.local ?? []) if (lf.has(l)) for (const g of d.global ?? []) if (gf.has(g)) cands.push([l, g]);
      const scored = cands.map(([l, g], i) => [overlap(l, g), i, l, g] as [number, number, string, string]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
      if (scored.length && scored[0][0] > 0) {
        const [, , l, g] = scored[0];
        available.push(make(d.id, d.label ?? d.id, l, g, "settings (shared_filters)"));
        used.add(`l:${l}`);
        used.add(`g:${g}`);
      } else {
        const why = !(d.local ?? []).some((x: string) => lf.has(x)) ? "not in the local build"
          : !(d.global ?? []).some((x: string) => gf.has(x)) ? "not in the global build" : "no values in common (different naming)";
        unavailable.push({ id: d.id, label: d.label ?? d.id, reason: why });
      }
    }
    if (cfg.auto_same_name ?? true)
      for (const name of [...lf.keys()].filter((k) => gf.has(k)).sort()) {
        if (used.has(`l:${name}`) || used.has(`g:${name}`) || (cfg.never ?? []).includes(name)) continue;
        if (overlap(name, name) > 0) available.push(make(name, lf.get(name)!.field_title, name, name, "same field name"));
      }
    return { available, unavailable };
  }

  colors(lb: Build, gb: Build, grouping: string, taxa: string[], palette: string): [Record<string, string>, any] {
    const special: Record<string, string> = { [OTHER]: OTHER_COLOR, [NOT_ASSIGNED]: NOT_ASSIGNED_COLOR };
    const plain = taxa.filter((t) => !(t in special));
    const info: any = { palette, grouping };
    const out: Record<string, string> = {};
    if (palette === "nextstrain" && (grouping === "clade" || grouping === "subclade")) {
      const key = grouping === "clade" ? gb.cladeField : gb.subcladeField;
      const official = key ? gb.colorScales[key] ?? [] : [];
      info.official_source = official.length
        ? `scale in the nextstrain.org dataset JSON ('${key}')`
        : `'${key}' has no colour scale in the national build; Auspice default palette`;
      const lkey = grouping === "clade" ? lb.cladeField : lb.subcladeField;
      const [cmap, src] = nationalColors(plain, key, official, key ? gb.valueOrder[key] ?? [] : [], Object.fromEntries(lkey ? lb.colorScales[lkey] ?? [] : []));
      for (const t of plain) out[t] = cmap[t];
      info.key = key;
      info.by_source = {};
      for (const t of plain) (info.by_source[src[t]] ??= []).push(t);
    } else {
      plain.forEach((t, i) => (out[t] = COLORBLIND_PALETTE[i % COLORBLIND_PALETTE.length]));
      info.official_source = palette === "colorblind" ? "colour-blind-safe palette" : "colour-blind-safe palette (genotypes have no national colour scale)";
    }
    return [{ ...out, ...special }, info];
  }

  compare(req: CompareReq) {
    const lb = this.get(req.local_build_id), gb = this.get(req.global_build_id);
    if (lb.spec.source_type !== "local" || gb.spec.source_type !== "global")
      throw new Error("local_build_id must be a local build and global_build_id a global build.");
    if (lb.spec.subtype !== gb.spec.subtype || lb.spec.segment !== gb.spec.segment)
      throw new Error(`Incompatible builds: local is ${lb.spec.subtype}/${lb.spec.segment}, global is ${gb.spec.subtype}/${gb.spec.segment}.`);
    const grouping = req.grouping ?? "subclade";
    let geno: Query["geno"] = null;
    if (grouping === "genotype") {
      const positions = [...new Set((req.genotype?.positions ?? []).map(Number))].sort((a, b) => a - b);
      if (!req.genotype?.gene || !positions.length) throw new Error("Choose a gene and at least one position for genotype grouping.");
      geno = { gene: req.genotype.gene, positions };
    }
    const lcl: [string, string[]][] = Object.entries(req.local_filters ?? {});
    const gcl: [string, string[]][] = Object.entries(req.global_filters ?? {});
    const sharedApplied: any[] = [];
    if (Object.values(req.shared_filters ?? {}).some((v) => v.length)) {
      const defs = new Map(this.sharedFilters(lb.spec.id, gb.spec.id).available.map((d: any) => [d.id, d]));
      for (const [fid, values] of Object.entries(req.shared_filters ?? {}).sort()) {
        if (!values.length) continue;
        const d = defs.get(fid);
        if (!d) throw new Error(`Filter '${fid}' cannot be applied to both of these builds.`);
        lcl.push([d.local_field, values]);
        gcl.push([d.global_field, values]);
        sharedApplied.push({ id: fid, label: d.label, values: [...values].sort(), local_field: d.local_field, global_field: d.global_field });
      }
    }
    let [ldf, linfo] = frequencies({ b: lb, grouping, geno, clauses: lcl });
    let [gdf, ginfo] = frequencies({ b: gb, grouping, geno, clauses: gcl });
    const inclProj = !!req.include_projection;
    if (!inclProj) {
      ldf = ldf.filter((r) => !r.is_projection);
      gdf = gdf.filter((r) => !r.is_projection);
    }
    const rng = (df: Row[]): [string, string] | null => (df.length ? [df.reduce((m, r) => (r.date < m ? r.date : m), df[0].date), df.reduce((m, r) => (r.date > m ? r.date : m), df[0].date)] : null);
    const localRange = rng(ldf), globalRange = rng(gdf);
    let shared: [string, string] | null = null;
    if (localRange && globalRange) {
      const s = localRange[0] > globalRange[0] ? localRange[0] : globalRange[0];
      const e = localRange[1] < globalRange[1] ? localRange[1] : globalRange[1];
      shared = s <= e ? [s, e] : null;
    }
    const start = req.start ?? null, end = req.end ?? null;
    const inRange = (d: string) => (!start || d >= start) && (!end || d <= end);
    let ldfR = ldf.filter((r) => inRange(r.date)), gdfR = gdf.filter((r) => inRange(r.date));

    const topN = Number(req.top_n ?? 0);
    const all = [...new Set([...ldfR.map((r) => r.taxon), ...gdfR.map((r) => r.taxon)])].sort();
    let groupedOther: string[] = [];
    if (topN && all.length > topN) {
      const mx = new Map<string, number>();
      for (const r of [...ldfR, ...gdfR]) mx.set(r.taxon, Math.max(mx.get(r.taxon) ?? -Infinity, r.frequency));
      const keep = new Set([...mx.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([t]) => t));
      groupedOther = all.filter((t) => !keep.has(t));
      const collapse = (df: Row[]): Row[] => {
        const m = new Map<string, Row>();
        for (const r of df) {
          const t = keep.has(r.taxon) ? r.taxon : OTHER;
          const k = `${r.pivot_idx}\u0000${t}`;
          const cur = m.get(k);
          if (cur) {
            cur.frequency += r.frequency;
            cur.numerator += r.numerator;
          } else m.set(k, { ...r, taxon: t });
        }
        return [...m.values()].sort((a, b) => a.pivot_idx - b.pivot_idx || cmp(a.taxon, b.taxon));
      };
      ldf = collapse(ldf); gdf = collapse(gdf); ldfR = collapse(ldfR); gdfR = collapse(gdfR);
    }
    const taxaOrder = orderTaxa(ldfR, gdfR);
    const stable = allTaxa([lb, gb], grouping, geno);
    const [colors, colorInfo] = this.colors(lb, gb, grouping, [...stable, ...taxaOrder.filter((t) => !stable.includes(t))], req.palette ?? "nextstrain");

    const al = align(ldf, gdf, lb, gb, pivotRows(lb, inclProj), pivotRows(gb, inclProj));
    const rows = al.rows.filter((r) => inRange(isoOfMs(r.grid_ms)));
    const snapshot = snapshotOf(rows, req.snapshot ?? {});
    const notes: string[] = [];
    if (grouping === "clade" || grouping === "subclade") {
      const lt = new Set(ldf.map((r) => r.taxon).filter((t) => t !== OTHER && t !== NOT_ASSIGNED));
      const gt = new Set(gdf.map((r) => r.taxon).filter((t) => t !== OTHER && t !== NOT_ASSIGNED));
      if (lt.size && gt.size && ![...lt].some((t) => gt.has(t))) {
        const lf = grouping === "clade" ? lb.cladeField : lb.subcladeField;
        const gf = grouping === "clade" ? gb.cladeField : gb.subcladeField;
        notes.push(
          `No ${grouping} labels in common: the local build uses '${lf}' (e.g. ${[...lt].sort().slice(0, 2).join(", ")}) and the global build uses '${gf}' (e.g. ${[...gt].sort().slice(0, 2).join(", ")}). These are different naming schemes, so the builds cannot be compared label by label.`,
        );
      }
    }
    const tp = (f: (r: Aligned["rows"][number]) => boolean) => [...new Set(rows.filter(f).map((r) => isoOfMs(r.grid_ms)))].sort();
    return {
      local: seriesPayload(ldfR, linfo, lb),
      global: seriesPayload(gdfR, ginfo, gb),
      aligned: alignedSeries(rows),
      alignment: al.info,
      taxa: taxaOrder,
      colors,
      color_info: colorInfo,
      grouped_into_other: groupedOther,
      difference: differencePayload(rows),
      snapshot,
      notes,
      date_ranges: { local: localRange, global: globalRange, shared, selected: [start, end], selection_has_both: rows.some((r) => r.both) },
      timepoints: { local: tp((r) => r.in_local), global: tp((r) => r.in_global), shared: tp((r) => r.both) },
      harmonization: { version: 0, applied: [] },
      provenance: provenance(lb, gb, linfo, ginfo, req, grouping, geno, al.info, colorInfo, sharedApplied),
    };
  }
}

function orderTaxa(ldf: Row[], gdf: Row[]): string[] {
  const s = new Map<string, [number, number]>();
  for (const r of [...ldf, ...gdf]) {
    const c = s.get(r.taxon) ?? [0, 0];
    s.set(r.taxon, [c[0] + r.frequency, c[1] + 1]);
  }
  const order = [...s.entries()].map(([t, [sum, n]]) => [t, sum / n] as [string, number]).sort((a, b) => b[1] - a[1]).map(([t]) => t);
  for (const sp of [OTHER, NOT_ASSIGNED]) {
    const i = order.indexOf(sp);
    if (i >= 0) {
      order.splice(i, 1);
      order.push(sp);
    }
  }
  return order;
}

function seriesPayload(df: Row[], info: { tips_included: number; notes: string[]; served_from: string }, b: Build) {
  const piv = new Map<number, Row>();
  for (const r of df) if (!piv.has(r.pivot_idx)) piv.set(r.pivot_idx, r);
  const order = [...piv.keys()].sort((a, c) => a - c);
  const series: Record<string, { frequency: number[]; numerator: number[] }> = {};
  const byTaxon = new Map<string, Map<number, Row>>();
  for (const r of df) {
    if (!byTaxon.has(r.taxon)) byTaxon.set(r.taxon, new Map());
    byTaxon.get(r.taxon)!.set(r.pivot_idx, r);
  }
  for (const [t, m] of [...byTaxon.entries()].sort((a, c) => cmp(a[0], c[0])))
    series[t] = { frequency: order.map((p) => r6(m.get(p)?.frequency ?? 0)), numerator: order.map((p) => m.get(p)?.numerator ?? 0) };
  return {
    build_id: b.spec.id,
    dates: order.map((p) => piv.get(p)!.date),
    months: order.map((p) => piv.get(p)!.month),
    denominator: order.map((p) => piv.get(p)!.denominator),
    series,
    tips_included: info.tips_included,
    tips_total: b.tips.length,
    served_from: info.served_from,
    notes: info.notes,
  };
}

function alignedSeries(rows: Aligned["rows"]) {
  if (!rows.length) return { dates: [], local: null, global: null };
  const dates = [...new Set(rows.map((r) => r.grid_ms))].sort((a, b) => a - b);
  const first = new Map<number, Aligned["rows"][number]>();
  for (const r of rows) if (!first.has(r.grid_ms)) first.set(r.grid_ms, r);
  const out: any = { dates: dates.map(isoOfMs) };
  for (const s of ["local", "global"] as const) {
    const present = dates.map((d) => (s === "local" ? first.get(d)!.in_local : first.get(d)!.in_global));
    const series: Record<string, any> = {};
    const byTaxon = new Map<string, Map<number, Aligned["rows"][number]>>();
    for (const r of rows) {
      if (!byTaxon.has(r.taxon)) byTaxon.set(r.taxon, new Map());
      byTaxon.get(r.taxon)!.set(r.grid_ms, r);
    }
    for (const [t, m] of [...byTaxon.entries()].sort((a, c) => cmp(a[0], c[0]))) {
      series[t] = {
        frequency: dates.map((d, i) => {
          const v = m.get(d)?.[`frequency_${s}`];
          return present[i] ? (v == null ? 0 : r6(v)) : null;
        }),
        numerator: dates.map((d, i) => (present[i] ? m.get(d)?.[`numerator_${s}`] ?? 0 : null)),
      };
    }
    out[s] = {
      present,
      pivot_dates: dates.map((d, i) => (present[i] ? first.get(d)![`pivot_date_${s}`] : null)),
      offset_days: dates.map((d, i) => {
        const v = first.get(d)![`offset_days_${s}`];
        return present[i] && v != null ? Math.round(v * 10) / 10 : null;
      }),
      denominator: dates.map((d, i) => (present[i] ? first.get(d)![`denominator_${s}`] : null)),
      series,
    };
  }
  return out;
}

function differencePayload(rows: Aligned["rows"]) {
  const b = rows.filter((r) => r.both);
  if (!b.length) return { dates: [], series: {}, method: T.alignment };
  const dates = [...new Set(b.map((r) => r.grid_ms))].sort((x, y) => x - y);
  const byTaxon = new Map<string, Map<number, Aligned["rows"][number]>>();
  for (const r of b) {
    if (!byTaxon.has(r.taxon)) byTaxon.set(r.taxon, new Map());
    byTaxon.get(r.taxon)!.set(r.grid_ms, r);
  }
  const series: Record<string, any> = {};
  for (const [t, m] of [...byTaxon.entries()].sort((a, c) => cmp(a[0], c[0]))) {
    const g = dates.map((d) => m.get(d));
    if (g.every((r) => r?.difference_pp == null)) continue;
    series[t] = {
      difference_pp: g.map((r) => (r?.difference_pp == null ? null : r4(r.difference_pp))),
      local: g.map((r) => (r?.frequency_local == null ? null : r6(r.frequency_local))),
      global: g.map((r) => (r?.frequency_global == null ? null : r6(r.frequency_global))),
      local_n: g.map((r) => (r ? r.numerator_local : null)),
      global_n: g.map((r) => (r ? r.numerator_global : null)),
    };
  }
  return { dates: dates.map(isoOfMs), series, method: T.alignment };
}

function snapshotOf(rows: Aligned["rows"], spec: { mode?: string; timepoint?: string | null }) {
  const mode = spec.mode ?? "range";
  const shared = rows.filter((r) => r.both);
  if (!shared.length) return { mode, label: null, rows: [], timepoints: [] };
  const pts = [...new Set(shared.map((r) => isoOfMs(r.grid_ms)))].sort();
  let sel = shared, label: string, used: string[];
  if (mode === "point") {
    const tp = spec.timepoint && pts.includes(spec.timepoint) ? spec.timepoint : pts[pts.length - 1];
    sel = shared.filter((r) => isoOfMs(r.grid_ms) === tp);
    label = tp;
    used = [tp];
  } else {
    label = `${pts[0]} to ${pts[pts.length - 1]} (mean of ${pts.length} shared timepoints)`;
    used = pts;
  }
  const n = used.length;
  const g = new Map<string, { lf: number; gf: number; ln: number; gn: number }>();
  for (const r of sel) {
    const c = g.get(r.taxon) ?? { lf: 0, gf: 0, ln: 0, gn: 0 };
    c.lf += r.frequency_local ?? 0;
    c.gf += r.frequency_global ?? 0;
    c.ln += r.numerator_local;
    c.gn += r.numerator_global;
    g.set(r.taxon, c);
  }
  const firstPer = new Map<number, Aligned["rows"][number]>();
  for (const r of sel) if (!firstPer.has(r.grid_ms)) firstPer.set(r.grid_ms, r);
  const denL = [...firstPer.values()].reduce((s, r) => s + r.denominator_local, 0);
  const denG = [...firstPer.values()].reduce((s, r) => s + r.denominator_global, 0);
  const out = [];
  for (const [taxon, c] of [...g.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    const lf = c.lf / n, gf = c.gf / n;
    const lp = lf > 0 || c.ln > 0, gp = gf > 0 || c.gn > 0;
    if (!lp && !gp) continue;
    out.push({
      taxon,
      local_frequency: r6(lf),
      global_frequency: r6(gf),
      difference_pp: taxon.includes("?") ? null : r4((lf - gf) * 100),
      local_n: c.ln,
      global_n: c.gn,
      local_denominator: denL,
      global_denominator: denG,
      presence: lp && gp ? "both" : lp ? "local only" : "global only",
    });
  }
  return { mode, label, timepoints: used, rows: out };
}

function provenance(lb: Build, gb: Build, linfo: any, ginfo: any, req: CompareReq, grouping: string, geno: Query["geno"], gi: GridInfo, colorInfo: any, sharedApplied: any[]) {
  const val = (v: any, source: string) =>
    v === null || v === undefined || v === "" ? { value: source === "json" || source === "derived" ? T.not_available : "Not supplied", source: "missing" } : { value: v, source };
  const side = (b: Build, info: any, filters: any, name: string) => {
    const dp = b.meta.data_provenance;
    return {
      dataset_name: { value: name, source: "app" },
      build_label: val(b.spec.label, "app"),
      build_id: val(b.spec.id, "app"),
      json_source: val(`nextstrain.org/${b.spec.remote}`, "app"),
      remote: val(`https://nextstrain.org/${b.spec.remote}`, "app"),
      fetched_at: val(b.loadedAt.replace("T", " ") + " UTC (this browser session)", "app"),
      json_title: val(b.meta.title, "json"),
      subtype: val(SUBTYPE_LABEL[b.spec.subtype] ?? b.spec.subtype, "app"),
      segment: val(b.spec.segment, "app"),
      resolution: val(b.spec.resolution, "app"),
      build_date: val(null, "app"),
      updated_date: val(b.meta.updated, "json"),
      most_recent_sample_date: val(b.maxSample, "json"),
      earliest_sample_date: val(b.minSample, "json"),
      total_tips: val(b.tips.length, "json"),
      tips_after_filtering: val(info.tips_included, "derived"),
      active_filters: { value: filters ?? {}, source: "user" },
      frequency_source: val((T.freq_source_labels as Record<string, string>)[b.freqSource], "app"),
      frequency_source_detail: val(b.freqDetail, "app"),
      downsampling: val(b.spec.source_type === "local" ? T.local_downsampling : T.global_downsampling, "app"),
      data_provenance: val(Array.isArray(dp) ? dp.map((x: any) => x.name ?? "").join("; ") : null, "json"),
      clade_field: val(b.cladeField, "json"),
      subclade_field: val(b.subcladeField, "json"),
      ingestion_timestamp: val(b.loadedAt, "app"),
      synthetic: false,
    };
  };
  const loaded = lb.loadedAt > gb.loadedAt ? lb.loadedAt : gb.loadedAt;
  return {
    local: side(lb, linfo, req.local_filters, T.local_name),
    global: side(gb, ginfo, req.global_filters, T.global_name),
    comparison: {
      grouping,
      genotype_definition: geno ? genoDef(geno) : null,
      selected_range: [req.start ?? null, req.end ?? null],
      shared_filters: sharedApplied,
      alignment_method: T.alignment,
      alignment_detail: gridText(gi),
      colours: colorInfo?.official_source ?? null,
      count_method: T.counts,
      data_processing_timestamp: loaded,
      dashboard_refresh_timestamp: loaded,
      harmonization_version: 0,
    },
  };
}
