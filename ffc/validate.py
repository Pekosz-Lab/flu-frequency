"""Validation of Auspice v2 dataset JSONs and augur tip-frequency JSONs.

Errors stop ingestion of that build; warnings are recorded and shown in the
dashboard's data-status panel.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Report:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


def validate_auspice(d: dict) -> Report:
    r = Report()
    if not isinstance(d, dict):
        r.errors.append("Top level is not a JSON object.")
        return r
    version = d.get("version")
    if version != "v2":
        r.errors.append(
            f"Unsupported Auspice JSON version {version!r}; only Auspice v2 dataset JSONs "
            "(augur export v2) are supported."
        )
    if not isinstance(d.get("meta"), dict):
        r.errors.append("Missing 'meta' object.")
    tree = d.get("tree")
    if isinstance(tree, list):
        r.errors.append("'tree' is a list (multiple subtrees); only single-tree datasets are supported.")
    elif not isinstance(tree, dict):
        r.errors.append("Missing 'tree' object.")
    if r.errors:
        return r
    meta = d["meta"]
    for key in ("updated", "colorings", "genome_annotations"):
        if key not in meta:
            r.warnings.append(f"meta.{key} is absent.")
    # Walk once for structural checks (iterative: trees can be deep).
    names: set[str] = set()
    dup = 0
    tips = undated = unnamed = 0
    stack = [tree]
    while stack:
        n = stack.pop()
        name = n.get("name")
        if not name:
            unnamed += 1
        elif name in names:
            dup += 1
        else:
            names.add(name)
        kids = n.get("children")
        if kids:
            stack.extend(kids)
        else:
            tips += 1
            if not isinstance(n.get("node_attrs", {}).get("num_date"), dict):
                undated += 1
    if unnamed:
        r.errors.append(f"{unnamed} tree nodes have no name.")
    if dup:
        r.errors.append(f"{dup} duplicated node names.")
    if tips == 0:
        r.errors.append("Tree has no tips.")
    if undated:
        r.warnings.append(f"{undated} of {tips} tips have no num_date; they are excluded from frequencies.")
    return r


def validate_tip_frequencies(f: dict, tip_names: set[str]) -> Report:
    r = Report()
    if not isinstance(f, dict):
        r.errors.append("Frequency JSON top level is not an object.")
        return r
    pivots = f.get("pivots")
    if not isinstance(pivots, list) or len(pivots) < 2:
        r.errors.append("Frequency JSON has no 'pivots' list (augur tip-frequencies format expected).")
        return r
    if any(not isinstance(p, (int, float)) for p in pivots):
        r.errors.append("Non-numeric pivots.")
        return r
    if any(b <= a for a, b in zip(pivots, pivots[1:])):
        r.errors.append("Pivots are not strictly increasing.")
    entries = {k: v for k, v in f.items() if isinstance(v, dict) and "frequencies" in v}
    bad_len = [k for k, v in entries.items() if len(v["frequencies"]) != len(pivots)]
    if bad_len:
        r.errors.append(f"{len(bad_len)} entries have a frequency vector of the wrong length.")
    neg = sum(1 for v in entries.values() if any((x or 0) < 0 for x in v["frequencies"]))
    if neg:
        r.errors.append(f"{neg} entries contain negative frequencies.")
    non_tip = [k for k in entries if k not in tip_names]
    missing = [t for t in tip_names if t not in entries]
    if non_tip:
        r.warnings.append(
            f"{len(non_tip)} frequency entries are not tips of the tree (e.g. internal nodes); "
            "they are ignored, as in Auspice."
        )
    if missing:
        r.warnings.append(
            f"{len(missing)} of {len(tip_names)} tips have no frequency entry; they contribute no "
            "frequency weight."
        )
    if not set(entries) & tip_names:
        r.errors.append("No frequency entry matches a tip name in the tree.")
    return r
