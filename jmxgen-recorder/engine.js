/* The jmxgen engine, running inside the extension.
 *
 * jmxgen.py is loaded verbatim - the same file the CLI runs - on a Python
 * compiled to WebAssembly. There is deliberately no second implementation: a
 * JavaScript port would be a few thousand lines that drift out of step with
 * the Python the moment either side is fixed, which is exactly the trap that
 * bit us when a wire-format fix had to land in one place and be mirrored in
 * another.
 *
 * Two things Python-in-WASM cannot do, and how they are handled:
 *   - sockets      -> HTTP goes out through the page's fetch (see pyFetch)
 *   - subprocesses -> `replay` needs the JMeter binary, so it stays with the
 *                     local console when one is running. Everything else works
 *                     with nothing installed.
 *
 * Every line Python prints is forwarded to the UI, so a failure is read in the
 * extension rather than hunted for in a terminal nobody opened.
 */

const VENDOR = chrome.runtime.getURL("vendor/pyodide/");
let pyodide = null;
let booting = null;

/* ---- log plumbing -----------------------------------------------------
   Python's stdout/stderr, our own progress lines, and any exception all go
   down the same channel and land in the page's Log panel. */
function emit(level, text) {
  chrome.runtime.sendMessage({ type: "engine-log", level, text, at: Date.now() })
    .catch(() => {});   // nobody listening is fine - the log is a convenience
}
const log = (t) => emit("info", t);
const warn = (t) => emit("warn", t);
const fail = (t) => emit("error", t);

/* ---- boot -------------------------------------------------------------- */

async function boot() {
  if (pyodide) return pyodide;
  if (booting) return booting;                 // concurrent callers share one boot
  booting = (async () => {
    const t0 = performance.now();
    log("starting the engine…");

    // The engine lives in the authoring page, not the offscreen document: that
    // document is closed after every HAR download, which would throw away a
    // booted interpreter each time.
    if (typeof loadPyodide !== "function") {
      await new Promise((ok, no) => {
        const s = document.createElement("script");
        s.src = VENDOR + "pyodide.js";
        s.onload = ok; s.onerror = () => no(new Error("could not load pyodide.js"));
        document.head.appendChild(s);
      });
    }

    pyodide = await loadPyodide({
      indexURL: VENDOR,
      stdout: (line) => emit("py", line),
      stderr: (line) => emit("pyerr", line),
    });
    log(`python ready in ${Math.round(performance.now() - t0)}ms`);

    // loadPackage takes wheel URLs directly, so micropip (and its own
    // dependency chain) never has to be shipped
    await pyodide.loadPackage(
      ["PyYAML-6.0.1-cp312-cp312-pyodide_2024_0_wasm32.whl",
       "et_xmlfile-2.0.0-py3-none-any.whl",
       "openpyxl-3.1.5-py2.py3-none-any.whl"].map((w) => VENDOR + w),
      { messageCallback: () => {} });
    log("yaml and spreadsheet support loaded");

    const src = await (await fetch(chrome.runtime.getURL("jmxgen.py"))).text();
    pyodide.FS.writeFile("/jmxgen.py", src);

    // Python's HTTP is served from a cache the page fills in first. A JS fetch
    // returns a Promise, and jmxgen's fetch sites are ordinary synchronous
    // calls - there is nowhere to await. So anything the engine is about to
    // need is fetched here, then handed over.
    pyodide.registerJsModule("jsbridge", { get: (url) => PREFETCH.get(url) });

    await pyodide.runPythonAsync(`
import sys, io, json
sys.path.insert(0, "/")

import jsbridge
import jmxgen

# _fetch is the single place jmxgen reaches the network (an OpenAPI spec given
# as a URL, and each page a probe walks). Point it at the prefetched cache
# rather than at sockets, which WASM does not have.
def _cached_fetch(url, timeout=20, user_agent=None):
    got = jsbridge.get(url)
    if got is None:
        raise ValueError(
            "%s was not fetched before the engine ran. The browser has to "
            "collect a URL up front - list it as a source rather than having "
            "the plan discover it." % url)
    return got.text, got.contentType

jmxgen._fetch = _cached_fetch
print("jmxgen %s loaded" % getattr(jmxgen, "__version__", ""))
`);
    log(`engine ready in ${Math.round(performance.now() - t0)}ms`);
    return pyodide;
  })();
  try {
    return await booting;
  } catch (e) {
    booting = null;                            // let a later call try again
    fail("engine failed to start: " + (e.message || e));
    throw e;
  }
}

/* ---- prefetch ---------------------------------------------------------- */

const PREFETCH = new Map();

/* Which URLs will this payload make the engine ask for? Only two sources reach
   the network, and both name their URLs up front. */
function urlsNeededBy(payload) {
  const mode = payload.mode;
  const text = (payload.text || "").trim();
  if (mode === "openapi" && /^https?:\/\//i.test(text)) return [text];
  if (mode === "urls") {
    return text.split(/\n+/).map((u) => u.trim()).filter(Boolean)
               .map((u) => (/^https?:\/\//i.test(u) ? u : "https://" + u));
  }
  return [];
}

async function prefetch(payload) {
  for (const url of urlsNeededBy(payload)) {
    if (PREFETCH.has(url)) continue;
    log("GET " + url);
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      PREFETCH.set(url, {
        text: await r.text(),
        contentType: r.headers.get("content-type") || "",
      });
    } catch (e) {
      throw new Error(`could not fetch ${url}: ${e.message || e}`);
    }
  }
}

/* ---- authoring --------------------------------------------------------
   Mirrors the console's /api/author contract exactly, so the pages that
   already speak it need no new shape to learn. */

async function author(payload) {
  const py = await boot();
  await prefetch(payload);
  py.globals.set("_payload", JSON.stringify(payload));
  const out = await py.runPythonAsync(`
import base64, json, os, tempfile, traceback
import jmxgen

payload = json.loads(_payload)
mode = payload.get("mode", "openapi")
opts = payload.get("options") or {}
text = (payload.get("text") or "").strip()
upload = payload.get("file") or {}

path = None
if upload.get("content"):
    d = tempfile.mkdtemp()
    path = os.path.join(d, os.path.basename(upload.get("name") or "input"))
    with open(path, "wb") as fh:
        fh.write(base64.b64decode(upload["content"]))

report = {"mode": mode}
if mode == "openapi":
    src = path or text
    if not src:
        raise ValueError("give an OpenAPI file or a spec URL")
    spec, n = jmxgen.openapi_to_spec(
        src, auth=opts.get("auth") or None, server=opts.get("server") or None,
        include=opts.get("include") or None, exclude=opts.get("exclude") or None)
    report["operations"] = n
elif mode == "postman":
    if not path:
        raise ValueError("upload a Postman collection")
    spec, n = jmxgen.postman_to_spec(path); report["requests"] = n
elif mode == "curl":
    if not text:
        raise ValueError("paste at least one curl command")
    spec, n = jmxgen.curl_to_spec(text); report["requests"] = n
elif mode == "excel":
    if not path:
        raise ValueError("upload a spreadsheet")
    spec = jmxgen.sheet_to_spec(path)
elif mode == "urls":
    urls = [u.strip() for u in text.splitlines() if u.strip()]
    if not urls:
        raise ValueError("give at least one URL")
    spec, st = jmxgen.probe_to_spec(urls, assets=not opts.get("no_assets"),
                                    keep_static=not opts.get("no_static"))
    report.update({"pages": st["pages"], "assets": st["assets"]})
elif mode == "jmx":
    if not path:
        raise ValueError("upload a .jmx")
    spec, counts = jmxgen.jmx_to_spec(path); report.update(counts)
elif mode == "har":
    if not path:
        raise ValueError("upload a HAR")
    spec, info = jmxgen.har_to_spec(
        path, include=opts.get("include") or None, exclude=opts.get("exclude") or None,
        keep_static=bool(opts.get("keep_static")), pages=not opts.get("no_pages"),
        drop_third_party=not opts.get("keep_third_party"),
        correlate=not opts.get("no_correlate"), mode=opts.get("traffic", "auto"),
        methods=opts.get("methods") or None,
        real_think_time=bool(opts.get("real_think_time")),
        rules=jmxgen.load_rules(None))
    report.update({"kept": info["kept"], "total": info["total"],
                   "pages": info["pages"], "correlated": info["correlated"]})
else:
    raise ValueError("unknown mode: %s" % mode)

# options that apply whatever the source was
if opts.get("login_path"):
    p = opts["login_path"].strip()
    method, _, rest = p.partition(" ") if " " in p else ("POST", "", p)
    login = {"var": "AUTH_TOKEN",
             "login": {"method": (method or "POST").upper(), "path": rest or p,
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
        "variables": [c.strip() for c in (opts.get("csv_columns") or "").split(",") if c.strip()]}]
for key in ("threads", "ramp_up", "duration"):
    if opts.get(key):
        for tg in spec.get("thread_groups", []):
            tg[key] = int(opts[key])
            if key == "duration":
                tg.pop("loops", None)

xml = jmxgen.build_plan(spec)
out = tempfile.mkdtemp()
jmx_path = os.path.join(out, "plan.jmx")
open(jmx_path, "w", encoding="utf-8").write(xml)
errors, warnings = jmxgen.verify(jmx_path, quiet=True)

json.dumps({
  "report": report,
  "steps": jmxgen._flatten(spec) if hasattr(jmxgen, "_flatten") else [],
  "verify": {"errors": errors, "warnings": warnings},
  "size_kb": round(len(xml.encode("utf-8")) / 1024.0, 1),
  "spec_yaml": jmxgen.dump_spec(spec, "x.yaml"),
  "correlations": report.get("correlated") or [],
  "load": jmxgen._plan_load(spec) if hasattr(jmxgen, "_plan_load") else {},
  "jmx": xml,
  "taurus": jmxgen.dump_taurus(spec),
  "has_browser_steps": jmxgen.spec_has_browser_steps(spec),
  "playwright": jmxgen.spec_to_playwright(spec, "browser_test.py")
                if jmxgen.spec_has_browser_steps(spec) else "",
  "spec_json": json.dumps(spec),
})
`);
  return JSON.parse(out);
}

/* Re-emit from an edited spec, so the pages can drop steps or reject
   correlations without re-reading the source. */
async function rebuild(specJson, changes) {
  const py = await boot();
  py.globals.set("_spec", specJson);
  py.globals.set("_changes", JSON.stringify(changes || {}));
  const out = await py.runPythonAsync(`
import json, os, tempfile
import jmxgen
spec = json.loads(_spec); changes = json.loads(_changes)
for key in ("threads", "ramp_up", "duration"):
    if changes.get(key):
        for tg in spec.get("thread_groups", []):
            tg[key] = int(changes[key])
xml = jmxgen.build_plan(spec)
d = tempfile.mkdtemp(); p = os.path.join(d, "plan.jmx")
open(p, "w", encoding="utf-8").write(xml)
errors, warnings = jmxgen.verify(p, quiet=True)
json.dumps({"jmx": xml, "verify": {"errors": errors, "warnings": warnings},
            "size_kb": round(len(xml.encode("utf-8")) / 1024.0, 1),
            "taurus": jmxgen.dump_taurus(spec), "spec_json": json.dumps(spec)})
`);
  return JSON.parse(out);
}

/* ---- message routing --------------------------------------------------- */

// Called directly by the page that hosts it; the message listener below is for
// anything else in the extension that wants a plan built.
window.JmxgenEngine = { boot, author, rebuild, isReady: () => !!pyodide };

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "engine") return;
  (async () => {
    try {
      if (msg.type === "engine-boot") return sendResponse({ ok: true, data: (await boot(), true) });
      if (msg.type === "engine-author") return sendResponse({ ok: true, data: await author(msg.payload) });
      if (msg.type === "engine-rebuild")
        return sendResponse({ ok: true, data: await rebuild(msg.spec, msg.changes) });
      sendResponse({ ok: false, error: "unknown engine call: " + msg.type });
    } catch (e) {
      // a Python traceback is the most useful thing we have; keep all of it
      const detail = String(e && e.message ? e.message : e);
      fail(detail);
      sendResponse({ ok: false, error: detail });
    }
  })();
  return true;
});

log("engine host loaded");
