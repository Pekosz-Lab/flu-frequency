"""Fixed wording, subtype/segment vocabularies and other constants.

The caveat text here is shown in the dashboard, in every export and in the
methodology panel. Change it in one place only: here.
"""

NOT_AVAILABLE = "Not available in source JSON"

CAVEAT_MAIN = (
    "Frequencies displayed in this dashboard represent taxa present in the supplied "
    "JHH local phylogeny builds and supplied Nextstrain seasonal-flu surveillance builds. "
    "They do not necessarily represent true circulating prevalence, complete regional "
    "prevalence, or all influenza sequences available in GISAID."
)

CAVEAT_POINTS = [
    "JHH local datasets are not downsampled; they include all sequences included in the supplied local build.",
    "Nextstrain seasonal-flu global datasets are downsampled according to the methodology used to create the supplied seasonal-flu build.",
    "Comparisons represent differences in the composition of the analyzed local and global datasets.",
    "The global dataset should not be interpreted as an unbiased representation of all globally circulating influenza viruses.",
    "All dates, update times, metadata, and provenance values are extracted from the input JSON files where possible.",
    f"If a provenance field is absent from a JSON file it is shown as “{NOT_AVAILABLE}” rather than inferred.",
]

LOCAL_DOWNSAMPLING = "Not downsampled: includes all sequences included in this JHH build."
GLOBAL_DOWNSAMPLING = (
    "Downsampled according to the methodology used to generate this Nextstrain seasonal-flu build."
)

FIGURE_FOOTNOTE = (
    "Local frequencies reflect taxa represented in the selected JHH local Nextstrain build and "
    "include all sequences in that build. Global frequencies reflect taxa represented in the "
    "selected Nextstrain seasonal-flu build, which may be downsampled according to its source "
    "pipeline. These frequencies compare the composition of the analyzed datasets and should not "
    "be interpreted as unbiased estimates of all circulating influenza viruses or all GISAID "
    "submissions."
)

LOCAL_DATASET_NAME = "JHH local surveillance"
GLOBAL_DATASET_NAME = "Nextstrain seasonal-flu global surveillance"

POSITIVE_LABEL = "Higher relative frequency in JHH local surveillance"
NEGATIVE_LABEL = "Higher relative frequency in Nextstrain global surveillance"

# Canonical subtype ids -> display names. Aliases are accepted in manifests.
SUBTYPES = {
    "h1n1pdm": "A/H1N1pdm",
    "h3n2": "A/H3N2",
    "vic": "B/Victoria",
}
SUBTYPE_ALIASES = {
    "h1": "h1n1pdm", "h1n1": "h1n1pdm", "h1n1pdm": "h1n1pdm", "a/h1n1pdm": "h1n1pdm",
    "h3": "h3n2", "h3n2": "h3n2", "a/h3n2": "h3n2",
    "vic": "vic", "b/vic": "vic", "bvic": "vic", "b/victoria": "vic", "victoria": "vic",
}

# Every influenza segment the schema understands. Which ones are exposed in
# the UI is decided by config/settings.yaml (enabled_segments).
ALL_SEGMENTS = ["PB2", "PB1", "PA", "HA", "NP", "NA", "MP", "NS", "GENOME"]

GROUPINGS = ["clade", "subclade", "genotype"]

FREQ_SOURCE_LABELS = {
    "imported": "Imported frequency JSON",
    "embedded": "Embedded frequency data",
    "recomputed": "Recomputed from Auspice JSON",
}

ALIGNMENT_METHOD = (
    "Shared timepoints: both builds are shown at one set of timepoints, so the local and global "
    "panels line up exactly. The timepoints are the frequency pivots of the build with the coarser "
    "pivot spacing (e.g. the monthly JHH pivots when the seasonal-flu build has weekly pivots), "
    "extended at the same spacing over the other build's dates. At each timepoint the other build's "
    "value is taken from its nearest pivot, only if that pivot is within half of its own pivot spacing "
    "(about 3.5 days for weekly pivots); the pivot used and its offset are shown on hover. No "
    "interpolation or averaging is done. 'Native pivots' shows each build at its own pivots instead."
)

COUNT_METHOD = (
    "Counts (N) are the number of tips in the build whose collection date falls in the interval "
    "around each timepoint (midpoint to midpoint between timepoints). Frequencies themselves are the "
    "KDE-smoothed tip frequencies used by Auspice, so frequency is not exactly numerator/denominator."
)


def canonical_subtype(value: str) -> str:
    key = str(value).strip().lower()
    if key in SUBTYPE_ALIASES:
        return SUBTYPE_ALIASES[key]
    raise ValueError(f"Unknown subtype '{value}'. Known: {sorted(set(SUBTYPE_ALIASES))}")


def canonical_segment(value: str) -> str:
    seg = str(value).strip().upper()
    if seg not in ALL_SEGMENTS:
        raise ValueError(f"Unknown segment '{value}'. Known: {ALL_SEGMENTS}")
    return seg
