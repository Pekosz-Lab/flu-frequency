"""Command line: `ffc <command>` (or `python -m ffc <command>`).

  ffc start     guided setup: sign in, download, process and open (start here)
  ffc fetch     download input JSONs with `nextstrain remote download`
  ffc ingest    parse JSONs listed in the manifest into the local store (offline)
  ffc update    fetch + ingest
  ffc serve     start the dashboard at http://127.0.0.1:8050
  ffc inspect   list colourings / filters / genes of each manifest build (no data values)
  ffc demo      write SYNTHETIC demo data, ingest it into store-demo/
"""

from __future__ import annotations

import argparse
import json
import sys
import webbrowser
from pathlib import Path

from .config import PROJECT_ROOT, ManifestError, load_manifest, load_settings


def _paths(args):
    project = Path(args.project).resolve()
    return project, Path(args.manifest or project / "config" / "manifest.yaml").resolve(), Path(
        args.store or project / "store"
    ).resolve()


def cmd_fetch(args):
    from .fetch import FetchError, run_fetch

    project, manifest, _ = _paths(args)
    try:
        run_fetch(project / "config" / "fetch.yaml", project, manifest, only=args.only,
                  subtypes=args.subtypes, dry_run=args.dry_run)
    except FetchError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2
    return 0


def cmd_ingest(args):
    from .ingest import run_ingest

    project, manifest, store = _paths(args)
    try:
        report = run_ingest(manifest, store, project / "config" / "settings.yaml",
                            project / "config" / "taxon_harmonization.yaml", force=args.force)
    except ManifestError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2
    failed = {k: v for k, v in report["builds"].items() if v["status"] in ("failed", "missing_file")}
    if failed:
        print(f"{len(failed)} build(s) not ingested: {', '.join(failed)}", file=sys.stderr)
        return 1
    return 0


def cmd_update(args):
    rc = cmd_fetch(args)
    if rc:
        return rc
    return cmd_ingest(args)


def cmd_serve(args):
    import uvicorn

    from .api import create_app

    project, _, store = _paths(args)
    settings = load_settings(project / "config" / "settings.yaml")
    host = args.host or settings["server"]["host"]
    port = args.port or settings["server"]["port"]
    db = store / "ffc.duckdb"
    if not db.exists():
        print(f"ERROR: no store at {db}. Run `ffc ingest` (or `ffc demo`) first.", file=sys.stderr)
        return 2
    if host not in ("127.0.0.1", "localhost"):
        print("WARNING: serving beyond this computer. JHH data must not be exposed to other machines.",
              file=sys.stderr)
    app = create_app(db, project)
    url = f"http://{host}:{port}"
    print(f"Dashboard: {url}  (Ctrl+C to stop)")
    if args.open:
        webbrowser.open(url)
    uvicorn.run(app, host=host, port=port, log_level="warning")
    return 0


def cmd_inspect(args):
    """Structure only: never prints strain names or metadata values."""
    from .parse_auspice import parse_build

    _, manifest, _ = _paths(args)
    for e in load_manifest(manifest):
        if not e.auspice_json.exists():
            print(f"{e.id}: file missing ({e.auspice_json})")
            continue
        d = json.loads(e.auspice_json.read_text())
        pb = parse_build(d)
        attrs = sorted({k for t in pb.tips for k in t.attrs})
        print(f"{e.id} [{e.source_type} {e.subtype} {e.segment}] tips={len(pb.tips)} updated={pb.meta.get('updated')}")
        print(f"  colorings: {', '.join(pb.colorings)}")
        print(f"  filters:   {', '.join(pb.meta.get('filters') or [])}")
        print(f"  tip node_attrs: {', '.join(attrs)}")
        print(f"  genes: {', '.join(pb.genome_annotations)}")
    return 0


def cmd_demo(args):
    from .demo import write_demo
    from .ingest import run_ingest

    project = Path(args.project).resolve()
    manifest = project / "config" / "manifest.demo.yaml"
    store = project / "store-demo"
    print("Writing SYNTHETIC demo builds to data/demo/ ...")
    write_demo(project / "data" / "demo", manifest, project)
    run_ingest(manifest, store, project / "config" / "settings.yaml",
               project / "config" / "taxon_harmonization.yaml", force=True,
               colors_path=project / "data" / "demo" / "colors.json")
    print("Demo ready. Start it with:  ffc --store store-demo serve --open")
    return 0


def cmd_start(args):
    from .start import run_start

    return run_start(args, Path(args.project).resolve())


def main(argv=None):
    p = argparse.ArgumentParser(prog="ffc", description="JHH local vs Nextstrain global frequency comparison")
    p.add_argument("--project", default=str(PROJECT_ROOT), help="project folder (default: this app's folder)")
    p.add_argument("--manifest", help="manifest YAML (default: config/manifest.yaml)")
    p.add_argument("--store", help="store folder (default: store/)")
    sub = p.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("fetch", help="download JSONs with `nextstrain remote download`")
    f.add_argument("--only", choices=["local", "global"])
    f.add_argument("--subtypes", nargs="+", choices=["h1n1pdm", "h3n2", "vic"])
    f.add_argument("--dry-run", action="store_true", help="show the commands without running them")
    f.set_defaults(func=cmd_fetch)

    i = sub.add_parser("ingest", help="parse manifest JSONs into the local store (offline)")
    i.add_argument("--force", action="store_true", help="re-parse even unchanged builds")
    i.set_defaults(func=cmd_ingest)

    u = sub.add_parser("update", help="fetch then ingest")
    u.add_argument("--only", choices=["local", "global"])
    u.add_argument("--subtypes", nargs="+", choices=["h1n1pdm", "h3n2", "vic"])
    u.add_argument("--dry-run", action="store_true")
    u.add_argument("--force", action="store_true")
    u.set_defaults(func=cmd_update)

    s = sub.add_parser("serve", help="start the dashboard")
    s.add_argument("--host")
    s.add_argument("--port", type=int)
    s.add_argument("--open", action="store_true", help="open the dashboard in your browser")
    s.set_defaults(func=cmd_serve)

    st = sub.add_parser("start", help="guided setup: sign in, download builds, open the dashboard (recommended)")
    st.add_argument("--source", choices=["private", "public", "copy", "existing"],
                    help="where the JHH builds come from (asked if omitted)")
    st.add_argument("--subtypes", nargs="+", help="subtypes to download (default: all)")
    st.add_argument("--resolutions", nargs="+", help="global Nextstrain resolutions (default: all configured)")
    st.add_argument("--yes", action="store_true", help="accept every default without asking")
    st.add_argument("--port", type=int, help="port for the dashboard (default 8050, next free one if busy)")
    st.add_argument("--no-open", action="store_true", help="do not open the browser")
    st.add_argument("--no-serve", action="store_true", help="download and process only; do not start the dashboard")
    st.set_defaults(func=cmd_start)

    sub.add_parser("inspect", help="show the structure of each manifest build").set_defaults(func=cmd_inspect)
    sub.add_parser("demo", help="build a SYNTHETIC demo store").set_defaults(func=cmd_demo)

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
