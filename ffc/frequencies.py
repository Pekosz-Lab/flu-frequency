"""Tip frequencies: import from augur tip-frequencies JSON, or recompute.

Auspice's frequency panel works from per-tip KDE frequencies at a set of
time pivots. For a colour-by value it sums the frequencies of the visible
tips carrying that value at each pivot and (with "normalize" on, the
default) divides by the summed frequency of all visible tips at that pivot.
We store per-tip weights here and do the summing/normalising at query time,
so filtered views behave the same way.
"""

from __future__ import annotations

import datetime as dt

import numpy as np

from .dates import add_months, from_decimal, month_start, to_decimal


def import_tip_frequencies(f: dict, tip_names: list[str]):
    """Return (pivots, {tip: np.array}) for tips only; plus projection pivot if any."""
    pivots = np.asarray(f["pivots"], dtype=float)
    weights = {}
    for t in tip_names:
        e = f.get(t)
        if isinstance(e, dict) and "frequencies" in e:
            weights[t] = np.asarray([x or 0.0 for x in e["frequencies"]], dtype=float)
    projection = f.get("projection_pivot")
    return pivots, weights, (float(projection) if isinstance(projection, (int, float)) else None)


def make_pivots(min_date: float, max_date: float, interval_months: int = 1) -> np.ndarray:
    """Monthly pivots from the month of the earliest tip to the month after the latest."""
    start = month_start(from_decimal(min_date))
    end = add_months(month_start(from_decimal(max_date)), 1)
    out = []
    d = start
    while d <= end:
        out.append(to_decimal(d))
        d = add_months(d, interval_months)
    return np.asarray(out)


def _density(mu: float, pivots: np.ndarray, sigma: float) -> np.ndarray:
    z = np.exp(-0.5 * ((pivots - mu) / sigma) ** 2)
    s = z.sum()
    return z / s if s > 0 else z


def recompute_tip_frequencies(
    tip_dates: dict[str, float],
    narrow_bandwidth: float = 1 / 12,
    wide_bandwidth: float = 3 / 12,
    proportion_wide: float = 0.2,
    pivot_interval_months: int = 1,
    pivot_interval_days: int | None = None,
):
    """KDE tip frequencies in the manner of `augur frequencies --method kde`.

    Each tip contributes a mixture of a narrow and a wide Gaussian centred on
    its collection date, normalised to sum to 1 over pivots; values are then
    normalised across tips at each pivot.
    """
    dates = np.asarray(list(tip_dates.values()), dtype=float)
    if pivot_interval_days:  # e.g. weekly pivots, as the seasonal-flu builds use
        import datetime as _dt
        d0 = from_decimal(dates.min())
        n = int((from_decimal(dates.max()) - d0).days // pivot_interval_days) + 2
        pivots = np.asarray([to_decimal(d0 + _dt.timedelta(days=pivot_interval_days * i)) for i in range(n)])
    else:
        pivots = make_pivots(dates.min(), dates.max(), pivot_interval_months)
    dens = np.vstack(
        [
            (1 - proportion_wide) * _density(mu, pivots, narrow_bandwidth)
            + proportion_wide * _density(mu, pivots, wide_bandwidth)
            for mu in dates
        ]
    )
    col = dens.sum(axis=0)
    col[col == 0] = 1
    freq = dens / col
    return pivots, {t: freq[i] for i, t in enumerate(tip_dates)}


def pivot_bins(pivots: np.ndarray, num_date: float | None) -> int | None:
    """Index of the pivot whose midpoint-to-midpoint interval contains the date.
    Dates outside the first/last half-interval are not binned."""
    if num_date is None or len(pivots) == 0:
        return None
    edges = np.concatenate(
        [
            [pivots[0] - (pivots[1] - pivots[0]) / 2],
            (pivots[:-1] + pivots[1:]) / 2,
            [pivots[-1] + (pivots[-1] - pivots[-2]) / 2],
        ]
    )
    if num_date < edges[0] or num_date >= edges[-1]:
        return None
    return int(np.searchsorted(edges, num_date, side="right") - 1)


def pivot_table_rows(build_id: str, pivots: np.ndarray, projection: float | None):
    from .dates import month_key

    rows = []
    for i, p in enumerate(pivots):
        d: dt.date = from_decimal(float(p))
        rows.append(
            {
                "build_id": build_id,
                "pivot_idx": i,
                "num_date": float(p),
                "date": d,
                "month": month_key(float(p)),
                "is_projection": bool(projection is not None and p > projection),
            }
        )
    return rows
