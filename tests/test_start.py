"""`ffc start` (guided setup) against a stand-in `nextstrain` command."""
import json
import os
import stat
import sys
import textwrap
from argparse import Namespace
from pathlib import Path

import pytest
import yaml

from ffc.demo import make_build
from ffc.start import has_private_access, run_start

ROOT = Path(__file__).resolve().parent.parent


def fake_cli(tmp: Path, whoami: str | None) -> Path:
    """`nextstrain` that answers version/whoami and 'downloads' synthetic builds."""
    lib = tmp / "fake_builds"
    lib.mkdir()
    for kind, (a, f, r) in {
        "local": make_build("h3n2", "HA", "local", 2024.0, 2026.6, 150, 1, "L"),
        "global": make_build("h3n2", "HA", "global", 2024.7, 2026.7, 200, 2, "G"),
    }.items():
        (lib / f"{kind}.json").write_text(json.dumps(a))
        (lib / f"{kind}_tip-frequencies.json").write_text(json.dumps(f))
    calls = tmp / "calls.log"
    exe = tmp / "bin" / "nextstrain"
    exe.parent.mkdir()
    exe.write_text(textwrap.dedent(f"""\
        #!{sys.executable}
        import sys, shutil, pathlib
        a = sys.argv[1:]
        open({str(calls)!r}, "a").write(" ".join(a) + "\\n")
        if a[:1] == ["version"]:
            print("Nextstrain CLI 10.0.0 (fake)"); sys.exit(0)
        if a[:1] == ["whoami"]:
            out = {whoami!r}
            if out is None:
                print("Not logged in to https://nextstrain.org.", file=sys.stderr); sys.exit(1)
            print(out); sys.exit(0)
        if a[:2] == ["remote", "download"]:
            url, dest = a[2], pathlib.Path(a[3])
            if "/h3n2/ha" not in url:
                print("404 Not Found", file=sys.stderr); sys.exit(1)
            kind = "local" if "/groups/" in url else "global"
            stem = url.replace("nextstrain.org/", "").replace("/", "_")
            shutil.copy({str(lib)!r} + f"/{{kind}}.json", dest / f"{{stem}}.json")
            shutil.copy({str(lib)!r} + f"/{{kind}}_tip-frequencies.json", dest / f"{{stem}}_tip-frequencies.json")
            sys.exit(0)
        sys.exit(2)
        """))
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    return calls


@pytest.fixture()
def project(tmp_path, monkeypatch):
    (tmp_path / "config").mkdir()
    for f in ("settings.yaml", "taxon_harmonization.yaml"):
        (tmp_path / "config" / f).write_text((ROOT / "config" / f).read_text())
    fcfg = yaml.safe_load((ROOT / "config" / "fetch.yaml").read_text())
    fcfg["segments"] = ["ha"]
    fcfg["global"]["resolutions"] = ["2y"]
    (tmp_path / "config" / "fetch.yaml").write_text(yaml.safe_dump(fcfg))
    monkeypatch.setenv("PATH", f"{tmp_path / 'bin'}{os.pathsep}{os.environ['PATH']}")
    return tmp_path


def args(**kw):
    base = dict(source=None, subtypes=["h3n2"], resolutions=None, yes=True, port=None, no_open=True, no_serve=True)
    base.update(kw)
    return Namespace(**base)


def manifest_locals(p: Path):
    return [b for b in yaml.safe_load((p / "config" / "manifest.yaml").read_text())["builds"] if b["source_type"] == "local"]


def test_group_membership_parsing():
    assert has_private_access(["PekoszLab"]) and has_private_access(["PekoszLab/viewers"])
    assert not has_private_access(["PekoszLab-Public", "PekoszLab-Public/owners", "Other"])


def test_private_access_downloads_private_builds(project):
    calls = fake_cli(project, "# Logged into https://nextstrain.org as…\nusername: x\ngroups: \n  - PekoszLab/viewers")
    assert run_start(args(), project) == 0
    log = calls.read_text()
    assert "remote download nextstrain.org/groups/PekoszLab/seasonal/h3n2/ha" in log
    assert "login" not in log  # already logged in
    loc = manifest_locals(project)
    assert loc and loc[0]["remote"].startswith("nextstrain.org/groups/PekoszLab/seasonal/")
    assert (project / "store" / "ffc.duckdb").exists()


@pytest.mark.parametrize("whoami", [None, "username: x\ngroups: \n  - PekoszLab-Public/viewers"])
def test_no_access_falls_back_to_public(project, whoami):
    calls = fake_cli(project, whoami)
    assert run_start(args(), project) == 0
    log = calls.read_text()
    assert "groups/PekoszLab/" not in log  # private group never contacted
    assert "remote download nextstrain.org/groups/PekoszLab-Public/seasonal-flu/h3n2/ha" in log
    assert "login" not in log  # never logs in without a person answering the prompt
    loc = manifest_locals(project)
    assert loc[0]["label"].endswith("(public build)")


def test_existing_data_skips_download(project):
    fake_cli(project, None)
    assert run_start(args(source="public"), project) == 0
    calls = project / "calls.log"
    calls.write_text("")
    assert run_start(args(source="existing"), project) == 0
    assert "remote download" not in calls.read_text()
