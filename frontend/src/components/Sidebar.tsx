import { useEffect, useMemo, useState } from "react";
import type { BuildInfo, CompareResult, FieldInfo, GenotypeOptions, Options, Selection, SharedFilterOptions } from "../types";
import { buildsFor, segmentsFor } from "../App";
import FiltersSection, { type FilterTab } from "./FilterPanel";
import DateControls from "./DateControls";

interface Props {
  opts: Options;
  sel: Selection;
  update: (p: Partial<Selection>) => void;
  localFields: FieldInfo[];
  globalFields: FieldInfo[];
  geno: GenotypeOptions | null;
  result: CompareResult | null;
  localBuild?: BuildInfo;
  globalBuild?: BuildInfo;
  shared: SharedFilterOptions | null;
  filterTab: FilterTab;
  setFilterTab: (t: FilterTab) => void;
}

export default function Sidebar({ opts, sel, update, localFields, globalFields, geno, result, localBuild, globalBuild, shared, filterTab, setFilterTab }: Props) {
  const segments = segmentsFor(opts, sel.subtype);
  const locals = buildsFor(opts, sel.subtype, sel.segment, "local");
  const globals = buildsFor(opts, sel.subtype, sel.segment, "global");
  const validGlobals = new Set(opts.pairs.filter((p) => p.local === sel.localId).map((p) => p.global));

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="dot" /> Flu Frequency Compare
      </div>

      <section className="ctl">
        <label htmlFor="subtype">Subtype</label>
        <select id="subtype" value={sel.subtype} onChange={(e) => update({ subtype: e.target.value })}>
          {opts.subtypes.map((s) => (
            <option key={s.id} value={s.id} disabled={!segmentsFor(opts, s.id).length}>
              {s.label}
              {!segmentsFor(opts, s.id).length ? " (no local+global builds)" : ""}
            </option>
          ))}
        </select>
        <div className="segbar" role="radiogroup" aria-label="Segment">
          {opts.enabled_segments.map((s) => (
            <button
              key={s}
              role="radio"
              aria-checked={sel.segment === s}
              className={sel.segment === s ? "on" : ""}
              disabled={!segments.includes(s)}
              title={!segments.includes(s) ? "No compatible local and global builds for this segment" : ""}
              onClick={() => update({ segment: s })}
            >
              {s}
            </button>
          ))}
        </div>
      </section>

      <section className="ctl">
        <label htmlFor="grouping">Color by</label>
        <select id="grouping" value={sel.grouping} onChange={(e) => update({ grouping: e.target.value as Selection["grouping"] })}>
          <option value="clade">Clade</option>
          <option value="subclade">Subclade</option>
          <option value="genotype" disabled={!geno?.genes.some((g) => g.available)}>
            Genotype
          </option>
        </select>
        {sel.grouping !== "genotype" && result && (
          <p className="hint">
            JSON field: local <code>{result.provenance.local[`${sel.grouping}_field`]?.value}</code>, global{" "}
            <code>{result.provenance.global[`${sel.grouping}_field`]?.value}</code>
          </p>
        )}
        {sel.grouping === "genotype" && <GenotypeMenu geno={geno} sel={sel} update={update} />}
      </section>

      <section className="ctl">
        <label htmlFor="global">Global surveillance build to compare</label>
        <select id="global" value={sel.globalId} onChange={(e) => update({ globalId: e.target.value })}>
          {globals.map((b) => (
            <option key={b.build_id} value={b.build_id} disabled={!validGlobals.has(b.build_id)}>
              {b.resolution ? `${b.resolution} · ` : ""}
              {b.label}
            </option>
          ))}
        </select>
        {globalBuild && <BuildCard b={globalBuild} />}
      </section>

      <section className="ctl">
        <label htmlFor="local">JHH local build</label>
        {locals.length > 1 ? (
          <select id="local" value={sel.localId} onChange={(e) => update({ localId: e.target.value })}>
            {locals.map((b) => (
              <option key={b.build_id} value={b.build_id}>
                {b.label}
              </option>
            ))}
          </select>
        ) : null}
        {localBuild && <BuildCard b={localBuild} />}
      </section>

      <section className="ctl">
        <label>Dates</label>
        <DateControls sel={sel} update={update} result={result} />
      </section>

      <FiltersSection
        sel={sel}
        update={update}
        localFields={localFields}
        globalFields={globalFields}
        shared={shared}
        tab={filterTab}
        setTab={setFilterTab}
        included={{ local: result?.local.tips_included, global: result?.global.tips_included }}
        totals={{ local: localBuild?.total_tip_count, global: globalBuild?.total_tip_count }}
      />

      <section className="ctl">
        <label htmlFor="topn">Taxa shown</label>
        <div className="row">
          <select id="topn" value={sel.topN} onChange={(e) => update({ topN: Number(e.target.value) })}>
            {[0, 5, 8, 12, 20].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? "All taxa" : `Top ${n} + Other`}
              </option>
            ))}
          </select>
          <select aria-label="Palette" value={sel.palette} onChange={(e) => update({ palette: e.target.value as Selection["palette"] })}>
            <option value="nextstrain">Nextstrain colours</option>
            <option value="colorblind">Colour-blind safe</option>
          </select>
        </div>
        <label className="check">
          <input type="checkbox" checked={sel.includeProjection} onChange={(e) => update({ includeProjection: e.target.checked })} />
          Show projected frequencies (if a build has them)
        </label>
        <label htmlFor="timeaxis" className="sublabel">
          Time axis
        </label>
        <div className="segbar" role="radiogroup" aria-label="Time axis" id="timeaxis">
          <button role="radio" aria-checked={sel.timeAxis === "aligned"} className={sel.timeAxis === "aligned" ? "on" : ""} onClick={() => update({ timeAxis: "aligned" })} title="Both panels at the same timepoints">
            Shared timepoints
          </button>
          <button role="radio" aria-checked={sel.timeAxis === "native"} className={sel.timeAxis === "native" ? "on" : ""} onClick={() => update({ timeAxis: "native" })} title="Each build at its own pivots, with a separate time axis for the local panel">
            Native pivots
          </button>
        </div>
      </section>

    </aside>
  );
}

function BuildCard({ b }: { b: BuildInfo }) {
  return (
    <details className={`buildcard ${b.source_type}`}>
      <summary>
        <span>
          {b.total_tip_count.toLocaleString()} tips · latest sample {b.most_recent_sample_date}
        </span>
        <span className="more">details</span>
      </summary>
      <dl>
        <dt>Build</dt>
        <dd title={b.build_id}>{b.build_id}</dd>
        <dt>Updated</dt>
        <dd>{b.updated_date}</dd>
        <dt>Source</dt>
        <dd title={b.remote ?? b.source_file}>{b.source_file}</dd>
        {b.fetched_at && (
          <>
            <dt>Fetched</dt>
            <dd>{b.fetched_at.replace("T", " ").slice(0, 16)}</dd>
          </>
        )}
        <dd className="full ds">{b.downsampling}</dd>
        {b.warnings.length > 0 && (
          <dd className="full warn">
            {b.warnings.length} ingest note{b.warnings.length > 1 ? "s" : ""}:
            <ul>
              {b.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </dd>
        )}
      </dl>
    </details>
  );
}

function GenotypeMenu({ geno, sel, update }: { geno: GenotypeOptions | null; sel: Selection; update: (p: Partial<Selection>) => void }) {
  const genes = geno?.genes ?? [];
  const [text, setText] = useState(sel.positions.join(", "));
  useEffect(() => setText(sel.positions.join(", ")), [sel.positions]);
  useEffect(() => {
    if (!sel.gene && genes.length) {
      const g = genes.find((x) => x.available && x.seq_type === "aa") ?? genes.find((x) => x.available);
      if (g) update({ gene: g.gene });
    }
  }, [genes, sel.gene, update]);
  const gene = genes.find((g) => g.gene === sel.gene);
  const suggestions = useMemo(() => {
    const ps = geno?.positions[sel.gene] ?? [];
    return ps
      .filter((p) => p.variable_in_local && p.variable_in_global)
      .sort((a, b) => (b.local_nonroot ?? 0) + (b.global_nonroot ?? 0) - (a.local_nonroot ?? 0) - (a.global_nonroot ?? 0))
      .slice(0, 24)
      .sort((a, b) => a.position - b.position);
  }, [geno, sel.gene]);
  const commit = (s: string) => {
    const ps = Array.from(new Set(s.split(/[ ,;]+/).map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x) && x > 0))).sort((a, b) => a - b);
    update({ positions: ps.slice(0, 6) });
  };
  return (
    <div className="geno">
      <label htmlFor="gene" className="sublabel">
        Genotype of
      </label>
      <select id="gene" value={sel.gene} onChange={(e) => update({ gene: e.target.value, positions: [] })}>
        {genes.map((g) => (
          <option key={g.gene} value={g.gene} disabled={!g.available}>
            {g.label}
            {!g.available ? " (not in both builds)" : ""}
          </option>
        ))}
      </select>
      {gene?.note && <p className="hint warn">{gene.note}</p>}
      <label htmlFor="positions" className="sublabel">
        Position(s), {gene?.seq_type === "nuc" ? "nucleotide" : "amino-acid"} numbering
      </label>
      <input
        id="positions"
        value={text}
        placeholder="e.g. 158, 189"
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && commit((e.target as HTMLInputElement).value)}
      />
      {suggestions.length > 0 && (
        <div className="chips suggest" aria-label="Positions variable in both builds">
          {suggestions.map((p) => (
            <button
              key={p.position}
              className={sel.positions.includes(p.position) ? "chip on" : "chip"}
              onClick={() =>
                update({
                  positions: sel.positions.includes(p.position)
                    ? sel.positions.filter((x) => x !== p.position)
                    : [...sel.positions, p.position].sort((a, b) => a - b).slice(0, 6),
                })
              }
            >
              {p.position}
            </button>
          ))}
        </div>
      )}
      <p className="hint">Suggested: positions that vary in both builds. Multiple positions combine into one genotype label.</p>
    </div>
  );
}
