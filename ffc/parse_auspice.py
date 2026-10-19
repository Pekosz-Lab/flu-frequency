"""Parse an Auspice v2 dataset JSON into flat Python structures.

Only the JSON is read. Nothing is fetched.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .dates import from_decimal

MUTATION_RE = re.compile(r"^([A-Za-z\-\*\.])(\d+)([A-Za-z\-\*\.])$")


@dataclass
class ParsedNode:
    name: str
    parent: str | None
    is_tip: bool
    attrs: dict  # scalar node_attrs values (value of {"value": ...} dicts)
    num_date: float | None
    mutations: dict  # gene -> list[(from, pos, to)]


@dataclass
class ParsedBuild:
    meta: dict
    nodes: list[ParsedNode]  # preorder
    tips: list[ParsedNode]
    colorings: dict  # key -> {title, type, scale: {value: color}}
    genome_annotations: dict  # gene -> {start, end, strand, ...}
    embedded_frequencies: dict | None = None
    parse_notes: list[str] = field(default_factory=list)


def _scalar(v):
    if isinstance(v, dict):
        if "value" in v:
            v = v["value"]
        else:
            return None
    if isinstance(v, (str, int, float, bool)):
        return v
    return None


def parse_mutations(branch_attrs: dict) -> dict:
    out: dict[str, list] = {}
    for gene, muts in (branch_attrs.get("mutations") or {}).items():
        parsed = []
        for m in muts or []:
            mm = MUTATION_RE.match(str(m))
            if mm:
                parsed.append((mm.group(1).upper(), int(mm.group(2)), mm.group(3).upper()))
        if parsed:
            out[gene] = parsed
    return out


def parse_build(d: dict) -> ParsedBuild:
    meta = d.get("meta", {})
    nodes: list[ParsedNode] = []
    # iterative preorder
    stack = [(d["tree"], None)]
    while stack:
        n, parent = stack.pop()
        attrs = {}
        for k, v in (n.get("node_attrs") or {}).items():
            if k == "num_date":
                continue
            sv = _scalar(v)
            if sv is not None:
                attrs[k] = sv
        nd = n.get("node_attrs", {}).get("num_date")
        num_date = None
        if isinstance(nd, dict) and isinstance(nd.get("value"), (int, float)):
            num_date = float(nd["value"])
        kids = n.get("children") or []
        node = ParsedNode(
            name=n["name"],
            parent=parent,
            is_tip=not kids,
            attrs=attrs,
            num_date=num_date,
            mutations=parse_mutations(n.get("branch_attrs") or {}),
        )
        nodes.append(node)
        for c in reversed(kids):
            stack.append((c, n["name"]))
    colorings = {}
    for c in meta.get("colorings") or []:
        key = c.get("key")
        if not key:
            continue
        scale = {}
        if isinstance(c.get("scale"), list):
            for pair in c["scale"]:
                if isinstance(pair, list) and len(pair) == 2 and isinstance(pair[1], str):
                    scale[str(pair[0])] = pair[1]
        colorings[key] = {"title": c.get("title") or key, "type": c.get("type") or "categorical", "scale": scale}
    embedded = None
    # Auspice v2 normally keeps frequencies in a sidecar; accept an embedded
    # block in the same tip-frequencies format if a build carries one.
    for key in ("frequencies", "tip_frequencies", "tip-frequencies"):
        if isinstance(d.get(key), dict) and "pivots" in d[key]:
            embedded = d[key]
            break
    return ParsedBuild(
        meta=meta,
        nodes=nodes,
        tips=[n for n in nodes if n.is_tip],
        colorings=colorings,
        genome_annotations=meta.get("genome_annotations") or {},
        embedded_frequencies=embedded,
    )


def tip_collection_date(node: ParsedNode) -> str | None:
    return from_decimal(node.num_date).isoformat() if node.num_date is not None else None


def trimmed_meta(meta: dict) -> dict:
    """Meta fields worth storing as json_metadata (colour scales stored separately)."""
    keep = ["title", "updated", "build_url", "build_avatar", "data_provenance", "maintainers",
            "display_defaults", "panels", "filters", "geo_resolutions"]
    out = {k: meta[k] for k in keep if k in meta}
    out["colorings"] = [
        {"key": c.get("key"), "title": c.get("title"), "type": c.get("type")}
        for c in meta.get("colorings") or []
    ]
    out["genome_annotations"] = meta.get("genome_annotations") or {}
    return out
