#!/usr/bin/env python3
"""
jmx_pipeline - author a JMeter plan and run it on HyperExecute, in one command.

Chains the two tools in this folder:

    jmxgen.py                  source -> .jmx  (+ verify)
    hyperexecute_automation.py .jmx    -> project, upload, trigger, monitor, download

Examples
--------
    # record a URL list in a headless browser, then load-test it on HyperExecute
    python3 jmx_pipeline.py record pages.txt \\
        --project-name "TestMu Load" --concurrency 5 --duration 300

    # author from an OpenAPI spec, pass extra authoring flags through
    python3 jmx_pipeline.py from-openapi api.yaml \\
        --author "--auth 'Bearer ${TOKEN}' --include /orders" \\
        --project-name "Orders API" --regions eastus --concurrency 10

    # skip authoring and ship a plan you already have
    python3 jmx_pipeline.py --jmx testmuai_lean.jmx --data users.csv \\
        --project-name "TestMu Load" --duration 600

    # author only, stop before the cloud (dry run of the whole first half)
    python3 jmx_pipeline.py probe pages.txt --no-run

Credentials come from --userName/--accessKey or LAMBDATEST_USERNAME /
LAMBDATEST_ACCESS_KEY, exactly as hyperexecute_automation.py expects.
"""

import argparse
import importlib.util
import os
import shlex
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
JMXGEN = os.path.join(HERE, "jmxgen.py")
HX_SCRIPT = os.path.join(HERE, "hyperexecute_automation.py")

AUTHOR_MODES = ("record", "probe", "from-har", "from-openapi", "from-postman",
                "from-curl", "from-excel", "from-url", "build")


def load_hyperexecute():
    if not os.path.exists(HX_SCRIPT):
        sys.exit("hyperexecute_automation.py not found next to this script (%s)" % HERE)
    spec = importlib.util.spec_from_file_location("hyperexecute_automation", HX_SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def banner(hx, title):
    hx.ui_header(title)
    sys.stdout.flush()


def author(mode, sources, out_jmx, extra_flags, deep):
    """Run jmxgen and return the path of the plan it wrote."""
    if not os.path.exists(JMXGEN):
        sys.exit("jmxgen.py not found next to this script (%s)" % HERE)
    cmd = [sys.executable, JMXGEN, mode] + list(sources) + ["-o", out_jmx]
    if extra_flags:
        cmd += shlex.split(extra_flags)
    if deep:
        cmd += ["--deep"]
    print("  -> %s" % " ".join(shlex.quote(c) for c in cmd), flush=True)
    sys.stdout.flush()
    proc = subprocess.run(cmd)
    if proc.returncode != 0 or not os.path.exists(out_jmx):
        sys.exit("authoring failed - nothing was shipped")
    return out_jmx


def verify(jmx, deep):
    sys.stdout.flush()
    cmd = [sys.executable, JMXGEN, "verify", jmx] + (["--deep"] if deep else [])
    if subprocess.run(cmd).returncode != 0:
        sys.exit("the generated plan did not verify - refusing to run it")


def main():
    hx = load_hyperexecute()

    ap = argparse.ArgumentParser(
        prog="jmx_pipeline",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)

    ap.add_argument("mode", nargs="?", choices=AUTHOR_MODES,
                    help="how to author the plan (omit when using --jmx)")
    ap.add_argument("sources", nargs="*",
                    help="URLs / files for that mode (a .txt, .csv, .xlsx list works too)")
    ap.add_argument("--jmx", help="skip authoring and ship this existing .jmx")
    ap.add_argument("--out", default=None, help="path for the generated .jmx")
    ap.add_argument("--author", default=None, metavar="FLAGS",
                    help="extra jmxgen flags, quoted, e.g. \"--parallel 6 --no-static\"")
    ap.add_argument("--data", nargs="*", default=[],
                    help="extra files to upload with the plan (CSVs, .properties, jars)")
    ap.add_argument("--deep", action="store_true",
                    help="have JMeter itself load the plan before shipping it")
    ap.add_argument("--no-run", action="store_true",
                    help="author and verify only - do not touch HyperExecute")

    ap.add_argument("--project-name", default=None,
                    help="create a new HyperExecute project with this name")
    ap.add_argument("--project-id", default=None,
                    help="reuse an existing project instead of creating one "
                         "(files are still uploaded to it)")
    ap.add_argument("--project-type", default="jmeter")

    # every run/credential flag from hyperexecute_automation.py, verbatim
    hx._add_credentials_args(ap)
    hx._add_run_args(ap)

    a = ap.parse_args()

    if not a.jmx and not a.mode:
        ap.error("give an authoring mode (%s) or --jmx <file>" % "/".join(AUTHOR_MODES))
    if a.mode and not a.sources:
        ap.error("mode '%s' needs at least one source (URL or file)" % a.mode)

    # ---------------------------------------------------------------- author
    if a.jmx:
        jmx = a.jmx
        if not os.path.exists(jmx):
            sys.exit("no such file: %s" % jmx)
        banner(hx, "Pipeline  1/3  ·  Using existing plan")
        hx.ui_field("Plan", jmx)
        verify(jmx, a.deep)
    else:
        banner(hx, "Pipeline  1/3  ·  Authoring")
        out = a.out or os.path.join(
            os.getcwd(), "%s.jmx" % (a.project_name or a.mode).replace(" ", "_"))
        jmx = author(a.mode, a.sources, out, a.author, a.deep)

    size_kb = os.path.getsize(jmx) / 1024.0
    hx.ui_ok("plan ready: %s (%.0f KB)" % (jmx, size_kb))

    if a.no_run:
        hx.ui_step("--no-run: stopping before HyperExecute")
        return 0

    # ------------------------------------------------------------- upload
    username, api_key = hx._resolve_credentials(a)
    project_id = a.project_id or os.environ.get("HYPEREXECUTE_PROJECT_ID")
    files = [jmx] + [f for f in a.data if f]
    for f in files:
        if not os.path.exists(f):
            sys.exit("no such file: %s" % f)

    banner(hx, "Pipeline  2/3  ·  Project + upload")
    api = hx.HyperExecuteAPI(username, api_key, project_id, debug=a.debug)

    if not project_id:
        name = a.project_name or os.path.splitext(os.path.basename(jmx))[0]
        hx.ui_field("Creating", "%s (%s)" % (name, a.project_type))
        project_id = api.create_project(name, a.project_type)
        if not project_id:
            sys.exit("could not create the project")
        api.project_id = project_id
    else:
        hx.ui_field("Project", project_id)

    hx.ui_field("Uploading", ", ".join(os.path.basename(f) for f in files))
    if not api.upload_files(files):
        sys.exit("upload failed")

    # ---------------------------------------------------------------- run
    banner(hx, "Pipeline  3/3  ·  Run")
    hx._run_test(api, a, os.path.basename(jmx))
    print("\n  reuse this project next time with:  --project-id %s" % project_id)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
