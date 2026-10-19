"""Clade/subclade colours that match nextstrain.org.

How Auspice (nextstrain.org) colours a categorical trait, reproduced here:

* If the dataset JSON gives the coloring a ``scale``, listed values get those
  colours. Values present in the tree but not listed get shades of grey
  (#BDC3C6 -> #868992, HCL interpolation), in order of first appearance in a
  pre-order walk of the tree.
* If there is no scale (seasonal-flu's ``clade_membership``), Auspice takes the
  valid values of the tree, sorts them (alphabetically for clade_membership,
  otherwise by count then name), and assigns its default palette for that
  number of values.

The palette below and the grey-ramp maths come from Auspice
(nextstrain/auspice, src/util/globals.js and src/util/colorScale.ts) and the
lab's scripts/sync_subclade_colors.py, so colours are identical to the
national builds.
"""

from __future__ import annotations

import math
import re

UNKNOWN_COLOR = "#ADB1B3"
GREY_RANGE = ("#BDC3C6", "#868992")
INVALID_STRINGS = {"unknown", "?", "nan", "na", "n/a", "", "unassigned"}


def is_valid_value(v) -> bool:
    if isinstance(v, bool) or isinstance(v, (int, float)):
        return True
    return isinstance(v, str) and v.lower() not in INVALID_STRINGS


def natural_key(v: str):
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", str(v))]


AUSPICE_CATEGORICAL = [
    [],
    ['#4C90C0'],
    ['#4C90C0', '#CBB742'],
    ['#4988C5', '#7EB876', '#CBB742'],
    ['#4580CA', '#6BB28D', '#AABD52', '#DFA43B'],
    ['#4377CD', '#61AB9D', '#94BD61', '#CDB642', '#E68133'],
    ['#416DCE', '#59A3AA', '#84BA6F', '#BBBC49', '#E29D39', '#E1502A'],
    ['#3F63CF', '#529AB6', '#75B681', '#A6BE55', '#D4B13F', '#E68133', '#DC2F24'],
    ['#3E58CF', '#4B8EC1', '#65AE96', '#8CBB69', '#B8BC4A', '#DCAB3C', '#E67932', '#DC2F24'],
    ['#3F4DCB', '#4681C9', '#5AA4A8', '#78B67E', '#9EBE5A', '#C5B945', '#E0A23A', '#E67231', '#DC2F24'],
    ['#4042C7', '#4274CE', '#5199B7', '#69B091', '#88BB6C', '#ADBD51', '#CEB541', '#E39B39', '#E56C2F', '#DC2F24'],
    ['#4137C2', '#4066CF', '#4B8DC2', '#5DA8A3', '#77B67F', '#96BD60', '#B8BC4B', '#D4B13F', '#E59638', '#E4672F', '#DC2F24'],
    ['#462EB9', '#3E58CF', '#4580CA', '#549DB2', '#69B091', '#83BA70', '#A2BE57', '#C1BA47', '#D9AD3D', '#E69136', '#E4632E', '#DC2F24'],
    ['#4B26B1', '#3F4ACA', '#4272CE', '#4D92BF', '#5DA8A3', '#74B583', '#8EBC66', '#ACBD51', '#C8B944', '#DDA93C', '#E68B35', '#E3602D', '#DC2F24'],
    ['#511EA8', '#403DC5', '#4063CF', '#4785C7', '#559EB1', '#67AF94', '#7EB877', '#98BD5E', '#B4BD4C', '#CDB642', '#DFA53B', '#E68735', '#E35D2D', '#DC2F24'],
    ['#511EA8', '#403AC4', '#3F5ED0', '#457FCB', '#5098B9', '#60AA9F', '#73B583', '#8BBB6A', '#A4BE56', '#BDBB48', '#D3B240', '#E19F3A', '#E68234', '#E25A2C', '#DC2F24'],
    ['#511EA8', '#4138C3', '#3E59CF', '#4379CD', '#4D92BE', '#5AA5A8', '#6BB18E', '#7FB975', '#96BD5F', '#AFBD4F', '#C5B945', '#D8AE3E', '#E39B39', '#E67D33', '#E2572B', '#DC2F24'],
    ['#511EA8', '#4236C1', '#3F55CE', '#4273CE', '#4A8CC2', '#569FAF', '#64AD98', '#76B680', '#8BBB6A', '#A1BE58', '#B7BC4B', '#CCB742', '#DCAB3C', '#E59638', '#E67932', '#E1552B', '#DC2F24'],
    ['#511EA8', '#4335BF', '#3F51CC', '#416ECE', '#4887C6', '#529BB6', '#5FA9A0', '#6EB389', '#81B973', '#95BD61', '#AABD52', '#BFBB48', '#D1B340', '#DEA63B', '#E69237', '#E67531', '#E1522A', '#DC2F24'],
    ['#511EA8', '#4333BE', '#3F4ECB', '#4169CF', '#4682C9', '#4F96BB', '#5AA5A8', '#68AF92', '#78B77D', '#8BBB6A', '#9EBE59', '#B3BD4D', '#C5B945', '#D5B03F', '#E0A23A', '#E68D36', '#E67231', '#E1502A', '#DC2F24'],
    ['#511EA8', '#4432BD', '#3F4BCA', '#4065CF', '#447ECC', '#4C91BF', '#56A0AE', '#63AC9A', '#71B486', '#81BA72', '#94BD62', '#A7BE54', '#BABC4A', '#CBB742', '#D9AE3E', '#E29E39', '#E68935', '#E56E30', '#E14F2A', '#DC2F24'],
    ['#511EA8', '#4531BC', '#3F48C9', '#3F61D0', '#4379CD', '#4A8CC2', '#539CB4', '#5EA9A2', '#6BB18E', '#7AB77B', '#8BBB6A', '#9CBE5B', '#AFBD4F', '#C0BA47', '#CFB541', '#DCAB3C', '#E39B39', '#E68534', '#E56B2F', '#E04D29', '#DC2F24'],
    ['#511EA8', '#4530BB', '#3F46C8', '#3F5ED0', '#4375CD', '#4988C5', '#5098B9', '#5AA5A8', '#66AE95', '#73B583', '#82BA71', '#93BC62', '#A4BE56', '#B5BD4C', '#C5B945', '#D3B240', '#DEA73B', '#E59738', '#E68234', '#E4682F', '#E04C29', '#DC2F24'],
    ['#511EA8', '#462FBA', '#3F44C8', '#3E5BD0', '#4270CE', '#4784C8', '#4E95BD', '#57A1AD', '#61AB9C', '#6DB38A', '#7BB879', '#8BBB6A', '#9BBE5C', '#ABBD51', '#BBBC49', '#CBB843', '#D6AF3E', '#DFA43B', '#E69537', '#E67F33', '#E4662E', '#E04A29', '#DC2F24'],
    ['#511EA8', '#462EB9', '#4042C7', '#3E58CF', '#416DCE', '#4580CA', '#4C90C0', '#549DB2', '#5DA8A3', '#69B091', '#75B681', '#83BA70', '#92BC63', '#A2BE57', '#B2BD4D', '#C1BA47', '#CEB541', '#D9AD3D', '#E1A03A', '#E69136', '#E67C32', '#E4632E', '#E04929', '#DC2F24'],
    ['#511EA8', '#462EB9', '#4040C6', '#3F55CE', '#4169CF', '#447DCC', '#4A8CC2', '#529AB7', '#5AA5A8', '#64AD98', '#70B487', '#7DB878', '#8BBB6A', '#99BD5D', '#A9BD53', '#B7BC4B', '#C5B945', '#D1B340', '#DCAB3C', '#E29D39', '#E68D36', '#E67932', '#E3612D', '#E04828', '#DC2F24'],
    ['#511EA8', '#472DB8', '#403EC6', '#3F53CD', '#4066CF', '#4379CD', '#4989C5', '#4F97BB', '#57A1AD', '#61AA9E', '#6BB18E', '#77B67F', '#84BA70', '#92BC64', '#A0BE58', '#AFBD4F', '#BCBB49', '#CAB843', '#D4B13F', '#DEA83C', '#E39B39', '#E68A35', '#E67732', '#E35F2D', '#DF4728', '#DC2F24'],
    ['#511EA8', '#472CB7', '#403DC5', '#3F50CC', '#4063CF', '#4375CD', '#4785C7', '#4D93BE', '#559EB1', '#5DA8A3', '#67AF94', '#72B485', '#7EB877', '#8BBB6A', '#98BD5E', '#A6BE55', '#B4BD4C', '#C1BA47', '#CDB642', '#D7AF3E', '#DFA53B', '#E49838', '#E68735', '#E67431', '#E35D2D', '#DF4628', '#DC2F24'],
    ['#511EA8', '#482CB7', '#403BC5', '#3F4ECB', '#3F61D0', '#4272CE', '#4682C9', '#4C90C0', '#529BB5', '#5AA5A8', '#63AC9A', '#6DB28B', '#78B77D', '#84BA6F', '#91BC64', '#9EBE59', '#ACBD51', '#B9BC4A', '#C5B945', '#D0B441', '#DAAD3D', '#E0A23A', '#E59637', '#E68434', '#E67231', '#E35C2C', '#DF4528', '#DC2F24'],
    ['#511EA8', '#482BB6', '#403AC4', '#3F4CCB', '#3F5ED0', '#426FCE', '#457FCB', '#4A8CC2', '#5098B9', '#58A2AC', '#60AA9F', '#69B091', '#73B583', '#7FB976', '#8BBB6A', '#97BD5F', '#A4BE56', '#B1BD4E', '#BDBB48', '#C9B843', '#D3B240', '#DCAB3C', '#E19F3A', '#E69337', '#E68234', '#E67030', '#E25A2C', '#DF4428', '#DC2F24'],
    ['#511EA8', '#482BB6', '#4039C3', '#3F4ACA', '#3E5CD0', '#416CCE', '#447CCD', '#4989C4', '#4E96BC', '#559FB0', '#5DA8A4', '#66AE96', '#6FB388', '#7AB77C', '#85BA6F', '#91BC64', '#9DBE5A', '#AABD53', '#B6BD4B', '#C2BA46', '#CDB642', '#D6B03F', '#DDA83C', '#E29D39', '#E69036', '#E67F33', '#E56D30', '#E2592C', '#DF4428', '#DC2F24'],
    ['#511EA8', '#482AB5', '#4138C3', '#3F48C9', '#3E59CF', '#4169CF', '#4379CD', '#4886C6', '#4D92BE', '#539CB4', '#5AA5A8', '#62AB9B', '#6BB18E', '#75B581', '#7FB975', '#8BBB6A', '#96BD5F', '#A2BE57', '#AFBD4F', '#BABC4A', '#C5B945', '#CFB541', '#D8AE3E', '#DFA63B', '#E39B39', '#E68D36', '#E67D33', '#E56B2F', '#E2572B', '#DF4328', '#DC2F24'],
    ['#511EA8', '#492AB5', '#4137C2', '#3F47C9', '#3E57CE', '#4067CF', '#4376CD', '#4783C8', '#4C8FC0', '#519AB7', '#58A2AC', '#5FA9A0', '#68AF93', '#70B486', '#7BB77A', '#85BA6F', '#90BC65', '#9CBE5B', '#A8BE54', '#B3BD4D', '#BEBB48', '#C9B843', '#D2B340', '#DAAD3D', '#E0A33B', '#E49838', '#E68B35', '#E67B32', '#E5692F', '#E2562B', '#DF4227', '#DC2F24'],
    ['#511EA8', '#492AB5', '#4236C1', '#3F45C8', '#3F55CE', '#4064CF', '#4273CE', '#4681CA', '#4A8CC2', '#4F97BA', '#569FAF', '#5CA7A4', '#64AD98', '#6DB28B', '#76B680', '#80B974', '#8BBB6A', '#96BD60', '#A1BE58', '#ACBD51', '#B7BC4B', '#C2BA46', '#CCB742', '#D4B13F', '#DCAB3C', '#E1A13A', '#E59638', '#E68835', '#E67932', '#E4672F', '#E1552B', '#DF4227', '#DC2F24'],
    ['#511EA8', '#4929B4', '#4235C0', '#3F44C8', '#3F53CD', '#3F62CF', '#4270CE', '#457ECB', '#4989C4', '#4E95BD', '#549DB3', '#5AA5A8', '#61AB9C', '#69B090', '#72B485', '#7BB879', '#85BA6E', '#90BC65', '#9BBE5C', '#A6BE55', '#B1BD4E', '#BBBC49', '#C5B945', '#CEB541', '#D6AF3E', '#DDA93C', '#E29F39', '#E69537', '#E68634', '#E67732', '#E4662E', '#E1532B', '#DF4127', '#DC2F24'],
    ['#511EA8', '#4929B4', '#4335BF', '#3F42C7', '#3F51CC', '#3F60D0', '#416ECE', '#447CCD', '#4887C6', '#4D92BF', '#529BB6', '#58A2AB', '#5FA9A0', '#66AE95', '#6EB389', '#77B67E', '#81B973', '#8BBB6A', '#95BD61', '#A0BE59', '#AABD52', '#B5BD4C', '#BFBB48', '#C9B843', '#D1B340', '#D8AE3E', '#DEA63B', '#E29C39', '#E69237', '#E68434', '#E67531', '#E4642E', '#E1522A', '#DF4127', '#DC2F24'],
    ['#511EA8', '#4928B4', '#4334BF', '#4041C7', '#3F50CC', '#3F5ED0', '#416CCE', '#4379CD', '#4784C7', '#4B8FC1', '#5098B9', '#56A0AF', '#5CA7A4', '#63AC99', '#6BB18E', '#73B583', '#7CB878', '#86BB6E', '#90BC65', '#9ABD5C', '#A4BE56', '#AFBD4F', '#B9BC4A', '#C2BA46', '#CCB742', '#D3B240', '#DAAC3D', '#DFA43B', '#E39B39', '#E68F36', '#E68234', '#E67431', '#E4632E', '#E1512A', '#DF4027', '#DC2F24'],
]


def auspice_categorical(domain: list[str]) -> dict[str, str]:
    """Auspice createDiscreteScale: colors[n] for n values (cycled beyond 36)."""
    n = len(domain)
    if n == 0:
        return {}
    pal = AUSPICE_CATEGORICAL[n] if n < len(AUSPICE_CATEGORICAL) else AUSPICE_CATEGORICAL[-1]
    return {v: pal[i % len(pal)] for i, v in enumerate(domain)}


def auspice_sorted_domain(key: str, counts: dict[str, int]) -> list[str]:
    """Auspice sortedDomain(): clade_membership alphabetical, else count desc then name."""
    vals = [v for v in counts if is_valid_value(v)]
    if key == "clade_membership":
        return sorted(vals)
    return sorted(vals, key=lambda v: (-counts[v], v))


# ---- grey ramp identical to Auspice / d3 (d3-color Lab/HCL, interpolateHcl) ----
_Xn, _Yn, _Zn = 0.96422, 1.0, 0.82521
_t0, _t1 = 4 / 29, 6 / 29
_t2, _t3 = 3 * _t1 * _t1, _t1 ** 3


def _rgb2lrgb(x):
    x /= 255
    return x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4


def _lrgb2rgb(x):
    return 255 * (12.92 * x if x <= 0.0031308 else 1.055 * x ** (1 / 2.4) - 0.055)


def _xyz2lab(t):
    return t ** (1 / 3) if t > _t3 else t / _t2 + _t0


def _lab2xyz(t):
    return t ** 3 if t > _t1 else _t2 * (t - _t0)


def _hex2hcl(h):
    r, g, b = (_rgb2lrgb(int(h[i:i + 2], 16)) for i in (1, 3, 5))
    y = _xyz2lab((0.2225045 * r + 0.7168786 * g + 0.0606169 * b) / _Yn)
    if r == g == b:
        x = z = y
    else:
        x = _xyz2lab((0.4360747 * r + 0.3850649 * g + 0.1430804 * b) / _Xn)
        z = _xyz2lab((0.0139322 * r + 0.0971045 * g + 0.7141733 * b) / _Zn)
    L, A, B = 116 * y - 16, 500 * (x - y), 200 * (y - z)
    return math.degrees(math.atan2(B, A)) % 360, math.hypot(A, B), L


def _hcl2hex(hue, c, L):
    a, b = math.cos(math.radians(hue)) * c, math.sin(math.radians(hue)) * c
    y = (L + 16) / 116
    x, z = y + a / 500, y - b / 200
    x, y, z = _Xn * _lab2xyz(x), _Yn * _lab2xyz(y), _Zn * _lab2xyz(z)
    rgb = (_lrgb2rgb(3.1338561 * x - 1.6168667 * y - 0.4906146 * z),
           _lrgb2rgb(-0.9787684 * x + 1.9161415 * y + 0.0334540 * z),
           _lrgb2rgb(0.0719453 * x - 0.2289914 * y + 1.4052427 * z))
    return "#" + "".join(f"{max(0, min(255, int(math.floor(v + 0.5)))):02X}" for v in rgb)


def grey_ramp(n: int) -> list[str]:
    """Auspice createListOfColors(n, GREY_RANGE)."""
    if n <= 0:
        return []
    (h0, c0, l0), (h1, c1, l1) = (_hex2hcl(x) for x in GREY_RANGE)
    dh = h1 - h0
    if dh > 180 or dh < -180:
        dh -= 360 * round(dh / 360)
    return [_hcl2hex(h0 + dh * t, c0 + (c1 - c0) * t, l0 + (l1 - l0) * t) for t in (i / n for i in range(n))]


def national_colors(
    taxa: list[str],
    key: str | None,
    official_scale: list[tuple[str, str]],
    global_tree_values: list[tuple[str, int]],
    local_scale: dict[str, str],
) -> tuple[dict[str, str], dict[str, str]]:
    """Colours for clade/subclade taxa as the national (nextstrain.org) build shows them.

    official_scale:      [(value, hex)] from the latest fetched seasonal-flu JSONs for this key
    global_tree_values:  [(value, n_nodes)] of the selected global build, in pre-order of first appearance
    local_scale:         the local build JSON's own scale (the lab's synced colors.tsv), used only for
                         values the national build neither lists nor contains
    Returns (colour by taxon, source by taxon).
    """
    colors: dict[str, str] = {}
    source: dict[str, str] = {}
    if official_scale:
        for v, c in official_scale:
            colors.setdefault(v, c.upper())
            source.setdefault(v, "official scale")
        extras = [v for v, _ in global_tree_values if v not in colors and is_valid_value(v)]
        for v, c in zip(extras, grey_ramp(len(extras))):
            colors[v], source[v] = c, "grey (not in official scale)"
    elif global_tree_values:
        dom = auspice_sorted_domain(key or "", dict(global_tree_values))
        for v, c in auspice_categorical(dom).items():
            colors[v], source[v] = c, "Auspice default palette"
    rest = [t for t in taxa if t not in colors]
    leftover = []
    for t in rest:
        if t in local_scale:
            colors[t], source[t] = local_scale[t].upper(), "local build scale (not in national build)"
        else:
            leftover.append(t)
    leftover.sort(key=natural_key)
    for t, c in zip(leftover, grey_ramp(len(leftover))):
        colors[t], source[t] = c, "grey (not in national build)"
    return colors, source
