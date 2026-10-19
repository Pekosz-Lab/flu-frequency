import json
from pathlib import Path

import pytest
import yaml

from ffc.demo import make_build
from ffc.ingest import run_ingest

ROOT = Path(__file__).resolve().parent.parent


def write_build(d: Path, auspice, freq=None, root=None, stem="b"):
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{stem}.json").write_text(json.dumps(auspice))
    if freq is not None:
        (d / f"{stem}_tip-frequencies.json").write_text(json.dumps(freq))
    if root is not None:
        (d / f"{stem}_root-sequence.json").write_text(json.dumps(root))
    return d / f"{stem}.json"


@pytest.fixture(scope="session")
def project(tmp_path_factory):
    """Small synthetic project: H3N2 HA local (imported freqs), local2 (no freq
    file -> recompute), global 2y (projection + root seq), global 6m, and a
    H1N1pdm global build that must never pair with H3N2 local builds."""
    base = tmp_path_factory.mktemp("proj")
    (base / "config").mkdir()
    for f in ("settings.yaml", "taxon_harmonization.yaml"):
        (base / "config" / f).write_text((ROOT / "config" / f).read_text())
    end = 2026.7
    a, f, _ = make_build("h3n2", "HA", "local", end - 3, end - 0.05, 260, 1, "L")
    p_local = write_build(base / "data/local", a, f)
    a, f, _ = make_build("h3n2", "HA", "local", end - 2, end - 0.05, 150, 2, "L2")
    p_local2 = write_build(base / "data/local2", a, None)
    a, f, r = make_build("h3n2", "HA", "global", end - 2, end, 400, 3, "G")
    f["projection_pivot"] = f["pivots"][-2]
    p_glob = write_build(base / "data/global", a, f, r)
    a, f, r = make_build("h3n2", "HA", "global", end - 0.5, end, 200, 4, "G6")
    p_glob6 = write_build(base / "data/global6", a, f, r)
    a, f, r = make_build("h1n1pdm", "HA", "global", end - 2, end, 200, 5, "H1")
    p_h1 = write_build(base / "data/h1", a, f, r)
    manifest = {
        "builds": [
            {"id": "loc", "source_type": "local", "subtype": "H3", "segment": "HA", "auspice_json": str(p_local), "label": "Local"},
            {"id": "loc2", "source_type": "local", "subtype": "h3n2", "segment": "ha", "auspice_json": str(p_local2), "label": "Local 2"},
            {"id": "glob", "source_type": "global", "subtype": "h3n2", "segment": "HA", "auspice_json": str(p_glob),
             "label": "Global 2y", "resolution": "2y", "remote": "nextstrain.org/flu/seasonal/h3n2/ha/2y",
             "fetched_at": "2026-10-01T00:00:00"},
            {"id": "glob6", "source_type": "global", "subtype": "h3n2", "segment": "HA", "auspice_json": str(p_glob6), "label": "Global 6m", "resolution": "6m"},
            {"id": "h1glob", "source_type": "global", "subtype": "h1n1pdm", "segment": "HA", "auspice_json": str(p_h1), "label": "H1 global"},
            {"id": "inactive", "source_type": "global", "subtype": "h3n2", "segment": "HA", "auspice_json": "missing.json", "active": False},
        ]
    }
    (base / "config" / "manifest.yaml").write_text(yaml.safe_dump(manifest))
    report = run_ingest(base / "config" / "manifest.yaml", base / "store", base / "config" / "settings.yaml",
                        base / "config" / "taxon_harmonization.yaml", log=lambda *a: None)
    return {"base": base, "report": report, "db": base / "store" / "ffc.duckdb"}


@pytest.fixture()
def engine(project):
    from ffc.engine import Engine

    return Engine(project["db"])
