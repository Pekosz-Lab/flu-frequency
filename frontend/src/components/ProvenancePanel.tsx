import type { BuildInfo, CompareResult, ProvValue } from "../types";

const ROWS: [string, string][] = [
  ["dataset_name", "Dataset"],
  ["build_label", "Selected build"],
  ["build_id", "Build ID"],
  ["json_source", "JSON source"],
  ["remote", "Fetched from"],
  ["fetched_at", "Fetched at"],
  ["json_title", "JSON title"],
  ["subtype", "Subtype"],
  ["segment", "Segment"],
  ["resolution", "Resolution"],
  ["build_date", "Build date"],
  ["updated_date", "Updated (JSON)"],
  ["most_recent_sample_date", "Most recent sample"],
  ["earliest_sample_date", "Earliest sample"],
  ["total_tips", "Total tips"],
  ["tips_after_filtering", "Tips after filtering"],
  ["active_filters", "Filters on this dataset only"],
  ["frequency_source", "Frequency source"],
  ["frequency_source_detail", "Frequency detail"],
  ["downsampling", "Downsampling"],
  ["data_provenance", "Data provenance (JSON)"],
  ["clade_field", "Clade field"],
  ["subclade_field", "Subclade field"],
  ["ingestion_timestamp", "Ingested"],
];

const SRC_LABEL: Record<string, string> = {
  json: "JSON",
  manifest: "manifest",
  derived: "derived",
  app: "app",
  user: "you",
  missing: "missing",
};

function fmt(v: any) {
  if (v && typeof v === "object") {
    const e = Object.entries(v as Record<string, string[]>).filter(([, x]) => x.length);
    return e.length ? e.map(([k, x]) => `${k}: ${x.join(", ")}`).join("; ") : "none";
  }
  if (typeof v === "number") return v.toLocaleString();
  return String(v);
}

function Side({ title, p, cls }: { title: string; p: Record<string, ProvValue>; cls: string }) {
  return (
    <div className={`prov ${cls}`}>
      <h3>{title}</h3>
      <dl>
        {ROWS.map(([k, label]) =>
          p[k] ? (
            <div key={k} className="kv">
              <dt>{label}</dt>
              <dd className={p[k].source === "missing" ? "missing" : ""}>
                {fmt(p[k].value)} <span className={`src src-${p[k].source}`}>{SRC_LABEL[p[k].source] ?? p[k].source}</span>
              </dd>
            </div>
          ) : null,
        )}
      </dl>
    </div>
  );
}

export default function ProvenancePanel({ result, text }: { result: CompareResult; localBuild?: BuildInfo; globalBuild?: BuildInfo; text: Record<string, any> }) {
  const c = result.provenance.comparison;
  const dr = result.date_ranges;
  return (
    <div className="prov-wrap" aria-label="Provenance and status">
      <p className="sub">
            Value sources: <span className="src src-json">JSON</span> source file, <span className="src src-manifest">manifest</span> deployment config,{" "}
            <span className="src src-derived">derived</span> computed from the JSON, <span className="src src-missing">missing</span> {text.not_available}.
      </p>
      <div className="prov-grid">
        <Side title="Local surveillance" p={result.provenance.local} cls="local" />
        <Side title="Global surveillance" p={result.provenance.global} cls="global" />
        <div className="prov comparison">
          <h3>Comparison</h3>
          <dl>
            <div className="kv"><dt>Shared date range</dt><dd>{dr.shared ? `${dr.shared[0]} – ${dr.shared[1]}` : "no overlap"}</dd></div>
            <div className="kv"><dt>Selected range</dt><dd>{dr.selected[0] ?? "start of data"} – {dr.selected[1] ?? "end of data"}</dd></div>
            <div className="kv"><dt>Grouping</dt><dd>{c.grouping}</dd></div>
            <div className="kv"><dt>Genotype definition</dt><dd>{c.genotype_definition ?? "not applicable"}</dd></div>
            <div className="kv"><dt>Time alignment</dt><dd>{c.alignment_method}</dd></div>
            <div className="kv"><dt>Counts</dt><dd>{c.count_method}</dd></div>
            <div className="kv"><dt>Filters on both datasets</dt><dd>{(c.shared_filters ?? []).length ? (c.shared_filters as any[]).map((f) => `${f.label} = ${f.values.join(", ")} (local “${f.local_field}”, global “${f.global_field}”)`).join("; ") : "none"}</dd></div>
            {c.alignment_detail && <div className="kv"><dt>Timepoints</dt><dd>{c.alignment_detail}</dd></div>}
            <div className="kv"><dt>Colours</dt><dd>{result.color_info.official_source}{result.color_info.by_source?.["grey (not in official scale)"]?.length ? `; grey (no official colour): ${result.color_info.by_source["grey (not in official scale)"].join(", ")}` : ""}{result.color_info.by_source?.["grey (not in national build)"]?.length ? `; grey (not in national build): ${result.color_info.by_source["grey (not in national build)"].join(", ")}` : ""}</dd></div>
            <div className="kv"><dt>Taxon harmonization</dt><dd>{result.harmonization.applied.length ? result.harmonization.applied.map((m) => `${m.source}: ${m.from} → ${m.to}`).join("; ") : `none applied (exact label matching; mapping file v${result.harmonization.version})`}</dd></div>
            <div className="kv"><dt>Data processed</dt><dd>{c.data_processing_timestamp}</dd></div>
            <div className="kv"><dt>Dashboard data refreshed</dt><dd>{c.dashboard_refresh_timestamp ?? "–"}</dd></div>
            <div className="kv"><dt>Served from</dt><dd>local: {result.local.served_from}, global: {result.global.served_from}</dd></div>
          </dl>
        </div>
      </div>
    </div>
  );
}
