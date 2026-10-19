import os
import stat
import textwrap

import pytest
import yaml
from fastapi.testclient import TestClient

from ffc.api import create_app
from ffc.fetch import run_fetch


@pytest.fixture()
def client(project):
    return TestClient(create_app(project["db"], project["base"]))


BODY = {"local_build_id": "loc", "global_build_id": "glob", "grouping": "subclade"}


def test_options_pairs(client):
    o = client.get("/api/options").json()
    pairs = {(p["local"], p["global"]) for p in o["pairs"]}
    assert ("loc", "glob") in pairs and ("loc", "h1glob") not in pairs
    assert o["enabled_segments"] == ["HA", "NA"]
    assert "do not necessarily represent true circulating prevalence" in o["text"]["caveat"]


def test_shared_filter_endpoint(client):
    r = client.get("/api/shared-filters?local=loc&global=glob")
    assert r.status_code == 200
    ids = {d["id"] for d in r.json()["available"]}
    assert "subclade" in ids
    vals = [v["value"] for d in r.json()["available"] if d["id"] == "subclade" for v in d["values"] if v["in_both"]][:1]
    c = client.post("/api/compare", json={**BODY, "shared_filters": {"subclade": vals}})
    assert c.status_code == 200
    svg = client.post("/api/export/figure?fmt=svg", json={**BODY, "shared_filters": {"subclade": vals}}).text
    assert "Filters on both datasets" in svg


def test_compare_and_errors(client):
    r = client.post("/api/compare", json=BODY)
    assert r.status_code == 200 and r.json()["taxa"]
    assert client.post("/api/compare", json={**BODY, "global_build_id": "h1glob"}).status_code == 400
    assert client.post("/api/compare", json={**BODY, "global_build_id": "nope"}).status_code == 404


@pytest.mark.parametrize("fmt,magic", [("png", b"\x89PNG"), ("pdf", b"%PDF"), ("svg", b"<?xml")])
def test_figure_exports(client, fmt, magic):
    for view in ("stacked", "overlay", "difference"):
        r = client.post(f"/api/export/figure?fmt={fmt}", json={**BODY, "view": view})
        assert r.status_code == 200 and r.content.startswith(magic)
        assert "attachment" in r.headers["content-disposition"]
    if fmt == "svg":
        txt = r.content.decode()
        assert "should not be interpreted as unbiased estimates" in txt.replace("\n", " ") or "unbiased" in txt


def test_data_exports_carry_provenance(client):
    for what in ("trajectories", "comparison", "snapshot"):
        r = client.post(f"/api/export/data?what={what}&fmt=tsv", json=BODY)
        assert r.status_code == 200
        head = r.text.splitlines()
        assert head[0].startswith("# Subtype:") and any("Caveat:" in h for h in head)
    r = client.post("/api/export/data?what=analysis&fmt=json", json=BODY)
    assert r.json()["settings"]["local_build_id"] == "loc"
    r = client.post("/api/export/report", json=BODY)
    assert r.status_code == 200 and b"Snapshot" in r.content


def _fake_cli(tmp_path, fail_for=()):
    """A stand-in `nextstrain` that 'downloads' tiny JSONs, so fetch can be tested offline."""
    exe = tmp_path / "bin" / "nextstrain"
    exe.parent.mkdir()
    fails = " ".join(fail_for)
    exe.write_text(textwrap.dedent(f"""\
        #!/bin/sh
        # usage: nextstrain remote download <url> <dir>/
        url="$3"; dest="$4"
        for f in {fails}; do case "$url" in *"$f"*) echo "404 Not Found" >&2; exit 1;; esac; done
        stem=$(echo "$url" | sed 's#^nextstrain.org/##; s#/#_#g')
        case "$url" in *12y*) col='["K","#AAAAAA"],["J.2","#4272CE"],["J.9","#111111"]';; *) col='["J.2","#4272CE"],["K","#AEBD50"]';; esac
        echo '{{"version":"v2","meta":{{"updated":"2026-10-08","colorings":[{{"key":"subclade","scale":['"$col"']}},{{"key":"region","scale":[["Asia","#000000"]]}}]}},"tree":{{"name":"x"}}}}' > "$dest/$stem.json"
        echo '{{"pivots":[1,2]}}' > "$dest/${{stem}}_tip-frequencies.json"
        """))
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    return exe.parent


def test_fetch_downloads_only_and_merges_manifest(tmp_path, monkeypatch):
    bindir = _fake_cli(tmp_path, fail_for=["/3y", "/6y"])
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    (tmp_path / "config").mkdir()
    cfg = {
        "segments": ["ha"],
        "subtypes": {"h3n2": {"local": "h3n2", "global": "h3n2"}},
        "global": {"remote_prefix": "nextstrain.org/flu/seasonal", "resolutions": ["6m", "2y", "3y", "6y", "12y"]},
        "local": {"mode": "remote", "remote_prefix": "nextstrain.org/groups/PekoszLab/seasonal"},
    }
    (tmp_path / "config" / "fetch.yaml").write_text(yaml.safe_dump(cfg))
    manifest = tmp_path / "config" / "manifest.yaml"
    manifest.write_text(yaml.safe_dump({"builds": [{"id": "handmade", "source_type": "local", "subtype": "h3n2",
                                                     "segment": "HA", "auspice_json": "x.json"}]}))
    entries = run_fetch(tmp_path / "config" / "fetch.yaml", tmp_path, manifest, log=lambda *a: None)
    ids = {e["id"] for e in entries}
    assert ids == {"nextstrain_h3n2_ha_6m", "nextstrain_h3n2_ha_2y", "nextstrain_h3n2_ha_12y", "jhh_h3n2_ha"}
    m = yaml.safe_load(manifest.read_text())["builds"]
    assert {b["id"] for b in m} == ids | {"handmade"}
    g = next(b for b in m if b["id"] == "nextstrain_h3n2_ha_2y")
    assert g["remote"] == "nextstrain.org/flu/seasonal/h3n2/ha/2y" and g["fetched_at"]
    assert g["frequencies_json"].endswith("_tip-frequencies.json")
    assert (tmp_path / "data/raw/global/h3n2/ha/2y/fetch_record.json").exists()
    # colours: merged across resolutions, 2y wins ties, only clade/subclade keys kept
    import json as _json
    col = _json.loads((tmp_path / "data/colors/nextstrain_colors.json").read_text())
    sub = col["lineages"]["h3n2/ha"]["keys"]["subclade"]
    assert sub[:2] == [["J.2", "#4272CE"], ["K", "#AEBD50"]] and ["J.9", "#111111"] in sub
    assert "region" not in col["lineages"]["h3n2/ha"]["keys"]
    first = col["fetched_at"]
    # `--only local` still refreshes the colours (downloads the 2y build just for them)
    run_fetch(tmp_path / "config" / "fetch.yaml", tmp_path, manifest, only="local", log=lambda *a: None)
    col2 = _json.loads((tmp_path / "data/colors/nextstrain_colors.json").read_text())
    assert col2["lineages"]["h3n2/ha"]["sources"] == [{"resolution": "2y", "updated": "2026-10-08"}]
    assert col2["fetched_at"] >= first


def test_fetch_never_uploads():
    src = (os.path.dirname(__file__) + "/../ffc/fetch.py")
    code = open(src).read()
    assert '"upload"' not in code and "'upload'" not in code and '"login"' not in code
