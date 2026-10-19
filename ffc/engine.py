"""Query engine over the DuckDB store.

Every dashboard request is answered here: frequency trajectories (from the
precomputed table when possible, otherwise aggregated from stored per-tip
frequencies), monthly-aligned local-vs-global comparisons, snapshot tables,
colours and provenance. No JSON is parsed and no tree is traversed here.
"""

from __future__ import annotations

import hashlib
import json
import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

from .colors import INVALID_STRINGS, UNKNOWN_COLOR, national_colors
from .constants import (
    ALIGNMENT_METHOD,
    COUNT_METHOD,
    FREQ_SOURCE_LABELS,
    GLOBAL_DATASET_NAME,
    LOCAL_DATASET_NAME,
    NOT_AVAILABLE,
    SUBTYPES,
)

OTHER = "Other"
NOT_ASSIGNED = "Not assigned"

# Okabe-Ito + Paul Tol (muted, light); colour-blind-safe, cycled if needed.
COLORBLIND_PALETTE = [
    "#0072B2", "#E69F00", "#009E73", "#CC79A7", "#56B4E9", "#D55E00", "#F0E442",
    "#332288", "#88CCEE", "#44AA99", "#117733", "#999933", "#DDCC77", "#CC6677",
    "#882255", "#AA4499", "#77AADD", "#EE8866", "#AAAA00", "#99DDFF",
]
OTHER_COLOR = "#E4E6EA"          # lighter than any national grey, so "Other" stays distinct
NOT_ASSIGNED_COLOR = UNKNOWN_COLOR  # Auspice's colour for missing values


@dataclass
class GenotypeSpec:
    gene: str
    positions: list[int]

    @property
    def definition(self) -> str:
        return f"{self.gene} position{'s' if len(self.positions) > 1 else ''} " + ", ".join(
            str(p) for p in self.positions
        )


@dataclass
class Query:
    build_id: str
    grouping: str = "subclade"  # clade | subclade | genotype
    genotype: GenotypeSpec | None = None
    filters: dict[str, list[str]] = field(default_factory=dict)
    # extra (field, values) clauses, e.g. from filters applied to both datasets; ANDed with `filters`
    extra: list[tuple[str, list[str]]] = field(default_factory=list)

    def clauses(self) -> list[tuple[str, list[str]]]:
        out = [(k, list(v)) for k, v in self.filters.items() if v] + [(k, list(v)) for k, v in self.extra if v]
        return sorted((k, sorted(map(str, v))) for k, v in out)

    def filter_hash(self) -> str:
        cl = self.clauses()
        if not cl:
            return "unfiltered"
        return hashlib.sha1(json.dumps(cl).encode()).hexdigest()[:12]


def _jsonable(x):
    if isinstance(x, (np.integer,)):
        return int(x)
    if isinstance(x, (np.floating,)):
        return None if np.isnan(x) else float(x)
    if isinstance(x, float) and np.isnan(x):
        return None
    if x is pd.NaT:
        return None
    if isinstance(x, pd.Timestamp):
        return x.date().isoformat()
    if hasattr(x, "isoformat"):
        return x.isoformat()
    return x


class Engine:
    def __init__(self, db_path: Path, harmonization: dict | None = None, cache_size: int = 256,
                 shared_filter_settings: dict | None = None):
        self.db_path = Path(db_path)
        self.shared_settings = shared_filter_settings
        self.harmonization = harmonization or {"version": 0, "mappings": []}
        self._lock = threading.Lock()
        self._cache_lock = threading.RLock()
        self._cache: OrderedDict = OrderedDict()
        self._cache_size = cache_size
        self._mtime = None
        self.con: duckdb.DuckDBPyConnection | None = None
        self._open()

    # ------------------------------------------------------------------ setup
    def _open(self):
        if self.con is not None:
            self.con.close()
        self.con = duckdb.connect(str(self.db_path), read_only=True)
        self._mtime = self.db_path.stat().st_mtime
        self._cache.clear()

    def refresh_if_changed(self):
        """Pick up a re-ingested store without restarting the server."""
        try:
            m = self.db_path.stat().st_mtime
        except FileNotFoundError:
            return
        if m != self._mtime:
            with self._lock:
                self._open()

    @classmethod
    def from_connection(cls, con, harmonization=None):
        self = cls.__new__(cls)
        self.db_path = None
        self.shared_settings = None
        self.harmonization = harmonization or {"version": 0, "mappings": []}
        self._lock = threading.Lock()
        self._cache_lock = threading.RLock()
        self._cache = OrderedDict()
        self._cache_size = 64
        self._mtime = None
        self.con = con
        return self

    def q(self, sql: str, params=None) -> pd.DataFrame:
        cur = self.con.cursor()
        try:
            return cur.execute(sql, params or []).df()
        finally:
            cur.close()

    def _cached(self, key, fn):
        with self._cache_lock:
            return self._cached_unlocked(key, fn)

    def _cached_unlocked(self, key, fn):
        if key in self._cache:
            self._cache.move_to_end(key)
            return self._cache[key]
        val = fn()
        self._cache[key] = val
        if len(self._cache) > self._cache_size:
            self._cache.popitem(last=False)
        return val

    # ------------------------------------------------------------- metadata
    def builds(self) -> pd.DataFrame:
        return self._cached(("builds",), lambda: self.q("SELECT * FROM builds ORDER BY source_type, subtype, segment, build_id"))

    def build(self, build_id: str) -> dict:
        df = self.builds()
        row = df[df.build_id == build_id]
        if row.empty:
            raise KeyError(f"Unknown build '{build_id}'")
        return {k: _jsonable(v) for k, v in row.iloc[0].to_dict().items()}

    def fields(self, build_id: str) -> list[dict]:
        df = self.q(
            "SELECT * FROM available_metadata_fields WHERE build_id = ? ORDER BY field_name", [build_id]
        )
        out = []
        for r in df.to_dict("records"):
            r["allowed_values"] = json.loads(r["allowed_values"] or "[]")
            out.append({k: _jsonable(v) for k, v in r.items()})
        return out

    def shared_filters(self, local_id: str, global_id: str) -> dict:
        key = ("shared_filters", local_id, global_id)
        return self._cached(key, lambda: self._shared_filters(local_id, global_id))

    def _shared_filters(self, local_id: str, global_id: str) -> dict:
        """Filters that can be applied to BOTH builds: attributes that are equivalent between the
        two JSONs. A pair of fields counts as equivalent if it is listed in settings
        (shared_filters) or has the same name in both builds, AND the two fields share at least
        one value. Among configured candidates, the pair sharing the most values is used."""
        cfg = self.shared_settings or {}
        lf = {f["field_name"]: f for f in self.fields(local_id)}
        gf = {f["field_name"]: f for f in self.fields(global_id)}
        vals = lambda f: {v["value"]: v["count"] for v in f["allowed_values"]}  # noqa: E731
        available, unavailable, used = [], [], set()

        def make(fid, label, l, g, how):
            lv, gv = vals(lf[l]), vals(gf[g])
            values = [
                {"value": v, "local_count": lv.get(v, 0), "global_count": gv.get(v, 0), "in_both": v in lv and v in gv}
                for v in set(lv) | set(gv)
            ]
            values.sort(key=lambda x: (not x["in_both"], -(x["local_count"] + x["global_count"]), x["value"]))
            return {"id": fid, "label": label, "local_field": l, "global_field": g, "matched_by": how,
                    "local_title": lf[l]["field_title"], "global_title": gf[g]["field_title"],
                    "n_shared_values": sum(v["in_both"] for v in values), "values": values}

        for d in cfg.get("pairs") or []:
            cands = [(l, g) for l in d.get("local", []) if l in lf for g in d.get("global", []) if g in gf]
            scored = sorted(((len(set(vals(lf[l])) & set(vals(gf[g]))), i, l, g) for i, (l, g) in enumerate(cands)),
                            key=lambda x: (-x[0], x[1]))
            if scored and scored[0][0] > 0:
                _, _, l, g = scored[0]
                available.append(make(d["id"], d.get("label", d["id"]), l, g, "settings (shared_filters)"))
                used |= {("l", l), ("g", g)}
            else:
                why = ("not in the local build" if not any(x in lf for x in d.get("local", [])) else
                       "not in the global build" if not any(x in gf for x in d.get("global", [])) else
                       "no values in common (different naming)")
                unavailable.append({"id": d["id"], "label": d.get("label", d["id"]), "reason": why})
        if cfg.get("auto_same_name", True):
            for name in sorted(set(lf) & set(gf)):
                if ("l", name) in used or ("g", name) in used or name in (cfg.get("never") or []):
                    continue
                if set(vals(lf[name])) & set(vals(gf[name])):
                    available.append(make(name, lf[name]["field_title"], name, name, "same field name"))
        return {"available": available, "unavailable": unavailable}

    def genotype_options(self, local_id: str, global_id: str) -> dict:
        ann = self.q(
            "SELECT * FROM gene_annotations WHERE build_id IN (?, ?)", [local_id, global_id]
        )
        genes = []
        for gene in sorted(set(ann.gene)):
            if gene == "nuc":
                pass
            rows = {r.build_id: r for r in ann[ann.gene == gene].itertuples()}
            loc, glo = rows.get(local_id), rows.get(global_id)
            available = bool(loc is not None and glo is not None and (loc.has_mutations or glo.has_mutations))
            coords_match = bool(
                loc is not None and glo is not None and loc.start_pos == glo.start_pos and loc.end_pos == glo.end_pos
            )
            note = None
            if loc is None or glo is None:
                note = f"{gene} annotation present only in the {'local' if loc is not None else 'global'} build JSON."
            elif not coords_match:
                note = (
                    f"{gene} coordinates differ between builds (local {loc.start_pos}-{loc.end_pos}, "
                    f"global {glo.start_pos}-{glo.end_pos}); positions may not refer to the same site."
                )
            genes.append(
                {
                    "gene": gene,
                    "label": "Nucleotide (nuc)" if gene == "nuc" else f"{gene} (amino acid)",
                    "seq_type": "nuc" if gene == "nuc" else "aa",
                    "available": available,
                    "coordinates_match": coords_match,
                    "note": note,
                }
            )
        # nuc first, then CDS alphabetical
        genes.sort(key=lambda g: (g["gene"] != "nuc", g["gene"]))
        pos = self.q(
            """
            SELECT gene, position,
                   max(CASE WHEN build_id = ? THEN n_tips_nonroot END) AS local_nonroot,
                   max(CASE WHEN build_id = ? THEN n_tips_nonroot END) AS global_nonroot,
                   max(CASE WHEN build_id = ? THEN n_states END) AS local_states,
                   max(CASE WHEN build_id = ? THEN n_states END) AS global_states
            FROM genotype_positions WHERE build_id IN (?, ?)
            GROUP BY gene, position ORDER BY gene, position
            """,
            [local_id, global_id, local_id, global_id, local_id, global_id],
        )
        positions: dict[str, list] = {}
        for r in pos.itertuples():
            positions.setdefault(r.gene, []).append(
                {
                    "position": int(r.position),
                    "variable_in_local": bool(pd.notna(r.local_states) and r.local_states > 1),
                    "variable_in_global": bool(pd.notna(r.global_states) and r.global_states > 1),
                    "local_nonroot": None if pd.isna(r.local_nonroot) else int(r.local_nonroot),
                    "global_nonroot": None if pd.isna(r.global_nonroot) else int(r.global_nonroot),
                }
            )
        return {"genes": genes, "positions": positions}

    # -------------------------------------------------------------- taxa SQL
    def _filter_clause(self, build_id: str, clauses: list[tuple[str, list[str]]]):
        """One AND-ed condition per clause; values within a clause are OR-ed."""
        sql, params = "", []
        for fld, values in clauses:
            if not values:
                continue
            ph = ", ".join("?" for _ in values)
            sql += (
                f" AND t.tip_id IN (SELECT tip_id FROM tip_attrs WHERE build_id = ? AND field = ? "
                f"AND value IN ({ph}))"
            )
            params += [build_id, fld, *[str(v) for v in values]]
        return sql, params

    def _genotype_states(self, build_id: str, spec: GenotypeSpec):
        """Per requested position: root state, or None if the build has no
        variation there and no root sequence to say what the state is."""
        gp = self.q(
            "SELECT position, root_state FROM genotype_positions WHERE build_id = ? AND gene = ?",
            [build_id, spec.gene],
        )
        roots = dict(zip(gp.position.astype(int), gp.root_state))
        seq = self.q(
            "SELECT sequence FROM root_sequences WHERE build_id = ? AND gene = ?", [build_id, spec.gene]
        )
        rs = seq.sequence.iloc[0] if not seq.empty else None
        out, unknown = [], []
        for p in spec.positions:
            if p in roots:
                out.append((p, roots[p]))
            elif rs and 0 < p <= len(rs):
                out.append((p, rs[p - 1].upper()))
            else:
                out.append((p, None))
                unknown.append(p)
        return out, unknown

    def _taxa_sql(self, query: Query, field_name: str | None):
        """SQL yielding (tip_id, taxon) for the build, with filters applied."""
        fsql, fparams = self._filter_clause(query.build_id, query.clauses())
        notes: list[str] = []
        if query.grouping in ("clade", "subclade"):
            col = "clade" if query.grouping == "clade" else "subclade"
            invalid = ", ".join(f"'{x}'" for x in sorted(INVALID_STRINGS))
            sql = (
                f"SELECT t.tip_id, CASE WHEN t.{col} IS NULL OR lower(t.{col}) IN ({invalid}) "
                f"THEN '{NOT_ASSIGNED}' ELSE t.{col} END AS taxon FROM tips t "
                f"WHERE t.build_id = ?{fsql}"
            )
            return sql, [query.build_id, *fparams], notes
        spec = query.genotype
        if not spec or not spec.positions:
            raise ValueError("Genotype grouping needs a gene and at least one position.")
        states, unknown = self._genotype_states(query.build_id, spec)
        if unknown:
            notes.append(
                f"Position(s) {', '.join(map(str, unknown))} of {spec.gene} show no variation in this build "
                "and the build JSON has no root sequence, so the state is not available in the source JSON "
                "(shown as '?')."
            )
        # literal VALUES list is safe: positions are ints, states are single letters from our own store
        vals_sql = ", ".join(
            f"({int(p)}, '{(s or '?').replace(chr(39), '')}')" for p, s in states
        )
        sql = f"""
            SELECT t.tip_id,
                   string_agg(CAST(gp.position AS VARCHAR) || COALESCE(tg.state, gp.root_state), ' '
                              ORDER BY gp.position) AS taxon
            FROM tips t
            CROSS JOIN (VALUES {vals_sql}) AS gp(position, root_state)
            LEFT JOIN tip_genotypes tg
                   ON tg.build_id = t.build_id AND tg.tip_id = t.tip_id
                  AND tg.gene = ? AND tg.position = gp.position
            WHERE t.build_id = ?{fsql}
            GROUP BY t.tip_id
        """
        return sql, [spec.gene, query.build_id, *fparams], notes

    # -------------------------------------------------------- frequencies
    def frequencies(self, query: Query) -> tuple[pd.DataFrame, dict]:
        key = ("freq", query.build_id, query.grouping,
               (query.genotype.gene, tuple(query.genotype.positions)) if query.genotype else None,
               query.filter_hash())
        return self._cached(key, lambda: self._frequencies(query))

    def _frequencies(self, query: Query):
        b = self.build(query.build_id)
        info = {"notes": [], "served_from": "computed"}
        total_tips = b["total_tip_count"]
        if query.grouping in ("clade", "subclade") and query.filter_hash() == "unfiltered":
            df = self.q(
                """
                SELECT pivot_idx, num_date, date_bin AS date, month, is_projection,
                       taxon_label AS taxon, frequency, numerator_count AS numerator,
                       denominator_count AS denominator
                FROM frequency_observations
                WHERE build_id = ? AND grouping_type = ? AND filter_context_hash = 'unfiltered'
                """,
                [query.build_id, query.grouping],
            )
            if not df.empty:
                info["served_from"] = "precomputed"
                info["tips_included"] = total_tips
                return df, info
        taxa_sql, params, notes = self._taxa_sql(query, None)
        info["notes"] += notes
        sql = f"""
            WITH tx AS ({taxa_sql}),
            w AS (
                SELECT tf.pivot_idx, tx.taxon, SUM(tf.weight) AS w
                FROM tip_frequencies tf JOIN tx ON tf.tip_id = tx.tip_id
                WHERE tf.build_id = ?
                GROUP BY tf.pivot_idx, tx.taxon
            ),
            tot AS (SELECT pivot_idx, SUM(w) AS tw FROM w GROUP BY pivot_idx),
            cnt AS (
                SELECT t.pivot_bin AS pivot_idx, tx.taxon, COUNT(*) AS n
                FROM tips t JOIN tx ON t.tip_id = tx.tip_id
                WHERE t.build_id = ? AND t.pivot_bin IS NOT NULL
                GROUP BY t.pivot_bin, tx.taxon
            ),
            cnt_tot AS (SELECT pivot_idx, SUM(n) AS nt FROM cnt GROUP BY pivot_idx)
            SELECT p.pivot_idx, p.num_date, p.date, p.month, p.is_projection,
                   w.taxon, w.w / NULLIF(tot.tw, 0) AS frequency,
                   COALESCE(cnt.n, 0) AS numerator, COALESCE(cnt_tot.nt, 0) AS denominator
            FROM w
            JOIN tot ON tot.pivot_idx = w.pivot_idx
            JOIN pivots p ON p.build_id = ? AND p.pivot_idx = w.pivot_idx
            LEFT JOIN cnt ON cnt.pivot_idx = w.pivot_idx AND cnt.taxon = w.taxon
            LEFT JOIN cnt_tot ON cnt_tot.pivot_idx = w.pivot_idx
            ORDER BY p.pivot_idx, w.taxon
        """
        df = self.q(sql, [*params, query.build_id, query.build_id, query.build_id])
        n_inc = self.q(f"SELECT COUNT(*) AS n FROM ({taxa_sql})", params).n.iloc[0]
        info["tips_included"] = int(n_inc)
        return df, info

    def all_taxa(self, build_ids: list[str], grouping: str, genotype: GenotypeSpec | None) -> list[str]:
        """Unfiltered taxon labels across builds (used for stable colours)."""
        labels: set[str] = set()
        for bid in build_ids:
            sql, params, _ = self._taxa_sql(Query(bid, grouping, genotype, {}), None)
            labels |= set(self.q(f"SELECT DISTINCT taxon FROM ({sql})", params).taxon.dropna())
        return sorted(labels)

    # -------------------------------------------------------- harmonization
    def harmonize(self, df: pd.DataFrame, subtype: str, source: str, grouping: str):
        applied = []
        maps = {}
        for m in self.harmonization.get("mappings", []):
            if m.get("grouping") != grouping:
                continue
            if m.get("subtype", "*") not in ("*", subtype):
                continue
            if m.get("source", "both") not in ("both", source):
                continue
            maps[str(m["from"])] = str(m["to"])
        if not maps or df.empty:
            return df, applied
        hit = df.taxon.isin(maps.keys())
        if hit.any():
            for k in sorted(set(df.taxon[hit])):
                applied.append({"source": source, "from": k, "to": maps[k]})
            df = df.copy()
            df["taxon"] = df.taxon.replace(maps)
            df = (
                df.groupby(["pivot_idx", "num_date", "date", "month", "is_projection", "taxon"], as_index=False)
                .agg(frequency=("frequency", "sum"), numerator=("numerator", "sum"), denominator=("denominator", "first"))
            )
        return df, applied

    # --------------------------------------------------------------- colours
    def colors(self, local_id: str, global_id: str, grouping: str, taxa: list[str], palette: str):
        """Colour per taxon, plus a description of where the colours came from.

        "nextstrain" palette, clade/subclade: exactly as nextstrain.org shows the selected
        global build (official scale fetched on the latest `ffc fetch`, Auspice grey for
        unlisted values, Auspice default palette for fields without a scale; see colors.py).
        Otherwise (genotype, or the colour-blind palette): a colour-blind-safe palette.
        """
        special = {OTHER: OTHER_COLOR, NOT_ASSIGNED: NOT_ASSIGNED_COLOR}
        plain = [t for t in taxa if t not in special]
        info: dict = {"palette": palette, "grouping": grouping}
        out: dict[str, str] = {}
        if palette == "nextstrain" and grouping in ("clade", "subclade"):
            lb, gb = self.build(local_id), self.build(global_id)
            key = gb.get(f"{grouping}_field")
            ref = self.q(
                "SELECT value, color, sources, fetched_at FROM reference_colors "
                "WHERE subtype = ? AND segment = ? AND coloring_key = ? ORDER BY rank",
                [gb["subtype"], gb["segment"], key],
            ) if key else pd.DataFrame()
            if not ref.empty:
                official = list(zip(ref.value, ref.color))
                info["official_source"] = (
                    f"nextstrain.org seasonal-flu {gb['subtype']} {gb['segment']} colours for '{key}', "
                    f"fetched {ref.fetched_at.iloc[0]}"
                )
            else:
                sc = self.q(
                    "SELECT value, color FROM color_scales WHERE build_id = ? AND coloring_key = ? ORDER BY rowid",
                    [global_id, key],
                ) if key else pd.DataFrame(columns=["value", "color"])
                official = list(zip(sc.value, sc.color))
                info["official_source"] = (
                    f"scale in the selected global build JSON ('{key}')" if official
                    else f"'{key}' has no colour scale in the national build; Auspice default palette"
                )
            tree_vals = self.q(
                "SELECT value, n_nodes FROM value_order WHERE build_id = ? AND coloring_key = ? ORDER BY first_index",
                [global_id, key],
            ) if key else pd.DataFrame(columns=["value", "n_nodes"])
            lkey = lb.get(f"{grouping}_field")
            lsc = self.q(
                "SELECT value, color FROM color_scales WHERE build_id = ? AND coloring_key = ?", [local_id, lkey]
            ) if lkey else pd.DataFrame(columns=["value", "color"])
            cmap, src = national_colors(
                plain, key, official, list(zip(tree_vals.value, tree_vals.n_nodes.astype(int))),
                dict(zip(lsc.value, lsc.color)),
            )
            out = {t: cmap[t] for t in plain}
            info["key"] = key
            info["by_source"] = {}
            for t in plain:
                info["by_source"].setdefault(src[t], []).append(t)
        else:
            for i, t in enumerate(plain):
                out[t] = COLORBLIND_PALETTE[i % len(COLORBLIND_PALETTE)]
            info["official_source"] = "colour-blind-safe palette" if palette == "colorblind" else (
                "colour-blind-safe palette (genotypes have no national colour scale)")
        return out | special, info

    # ------------------------------------------------------------ comparison
    def compare(self, req: dict) -> dict:
        """Everything the dashboard needs for one view. `req` keys:
        local_build_id, global_build_id, grouping, genotype {gene, positions},
        local_filters, global_filters, start, end (ISO dates), top_n,
        snapshot {mode: point|range, timepoint}, palette, include_projection."""
        key = ("compare", json.dumps(req, sort_keys=True, default=str))
        return self._cached(key, lambda: self._compare(req))

    def _compare(self, req: dict) -> dict:
        lid, gid = req["local_build_id"], req["global_build_id"]
        lb, gb = self.build(lid), self.build(gid)
        if lb["source_type"] != "local" or gb["source_type"] != "global":
            raise ValueError("local_build_id must be a local build and global_build_id a global build.")
        if lb["subtype"] != gb["subtype"] or lb["segment"] != gb["segment"]:
            raise ValueError(
                f"Incompatible builds: local is {lb['subtype']}/{lb['segment']}, "
                f"global is {gb['subtype']}/{gb['segment']}."
            )
        grouping = req.get("grouping", "subclade")
        geno = None
        if grouping == "genotype":
            g = req.get("genotype") or {}
            positions = sorted({int(p) for p in g.get("positions") or []})
            if not g.get("gene") or not positions:
                raise ValueError("Choose a gene and at least one position for genotype grouping.")
            geno = GenotypeSpec(g["gene"], positions)
        lq = Query(lid, grouping, geno, req.get("local_filters") or {})
        gq = Query(gid, grouping, geno, req.get("global_filters") or {})
        shared_applied = []
        if any((req.get("shared_filters") or {}).values()):
            defs = {d["id"]: d for d in self.shared_filters(lid, gid)["available"]}
            for fid, values in sorted((req.get("shared_filters") or {}).items()):
                if not values:
                    continue
                if fid not in defs:
                    raise ValueError(f"Filter '{fid}' cannot be applied to both of these builds.")
                d = defs[fid]
                lq.extra.append((d["local_field"], list(values)))
                gq.extra.append((d["global_field"], list(values)))
                shared_applied.append({"id": fid, "label": d["label"], "values": sorted(values),
                                       "local_field": d["local_field"], "global_field": d["global_field"]})
        req = {**req, "_shared_applied": shared_applied}
        ldf, linfo = self.frequencies(lq)
        gdf, ginfo = self.frequencies(gq)
        ldf, lmap = self.harmonize(ldf, lb["subtype"], "local", grouping)
        gdf, gmap = self.harmonize(gdf, gb["subtype"], "global", grouping)

        include_proj = bool(req.get("include_projection", False))
        if not include_proj:
            ldf = ldf[~ldf.is_projection.astype(bool)]
            gdf = gdf[~gdf.is_projection.astype(bool)]

        # Date availability (before range restriction)
        def rng(df):
            if df.empty:
                return None
            return [pd.Timestamp(df.date.min()).date().isoformat(), pd.Timestamp(df.date.max()).date().isoformat()]

        local_range, global_range = rng(ldf), rng(gdf)
        shared = None
        if local_range and global_range:
            s, e = max(local_range[0], global_range[0]), min(local_range[1], global_range[1])
            shared = [s, e] if s <= e else None

        start, end = req.get("start"), req.get("end")

        def in_range(df, col="date"):
            d = pd.to_datetime(df[col])
            m = pd.Series(True, index=df.index)
            if start:
                m &= d >= pd.Timestamp(start)
            if end:
                m &= d <= pd.Timestamp(end)
            return df[m]

        ldf_r, gdf_r = in_range(ldf), in_range(gdf)

        # Top-N + Other, ranked by max frequency in either dataset within range
        top_n = int(req.get("top_n") or 0)
        all_taxa = sorted(set(ldf_r.taxon) | set(gdf_r.taxon))
        grouped_other: list[str] = []
        if top_n and len(all_taxa) > top_n:
            mx = pd.concat([ldf_r[["taxon", "frequency"]], gdf_r[["taxon", "frequency"]]]).groupby("taxon").frequency.max()
            keep = set(mx.sort_values(ascending=False).index[:top_n])
            grouped_other = sorted(set(all_taxa) - keep)

            def collapse(df):
                if df.empty:
                    return df
                df = df.copy()
                df.loc[~df.taxon.isin(keep), "taxon"] = OTHER
                return df.groupby(["pivot_idx", "num_date", "date", "month", "is_projection", "taxon"], as_index=False).agg(
                    frequency=("frequency", "sum"), numerator=("numerator", "sum"), denominator=("denominator", "first")
                )

            ldf, gdf, ldf_r, gdf_r = collapse(ldf), collapse(gdf), collapse(ldf_r), collapse(gdf_r)

        taxa_order = self._order_taxa(ldf_r, gdf_r)
        stable = self.all_taxa([lid, gid], grouping, geno)
        colors, color_info = self.colors(
            lid, gid, grouping, stable + [t for t in taxa_order if t not in stable], req.get("palette", "nextstrain")
        )

        # One shared set of timepoints for both builds (see constants.ALIGNMENT_METHOD)
        aligned_all, grid_info = self.aligned_frame(lid, gid, ldf, gdf, include_proj)
        aligned = in_range(aligned_all, "grid_date") if not aligned_all.empty else aligned_all
        snapshot = self.snapshot(aligned, req.get("snapshot") or {})

        notes = []
        if grouping in ("clade", "subclade"):
            lt = set(ldf.taxon) - {OTHER, NOT_ASSIGNED}
            gt = set(gdf.taxon) - {OTHER, NOT_ASSIGNED}
            if lt and gt and not (lt & gt):
                ex_l, ex_g = sorted(lt)[:2], sorted(gt)[:2]
                notes.append(
                    f"No {grouping} labels in common: the local build uses '{lb.get(grouping + '_field')}' "
                    f"(e.g. {', '.join(ex_l)}) and the global build uses '{gb.get(grouping + '_field')}' "
                    f"(e.g. {', '.join(ex_g)}). These are different naming schemes, so the builds cannot be "
                    "compared label by label. A mapping can be added to config/taxon_harmonization.yaml."
                )

        tp = lambda m: sorted(aligned.loc[m, "grid_date"].dt.date.astype(str).unique()) if not aligned.empty else []  # noqa: E731
        return {
            "local": self._series_payload(ldf_r, linfo, lb),
            "global": self._series_payload(gdf_r, ginfo, gb),
            "aligned": self._aligned_series(aligned),
            "alignment": grid_info,
            "taxa": taxa_order,
            "colors": colors,
            "color_info": color_info,
            "grouped_into_other": grouped_other,
            "difference": self._difference_payload(aligned),
            "snapshot": snapshot,
            "notes": notes,
            "date_ranges": {
                "local": local_range,
                "global": global_range,
                "shared": shared,
                "selected": [start, end],
                "selection_has_both": bool(not aligned.empty and aligned.both.any()),
            },
            "timepoints": {
                "local": tp(aligned.in_local) if not aligned.empty else [],
                "global": tp(aligned.in_global) if not aligned.empty else [],
                "shared": tp(aligned.both) if not aligned.empty else [],
            },
            "harmonization": {"version": self.harmonization.get("version"), "applied": lmap + gmap},
            "provenance": self.provenance(lb, gb, linfo, ginfo, req, grouping, geno, grid_info, color_info),
        }

    @staticmethod
    def _order_taxa(ldf, gdf):
        both = pd.concat([ldf[["taxon", "frequency"]], gdf[["taxon", "frequency"]]])
        if both.empty:
            return []
        order = both.groupby("taxon").frequency.mean().sort_values(ascending=False).index.tolist()
        for special in (OTHER, NOT_ASSIGNED):
            if special in order:
                order.remove(special)
                order.append(special)
        return order

    @staticmethod
    def _series_payload(df: pd.DataFrame, info: dict, b: dict) -> dict:
        pivots = (
            df[["pivot_idx", "date", "month", "denominator"]].drop_duplicates("pivot_idx").sort_values("pivot_idx")
            if not df.empty
            else pd.DataFrame(columns=["pivot_idx", "date", "month", "denominator"])
        )
        dates = [pd.Timestamp(d).date().isoformat() for d in pivots.date]
        series = {}
        for taxon, g in df.groupby("taxon"):
            g = g.set_index("pivot_idx").reindex(pivots.pivot_idx)
            series[taxon] = {
                "frequency": [None if pd.isna(v) else round(float(v), 6) for v in g.frequency.fillna(0)],
                "numerator": [int(v) for v in g.numerator.fillna(0)],
            }
        return {
            "build_id": b["build_id"],
            "dates": dates,
            "months": list(pivots.month),
            "denominator": [int(v) for v in pivots.denominator.fillna(0)],
            "series": series,
            "tips_included": info.get("tips_included"),
            "tips_total": b["total_tip_count"],
            "served_from": info.get("served_from"),
            "notes": info.get("notes", []),
        }

    # ------------------------------------------------------------ alignment
    def pivot_dates(self, build_id: str, include_projection: bool = False) -> pd.DataFrame:
        df = self.q("SELECT pivot_idx, date, is_projection FROM pivots WHERE build_id = ? ORDER BY pivot_idx", [build_id])
        if not include_projection:
            df = df[~df.is_projection.astype(bool)]
        return pd.DataFrame({"pivot_idx": df.pivot_idx.astype(int).values, "date": pd.to_datetime(df.date).values})

    def aligned_frame(self, lid, gid, ldf, gdf, include_projection=False):
        return self.align(ldf, gdf, self.pivot_dates(lid, include_projection), self.pivot_dates(gid, include_projection))

    @staticmethod
    def _spacing_days(dates: pd.Series) -> float:
        if len(dates) < 2:
            return 30.0
        d = np.diff(np.sort(pd.to_datetime(dates).values)).astype("timedelta64[s]").astype(float) / 86400
        return float(np.median(d))

    @classmethod
    def build_grid(cls, lp: pd.DataFrame, gp: pd.DataFrame):
        """Shared timepoints: the pivots of the build with the coarser pivot spacing,
        extended at the same spacing over the other build's date span."""
        ls, gs = cls._spacing_days(lp.date), cls._spacing_days(gp.date)
        if lp.empty and gp.empty:
            return pd.DatetimeIndex([]), {"reference": None, "step_days": None}
        ref = "global" if lp.empty or (not gp.empty and gs > 1.5 * ls) else "local"
        refp, other = (lp, gp) if ref == "local" else (gp, lp)
        step = cls._spacing_days(refp.date)
        monthly = 26 <= step <= 35
        anchor = pd.Timestamp(refp.date.iloc[0])
        def at(k):  # noqa: E306
            return anchor + pd.DateOffset(months=k) if monthly else anchor + pd.Timedelta(days=round(step) * k)
        grid = list(pd.to_datetime(refp.date))
        if not other.empty:
            tol = pd.Timedelta(days=0.5 * cls._spacing_days(other.date) + 0.5)
            lo, hi = pd.Timestamp(other.date.min()) - tol, pd.Timestamp(other.date.max()) + tol
            k = 0
            while True:
                k -= 1
                d = at(k)
                if d < lo:
                    break
                if d < grid[0]:
                    grid.insert(0, d)
            n_ref = len(refp)
            k = n_ref - 1
            while True:
                k += 1
                d = at(k)
                if d > hi:
                    break
                if d > grid[-1]:
                    grid.append(d)
        info = {
            "reference": ref,
            "step_days": round(step, 1),
            "step": "monthly" if monthly else f"every {round(step)} days",
            "local_spacing_days": round(ls, 1) if not lp.empty else None,
            "global_spacing_days": round(gs, 1) if not gp.empty else None,
        }
        return pd.DatetimeIndex(grid), info

    @classmethod
    def _match(cls, grid: pd.DatetimeIndex, piv: pd.DataFrame):
        """Nearest pivot to each grid point, within half the build's pivot spacing."""
        n = len(grid)
        out = np.full(n, -1)
        dist = np.full(n, np.nan)
        if piv.empty or n == 0:
            return out, dist
        pdates = pd.to_datetime(piv.date).values
        tol = 0.5 * cls._spacing_days(piv.date) + 0.5
        g = grid.values
        idx = np.searchsorted(pdates, g)
        best = {}
        for i in range(n):
            cands = [j for j in (idx[i] - 1, idx[i]) if 0 <= j < len(pdates)]
            if not cands:
                continue
            j = min(cands, key=lambda j: abs((pdates[j] - g[i]) / np.timedelta64(1, "D")))
            d = (pdates[j] - g[i]) / np.timedelta64(1, "D")
            if abs(d) <= tol and (j not in best or abs(d) < abs(best[j][1])):
                if j in best:
                    out[best[j][0]] = -1
                    dist[best[j][0]] = np.nan
                best[j] = (i, d)
                out[i] = int(piv.pivot_idx.iloc[j])
                dist[i] = d
        return out, dist

    @classmethod
    def align(cls, ldf: pd.DataFrame, gdf: pd.DataFrame, lp: pd.DataFrame, gp: pd.DataFrame):
        """Put both builds on one set of timepoints; see constants.ALIGNMENT_METHOD.
        Returns (long DataFrame by grid_date x taxon, grid info)."""
        grid, info = cls.build_grid(lp, gp)
        cols = ["grid_date", "taxon", "both", "in_local", "in_global"]
        if len(grid) == 0:
            return pd.DataFrame(columns=cols), info
        g = len(grid)
        edges = np.empty(g + 1, dtype="datetime64[ns]")
        gv = grid.values
        if g == 1:
            half = np.timedelta64(int(info["step_days"] * 43200), "s")
            edges[0], edges[1] = gv[0] - half, gv[0] + half
        else:
            mids = gv[:-1] + (gv[1:] - gv[:-1]) / 2
            edges[1:-1] = mids
            edges[0] = gv[0] - (gv[1] - gv[0]) / 2
            edges[-1] = gv[-1] + (gv[-1] - gv[-2]) / 2

        def side(df, piv):
            match, dist = cls._match(grid, piv)
            present_piv = set(df.pivot_idx) if not df.empty else set()
            present = np.array([m >= 0 and m in present_piv for m in match])
            pdate = dict(zip(piv.pivot_idx, pd.to_datetime(piv.date)))
            m = pd.DataFrame({"gi": np.arange(g), "pivot_idx": match})
            freq = m[m.pivot_idx >= 0].merge(df[["pivot_idx", "taxon", "frequency"]], on="pivot_idx") if not df.empty else \
                pd.DataFrame(columns=["gi", "pivot_idx", "taxon", "frequency"])
            # counts: native pivot intervals summed into grid intervals
            if not df.empty:
                pi = np.searchsorted(edges, pd.to_datetime(piv.date).values, side="right") - 1
                interval = dict(zip(piv.pivot_idx, pi))
                d2 = df.assign(gi=df.pivot_idx.map(interval))
                d2 = d2[(d2.gi >= 0) & (d2.gi < g)]
                num = d2.groupby(["gi", "taxon"]).numerator.sum()
                den = d2.drop_duplicates("pivot_idx").groupby("gi").denominator.sum()
            else:
                num, den = pd.Series(dtype=float), pd.Series(dtype=float)
            meta = pd.DataFrame({
                "gi": np.arange(g), "present": present,
                "pivot_date": [pdate.get(x) if x >= 0 else pd.NaT for x in match],
                "offset_days": dist,
                "denominator": [den.get(i, 0) for i in range(g)],
            })
            return freq[["gi", "taxon", "frequency"]], num, meta

        lf, ln, lm = side(ldf, lp)
        gf, gn, gm = side(gdf, gp)
        keys = pd.concat([lf[["gi", "taxon"]], gf[["gi", "taxon"]],
                          ln.reset_index()[["gi", "taxon"]], gn.reset_index()[["gi", "taxon"]]]).drop_duplicates()
        a = keys.merge(lf.rename(columns={"frequency": "frequency_local"}), on=["gi", "taxon"], how="left")
        a = a.merge(gf.rename(columns={"frequency": "frequency_global"}), on=["gi", "taxon"], how="left")
        a["numerator_local"] = [ln.get((i, t), 0) for i, t in zip(a.gi, a.taxon)]
        a["numerator_global"] = [gn.get((i, t), 0) for i, t in zip(a.gi, a.taxon)]
        for sname, meta in (("local", lm), ("global", gm)):
            mm = meta.set_index("gi")
            a[f"in_{sname}"] = a.gi.map(mm.present).astype(bool)
            a[f"pivot_date_{sname}"] = a.gi.map(mm.pivot_date)
            a[f"offset_days_{sname}"] = a.gi.map(mm.offset_days)
            a[f"denominator_{sname}"] = a.gi.map(mm.denominator)
            a[f"frequency_{sname}"] = np.where(a[f"in_{sname}"], a[f"frequency_{sname}"].fillna(0), np.nan)
        a["both"] = a.in_local & a.in_global
        a["grid_date"] = grid[a.gi.values]
        comparable = a.both & ~a.taxon.astype(str).str.contains("?", regex=False)
        a["difference_pp"] = np.where(comparable, (a.frequency_local - a.frequency_global) * 100, np.nan)
        a = a[a.in_local | a.in_global].sort_values(["grid_date", "taxon"]).reset_index(drop=True)
        off = lambda s: float(np.nanmax(np.abs(a[f"offset_days_{s}"]))) if a[f"in_{s}"].any() else None  # noqa: E731
        info["max_offset_days"] = {"local": off("local"), "global": off("global")}
        info["method"] = ALIGNMENT_METHOD
        return a, info

    @staticmethod
    def _aligned_series(a: pd.DataFrame) -> dict:
        if a.empty:
            return {"dates": [], "local": None, "global": None}
        dates = sorted(a.grid_date.unique())
        out = {"dates": [pd.Timestamp(d).date().isoformat() for d in dates]}
        for sname in ("local", "global"):
            meta = a.drop_duplicates("grid_date").set_index("grid_date").reindex(dates)
            present = [bool(x) for x in meta[f"in_{sname}"].fillna(False)]
            series = {}
            for taxon, gtx in a.groupby("taxon"):
                gtx = gtx.set_index("grid_date").reindex(dates)
                series[taxon] = {
                    "frequency": [round(float(v), 6) if p and pd.notna(v) else (0.0 if p else None)
                                  for v, p in zip(gtx[f"frequency_{sname}"], present)],
                    "numerator": [int(v) if p and pd.notna(v) else (0 if p else None)
                                  for v, p in zip(gtx[f"numerator_{sname}"], present)],
                }
            out[sname] = {
                "present": present,
                "pivot_dates": [pd.Timestamp(d).date().isoformat() if p and pd.notna(d) else None
                                for d, p in zip(meta[f"pivot_date_{sname}"], present)],
                "offset_days": [None if not p or pd.isna(d) else round(float(d), 1)
                                for d, p in zip(meta[f"offset_days_{sname}"], present)],
                "denominator": [int(v) if p else None for v, p in zip(meta[f"denominator_{sname}"].fillna(0), present)],
                "series": series,
            }
        return out

    @staticmethod
    def _difference_payload(a: pd.DataFrame) -> dict:
        if a.empty or not a.both.any():
            return {"dates": [], "series": {}, "method": ALIGNMENT_METHOD}
        b = a[a.both]
        dates = sorted(b.grid_date.unique())
        series = {}
        for taxon, g in b.groupby("taxon"):
            g = g.set_index("grid_date").reindex(dates)
            if g.difference_pp.isna().all():
                continue
            series[taxon] = {
                "difference_pp": [None if pd.isna(v) else round(float(v), 4) for v in g.difference_pp],
                "local": [None if pd.isna(v) else round(float(v), 6) for v in g.frequency_local],
                "global": [None if pd.isna(v) else round(float(v), 6) for v in g.frequency_global],
                "local_n": [None if pd.isna(v) else int(v) for v in g.numerator_local],
                "global_n": [None if pd.isna(v) else int(v) for v in g.numerator_global],
            }
        return {"dates": [pd.Timestamp(d).date().isoformat() for d in dates], "series": series, "method": ALIGNMENT_METHOD}

    @staticmethod
    def snapshot(a: pd.DataFrame, spec: dict) -> dict:
        """Comparison table at one shared timepoint, or the mean over all shared timepoints in range."""
        mode = spec.get("mode", "range")
        if a.empty or not a.both.any():
            return {"mode": mode, "label": None, "rows": [], "timepoints": []}
        shared = a[a.both]
        pts = sorted(shared.grid_date.dt.date.astype(str).unique())
        if mode == "point":
            tp = spec.get("timepoint") if spec.get("timepoint") in pts else pts[-1]
            sel = shared[shared.grid_date.dt.date.astype(str) == tp]
            label, used = tp, [tp]
        else:
            sel = shared
            label, used = f"{pts[0]} to {pts[-1]} (mean of {len(pts)} shared timepoints)", pts
        n_m = len(used)
        g = sel.groupby("taxon").agg(
            local_frequency=("frequency_local", "sum"),
            global_frequency=("frequency_global", "sum"),
            local_n=("numerator_local", "sum"),
            global_n=("numerator_global", "sum"),
        )
        g["local_frequency"] /= n_m
        g["global_frequency"] /= n_m
        g["difference_pp"] = (g.local_frequency - g.global_frequency) * 100
        g.loc[g.index.astype(str).str.contains("?", regex=False), "difference_pp"] = np.nan
        den_l = sel.drop_duplicates("grid_date").denominator_local.sum()
        den_g = sel.drop_duplicates("grid_date").denominator_global.sum()
        rows = []
        for taxon, r in g.iterrows():
            lp, gp = r.local_frequency > 0 or r.local_n > 0, r.global_frequency > 0 or r.global_n > 0
            if not (lp or gp):
                continue
            rows.append({
                "taxon": taxon,
                "local_frequency": round(float(r.local_frequency), 6),
                "global_frequency": round(float(r.global_frequency), 6),
                "difference_pp": None if pd.isna(r.difference_pp) else round(float(r.difference_pp), 4),
                "local_n": int(r.local_n),
                "global_n": int(r.global_n),
                "local_denominator": int(den_l),
                "global_denominator": int(den_g),
                "presence": "both" if lp and gp else ("local only" if lp else "global only"),
            })
        return {"mode": mode, "label": label, "timepoints": used, "rows": rows}

    # ------------------------------------------------------------ provenance
    def provenance(self, lb, gb, linfo, ginfo, req, grouping, geno, grid_info=None, color_info=None) -> dict:
        def val(v, source):
            if v is None or v == "" or (isinstance(v, float) and np.isnan(v)):
                missing = NOT_AVAILABLE if source in ("json", "derived") else "Not supplied in manifest"
                return {"value": missing, "source": "missing"}
            return {"value": v, "source": source}

        def side(b, info, filters, name):
            mm = json.loads(b.get("manifest_metadata") or "{}")
            jm = json.loads(b.get("json_metadata") or "{}")
            dp = jm.get("data_provenance")
            dp_txt = "; ".join(x.get("name", "") for x in dp) if isinstance(dp, list) else None
            src_file = Path(b["auspice_json_path"]).name if b.get("auspice_json_path") else None
            return {
                "dataset_name": {"value": name, "source": "app"},
                "build_label": val(b.get("display_name"), "manifest"),
                "build_id": val(b.get("build_id"), "manifest"),
                "json_source": val(src_file, "manifest"),
                "remote": val(b.get("remote"), "manifest"),
                "fetched_at": val(b.get("fetched_at"), "manifest"),
                "json_title": val(b.get("json_title"), "json"),
                "subtype": val(SUBTYPES.get(b.get("subtype"), b.get("subtype")), "manifest"),
                "segment": val(b.get("segment"), "manifest"),
                "resolution": val(b.get("resolution"), "manifest"),
                "build_date": val(b.get("build_date"), "manifest"),
                "updated_date": val(b.get("updated_date"), "json"),
                "most_recent_sample_date": val(b.get("most_recent_sample_date"), "json"),
                "earliest_sample_date": val(b.get("min_sample_date"), "json"),
                "total_tips": val(b.get("total_tip_count"), "json"),
                "tips_after_filtering": val(info.get("tips_included"), "derived"),
                "active_filters": {"value": filters or {}, "source": "user"},
                "frequency_source": val(FREQ_SOURCE_LABELS.get(b.get("frequency_source")), "app"),
                "frequency_source_detail": val(b.get("frequency_source_detail"), "app"),
                "downsampling": val(b.get("downsampling_description"), "manifest"),
                "data_provenance": val(dp_txt, "json"),
                "clade_field": val(b.get("clade_field"), "json"),
                "subclade_field": val(b.get("subclade_field"), "json"),
                "ingestion_timestamp": val(b.get("ingestion_timestamp"), "app"),
                "synthetic": bool(mm.get("synthetic", False)),
            }

        ing = max(str(lb.get("ingestion_timestamp")), str(gb.get("ingestion_timestamp")))
        refreshed = None
        if self.db_path is not None and self.db_path.exists():
            import datetime as _dt

            refreshed = _dt.datetime.fromtimestamp(self.db_path.stat().st_mtime).astimezone().isoformat(timespec="seconds")
        return {
            "local": side(lb, linfo, req.get("local_filters"), LOCAL_DATASET_NAME),
            "global": side(gb, ginfo, req.get("global_filters"), GLOBAL_DATASET_NAME),
            "comparison": {
                "grouping": grouping,
                "genotype_definition": geno.definition if geno else None,
                "selected_range": [req.get("start"), req.get("end")],
                "shared_filters": req.get("_shared_applied") or [],
                "alignment_method": ALIGNMENT_METHOD,
                "alignment_detail": _grid_text(grid_info),
                "colours": (color_info or {}).get("official_source"),
                "count_method": COUNT_METHOD,
                "data_processing_timestamp": ing,
                "dashboard_refresh_timestamp": refreshed,
                "harmonization_version": self.harmonization.get("version"),
            },
        }


def _grid_text(info: dict | None) -> str | None:
    if not info or not info.get("reference"):
        return None
    ref = "JHH local" if info["reference"] == "local" else "Nextstrain global"
    other = "global" if info["reference"] == "local" else "local"
    mo = (info.get("max_offset_days") or {}).get(other)
    sp = lambda x: "n/a" if x is None else f"{x:g} days"  # noqa: E731
    txt = (f"Shared timepoints = the {ref} build's frequency pivots ({info['step']}), extended at the same spacing. "
           f"Pivot spacing: local {sp(info.get('local_spacing_days'))}, global {sp(info.get('global_spacing_days'))}.")
    if mo is not None:
        txt += f" {other.capitalize()} values come from its nearest pivot, at most {mo:g} days away."
    return txt
