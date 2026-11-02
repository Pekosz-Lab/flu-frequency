import type { CompareResult, RangeMode } from "./types";

export function minusMonths(iso: string, n: number) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}

/** The start/end a range mode asks for, given the data each build has (after filters).
 *  Returns null for "custom" (dates chosen by hand are kept as they are). */
export function targetRange(mode: RangeMode, dr: CompareResult["date_ranges"]): [string | null, string | null] | null {
  if (mode === "custom") return null;
  const sh = dr.shared;
  if (mode === "all" || !sh) return [null, null]; // no overlap: show everything there is
  if (mode === "overlap") return [sh[0], sh[1]];
  const s = minusMonths(sh[1], mode);
  return [s > sh[0] ? s : sh[0], sh[1]];
}
