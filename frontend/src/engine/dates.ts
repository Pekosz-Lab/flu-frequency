// Decimal-year <-> calendar date, same convention as augur and ffc/dates.py:
// numeric_date(d) = year + (day_of_year - 0.5) / days_in_year
export const DAY_MS = 86_400_000;

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const daysInYear = (y: number) => (isLeap(y) ? 366 : 365);

/** UTC midnight ms of a decimal year. */
export function decimalToMs(x: number): number {
  const year = Math.floor(x);
  const n = daysInYear(year);
  let doy = Math.round((x - year) * n + 0.5);
  doy = Math.min(Math.max(doy, 1), n);
  return Date.UTC(year, 0, 1) + (doy - 1) * DAY_MS;
}

export function msToDecimal(ms: number): number {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const doy = Math.round((ms - Date.UTC(y, 0, 1)) / DAY_MS) + 1;
  return y + (doy - 0.5) / daysInYear(y);
}

export const isoOfMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const isoOfDecimal = (x: number) => isoOfMs(decimalToMs(x));
export const monthOfDecimal = (x: number) => isoOfDecimal(x).slice(0, 7);
export const msOfIso = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));

/** pandas DateOffset(months=k): same day of month, clamped to the month's end. */
export function addMonthsClamped(ms: number, k: number): number {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + k;
  const ty = y + Math.floor(m / 12);
  const tm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return Date.UTC(ty, tm, Math.min(d.getUTCDate(), last));
}

/** Monthly pivots from the month of the earliest date to the month after the latest (ffc make_pivots). */
export function makeMonthlyPivots(minDec: number, maxDec: number, interval = 1): number[] {
  const a = new Date(decimalToMs(minDec));
  const b = new Date(decimalToMs(maxDec));
  let cur = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), 1);
  const end = Date.UTC(b.getUTCFullYear(), b.getUTCMonth() + 1, 1);
  const out: number[] = [];
  while (cur <= end) {
    out.push(msToDecimal(cur));
    const d = new Date(cur);
    cur = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + interval, 1);
  }
  return out;
}
