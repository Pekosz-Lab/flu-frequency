"""`ffc start`: guided, interactive setup for running the app on your own computer.

Walks through: checks -> where the JHH builds come from -> Nextstrain login and
group-access check (private builds) -> which builds -> download, process, open.
Private data never leaves this computer; the dashboard is served on 127.0.0.1 only.

Every question has a default (press Enter). For scripts: `ffc start --yes` with
--source/--subtypes/--resolutions answers everything without prompting.
"""

from __future__ import annotations

import re
import shutil
import socket
import subprocess
import sys
from pathlib import Path

import yaml

from . import __version__

PRIVATE_GROUP = "PekoszLab"
PUBLIC_PREFIX = "nextstrain.org/groups/PekoszLab-Public/seasonal-flu"

SOURCES = {
    "private": "Private PekoszLab group on nextstrain.org (needs a Nextstrain login with group access)",
    "public": "Public PekoszLab-Public group on nextstrain.org (no login)",
    "copy": "Copy from the nextstrain pipeline folder on this computer",
    "existing": "Use the builds already downloaded (no download)",
}

BOLD, DIM, GREEN, YELLOW, RED, RESET = ("\033[1m", "\033[2m", "\033[32m", "\033[33m", "\033[31m", "\033[0m")
if not sys.stdout.isatty():
    BOLD = DIM = GREEN = YELLOW = RED = RESET = ""


def ok(msg):
    print(f"  {GREEN}✓{RESET} {msg}")


def warn(msg):
    print(f"  {YELLOW}!{RESET} {msg}")


def fail(msg):
    print(f"  {RED}✗{RESET} {msg}")


def step(n, total, title):
    print(f"\n{BOLD}[{n}/{total}] {title}{RESET}")


class Asker:
    """Prompts with defaults; with --yes (or no terminal) the default is taken."""

    def __init__(self, assume_yes: bool):
        self.auto = assume_yes or not sys.stdin.isatty()

    def text(self, q: str, default: str) -> str:
        if self.auto:
            print(f"  {q} {DIM}[{default}]{RESET} {default}")
            return default
        a = input(f"  {q} {DIM}[{default}]{RESET} ").strip()
        return a or default

    def yes(self, q: str, default: bool = True) -> bool:
        d = "Y/n" if default else "y/N"
        if self.auto:
            print(f"  {q} [{d}] {'yes' if default else 'no'}")
            return default
        while True:
            a = input(f"  {q} [{d}] ").strip().lower()
            if not a:
                return default
            if a in ("y", "yes"):
                return True
            if a in ("n", "no"):
                return False

    def choice(self, q: str, options: dict[str, str], default: str) -> str:
        keys = list(options)
        for i, k in enumerate(keys, 1):
            mark = f" {DIM}(default){RESET}" if k == default else ""
            print(f"    {i}) {options[k]}{mark}")
        if self.auto:
            print(f"  {q} {default}")
            return default
        while True:
            a = input(f"  {q} [{keys.index(default) + 1}] ").strip()
            if not a:
                return default
            if a.isdigit() and 1 <= int(a) <= len(keys):
                return keys[int(a) - 1]
            if a in keys:
                return a
            print(f"  Please type a number from 1 to {len(keys)}.")


def nextstrain_user() -> tuple[bool, list[str]]:
    """(logged_in, groups) from `nextstrain whoami`."""
    exe = shutil.which("nextstrain")
    if not exe:
        return False, []
    p = subprocess.run([exe, "whoami"], capture_output=True, text=True)
    if p.returncode != 0:
        return False, []
    groups = re.findall(r"^\s*-\s*(\S+)", p.stdout, flags=re.M)
    return True, groups


def has_private_access(groups: list[str]) -> bool:
    # memberships look like "PekoszLab" or "PekoszLab/viewers"; PekoszLab-Public is a different group
    return any(g == PRIVATE_GROUP or g.startswith(PRIVATE_GROUP + "/") for g in groups)


def free_port(preferred: int) -> int:
    for port in range(preferred, preferred + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("No free port found")


def run_start(args, project: Path) -> int:
    from .config import load_settings
    from .fetch import FetchError, run_fetch
    from .ingest import run_ingest

    ask = Asker(args.yes)
    total = 5
    print(f"{BOLD}Flu Frequency Compare: guided start{RESET} {DIM}(v{__version__}){RESET}")
    print(f"{DIM}Runs on this computer only; private builds never leave it.{RESET}")

    # ---------------------------------------------------------------- 1 checks
    step(1, total, "Checking your setup")
    ok(f"Python {sys.version.split()[0]}, app folder {project}")
    has_cli = shutil.which("nextstrain") is not None
    if has_cli:
        v = subprocess.run(["nextstrain", "version"], capture_output=True, text=True).stdout.strip().splitlines()
        ok(f"Nextstrain CLI found ({v[0] if v else 'version unknown'})")
    else:
        warn("Nextstrain CLI not found. Downloads need it: activate the flu-freq-compare conda environment,")
        warn("or install it with: conda install -c conda-forge -c bioconda nextstrain-cli")
    manifest = project / "config" / "manifest.yaml"
    have_data = manifest.exists() and (project / "data" / "raw").exists()
    if have_data:
        ok("Builds downloaded earlier were found")

    # ---------------------------------------------------------------- 2 source
    step(2, total, "Where should the JHH builds come from?")
    options = dict(SOURCES)
    if not have_data:
        options.pop("existing")
    copy_from = (project / yaml.safe_load((project / "config" / "fetch.yaml").read_text())["local"]["copy_from"]).resolve()
    if not copy_from.exists():
        options.pop("copy")
    default = args.source or ("existing" if have_data and not has_cli else "private")
    if default not in options:
        default = "private" if has_cli else next(iter(options))
    source = args.source or ask.choice("Choose:", options, default)
    if source not in options:
        fail(f"'{source}' is not available here.")
        return 2

    # ---------------------------------------------------------------- 3 login
    step(3, total, "Nextstrain access")
    if source == "private":
        if not has_cli:
            fail("The Nextstrain CLI is needed to sign in. Install it (see step 1) and run `ffc start` again.")
            return 2
        logged_in, groups = nextstrain_user()
        if not logged_in:
            print("  You are not logged in to nextstrain.org.")
            if ask.yes("Log in now? (opens Nextstrain's own sign-in; this app never sees your password)", True) and not ask.auto:
                subprocess.run(["nextstrain", "login"])  # interactive, user's own credentials
                logged_in, groups = nextstrain_user()
            elif ask.auto:
                warn("Not logged in, and running without prompts: cannot sign in automatically.")
        if logged_in and has_private_access(groups):
            ok(f"Logged in, with access to the {PRIVATE_GROUP} group")
        else:
            if logged_in:
                warn(f"You are logged in, but your account is not a member of the {PRIVATE_GROUP} group.")
                print(f"  Ask the lab's Nextstrain group owner to add you, then run `ffc start` again.")
            else:
                warn("Without a login the private builds cannot be downloaded.")
            if ask.yes("Continue with the PUBLIC builds (PekoszLab-Public) instead?", True):
                source = "public"
                ok("Using the public builds")
            else:
                print("  Stopped. Nothing was downloaded.")
                return 1
    else:
        ok({"public": "Public builds: no login needed",
            "copy": f"Copying from {copy_from} (read only)",
            "existing": "Using builds already on this computer"}[source])

    # ---------------------------------------------------------------- 4 which builds
    step(4, total, "Which builds?")
    fcfg = yaml.safe_load((project / "config" / "fetch.yaml").read_text())
    all_sub = list(fcfg["subtypes"])
    all_res = list(fcfg["global"]["resolutions"])
    subtypes = args.subtypes or ask.text("Subtypes (space-separated):", " ".join(all_sub)).split()
    bad = [s for s in subtypes if s not in all_sub]
    if bad:
        fail(f"Unknown subtype(s): {', '.join(bad)}. Choose from {', '.join(all_sub)}.")
        return 2
    resolutions = all_res
    if source != "existing":
        resolutions = args.resolutions or ask.text("Global Nextstrain builds to compare with:", " ".join(all_res)).split()
        badr = [r for r in resolutions if r not in all_res]
        if badr:
            fail(f"Unknown resolution(s): {', '.join(badr)}. Choose from {', '.join(all_res)}.")
            return 2

    # ---------------------------------------------------------------- 5 run
    step(5, total, "Download, process and open")
    if source != "existing":
        overrides = {"global": {"resolutions": resolutions}}
        if source == "private":
            overrides["local"] = {"mode": "remote"}
        elif source == "public":
            overrides["local"] = {"mode": "remote", "remote_prefix": PUBLIC_PREFIX, "label_suffix": " (public build)"}
        elif source == "copy":
            overrides["local"] = {"mode": "copy"}
        try:
            entries = run_fetch(project / "config" / "fetch.yaml", project, manifest, subtypes=subtypes,
                                overrides=overrides, log=lambda m: print("  " + m))
        except FetchError as e:
            fail(str(e))
            return 2
        locals_ = [e for e in entries if e["source_type"] == "local"]
        if not locals_:
            fail("No JHH builds could be downloaded. Check your access, or run `ffc start` and choose the public builds.")
            return 1
    report = run_ingest(manifest, project / "store", project / "config" / "settings.yaml",
                        project / "config" / "taxon_harmonization.yaml", log=lambda m: print("  " + m))
    failed = [k for k, v in report["builds"].items() if v["status"] in ("failed", "missing_file")]
    if failed:
        warn(f"{len(failed)} build(s) could not be processed: {', '.join(failed)}")
    if args.no_serve:
        ok("Done. Start the dashboard any time with: ffc serve --open")
        return 0
    settings = load_settings(project / "config" / "settings.yaml")
    port = free_port(args.port or settings["server"]["port"])
    import uvicorn

    from .api import create_app

    url = f"http://127.0.0.1:{port}"
    ok(f"Dashboard ready at {BOLD}{url}{RESET}  (only this computer can open it; Ctrl+C to stop)")
    if not args.no_open:
        import webbrowser

        webbrowser.open(url)
    uvicorn.run(create_app(project / "store" / "ffc.duckdb", project), host="127.0.0.1", port=port, log_level="warning")
    return 0
