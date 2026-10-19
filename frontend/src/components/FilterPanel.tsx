import { useMemo, useState } from "react";
import type { FieldInfo, Filters, Selection, SharedFilterOptions } from "../types";

export type FilterTab = "both" | "local" | "global";

const TAB_LABEL: Record<FilterTab, string> = { both: "Both datasets", local: "JHH local", global: "Nextstrain global" };

const count = (f: Filters) => Object.values(f).reduce((n, v) => n + (v.length ? 1 : 0), 0);

function toggleValue(f: Filters, field: string, value: string): Filters {
  const cur = new Set(f[field] ?? []);
  cur.has(value) ? cur.delete(value) : cur.add(value);
  const next = { ...f, [field]: Array.from(cur) };
  if (!next[field].length) delete next[field];
  return next;
}

function setValues(f: Filters, field: string, values: string[]): Filters {
  const next = { ...f, [field]: values };
  if (!values.length) delete next[field];
  return next;
}

interface Props {
  sel: Selection;
  update: (p: Partial<Selection>) => void;
  localFields: FieldInfo[];
  globalFields: FieldInfo[];
  shared: SharedFilterOptions | null;
  tab: FilterTab;
  setTab: (t: FilterTab) => void;
  included: { local?: number; global?: number };
  totals: { local?: number; global?: number };
}

/** All filtering in one place: a tab per scope, inclusion bars, searchable value lists. */
export default function FiltersSection({ sel, update, localFields, globalFields, shared, tab, setTab, included, totals }: Props) {
  const counts = { both: count(sel.sharedFilters), local: count(sel.localFilters), global: count(sel.globalFilters) };
  const anyActive = counts.both + counts.local + counts.global > 0;
  return (
    <section className="ctl filters-section" id="filters" aria-label="Filters">
      <div className="filters-head">
        <label>Filters</label>
        <button className="link" disabled={!anyActive} onClick={() => update({ sharedFilters: {}, localFilters: {}, globalFilters: {} })}>
          Clear all
        </button>
      </div>
      <Inclusion included={included} totals={totals} />
      <div className="tabs" role="tablist" aria-label="Filter scope">
        {(["both", "local", "global"] as FilterTab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`tab ${t} ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>
            {TAB_LABEL[t]}
            {counts[t] > 0 && <span className="badge-n">{counts[t]}</span>}
          </button>
        ))}
      </div>
      <div className="tab-body" role="tabpanel">
        {tab === "both" && <BothTab sel={sel} update={update} shared={shared} />}
        {tab === "local" && (
          <SideTab
            side="local"
            fields={localFields}
            otherFields={globalFields}
            filters={sel.localFilters}
            onChange={(f) => update({ localFilters: f })}
            blurb="Applies to the JHH local build only."
          />
        )}
        {tab === "global" && (
          <SideTab
            side="global"
            fields={globalFields}
            otherFields={localFields}
            filters={sel.globalFilters}
            onChange={(f) => update({ globalFilters: f })}
            blurb="Applies to the Nextstrain global build only."
          />
        )}
      </div>
    </section>
  );
}

function Inclusion({ included, totals }: { included: Props["included"]; totals: Props["totals"] }) {
  return (
    <div className="inclusion">
      {(["local", "global"] as const).map((s) => {
        const inc = included[s];
        const tot = totals[s];
        const pct = inc != null && tot ? (inc / tot) * 100 : 100;
        return (
          <div key={s} className={`inc-row ${s}`} title={`${s === "local" ? "JHH local" : "Nextstrain global"} tips included after filtering`}>
            <span className="inc-name">{s === "local" ? "Local" : "Global"}</span>
            <span className="inc-bar">
              <span style={{ width: `${pct}%` }} />
            </span>
            <span className="inc-num">
              {inc != null && tot != null ? (
                <>
                  <strong>{inc.toLocaleString()}</strong> / {tot.toLocaleString()}
                </>
              ) : (
                "–"
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function BothTab({ sel, update, shared }: { sel: Selection; update: (p: Partial<Selection>) => void; shared: SharedFilterOptions | null }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!shared) return <p className="hint">Loading…</p>;
  return (
    <>
      <p className="hint">
        The same filter is applied to <strong>both</strong> builds. Only attributes recorded in both JSON files, with values in common, are listed.
      </p>
      {shared.available.length === 0 && <p className="hint">These two builds have no equivalent filterable attributes.</p>}
      {shared.available.map((d) => (
        <ValuePicker
          key={d.id}
          title={d.label}
          subtitle={d.local_field === d.global_field ? `field “${d.local_field}” in both` : `local “${d.local_field}” = global “${d.global_field}”`}
          columns={["Local", "Global"]}
          values={d.values.map((v) => ({ value: v.value, counts: [v.local_count, v.global_count], disabled: !v.in_both }))}
          disabledNote="only in one dataset"
          selected={sel.sharedFilters[d.id] ?? []}
          open={open === d.id}
          setOpen={(o) => setOpen(o ? d.id : null)}
          onToggle={(v) => update({ sharedFilters: toggleValue(sel.sharedFilters, d.id, v) })}
          onSet={(vs) => update({ sharedFilters: setValues(sel.sharedFilters, d.id, vs) })}
          scope="both"
        />
      ))}
      {shared.unavailable.length > 0 && (
        <p className="hint na-line">
          Not comparable: {shared.unavailable.map((u) => `${u.label} (${u.reason})`).join("; ")}.
        </p>
      )}
    </>
  );
}

function SideTab({
  side,
  fields,
  otherFields,
  filters,
  onChange,
  blurb,
}: {
  side: "local" | "global";
  fields: FieldInfo[];
  otherFields: FieldInfo[];
  filters: Filters;
  onChange: (f: Filters) => void;
  blurb: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const missing = otherFields.filter((f) => !fields.some((x) => x.field_name === f.field_name));
  return (
    <>
      <p className="hint">{blurb}</p>
      {fields.length === 0 && <p className="hint">No filterable metadata fields in this build JSON.</p>}
      {fields.map((f) => (
        <ValuePicker
          key={f.field_name}
          title={f.field_title}
          subtitle={f.field_title !== f.field_name ? `field “${f.field_name}”` : undefined}
          columns={["Tips"]}
          values={[...f.allowed_values].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)).map((v) => ({ value: v.value, counts: [v.count] }))}
          selected={filters[f.field_name] ?? []}
          open={open === f.field_name}
          setOpen={(o) => setOpen(o ? f.field_name : null)}
          onToggle={(v) => onChange(toggleValue(filters, f.field_name, v))}
          onSet={(vs) => onChange(setValues(filters, f.field_name, vs))}
          scope={side}
          source={f.source_location_in_json}
        />
      ))}
      {missing.length > 0 && (
        <p className="hint na-line" title="These fields exist only in the other build">
          Not available in source JSON: {missing.map((f) => f.field_title).join(", ")}
        </p>
      )}
    </>
  );
}

interface PickerValue {
  value: string;
  counts: number[];
  disabled?: boolean;
}

function ValuePicker({
  title,
  subtitle,
  columns,
  values,
  selected,
  open,
  setOpen,
  onToggle,
  onSet,
  scope,
  source,
  disabledNote,
}: {
  title: string;
  subtitle?: string;
  columns: string[];
  values: PickerValue[];
  selected: string[];
  open: boolean;
  setOpen: (o: boolean) => void;
  onToggle: (v: string) => void;
  onSet: (vs: string[]) => void;
  scope: "both" | "local" | "global";
  source?: string;
  disabledNote?: string;
}) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => values.filter((v) => v.value.toLowerCase().includes(q.toLowerCase())), [values, q]);
  const enabled = shown.filter((v) => !v.disabled);
  const disabled = shown.filter((v) => v.disabled);
  const max = Math.max(1, ...values.flatMap((v) => v.counts));
  const summary = selected.length ? (selected.length <= 2 ? selected.join(", ") : `${selected.length} selected`) : "any";
  return (
    <div className={`field ${open ? "open" : ""} ${selected.length ? "active" : ""} scope-${scope}`}>
      <button className="field-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="field-title">
          {title}
          {subtitle && <span className="field-sub">{subtitle}</span>}
        </span>
        <span className={`field-val ${selected.length ? "set" : ""}`}>
          {summary} <span className="caret">{open ? "▴" : "▾"}</span>
        </span>
      </button>
      {open && (
        <div className="values">
          <div className="values-tools">
            {values.length > 6 && <input aria-label={`Search ${title}`} placeholder={`Search ${values.length} values`} value={q} onChange={(e) => setQ(e.target.value)} />}
            <div className="row">
              <button className="link" onClick={() => onSet(Array.from(new Set([...selected, ...enabled.map((v) => v.value)])))}>
                Select {q ? "shown" : "all"}
              </button>
              <button className="link" disabled={!selected.length} onClick={() => onSet([])}>
                Clear
              </button>
            </div>
          </div>
          <div className="vgrid-head" style={{ gridTemplateColumns: `1fr repeat(${columns.length}, 64px)` }}>
            <span>Value</span>
            {columns.map((c) => (
              <span key={c} className="num">
                {c}
              </span>
            ))}
          </div>
          <ul>
            {enabled.map((v) => (
              <Row key={v.value} v={v} max={max} columns={columns} checked={selected.includes(v.value)} onToggle={onToggle} />
            ))}
            {enabled.length === 0 && <li className="hint">No matching values.</li>}
          </ul>
          {disabled.length > 0 && (
            <details className="disabled-values">
              <summary>
                {disabled.length} value{disabled.length > 1 ? "s" : ""} {disabledNote}
              </summary>
              <ul>
                {disabled.map((v) => (
                  <Row key={v.value} v={v} max={max} columns={columns} checked={false} onToggle={() => undefined} disabled />
                ))}
              </ul>
            </details>
          )}
          {source && <p className="hint">Source: {source}</p>}
        </div>
      )}
    </div>
  );
}

function Row({ v, max, columns, checked, onToggle, disabled }: { v: PickerValue; max: number; columns: string[]; checked: boolean; onToggle: (v: string) => void; disabled?: boolean }) {
  return (
    <li>
      <label className={`vrow ${disabled ? "dis" : ""}`} style={{ gridTemplateColumns: `1fr repeat(${columns.length}, 64px)` }}>
        <span className="vname">
          <input type="checkbox" checked={checked} disabled={disabled} onChange={() => onToggle(v.value)} />
          <span title={v.value}>{v.value}</span>
        </span>
        {v.counts.map((c, i) => (
          <span key={i} className={`vcount c${i}`}>
            <span className="vbar" style={{ width: `${(c / max) * 100}%` }} />
            <span className="vnum">{c.toLocaleString()}</span>
          </span>
        ))}
      </label>
    </li>
  );
}

/** Active filters, shown above the chart so they are always visible. */
export function ActiveFilterBar({
  sel,
  update,
  shared,
  onEdit,
  localFields,
  globalFields,
}: {
  sel: Selection;
  update: (p: Partial<Selection>) => void;
  shared: SharedFilterOptions | null;
  onEdit: (t: FilterTab) => void;
  localFields: FieldInfo[];
  globalFields: FieldInfo[];
}) {
  const label = (id: string) => shared?.available.find((d) => d.id === id)?.label ?? id;
  const title = (fields: FieldInfo[], f: string) => fields.find((x) => x.field_name === f)?.field_title ?? f;
  const chips: { scope: FilterTab; field: string; text: string; remove: () => void }[] = [];
  for (const [f, vs] of Object.entries(sel.sharedFilters))
    if (vs.length) chips.push({ scope: "both", field: f, text: `${label(f)}: ${vs.join(", ")}`, remove: () => update({ sharedFilters: setValues(sel.sharedFilters, f, []) }) });
  for (const [f, vs] of Object.entries(sel.localFilters))
    if (vs.length) chips.push({ scope: "local", field: f, text: `${title(localFields, f)}: ${vs.join(", ")}`, remove: () => update({ localFilters: setValues(sel.localFilters, f, []) }) });
  for (const [f, vs] of Object.entries(sel.globalFilters))
    if (vs.length) chips.push({ scope: "global", field: f, text: `${title(globalFields, f)}: ${vs.join(", ")}`, remove: () => update({ globalFilters: setValues(sel.globalFilters, f, []) }) });
  return (
    <div className="filterbar" aria-label="Active filters">
      <span className="fb-label">Filters</span>
      {chips.length === 0 && <span className="muted">none, all tips included</span>}
      {chips.map((c) => (
        <span key={c.scope + c.field} className={`fchip ${c.scope}`}>
          <button className="fchip-scope" onClick={() => onEdit(c.scope)} title="Edit">
            {c.scope === "both" ? "Both" : c.scope === "local" ? "Local" : "Global"}
          </button>
          <span className="fchip-text" title={c.text}>
            {c.text}
          </span>
          <button className="fchip-x" aria-label={`Remove ${c.text}`} onClick={c.remove}>
            ×
          </button>
        </span>
      ))}
      <button className="link" onClick={() => onEdit(chips[0]?.scope ?? "both")}>
        {chips.length ? "Edit" : "Add filter"}
      </button>
      {chips.length > 1 && (
        <button className="link" onClick={() => update({ sharedFilters: {}, localFilters: {}, globalFilters: {} })}>
          Clear all
        </button>
      )}
    </div>
  );
}
