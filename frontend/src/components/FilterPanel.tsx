import { useEffect, useMemo, useRef, useState } from "react";
import type { FieldInfo, Filters, Selection, SharedFilterDef, SharedFilterOptions } from "../types";

/** Filtering in one search box, as in Auspice's "Filter data": type a value (a region, country, subclade…),
 *  pick it, and it becomes a chip. Each filter has a scope: both datasets, JHH local only or Nextstrain global only.
 *  A value recorded in both builds is applied to both by default; the chip's scope menu changes that. */

export type Scope = "both" | "local" | "global";
const SCOPE_NAME: Record<Scope, string> = { both: "Both datasets", local: "JHH local only", global: "Nextstrain global only" };
const SCOPE_SHORT: Record<Scope, string> = { both: "Both", local: "Local", global: "Global" };

interface Value {
  value: string;
  local?: number;
  global?: number;
  disabled?: boolean; // shared attribute, value present in one dataset only
}
interface FieldDef {
  key: string; // `${scope}:${field}`
  scope: Scope;
  field: string; // shared filter id, or the JSON field name
  label: string;
  sub?: string;
  values: Value[];
  family?: SharedFilterDef; // the shared attribute this field belongs to (lets a filter move between scopes)
}

const filtersOf = (sel: Selection, s: Scope): Filters => (s === "both" ? sel.sharedFilters : s === "local" ? sel.localFilters : sel.globalFilters);
const patchFor = (s: Scope, f: Filters): Partial<Selection> => (s === "both" ? { sharedFilters: f } : s === "local" ? { localFilters: f } : { globalFilters: f });
function setValues(f: Filters, field: string, values: string[]): Filters {
  const next = { ...f, [field]: values };
  if (!values.length) delete next[field];
  return next;
}
const count = (f: Filters) => Object.values(f).reduce((n, v) => n + (v.length ? 1 : 0), 0);

function buildDefs(shared: SharedFilterOptions | null, localFields: FieldInfo[], globalFields: FieldInfo[]): FieldDef[] {
  const defs: FieldDef[] = [];
  for (const d of shared?.available ?? [])
    defs.push({
      key: `both:${d.id}`,
      scope: "both",
      field: d.id,
      label: d.label,
      sub: d.local_field === d.global_field ? `field “${d.local_field}” in both` : `local “${d.local_field}” = global “${d.global_field}”`,
      values: d.values.map((v) => ({ value: v.value, local: v.local_count, global: v.global_count, disabled: !v.in_both })),
      family: d,
    });
  const side = (scope: "local" | "global", fields: FieldInfo[]) => {
    for (const f of fields)
      defs.push({
        key: `${scope}:${f.field_name}`,
        scope,
        field: f.field_name,
        label: f.field_title,
        sub: `${f.field_title !== f.field_name ? `field “${f.field_name}” · ` : ""}${f.source_location_in_json}`,
        values: [...f.allowed_values].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)).map((v) => ({ value: v.value, [scope]: v.count })),
        family: shared?.available.find((d) => (scope === "local" ? d.local_field : d.global_field) === f.field_name),
      });
  };
  side("global", globalFields);
  side("local", localFields);
  return defs;
}

/** Where a filter on `def` can move to, and which of its values survive the move. */
function moveTargets(def: FieldDef, defs: FieldDef[]): { scope: Scope; def: FieldDef; ok: (v: string) => boolean }[] {
  const fam = def.family;
  if (!fam) return [{ scope: def.scope, def, ok: () => true }];
  const out: { scope: Scope; def: FieldDef; ok: (v: string) => boolean }[] = [];
  const val = (v: string) => fam.values.find((x) => x.value === v);
  const both = defs.find((d) => d.key === `both:${fam.id}`);
  const loc = defs.find((d) => d.key === `local:${fam.local_field}`);
  const glo = defs.find((d) => d.key === `global:${fam.global_field}`);
  if (both) out.push({ scope: "both", def: both, ok: (v) => !!val(v)?.in_both });
  if (glo) out.push({ scope: "global", def: glo, ok: (v) => (def.scope === "global" ? true : (val(v)?.global_count ?? 0) > 0) });
  if (loc) out.push({ scope: "local", def: loc, ok: (v) => (def.scope === "local" ? true : (val(v)?.local_count ?? 0) > 0) });
  return out;
}

interface Props {
  sel: Selection;
  update: (p: Partial<Selection>) => void;
  localFields: FieldInfo[];
  globalFields: FieldInfo[];
  shared: SharedFilterOptions | null;
  included: { local?: number; global?: number };
  totals: { local?: number; global?: number };
}

type Row = { kind: "field"; def: FieldDef } | { kind: "value"; def: FieldDef; v: Value };

export default function FilterBar({ sel, update, localFields, globalFields, shared, included, totals }: Props) {
  const defs = useMemo(() => buildDefs(shared, localFields, globalFields), [shared, localFields, globalFields]);
  const byKey = useMemo(() => new Map(defs.map((d) => [d.key, d])), [defs]);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [drill, setDrill] = useState<string | null>(null); // key of the field being browsed
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  useEffect(() => setActive(0), [q, drill, open]);
  useEffect(() => {
    if (!open) setDrill(null); // reopening starts from the attribute list
  }, [open]);

  const isOn = (def: FieldDef, v: string) => (filtersOf(sel, def.scope)[def.field] ?? []).includes(v);
  const toggle = (def: FieldDef, v: string) => {
    const f = filtersOf(sel, def.scope);
    const cur = f[def.field] ?? [];
    update(patchFor(def.scope, setValues(f, def.field, cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v])));
  };
  const setField = (def: FieldDef, vs: string[]) => update(patchFor(def.scope, setValues(filtersOf(sel, def.scope), def.field, vs)));

  const drillDef = drill ? byKey.get(drill) : undefined;
  const ql = q.trim().toLowerCase();

  // rows of the dropdown: field list (browse), values of one field (drill), or search hits
  const rows: Row[] = useMemo(() => {
    if (drillDef) return drillDef.values.filter((v) => !v.disabled && v.value.toLowerCase().includes(ql)).map((v) => ({ kind: "value", def: drillDef, v }));
    if (!ql) return defs.map((def) => ({ kind: "field", def }));
    const out: Row[] = [];
    // value hits first, both-dataset attributes first; a value already offered for both is not repeated per dataset
    for (const def of defs) {
      for (const v of def.values) {
        if (v.disabled || !v.value.toLowerCase().includes(ql)) continue;
        if (def.scope !== "both" && def.family?.values.find((x) => x.value === v.value)?.in_both) continue;
        out.push({ kind: "value", def, v });
      }
    }
    out.sort((a, b) => {
      const av = (a as any).v.value.toLowerCase().startsWith(ql) ? 0 : 1;
      const bv = (b as any).v.value.toLowerCase().startsWith(ql) ? 0 : 1;
      return av - bv;
    });
    const fields: Row[] = defs.filter((d) => d.label.toLowerCase().includes(ql) || d.field.toLowerCase().includes(ql)).map((def) => ({ kind: "field", def }));
    return [...out.slice(0, 60), ...fields];
  }, [defs, drillDef, ql]);

  const choose = (r: Row) => {
    if (r.kind === "field") {
      setDrill(r.def.key);
      setQ("");
    } else {
      toggle(r.def, r.v.value);
      if (!drillDef) setQ("");
    }
    input.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.max(0, Math.min(rows.length - 1, a + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter") {
      if (open && rows[active]) choose(rows[active]);
    } else if (e.key === "Backspace" && !q) {
      if (drill) setDrill(null);
      else if (chips.length) chips[chips.length - 1].remove();
    }
  };
  useEffect(() => {
    list.current?.querySelector(".opt.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // active filters as chips
  const chips = useMemo(() => {
    const out: { key: string; def?: FieldDef; scope: Scope; field: string; label: string; values: string[]; remove: () => void }[] = [];
    for (const s of ["both", "local", "global"] as Scope[])
      for (const [field, vs] of Object.entries(filtersOf(sel, s))) {
        if (!vs.length) continue;
        const def = byKey.get(`${s}:${field}`);
        out.push({ key: `${s}:${field}`, def, scope: s, field, label: def?.label ?? field, values: vs, remove: () => update(patchFor(s, setValues(filtersOf(sel, s), field, []))) });
      }
    return out;
  }, [sel, byKey, update]);

  const moveChip = (def: FieldDef, values: string[], to: Scope) => {
    const target = moveTargets(def, defs).find((t) => t.scope === to);
    if (!target || target.scope === def.scope) return;
    const keep = values.filter(target.ok);
    const fromF = setValues(filtersOf(sel, def.scope), def.field, []);
    const toF0 = filtersOf(sel, to);
    const toF = setValues(toF0, target.def.field, Array.from(new Set([...(toF0[target.def.field] ?? []), ...keep])));
    update({ ...patchFor(def.scope, fromF), ...patchFor(to, toF) });
  };

  const nActive = count(sel.sharedFilters) + count(sel.localFilters) + count(sel.globalFilters);
  const maxCount = (def: FieldDef) => Math.max(1, ...def.values.map((v) => Math.max(v.local ?? 0, v.global ?? 0)));

  return (
    <div className="filterbar" id="filters" aria-label="Filters">
      <div
        className={`fbox ${open ? "open" : ""}`}
        ref={box}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          if (drill) setDrill(null);
          else setOpen(false);
        }}
      >
        <div className="fbox-input" onClick={() => input.current?.focus()}>
          <span className="fbox-icon" aria-hidden>
            ⌕
          </span>
          {chips.map((c) => {
            const targets = c.def ? moveTargets(c.def, defs) : [];
            return (
              <span key={c.key} className={`fchip ${c.scope}`} onClick={(e) => e.stopPropagation()}>
                {targets.length > 1 ? (
                  <select
                    className="fchip-scope"
                    aria-label={`Apply ${c.label} filter to`}
                    title="Which dataset this filter applies to"
                    value={c.scope}
                    onChange={(e) => moveChip(c.def!, c.values, e.target.value as Scope)}
                  >
                    {targets.map((t) => (
                      <option key={t.scope} value={t.scope} disabled={!c.values.some(t.ok)}>
                        {SCOPE_SHORT[t.scope]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="fchip-scope" title={SCOPE_NAME[c.scope]}>
                    {SCOPE_SHORT[c.scope]}
                  </span>
                )}
                <button
                  className="fchip-text"
                  title={`${c.label}: ${c.values.join(", ")} (${SCOPE_NAME[c.scope]}). Click to edit.`}
                  onClick={() => {
                    if (c.def) setDrill(c.def.key);
                    setQ("");
                    setOpen(true);
                    input.current?.focus();
                  }}
                >
                  {c.label}: {c.values.length <= 3 ? c.values.join(", ") : `${c.values.length} values`}
                </button>
                <button
                  className="fchip-x"
                  aria-label={`Remove ${c.label} filter`}
                  onClick={() => {
                    c.remove();
                    input.current?.focus();
                  }}
                >
                  ×
                </button>
              </span>
            );
          })}
          <input
            ref={input}
            role="combobox"
            aria-expanded={open}
            aria-controls="filter-options"
            aria-label="Filter data"
            placeholder={chips.length ? "Add filter…" : "Filter by region, country, subclade…"}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onKeyDown={onKey}
          />
          {nActive > 0 && (
            <button className="link fbox-clear" onClick={() => update({ sharedFilters: {}, localFilters: {}, globalFilters: {} })}>
              Clear all
            </button>
          )}
        </div>

        {open && (
          <div className="fbox-menu" id="filter-options" role="listbox" ref={list}>
            {!shared && <p className="hint pad">Loading filters…</p>}
            {drillDef && (
              <div className="drill-head">
                <button className="link" onClick={() => setDrill(null)}>
                  ← All filters
                </button>
                <div className="drill-title">
                  <strong>{drillDef.label}</strong> <span className={`scope-tag ${drillDef.scope}`}>{SCOPE_NAME[drillDef.scope]}</span>
                  {drillDef.sub && <div className="hint">{drillDef.sub}</div>}
                </div>
                <div className="row">
                  <button className="link" onClick={() => setField(drillDef, Array.from(new Set([...(filtersOf(sel, drillDef.scope)[drillDef.field] ?? []), ...rows.map((r) => (r as any).v.value)])))}>
                    Select {ql ? "shown" : "all"}
                  </button>
                  <button className="link" disabled={!(filtersOf(sel, drillDef.scope)[drillDef.field] ?? []).length} onClick={() => setField(drillDef, [])}>
                    Clear
                  </button>
                </div>
              </div>
            )}

            {!drillDef && !ql && shared && <BrowseHint />}
            {rows.length === 0 && shared && <p className="hint pad">No matching values.</p>}

            {rows.map((r, i) => {
              const prev = rows[i - 1];
              const section =
                !drillDef && r.kind === "field" && !ql && (!prev || prev.def.scope !== r.def.scope) ? <div className={`menu-section ${r.def.scope}`}>{SCOPE_NAME[r.def.scope]}</div> : null;
              const fieldHead = ql && !drillDef && r.kind === "field" && prev?.kind === "value" ? <div className="menu-section">Attributes</div> : null;
              if (r.kind === "field") {
                const n = (filtersOf(sel, r.def.scope)[r.def.field] ?? []).length;
                return (
                  <div key={`f-${r.def.key}`}>
                    {section}
                    {fieldHead}
                    <div role="option" aria-selected={i === active} className={`opt field-opt ${i === active ? "active" : ""}`} onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(r)}>
                      <span className="opt-name">
                        {r.def.label}
                        {ql && <span className={`scope-tag ${r.def.scope}`}>{SCOPE_SHORT[r.def.scope]}</span>}
                      </span>
                      <span className="opt-meta">
                        {n > 0 && <span className={`badge-n ${r.def.scope}`}>{n}</span>}
                        {r.def.values.filter((v) => !v.disabled).length} values ›
                      </span>
                    </div>
                  </div>
                );
              }
              const on = isOn(r.def, r.v.value);
              const max = maxCount(r.def);
              return (
                <div
                  key={`v-${r.def.key}-${r.v.value}`}
                  role="option"
                  aria-selected={on}
                  className={`opt value-opt ${on ? "on" : ""} ${i === active ? "active" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(r)}
                >
                  <span className="opt-name">
                    <span className={`tick ${on ? "on" : ""}`} aria-hidden>
                      {on ? "✓" : ""}
                    </span>
                    <span className="opt-val" title={r.v.value}>
                      {r.v.value}
                    </span>
                    {!drillDef && (
                      <span className="opt-field">
                        {r.def.label} <span className={`scope-tag ${r.def.scope}`}>{SCOPE_SHORT[r.def.scope]}</span>
                      </span>
                    )}
                  </span>
                  <span className="opt-counts">
                    {r.v.local != null ? <Count n={r.v.local} max={max} cls="local" /> : <span className="vcount" />}
                    {r.v.global != null ? <Count n={r.v.global} max={max} cls="global" /> : <span className="vcount" />}
                  </span>
                </div>
              );
            })}

            {drillDef && drillDef.values.some((v) => v.disabled) && (
              <details className="disabled-values">
                <summary>{drillDef.values.filter((v) => v.disabled).length} values in one dataset only</summary>
                <ul>
                  {drillDef.values
                    .filter((v) => v.disabled)
                    .map((v) => (
                      <li key={v.value}>
                        {v.value} <span className="muted">({v.local ? `local ${v.local}` : `global ${v.global}`})</span>
                      </li>
                    ))}
                </ul>
              </details>
            )}
            {!drillDef && !ql && shared && shared.unavailable.length > 0 && (
              <p className="hint pad na-line">Not comparable across datasets: {shared.unavailable.map((u) => `${u.label} (${u.reason})`).join("; ")}.</p>
            )}
          </div>
        )}
      </div>
      <Inclusion included={included} totals={totals} />
    </div>
  );
}

function BrowseHint() {
  return <p className="hint pad">Type to search values, or pick an attribute. Counts: <span className="k-local">local</span> · <span className="k-global">global</span> tips.</p>;
}

function Count({ n, max, cls }: { n: number; max: number; cls: "local" | "global" }) {
  return (
    <span className={`vcount ${cls}`} title={`${n.toLocaleString()} ${cls === "local" ? "JHH local" : "Nextstrain global"} tips`}>
      <span className="vbar" style={{ width: `${(n / max) * 100}%` }} />
      <span className="vnum">{n.toLocaleString()}</span>
    </span>
  );
}

function Inclusion({ included, totals }: { included: Props["included"]; totals: Props["totals"] }) {
  return (
    <div className="inclusion" title="Tips included after filtering">
      {(["local", "global"] as const).map((s) => {
        const inc = included[s];
        const tot = totals[s];
        const pct = inc != null && tot ? (inc / tot) * 100 : 100;
        return (
          <div key={s} className={`inc-row ${s}`}>
            <span className="inc-name">{s === "local" ? "Local" : "Global"}</span>
            <span className="inc-bar">
              <span style={{ width: `${pct}%` }} />
            </span>
            <span className="inc-num">{inc != null && tot != null ? `${inc.toLocaleString()} / ${tot.toLocaleString()}` : "–"}</span>
          </div>
        );
      })}
    </div>
  );
}

