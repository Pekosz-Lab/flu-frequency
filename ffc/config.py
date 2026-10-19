"""Load settings, manifest and harmonization files."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from .constants import (
    GLOBAL_DOWNSAMPLING,
    LOCAL_DOWNSAMPLING,
    canonical_segment,
    canonical_subtype,
)

PROJECT_ROOT = Path(__file__).resolve().parent.parent

DEFAULT_SETTINGS: dict[str, Any] = {
    "enabled_segments": ["HA", "NA"],
    "grouping_fields": {
        "clade": ["legacy-clade", "clade", "clade_membership"],
        "subclade": ["subclade", "proposed_subclade"],
    },
    "metadata_filters": {
        "include_json_filters": True,
        "include_categorical_colorings": True,
        "extra_candidates": [],
        "exclude": ["num_date", "gt", "div"],
        "max_distinct_values": 400,
    },
    "recompute": {
        "narrow_bandwidth": 1 / 12,
        "wide_bandwidth": 3 / 12,
        "proportion_wide": 0.2,
        "pivot_interval_months": 1,
    },
    "shared_filters": {"auto_same_name": True, "never": [], "pairs": []},
    "default_palette": "nextstrain",
    "default_top_n": 12,
    "server": {"host": "127.0.0.1", "port": 8050},
}


def _deep_merge(base: dict, extra: dict) -> dict:
    out = dict(base)
    for k, v in (extra or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def load_settings(path: Path | None = None) -> dict:
    path = path or PROJECT_ROOT / "config" / "settings.yaml"
    data = yaml.safe_load(path.read_text()) if path.exists() else {}
    settings = _deep_merge(DEFAULT_SETTINGS, data or {})
    settings["enabled_segments"] = [canonical_segment(s) for s in settings["enabled_segments"]]
    return settings


@dataclass
class BuildEntry:
    """One build as described by the manifest (deployment-supplied metadata)."""

    id: str
    source_type: str  # local | global
    organization: str
    subtype: str
    segment: str
    auspice_json: Path
    label: str
    frequencies_json: Path | None = None
    root_sequence_json: Path | None = None
    active: bool = True
    resolution: str | None = None
    remote: str | None = None
    fetched_at: str | None = None
    build_date: str | None = None
    downsampling_description: str | None = None
    synthetic: bool = False
    managed_by: str | None = None
    extra: dict = field(default_factory=dict)

    @property
    def downsampling(self) -> str:
        if self.downsampling_description:
            return self.downsampling_description
        return LOCAL_DOWNSAMPLING if self.source_type == "local" else GLOBAL_DOWNSAMPLING

    def manifest_metadata(self) -> dict:
        """Metadata supplied by the manifest (not extracted from the JSON)."""
        keys = ["label", "organization", "resolution", "remote", "fetched_at", "build_date",
                "downsampling_description", "synthetic", "managed_by"]
        out = {k: getattr(self, k) for k in keys if getattr(self, k) not in (None, "", False)}
        out.update(self.extra)
        return out


KNOWN_KEYS = {
    "id", "source_type", "organization", "subtype", "segment", "auspice_json", "label",
    "frequencies_json", "root_sequence_json", "active", "resolution", "remote", "fetched_at",
    "build_date", "downsampling_description", "synthetic", "managed_by",
}


class ManifestError(ValueError):
    pass


def _resolve(base: Path, p: str | None) -> Path | None:
    if not p:
        return None
    path = Path(p).expanduser()
    return path if path.is_absolute() else (base / path).resolve()


def load_manifest(path: Path, base: Path | None = None) -> list[BuildEntry]:
    """Parse and validate a manifest. Relative paths resolve against `base`
    (default: the project root, i.e. the folder that holds config/)."""
    if not path.exists():
        raise ManifestError(f"Manifest not found: {path}. Run `ffc fetch` or write one by hand.")
    base = base or (path.parent.parent if path.parent.name == "config" else path.parent)
    raw = yaml.safe_load(path.read_text()) or {}
    entries: list[BuildEntry] = []
    seen: set[str] = set()
    problems: list[str] = []
    for i, b in enumerate(raw.get("builds") or []):
        where = f"builds[{i}]"
        missing = [k for k in ("id", "source_type", "subtype", "segment", "auspice_json") if not b.get(k)]
        if missing:
            problems.append(f"{where}: missing {missing}")
            continue
        if b["id"] in seen:
            problems.append(f"{where}: duplicate id '{b['id']}'")
            continue
        seen.add(b["id"])
        st = str(b["source_type"]).lower()
        if st not in ("local", "global"):
            problems.append(f"{where} ({b['id']}): source_type must be 'local' or 'global'")
            continue
        try:
            subtype = canonical_subtype(b["subtype"])
            segment = canonical_segment(b["segment"])
        except ValueError as e:
            problems.append(f"{where} ({b['id']}): {e}")
            continue
        entries.append(
            BuildEntry(
                id=str(b["id"]),
                source_type=st,
                organization=b.get("organization") or ("JHH" if st == "local" else "Nextstrain seasonal-flu"),
                subtype=subtype,
                segment=segment,
                auspice_json=_resolve(base, b["auspice_json"]),
                frequencies_json=_resolve(base, b.get("frequencies_json")),
                root_sequence_json=_resolve(base, b.get("root_sequence_json")),
                label=b.get("label") or b["id"],
                active=bool(b.get("active", True)),
                resolution=b.get("resolution"),
                remote=b.get("remote"),
                fetched_at=b.get("fetched_at"),
                build_date=b.get("build_date"),
                downsampling_description=b.get("downsampling_description"),
                synthetic=bool(b.get("synthetic", False)),
                managed_by=b.get("managed_by"),
                extra={k: v for k, v in b.items() if k not in KNOWN_KEYS},
            )
        )
    if problems:
        raise ManifestError("Manifest problems:\n  " + "\n  ".join(problems))
    return entries


def write_manifest(path: Path, entries: list[dict]) -> None:
    header = (
        "# Builds the dashboard compares. Entries with `managed_by: fetch` are rewritten by\n"
        "# `ffc fetch`; add your own entries without that key and they are kept.\n"
        "# Paths are relative to the project folder.\n"
    )
    path.write_text(header + yaml.safe_dump({"version": 1, "builds": entries}, sort_keys=False))


def load_harmonization(path: Path | None = None) -> dict:
    path = path or PROJECT_ROOT / "config" / "taxon_harmonization.yaml"
    if not path.exists():
        return {"version": 0, "mappings": []}
    data = yaml.safe_load(path.read_text()) or {}
    data.setdefault("version", 1)
    data["mappings"] = data.get("mappings") or []
    return data
