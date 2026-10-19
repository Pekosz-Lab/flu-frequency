// Parse an Auspice v2 dataset (+ tip-frequencies / root-sequence sidecars) into
// in-memory structures. Port of ffc/parse_auspice.py, validate.py, frequencies.py,
// genotypes.py and the per-build part of ingest.py.
import { isValidValue } from "./colors";
import { decimalToMs, isoOfDecimal, makeMonthlyPivots, monthOfDecimal } from "./dates";
import CONFIG from "./web-config.json";

type Scalar = string | number | boolean;
const MUT_RE = /^([A-Za-z\-*.])(\d+)([A-Za-z\-*.])$/;

export interface BuildSpec {
  id: string;
  source_type: "local" | "global";
  organization: string;
  subtype: string;
  segment: string;
  resolution: string | null;
  label: string;
  remote: string; // dataset path on nextstrain.org
}

export interface Node {
  name: string;
  parent: number; // -1 for root
  isTip: boolean;
  attrs: Record<string, Scalar>;
  numDate: number | null;
  muts: Record<string, [string, number, string][]>;
}

export interface FieldInfo {
  field_name: string;
  field_title: string;
  field_type: string;
  allowed_values: { value: string; count: number }[];
  n_tips_with_value: number;
  source_location_in_json: string;
}

export interface Build {
  spec: BuildSpec;
  loadedAt: string;
  version: string | null;
  meta: any;
  nodes: Node[]; // pre-order
  tips: number[]; // node indices of tips
  pivots: number[]; // decimal years
  pivotIso: string[];
  pivotMonth: string[];
  isProjection: boolean[];
  projection: number | null;
  weights: (Float64Array | null)[]; // per tip (same order as `tips`)
  pivotBin: Int32Array; // per tip, -1 = not binned
  freqSource: "imported" | "embedded" | "recomputed";
  freqDetail: string;
  cladeField: string | null;
  subcladeField: string | null;
  fields: FieldInfo[];
  fieldIndex: Map<string, Map<string, number[]>>; // field -> value -> tip positions
  colorScales: Record<string, [string, string][]>;
  colorings: Record<string, { title: string; type: string }>;
  valueOrder: Record<string, [string, number][]>;
  rootSeq: Record<string, string> | null;
  genomeAnnotations: Record<string, { start: number | null; end: number | null }>;
  warnings: string[];
  minSample: string | null;
  maxSample: string | null;
  datedTips: number;
  geno?: GenotypeData;
}

export interface GenotypeData {
  roots: Record<string, Map<number, string>>;
  tipStates: Record<string, Map<number, string>>[]; // per tip position: gene -> pos -> state (non-root only)
  positions: Record<string, Map<number, { nonroot: number; nStates: number }>>;
}

const scalar = (v: any): Scalar | null => {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    if (!("value" in v)) return null;
    v = v.value;
  }
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : null;
};

export class BuildError extends Error {}

function validate(d: any): string[] {
  const errors: string[] = [];
  if (!d || typeof d !== "object") return ["Top level is not a JSON object."];
  if (d.version !== "v2") errors.push(`Unsupported Auspice JSON version ${JSON.stringify(d.version)}; only Auspice v2 datasets are supported.`);
  if (!d.meta || typeof d.meta !== "object") errors.push("Missing 'meta' object.");
  if (Array.isArray(d.tree)) errors.push("'tree' is a list (multiple subtrees); only single-tree datasets are supported.");
  else if (!d.tree || typeof d.tree !== "object") errors.push("Missing 'tree' object.");
  return errors;
}

export function parseBuild(spec: BuildSpec, main: any, freqJson: any | null, rootJson: any | null): Build {
  const errs = validate(main);
  if (errs.length) throw new BuildError(`${spec.label}: ${errs.join(" ")}`);
  const warnings: string[] = [];
  const meta = main.meta ?? {};
  // ---- pre-order walk (iterative)
  const nodes: Node[] = [];
  const stack: [any, number][] = [[main.tree, -1]];
  while (stack.length) {
    const [n, parent] = stack.pop()!;
    const attrs: Record<string, Scalar> = {};
    for (const [k, v] of Object.entries(n.node_attrs ?? {})) {
      if (k === "num_date") continue;
      const s = scalar(v);
      if (s !== null) attrs[k] = s;
    }
    const nd = n.node_attrs?.num_date;
    const numDate = nd && typeof nd.value === "number" ? nd.value : null;
    const muts: Record<string, [string, number, string][]> = {};
    for (const [gene, list] of Object.entries((n.branch_attrs?.mutations ?? {}) as Record<string, string[]>)) {
      const parsed: [string, number, string][] = [];
      for (const m of list ?? []) {
        const mm = MUT_RE.exec(String(m));
        if (mm) parsed.push([mm[1].toUpperCase(), +mm[2], mm[3].toUpperCase()]);
      }
      if (parsed.length) muts[gene] = parsed;
    }
    const kids = n.children ?? [];
    const idx = nodes.length;
    nodes.push({ name: n.name, parent, isTip: !kids.length, attrs, numDate, muts });
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], idx]);
  }
  const tips = nodes.map((n, i) => (n.isTip ? i : -1)).filter((i) => i >= 0);
  const tipNames = tips.map((i) => nodes[i].name);
  const undated = tips.filter((i) => nodes[i].numDate === null).length;
  if (undated) warnings.push(`${undated} of ${tips.length} tips have no num_date; they are excluded from frequencies.`);

  // ---- colorings
  const colorScales: Record<string, [string, string][]> = {};
  const colorings: Record<string, { title: string; type: string }> = {};
  for (const c of meta.colorings ?? []) {
    if (!c?.key) continue;
    colorings[c.key] = { title: c.title || c.key, type: c.type || "categorical" };
    if (Array.isArray(c.scale))
      colorScales[c.key] = c.scale.filter((p: any) => Array.isArray(p) && p.length === 2 && typeof p[1] === "string").map((p: any) => [String(p[0]), p[1]]);
  }

  // ---- frequencies: sidecar > embedded > recompute
  let pivots: number[] = [];
  let weights: (Float64Array | null)[] = tips.map(() => null);
  let projection = null as number | null;
  let freqSource: Build["freqSource"] = "recomputed";
  let freqDetail = "";
  const tryImport = (f: any): boolean => {
    if (!f || !Array.isArray(f.pivots) || f.pivots.length < 2) return false;
    const n = f.pivots.length;
    const entries = Object.keys(f).filter((k) => f[k] && typeof f[k] === "object" && Array.isArray(f[k].frequencies));
    const tipSet = new Set(tipNames);
    const nonTip = entries.filter((k) => !tipSet.has(k)).length;
    if (entries.some((k) => f[k].frequencies.length !== n)) return false;
    const w = tipNames.map((t) => (f[t]?.frequencies ? Float64Array.from(f[t].frequencies.map((x: number) => x || 0)) : null));
    if (!w.some(Boolean)) return false;
    pivots = f.pivots.map(Number);
    weights = w;
    projection = typeof f.projection_pivot === "number" ? f.projection_pivot : null;
    if (nonTip) warnings.push(`${nonTip} frequency entries are not tips of the tree (e.g. internal nodes); they are ignored, as in Auspice.`);
    const missing = w.filter((x) => !x).length;
    if (missing) warnings.push(`${missing} of ${tips.length} tips have no frequency entry; they contribute no frequency weight.`);
    return true;
  };
  if (freqJson && tryImport(freqJson)) {
    freqSource = "imported";
    const g = freqJson.generated_by;
    freqDetail = `tip-frequencies JSON from nextstrain.org${g ? ` (generated by ${g.program ?? "?"} ${g.version ?? ""})`.trimEnd() : ""}`;
  } else {
    const embedded = main.frequencies ?? main.tip_frequencies ?? main["tip-frequencies"];
    if (embedded && tryImport(embedded)) {
      freqSource = "embedded";
      freqDetail = "frequency block embedded in the Auspice JSON";
    } else {
      if (freqJson) warnings.push("Frequency JSON rejected; recomputed from tip dates.");
      const rc = CONFIG.recompute;
      const dated = tips.map((i) => nodes[i].numDate);
      const ds = dated.filter((d): d is number => d !== null);
      if (!ds.length) throw new BuildError(`${spec.label}: no dated tips and no frequency data.`);
      pivots = makeMonthlyPivots(Math.min(...ds), Math.max(...ds), rc.pivot_interval_months);
      const dens = (mu: number, sigma: number) => {
        const z = pivots.map((p) => Math.exp(-0.5 * ((p - mu) / sigma) ** 2));
        const s = z.reduce((a, b) => a + b, 0);
        return s > 0 ? z.map((v) => v / s) : z;
      };
      const raw = dated.map((mu) => {
        if (mu === null) return null;
        const a = dens(mu, rc.narrow_bandwidth), b = dens(mu, rc.wide_bandwidth);
        return a.map((v, i) => (1 - rc.proportion_wide) * v + rc.proportion_wide * b[i]);
      });
      const col = pivots.map((_, j) => raw.reduce((s, r) => s + (r ? r[j] : 0), 0) || 1);
      weights = raw.map((r) => (r ? Float64Array.from(r.map((v, j) => v / col[j])) : null));
      freqSource = "recomputed";
      freqDetail = "KDE recomputed from tip collection dates (augur kde defaults)";
    }
  }
  if (projection !== null) warnings.push(`Frequencies after projection pivot ${(projection as number).toFixed(3)} are projections and are hidden by default.`);

  // pivot bins (midpoint to midpoint)
  const edges: number[] = [pivots[0] - (pivots[1] - pivots[0]) / 2];
  for (let i = 0; i < pivots.length - 1; i++) edges.push((pivots[i] + pivots[i + 1]) / 2);
  edges.push(pivots[pivots.length - 1] + (pivots[pivots.length - 1] - pivots[pivots.length - 2]) / 2);
  const pivotBin = new Int32Array(tips.length).fill(-1);
  tips.forEach((ti, k) => {
    const d = nodes[ti].numDate;
    if (d === null || d < edges[0] || d >= edges[edges.length - 1]) return;
    let lo = 0, hi = edges.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (edges[mid] <= d) lo = mid;
      else hi = mid;
    }
    pivotBin[k] = lo;
  });

  // grouping fields
  const pick = (cands: string[]) => cands.find((c) => tips.some((i) => c in nodes[i].attrs)) ?? null;
  const cladeField = pick(CONFIG.grouping_fields.clade);
  const subcladeField = pick(CONFIG.grouping_fields.subclade);
  if (!cladeField) warnings.push("No clade field found in node_attrs; clade grouping will show 'Not assigned'.");
  if (!subcladeField) warnings.push("No subclade field found in node_attrs; subclade grouping will show 'Not assigned'.");

  // metadata filter fields
  const mf = CONFIG.metadata_filters;
  const metaFilters = new Set<string>(mf.include_json_filters ? meta.filters ?? [] : []);
  const cands = new Set<string>([...metaFilters, ...(mf.extra_candidates ?? [])]);
  if (mf.include_categorical_colorings)
    for (const [k, c] of Object.entries(colorings)) if (["categorical", "ordinal", "boolean"].includes(c.type)) cands.add(k);
  for (const x of mf.exclude ?? []) cands.delete(x);
  const fields: FieldInfo[] = [];
  const fieldIndex = new Map<string, Map<string, number[]>>();
  for (const fname of [...cands].sort()) {
    const idx = new Map<string, number[]>();
    tips.forEach((ti, k) => {
      const v = nodes[ti].attrs[fname];
      if (v === undefined) return;
      const s = String(v);
      if (!idx.has(s)) idx.set(s, []);
      idx.get(s)!.push(k);
    });
    if (!idx.size) continue;
    if (idx.size > mf.max_distinct_values) {
      warnings.push(`Field '${fname}' has ${idx.size} distinct values; not offered as a filter.`);
      continue;
    }
    const locs = [`tree.node_attrs.${fname}`];
    if (fname in colorings) locs.push("meta.colorings");
    if (metaFilters.has(fname)) locs.push("meta.filters");
    const allowed = [...idx.entries()].map(([value, ks]) => ({ value, count: ks.length })).sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
    fields.push({
      field_name: fname,
      field_title: colorings[fname]?.title ?? fname,
      field_type: colorings[fname]?.type ?? "categorical",
      allowed_values: allowed,
      n_tips_with_value: allowed.reduce((s, x) => s + x.count, 0),
      source_location_in_json: locs.join(", "),
    });
    fieldIndex.set(fname, idx);
  }

  // value order (Auspice ordering inputs) for clade/subclade candidate keys, over ALL nodes
  const keys = new Set<string>([...CONFIG.grouping_fields.clade, ...CONFIG.grouping_fields.subclade]);
  const valueOrder: Record<string, [string, number][]> = {};
  const counts: Record<string, Map<string, number>> = {};
  nodes.forEach((n) => {
    for (const k of keys) {
      const v = n.attrs[k];
      if (v === undefined || !isValidValue(v)) continue;
      const s = String(v);
      counts[k] ??= new Map();
      counts[k].set(s, (counts[k].get(s) ?? 0) + 1);
    }
  });
  for (const [k, m] of Object.entries(counts)) valueOrder[k] = [...m.entries()]; // Map keeps first-appearance order

  const dates = tips.map((i) => nodes[i].numDate).filter((d): d is number => d !== null);
  const ga: Build["genomeAnnotations"] = {};
  for (const [g, a] of Object.entries((meta.genome_annotations ?? {}) as Record<string, any>)) {
    if (!a || typeof a !== "object") continue;
    let start = a.start ?? null, end = a.end ?? null;
    if (start === null && Array.isArray(a.segments) && a.segments.length) {
      start = a.segments[0].start ?? null;
      end = a.segments[a.segments.length - 1].end ?? null;
    }
    ga[g] = { start, end };
  }
  return {
    spec,
    loadedAt: new Date().toISOString().slice(0, 19),
    version: main.version ?? null,
    meta,
    nodes,
    tips,
    pivots,
    pivotIso: pivots.map(isoOfDecimal),
    pivotMonth: pivots.map(monthOfDecimal),
    isProjection: pivots.map((p) => projection !== null && p > projection),
    projection,
    weights,
    pivotBin,
    freqSource,
    freqDetail,
    cladeField,
    subcladeField,
    fields,
    fieldIndex,
    colorScales,
    colorings,
    valueOrder,
    rootSeq: rootJson && typeof rootJson === "object" ? rootJson : null,
    genomeAnnotations: ga,
    warnings,
    minSample: dates.length ? new Date(decimalToMs(Math.min(...dates))).toISOString().slice(0, 10) : null,
    maxSample: dates.length ? new Date(decimalToMs(Math.max(...dates))).toISOString().slice(0, 10) : null,
    datedTips: dates.length,
  };
}

/** Tip genotypes from branch mutations (port of ffc/genotypes.py), computed once per build. */
export function genotypes(b: Build): GenotypeData {
  if (b.geno) return b.geno;
  const roots: Record<string, Map<number, string>> = {};
  for (const n of b.nodes)
    for (const [gene, muts] of Object.entries(n.muts)) {
      roots[gene] ??= new Map();
      for (const [frm, pos] of muts) if (!roots[gene].has(pos)) roots[gene].set(pos, frm);
    }
  if (b.rootSeq)
    for (const [gene, m] of Object.entries(roots)) {
      const seq = b.rootSeq[gene];
      if (typeof seq === "string") for (const pos of m.keys()) if (pos > 0 && pos <= seq.length) m.set(pos, seq[pos - 1].toUpperCase());
    }
  const children: number[][] = b.nodes.map(() => []);
  b.nodes.forEach((n, i) => n.parent >= 0 && children[n.parent].push(i));
  const tipPos = new Map(b.tips.map((ti, k) => [ti, k]));
  const tipStates: Record<string, Map<number, string>>[] = b.tips.map(() => ({}));
  const current: Record<string, Map<number, string>> = {};
  const stack: [string, any][] = [["enter", 0]];
  while (stack.length) {
    const [action, item] = stack.pop()!;
    if (action === "exit") {
      for (const [gene, pos, prev] of item as [string, number, string | undefined][]) {
        if (prev === undefined) current[gene].delete(pos);
        else current[gene].set(pos, prev);
      }
      continue;
    }
    const i = item as number;
    const node = b.nodes[i];
    const undo: [string, number, string | undefined][] = [];
    for (const [gene, muts] of Object.entries(node.muts)) {
      current[gene] ??= new Map();
      const rg = roots[gene];
      const cg = current[gene];
      for (const [, pos, to] of muts) {
        undo.push([gene, pos, cg.get(pos)]);
        if (rg?.get(pos) === to) cg.delete(pos);
        else cg.set(pos, to);
      }
    }
    stack.push(["exit", undo.reverse()]);
    if (node.isTip) {
      const k = tipPos.get(i)!;
      for (const [gene, m] of Object.entries(current)) if (m.size) tipStates[k][gene] = new Map(m);
    } else for (let c = children[i].length - 1; c >= 0; c--) stack.push(["enter", children[i][c]]);
  }
  const positions: GenotypeData["positions"] = {};
  const nt = b.tips.length;
  for (const [gene, m] of Object.entries(roots)) {
    positions[gene] = new Map();
    for (const [pos, rs] of m) {
      const c = new Map<string, number>();
      for (const ts of tipStates) {
        const s = ts[gene]?.get(pos);
        if (s !== undefined) c.set(s, (c.get(s) ?? 0) + 1);
      }
      const nonroot = [...c.values()].reduce((a, v) => a + v, 0);
      c.set(rs, (c.get(rs) ?? 0) + (nt - nonroot));
      positions[gene].set(pos, { nonroot, nStates: [...c.values()].filter((v) => v > 0).length });
    }
  }
  b.geno = { roots, tipStates, positions };
  return b.geno;
}
