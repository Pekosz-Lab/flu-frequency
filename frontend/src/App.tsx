import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { compare, getFields, getGenotypeOptions, getOptions, getSharedFilters, IS_WEB } from "./api";
import { onProgress, type Progress } from "./webSource";
import type { BuildInfo, CompareResult, FieldInfo, GenotypeOptions, Options, Selection, SharedFilterOptions } from "./types";
import { targetRange } from "./dateRange";
import FilterBar from "./components/FilterPanel";
import Sidebar from "./components/Sidebar";
import FrequencyChart from "./components/FrequencyChart";
import SnapshotTable from "./components/SnapshotTable";
import ProvenancePanel from "./components/ProvenancePanel";
import ExportMenu from "./components/ExportMenu";
import Attribution from "./components/Attribution";
import Timeline from "./components/Timeline";
import Methodology from "./components/Methodology";

const RES_ORDER = ["6m", "1y", "2y", "3y", "6y", "12y"];
export const resRank = (r: string | null) => {
  const i = RES_ORDER.indexOf(r ?? "");
  return i < 0 ? 99 : i;
};

function defaultsFor(opts: Options, subtype: string, segment?: string): Partial<Selection> {
  const segs = segmentsFor(opts, subtype);
  const seg = segment && segs.includes(segment) ? segment : segs[0] ?? "";
  const locals = buildsFor(opts, subtype, seg, "local");
  const globals = buildsFor(opts, subtype, seg, "global");
  const g = globals.find((b) => b.resolution === "2y") ?? globals[0];
  return {
    subtype,
    segment: seg,
    localId: locals[0]?.build_id ?? "",
    globalId: g?.build_id ?? "",
    localFilters: {},
    globalFilters: {},
    sharedFilters: {},
    positions: [],
    gene: "",
  };
}

export function segmentsFor(opts: Options, subtype: string): string[] {
  const ok = new Set(
    opts.pairs
      .map((p) => opts.builds.find((b) => b.build_id === p.local))
      .filter((b): b is BuildInfo => !!b && b.subtype === subtype)
      .map((b) => b.segment),
  );
  return opts.enabled_segments.filter((s) => ok.has(s));
}

export function buildsFor(opts: Options, subtype: string, segment: string, type: "local" | "global") {
  return opts.builds
    .filter((b) => b.subtype === subtype && b.segment === segment && b.source_type === type)
    .sort((a, b) => resRank(a.resolution) - resRank(b.resolution) || a.label.localeCompare(b.label));
}

const VIEWS = [
  ["stacked", "Side by side"],
  ["overlay", "By taxon"],
  ["difference", "Difference"],
] as const;

export default function App() {
  const [opts, setOpts] = useState<Options | null>(null);
  const [sel, setSel] = useState<Selection | null>(null);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [localFields, setLocalFields] = useState<FieldInfo[]>([]);
  const [globalFields, setGlobalFields] = useState<FieldInfo[]>([]);
  const [geno, setGeno] = useState<GenotypeOptions | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [shared, setShared] = useState<SharedFilterOptions | null>(null);
  const [progress, setProgress] = useState<Progress>(null);
  useEffect(() => {
    if (IS_WEB) onProgress(setProgress);
  }, []);

  useEffect(() => {
    getOptions()
      .then((o) => {
        setOpts(o);
        const firstSub = o.subtypes.find((s) => segmentsFor(o, s.id).length) ?? o.subtypes[0];
        setSel({
          grouping: "subclade",
          topN: o.default_top_n,
          palette: o.default_palette,
          view: "stacked",
          start: null,
          end: null,
          range: "overlap",
          snapshotMode: "range",
          snapshotTime: null,
          includeProjection: false,
          timeAxis: "aligned",
          ...(defaultsFor(o, firstSub.id) as Pick<Selection, "subtype" | "segment" | "localId" | "globalId" | "localFilters" | "globalFilters" | "sharedFilters" | "positions" | "gene">),
        });
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  const update = useCallback((patch: Partial<Selection>) => {
    setSel((s) => {
      if (!s || !opts) return s;
      let next = { ...s, ...patch };
      if (patch.subtype && patch.subtype !== s.subtype) next = { ...next, ...defaultsFor(opts, patch.subtype) };
      else if (patch.segment && patch.segment !== s.segment) next = { ...next, ...defaultsFor(opts, s.subtype, patch.segment) };
      if (patch.localId && patch.localId !== s.localId) next.localFilters = {};
      if (patch.globalId && patch.globalId !== s.globalId) next.globalFilters = {};
      return next;
    });
  }, [opts]);

  // per-build metadata fields and genotype options
  useEffect(() => {
    if (!sel?.localId) return;
    getFields(sel.localId).then(setLocalFields).catch(() => setLocalFields([]));
  }, [sel?.localId]);
  useEffect(() => {
    if (!sel?.globalId) return;
    getFields(sel.globalId).then(setGlobalFields).catch(() => setGlobalFields([]));
  }, [sel?.globalId]);
  useEffect(() => {
    if (!sel?.localId || !sel?.globalId) return;
    let current = true; // ignore answers for a pair that is no longer selected
    setGeno(null);
    getGenotypeOptions(sel.localId, sel.globalId)
      .then((g) => current && setGeno(g))
      .catch(() => current && setGeno(null));
    return () => {
      current = false;
    };
  }, [sel?.localId, sel?.globalId]);

  // filters that apply to both builds; drop selections that the new pair cannot support
  useEffect(() => {
    if (!sel?.localId || !sel?.globalId) return;
    let current = true;
    setShared(null);
    getSharedFilters(sel.localId, sel.globalId)
      .then((s) => {
        if (!current) return;
        setShared(s);
        setSel((cur) => {
          if (!cur) return cur;
          const ok = new Set(s.available.map((d) => d.id));
          const kept = Object.fromEntries(Object.entries(cur.sharedFilters).filter(([k]) => ok.has(k)));
          return Object.keys(kept).length === Object.keys(cur.sharedFilters).length ? cur : { ...cur, sharedFilters: kept };
        });
      })
      .catch(() => current && setShared({ available: [], unavailable: [] }));
    return () => {
      current = false;
    };
  }, [sel?.localId, sel?.globalId]);

  // fetch comparison (debounced, cancellable)
  const ctrl = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!sel?.localId || !sel?.globalId) return;
    if (sel.grouping === "genotype" && (!sel.gene || sel.positions.length === 0)) return;
    // wait for the shared-filter options of this pair before sending filters that apply to both
    if (Object.keys(sel.sharedFilters).length && !shared) return;
    const t = setTimeout(() => {
      ctrl.current?.abort();
      const c = new AbortController();
      ctrl.current = c;
      setLoading(true);
      let refetch = false;
      compare(sel, c.signal)
        .then((r) => {
          // keep the dates on the range the current mode asks for (by default: where both datasets have data).
          // The data ranges depend on the builds and filters, not on the dates asked for, so this settles in one step.
          const want = targetRange(sel.range, r.date_ranges);
          if (want && (want[0] !== sel.start || want[1] !== sel.end)) {
            refetch = true;
            setSel((cur) => (cur && cur.range === sel.range ? { ...cur, start: want[0], end: want[1] } : cur));
            return;
          }
          setResult(r);
          setError(null);
          if (IS_WEB) getOptions().then(setOpts); // refresh build cards with the loaded builds' metadata
        })
        .catch((e) => {
          if (e.name !== "AbortError") setError(String(e.message ?? e));
        })
        .finally(() => {
          if (ctrl.current === c && !refetch) setLoading(false);
        });
    }, 120);
    return () => clearTimeout(t);
  }, [sel, shared]);

  const localBuild = useMemo(() => opts?.builds.find((b) => b.build_id === sel?.localId), [opts, sel?.localId]);
  const globalBuild = useMemo(() => opts?.builds.find((b) => b.build_id === sel?.globalId), [opts, sel?.globalId]);
  const synthetic = !!(localBuild?.synthetic || globalBuild?.synthetic);

  if (error && !opts) return <div className="fatal">Could not load the dashboard data: {error}. Is `ffc serve` running and has `ffc ingest` been run?</div>;
  if (!opts || !sel) return <div className="fatal">Loading…</div>;
  if (!opts.builds.length) return <div className="fatal">The store contains no builds. Run <code>ffc fetch</code> and <code>ffc ingest</code>.</div>;

  const subtypeLabel = opts.subtypes.find((s) => s.id === sel.subtype)?.label;
  const groupingLabel = sel.grouping === "genotype" ? `Genotype ${sel.gene} ${sel.positions.join(", ")}` : sel.grouping === "clade" ? "Clade" : "Subclade";
  const loadMsg = progress ? `Downloading ${progress.label} from nextstrain.org… ${(progress.bytes / 1e6).toFixed(1)} MB` : null;

  return (
    <div className="app">
      <Sidebar opts={opts} sel={sel} update={update} geno={geno} localBuild={localBuild} globalBuild={globalBuild} />
      <main className="main">
        {IS_WEB && <SiteNav />}
        {IS_WEB && (
          <div className="banner public" role="note">
            <strong>Public builds only.</strong> This site reads public nextstrain.org datasets and never accesses private builds. For private builds,{" "}
            <a href="../local/">run the app on your own computer</a>.
          </div>
        )}
        {synthetic && <div className="banner synthetic">SYNTHETIC DEMO DATA: invented sequences, not surveillance data.</div>}
        <section className="card chart-card">
          <header className="chart-head">
            <div>
              <h1>
                {subtypeLabel} {sel.segment} · {groupingLabel}
              </h1>
              <p className="sub">
                <span className="k-local">JHH local</span> vs <span className="k-global">Nextstrain global{globalBuild?.resolution ? ` ${globalBuild.resolution}` : ""}</span>
              </p>
            </div>
            <div className="head-actions">
              <div className="seg-toggle" role="tablist" aria-label="Display mode">
                {VIEWS.map(([v, label]) => (
                  <button key={v} role="tab" aria-selected={sel.view === v} className={sel.view === v ? "on" : ""} onClick={() => update({ view: v })}>
                    {label}
                  </button>
                ))}
              </div>
              <ExportMenu sel={sel} result={result} text={opts.text} />
            </div>
          </header>
          <FilterBar
            sel={sel}
            update={update}
            localFields={localFields}
            globalFields={globalFields}
            shared={shared}
            included={{ local: result?.local.tips_included, global: result?.global.tips_included }}
            totals={{ local: localBuild?.total_tip_count, global: globalBuild?.total_tip_count }}
          />
          {loadMsg && result && (
            <div className="loadbar" role="status">
              {loadMsg}
            </div>
          )}
          {error && <div className="banner error">{error}</div>}
          {sel.grouping === "genotype" && (!sel.gene || !sel.positions.length) ? (
            <div className="empty">Choose a gene and at least one position under “Color by”.</div>
          ) : result ? (
            <>
              <FrequencyChart result={result} sel={sel} highlight={highlight} setHighlight={setHighlight} text={opts.text} loading={loading} />
              <Timeline result={result} sel={sel} update={update} />
            </>
          ) : (
            <div className="empty">{loadMsg ?? (loading ? (IS_WEB ? "Loading builds from nextstrain.org…" : "Loading…") : "No data")}</div>
          )}
          {result && <Attribution result={result} store={opts.store} />}
          <p className="caveat" role="note">
            <strong>Relative frequencies only.</strong> {opts.text.caveat}
          </p>
        </section>
        {result && <SnapshotTable result={result} sel={sel} update={update} highlight={highlight} setHighlight={setHighlight} />}
        <section className="card details-card">
          <details>
            <summary>
              <h2>Provenance &amp; methods</h2>
              <span className="muted">build sources, dates, fields used, how frequencies are computed</span>
            </summary>
            {result && <ProvenancePanel result={result} localBuild={localBuild} globalBuild={globalBuild} text={opts.text} />}
            <Methodology text={opts.text} />
          </details>
        </section>
      </main>
    </div>
  );
}

function SiteNav() {
  return (
    <nav className="sitenav" aria-label="Site">
      <a href="../">Home</a>
      <span aria-current="page">Analysis (public builds)</span>
      <a href="../local/">Private builds: run locally</a>
    </nav>
  );
}
