"""Download the input JSONs with `nextstrain remote download`.

This is the only part of the app that touches the network, and it runs
separately from ingestion. It only DOWNLOADS: it never uploads, never runs
`nextstrain login`, and never changes the nextstrain pipeline repository.

Layout written:
  data/raw/global/{subtype}/{segment}/{resolution}/<files>.json + fetch_record.json
  data/raw/local/{subtype}/{segment}/current/<files>.json + fetch_record.json
Then the `managed_by: fetch` entries of config/manifest.yaml are rewritten.
"""

from __future__ import annotations

import datetime as dt
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import yaml

from .config import write_manifest
from .constants import SUBTYPES


class FetchError(RuntimeError):
    pass


def _now():
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def _classify(files: list[Path]) -> dict:
    out = {"main": None, "freq": None, "root": None}
    for f in files:
        n = f.name
        if n.endswith("_tip-frequencies.json"):
            out["freq"] = f
        elif n.endswith("_root-sequence.json"):
            out["root"] = f
        elif n.endswith("_measurements.json") or n.endswith("_frequencies.json"):
            continue
        elif n.endswith(".json") and n != "fetch_record.json":
            out["main"] = f
    return out


def nextstrain_cli() -> str:
    exe = shutil.which("nextstrain")
    if not exe:
        raise FetchError(
            "The Nextstrain CLI (`nextstrain`) is not on your PATH. Activate the flu-freq-compare "
            "conda environment (it includes nextstrain-cli), or install it with:\n"
            "  conda install -c conda-forge -c bioconda nextstrain-cli"
        )
    return exe


def _download(remote: str, dest: Path, dry_run: bool, log) -> dict | None:
    """Run `nextstrain remote download <remote> <tmpdir>` and move results to dest."""
    cmd_preview = f"nextstrain remote download {remote} {dest}/"
    if dry_run:
        log(f"  [dry run] {cmd_preview}")
        return None
    exe = nextstrain_cli()
    with tempfile.TemporaryDirectory() as tmp:
        proc = subprocess.run([exe, "remote", "download", remote, tmp + "/"], capture_output=True, text=True)
        if proc.returncode != 0:
            msg = (proc.stderr or proc.stdout).strip().splitlines()
            log(f"  could not download {remote}: {msg[-1] if msg else 'unknown error'}")
            return None
        files = _classify(sorted(Path(tmp).glob("*.json")))
        if not files["main"]:
            log(f"  {remote}: no main dataset JSON downloaded; skipped")
            return None
        dest.mkdir(parents=True, exist_ok=True)
        for old in dest.glob("*.json"):
            old.unlink()
        moved = {}
        for kind, f in files.items():
            if f:
                target = dest / f.name
                shutil.move(str(f), target)
                moved[kind] = target
    record = {
        "remote": remote,
        "fetched_at": _now(),
        "command": cmd_preview,
        "files": {k: v.name for k, v in moved.items()},
    }
    (dest / "fetch_record.json").write_text(json.dumps(record, indent=1))
    log(f"  downloaded {remote} -> {dest}")
    return {"record": record, "files": moved}


def _copy_local(src_dir: Path, subtype_local: str, segment: str, dest: Path, log) -> dict | None:
    main = src_dir / subtype_local / f"{segment}.json"
    if not main.exists():
        log(f"  {main} not found; skipped")
        return None
    dest.mkdir(parents=True, exist_ok=True)
    for old in dest.glob("*.json"):
        old.unlink()
    moved = {"main": dest / main.name}
    shutil.copy2(main, moved["main"])  # copy only: the source repo is never modified
    freq = main.with_name(f"{segment}_tip-frequencies.json")
    if freq.exists():
        moved["freq"] = dest / freq.name
        shutil.copy2(freq, moved["freq"])
    root = main.with_name(f"{segment}_root-sequence.json")
    if root.exists():
        moved["root"] = dest / root.name
        shutil.copy2(root, moved["root"])
    record = {"copied_from": str(main), "fetched_at": _now(), "files": {k: v.name for k, v in moved.items()}}
    (dest / "fetch_record.json").write_text(json.dumps(record, indent=1))
    log(f"  copied {main} -> {dest}")
    return {"record": record, "files": moved}


def run_fetch(config_path: Path, project: Path, manifest_path: Path, only: str | None = None,
              subtypes: list[str] | None = None, dry_run: bool = False, log=print,
              overrides: dict | None = None) -> list[dict]:
    cfg = yaml.safe_load(config_path.read_text())
    for section, values in (overrides or {}).items():  # e.g. from `ffc start`
        if isinstance(values, dict):
            cfg.setdefault(section, {}).update(values)
        else:
            cfg[section] = values
    raw = project / "data" / "raw"
    segments = [s.lower() for s in cfg.get("segments", ["ha", "na"])]
    sub_map = cfg["subtypes"]
    chosen = subtypes or list(sub_map)
    entries: list[dict] = []
    downloaded_globals: dict[tuple[str, str], list[tuple[str, Path]]] = {}

    def rel(p: Path) -> str:
        try:
            return str(p.relative_to(project))
        except ValueError:
            return str(p)

    if only in (None, "global"):
        g = cfg["global"]
        log("Global builds (nextstrain remote download):")
        for st in chosen:
            for seg in segments:
                for res in g.get("resolutions", ["2y"]):
                    remote = f"{g['remote_prefix'].rstrip('/')}/{sub_map[st]['global']}/{seg}/{res}"
                    dest = raw / "global" / st / seg / res
                    got = _download(remote, dest, dry_run, log)
                    if not got:
                        continue
                    downloaded_globals.setdefault((st, seg), []).append((res, got["files"]["main"]))
                    entries.append(
                        {
                            "id": f"nextstrain_{st}_{seg}_{res}",
                            "source_type": "global",
                            "organization": g.get("organization", "Nextstrain seasonal-flu"),
                            "subtype": st,
                            "segment": seg.upper(),
                            "resolution": res,
                            "auspice_json": rel(got["files"]["main"]),
                            "frequencies_json": rel(got["files"]["freq"]) if got["files"].get("freq") else None,
                            "root_sequence_json": rel(got["files"]["root"]) if got["files"].get("root") else None,
                            "label": f"Nextstrain seasonal-flu {SUBTYPES[st]} {seg.upper()} ({res})",
                            "remote": remote,
                            "fetched_at": got["record"]["fetched_at"],
                            "active": True,
                            "managed_by": "fetch",
                        }
                    )
    if only in (None, "local"):
        lc = cfg["local"]
        mode = lc.get("mode", "remote")
        log(f"Local JHH builds ({'nextstrain remote download' if mode == 'remote' else 'copy from ' + lc['copy_from']}):")
        for st in chosen:
            for seg in segments:
                dest = raw / "local" / st / seg / "current"
                if mode == "remote":
                    remote = f"{lc['remote_prefix'].rstrip('/')}/{sub_map[st]['local']}/{seg}"
                    got = _download(remote, dest, dry_run, log)
                else:
                    remote = None
                    src = (project / lc["copy_from"]).resolve()
                    got = None if dry_run else _copy_local(src, sub_map[st]["local"], seg, dest, log)
                    if dry_run:
                        log(f"  [dry run] copy {src}/{sub_map[st]['local']}/{seg}.json -> {dest}/")
                if not got:
                    continue
                entries.append(
                    {
                        "id": f"jhh_{st}_{seg}",
                        "source_type": "local",
                        "organization": lc.get("organization", "JHH"),
                        "subtype": st,
                        "segment": seg.upper(),
                        "auspice_json": rel(got["files"]["main"]),
                        "frequencies_json": rel(got["files"]["freq"]) if got["files"].get("freq") else None,
                        "root_sequence_json": rel(got["files"]["root"]) if got["files"].get("root") else None,
                        "label": f"JHH {SUBTYPES[st]} {seg.upper()} local surveillance{lc.get('label_suffix', '')}",
                        "remote": remote or got["record"].get("copied_from"),
                        "fetched_at": got["record"]["fetched_at"],
                        "active": True,
                        "managed_by": "fetch",
                    }
                )
    # Colours are refreshed on every fetch (Nextstrain re-assigns them as subclades emerge)
    refresh_colors(cfg, project, chosen, segments, downloaded_globals, dry_run, log)
    if dry_run:
        return entries
    # merge into manifest: replace fetch-managed entries this run touched, keep everything else
    existing = []
    if manifest_path.exists():
        existing = (yaml.safe_load(manifest_path.read_text()) or {}).get("builds") or []
    new_ids = {e["id"] for e in entries}
    kept = [b for b in existing if b.get("id") not in new_ids]
    merged = kept + [{k: v for k, v in e.items() if v is not None} for e in entries]
    write_manifest(manifest_path, merged)
    log(f"Manifest updated: {manifest_path} ({len(entries)} builds fetched, {len(kept)} other entries kept)")
    return entries


# ----------------------------------------------------------------------------- colours
COLORS_FILE = Path("data") / "colors" / "nextstrain_colors.json"


def _scales_from(path: Path, keys: set[str]) -> tuple[str | None, dict[str, list]]:
    with open(path) as fh:
        meta = json.load(fh).get("meta", {})
    out = {}
    for c in meta.get("colorings") or []:
        if c.get("key") in keys and isinstance(c.get("scale"), list):
            out[c["key"]] = [[str(v), str(h).upper()] for v, h in c["scale"] if isinstance(h, str)]
    return meta.get("updated"), out


def refresh_colors(cfg: dict, project: Path, subtypes: list[str], segments: list[str],
                   downloaded: dict, dry_run: bool, log=print) -> dict | None:
    """Refresh the national clade/subclade colour scales from nextstrain.org.

    Uses the seasonal-flu dataset JSONs downloaded in this run; for any
    subtype/segment with none, downloads `colors.resolutions` (default 2y) with
    `nextstrain remote download` just for their colours. Scales from several
    resolutions are merged (most recently updated first). Written to
    data/colors/nextstrain_colors.json, which `ffc ingest` loads.
    """
    from .config import load_settings

    settings = load_settings(project / "config" / "settings.yaml")
    keys = {k for cands in settings["grouping_fields"].values() for k in cands}
    g = cfg["global"]
    color_res = (cfg.get("colors") or {}).get("resolutions") or ["2y"]
    out_path = project / COLORS_FILE
    old = json.loads(out_path.read_text()) if out_path.exists() else {"lineages": {}}
    new = {"fetched_at": _now(), "source": f"{g['remote_prefix']} (nextstrain remote download)",
           "lineages": dict(old.get("lineages", {}))}
    log("Colours (refreshed on every fetch):")
    for st in subtypes:
        for seg in segments:
            files = list(downloaded.get((st, seg), []))
            tmpdirs = []
            if not files:
                for res in color_res:
                    remote = f"{g['remote_prefix'].rstrip('/')}/{cfg['subtypes'][st]['global']}/{seg}/{res}"
                    if dry_run:
                        log(f"  [dry run] nextstrain remote download {remote} (colours only)")
                        continue
                    tmp = Path(tempfile.mkdtemp())
                    tmpdirs.append(tmp)
                    got = _download(remote, tmp / "d", False, lambda *_: None)
                    if got:
                        files.append((res, got["files"]["main"]))
                    else:
                        log(f"  {st} {seg}: could not download {remote} for colours")
            if dry_run:
                continue
            parsed = []
            for res, path in files:
                updated, scales = _scales_from(path, keys)
                parsed.append((updated or "", res, scales))
            for t in tmpdirs:
                shutil.rmtree(t, ignore_errors=True)
            if not parsed:
                log(f"  {st} {seg}: no colours fetched; keeping previous colours" if f"{st}/{seg}" in old["lineages"]
                    else f"  {st} {seg}: no colours available")
                continue
            # most recently updated first; within a date, the order of the configured resolutions
            order = {r: i for i, r in enumerate(g.get("resolutions", []))}
            parsed.sort(key=lambda x: (x[0], -order.get(x[1], 99)), reverse=True)
            merged: dict[str, list] = {}
            conflicts = []
            for updated, res, scales in parsed:
                for key, scale in scales.items():
                    have = {v: c for v, c in merged.setdefault(key, [])}
                    for v, c in scale:
                        if v not in have:
                            merged[key].append([v, c])
                            have[v] = c
                        elif have[v] != c:
                            conflicts.append(f"{key} {v}: {have[v]} kept, {c} in {res}")
            entry = {
                "keys": merged,
                "sources": [{"resolution": r, "updated": u} for u, r, _ in parsed],
            }
            prev = old.get("lineages", {}).get(f"{st}/{seg}", {}).get("keys", {})
            changes = []
            for key, scale in merged.items():
                before = dict(map(tuple, prev.get(key, [])))
                for v, c in scale:
                    if v not in before:
                        changes.append(f"+{v}")
                    elif before[v] != c:
                        changes.append(f"~{v} {before[v]}->{c}")
                changes += [f"-{v}" for v in before if v not in dict(map(tuple, scale))]
            new["lineages"][f"{st}/{seg}"] = entry
            summary = ", ".join(f"{k}: {len(v)}" for k, v in merged.items()) or "no scaled colourings"
            log(f"  {st} {seg}: {summary}" + (f"; changes {' '.join(changes)}" if prev and changes else "")
                + (" (first fetch)" if not prev else ""))
            for c in conflicts[:5]:
                log(f"    note: resolutions disagree on {c}")
    if dry_run:
        return None
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(new, indent=1))
    return new
