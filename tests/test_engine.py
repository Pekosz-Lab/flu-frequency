import json
import socket

import numpy as np
import pytest

from ffc.constants import NOT_AVAILABLE
from ffc.engine import Engine, Query
from ffc.ingest import run_ingest


def req(**kw):
    base = {"local_build_id": "loc", "global_build_id": "glob", "grouping": "subclade"}
    base.update(kw)
    return base


def col_sums(payload):
    return np.array([s["frequency"] for s in payload["series"].values()], dtype=float).sum(axis=0)


def test_ingest_report_and_sources(project, engine):
    rep = project["report"]["builds"]
    assert {k: v["status"] for k, v in rep.items()} == {k: "ingested" for k in ["loc", "loc2", "glob", "glob6", "h1glob"]}
    srcs = dict(zip(engine.builds().build_id, engine.builds().frequency_source))
    assert srcs["loc"] == "imported" and srcs["loc2"] == "recomputed"


def test_frequencies_normalised(engine):
    r = engine.compare(req())
    assert np.allclose(col_sums(r["local"]), 1, atol=1e-6)
    assert np.allclose(col_sums(r["global"]), 1, atol=1e-6)
    assert r["local"]["served_from"] == "precomputed"


def test_filters_renormalise_and_count(engine):
    fields = {f["field_name"]: f for f in engine.fields("glob")}
    assert "region" in fields
    region = fields["region"]["allowed_values"][0]["value"]
    r = engine.compare(req(global_filters={"region": [region]}))
    assert r["global"]["served_from"] == "computed"
    assert r["global"]["tips_included"] == fields["region"]["allowed_values"][0]["count"]
    s = col_sums(r["global"])
    assert np.allclose(s[s > 0], 1, atol=1e-6)
    # local and global filters are independent
    assert r["local"]["tips_included"] == engine.build("loc")["total_tip_count"]


def test_difference_sign_and_unmatched_taxa(engine):
    r = engine.compare(req())
    d = r["difference"]
    for t, s in d["series"].items():
        for dp, lf, gf in zip(s["difference_pp"], s["local"], s["global"]):
            if dp is not None:
                assert dp == pytest.approx((lf - gf) * 100, abs=1e-3)
    presences = {row["presence"] for row in r["snapshot"]["rows"]}
    assert presences <= {"both", "local only", "global only"}
    assert d["dates"] == r["timepoints"]["shared"]


def test_incompatible_pair_rejected(engine):
    with pytest.raises(ValueError, match="Incompatible"):
        engine.compare(req(global_build_id="h1glob"))
    with pytest.raises(ValueError):
        engine.compare(req(local_build_id="glob", global_build_id="glob6"))


def test_projection_hidden_by_default(engine):
    piv = str(engine.q("SELECT max(date) m FROM pivots WHERE build_id='glob' AND NOT is_projection").m[0])[:10]
    r = engine.compare(req())
    assert max(r["global"]["dates"]) <= piv
    r2 = engine.compare(req(include_projection=True))
    assert max(r2["global"]["dates"]) > piv


def test_missing_provenance_marked(engine):
    p = engine.compare(req())["provenance"]
    assert p["local"]["build_date"]["source"] == "missing"
    assert p["local"]["remote"]["value"] == "Not supplied in manifest"
    assert p["global"]["remote"]["value"] == "nextstrain.org/flu/seasonal/h3n2/ha/2y"
    assert p["global"]["updated_date"]["source"] == "json"
    assert NOT_AVAILABLE == "Not available in source JSON"


def test_top_n_other(engine):
    r = engine.compare(req(top_n=2))
    assert "Other" in r["taxa"] and len(r["taxa"]) <= 4  # 2 + Other (+ Not assigned possibly grouped)
    assert np.allclose(col_sums(r["local"]), 1, atol=1e-6)


def test_genotype_grouping(engine):
    opts = engine.genotype_options("loc", "glob")
    genes = {g["gene"]: g for g in opts["genes"]}
    assert genes["HA1"]["available"] and genes["HA1"]["coordinates_match"]
    both = [p["position"] for p in opts["positions"]["HA1"] if p["variable_in_local"] and p["variable_in_global"]]
    assert both, "synthetic builds share subclade-defining mutations"
    r = engine.compare(req(grouping="genotype", genotype={"gene": "HA1", "positions": both[:2]}))
    assert all(t.split()[0].startswith(str(both[0])) for t in r["taxa"] if t not in ("Other",))
    assert np.allclose(col_sums(r["local"]), 1, atol=1e-6)
    # a position invariant in the local tree (no root sequence) is reported, and not differenced
    local_var = {p["position"] for p in opts["positions"]["HA1"] if p["local_nonroot"] is not None}
    glob_only = [p["position"] for p in opts["positions"]["HA1"] if p["position"] not in local_var]
    if glob_only:
        r = engine.compare(req(grouping="genotype", genotype={"gene": "HA1", "positions": [glob_only[0]]}))
        assert r["local"]["notes"]
        assert all(t not in r["difference"]["series"] for t in r["taxa"] if "?" in t)


def test_harmonization_is_explicit(project):
    eng = Engine(project["db"], {"version": 7, "mappings": [
        {"grouping": "subclade", "subtype": "h3n2", "source": "global", "from": "J.2.2", "to": "J.2"}]})
    r = eng.compare(req())
    assert r["harmonization"]["version"] == 7
    assert {"source": "global", "from": "J.2.2", "to": "J.2"} in r["harmonization"]["applied"]
    assert "J.2.2" not in r["global"]["series"]
    assert "J.2.2" in r["local"]["series"]  # local labels untouched


def test_precomputed_tables(engine):
    n = engine.q("SELECT COUNT(*) n FROM comparison_observations WHERE local_build_id='loc' AND global_build_id='glob'").n[0]
    assert n > 0
    pairs = engine.q("SELECT DISTINCT global_build_id FROM comparison_observations WHERE local_build_id='loc'")
    assert "h1glob" not in set(pairs.global_build_id)


def test_reingest_reuses_and_makes_no_network_calls(project, monkeypatch):
    def no_net(*a, **k):
        raise AssertionError("network access attempted during ingestion")

    monkeypatch.setattr(socket, "socket", no_net)
    monkeypatch.setattr(socket, "create_connection", no_net)
    base = project["base"]
    rep = run_ingest(base / "config" / "manifest.yaml", base / "store", base / "config" / "settings.yaml",
                     base / "config" / "taxon_harmonization.yaml", log=lambda *a: None)
    assert {v["status"] for v in rep["builds"].values()} == {"unchanged"}
    assert json.loads((base / "store" / "ingest_report.json").read_text())["builds"]


def test_shared_timepoints_align_weekly_global_with_monthly_local(engine):
    """Both panels get identical timepoints; global values come from its nearest weekly pivot."""
    r = engine.compare(req(start="2025-12-01"))
    al = r["aligned"]
    assert r["alignment"]["reference"] == "local" and r["alignment"]["step"] == "monthly"
    assert r["alignment"]["global_spacing_days"] == 7
    assert al["dates"] == sorted(al["dates"]) and al["dates"][0] >= "2025-12-01"
    for i, d in enumerate(al["dates"]):
        if al["local"]["present"][i]:
            assert al["local"]["pivot_dates"][i] == d and al["local"]["offset_days"][i] == 0
        if al["global"]["present"][i]:
            assert abs(al["global"]["offset_days"][i]) <= 4
    # every shared timepoint has both builds, and frequencies at each side still sum to 1
    for side in ("local", "global"):
        s = al[side]
        for i, p in enumerate(s["present"]):
            if p:
                assert abs(sum(v[i] for v in (x["frequency"] for x in s["series"].values())) - 1) < 1e-5
    # range cut-offs are identical for both panels
    first_l = next(d for d, p in zip(al["dates"], al["local"]["present"]) if p)
    first_g = next(d for d, p in zip(al["dates"], al["global"]["present"]) if p)
    assert first_l == first_g


def test_national_colours(engine):
    from ffc.colors import grey_ramp

    r = engine.compare(req())
    sc = engine.q("SELECT value, color FROM color_scales WHERE build_id='glob' AND coloring_key='subclade'")
    official = dict(zip(sc.value, sc.color))  # no fetched colours file in the test store: global JSON scale
    for t, c in official.items():
        if t in r["colors"]:
            assert r["colors"][t] == c.upper()
    greys = set(grey_ramp(10))
    unlisted = [t for t in r["taxa"] if t not in official and t not in ("Other", "Not assigned")]
    assert unlisted and all(r["colors"][t] in greys for t in unlisted)
    # clade_membership has no scale: Auspice default palette over the sorted domain
    rc = engine.compare(req(grouping="clade"))
    assert rc["color_info"]["by_source"].get("Auspice default palette")
    assert rc["color_info"]["key"] == "clade_membership"


def test_invalid_strings_are_not_assigned(engine):
    from ffc.engine import NOT_ASSIGNED
    r = engine.compare(req())
    assert not any(t.lower() in ("unassigned", "?", "unknown") for t in r["taxa"])
    assert NOT_ASSIGNED in r["colors"]


SHARED = {
    "auto_same_name": True,
    "never": [],
    "pairs": [
        # first global candidate shares no values with the local field: the overlap check must skip it
        {"id": "subclade", "label": "Subclade", "local": ["subclade"], "global": ["region", "subclade"]},
        {"id": "qc_status", "label": "QC", "local": ["qc_overallStatus"], "global": ["qc.overallStatus_ha"]},
    ],
}


def test_shared_filters_pair_equivalent_fields(project):
    eng = Engine(project["db"], shared_filter_settings=SHARED)
    sf = eng.shared_filters("loc", "glob")
    by_id = {d["id"]: d for d in sf["available"]}
    assert by_id["subclade"]["local_field"] == "subclade" and by_id["subclade"]["global_field"] == "subclade"
    assert by_id["subclade"]["n_shared_values"] > 0
    assert {"id": "qc_status", "label": "QC", "reason": "not in the global build"} in sf["unavailable"]
    # values carry counts for both builds; values in only one build are flagged
    v = by_id["subclade"]["values"]
    assert all({"local_count", "global_count", "in_both"} <= set(x) for x in v)
    assert v[0]["in_both"]


def test_shared_filter_applies_to_both_builds(project):
    eng = Engine(project["db"], shared_filter_settings=SHARED)
    vals = [x["value"] for x in eng.shared_filters("loc", "glob")["available"][0]["values"] if x["in_both"]][:2]
    base = eng.compare(req())
    r = eng.compare(req(shared_filters={"subclade": vals}))
    assert r["local"]["tips_included"] < base["local"]["tips_included"]
    assert r["global"]["tips_included"] < base["global"]["tips_included"]
    # identical to applying the same filter to each side separately
    r2 = eng.compare(req(local_filters={"subclade": vals}, global_filters={"subclade": vals}))
    assert (r["local"]["tips_included"], r["global"]["tips_included"]) == (r2["local"]["tips_included"], r2["global"]["tips_included"])
    assert r["provenance"]["comparison"]["shared_filters"][0]["values"] == sorted(vals)
    # shared and side filters combine with AND
    r3 = eng.compare(req(shared_filters={"subclade": vals}, local_filters={"subclade": vals[:1]}))
    assert r3["local"]["tips_included"] <= r["local"]["tips_included"]
    with pytest.raises(ValueError):
        eng.compare(req(shared_filters={"nope": ["x"]}))
