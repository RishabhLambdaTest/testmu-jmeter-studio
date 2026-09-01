/* Authoring from the extension.
 *
 * Everything here talks to the console's existing HTTP API - /api/modes,
 * /api/author, /api/plan, /api/replay - so the application is untouched. The
 * console stays the engine; this is a second front end for it that happens to
 * live inside the extension, which is what makes the whole flow shareable
 * without asking anyone to switch windows.
 */

const $ = (id) => document.getElementById(id);
const DEFAULT_ENDPOINT = "http://localhost:8770";
const KEYS = ["mode", "traffic", "methods", "include", "exclude", "loginPath",
              "loginBody", "loginToken", "csvFile", "csvCols", "threads", "ramp",
              "dur", "endpoint", "planName"];

let MODES = {};
let STATE = null;          // the last /api/author response
let FILE = null;           // {name, content} of the picked file

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

/* ---- the console has to be up ------------------------------------------ */

async function ping() {
  const el = $("svc");
  try {
    const r = await fetch(base() + "/api/ping", { cache: "no-store" });
    if (!r.ok) throw new Error();
    el.textContent = "jmxgen is running at " + base();
    el.className = "svc up";
    return true;
  } catch (e) {
    el.textContent = "jmxgen is not running - start it with: jmxgen console";
    el.className = "svc down";
    return false;
  }
}
$("endpoint").onchange = () => { save(); ping().then(loadModes); };

/* ---- source picker ----------------------------------------------------- */

async function loadModes() {
  try {
    const r = await fetch(base() + "/api/modes", { cache: "no-store" });
    MODES = await r.json();
  } catch (e) { return; }
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
  if (FILE) body.file = FILE;

  $("go").disabled = true;
  say("generating…", "info");
  try {
    const r = await fetch(base() + "/api/author", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
    STATE = data;
    render();
    say("plan ready - " + data.steps.length + " request(s), " +
        data.size_kb + " KB", "ok");
  } catch (e) {
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

  const browser = (STATE.steps || []).some((s) => s.kind === "webdriver");
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
      : '<div class="empty">No results came back.</div>';
  }
}
document.querySelectorAll(".tabs button").forEach((b) =>
  b.onclick = () => showTab(b.dataset.tab));

/* ---- what to do with the plan ------------------------------------------ */

$("download").onclick = () => {
  if (!STATE) return;
  const name = $("planName").value.trim();
  const url = base() + "/api/plan/" + STATE.session +
              (name ? "?name=" + encodeURIComponent(name) : "");
  chrome.downloads.download({ url: url, filename: name || "plan.jmx" });
  say("saved " + (name || "plan.jmx"), "ok");
};

/* One recording yields two artifacts, and the split matters enough to say it
   in the page rather than leave people to discover it: the .jmx carries the
   load, the browser test proves the journey. */
function saveFrom(path, ext, kind) {
  const stem = ($("planName").value.trim() || "plan").replace(/\.[^.]+$/, "");
  const name = stem + ext;
  chrome.downloads.download({
    url: base() + path + STATE.session + "?name=" + encodeURIComponent(name),
    filename: name,
  });
  say("saved " + name + " - " + kind, "ok");
}

$("taurus").onclick = () => STATE && saveFrom("/api/taurus/", ".taurus.yml",
                                              "runs under bzt or BlazeMeter");
$("playwright").onclick = () => STATE && saveFrom("/api/browser/", "_browser_test.py",
                                                  "one browser, functional check");

$("validate").onclick = async () => {
  if (!STATE) return;
  $("validate").disabled = true;
  say("running the plan once…", "info");
  try {
    const r = await fetch(base() + "/api/replay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: STATE.session }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
    STATE.checks = data;
    showTab("checks");
    const bad = (data.samples || []).filter((s) => !s.success).length;
    say(bad ? bad + " request(s) failed - see Checks" : "every request passed", bad ? "err" : "ok");
  } catch (e) {
    say(String(e.message || e), "err");
  } finally {
    $("validate").disabled = false;
  }
};

$("ship").onclick = () => {
  if (!STATE) return;
  const name = $("planName").value.trim();
  chrome.tabs.create({
    url: chrome.runtime.getURL("run.html") + "?session=" + encodeURIComponent(STATE.session) +
         (name ? "&name=" + encodeURIComponent(name) : ""),
    active: true,
  });
};

/* ---- boot -------------------------------------------------------------- */

(async () => {
  await load();
  await ping();
  await loadModes();
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
