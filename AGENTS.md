# AGENTS.md: rules for AI coding agents working on flu-freq-compare

This app compares JHH local and Nextstrain global influenza builds. It handles
**unpublished JHH clinical sequence metadata** and **GISAID-derived data**.

## Hard rules
1. Never commit or move anything from `data/`, `store/`, `store-demo/`, `exports/`,
   `*.parquet`, `*.duckdb` or `config/manifest.yaml` into a tracked location. Never
   bypass `.githooks/pre-commit` (`--no-verify`, `git add -f`).
2. Never read build JSONs, Parquet files or the DuckDB store into your context
   (strain names and metadata values are sensitive). Use `ffc inspect` (structure
   only), test fixtures, or `ffc demo` synthetic data.
3. Never upload to Nextstrain. `ffc fetch` only runs `nextstrain remote download`;
   do not add `upload` or `login` calls to it. `ffc start` may run `nextstrain login`
   only after a person answers yes at its prompt; agents must never run it.
4. Never modify the nextstrain pipeline repository (`../nextstrain`). This app only
   reads its outputs.
5. Never stage or commit unless the user explicitly asks.
6. Do not bind the server to anything but `127.0.0.1` by default.
7. Keep the caveat wording in `ffc/constants.py` intact and shown in UI and exports.
   Frequencies are relative frequencies of the supplied builds, never prevalence.
8. No silent data transformation: no interpolation, no implicit taxon merging. Any
   relabelling goes through `config/taxon_harmonization.yaml` and is reported.
9. The public website (`frontend/web`, `webSource.ts`, built with `npm run build:web`)
   must never reference or fetch private builds: only `flu/seasonal/` and
   `groups/PekoszLab-Public/` paths, no credentials, no calls to the local app's API.
   Never weaken `frontend/scripts/check-site.mjs`, the CSP, or `assertPublic`.

## Where things live
- `ffc/ingest.py` (stage 1, offline) → `store/parquet/*` + `store/ffc.duckdb`
- `ffc/engine.py` (all queries), `ffc/api.py` (FastAPI), `ffc/exports.py` (figures/tables)
- `frontend/src` (React + TypeScript); rebuild `frontend/dist` with `npm run build`
- Website: `frontend/web/` (pages), `frontend/src/engine/` (browser engine; keep in step with
  `ffc/engine.py`: `tests/test_parity.py` must pass), `frontend/src/webSource.ts` (public fetches)
- Tests: `pytest` (synthetic data, includes engine parity), `frontend/e2e` (Playwright against `ffc demo`)
- Update `README.md` and `docs/DESIGN.md` with any behaviour change.
