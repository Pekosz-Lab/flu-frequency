"""Publication figures (PNG/SVG/PDF), tabular exports and the report.

Every figure carries: title, subtype, segment, local and global build labels
and dates, selected date range, local and global filters, grouping variable,
genotype definition, frequency source, data refresh date and the caveat
footnote.
"""

from __future__ import annotations

import datetime as dt
import html
import io
import json
import textwrap

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402
import pandas as pd  # noqa: E402

from .constants import (  # noqa: E402
    ALIGNMENT_METHOD,
    CAVEAT_MAIN,
    CAVEAT_POINTS,
    COUNT_METHOD,
    FIGURE_FOOTNOTE,
    NEGATIVE_LABEL,
    POSITIVE_LABEL,
)

GROUPING_LABEL = {"clade": "Clade", "subclade": "Subclade", "genotype": "Genotype"}
VIEW_LABEL = {"stacked": "Local and global panels", "overlay": "Overlay", "difference": "Difference (local - global)"}


def _v(p: dict, key: str):
    x = p.get(key, {})
    return x.get("value") if isinstance(x, dict) else x


def _filters_text(f: dict | None) -> str:
    if not f:
        return "none"
    return "; ".join(f"{k} = {', '.join(map(str, v))}" for k, v in sorted(f.items()) if v) or "none"


def metadata_lines(result: dict, req: dict) -> list[str]:
    pl, pg, pc = result["provenance"]["local"], result["provenance"]["global"], result["provenance"]["comparison"]
    sel = result["date_ranges"]["selected"]
    sel_txt = f"{sel[0] or 'start of data'} to {sel[1] or 'end of data'}"
    geno = pc.get("genotype_definition")
    lines = [
        f"Subtype: {_v(pl, 'subtype')}   Segment: {_v(pl, 'segment')}   Grouping: "
        f"{GROUPING_LABEL.get(pc['grouping'], pc['grouping'])}" + (f" ({geno})" if geno else "")
        + f"   Date range: {sel_txt}",
        f"Local: {_v(pl, 'build_label')} [{_v(pl, 'build_id')}], JSON updated {_v(pl, 'updated_date')}, "
        f"latest sample {_v(pl, 'most_recent_sample_date')}, tips {_v(pl, 'tips_after_filtering')}/{_v(pl, 'total_tips')}, "
        f"frequencies: {_v(pl, 'frequency_source')}. Local-only filters: {_filters_text(req.get('local_filters'))}",
        f"Global: {_v(pg, 'build_label')} [{_v(pg, 'build_id')}], JSON updated {_v(pg, 'updated_date')}, "
        f"latest sample {_v(pg, 'most_recent_sample_date')}, tips {_v(pg, 'tips_after_filtering')}/{_v(pg, 'total_tips')}, "
        f"frequencies: {_v(pg, 'frequency_source')}. Global-only filters: {_filters_text(req.get('global_filters'))}",
        f"Data processed {pc.get('data_processing_timestamp')}; dashboard data refreshed "
        f"{pc.get('dashboard_refresh_timestamp')}; figure generated "
        f"{dt.datetime.now().astimezone().isoformat(timespec='seconds')}.",
    ]
    sf = pc.get("shared_filters") or []
    if sf:
        lines.insert(1, "Filters on both datasets: " + "; ".join(
            f"{x['label']} = {', '.join(x['values'])} (local '{x['local_field']}', global '{x['global_field']}')" for x in sf))
    al = pc.get("alignment_detail")
    if al:
        lines.append("Time alignment: " + al)
    if pc.get("colours"):
        lines.append("Colours: " + str(pc["colours"]))
    if result["harmonization"]["applied"]:
        lines.append(
            "Taxon harmonization v{}: ".format(result["harmonization"]["version"])
            + "; ".join(f"{m['source']} {m['from']}->{m['to']}" for m in result["harmonization"]["applied"])
        )
    if result.get("grouped_into_other"):
        lines.append(f"'Other' groups {len(result['grouped_into_other'])} less frequent taxa.")
    return lines


def _dates(xs):
    return pd.to_datetime(xs)


def _side_xy(result: dict, side: str, time_axis: str):
    """(dates, {taxon: values}) for one build: shared timepoints (default) or native pivots."""
    if time_axis == "native":
        s = result[side]
        return _dates(s["dates"]), {t: [v or 0 for v in ser["frequency"]] for t, ser in s["series"].items()}
    al = result["aligned"]
    if not al.get("dates") or not al.get(side):
        return _dates([]), {}
    keep = [i for i, p in enumerate(al[side]["present"]) if p]
    x = _dates([al["dates"][i] for i in keep])
    return x, {t: [ser["frequency"][i] or 0 for i in keep] for t, ser in al[side]["series"].items()}


def render_figure(result: dict, req: dict, view: str, fmt: str, title: str | None = None,
                  time_axis: str = "aligned") -> bytes:
    colors = result["colors"]
    taxa = result["taxa"]
    pl = result["provenance"]["local"]
    grouping = GROUPING_LABEL.get(result["provenance"]["comparison"]["grouping"], "")
    title = title or f"{_v(pl, 'subtype')} {_v(pl, 'segment')} {grouping.lower()} frequencies: JHH local vs Nextstrain global"
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 9, "axes.spines.top": False,
                         "axes.spines.right": False, "svg.fonttype": "none", "pdf.fonttype": 42})
    fig = plt.figure(figsize=(11, 8.5))
    top, bottom = 0.86, 0.30
    native = time_axis == "native"
    xs = {side: _side_xy(result, side, time_axis) for side in ("local", "global")}
    all_x = [d for x, _ in xs.values() for d in x]
    if result.get("aligned", {}).get("dates") and not native:
        span = _dates(result["aligned"]["dates"])
        xlim = (span.min(), span.max())
    else:
        xlim = (min(all_x), max(all_x)) if all_x else None
    if view == "stacked":
        ax1 = fig.add_axes([0.07, (top + bottom) / 2 + 0.03, 0.70, (top - bottom) / 2 - 0.045], sharey=None)
        ax2 = fig.add_axes([0.07, bottom, 0.70, (top - bottom) / 2 - 0.045],
                           sharex=None if native else ax1, sharey=ax1)
        for ax, side, name in ((ax1, "local", "JHH local surveillance"),
                               (ax2, "global", "Nextstrain seasonal-flu global surveillance")):
            x, ser = xs[side]
            present = [t for t in taxa if t in ser]
            if present and len(x):
                ax.stackplot(x, [ser[t] for t in present],
                             colors=[colors.get(t, "#999") for t in present], linewidth=0.3, edgecolor="white")
            ax.set_ylim(0, 1)
            ax.set_ylabel("Relative frequency")
            ax.set_title(f"{name}: {_v(result['provenance'][side], 'build_label')}", loc="left", fontsize=10)
            if xlim:
                ax.set_xlim(*xlim)
        if native:
            for ax in (ax1, ax2):
                ax.xaxis.set_major_locator(mdates.AutoDateLocator())
                ax.xaxis.set_major_formatter(mdates.ConciseDateFormatter(ax.xaxis.get_major_locator()))
            ax1.set_xlabel("Time (local build pivots)", fontsize=8)
        else:
            plt.setp(ax1.get_xticklabels(), visible=False)
        ax2.set_xlabel("Time (global build pivots)" if native else "Time")
        main_ax = ax2
    elif view == "overlay":
        ax = fig.add_axes([0.07, bottom, 0.70, top - bottom])
        for side, ls in (("local", "-"), ("global", "--")):
            x, ser = xs[side]
            for t in taxa:
                if t in ser:
                    ax.plot(x, ser[t], ls, color=colors.get(t, "#999"), lw=1.6)
        ax.plot([], [], "k-", label="JHH local (solid)")
        ax.plot([], [], "k--", label="Nextstrain global (dashed)")
        ax.legend(loc="upper left", frameon=False, fontsize=8)
        ax.set_ylim(0, 1)
        if xlim:
            ax.set_xlim(*xlim)
        ax.set_ylabel("Relative frequency")
        ax.set_xlabel("Time")
        main_ax = ax
    else:
        ax = fig.add_axes([0.07, bottom, 0.70, top - bottom])
        d = result["difference"]
        x = _dates(d["dates"])
        for t in taxa:
            if t in d["series"]:
                ax.plot(x, d["series"][t]["difference_pp"], "-o", ms=2.5, color=colors.get(t, "#999"), lw=1.5)
        ax.axhline(0, color="black", lw=0.8)
        lim = max([abs(v) for s in d["series"].values() for v in s["difference_pp"] if v is not None] + [5])
        ax.set_ylim(-lim * 1.15, lim * 1.15)
        ax.set_ylabel("Difference (percentage points)")
        ax.set_xlabel("Shared timepoint")
        ax.text(0.01, 0.98, "\u2191 " + POSITIVE_LABEL, transform=ax.transAxes, va="top", fontsize=8, color="#444")
        ax.text(0.01, 0.02, "\u2193 " + NEGATIVE_LABEL, transform=ax.transAxes, va="bottom", fontsize=8, color="#444")
        main_ax = ax
    main_ax.xaxis.set_major_locator(mdates.AutoDateLocator())
    main_ax.xaxis.set_major_formatter(mdates.ConciseDateFormatter(main_ax.xaxis.get_major_locator()))
    # legend
    handles = [plt.Rectangle((0, 0), 1, 1, color=colors.get(t, "#999")) for t in taxa]
    fig.legend(handles, taxa, loc="upper left", bbox_to_anchor=(0.79, top), frameon=False,
               title=grouping + (f"\n{result['provenance']['comparison'].get('genotype_definition')}"
                                 if result["provenance"]["comparison"].get("genotype_definition") else ""),
               fontsize=8, title_fontsize=9, ncol=1 if len(taxa) <= 24 else 2)
    fig.text(0.07, 0.955, title, fontsize=13, weight="bold")
    fig.text(0.07, 0.925, f"View: {VIEW_LABEL.get(view, view)}. Relative frequencies of taxa in the supplied builds.",
             fontsize=9, color="#333")
    y = 0.215
    for line in metadata_lines(result, req):
        for wl in textwrap.wrap(line, 165):
            fig.text(0.07, y, wl, fontsize=7, color="#222")
            y -= 0.017
    y -= 0.008
    for wl in textwrap.wrap("Note: " + FIGURE_FOOTNOTE, 175):
        fig.text(0.07, y, wl, fontsize=7, style="italic", color="#444")
        y -= 0.016
    buf = io.BytesIO()
    fig.savefig(buf, format=fmt, dpi=300 if fmt == "png" else None)
    plt.close(fig)
    return buf.getvalue()


def trajectories_table(result: dict) -> pd.DataFrame:
    """Frequencies at the shared timepoints (what the figure shows), with the pivot each value came from."""
    al = result["aligned"]
    rows = []
    for side, name in (("local", "JHH local"), ("global", "Nextstrain global")):
        s = al.get(side)
        if not s:
            continue
        for t, ser in s["series"].items():
            for i, date in enumerate(al["dates"]):
                if not s["present"][i]:
                    continue
                f = ser["frequency"][i]
                rows.append({
                    "dataset": name,
                    "build_id": result[side]["build_id"],
                    "taxon": t,
                    "timepoint": date,
                    "pivot_date_used": s["pivot_dates"][i],
                    "pivot_offset_days": s["offset_days"][i],
                    "relative_frequency": f,
                    "percent": None if f is None else round(f * 100, 4),
                    "numerator_count": ser["numerator"][i],
                    "denominator_count": s["denominator"][i],
                })
    return pd.DataFrame(rows)


def native_trajectories_table(result: dict) -> pd.DataFrame:
    """Frequencies at each build's own pivots."""
    rows = []
    for side, name in (("local", "JHH local"), ("global", "Nextstrain global")):
        s = result[side]
        for t, ser in s["series"].items():
            for i, date in enumerate(s["dates"]):
                f = ser["frequency"][i]
                rows.append({
                    "dataset": name, "build_id": s["build_id"], "taxon": t, "pivot_date": date,
                    "relative_frequency": f, "percent": None if f is None else round(f * 100, 4),
                    "numerator_count": ser["numerator"][i], "denominator_count": s["denominator"][i],
                })
    return pd.DataFrame(rows)


def comparison_table(result: dict) -> pd.DataFrame:
    d = result["difference"]
    rows = []
    for t, s in d["series"].items():
        for i, m in enumerate(d["dates"]):
            rows.append({
                "taxon": t,
                "timepoint": m,
                "local_relative_frequency": s["local"][i],
                "global_relative_frequency": s["global"][i],
                "difference_percentage_points": s["difference_pp"][i],
                "local_numerator_count": s["local_n"][i],
                "global_numerator_count": s["global_n"][i],
            })
    return pd.DataFrame(rows)


def provenance_header(result: dict, req: dict) -> str:
    lines = metadata_lines(result, req) + [
        "Caveat: " + CAVEAT_MAIN,
        "Alignment: " + ALIGNMENT_METHOD,
        "Counts: " + COUNT_METHOD,
    ]
    return "".join(f"# {line}\n" for line in lines)


def table_bytes(df: pd.DataFrame, result: dict, req: dict, sep: str) -> bytes:
    return (provenance_header(result, req) + df.to_csv(sep=sep, index=False)).encode()


def analysis_json(result: dict, req: dict) -> bytes:
    payload = {
        "generated": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "settings": req,
        "caveat": CAVEAT_MAIN,
        "caveat_points": CAVEAT_POINTS,
        "figure_footnote": FIGURE_FOOTNOTE,
        "result": result,
    }
    from .jsonsafe import clean

    return json.dumps(clean(payload), indent=1, default=str).encode()


def report_html(result: dict, req: dict, figure_svg: bytes) -> bytes:
    snap = result["snapshot"]
    rows = sorted(snap["rows"], key=lambda r: -(r["difference_pp"] or 0))

    def pct(x):
        return "" if x is None else f"{x * 100:.1f}%"

    def pp(x):
        return "" if x is None else f"{x:+.1f}"

    trs = "".join(
        f"<tr><td>{html.escape(r['taxon'])}</td><td>{pct(r['local_frequency'])}</td><td>{pct(r['global_frequency'])}</td>"
        f"<td>{pp(r['difference_pp'])}</td><td>{r['local_n']}</td>"
        f"<td>{r['global_n']}</td><td>{r['presence']}</td></tr>"
        for r in rows
    )
    meta = "".join(f"<li>{html.escape(x)}</li>" for x in metadata_lines(result, req))
    caveats = "".join(f"<li>{html.escape(x)}</li>" for x in CAVEAT_POINTS)
    svg = figure_svg.decode()
    svg = svg[svg.find("<svg"):]
    doc = f"""<!doctype html><html><head><meta charset="utf-8"><title>Frequency comparison report</title>
<style>body{{font-family:system-ui,sans-serif;max-width:1100px;margin:24px auto;padding:0 16px;color:#1d2433}}
table{{border-collapse:collapse;width:100%;font-size:14px}}td,th{{border-bottom:1px solid #ddd;padding:4px 8px;text-align:right}}
td:first-child,th:first-child{{text-align:left}}.caveat{{background:#fff7e6;border-left:4px solid #e0a200;padding:8px 12px}}
svg{{width:100%;height:auto}}</style></head><body>
<h1>Local vs global relative frequency comparison</h1>
<p class="caveat">{html.escape(CAVEAT_MAIN)}</p>
<h2>Settings and provenance</h2><ul>{meta}</ul>
{svg}
<h2>Snapshot: {html.escape(str(snap.get('label')))}</h2>
<table><tr><th>Taxon</th><th>Local frequency</th><th>Global frequency</th><th>Difference (pp)</th><th>Local N</th><th>Global N</th><th>Present in</th></tr>{trs}</table>
<p>Difference = local relative frequency - global relative frequency, in percentage points. Positive: {html.escape(POSITIVE_LABEL.lower())}; negative: {html.escape(NEGATIVE_LABEL.lower())}.</p>
<h2>Methods and caveats</h2><ul>{caveats}<li>{html.escape(ALIGNMENT_METHOD)}</li><li>{html.escape(COUNT_METHOD)}</li></ul>
<p><em>{html.escape(FIGURE_FOOTNOTE)}</em></p></body></html>"""
    return doc.encode()
