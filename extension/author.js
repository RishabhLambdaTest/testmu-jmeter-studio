/* Authoring from the extension.
 *
 * The engine runs here, in WebAssembly, so every source in the dropdown works
 * with nothing installed. A local console is optional and buys exactly one
 * thing: Validate, which needs a real JMeter binary to run the plan once.
 */

const $ = (id) => document.getElementById(id);
const DEFAULT_ENDPOINT = "http://localhost:8770";
/* [storage key, element id]. realThink moved key when its default became on,
   so an "off" saved by an older build is not inherited silently. */
const CHECKS = [["realThink2", "realThink"], ["noCorrelate", "noCorrelate"]];
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
  // realThink is stored under a new key: it used to default to off, and a
  // saved "off" from before would otherwise keep handing people a plan with no
  // pacing, which is the setting this rename exists to stop inheriting.
  CHECKS.forEach(([key, id]) => { if (v[key] !== undefined) $(id).checked = v[key]; });
  if (!$("endpoint").value) $("endpoint").value = DEFAULT_ENDPOINT;
}

async function save() {
  const out = {};
  KEYS.forEach((k) => { if ($(k)) out[k] = $(k).value; });
  CHECKS.forEach(([key, id]) => out[key] = $(id).checked);
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
  ltsession: { label: "TestMu AI session (session id)", input: "text" },
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
    $("mode").value === "urls" ? "One URL per line" :
    $("mode").value === "ltsession" ? "Session id from the automation dashboard" : "Input";
  // filters only bite on sources that carry more than you asked for
  $("filters").hidden = !["har", "urls", "ltsession"].includes($("mode").value);
  // think times only exist in a recording, and they are the difference between
  // a load test and a spin loop, so the control sits with the load profile
  // rather than folded away under filters
  $("thinkRow").hidden = !["har", "ltsession"].includes($("mode").value);
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


/* ---- TestMu AI session -------------------------------------------------
   The session's own recording becomes a HAR the engine already knows how to
   author from, so nothing downstream changes. Credentials are the ones the
   run page already stores - the same LambdaTest account. */
async function sessionToEngine(sid) {
  const got = await chrome.storage.local.get("hxForm");
  const saved = (got && got.hxForm) || {};
  const user = (saved.user || "").trim();
  const key = (saved.key || "").trim();
  if (!user || !key) {
    throw new Error("no credentials saved - open Run on HyperExecute, " +
                    "fill in your username and access key, and tick Remember");
  }
  const out = await window.LT.ltSessionHar(user, key, sid, {
    log: (m) => addLog("info", m),
    maxBytes: 120 * 1048576,
    onProgress: (done, total, seen) =>
      say(`reading capture ${done}/${total} (${seen} requests)`, "info"),
  });
  addLog("info", `keeping ${out.kept} of ${out.total} request(s) from ${out.host}`);
  const others = out.hosts.filter((h) => h.host !== out.host).slice(0, 4)
    .map((h) => `${h.host} (${h.n})`).join(", ");
  if (others) addLog("info", "other hosts seen, left out: " + others);
  if (!out.named) {
    addLog("info", "this session had no step annotations, so steps came from navigations");
  }

  const sink = await window.JmxgenEngine.openInput("session.har");
  sink.write(JSON.stringify(out.har));
  const { path } = sink.close();
  return { path, info: out };
}


/* ---- will this plan survive being scaled? ------------------------------
   A converted session is nobody's hand-written plan, so the checks that used
   to live only in the console run here and say what they found. */
const SAMPLER_BUDGET = 300;

async function reportScale(data, nreq) {
  if (nreq > SAMPLER_BUDGET) {
    addLog("bad", `${nreq} samplers: past about ${SAMPLER_BUDGET} the plan tree ` +
      "itself becomes the memory cost on every thread. Narrow the host, tighten " +
      "Keep, or split the journey before running this at load.");
  }
  if (!data.jmx) return;
  try {
    const out = await window.JmxgenEngine.lint(data.jmx);
    (out.notes || []).forEach((n) => addLog("info", n));
    (out.issues || []).forEach((i) => addLog("bad", i));
    if (!(out.issues || []).length) {
      addLog("good", "scale checklist: nothing that would blow up the runner");
    }
  } catch (e) {
    addLog("info", "the scale checklist could not run: " + (e.message || e));
  }
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

  if (mode === "ltsession") {
    const sid = body.text.trim();
    if (!sid) return say("paste a session id first", "bad");
    $("go").disabled = true;
    say("fetching the session's recording...", "info");
    try {
      const { path } = await sessionToEngine(sid);
      body.mode = "har";                 // it is a recording from here on
      body.text = "";
      body.file = { name: "session.har", path };
    } catch (e) {
      $("go").disabled = false;
      const extra = e.guidance ? " " + e.guidance : "";
      addLog("bad", e.message + extra);
      return say(e.message + extra, "bad");
    }
  } else if (FROM_RECORDING) {
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
    const nreq = (data.steps || []).filter((s) => s.method !== "webdriver").length;
    await reportScale(data, nreq);
    addLog("ok", `plan built - ${nreq} request(s), ${data.size_kb} KB, ` +
                 `${(data.correlations || []).length} correlated`);
    for (const w of (data.verify && data.verify.warnings) || []) addLog("warn", w);
    for (const e of (data.verify && data.verify.errors) || []) addLog("error", e);
    render();
    say("plan ready - " + nreq + " request(s), " +
        data.size_kb + " KB", "ok");
  } catch (e) {
    addLog("error", String(e.message || e));
    say(String(e.message || e), "err");
  } finally {
    $("go").disabled = false;
  }
};

/* ---- editing the plan --------------------------------------------------
   Every edit is applied to the spec and the plan is rebuilt from it, so an
   edited plan is exactly what the spec says and goes through the same checks
   as a freshly authored one. The verbs are the ones the recording panel
   already uses, so there is nothing new to learn here. */

/* A plan you cannot read is a plan you cannot edit with any confidence, so the
   inspector opens with the request itself: what this sampler will send. */
function requestDetail(step) {
  const rows = [];
  if (step.url) rows.push(["URL", step.url]);
  for (const [k, v] of Object.entries(step.headers || {})) rows.push([k, v]);
  for (const [k, v] of Object.entries(step.params || {})) rows.push([k + " (param)", v]);
  const head = rows.map(([k, v]) =>
    `<div class="dl"><span class="k">${esc(k)}</span><span class="v mono">${esc(v)}</span></div>`).join("");
  const body = step.body
    ? `<pre class="reqbody mono">${esc(step.body)}</pre>` : "";
  if (!head && !body) return '<p class="hint nodetail">This step carries no request detail.</p>';
  return `<div class="detail">${head}${body}</div>`;
}

let INSPECTED = null;

function closeInspector() {
  const open = document.querySelector(".inspector");
  if (open) open.remove();
  INSPECTED = null;
}

function openInspector(tr) {
  if (INSPECTED === tr) return closeInspector();
  closeInspector();
  INSPECTED = tr;
  const at = tr.dataset.at;
  const step = planSteps()[Number(tr.dataset.i)] || {};
  const row = document.createElement("tr");
  row.className = "inspector";
  row.innerHTML = `<td colspan="6">
    ${requestDetail(step)}
    <div class="insp">
      <button data-op="rename">Rename…</button>
      <button data-op="assert">Assert 200</button>
      <button data-op="assertText">Assert text…</button>
      <button data-op="extract">Extract…</button>
      <button data-op="pause">Pause 1s</button>
      <button data-op="substitute">Replace value…</button>
      <button data-op="up">Move up</button>
      <button data-op="down">Move down</button>
      <button data-op="delete" class="warn">Delete</button>
    </div></td>`;
  tr.after(row);
  row.querySelectorAll("button").forEach((b) =>
    b.onclick = (e) => { e.stopPropagation(); runEdit(b.dataset.op, JSON.parse(at)); });
}

async function runEdit(op, at) {
  let edit = { op, at };
  if (op === "rename") {
    const v = prompt("Name for this request");
    if (!v) return;
    edit.value = v;
  } else if (op === "assertText") {
    const v = prompt("The response body must contain");
    if (!v) return;
    edit = { op: "assert", at, value: v };
  } else if (op === "extract") {
    const q = prompt("JSONPath to extract, for example $.data.token");
    if (!q) return;
    const v = prompt("Variable name");
    if (!v) return;
    edit = { op: "extract", at, value: q, var: v };
  } else if (op === "substitute") {
    const v = prompt("The value to replace, exactly as it appears above");
    if (!v) return;
    const name = prompt("Variable name to use instead");
    if (!name) return;
    edit = { op: "substitute", at, value: v, var: name };
  } else if (op === "pause") {
    edit.value = 1000;
  } else if (op === "delete") {
    if (!confirm("Remove this request from the plan?")) return;
  }

  closeInspector();
  say("rebuilding…", "info");
  try {
    const data = await JmxgenEngine.rebuild(STATE.spec_json, null, [edit]);
    applyRebuild(data, op);
  } catch (e) {
    addLog("error", String(e.message || e));
    say(String(e.message || e), "err");
  }
}

/* A rebuild returns a whole plan, so the page updates the same way it does
   after authoring - including the warnings, which is how deleting a request
   another one depends on becomes visible rather than silent. */
function applyRebuild(data, what) {
  /* What matters after an edit is not how many problems the plan has, but
     which ones it did not have a moment ago. Deleting a request that another
     one extracts a token from leaves a plan that still builds and still runs,
     and fails at load with a wall of 401s - so a new warning has to be as loud
     as an error here, or the editor becomes a way to break a plan quietly. */
  const was = STATE.verify || {};
  const beforeW = new Set((was.warnings || []));
  const beforeE = new Set((was.errors || []));
  const now = data.verify || {};
  const newW = (now.warnings || []).filter((w) => !beforeW.has(w));
  const newE = (now.errors || []).filter((e) => !beforeE.has(e));

  STATE = Object.assign({}, STATE, data);
  newW.forEach((w) => addLog("warn", w));
  newE.forEach((e) => addLog("error", e));
  render();

  const note = (data.notes || []).join(" · ");

  if (newE.length) {
    say(`${what} applied, and the plan now has an error: ${newE[0]}`, "err");
    showTab("checks");   // an error means the plan is broken: go and look
  } else if (newW.length) {
    /* A warning does not move you off the table you are working in. The
       message says what happened, and substitution has a specific next step:
       a variable that nothing defines yet is expected, not a mistake. */
    const nudge = what === "substitute"
      ? " - define it under Test data, or with Extract on an earlier request."
      : "";
    say(`${note || what + " applied"} - but ${newW[0]}${nudge}`, "warn");
  } else if (note) {
    say(note, "ok");
  } else {
    say(`${what} applied`, "ok");
  }
}

/* The spec editor: one control that reaches everything the engine builds,
   instead of a field per feature on a form most people never scroll past. */
$("specApply").onclick = async () => {
  const yaml = $("specYaml").value.trim();
  if (!yaml) return say("the spec is empty", "err");
  say("regenerating…", "info");
  try {
    const data = await JmxgenEngine.rebuildYaml(yaml);
    applyRebuild(data, "spec");
  } catch (e) {
    addLog("error", String(e.message || e));
    say("the spec could not be used: " + (e.message || e), "err");
  }
};

/* ---- results ----------------------------------------------------------- */

/* What the .jmx actually carries. A recorded browser step is a click, not a
   request: it ships in the Playwright script, so it is neither a sampler nor
   something to count as one. */
function planSteps() {
  return (STATE.steps || []).filter((s) => s.method !== "webdriver");
}

function render() {
  $("results").hidden = false;
  const v = STATE.verify || {};
  const cards = [
    ["requests", planSteps().length],
    ["correlated", (STATE.correlations || []).length],
    ["size", STATE.size_kb + " KB"],
    ["errors", (v.errors || []).length],
    ["warnings", (v.warnings || []).length],
  ];
  $("cards").innerHTML = cards.map(([k, n]) =>
    `<div class="card"><div class="n">${esc(n)}</div><div class="k">${k}</div></div>`).join("");
  if (!$("planName").value) $("planName").value = "plan.jmx";

  if (STATE.spec_yaml && document.activeElement !== $("specYaml")) {
    $("specYaml").value = STATE.spec_yaml;
  }
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
    // Browser steps are not in the .jmx - they leave as the Playwright script -
    // so listing them here as if they were samplers overstates the plan.
    const rows = planSteps().map((s, i) =>
      `<tr class="steprow" data-i="${i}" data-at="${esc(JSON.stringify(s.at || []))}">
       <td>${esc(s.group || "")}</td><td class="mono">${esc(s.method || "")}</td>
       <td class="mono">${esc(s.name || s.path || "")}</td>
       <td>${esc(s.asserts == null ? "" : s.asserts)}</td>
       <td>${esc(s.think_time == null ? "" : s.think_time + " ms")}</td>
       <td class="edit">edit</td></tr>`).join("");
    el.innerHTML = rows
      ? `<p class="hint tablehint">Click any request to see what it sends, and to
           rename it, assert on it, extract a value, replace a value with a
           variable, reorder it or remove it.</p>` +
        `<table><thead><tr><th>Group</th><th>Method</th><th>Request</th><th>Checks</th>` +
        `<th>Think</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
      : '<div class="empty">No requests in this plan.</div>';
    el.querySelectorAll(".steprow").forEach((tr) =>
      tr.onclick = () => openInspector(tr));
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
  /* Only invite someone to untick something when there is a list to untick.
     A single transaction renders no rows, so the instruction pointed at empty
     space and read like a control that had failed to load. */
  $("segSummary").textContent = txs.length > 1
    ? `${n} request(s) on disk across ${txs.length} transaction(s). ` +
      `Untick what this plan should leave out.`
    : `${n} request(s) on disk, in one unnamed group. Set a Transaction in ` +
      `the panel while recording to split the next one into named steps.`;
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
