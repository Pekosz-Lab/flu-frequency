// Compare the browser engine with the Python engine's golden results.
import { readFileSync, existsSync } from "node:fs";
import { parseBuild } from "../../frontend/src/engine/build";
import { BrowserEngine } from "../../frontend/src/engine/engine";

const golden = JSON.parse(readFileSync(process.argv[2], "utf8"));
const eng = new BrowserEngine();
for (const b of Object.values<any>(golden.builds)) {
  const rd = (p: string) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
  eng.add(parseBuild(b.spec, rd(b.main), rd(b.freq), rd(b.root)));
}
const SKIP = new Set(["provenance", "served_from", "official_source", "method", "local_title", "global_title"]);
let diffs: string[] = [];
function eq(a: any, b: any, path: string) {
  if (diffs.length > 25) return;
  if (typeof a === "number" && typeof b === "number") {
    if (Math.abs(a - b) > 2e-6 * Math.max(1, Math.abs(a))) diffs.push(`${path}: python ${a} vs browser ${b}`);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return void diffs.push(`${path}: length ${a.length} vs ${b.length}`);
    a.forEach((x, i) => eq(x, b[i], `${path}[${i}]`));
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (SKIP.has(k)) continue;
      if (!(k in b)) diffs.push(`${path}.${k}: missing in browser`);
      else if (!(k in a)) diffs.push(`${path}.${k}: extra in browser`);
      else eq(a[k], b[k], `${path}.${k}`);
    }
    return;
  }
  if (a !== b) diffs.push(`${path}: python ${JSON.stringify(a)} vs browser ${JSON.stringify(b)}`);
}
let n = 0;
for (const c of golden.cases) {
  const before = diffs.length;
  let got: any, label: string;
  if (c.req) {
    got = JSON.parse(JSON.stringify(eng.compare(c.req)));
    label = JSON.stringify(c.req);
  } else if (c.genotype_options) {
    got = eng.genotypeOptions(c.genotype_options[0], c.genotype_options[1]);
    label = "genotype_options " + c.genotype_options;
  } else if (c.shared_filters) {
    got = eng.sharedFilters(c.shared_filters[0], c.shared_filters[1]);
    label = "shared_filters " + c.shared_filters;
  } else {
    got = eng.fields(c.fields);
    label = "fields " + c.fields;
  }
  eq(c.result, JSON.parse(JSON.stringify(got)), "");
  if (diffs.length > before) diffs.splice(before, 0, `--- ${label}`);
  n++;
}
if (diffs.length) {
  console.log(diffs.slice(0, 40).join("\n"));
  console.log(`PARITY FAILED (${n} cases)`);
  process.exit(1);
}
console.log(`PARITY OK: ${n} cases identical between Python and browser engines`);
