#!/usr/bin/env python3
"""
jmxgen_server - the authoring service and web console.

Wraps jmxgen.py in an HTTP API and serves a single-page console, so authoring is
self-serve instead of expert-only. The CLI and the console call the same code.

    python3 jmxgen_server.py            # then open http://localhost:8770

API
    POST /api/author    source -> spec + .jmx + report (what was kept/dropped/correlated)
    POST /api/apply     re-generate after edits / rejected correlations
    POST /api/replay    run the plan once as a single user and diagnose
    POST /api/ship      create the HyperExecute project, upload, trigger, monitor
    GET  /api/plan/<id> download the .jmx
"""

import base64
import importlib.util
import json
import os
import re
import shutil
import shlex
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name, filename):
    path = os.path.join(HERE, filename)
    if not os.path.exists(path):
        return None
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


jmxgen = _load("jmxgen", "jmxgen.py")
if jmxgen is None:
    sys.exit("jmxgen.py must sit next to this file")

def _asset(name):
    """Read a bundled file - works from a directory or from inside a .pyz bundle."""
    path = os.path.join(HERE, name)
    if os.path.exists(path):
        return open(path, "rb").read()
    try:
        import zipfile
        for candidate in (sys.argv[0], HERE):
            if candidate and zipfile.is_zipfile(candidate):
                with zipfile.ZipFile(candidate) as z:
                    for entry in z.namelist():
                        if entry.endswith(name):
                            return z.read(entry)
    except Exception:
        pass
    return None


SESSIONS = {}
LOCK = threading.Lock()

# every authoring mode the console can offer, and how to reach it
MODES = {
    "openapi":  {"label": "OpenAPI / Swagger", "input": "file_or_url", "ext": ".yaml,.json"},
    "postman":  {"label": "Postman collection", "input": "file", "ext": ".json"},
    "har":      {"label": "Recording (HAR)", "input": "file", "ext": ".har,.json"},
    "curl":     {"label": "cURL command(s)", "input": "text"},
    "excel":    {"label": "Excel / CSV sheet", "input": "file", "ext": ".xlsx,.csv"},
    "urls":     {"label": "Page URL list (probe)", "input": "text"},
    "jmx":      {"label": "Existing .jmx (import)", "input": "file", "ext": ".jmx"},
}


def _session_dir(sid):
    return os.path.join(tempfile.gettempdir(), "jmxgen-console", sid)


def _safe_jmx_name(name):
    """A filename the user chose, reduced to something safe to write and upload."""
    name = os.path.basename((name or "").strip())
    name = re.sub(r'[^A-Za-z0-9._-]+', "_", name).strip("._-")
    if not name:
        return "plan.jmx"
    stem = name[:-4] if name.lower().endswith(".jmx") else name
    stem = stem[:116] or "plan"          # trim the stem, never the extension
    return stem + ".jmx"


def _write_upload(sid, filename, content_b64):
    d = _session_dir(sid)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, os.path.basename(filename or "input"))
    with open(path, "wb") as fh:
        fh.write(base64.b64decode(content_b64 or ""))
    return path


def _build_from_source(sid, payload):
    """Run the right jmxgen adapter and return (spec, report)."""
    mode = payload.get("mode", "openapi")
    opts = payload.get("options") or {}
    text = (payload.get("text") or "").strip()
    upload = payload.get("file") or {}
    path = None
    if upload.get("content"):
        path = _write_upload(sid, upload.get("name"), upload["content"])

    rules = jmxgen.load_rules(None)
    report = {"mode": mode}

    if mode == "openapi":
        src = path or text
        if not src:
            raise ValueError("give an OpenAPI file or URL")
        spec, n = jmxgen.openapi_to_spec(
            src, auth=opts.get("auth") or None, server=opts.get("server") or None,
            include=opts.get("include") or None, exclude=opts.get("exclude") or None)
        report["operations"] = n
    elif mode == "postman":
        if not path:
            raise ValueError("upload a Postman collection")
        spec, n = jmxgen.postman_to_spec(path)
        report["requests"] = n
    elif mode == "curl":
        if not text:
            raise ValueError("paste at least one curl command")
        spec, n = jmxgen.curl_to_spec(text)
        report["requests"] = n
    elif mode == "excel":
        if not path:
            raise ValueError("upload a spreadsheet")
        spec = jmxgen.sheet_to_spec(path)
    elif mode == "urls":
        urls = [u.strip() for u in text.splitlines() if u.strip()]
        if not urls:
            raise ValueError("give at least one URL")
        spec, st = jmxgen.probe_to_spec(
            urls, assets=not opts.get("no_assets"),
            keep_static=not opts.get("no_static"),
            parallel=int(opts["parallel"]) if opts.get("parallel") else None)
        report.update({"pages": st["pages"], "assets": st["assets"],
                       "skipped_third_party": st["skipped_third_party"],
                       "failed": ["%s -> %s" % (u, e) for u, e in st["failed"]],
                       "blocked": st["blocked"]})
    elif mode == "jmx":
        if not path:
            raise ValueError("upload a .jmx")
        spec, counts = jmxgen.jmx_to_spec(path)
        report.update(counts)
    elif mode == "har":
        if not path:
            raise ValueError("upload a HAR")
        spec, info = jmxgen.har_to_spec(
            path,
            include=opts.get("include") or None,
            exclude=opts.get("exclude") or None,
            keep_static=bool(opts.get("keep_static")),
            pages=not opts.get("no_pages"),
            drop_third_party=not opts.get("keep_third_party"),
            correlate=not opts.get("no_correlate"),
            mode=opts.get("traffic", "auto"),
            methods=opts.get("methods") or None,
            real_think_time=bool(opts.get("real_think_time")),
            rules=rules)
        report.update({"kept": info["kept"], "total": info["total"],
                       "pages": info["pages"], "skipped": info["skipped"],
                       "correlated": info["correlated"]})
    else:
        raise ValueError("unknown mode: %s" % mode)

    # options that apply regardless of source
    if opts.get("login_path"):
        method, _, p = (opts["login_path"].strip().partition(" ")
                        if " " in opts["login_path"] else ("POST", "", opts["login_path"]))
        login = {"var": "AUTH_TOKEN",
                 "login": {"method": (method or "POST").upper(), "path": p or opts["login_path"],
                           "extract": {"type": "json",
                                       "query": opts.get("login_token") or "$.access_token"}}}
        if opts.get("login_body"):
            try:
                login["login"]["body"] = json.loads(opts["login_body"])
                login["login"]["headers"] = {"Content-Type": "application/json"}
            except ValueError:
                login["login"]["body"] = opts["login_body"]
        spec["auth"] = login
    if opts.get("csv_file"):
        spec["csv"] = (spec.get("csv") or []) + [{
            "file": opts["csv_file"],
            "variables": [c.strip() for c in (opts.get("csv_columns") or "").split(",")
                          if c.strip()]}]
    for key in ("threads", "ramp_up", "duration"):
        if opts.get(key):
            for tg in spec.get("thread_groups", []):
                tg[key] = int(opts[key])
                if key == "duration":
                    tg.pop("loops", None)
    return spec, report


def _emit(sid, spec, report):
    d = _session_dir(sid)
    os.makedirs(d, exist_ok=True)
    jmx_path = os.path.join(d, "plan.jmx")
    with open(jmx_path, "w", encoding="utf-8") as fh:
        fh.write(jmxgen.build_plan(spec))
    errors, warnings = jmxgen.verify(jmx_path, quiet=True)
    steps = _flatten(spec)
    with LOCK:
        SESSIONS[sid] = {"spec": spec, "jmx": jmx_path, "dir": d,
                         "correlations": report.get("correlated") or []}
    return {
        "session": sid,
        "report": report,
        "steps": steps,
        "verify": {"errors": errors, "warnings": warnings},
        "size_kb": round(os.path.getsize(jmx_path) / 1024.0, 1),
        "spec_yaml": jmxgen.dump_spec(spec, "x.yaml"),
        "correlations": report.get("correlated") or [],
        # so the HyperExecute form can prefill the load it is about to override
        "load": _plan_load(spec),
    }


def _plan_load(spec):
    """The first thread group's load, for prefilling the run form."""
    tgs = spec.get("thread_groups") or []
    tg = tgs[0] if tgs else {}
    return {"threads": tg.get("threads") or 1,
            "ramp_up": tg.get("ramp_up") or 1,
            "duration": tg.get("duration") or ""}


def _flatten(spec, depth=0, out=None, group=""):
    """A flat, display-friendly view of the plan's steps."""
    if out is None:
        out = []
    for tg in spec.get("thread_groups", []):
        _walk_steps(tg.get("steps", []), out, tg.get("name", "Thread Group"))
    return out


def _walk_steps(steps, out, group):
    for st in steps:
        if "transaction" in st or "parallel" in st:
            label = st.get("transaction") or st.get("parallel")
            _walk_steps(st.get("steps", []), out, label)
            continue
        if "steps" in st:
            _walk_steps(st["steps"], out, group)
            continue
        if "pause" in st:
            out.append({"group": group, "name": "pause %sms" % st["pause"],
                        "method": "", "path": "", "kind": "pause"})
            continue
        out.append({
            "group": group,
            "name": st.get("name", ""),
            "method": st.get("method", st.get("type", "")),
            "path": str(st.get("path", ""))[:120],
            "asserts": len(st.get("assert", []) or []),
            "extracts": [e.get("var") for e in (st.get("extract", []) or [])],
            "think_time": st.get("think_time"),
            "kind": st.get("type", "http"),
        })


class Handler(BaseHTTPRequestHandler):
    server_version = "jmxgen-console"
    last_seen = time.time()             # when the console was last used - drives idle shutdown

    def handle_one_request(self):
        Handler.last_seen = time.time()
        return BaseHTTPRequestHandler.handle_one_request(self)

    def _cors(self):
        # the recorder extension posts here from its own origin
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body)
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            page = _asset("console.html")
            if page is None:
                return self._send(500, "console.html is missing", "text/plain")
            return self._send(200, page, "text/html; charset=utf-8")
        if self.path == "/api/modes":
            return self._send(200, MODES)
        if self.path == "/api/ping":
            return self._send(200, {"ok": True, "service": "jmxgen"})
        if self.path.startswith("/api/session/"):
            sid = self.path.rsplit("/", 1)[-1]
            sess = SESSIONS.get(sid)
            if not sess:
                return self._send(404, {"error": "no such session"})
            return self._send(200, _emit(sid, sess["spec"],
                                         {"mode": "restored",
                                          "correlated": sess["correlations"]}))
        if self.path.startswith("/api/plan/"):
            raw = self.path[len("/api/plan/"):]
            sid, _, query = raw.partition("?")
            sess = SESSIONS.get(sid)
            if not sess:
                return self._send(404, {"error": "no such session"})
            data = open(sess["jmx"], "rb").read()
            name = _safe_jmx_name(
                urllib.parse.parse_qs(query).get("name", [""])[0])
            self.send_response(200)
            self.send_header("Content-Type", "application/xml")
            self.send_header("Content-Disposition",
                             'attachment; filename="%s"' % name)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            return self.wfile.write(data)
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self._send(400, {"error": "bad JSON"})
        try:
            if self.path == "/api/author":
                sid = uuid.uuid4().hex[:12]
                spec, report = _build_from_source(sid, payload)
                return self._send(200, _emit(sid, spec, report))
            if self.path == "/api/apply":
                return self._send(200, self._apply(payload))
            if self.path == "/api/replay":
                sess = SESSIONS.get(payload.get("session"))
                if not sess:
                    return self._send(404, {"error": "no such session"})
                result = jmxgen.replay(sess["jmx"], quiet=True)
                result.pop("dir", None)
                return self._send(200, result)
            if self.path == "/api/ship":
                return self._send(200, self._ship(payload))
        except ValueError as exc:
            return self._send(400, {"error": str(exc)})
        except Exception as exc:                       # noqa: BLE001 - surface it
            traceback.print_exc()
            return self._send(500, {"error": "%s: %s" % (type(exc).__name__, exc)})
        return self._send(404, {"error": "not found"})

    def _apply(self, payload):
        sess = SESSIONS.get(payload.get("session"))
        if not sess:
            raise ValueError("no such session")
        spec = sess["spec"]
        reverted = 0
        reject = payload.get("reject_vars") or []
        if reject:
            spec, reverted = jmxgen.uncorrelate(spec, sess["correlations"], reject)
        for key in ("threads", "ramp_up", "duration"):
            if payload.get(key):
                for tg in spec.get("thread_groups", []):
                    tg[key] = int(payload[key])
                    if key == "duration":
                        tg.pop("loops", None)
        if payload.get("drop_steps"):
            drop = set(payload["drop_steps"])
            _prune_steps(spec, drop)
        out = _emit(payload["session"], spec,
                    {"mode": "edited", "correlated":
                     [c for c in sess["correlations"] if c["var"] not in set(reject)]})
        out["reverted"] = reverted
        return out

    def _ship(self, payload):
        """Create the project, upload every file, trigger the job.

        Deliberately stops at trigger: monitoring and artifact download belong to
        the HyperExecute dashboard, and holding an HTTP request open for a
        30-minute load test is the wrong shape.
        """
        hx = _load("hyperexecute_automation", "hyperexecute_automation.py")
        if hx is None:
            raise ValueError("hyperexecute_automation.py is not next to this file")

        # strip both sources: a key pasted with a trailing newline makes every
        # call fail with a 401 that looks exactly like a wrong key
        user = (payload.get("username") or os.environ.get("LAMBDATEST_USERNAME") or "").strip()
        key = (payload.get("access_key") or os.environ.get("LAMBDATEST_ACCESS_KEY") or "").strip()
        if not user or not key:
            raise ValueError("LambdaTest username and access key are required")

        # --- gather every file that has to reach the project -----------------
        sid = payload.get("session")
        files, primary = [], (payload.get("primary_jmx") or "").strip()
        sess = SESSIONS.get(sid)
        if sess and payload.get("include_generated", True):
            named = os.path.join(_session_dir(sid),
                                 _safe_jmx_name(payload.get("jmx_name")))
            if os.path.abspath(named) != os.path.abspath(sess["jmx"]):
                shutil.copyfile(sess["jmx"], named)
            files.append(named)
            if not primary:
                primary = os.path.basename(named)
        for up in payload.get("files") or []:
            name = os.path.basename(up.get("name") or "")
            if not name or not up.get("content"):
                continue
            path = _write_upload(sid or "hx", name, up["content"])
            files.append(path)
            if not primary and name.lower().endswith(".jmx"):
                primary = name
        if not files:
            raise ValueError("nothing to upload - generate a plan or add a file")
        if not primary:
            raise ValueError("choose which .jmx the job should run")

        # --- validate the run config BEFORE creating anything, so a typo in the
        # --- region list cannot leave an orphan project behind ---------------
        def num(key_):
            v = payload.get(key_)
            if v in (None, "", []):
                return None
            try:
                return int(v)
            except (TypeError, ValueError):
                raise ValueError("%s must be a whole number, got %r" % (key_, v))

        trigger = payload.get("trigger", True)
        nums = {k: num(k) for k in ("duration", "rampup", "vusers", "max_vusers_per_vm",
                                    "global_timeout", "concurrency")}
        regions = [r.strip() for r in (payload.get("regions") or "").replace(",", " ").split()
                   if r.strip()]
        if trigger and not regions:
            raise ValueError("pick at least one region")

        # `-e -o <dir>` is what produces the HTML dashboard that HyperExecute
        # collects as an artifact, so it is always sent. Extra flags are passed
        # through, but the trigger API validates them and rejects -J outright.
        report_dir = (payload.get("report_dir") or "report").strip() or "report"
        extra = payload.get("extra_jmeter_args")
        extra = shlex.split(extra) if isinstance(extra, str) else list(extra or [])
        bad = [a for a in extra if a.startswith("-J") or a.startswith("-D")]
        if bad:
            raise ValueError(
                "HyperExecute rejects %s in the args array - put the property in "
                "user.properties and upload it with the plan" % ", ".join(bad))
        report_args = hx.HyperExecuteAPI.build_report_args(report_dir=report_dir,
                                                           extra_args=extra or None)

        # --- project ---------------------------------------------------------
        api = hx.HyperExecuteAPI(user, key, (payload.get("project_id") or "").strip() or None,
                                 debug=bool(payload.get("debug")))
        created = False
        if not api.project_id:
            name = (payload.get("project_name") or "").strip()
            if not name:
                raise ValueError("give a project name, or an existing project id")
            pid = api.create_project(name, payload.get("project_type") or "jmeter")
            if not pid:
                raise ValueError(api.last_error or
                                 "could not create the project - check the credentials")
            api.project_id = pid
            created = True

        if not api.upload_files(files):
            raise ValueError(api.last_error or
                             "upload failed - see the console log for the response")

        out = {"project_id": api.project_id, "created": created,
               "uploaded": [os.path.basename(f) for f in files],
               "primary_jmx": primary,
               "project_url": "https://hyperexecute.lambdatest.com/hyperexecute/projects"}
        if not trigger:
            out["note"] = "uploaded; not triggered"
            return out

        # --- trigger ---------------------------------------------------------
        job_id = api.trigger_job(
            regions=regions,
            jmx_path=primary,
            duration=nums["duration"],
            rampup=nums["rampup"],
            vusers=nums["vusers"],
            platform=(payload.get("platform") or "").strip() or None,
            max_vusers_per_vm=nums["max_vusers_per_vm"],
            global_timeout=nums["global_timeout"],
            concurrency=nums["concurrency"] or 1,
            splitcsv=bool(payload.get("splitcsv")),
            job_label=(payload.get("job_label") or "").strip() or None,
            report_args=report_args,
            report_dir=report_dir,
        )
        if not job_id:
            raise ValueError(api.last_error or
                             "trigger failed - see the console log for the response")
        out["job_id"] = job_id
        out["job_url"] = "https://hyperexecute.lambdatest.com/hyperexecute/job/%s" % job_id
        return out


def _prune_steps(spec, drop_names):
    def walk(steps):
        out = []
        for st in steps:
            if "steps" in st:
                st["steps"] = walk(st["steps"])
                if st["steps"]:
                    out.append(st)
                continue
            if st.get("name") in drop_names:
                continue
            out.append(st)
        return out
    for tg in spec.get("thread_groups", []):
        tg["steps"] = walk(tg.get("steps", []))


def _who_holds(port):
    """Best-effort name of the process on the port, so the fix is obvious."""
    try:
        out = subprocess.run(["lsof", "-nP", "-iTCP:%d" % port, "-sTCP:LISTEN"],
                             capture_output=True, text=True, timeout=3).stdout
        rows = [l.split() for l in out.splitlines()[1:] if l.split()]
        if rows:
            return " (%s, pid %s - stop it with: kill %s)" % (rows[0][0], rows[0][1], rows[0][1])
    except Exception:
        pass
    return ""


IDLE_MINUTES = 60          # a forgotten console should not hold the port forever


class _V6Server(ThreadingHTTPServer):
    address_family = socket.AF_INET6


def main():
    port = int(os.environ.get("PORT", 8770))
    # "localhost" resolves to ::1 first on macOS and Windows, so an IPv4-only
    # bind is refused by the browser and the extension. Serve both loopbacks.
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError as e:
        if e.errno not in (48, 98, 10048):     # EADDRINUSE on mac / linux / windows
            raise
        holder = _who_holds(port)
        sys.stderr.write(
            "\nport %d is already in use%s\n"
            "  a console is probably still running - reuse it at http://localhost:%d\n"
            "  or start this one somewhere else:  jmxgen console --port %d\n"
            % (port, holder, port, port + 1))
        return 1
    servers = [srv]
    try:
        servers.append(_V6Server(("::1", port), Handler))
    except OSError:
        pass                                   # no IPv6 on this box - IPv4 is enough
    for extra in servers[1:]:
        threading.Thread(target=extra.serve_forever, daemon=True).start()

    idle = int(os.environ.get("IDLE_TIMEOUT", IDLE_MINUTES))
    print("jmxgen console  ->  http://localhost:%d" % port, flush=True)
    print("  (ctrl-c to stop%s)"
          % ("" if idle <= 0 else "; stops on its own after %d min idle" % idle),
          flush=True)

    # Whatever ends this process - ctrl-c, `kill`, closing the terminal, or the
    # idle timer - the listening sockets must be closed, or the next start hits
    # "address already in use" against a console nobody is using any more.
    done = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        try:
            signal.signal(sig, lambda *_: done.set())
        except (ValueError, AttributeError, OSError):
            pass                               # not the main thread, or no SIGHUP

    if idle > 0:
        def _watch_idle():
            while not done.wait(20):
                if time.time() - Handler.last_seen > idle * 60:
                    print("\nidle for %d min - stopping and releasing port %d"
                          % (idle, port), flush=True)
                    done.set()
        threading.Thread(target=_watch_idle, daemon=True).start()

    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        done.wait()
    except KeyboardInterrupt:
        pass
    finally:
        for s_ in servers:
            s_.shutdown()                      # stop accepting
            s_.server_close()                  # and actually release the port
        shutil.rmtree(os.path.join(tempfile.gettempdir(), "jmxgen-console"),
                      ignore_errors=True)
        print("stopped - port %d released" % port, flush=True)


if __name__ == "__main__":
    main()
