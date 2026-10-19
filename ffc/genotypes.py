"""Tip genotypes reconstructed from branch mutations, as Auspice does for
"Color by genotype".

For every gene (and `nuc`) in a build we record, for each tip, the state at
every position that mutates somewhere in the tree, but only where it differs
from the root state (sparse). The root state comes from the build's
root-sequence sidecar JSON when supplied, otherwise from the `from` state of
the first mutation at that position in a preorder walk (which is what
Auspice does without a root sequence).
"""

from __future__ import annotations

from collections import Counter, defaultdict

from .parse_auspice import ParsedBuild


def root_states(build: ParsedBuild, root_sequence: dict | None) -> dict[str, dict[int, str]]:
    roots: dict[str, dict[int, str]] = defaultdict(dict)
    for node in build.nodes:  # preorder
        for gene, muts in node.mutations.items():
            g = roots[gene]
            for frm, pos, _ in muts:
                if pos not in g:
                    g[pos] = frm
    if root_sequence:
        for gene, positions in roots.items():
            seq = root_sequence.get(gene)
            if isinstance(seq, str):
                for pos in positions:
                    if 0 < pos <= len(seq):
                        positions[pos] = seq[pos - 1].upper()
    return dict(roots)


def tip_genotypes(build: ParsedBuild, roots: dict[str, dict[int, str]]):
    """Return list of (tip, gene, position, state) for states != root."""
    children: dict[str | None, list] = defaultdict(list)
    for n in build.nodes:
        children[n.parent].append(n)
    root = build.nodes[0]
    current: dict[str, dict[int, str]] = defaultdict(dict)  # only positions != root
    out: list[tuple[str, str, int, str]] = []
    # iterative DFS with undo records
    stack: list[tuple[str, object]] = [("enter", root)]
    while stack:
        action, item = stack.pop()
        if action == "exit":
            for gene, pos, prev in item:  # type: ignore[union-attr]
                if prev is None:
                    current[gene].pop(pos, None)
                else:
                    current[gene][pos] = prev
            continue
        node = item
        undo = []
        for gene, muts in node.mutations.items():
            rg = roots.get(gene, {})
            cg = current[gene]
            for _, pos, to in muts:
                undo.append((gene, pos, cg.get(pos)))
                if rg.get(pos) == to:
                    cg.pop(pos, None)
                else:
                    cg[pos] = to
        stack.append(("exit", list(reversed(undo))))
        if node.is_tip:
            for gene, states in current.items():
                for pos, st in states.items():
                    out.append((node.name, gene, pos, st))
        else:
            for c in reversed(children[node.name]):
                stack.append(("enter", c))
    return out


def position_summary(roots, tip_rows, n_tips: int):
    """Per (gene, position): root state, number of tips differing, state counts."""
    counts: dict[tuple[str, int], Counter] = defaultdict(Counter)
    for _, gene, pos, st in tip_rows:
        counts[(gene, pos)][st] += 1
    rows = []
    for gene, positions in roots.items():
        for pos, rs in positions.items():
            c = counts.get((gene, pos), Counter())
            n_diff = sum(c.values())
            states = dict(c)
            states[rs] = states.get(rs, 0) + (n_tips - n_diff)
            rows.append(
                {
                    "gene": gene,
                    "position": pos,
                    "root_state": rs,
                    "n_tips_nonroot": n_diff,
                    "n_states": sum(1 for v in states.values() if v > 0),
                    "state_counts": states,
                }
            )
    return rows
