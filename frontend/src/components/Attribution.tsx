import type { CompareResult } from "../types";

const v = (p: Record<string, any>, k: string) => p[k]?.value;

export default function Attribution({ result, store }: { result: CompareResult; store: Record<string, string> }) {
  const pl = result.provenance.local;
  const pg = result.provenance.global;
  const ts = (s?: string | null) => (s ? String(s).replace("T", " ").slice(0, 16) : "–");
  return (
    <footer className="attribution" aria-label="Data attribution">
      <div>
        <span className="tag local">Local</span> {v(pl, "build_label")} · JSON updated {v(pl, "updated_date")} · latest sample {v(pl, "most_recent_sample_date")}
        {v(pl, "data_provenance") && v(pl, "data_provenance") !== "Not available in source JSON" ? ` · data: ${v(pl, "data_provenance")}` : ""}
      </div>
      <div>
        <span className="tag global">Global</span> {v(pg, "build_label")} · JSON updated {v(pg, "updated_date")} · latest sample {v(pg, "most_recent_sample_date")}
        {pg.fetched_at?.source !== "missing" ? ` · fetched ${ts(v(pg, "fetched_at"))}` : ""}
        {v(pg, "data_provenance") && v(pg, "data_provenance") !== "Not available in source JSON" ? ` · data: ${v(pg, "data_provenance")}` : ""}
      </div>
      <div className="muted">
        Processed {ts(result.provenance.comparison.data_processing_timestamp)} · store built {ts(store.built_at)} · flu-freq-compare {store.app_version}
      </div>
    </footer>
  );
}
