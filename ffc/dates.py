"""Decimal-year <-> calendar date conversion, matching augur's convention.

augur: numeric_date(d) = year + (day_of_year - 0.5) / days_in_year
"""

from __future__ import annotations

import calendar
import datetime as dt
import math


def days_in_year(year: int) -> int:
    return 366 if calendar.isleap(year) else 365


def to_decimal(d: dt.date) -> float:
    return d.year + (d.timetuple().tm_yday - 0.5) / days_in_year(d.year)


def from_decimal(x: float) -> dt.date:
    year = int(math.floor(x))
    n = days_in_year(year)
    # inverse of (doy - 0.5)/n, 1-based; round() absorbs the 4-decimal rounding
    # augur applies to pivots, so a pivot generated on the 1st stays on the 1st
    doy = int(round((x - year) * n + 0.5))
    doy = min(max(doy, 1), n)
    return dt.date(year, 1, 1) + dt.timedelta(days=doy - 1)


def month_key(x: float) -> str:
    d = from_decimal(x)
    return f"{d.year:04d}-{d.month:02d}"


def month_start(d: dt.date) -> dt.date:
    return dt.date(d.year, d.month, 1)


def add_months(d: dt.date, n: int) -> dt.date:
    m = d.month - 1 + n
    return dt.date(d.year + m // 12, m % 12 + 1, 1)


def parse_iso(s: str | None) -> dt.date | None:
    if not s:
        return None
    return dt.date.fromisoformat(str(s)[:10])
