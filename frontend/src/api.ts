import type { CompareResult, FieldInfo, GenotypeOptions, Options, Selection, SharedFilterOptions, View } from "./types";
import * as web from "./webSource";
import { webDownload } from "./webExports";

/** true in the public website build (`npm run build:web`): data comes from public nextstrain.org datasets
 *  and is processed in the browser. false in the local app, which talks to `ffc serve`. */
export const IS_WEB = import.meta.env.VITE_TARGET === "web";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.detail) msg = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const getOptions = (): Promise<Options> =>
  IS_WEB ? Promise.resolve(web.options() as unknown as Options) : fetch("/api/options").then((r) => json<Options>(r));
export const getFields = (id: string): Promise<FieldInfo[]> =>
  IS_WEB ? web.fields(id) : fetch(`/api/builds/${encodeURIComponent(id)}/fields`).then((r) => json<FieldInfo[]>(r));
export const getGenotypeOptions = (local: string, global: string): Promise<GenotypeOptions> =>
  IS_WEB ? web.genotypeOptions(local, global) : fetch(`/api/genotype-options?local=${encodeURIComponent(local)}&global=${encodeURIComponent(global)}`).then((r) =>
    json<GenotypeOptions>(r),
  );

export const getSharedFilters = (local: string, global: string): Promise<SharedFilterOptions> =>
  IS_WEB ? web.sharedFilters(local, global) : fetch(`/api/shared-filters?local=${encodeURIComponent(local)}&global=${encodeURIComponent(global)}`).then((r) =>
    json<SharedFilterOptions>(r),
  );

export function requestBody(sel: Selection) {
  return {
    local_build_id: sel.localId,
    global_build_id: sel.globalId,
    grouping: sel.grouping,
    genotype: sel.grouping === "genotype" ? { gene: sel.gene, positions: sel.positions } : null,
    local_filters: sel.localFilters,
    global_filters: sel.globalFilters,
    shared_filters: sel.sharedFilters,
    start: sel.start,
    end: sel.end,
    top_n: sel.topN,
    snapshot: { mode: sel.snapshotMode, timepoint: sel.snapshotTime },
    palette: sel.palette,
    include_projection: sel.includeProjection,
  };
}

export const compare = (sel: Selection, signal?: AbortSignal): Promise<CompareResult> =>
  IS_WEB ? web.compare(requestBody(sel) as any) : fetch("/api/compare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody(sel)),
    signal,
  }).then((r) => json<CompareResult>(r));

export async function download(path: string, sel: Selection, view: View, result: CompareResult | null = null) {
  if (IS_WEB) return webDownload(path, sel, view, result);
  const res = await fetch(`/api/export/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...requestBody(sel), view, time_axis: sel.timeAxis }),
  });
  if (!res.ok) throw new Error(`Export failed: ${res.status}`);
  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition") || "";
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? "export";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
