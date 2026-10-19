"""Synthetic Auspice v2 builds for demos and tests.

Everything here is invented: strain names, dates, clades, mutations. The
JSONs mimic the structure of the Pekosz Lab local builds (legacy-clade,
subclade, sequencing_run, no geography) and of Nextstrain seasonal-flu
builds (clade, subclade, region, country, root-sequence sidecar).
"""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import numpy as np
import yaml

from .dates import to_decimal
from .frequencies import recompute_tip_frequencies

AA = "ACDEFGHIKLMNPQRSTVWY"
NT = "ACGT"

SUBCLADES = {
    "h3n2": {
        "clade": "2a.3a.1",
        "subclades": [  # name, parent, emergence (decimal year), growth
            ("J", None, 2022.6, 2.0), ("J.1", "J", 2023.4, 3.0), ("J.2", "J", 2023.8, 3.5),
            ("J.2.1", "J.2", 2024.5, 4.0), ("J.2.2", "J.2", 2024.9, 4.5), ("K", "J.2", 2025.4, 6.0),
        ],
        "annotations": {
            "HA": {"nuc": (1, 1718), "SigPep": (1, 48), "HA1": (49, 1035), "HA2": (1036, 1698)},
            "NA": {"nuc": (1, 1439), "NA": (8, 1417)},
        },
    },
    "h1n1pdm": {
        "clade": "5a.2a",
        "subclades": [
            ("C.1", None, 2022.5, 2.0), ("C.1.1", "C.1", 2023.3, 3.0), ("C.1.9", "C.1", 2023.9, 3.5),
            ("D", "C.1.9", 2024.4, 4.0), ("D.1", "D", 2024.9, 4.5), ("D.3", "D", 2025.3, 5.0),
        ],
        "annotations": {
            "HA": {"nuc": (1, 1752), "SigPep": (21, 71), "HA1": (72, 1052), "HA2": (1053, 1718)},
            "NA": {"nuc": (1, 1433), "NA": (9, 1418)},
        },
    },
    "vic": {
        "clade": "V1A.3a.2",
        "subclades": [
            ("C.5", None, 2022.5, 2.0), ("C.5.1", "C.5", 2023.4, 3.0), ("C.5.6", "C.5", 2023.9, 3.5),
            ("C.5.7", "C.5", 2024.6, 4.0), ("C.3", None, 2024.2, 3.0),
        ],
        "annotations": {
            "HA": {"nuc": (1, 1885), "SigPep": (34, 78), "HA1": (79, 1119), "HA2": (1120, 1791)},
            # global NA uses slightly different coordinates to exercise the warning
            "NA": {"nuc": (1, 1401), "NA": (1, 1401)},
        },
    },
}
LEGACY_PREFIX = {"h3n2": "2a.3a.1", "h1n1pdm": "5a.2a.1", "vic": "V1A.3a.2"}
REGIONS = {
    "North America": ["USA", "Canada", "Mexico"],
    "Europe": ["United Kingdom", "France", "Germany", "Spain"],
    "Asia": ["Japan", "China", "India", "Singapore"],
    "Oceania": ["Australia", "New Zealand"],
    "South America": ["Brazil", "Chile"],
    "Africa": ["South Africa", "Kenya"],
}
PALETTE = ["#4041C7", "#3F63CF", "#4C90C0", "#62AA96", "#80B970", "#B1BD4E", "#D3A53F", "#E3743A", "#DC2F24"]


def _shares(subclades, t: float, bias: dict | None = None):
    w = []
    for name, _, emerg, growth in subclades:
        x = 1 / (1 + np.exp(-growth * (t - emerg)))
        w.append(x * (bias or {}).get(name, 1.0))
    w = np.asarray(w)
    # later subclades displace earlier ones
    disp = np.ones(len(w))
    for i in range(len(w)):
        for j in range(i + 1, len(w)):
            disp[i] *= 1 - 0.85 * w[j] / max(w.max(), 1e-9)
    s = np.clip(w * disp, 1e-6, None)
    return s / s.sum()


def _seasonal_dates(rng, start: float, end: float, n: int):
    out = []
    while len(out) < n:
        t = rng.uniform(start, end)
        frac = t % 1
        # northern-hemisphere winter peaks, some year-round background
        dens = 0.25 + np.cos(2 * np.pi * (frac - 0.05)) ** 8 + 0.6 * max(0, np.cos(2 * np.pi * frac)) ** 2
        if rng.uniform(0, 2) < dens:
            out.append(t)
    return np.asarray(sorted(out))


def make_build(subtype: str, segment: str, kind: str, start: float, end: float, n_tips: int,
               seed: int, title: str, bias: dict | None = None):
    rng = np.random.default_rng(seed)
    # root sequence and subclade-defining mutations are shared by every build of a
    # subtype/segment (as in reality); tips and their private mutations are not
    shared_rng = np.random.default_rng(sum(map(ord, subtype + segment)))
    spec = SUBCLADES[subtype]
    ann = spec["annotations"][segment]
    if kind == "global" and subtype == "vic" and segment == "NA":
        ann = {"nuc": (1, 1401), "NA": (2, 1402)}
    cds = [g for g in ann if g != "nuc"]
    main_cds = "HA1" if segment == "HA" else "NA"
    lengths = {g: (ann[g][1] - ann[g][0] + 1) // (1 if g == "nuc" else 3) for g in ann}
    root = {g: "".join(shared_rng.choice(list(NT if g == "nuc" else AA), size=lengths[g])) for g in ann}
    state = {g: dict() for g in ann}  # overrides along the current path

    def mutate(gene, n, cur, r=None):
        r = r or rng
        muts = []
        for _ in range(n):
            pos = int(r.integers(1, lengths[gene] + 1))
            frm = cur[gene].get(pos, root[gene][pos - 1])
            alphabet = NT if gene == "nuc" else AA
            to = str(r.choice([c for c in alphabet if c != frm]))
            cur[gene][pos] = to
            muts.append(f"{frm}{pos}{to}")
        return muts

    node_id = [0]

    def new_name():
        node_id[0] += 1
        return f"NODE_{node_id[0]:07d}"

    # subclade backbone
    sub_nodes = {}

    def sub_node(name, parent_state):
        cur = {g: dict(v) for g, v in parent_state.items()}
        muts = {main_cds: mutate(main_cds, 2, cur, shared_rng), "nuc": mutate("nuc", 4, cur, shared_rng)}
        node = {"name": new_name(), "node_attrs": {}, "branch_attrs": {"mutations": muts, "labels": {"clade": name}},
                "children": []}
        return node, cur

    tree = {"name": new_name(), "node_attrs": {}, "branch_attrs": {}, "children": []}
    states = {None: state}
    for name, parent, _, _ in spec["subclades"]:
        node, cur = sub_node(name, states[parent])
        states[name] = cur
        sub_nodes[name] = node
        (sub_nodes[parent]["children"] if parent else tree["children"]).append(node)

    dates = _seasonal_dates(rng, start, end, n_tips)
    names = [s[0] for s in spec["subclades"]]
    tips = []
    for i, t in enumerate(dates):
        p = _shares(spec["subclades"], t, bias)
        sc = names[rng.choice(len(names), p=p)]
        cur = {g: dict(v) for g, v in states[sc].items()}
        muts = {"nuc": mutate("nuc", int(rng.integers(0, 3)), cur)}
        if rng.uniform() < 0.3:
            muts[main_cds] = mutate(main_cds, 1, cur)
        strain = f"{'A' if subtype != 'vic' else 'B'}/Synthetic-{kind}/{seed % 1000}{i:05d}/{int(t)}"
        attrs = {
            "num_date": {"value": round(float(t), 4), "confidence": [float(t) - 0.002, float(t) + 0.002]},
            "subclade": {"value": sc},
        }
        legacy = LEGACY_PREFIX[subtype] + ("" if sc.count(".") < 2 else ".x")
        if kind == "local":
            attrs["legacy-clade"] = {"value": legacy}
            attrs["sequencing_run"] = {"value": f"run{int((t - start) * 12) % 18 + 1:02d}"}
            attrs["qc_overallStatus"] = {"value": "good" if rng.uniform() < 0.9 else "mediocre"}
            if rng.uniform() < 0.03:
                attrs.pop("subclade")  # unassigned tips exist in real builds
        else:
            region = rng.choice(list(REGIONS), p=[0.35, 0.25, 0.2, 0.08, 0.07, 0.05])
            attrs["clade_membership"] = {"value": legacy}
            attrs["region"] = {"value": str(region)}
            attrs["country"] = {"value": str(rng.choice(REGIONS[region]))}
        tip = {"name": strain, "node_attrs": attrs, "branch_attrs": {"mutations": muts}}
        tips.append((sc, tip, float(t)))
        sub_nodes[sc]["children"].append(tip)
    # remove backbone nodes that received no tips
    def prune(n):
        kept = []
        for c in n.get("children", []):
            if "children" in c:
                prune(c)
                if not c["children"]:
                    continue
            kept.append(c)
        n["children"] = kept

    prune(tree)

    # Internal nodes need dates for Auspice; use the earliest descendant
    def fill(n):
        if "children" not in n:
            return n["node_attrs"]["num_date"]["value"]
        ds = [fill(c) for c in n["children"]]
        n["node_attrs"]["num_date"] = {"value": round(min(ds) - 0.05, 4)}
        return min(ds) - 0.05

    fill(tree)

    # like seasonal-flu: only some subclades have an official colour; the rest are grey in Auspice
    listed = names if kind == "local" else names[: max(2, len(names) - 2)]
    sub_scale = [[name, PALETTE[i % len(PALETTE)]] for i, name in enumerate(listed)]
    colorings = [
        {"key": "num_date", "title": "Sampling date", "type": "continuous"},
        {"key": "gt", "title": "Genotype", "type": "categorical"},
        {"key": "subclade", "title": "Subclade", "type": "categorical", "scale": sub_scale},
    ]
    if kind == "local":
        colorings += [
            {"key": "legacy-clade", "title": "Legacy clade", "type": "categorical"},
            {"key": "sequencing_run", "title": "Sequencing run", "type": "categorical"},
            {"key": "qc_overallStatus", "title": "QC status", "type": "categorical"},
        ]
        filters = ["legacy-clade", "subclade", "sequencing_run", "qc_overallStatus"]
    else:
        colorings += [
            {"key": "clade_membership", "title": "Clade", "type": "categorical"},
            {"key": "region", "title": "Region", "type": "categorical"},
            {"key": "country", "title": "Country", "type": "categorical"},
        ]
        filters = ["clade_membership", "subclade", "region", "country"]
    meta = {
        "title": title,
        "updated": dt.date.fromordinal(dt.date(int(end), 1, 1).toordinal() + int((end % 1) * 365)).isoformat(),
        "build_url": "https://example.org/synthetic-demo",
        "data_provenance": [{"name": "SYNTHETIC DEMO DATA"}],
        "colorings": colorings,
        "filters": filters,
        "panels": ["tree", "entropy", "frequencies"],
        "genome_annotations": {
            g: {"start": a[0], "end": a[1], "strand": "+", "type": "nuc" if g == "nuc" else "CDS"} for g, a in ann.items()
        },
        "display_defaults": {"color_by": "subclade"},
    }
    if kind == "global":
        meta["geo_resolutions"] = [{"key": "region", "demes": {}}, {"key": "country", "demes": {}}]
    auspice = {"version": "v2", "meta": meta, "tree": tree}
    dated = {tip["name"]: t for _, tip, t in tips}
    # seasonal-flu builds use weekly pivots; the lab builds monthly
    pivots, w = recompute_tip_frequencies(dated, pivot_interval_days=7 if kind == "global" else None)
    freq = {"generated_by": {"program": "ffc-demo", "version": "synthetic"}, "pivots": [round(p, 4) for p in pivots]}
    for k, v in w.items():
        freq[k] = {"frequencies": [round(float(x), 6) for x in v]}
    # mimic real files: an internal node entry
    freq[tree["name"]] = {"frequencies": [0.0] * len(pivots)}
    root_seq = {g: s for g, s in root.items()}
    return auspice, freq, root_seq


def write_demo(out_dir: Path, manifest_path: Path, base: Path) -> Path:
    """Write synthetic builds + a demo manifest. Returns the manifest path."""
    today = dt.date(2026, 10, 1)
    end = to_decimal(today)
    entries = []
    seed = 11
    for subtype in ("h1n1pdm", "h3n2", "vic"):
        for segment in ("HA", "NA"):
            seed += 7
            local_dir = out_dir / "local" / subtype / segment.lower()
            local_dir.mkdir(parents=True, exist_ok=True)
            bias = {s[0]: 1.0 + 0.8 * ((i % 3) - 1) for i, s in enumerate(SUBCLADES[subtype]["subclades"])}
            a, f, _ = make_build(subtype, segment, "local", end - 5.3, end - 0.05, 420, seed,
                                 f"SYNTHETIC JHH {subtype} {segment}", bias)
            (local_dir / "auspice.json").write_text(json.dumps(a))
            recompute_case = subtype == "vic" and segment == "NA"
            if not recompute_case:
                (local_dir / "auspice_tip-frequencies.json").write_text(json.dumps(f))
            entries.append(
                {
                    "id": f"jhh_{subtype}_{segment.lower()}",
                    "source_type": "local",
                    "organization": "JHH",
                    "subtype": subtype,
                    "segment": segment,
                    "auspice_json": str((local_dir / "auspice.json").relative_to(base)),
                    "label": f"JHH {subtype.upper()} {segment} local surveillance (SYNTHETIC)",
                    "active": True,
                    "synthetic": True,
                }
            )
            for res, years, n in (("6m", 0.5, 500), ("2y", 2.0, 900), ("12y", 12.0, 1200)):
                seed += 3
                gdir = out_dir / "global" / subtype / segment.lower() / res
                gdir.mkdir(parents=True, exist_ok=True)
                a, f, root = make_build(subtype, segment, "global", max(end - years, 2014.0), end, n, seed,
                                        f"SYNTHETIC seasonal-flu {subtype} {segment} {res}")
                if res == "2y":
                    f["projection_pivot"] = f["pivots"][-2]
                (gdir / "dataset.json").write_text(json.dumps(a))
                (gdir / "dataset_tip-frequencies.json").write_text(json.dumps(f))
                (gdir / "dataset_root-sequence.json").write_text(json.dumps(root))
                entries.append(
                    {
                        "id": f"nextstrain_{subtype}_{segment.lower()}_{res}",
                        "source_type": "global",
                        "organization": "Nextstrain seasonal-flu",
                        "subtype": subtype,
                        "segment": segment,
                        "resolution": res,
                        "auspice_json": str((gdir / "dataset.json").relative_to(base)),
                        "label": f"Nextstrain seasonal-flu {subtype} {segment} {res} (SYNTHETIC)",
                        "remote": f"nextstrain.org/flu/seasonal/{subtype}/{segment.lower()}/{res} (synthetic stand-in)",
                        "fetched_at": "2026-10-01T09:00:00-04:00",
                        "active": True,
                        "synthetic": True,
                    }
                )
    # synthetic "national colours" file, as `ffc fetch` would write it
    colors = {"fetched_at": "2026-10-01T09:00:00-04:00", "source": "SYNTHETIC", "lineages": {}}
    for subtype in SUBCLADES:
        names = [s[0] for s in SUBCLADES[subtype]["subclades"]]
        for seg in ("ha", "na"):
            colors["lineages"][f"{subtype}/{seg}"] = {
                "keys": {"subclade": [[n, PALETTE[i % len(PALETTE)]] for i, n in enumerate(names[:-2])]},
                "sources": [{"resolution": "2y", "updated": "2026-10-01"}],
            }
    (out_dir / "colors.json").write_text(json.dumps(colors))
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        "# SYNTHETIC demo manifest written by `ffc demo`. Not real surveillance data.\n"
        + yaml.safe_dump({"version": 1, "builds": entries}, sort_keys=False)
    )
    return manifest_path
