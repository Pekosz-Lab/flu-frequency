import datetime as dt

import numpy as np
import pytest

from ffc.config import ManifestError, load_manifest
from ffc.dates import from_decimal, month_key, to_decimal
from ffc.frequencies import import_tip_frequencies, pivot_bins, recompute_tip_frequencies
from ffc.genotypes import position_summary, root_states, tip_genotypes
from ffc.parse_auspice import parse_build
from ffc.validate import validate_auspice, validate_tip_frequencies


def test_decimal_dates_roundtrip_and_augur_rounding():
    for d in [dt.date(2024, 1, 1), dt.date(2024, 2, 29), dt.date(2025, 12, 31), dt.date(2026, 7, 1)]:
        assert from_decimal(to_decimal(d)) == d
        # augur stores pivots rounded to 4 decimals; month must not slip
        assert month_key(round(to_decimal(d), 4)) == f"{d.year}-{d.month:02d}"


def tiny_tree():
    return {
        "version": "v2",
        "meta": {"updated": "2026-01-01", "colorings": [], "genome_annotations": {"nuc": {"start": 1, "end": 30}, "HA1": {"start": 1, "end": 30}}},
        "tree": {
            "name": "root",
            "node_attrs": {"num_date": {"value": 2025.0}},
            "children": [
                {"name": "n1", "node_attrs": {"num_date": {"value": 2025.1}},
                 "branch_attrs": {"mutations": {"HA1": ["K5N"], "nuc": ["A10G"]}},
                 "children": [
                     {"name": "t1", "node_attrs": {"num_date": {"value": 2025.5}, "subclade": {"value": "J.1"}},
                      "branch_attrs": {"mutations": {"HA1": ["N5K"]}}},
                     {"name": "t2", "node_attrs": {"num_date": {"value": 2025.6}, "subclade": {"value": "J.2"}},
                      "branch_attrs": {"mutations": {"HA1": ["S7T"]}}},
                 ]},
                {"name": "t3", "node_attrs": {"num_date": {"value": 2025.7}}},
            ],
        },
    }


def test_validate_auspice():
    assert validate_auspice(tiny_tree()).ok
    bad = tiny_tree()
    bad["version"] = "v1"
    assert not validate_auspice(bad).ok
    assert not validate_auspice({"version": "v2", "meta": {}}).ok
    undated = tiny_tree()
    del undated["tree"]["children"][1]["node_attrs"]["num_date"]
    rep = validate_auspice(undated)
    assert rep.ok and any("no num_date" in w for w in rep.warnings)


def test_validate_frequencies():
    tips = {"t1", "t2", "t3"}
    good = {"pivots": [2025.0, 2025.5], "t1": {"frequencies": [0.5, 0.2]}, "NODE_1": {"frequencies": [0.1, 0.1]}}
    rep = validate_tip_frequencies(good, tips)
    assert rep.ok
    assert any("not tips" in w for w in rep.warnings)
    assert any("no frequency entry" in w for w in rep.warnings)
    wrong = {"pivots": [2025.0, 2025.5], "t1": {"frequencies": [0.5]}}
    assert not validate_tip_frequencies(wrong, tips).ok
    assert not validate_tip_frequencies({"pivots": [1]}, tips).ok


def test_genotypes_from_mutations():
    pb = parse_build(tiny_tree())
    roots = root_states(pb, None)
    assert roots["HA1"] == {5: "K", 7: "S"}
    rows = tip_genotypes(pb, roots)
    states = {(t, g, p): s for t, g, p, s in rows}
    assert ("t1", "HA1", 5) not in states  # reverted to root K
    assert states[("t2", "HA1", 5)] == "N"
    assert states[("t2", "HA1", 7)] == "T"
    assert states[("t1", "nuc", 10)] == "G"
    assert not any(t == "t3" for t, *_ in rows)
    summ = {(r["gene"], r["position"]): r for r in position_summary(roots, rows, 3)}
    assert summ[("HA1", 5)]["state_counts"] == {"N": 1, "K": 2}
    # root sequence overrides inference
    roots2 = root_states(pb, {"HA1": "XXXXQXSXXX"})
    assert roots2["HA1"][5] == "Q"


def test_recompute_and_import_frequencies():
    dates = {"a": 2025.1, "b": 2025.4, "c": 2025.45, "d": 2025.9}
    pivots, w = recompute_tip_frequencies(dates)
    m = np.vstack(list(w.values()))
    assert np.allclose(m.sum(axis=0), 1.0)
    f = {"pivots": list(pivots), **{k: {"frequencies": list(v)} for k, v in w.items()}, "NODE": {"frequencies": [1] * len(pivots)}}
    p2, w2, proj = import_tip_frequencies(f, ["a", "b", "c", "d"])
    assert set(w2) == {"a", "b", "c", "d"} and proj is None
    assert pivot_bins(pivots, 2025.4) is not None
    assert pivot_bins(pivots, 2030.0) is None


def test_manifest_validation(tmp_path):
    (tmp_path / "m.yaml").write_text(
        "builds:\n  - {id: a, source_type: regional, subtype: h3n2, segment: HA, auspice_json: x.json}\n"
        "  - {id: b, source_type: local, subtype: H5, segment: HA, auspice_json: x.json}\n"
    )
    with pytest.raises(ManifestError) as e:
        load_manifest(tmp_path / "m.yaml")
    assert "source_type" in str(e.value) and "Unknown subtype" in str(e.value)
