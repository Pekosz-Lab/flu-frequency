import { useEffect, useMemo, useState } from "react";
import type { BuildInfo, GenotypeOptions, Options, Selection } from "../types";
import { buildsFor, segmentsFor } from "../App";

interface Props {
  opts: Options;
  sel: Selection;
  update: (p: Partial<Selection>) => void;
  geno: GenotypeOptions | null;
  localBuild?: BuildInfo;
  globalBuild?: BuildInfo;
}

/** A row of mutually exclusive buttons (radio group). */
function Seg<T extends string | number>({
  label,
  value,
  items,
  onChange,
  id,
}: {
  label: string;
  value: T;
  items: { v: T; text: string; disabled?: boolean; title?: string }[];
  onChange: (v: T) => void;
  id?: string;
}) {
  return (
    <div className="segbar" role="radiogroup" aria-label={label} id={id}>
      {items.map((it) => (
        <button
          key={String(it.v)}
          role="radio"
          aria-checked={value === it.v}
          className={value === it.v ? "on" : ""}
          disabled={it.disabled}
          title={it.title}
          onClick={() => onChange(it.v)}
        >
          {it.text}
        </button>
      ))}
    </div>
  );
}

export default function Sidebar({ opts, sel, update, geno, localBuild, globalBuild }: Props) {
  // phones: settings fold away under one button so the chart comes first (always shown on desktop)
  const [open, setOpen] = useState(false);
  const segments = segmentsFor(opts, sel.subtype);
  const locals = buildsFor(opts, sel.subtype, sel.segment, "local");
  const globals = buildsFor(opts, sel.subtype, sel.segment, "global");
  const validGlobals = new Set(opts.pairs.filter((p) => p.local === sel.localId).map((p) => p.global));
  // resolution buttons when each global build has its own resolution, otherwise a list
  const resolutions = globals.map((b) => b.resolution ?? "");
  const globalsAsButtons = globals.length <= 6 && resolutions.every((r) => r) && new Set(resolutions).size === resolutions.length;

  return (
    <aside className={`sidebar ${open ? "" : "collapsed"}`}>
      <div className="brand">
        <span className="brand-name">
          <span className="dot" /> Flu Frequency Compare
        </span>
        <button className="settings-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide settings ▴" : "Settings ▾"}
        </button>
      </div>

      <section className="ctl">
        <span className="ctl-label">Dataset</span>
        <Seg
          label="Subtype"
          id="subtype"
          value={sel.subtype}
          onChange={(v) => update({ subtype: v })}
          items={opts.subtypes.map((s) => ({
            v: s.id,
            text: s.label,
            disabled: !segmentsFor(opts, s.id).length,
            title: !segmentsFor(opts, s.id).length ? "No local + global builds" : undefined,
          }))}
        />
        <Seg
          label="Segment"
          value={sel.segment}
          onChange={(v) => update({ segment: v })}
          items={opts.enabled_segments.map((s) => ({
            v: s,
            text: s,
            disabled: !segments.includes(s),
            title: !segments.includes(s) ? "No compatible local and global builds for this segment" : undefined,
          }))}
        />
      </section>

      <section className="ctl">
        <span className="ctl-label">Compare</span>
        <div className="side local">
          <div className="side-name">JHH local</div>
          {locals.length > 1 && (
            <select id="local" aria-label="JHH local build" value={sel.localId} onChange={(e) => update({ localId: e.target.value })}>
              {locals.map((b) => (
                <option key={b.build_id} value={b.build_id}>
                  {b.label}
                </option>
              ))}
            </select>
          )}
          {localBuild && <BuildCard b={localBuild} />}
        </div>
        <div className="side global">
          <div className="side-name">Nextstrain global</div>
          {globalsAsButtons ? (
            <Seg
              label="Global build"
              id="global"
              value={sel.globalId}
              onChange={(v) => update({ globalId: v })}
              items={globals.map((b) => ({ v: b.build_id, text: b.resolution!, disabled: !validGlobals.has(b.build_id), title: b.label }))}
            />
          ) : (
            <select id="global" aria-label="Global build" value={sel.globalId} onChange={(e) => update({ globalId: e.target.value })}>
              {globals.map((b) => (
                <option key={b.build_id} value={b.build_id} disabled={!validGlobals.has(b.build_id)}>
                  {b.resolution ? `${b.resolution} · ` : ""}
                  {b.label}
                </option>
              ))}
            </select>
          )}
          {globalBuild && <BuildCard b={globalBuild} />}
        </div>
      </section>

      <section className="ctl">
        <span className="ctl-label">Color by</span>
        <Seg
          label="Color by"
          id="grouping"
          value={sel.grouping}
          onChange={(v) => update({ grouping: v })}
          items={[
            { v: "clade", text: "Clade" },
            { v: "subclade", text: "Subclade" },
            { v: "genotype", text: "Genotype", disabled: !geno?.genes.some((g) => g.available), title: "Amino-acid or nucleotide state at chosen positions" },
          ]}
        />
        {sel.grouping === "genotype" && <GenotypeMenu geno={geno} sel={sel} update={update} />}
      </section>

      <details className="ctl more">
        <summary className="ctl-label">Display options</summary>
        <label className="field-row">
          <span>Taxa</span>
          <select id="topn" value={sel.topN} onChange={(e) => update({ topN: Number(e.target.value) })}>
            {[0, 5, 8, 12, 20].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? "All" : `Top ${n} + Other`}
              </option>
            ))}
          </select>
        </label>
        <label className="field-row">
          <span>Colours</span>
          <select aria-label="Palette" value={sel.palette} onChange={(e) => update({ palette: e.target.value as Selection["palette"] })}>
            <option value="nextstrain">Nextstrain</option>
            <option value="colorblind">Colour-blind safe</option>
          </select>
        </label>
        <div className="field-row">
          <span>Time axis</span>
          <Seg
            label="Time axis"
            id="timeaxis"
            value={sel.timeAxis}
            onChange={(v) => update({ timeAxis: v })}
            items={[
              { v: "aligned", text: "Shared", title: "Both panels at the same timepoints" },
              { v: "native", text: "Native", title: "Each build at its own pivots, with a separate time axis for the local panel" },
            ]}
          />
        </div>
        <label className="check">
          <input type="checkbox" checked={sel.includeProjection} onChange={(e) => update({ includeProjection: e.target.checked })} />
          Projected frequencies (if a build has them)
        </label>
      </details>
    </aside>
  );
}

function BuildCard({ b }: { b: BuildInfo }) {
  return (
    <details className={`buildcard ${b.source_type}`}>
      <summary title="Build details">
        <span>
          {b.total_tip_count.toLocaleString()} tips · to {b.most_recent_sample_date}
          {b.warnings.length > 0 && <span className="warn"> · {b.warnings.length} note{b.warnings.length > 1 ? "s" : ""}</span>}
        </span>
        <span className="more" aria-hidden>
          ⓘ
        </span>
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
            Ingest notes:
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
      <div className="row">
        <select id="gene" aria-label="Gene" value={sel.gene} onChange={(e) => update({ gene: e.target.value, positions: [] })}>
          {genes.map((g) => (
            <option key={g.gene} value={g.gene} disabled={!g.available}>
              {g.label}
              {!g.available ? " (not in both builds)" : ""}
            </option>
          ))}
        </select>
        <input
          id="positions"
          aria-label={`Positions (${gene?.seq_type === "nuc" ? "nucleotide" : "amino-acid"} numbering)`}
          title={`${gene?.seq_type === "nuc" ? "Nucleotide" : "Amino-acid"} numbering; several positions combine into one genotype label`}
          value={text}
          placeholder="positions, e.g. 158, 189"
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && commit((e.target as HTMLInputElement).value)}
        />
      </div>
      {gene?.note && <p className="hint warn">{gene.note}</p>}
      {suggestions.length > 0 && (
        <div className="chips suggest" aria-label="Positions variable in both builds" title="Positions that vary in both builds">
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
    </div>
  );
}
