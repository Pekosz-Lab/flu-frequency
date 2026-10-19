// Port of ffc/colors.py: colours as nextstrain.org (Auspice) shows them.
import { AUSPICE_CATEGORICAL } from "./auspicePalette";

export const UNKNOWN_COLOR = "#ADB1B3";
const GREY_RANGE: [string, string] = ["#BDC3C6", "#868992"];
export const INVALID_STRINGS = new Set(["unknown", "?", "nan", "na", "n/a", "", "unassigned"]);

export function isValidValue(v: unknown): boolean {
  if (typeof v === "boolean" || typeof v === "number") return true;
  return typeof v === "string" && !INVALID_STRINGS.has(v.toLowerCase());
}

export function naturalCompare(a: string, b: string): number {
  const ta = String(a).split(/(\d+)/);
  const tb = String(b).split(/(\d+)/);
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
    const x = ta[i], y = tb[i];
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (+x !== +y) return +x - +y;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return ta.length - tb.length;
}

export function auspiceCategorical(domain: string[]): Record<string, string> {
  const n = domain.length;
  if (!n) return {};
  const pal = n < AUSPICE_CATEGORICAL.length ? AUSPICE_CATEGORICAL[n] : AUSPICE_CATEGORICAL[AUSPICE_CATEGORICAL.length - 1];
  return Object.fromEntries(domain.map((v, i) => [v, pal[i % pal.length]]));
}

export function auspiceSortedDomain(key: string, counts: Map<string, number>): string[] {
  const vals = [...counts.keys()].filter(isValidValue);
  if (key === "clade_membership") return vals.sort();
  return vals.sort((a, b) => counts.get(b)! - counts.get(a)! || (a < b ? -1 : a > b ? 1 : 0));
}

// grey ramp identical to Auspice / d3 (Lab/HCL, interpolateHcl)
const Xn = 0.96422, Yn = 1.0, Zn = 0.82521;
const t0 = 4 / 29, t1 = 6 / 29, t2 = 3 * t1 * t1, t3 = t1 ** 3;
const rgb2lrgb = (x: number) => ((x /= 255) <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
const lrgb2rgb = (x: number) => 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
const xyz2lab = (t: number) => (t > t3 ? Math.cbrt(t) : t / t2 + t0);
const lab2xyz = (t: number) => (t > t1 ? t ** 3 : t2 * (t - t0));

function hex2hcl(h: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => rgb2lrgb(parseInt(h.slice(i, i + 2), 16)));
  const y = xyz2lab((0.2225045 * r + 0.7168786 * g + 0.0606169 * b) / Yn);
  let x: number, z: number;
  if (r === g && g === b) x = z = y;
  else {
    x = xyz2lab((0.4360747 * r + 0.3850649 * g + 0.1430804 * b) / Xn);
    z = xyz2lab((0.0139322 * r + 0.0971045 * g + 0.7141733 * b) / Zn);
  }
  const L = 116 * y - 16, A = 500 * (x - y), B = 200 * (y - z);
  return [((Math.atan2(B, A) * 180) / Math.PI + 360) % 360, Math.hypot(A, B), L];
}

function hcl2hex(hue: number, c: number, L: number): string {
  const a = Math.cos((hue * Math.PI) / 180) * c, b = Math.sin((hue * Math.PI) / 180) * c;
  let y = (L + 16) / 116;
  let x = y + a / 500, z = y - b / 200;
  x = Xn * lab2xyz(x); y = Yn * lab2xyz(y); z = Zn * lab2xyz(z);
  const rgb = [
    lrgb2rgb(3.1338561 * x - 1.6168667 * y - 0.4906146 * z),
    lrgb2rgb(-0.9787684 * x + 1.9161415 * y + 0.033454 * z),
    lrgb2rgb(0.0719453 * x - 0.2289914 * y + 1.4052427 * z),
  ];
  return "#" + rgb.map((v) => Math.max(0, Math.min(255, Math.floor(v + 0.5))).toString(16).toUpperCase().padStart(2, "0")).join("");
}

export function greyRamp(n: number): string[] {
  if (n <= 0) return [];
  const [h0, c0, l0] = hex2hcl(GREY_RANGE[0]);
  const [h1, c1, l1] = hex2hcl(GREY_RANGE[1]);
  let dh = h1 - h0;
  if (dh > 180 || dh < -180) dh -= 360 * Math.round(dh / 360);
  return Array.from({ length: n }, (_, i) => {
    const t = i / n;
    return hcl2hex(h0 + dh * t, c0 + (c1 - c0) * t, l0 + (l1 - l0) * t);
  });
}

/** Port of ffc.colors.national_colors. */
export function nationalColors(
  taxa: string[],
  key: string | null,
  officialScale: [string, string][],
  globalTreeValues: [string, number][],
  localScale: Record<string, string>,
): [Record<string, string>, Record<string, string>] {
  const colors: Record<string, string> = {};
  const source: Record<string, string> = {};
  if (officialScale.length) {
    for (const [v, c] of officialScale) {
      if (!(v in colors)) {
        colors[v] = c.toUpperCase();
        source[v] = "official scale";
      }
    }
    const extras = globalTreeValues.map(([v]) => v).filter((v) => !(v in colors) && isValidValue(v));
    greyRamp(extras.length).forEach((c, i) => {
      colors[extras[i]] = c;
      source[extras[i]] = "grey (not in official scale)";
    });
  } else if (globalTreeValues.length) {
    const dom = auspiceSortedDomain(key ?? "", new Map(globalTreeValues));
    for (const [v, c] of Object.entries(auspiceCategorical(dom))) {
      colors[v] = c;
      source[v] = "Auspice default palette";
    }
  }
  const leftover: string[] = [];
  for (const t of taxa) {
    if (t in colors) continue;
    if (t in localScale) {
      colors[t] = localScale[t].toUpperCase();
      source[t] = "local build scale (not in national build)";
    } else leftover.push(t);
  }
  leftover.sort(naturalCompare);
  greyRamp(leftover.length).forEach((c, i) => {
    colors[leftover[i]] = c;
    source[leftover[i]] = "grey (not in national build)";
  });
  return [colors, source];
}
