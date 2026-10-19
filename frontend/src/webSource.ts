// Data source for the public website: builds are fetched live from nextstrain.org
// in the visitor's browser and processed by the in-browser engine.
//
// PRIVACY: only PUBLIC datasets are ever requested. Every URL is checked against
// PUBLIC_PREFIXES before fetching; the lab's private Nextstrain group is never
// contacted, and no credentials or cookies are ever sent.
import { parseBuild, type Build, type BuildSpec } from "./engine/build";
import { BrowserEngine, type CompareReq } from "./engine/engine";
import CONFIG from "./engine/web-config.json";

const ORIGIN = CONFIG.nextstrain_origin;
export const PUBLIC_PREFIXES = [`${CONFIG.global.prefix}/`, `${CONFIG.local.prefix}/`];
const MEDIA = {
  main: "application/vnd.nextstrain.dataset.main+json",
  freq: "application/vnd.nextstrain.dataset.tip-frequencies+json",
  root: "application/vnd.nextstrain.dataset.root-sequence+json",
};

export function assertPublic(path: string) {
  if (!PUBLIC_PREFIXES.some((p) => path.startsWith(p)) || path.includes("..")) {
    throw new Error(`Refusing to fetch '${path}': the website only reads public Nextstrain datasets.`);
  }
}

export type Progress = { label: string; bytes: number } | null;
let progressListener: (p: Progress) => void = () => undefined;
export const onProgress = (fn: (p: Progress) => void) => (progressListener = fn);

async function fetchJson(path: string, accept: string, label: string, optional = false): Promise<any | null> {
  assertPublic(path);
  const res = await fetch(`${ORIGIN}/${path}`, {
    headers: { Accept: accept }, // CORS-safelisted header: no preflight needed
    credentials: "omit", // never send nextstrain.org cookies
    mode: "cors",
  });
  if (!res.ok) {
    if (optional) return null;
    if (res.status === 404) throw new Error(`${label} is not available on nextstrain.org (${path}).`);
    throw new Error(`${label}: nextstrain.org returned ${res.status}.`);
  }
  if (!res.body) return res.json();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    bytes += value.length;
    progressListener({ label, bytes });
  }
  const buf = new Uint8Array(bytes);
  let o = 0;
  for (const c of chunks) {
    buf.set(c, o);
    o += c.length;
  }
  return JSON.parse(new TextDecoder().decode(buf));
}

// ---- catalog of public builds (from web-config.json)
const RES_LABEL = (r: string) => r;
export const CATALOG: BuildSpec[] = (() => {
  const out: BuildSpec[] = [];
  for (const st of CONFIG.subtypes)
    for (const seg of CONFIG.segments) {
      if (!CONFIG.enabled_segments.includes(seg)) continue;
      out.push({
        id: `public_jhh_${st.id}_${seg.toLowerCase()}`,
        source_type: "local",
        organization: CONFIG.local.organization,
        subtype: st.id,
        segment: seg,
        resolution: null,
        label: `JHH ${st.label} ${seg} (public build)`,
        remote: `${CONFIG.local.prefix}/${st.local}/${seg.toLowerCase()}`,
      });
      for (const res of CONFIG.global.resolutions)
        out.push({
          id: `nextstrain_${st.id}_${seg.toLowerCase()}_${res}`,
          source_type: "global",
          organization: CONFIG.global.organization,
          subtype: st.id,
          segment: seg,
          resolution: res,
          label: `Nextstrain seasonal-flu ${st.label} ${seg} (${RES_LABEL(res)})`,
          remote: `${CONFIG.global.prefix}/${st.global}/${seg.toLowerCase()}/${res}`,
        });
    }
  for (const s of out) assertPublic(s.remote);
  return out;
})();

const engine = new BrowserEngine();
const loading = new Map<string, Promise<Build>>();

export function load(id: string): Promise<Build> {
  if (!loading.has(id)) {
    const spec = CATALOG.find((s) => s.id === id);
    if (!spec) return Promise.reject(new Error(`Unknown build ${id}`));
    const p = (async () => {
      const name = spec.source_type === "local" ? "JHH public build" : `Nextstrain ${spec.resolution} build`;
      const main = await fetchJson(spec.remote, MEDIA.main, `${name} (${spec.subtype} ${spec.segment})`);
      const freq = await fetchJson(spec.remote, MEDIA.freq, `${name} frequencies`, true);
      const root = await fetchJson(spec.remote, MEDIA.root, `${name} root sequence`, true);
      progressListener(null);
      const b = parseBuild(spec, main, freq, root);
      engine.add(b);
      return b;
    })();
    p.catch(() => loading.delete(id)); // allow a retry
    loading.set(id, p);
  }
  return loading.get(id)!;
}

const NA = CONFIG.text.not_available;

export function options() {
  const builds = CATALOG.map((s) => {
    const b = engine.builds.get(s.id);
    return {
      build_id: s.id,
      source_type: s.source_type,
      label: s.label,
      organization: s.organization,
      subtype: s.subtype,
      segment: s.segment,
      resolution: s.resolution,
      updated_date: b ? b.meta.updated ?? NA : "loads when selected",
      build_date: NA,
      most_recent_sample_date: b ? b.maxSample ?? NA : "–",
      min_sample_date: b ? b.minSample ?? NA : "–",
      source_file: `nextstrain.org/${s.remote}`,
      remote: `https://nextstrain.org/${s.remote}`,
      fetched_at: b ? b.loadedAt : null,
      total_tip_count: b ? b.tips.length : 0,
      downsampling: s.source_type === "local" ? CONFIG.text.local_downsampling : CONFIG.text.global_downsampling,
      frequency_source: b?.freqSource ?? "",
      warnings: b?.warnings ?? [],
      synthetic: false,
      loaded: !!b,
    };
  });
  const pairs = CATALOG.filter((l) => l.source_type === "local").flatMap((l) =>
    CATALOG.filter((g) => g.source_type === "global" && g.subtype === l.subtype && g.segment === l.segment).map((g) => ({ local: l.id, global: g.id })),
  );
  return {
    subtypes: CONFIG.subtypes.map((s) => ({ id: s.id, label: s.label })),
    enabled_segments: CONFIG.enabled_segments,
    builds,
    pairs,
    default_top_n: CONFIG.default_top_n,
    default_palette: CONFIG.default_palette,
    store: { built_at: "live from nextstrain.org", app_version: "web" },
    text: CONFIG.text,
  };
}

export async function fields(id: string) {
  await load(id);
  return engine.fields(id);
}

export async function genotypeOptions(l: string, g: string) {
  await Promise.all([load(l), load(g)]);
  return engine.genotypeOptions(l, g);
}

export async function sharedFilters(l: string, g: string) {
  await Promise.all([load(l), load(g)]);
  return engine.sharedFilters(l, g);
}

export async function compare(req: CompareReq) {
  await Promise.all([load(req.local_build_id), load(req.global_build_id)]);
  // yield so the loading state can paint before the synchronous computation
  await new Promise((r) => setTimeout(r, 0));
  return JSON.parse(JSON.stringify(engine.compare(req)));
}
