/* Authoring from the extension.
 *
 * The engine runs here, in WebAssembly, so every source in the dropdown works
 * with nothing installed. A local console is optional and buys exactly one
 * thing: Validate, which needs a real JMeter binary to run the plan once.
 */

const $ = (id) => document.getElementById(id);
const DEFAULT_ENDPOINT = "http://localhost:8770";
const KEYS = ["mode", "traffic", "methods", "include", "exclude", "loginPath",
              "loginBody", "loginToken", "csvFile", "csvCols", "threads", "ramp",
              "dur", "endpoint", "planName"];

let MODES = {};
let STATE = null;          // the last /api/author response
let FILE = null;           // {name, content} of the picked file
let FROM_RECORDING = false;  // author from what the recorder left on disk

const base = () => ($("endpoint").value.trim() || DEFAULT_ENDPOINT).replace(/\/+$/, "");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function say(text, kind) {
  const m = $("msg");
  m.textContent = text;
  m.className = "msg show " + (kind || "info");
}

/* ---- persistence ------------------------------------------------------- */

async function load() {
  const saved = await chrome.storage.local.get("jmxgen.author");
  const v = saved["jmxgen.author"] || {};
  KEYS.forEach((k) => { if (v[k] !== undefined && $(k)) $(k).value = v[k]; });
  ["realThink", "noCorrelate"].forEach((k) => { if (v[k] !== undefined) $(k).checked = v[k]; });
  if (!$("endpoint").value) $("endpoint").value = DEFAULT_ENDPOINT;
}

async function save() {
  const out = {};
  KEYS.forEach((k) => { if ($(k)) out[k] = $(k).value; });
  ["realThink", "noCorrelate"].forEach((k) => out[k] = $(k).checked);
  await chrome.storage.local.set({ "jmxgen.author": out });
}
document.addEventListener("input", save);


/* ---- log ---------------------------------------------------------------
   One place where everything shows up: engine progress, Python's own output,
   and any traceback. The whole point of running in the extension is that
   nobody should have to open a terminal to find out what went wrong. */
const LOG = [];
function addLog(level, text) {
  const at = new Date();
  LOG.push({ level, text, at });
  const el = $("log");
  if (!el) return;
  const stamp = at.toTimeString().slice(0, 8);
  const line = document.createElement("div");
  line.innerHTML = `<span class="t">${stamp}</span> ` +
                   `<span class="${level}">${esc(text)}</span>`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
  $("logCount").textContent = LOG.length;
}
chrome.runtime.onMessage.addListener((m) => {
  if (m && m.type === "engine-log") addLog(m.level, m.text);
});
$("logCopy").onclick = async () => {
  const text = LOG.map((l) => l.at.toTimeString().slice(0, 8) + "  [" + l.level + "] " + l.text)
                  .join("\n");
  await navigator.clipboard.writeText(text);
  say("log copied - paste it into a bug report", "ok");
};
$("logClear").onclick = () => {
  LOG.length = 0; $("log").innerHTML = ""; $("logCount").textContent = "0";
};
$("logToggle").onclick = (e) => {
  const hidden = document.querySelector(".logwrap").classList.toggle("collapsed");
  e.currentTarget.textContent = hidden ? "show" : "hide";
};

/* ---- where the work happens -------------------------------------------
   The engine runs inside the extension, so nothing needs installing. The local
   console is looked for anyway: it is the only thing that can run JMeter, so
   when it is there Validate works too. */

let CONSOLE_UP = false;

async function ping() {
  const el = $("svc");
  try {
    const r = await fetch(base() + "/api/ping", { cache: "no-store" });
    CONSOLE_UP = r.ok;
  } catch (e) {
    CONSOLE_UP = false;
  }
  $("validate").disabled = !CONSOLE_UP;
  $("validate").title = CONSOLE_UP
    ? "Run the plan once against the real target"
    : "Needs the local console - it is the only thing that can run JMeter";
  if (window.JmxgenEngine && window.JmxgenEngine.isReady()) {
    el.textContent = CONSOLE_UP
      ? "engine ready - local console found, so Validate is available too"
      : "engine ready - everything runs in this extension";
    el.className = "svc up";
  }
  return CONSOLE_UP;
}
$("endpoint").onchange = () => { save(); ping().then(loadModes); };

/* ---- source picker ----------------------------------------------------- */

const BUILTIN_MODES = {
  openapi: { label: "OpenAPI / Swagger", input: "file_or_url", ext: ".yaml,.json" },
  postman: { label: "Postman collection", input: "file", ext: ".json" },
  har:     { label: "Recording (HAR)", input: "file", ext: ".har,.json" },
  curl:    { label: "cURL command(s)", input: "text" },
  excel:   { label: "Excel / CSV sheet", input: "file", ext: ".xlsx,.csv" },
  urls:    { label: "Page URL list (probe)", input: "text" },
  jmx:     { label: "Existing .jmx (import)", input: "file", ext: ".jmx" },
};

async function loadModes() {
  // the list is the engine's, so the dropdown is right whether or not a
  // console is running
  MODES = BUILTIN_MODES;
  const want = $("mode").value;
  $("mode").innerHTML = Object.entries(MODES)
    .map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join("");
  if (MODES[want]) $("mode").value = want;
  // a mode can be requested by the popup: author.html?mode=curl
  const asked = new URLSearchParams(location.search).get("mode");
  if (asked && MODES[asked]) $("mode").value = asked;
  syncInputs();
}

function syncInputs() {
  const m = MODES[$("mode").value] || {};
  const wantsFile = m.input === "file" || m.input === "file_or_url";
  const wantsText = m.input === "text" || m.input === "file_or_url";
  $("inputFile").hidden = !wantsFile;
  $("inputText").hidden = !wantsText;
  $("file").accept = m.ext || "";
  $("textLabel").textContent =
    $("mode").value === "openapi" ? "…or a spec URL" :
    $("mode").value === "curl" ? "Paste one or more curl commands" :
    $("mode").value === "urls" ? "One URL per line" : "Input";
  // filters only bite on sources that carry more than you asked for
  $("filters").hidden = !["har", "urls"].includes($("mode").value);
}
$("mode").onchange = () => { syncInputs(); save(); };

$("file").onchange = async () => {
  const f = ($("file").files || [])[0];
  FILE = f ? { name: f.name, content: await readFile(f) } : null;
};

function readFile(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

/* ---- generate ---------------------------------------------------------- */

$("go").onclick = async () => {
  const mode = $("mode").value;
  const opts = {
    traffic: $("traffic").value,
    methods: $("methods").value.trim(),
    include: $("include").value.trim(),
    exclude: $("exclude").value.trim(),
    real_think_time: $("realThink").checked,
    no_correlate: $("noCorrelate").checked,
    login_path: $("loginPath").value.trim(),
    login_body: $("loginBody").value.trim(),
    login_token: $("loginToken").value.trim(),
    csv_file: $("csvFile").value.trim(),
    csv_columns: $("csvCols").value.trim(),
    threads: $("threads").value.trim(),
    ramp_up: $("ramp").value.trim(),
    duration: $("dur").value.trim(),
  };
  const body = { mode: mode, options: opts, text: $("text").value.trim() };
  if (FROM_RECORDING) {
    // written onto the engine's filesystem, so the payload carries a path
    // rather than the recording itself
    const { path } = await streamRecordingToEngine();
    body.file = { name: "recording.har", path };
  } else if (FILE) {
    body.file = FILE;
  }

  $("go").disabled = true;
  say("generating…", "info");
  addLog("info", "authoring from " + mode);
  try {
    const data = await window.JmxgenEngine.author(body);
    STATE = data;
    STATE.session = null;          // there is no server session to refer to
    addLog("ok", `plan built - ${data.steps.length} request(s), ${data.size_kb} KB, ` +
                 `${(data.correlations || []).length} correlated`);
    for (const w of (data.verify && data.verify.warnings) || []) addLog("warn", w);
    for (const e of (data.verify && data.verify.errors) || []) addLog("error", e);
    render();
    say("plan ready - " + data.steps.length + " request(s), " +
        data.size_kb + " KB", "ok");
  } catch (e) {
    addLog("error", String(e.message || e));
    say(String(e.message || e), "err");
  } finally {
    $("go").disabled = false;
  }
};

/* ---- results ----------------------------------------------------------- */

function render() {
  $("results").hidden = false;
  const v = STATE.verify || {};
  const cards = [
    ["requests", STATE.steps.length],
    ["correlated", (STATE.correlations || []).length],
    ["size", STATE.size_kb + " KB"],
    ["errors", (v.errors || []).length],
    ["warnings", (v.warnings || []).length],
  ];
  $("cards").innerHTML = cards.map(([k, n]) =>
    `<div class="card"><div class="n">${esc(n)}</div><div class="k">${k}</div></div>`).join("");
  if (!$("planName").value) $("planName").value = "plan.jmx";

  const browser = !!STATE.has_browser_steps;
  $("playwright").hidden = !browser;
  $("dualNote").hidden = !browser;
  if (browser) {
    $("dualNote").textContent =
      "This recording carries browser steps too. The .jmx is what scales to " +
      "thousands of users; the browser test drives one real Chromium and " +
      "proves the journey still works.";
  }
  showTab("steps");
}

function showTab(which) {
  document.querySelectorAll(".tabs button").forEach((b) =>
    b.classList.toggle("on", b.dataset.tab === which));
  const el = $("tabbody");
  if (which === "steps") {
    const rows = (STATE.steps || []).map((s) =>
      `<tr><td>${esc(s.group || "")}</td><td class="mono">${esc(s.method || "")}</td>
       <td class="mono">${esc(s.path || "")}</td>
       <td>${esc(s.asserts == null ? "" : s.asserts)}</td>
       <td>${esc(s.think_time == null ? "" : s.think_time + " ms")}</td></tr>`).join("");
    el.innerHTML = rows
      ? `<table><thead><tr><th>Group</th><th>Method</th><th>Path</th><th>Checks</th><th>Think</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<div class="empty">No requests in this plan.</div>';
  } else if (which === "corr") {
    const rows = (STATE.correlations || []).map((c) =>
      `<tr><td class="mono">\${${esc(c.var)}}</td><td>${esc(c.rule || "")}</td>
       <td><span class="pill ${esc(c.confidence || "")}">${esc(c.confidence || "")}</span></td>
       <td class="mono">${esc(c.source_step || c.found_in || "")}</td>
       <td class="mono">${esc(c.value_preview || "")}</td></tr>`).join("");
    el.innerHTML = rows
      ? `<table><thead><tr><th>Variable</th><th>Rule</th><th>Confidence</th><th>From</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<div class="empty">Nothing dynamic was found. Only a recording carries the responses correlation needs.</div>';
  } else {
    const checks = STATE.checks;
    if (!checks) {
      el.innerHTML = '<div class="empty">Press Validate to run the plan once against the real target.</div>';
      return;
    }
    const rows = (checks.samples || []).map((s) =>
      `<tr><td class="mono">${esc(s.label || "")}</td>
       <td><span class="pill ${s.success ? "ok" : "bad"}">${esc(s.code || "")}</span></td>
       <td>${esc(s.assertion || s.message || "")}</td></tr>`).join("");
    el.innerHTML = rows
      ? `<table><thead><tr><th>Request</th><th>Code</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="empty">Nothing ran.${
            checks.reason ? " JMeter said: " + esc(checks.reason) : ""
          }<br />A data file the plan references may be missing beside it, or no thread group is enabled.</div>`;
  }
}
document.querySelectorAll(".tabs button").forEach((b) =>
  b.onclick = () => showTab(b.dataset.tab));

/* ---- what to do with the plan ------------------------------------------ */

/* The plan is already in memory - it never went near a server - so a download
   is a blob, not a fetch. */
function saveText(text, filename, kind) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/octet-stream" }));
  chrome.downloads.download({ url, filename }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
  addLog("ok", "saved " + filename);
  say("saved " + filename + (kind ? " - " + kind : ""), "ok");
}

const stem = () => ($("planName").value.trim() || "plan").replace(/\.[^.]+$/, "");

/* Nothing leaves this page without parsing. jmxGate is a second opinion on top
   of the engine's own verify(): that one reports, this one refuses. */
function gateOrExplain(xml, label) {
  const g = jmxGate(xml, label);
  if (g.ok) return true;
  g.problems.forEach((p) => addLog("error", p));
  say(g.problems[0], "err");
  showTab("checks");
  return false;
}

$("download").onclick = () => {
  if (!STATE) return;
  if (!gateOrExplain(STATE.jmx, "the plan")) return;
  saveText(STATE.jmx, stem() + ".jmx", "");
};

/* One recording yields two artifacts, and the split matters enough to say it
   in the page rather than leave people to discover it: the .jmx carries the
   load, the browser test proves the journey. */
$("taurus").onclick = () =>
  STATE && saveText(STATE.taurus, stem() + ".taurus.yml", "runs under bzt or BlazeMeter");
$("playwright").onclick = () =>
  STATE && saveText(STATE.playwright, stem() + "_browser_test.py",
                    "one browser, functional check");

$("validate").onclick = async () => {
  if (!STATE) return;
  if (!CONSOLE_UP) {
    return say("Validate runs the plan through JMeter, which a browser cannot do. " +
               "Start the local console, or validate by running it on HyperExecute.", "err");
  }
  addLog("info", "replaying once through the local console…");
  $("validate").disabled = true;
  say("running the plan once…", "info");
  try {
    // Validate is the one thing that needs the JMeter binary, so it goes to
    // the local console when one is running. The plan is posted with it: the
    // console has no session for a plan this page built.
    const r = await fetch(base() + "/api/replay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jmx: STATE.jmx, name: stem() + ".jmx" }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
    STATE.checks = data;
    showTab("checks");
    const samples = data.samples || [];
    const bad = samples.filter((s) => !s.success).length;
    if (!samples.length) {
      // A run that executed nothing is not a pass. Both look like an empty
      // failure list, and reporting the wrong one is how a broken plan reaches
      // five hundred users.
      const why = data.reason || "the plan did not execute";
      addLog("error", "validate ran nothing - " + why);
      say("nothing ran - " + why, "err");
    } else if (bad) {
      addLog("error", bad + " of " + samples.length + " request(s) failed");
      say(bad + " request(s) failed - see Checks", "err");
    } else {
      addLog("ok", "validate passed - " + samples.length + " request(s), every variable resolved");
      say("every request passed - " + samples.length + " sampler(s)", "ok");
    }
  } catch (e) {
    say(String(e.message || e), "err");
  } finally {
    $("validate").disabled = false;
  }
};

$("ship").onclick = async () => {
  if (!STATE) return;
  if (!gateOrExplain(STATE.jmx, "the plan")) return;
  // hand the plan over in session storage: it was built in this page, so there
  // is no server session for the run page to look up
  const keyName = "handoff-" + Date.now().toString(36);
  try {
    await chrome.storage.session.set({
      [keyName]: { jmx: STATE.jmx, name: stem() + ".jmx", load: STATE.load || {} },
    });
  } catch (e) {
    // session storage is ten megabytes, and a plan that large is unusual but
    // possible from a long recording kept in web mode
    return say("the plan is too large to hand over - download the .jmx and " +
               "attach it on the run page instead", "err");
  }
  chrome.tabs.create({
    url: chrome.runtime.getURL("run.html") + "?handoff=" + encodeURIComponent(keyName),
    active: true,
  });
};

/* ---- a recording handed over by the popup ------------------------------
   Nothing is handed over, in fact: the recorder writes to IndexedDB and this
   page shares its origin, so it streams the recording straight out of the
   store and into the engine's filesystem. One entry is in memory at a time,
   which is what makes an hour-long session author at all.

   Assets are left behind unless the mode asks for them. An hour of browsing is
   perhaps 40,000 requests of which 3,000 are service calls; there is no reason
   for the other 37,000 to cross into Python only to be discarded there. */
async function streamRecordingToEngine() {
  const wantAssets = $("traffic").value === "web";
  const sink = await window.JmxgenEngine.openInput("recording.har");
  const stats = await CaptureRead.stream(sink.write, {
    skipAssets: !wantAssets,
    only: selectedSegments(),
    collapse: $("collapse").checked,
  });
  const { path, bytes } = sink.close();
  const notes = [];
  if (stats.assets) notes.push(`${stats.assets} assets ${wantAssets ? "kept" : "left out"}`);
  if (stats.repeats) notes.push(`${stats.repeats} repeats collapsed`);
  addLog("ok", `recording read from disk - ${stats.total} captured, ` +
               `${stats.written} sent to the engine` +
               (notes.length ? ` (${notes.join(", ")})` : "") +
               `, ${(bytes / 1e6).toFixed(1)} MB`);
  return { path, stats };
}

/* The transactions you named while recording, with what each one holds. This
   is how a two-hour session becomes a plan someone would run: tick Login,
   Search and Checkout, leave the forty minutes of reading behind. */
async function showSegments() {
  const txs = await CaptureRead.transactions();
  const list = $("segList");
  if (txs.length <= 1) {
    // one transaction is not a choice worth presenting
    list.innerHTML = "";
    $("segSummary").textContent = "";
    return txs;
  }
  list.innerHTML = txs.map((t, i) => `
    <label class="seg">
      <input type="checkbox" class="segbox" value="${esc(t.name)}" checked />
      <span class="name">${esc(t.name)}</span>
      <span class="n">${t.total} requests · ${t.api} not assets</span>
    </label>`).join("");
  return txs;
}

function selectedSegments() {
  const boxes = [...document.querySelectorAll(".segbox")];
  if (!boxes.length) return null;
  const on = boxes.filter((b) => b.checked).map((b) => b.value);
  return on.length === boxes.length ? null : on;    // all of it means no filter
}

async function takeRecording() {
  const q = new URLSearchParams(location.search);
  if (q.get("from") !== "recording") return false;
  const n = await CaptureRead.count();
  if (!n) {
    addLog("warn", "no recording on disk - record again, or pick a HAR file");
    return false;
  }
  FROM_RECORDING = true;
  $("mode").value = "har";
  syncInputs();
  $("segments").hidden = false;
  const txs = await showSegments();
  $("segSummary").textContent =
    `${n} request(s) on disk across ${txs.length} transaction(s). ` +
    `Untick what this plan should leave out.`;
  say(`recording loaded - ${n} request(s) on disk`, "ok");
  addLog("ok", `recording found - ${n} request(s)`);
  return true;
}

/* ---- boot -------------------------------------------------------------- */

(async () => {
  await load();
  await loadModes();
  await ping();                       // console check - cheap, and may fail
  // Boot the engine up front so the first Generate is not the slow one. The
  // status line only becomes accurate once this resolves, so ping again after.
  try {
    await window.JmxgenEngine.boot();
  } catch (e) {
    $("svc").textContent = "the engine failed to start - see the log";
    $("svc").className = "svc down";
    return;
  }
  await ping();

  // only now can anything be generated: the engine is up
  const q = new URLSearchParams(location.search);
  const handed = await takeRecording();
  if (handed && q.get("go") === "1") {
    await $("go").onclick();
    // "Run on HyperExecute" from the popup means: build it, then take me there
    if (STATE && q.get("then") === "hx") $("ship").onclick();
  }
})();

/* Page chrome. These are ordinary tabs, so the controls do what a tab can do. */
const pg = (id) => document.getElementById(id);
if (pg("pgMin")) {
  pg("pgMin").onclick = () => history.length > 1 ? history.back() : window.close();
  pg("pgMax").onclick = (e) => {
    const wide = document.querySelector(".page").classList.toggle("wide");
    e.currentTarget.title = wide ? "Normal width" : "Full width";
  };
  pg("pgClose").onclick = () => window.close();
}
