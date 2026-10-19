"""The website's in-browser engine (TypeScript) must give the same results as the
Python engine. Runs a fixed set of requests through both on synthetic builds."""
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
ESBUILD = ROOT / "frontend" / "node_modules" / ".bin" / "esbuild"


def test_web_config_is_up_to_date():
    r = subprocess.run([sys.executable, str(ROOT / "scripts" / "export_web_config.py"), "--check"], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "groups/PekoszLab/" not in (ROOT / "frontend" / "src" / "engine" / "web-config.json").read_text()


@pytest.mark.skipif(not shutil.which("node") or not ESBUILD.exists(), reason="needs node and `npm ci` in frontend/")
def test_browser_engine_matches_python(tmp_path):
    from ffc.demo import write_demo
    from ffc.ingest import run_ingest

    (tmp_path / "config").mkdir()
    for f in ("settings.yaml", "taxon_harmonization.yaml"):
        shutil.copy(ROOT / "config" / f, tmp_path / "config" / f)
    manifest = write_demo(tmp_path / "data" / "demo", tmp_path / "config" / "manifest.demo.yaml", tmp_path)
    run_ingest(manifest, tmp_path / "store", tmp_path / "config" / "settings.yaml",
               tmp_path / "config" / "taxon_harmonization.yaml", force=True, log=lambda *a: None,
               colors_path=tmp_path / "data" / "demo" / "colors.json")
    golden = tmp_path / "golden.json"
    subprocess.run([sys.executable, str(ROOT / "tests" / "parity" / "make_golden.py"), str(tmp_path / "store"),
                    str(manifest), str(golden)], check=True, cwd=ROOT)
    bundle = tmp_path / "parity.mjs"
    subprocess.run([str(ESBUILD), str(ROOT / "tests" / "parity" / "run.ts"), "--bundle", "--platform=node",
                    "--format=esm", f"--outfile={bundle}", "--log-level=warning"], check=True)
    r = subprocess.run(["node", str(bundle), str(golden)], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout[-4000:] + r.stderr[-2000:]
    assert "PARITY OK" in r.stdout
