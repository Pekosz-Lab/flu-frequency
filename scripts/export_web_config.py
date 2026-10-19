#!/usr/bin/env python3
"""Write frontend/src/engine/web-config.json for the public website.

Single source of truth: config/settings.yaml, config/fetch.yaml and the caveat
wording in ffc/constants.py. Only PUBLIC dataset locations are written:
the website must never reference the lab's private Nextstrain group.

    python scripts/export_web_config.py          # write
    python scripts/export_web_config.py --check  # exit 1 if the file is out of date
"""

import json
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from ffc import constants as C  # noqa: E402
from ffc.config import load_settings  # noqa: E402

OUT = ROOT / "frontend" / "src" / "engine" / "web-config.json"

# Public sources only. The lab's public group mirrors the private build layout
# (see the nextstrain repo's scripts/nextstrain_upload.py --public).
PUBLIC_LOCAL_PREFIX = "groups/PekoszLab-Public/seasonal-flu"


def build() -> dict:
    s = load_settings(ROOT / "config" / "settings.yaml")
    f = yaml.safe_load((ROOT / "config" / "fetch.yaml").read_text())
    glob_prefix = f["global"]["remote_prefix"].replace("nextstrain.org/", "").strip("/")
    cfg = {
        "nextstrain_origin": "https://nextstrain.org",
        "segments": [x.upper() for x in f["segments"]],
        "enabled_segments": s["enabled_segments"],
        "subtypes": [
            {"id": k, "label": C.SUBTYPES[k], "local": v["local"], "global": v["global"]}
            for k, v in f["subtypes"].items()
        ],
        "global": {"prefix": glob_prefix, "resolutions": f["global"]["resolutions"],
                   "organization": f["global"].get("organization", "Nextstrain seasonal-flu")},
        "local": {"prefix": PUBLIC_LOCAL_PREFIX, "organization": "JHH (PekoszLab-Public group)"},
        "grouping_fields": s["grouping_fields"],
        "metadata_filters": s["metadata_filters"],
        "shared_filters": s["shared_filters"],
        "recompute": s["recompute"],
        "default_palette": s["default_palette"],
        "default_top_n": s["default_top_n"],
        "text": {
            "caveat": C.CAVEAT_MAIN,
            "caveat_points": C.CAVEAT_POINTS,
            "footnote": C.FIGURE_FOOTNOTE,
            "alignment": C.ALIGNMENT_METHOD,
            "counts": C.COUNT_METHOD,
            "positive": C.POSITIVE_LABEL,
            "negative": C.NEGATIVE_LABEL,
            "local_name": C.LOCAL_DATASET_NAME,
            "global_name": C.GLOBAL_DATASET_NAME,
            "not_available": C.NOT_AVAILABLE,
            "local_downsampling": C.LOCAL_DOWNSAMPLING,
            "global_downsampling": C.GLOBAL_DOWNSAMPLING,
            "freq_source_labels": C.FREQ_SOURCE_LABELS,
        },
    }
    blob = json.dumps(cfg)
    if "groups/PekoszLab/" in blob:  # private group path must never reach the website
        raise SystemExit("refusing to write a private Nextstrain group path into the website config")
    return cfg


def main():
    text = json.dumps(build(), indent=1) + "\n"
    if "--check" in sys.argv:
        if not OUT.exists() or OUT.read_text() != text:
            print(f"{OUT} is out of date; run python scripts/export_web_config.py")
            sys.exit(1)
        print("web-config.json up to date")
        return
    OUT.write_text(text)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
