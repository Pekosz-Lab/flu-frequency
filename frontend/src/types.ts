export type SourceType = "local" | "global";
export type Grouping = "clade" | "subclade" | "genotype";
export type View = "stacked" | "overlay" | "difference";

export interface BuildInfo {
  build_id: string;
  source_type: SourceType;
  label: string;
  organization: string;
  subtype: string;
  segment: string;
  resolution: string | null;
  updated_date: string;
  build_date: string;
  most_recent_sample_date: string;
  min_sample_date: string;
  source_file: string;
  remote: string | null;
  fetched_at: string | null;
  total_tip_count: number;
  downsampling: string;
  frequency_source: string;
  warnings: string[];
  synthetic: boolean;
}

export interface Options {
  subtypes: { id: string; label: string }[];
  enabled_segments: string[];
  builds: BuildInfo[];
  pairs: { local: string; global: string }[];
  default_top_n: number;
  default_palette: "nextstrain" | "colorblind";
  store: Record<string, string>;
  text: Record<string, any>;
}

export interface FieldInfo {
  field_name: string;
  field_title: string;
  field_type: string;
  allowed_values: { value: string; count: number }[];
  n_tips_with_value: number;
  source_location_in_json: string;
}

export interface GenotypeOptions {
  genes: { gene: string; label: string; seq_type: string; available: boolean; coordinates_match: boolean; note: string | null }[];
  positions: Record<
    string,
    { position: number; variable_in_local: boolean; variable_in_global: boolean; local_nonroot: number | null; global_nonroot: number | null }[]
  >;
}

export type Filters = Record<string, string[]>;

export interface SharedFilterDef {
  id: string;
  label: string;
  local_field: string;
  global_field: string;
  matched_by: string;
  n_shared_values: number;
  values: { value: string; local_count: number; global_count: number; in_both: boolean }[];
}

export interface SharedFilterOptions {
  available: SharedFilterDef[];
  unavailable: { id: string; label: string; reason: string }[];
}

export interface Selection {
  subtype: string;
  segment: string;
  localId: string;
  globalId: string;
  grouping: Grouping;
  gene: string;
  positions: number[];
  localFilters: Filters;
  globalFilters: Filters;
  sharedFilters: Filters;
  start: string | null;
  end: string | null;
  topN: number;
  palette: "nextstrain" | "colorblind";
  view: View;
  snapshotMode: "range" | "point";
  snapshotTime: string | null;
  includeProjection: boolean;
  timeAxis: "aligned" | "native";
}

export interface SeriesPayload {
  build_id: string;
  dates: string[];
  months: string[];
  denominator: number[];
  series: Record<string, { frequency: (number | null)[]; numerator: number[] }>;
  tips_included: number;
  tips_total: number;
  served_from: string;
  notes: string[];
}

export interface ProvValue {
  value: any;
  source: string;
}

export interface AlignedSide {
  present: boolean[];
  pivot_dates: (string | null)[];
  offset_days: (number | null)[];
  denominator: (number | null)[];
  series: Record<string, { frequency: (number | null)[]; numerator: (number | null)[] }>;
}

export interface CompareResult {
  local: SeriesPayload;
  global: SeriesPayload;
  aligned: { dates: string[]; local: AlignedSide | null; global: AlignedSide | null };
  alignment: {
    reference: "local" | "global" | null;
    step: string;
    step_days: number;
    local_spacing_days: number | null;
    global_spacing_days: number | null;
    max_offset_days: { local: number | null; global: number | null };
  };
  color_info: { palette: string; official_source: string; key?: string; by_source?: Record<string, string[]> };
  notes: string[];
  taxa: string[];
  colors: Record<string, string>;
  grouped_into_other: string[];
  difference: {
    dates: string[];
    series: Record<string, { difference_pp: (number | null)[]; local: (number | null)[]; global: (number | null)[]; local_n: (number | null)[]; global_n: (number | null)[] }>;
    method?: string;
  };
  snapshot: {
    mode: string;
    label: string | null;
    timepoints: string[];
    rows: {
      taxon: string;
      local_frequency: number;
      global_frequency: number;
      difference_pp: number | null;
      local_n: number;
      global_n: number;
      local_denominator: number;
      global_denominator: number;
      presence: string;
    }[];
  };
  date_ranges: {
    local: [string, string] | null;
    global: [string, string] | null;
    shared: [string, string] | null;
    selected: [string | null, string | null];
    selection_has_both: boolean;
  };
  timepoints: { local: string[]; global: string[]; shared: string[] };
  harmonization: { version: number; applied: { source: string; from: string; to: string }[] };
  provenance: {
    local: Record<string, any>;
    global: Record<string, any>;
    comparison: Record<string, any>;
  };
}
