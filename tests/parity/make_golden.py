"""Run a fixed set of requests through the Python engine on the demo store and
write the results, for comparison with the browser (TypeScript) engine."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from ffc.config import load_settings, load_manifest  # noqa: E402
from ffc.engine import Engine  # noqa: E402
from ffc.jsonsafe import clean  # noqa: E402

store, manifest, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
e = Engine(store / "ffc.duckdb", shared_filter_settings=load_settings()["shared_filters"])
PAIRS = [("jhh_h3n2_ha", "nextstrain_h3n2_ha_2y"), ("jhh_vic_na", "nextstrain_vic_na_6m"),
         ("jhh_h1n1pdm_ha", "nextstrain_h1n1pdm_ha_12y")]
cases = []
for lid, gid in PAIRS:
    g = e.genotype_options(lid, gid)
    gene = next(x["gene"] for x in g["genes"] if x["available"] and x["seq_type"] == "aa")
    both = [p["position"] for p in g["positions"][gene] if p["variable_in_local"] and p["variable_in_global"]][:2]
    sf = e.shared_filters(lid, gid)
    sval = [v["value"] for v in sf["available"][0]["values"] if v["in_both"]][:2] if sf["available"] else []
    reg = [f for f in e.fields(gid) if f["field_name"] == "region"]
    base = {"local_build_id": lid, "global_build_id": gid}
    reqs = [
        {**base},
        {**base, "grouping": "clade"},
        {**base, "top_n": 3, "start": "2025-06-01"},
        {**base, "grouping": "genotype", "genotype": {"gene": gene, "positions": both}},
        {**base, "snapshot": {"mode": "point", "timepoint": None}, "palette": "colorblind", "end": "2026-06-30"},
    ]
    if reg:
        reqs.append({**base, "global_filters": {"region": [reg[0]["allowed_values"][0]["value"]]}})
    if sval:
        reqs.append({**base, "shared_filters": {sf["available"][0]["id"]: sval}})
    for r in reqs:
        cases.append({"req": r, "result": clean(e.compare(r))})
    cases.append({"genotype_options": [lid, gid], "result": clean(g)})
    cases.append({"shared_filters": [lid, gid], "result": clean(sf)})
    cases.append({"fields": gid, "result": clean(e.fields(gid))})
builds = {}
for b in load_manifest(manifest):
    if b.id in {x for p in PAIRS for x in p}:
        builds[b.id] = {
            "spec": {"id": b.id, "source_type": b.source_type, "organization": b.organization, "subtype": b.subtype,
                     "segment": b.segment, "resolution": b.resolution, "label": b.label, "remote": "demo"},
            "main": str(b.auspice_json),
            "freq": str(b.auspice_json.with_name(b.auspice_json.stem + "_tip-frequencies.json")),
            "root": str(b.auspice_json.with_name(b.auspice_json.stem + "_root-sequence.json")),
        }
out.write_text(json.dumps({"builds": builds, "cases": cases}))
print(f"{len(cases)} cases")
