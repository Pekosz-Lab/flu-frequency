"""Stage 2: FastAPI backend. Reads only the precomputed DuckDB store.

No surveillance data is fetched from anywhere; the frontend is served from
frontend/dist by the same process.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Query as Q
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__
from .config import load_harmonization, load_settings
from .constants import (
    ALIGNMENT_METHOD,
    CAVEAT_MAIN,
    CAVEAT_POINTS,
    COUNT_METHOD,
    FIGURE_FOOTNOTE,
    GLOBAL_DATASET_NAME,
    LOCAL_DATASET_NAME,
    NEGATIVE_LABEL,
    NOT_AVAILABLE,
    POSITIVE_LABEL,
    SUBTYPES,
)
from .engine import Engine
from .jsonsafe import clean
from . import exports


class Genotype(BaseModel):
    gene: str
    positions: list[int] = Field(default_factory=list)


class Snapshot(BaseModel):
    mode: Literal["point", "range"] = "range"
    timepoint: str | None = None


class CompareRequest(BaseModel):
    local_build_id: str
    global_build_id: str
    grouping: Literal["clade", "subclade", "genotype"] = "subclade"
    genotype: Genotype | None = None
    local_filters: dict[str, list[str]] = Field(default_factory=dict)
    global_filters: dict[str, list[str]] = Field(default_factory=dict)
    shared_filters: dict[str, list[str]] = Field(default_factory=dict)
    start: str | None = None
    end: str | None = None
    top_n: int = 0
    snapshot: Snapshot = Field(default_factory=Snapshot)
    palette: Literal["nextstrain", "colorblind"] = "nextstrain"
    include_projection: bool = False


class ExportRequest(CompareRequest):
    view: Literal["stacked", "overlay", "difference"] = "stacked"
    time_axis: Literal["aligned", "native"] = "aligned"
    title: str | None = None


def _d(x) -> str:
    """Date-only string, or the not-available marker."""
    import pandas as pd

    if x is None or x is pd.NaT or (isinstance(x, float) and x != x):
        return NOT_AVAILABLE
    return str(x)[:10]


def _req_dict(r: BaseModel) -> dict:
    d = r.model_dump()
    d.pop("view", None)
    d.pop("title", None)
    d.pop("time_axis", None)
    return d


def create_app(db_path: Path, project: Path) -> FastAPI:
    settings = load_settings(project / "config" / "settings.yaml")
    engine = Engine(db_path, load_harmonization(project / "config" / "taxon_harmonization.yaml"),
                    shared_filter_settings=settings.get("shared_filters"))
    app = FastAPI(title="flu-freq-compare", version=__version__)

    def run_compare(req: CompareRequest) -> dict:
        engine.refresh_if_changed()
        try:
            return engine.compare(_req_dict(req))
        except KeyError as e:
            raise HTTPException(404, str(e))
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.get("/api/health")
    def health():
        return {"ok": True, "version": __version__, "store": str(db_path)}

    @app.get("/api/options")
    def options():
        """Builds, valid local/global pairings and UI vocabularies."""
        engine.refresh_if_changed()
        b = engine.builds()
        builds = []
        for r in b.to_dict("records"):
            mm = json.loads(r["manifest_metadata"] or "{}")
            builds.append(
                {
                    "build_id": r["build_id"],
                    "source_type": r["source_type"],
                    "label": r["display_name"],
                    "organization": r["organization"],
                    "subtype": r["subtype"],
                    "segment": r["segment"],
                    "resolution": r["resolution"],
                    "updated_date": r["updated_date"] or NOT_AVAILABLE,
                    "build_date": r["build_date"] or NOT_AVAILABLE,
                    "most_recent_sample_date": _d(r["most_recent_sample_date"]),
                    "min_sample_date": _d(r["min_sample_date"]),
                    "source_file": Path(r["auspice_json_path"]).name,
                    "remote": r["remote"],
                    "fetched_at": r["fetched_at"],
                    "total_tip_count": int(r["total_tip_count"]),
                    "downsampling": r["downsampling_description"],
                    "frequency_source": r["frequency_source"],
                    "warnings": json.loads(r["validation_warnings"] or "[]"),
                    "synthetic": bool(mm.get("synthetic", False)),
                }
            )
        pairs = [
            {"local": l["build_id"], "global": g["build_id"]}
            for l in builds if l["source_type"] == "local"
            for g in builds if g["source_type"] == "global"
            and g["subtype"] == l["subtype"] and g["segment"] == l["segment"]
        ]
        info = engine.q("SELECT * FROM store_info").to_dict("records")[0]
        return clean({
            "subtypes": [{"id": k, "label": v} for k, v in SUBTYPES.items()],
            "enabled_segments": settings["enabled_segments"],
            "builds": builds,
            "pairs": pairs,
            "default_top_n": settings["default_top_n"],
            "default_palette": settings["default_palette"],
            "store": {k: str(v) for k, v in info.items()},
            "text": {
                "caveat": CAVEAT_MAIN,
                "caveat_points": CAVEAT_POINTS,
                "footnote": FIGURE_FOOTNOTE,
                "alignment": ALIGNMENT_METHOD,
                "counts": COUNT_METHOD,
                "positive": POSITIVE_LABEL,
                "negative": NEGATIVE_LABEL,
                "local_name": LOCAL_DATASET_NAME,
                "global_name": GLOBAL_DATASET_NAME,
                "not_available": NOT_AVAILABLE,
            },
        })

    @app.get("/api/builds/{build_id}/fields")
    def fields(build_id: str):
        try:
            engine.build(build_id)
        except KeyError as e:
            raise HTTPException(404, str(e))
        return clean(engine.fields(build_id))

    @app.get("/api/shared-filters")
    def shared_filters(local: str = Q(...), global_: str = Q(..., alias="global")):
        """Filters that apply to both builds (equivalent attributes in both JSONs)."""
        engine.refresh_if_changed()
        try:
            return clean(engine.shared_filters(local, global_))
        except KeyError as e:
            raise HTTPException(404, str(e))

    @app.get("/api/genotype-options")
    def genotype_options(local: str = Q(...), global_: str = Q(..., alias="global")):
        return clean(engine.genotype_options(local, global_))

    @app.post("/api/compare")
    def compare(req: CompareRequest):
        return JSONResponse(clean(run_compare(req)))

    @app.post("/api/export/figure")
    def export_figure(req: ExportRequest, fmt: Literal["png", "svg", "pdf"] = "png"):
        result = run_compare(req)
        data = exports.render_figure(result, _req_dict(req), req.view, fmt, req.title, req.time_axis)
        media = {"png": "image/png", "svg": "image/svg+xml", "pdf": "application/pdf"}[fmt]
        return Response(data, media_type=media, headers=_dl(req, req.view, fmt))

    @app.post("/api/export/data")
    def export_data(req: ExportRequest, what: Literal["trajectories", "native_trajectories", "comparison", "snapshot", "analysis"] = "trajectories",
                    fmt: Literal["csv", "tsv", "json"] = "csv"):
        result = run_compare(req)
        rd = _req_dict(req)
        if what == "analysis" or fmt == "json":
            return Response(exports.analysis_json(result, rd), media_type="application/json",
                            headers=_dl(req, "analysis", "json"))
        import pandas as pd

        df = {
            "trajectories": exports.trajectories_table,
            "native_trajectories": exports.native_trajectories_table,
            "comparison": exports.comparison_table,
            "snapshot": lambda r: pd.DataFrame(r["snapshot"]["rows"]),
        }[what](result)
        sep = "," if fmt == "csv" else "\t"
        return Response(exports.table_bytes(df, result, rd, sep),
                        media_type="text/csv" if fmt == "csv" else "text/tab-separated-values",
                        headers=_dl(req, what, fmt))

    @app.post("/api/export/report")
    def export_report(req: ExportRequest):
        result = run_compare(req)
        svg = exports.render_figure(result, _req_dict(req), req.view, "svg", req.title, req.time_axis)
        return Response(exports.report_html(result, _req_dict(req), svg), media_type="text/html",
                        headers=_dl(req, "report", "html"))

    def _dl(req, what, ext):
        lb = engine.build(req.local_build_id)
        name = f"{lb['subtype']}_{lb['segment']}_{req.grouping}_{req.global_build_id}_{what}.{ext}"
        return {"Content-Disposition": f'attachment; filename="{name}"'}

    dist = project / "frontend" / "dist"
    if dist.exists():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

        @app.get("/")
        def index():
            return FileResponse(dist / "index.html")

    return app
