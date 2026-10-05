/* Authoring from the extension.
 *
 * The engine runs here, in WebAssembly, so every source in the dropdown works
 * with nothing installed. Validate .jmx is the one entry that builds nothing:
 * it checks an existing plan's XML (jmxcheck.js).
 */

const $ = (id) => document.getElementById(id);
/* [storage key, element id]. realThink moved key when its default became on,
   so an "off" saved by an older build is not inherited silently. */
const CHECKS = [["realThink2", "realThink"], ["noCorrelate", "noCorrelate"],
                ["randomThink", "randomThink"], ["keepCookies", "keepCookies"],
                ["embedded", "embedded"]];
const KEYS = ["mode", "traffic", "methods", "include", "exclude", "loginPath",
              "loginBody", "loginToken", "csvFile", "csvCols", "threads", "ramp",
              "dur", "planName", "parallel", "rulesText", "testType", "chromePath"];

let MODES = {};
const JMX_UPLOAD_LIMIT = 50 * 1048576;   // HyperExecute's per-.jmx upload limit
let STATE = null;          // the last /api/author response
let FILE = null;           // {name, content} of the picked file
let FROM_RECORDING = false;  // author from what the recorder left on disk
/* Set when the hosts were chosen by hand: the third-party rule would otherwise
   drop the very host that was just ticked. */
let HOSTS_CHOSEN = false;
/* Every edit is a whole spec, so undo is a pointer into a list of them rather
   than an inverse for each operation. Ten deep: enough to get out of a wrong
   turn, small enough that a big plan does not sit in memory ten times over. */
const HISTORY = { past: [], future: [], limit: 10 };

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
   Everything runs inside the extension; there is nothing else to look for. */

function engineStatus() {
  if (window.JmxgenEngine && window.JmxgenEngine.isReady()) {
    $("svc").textContent = "engine ready - everything runs in this extension";
    $("svc").className = "svc up";
  }
}

/* ---- source picker ----------------------------------------------------- */

const BUILTIN_MODES = {
  openapi: { label: "OpenAPI / Swagger", input: "file_or_url", ext: ".yaml,.json" },
  postman: { label: "Postman collection", input: "file", ext: ".json" },
  har:     { label: "Recording (HAR)", input: "file", ext: ".har,.json" },
  curl:    { label: "cURL command(s)", input: "text" },
  excel:   { label: "Excel / CSV sheet", input: "file", ext: ".xlsx,.csv" },
  urls:    { label: "Page URL list (probe)", input: "text" },
  jmx:     { label: "Validate .jmx (check the XML)", input: "file", ext: ".jmx" },
  ltsession: { label: "TestMu AI session (session id)", input: "text" },
};

async function loadModes() {
  // the list is the engine's, built into the extension
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
  $("ltBlock").hidden = $("mode").value !== "ltsession";
  // a session id is one short line, not a paste area
  $("text").rows = $("mode").value === "ltsession" ? 1 : 5;
  $("filters").hidden = !["har", "urls", "ltsession"].includes($("mode").value);
  // think times only exist in a recording, and they are the difference between
  // a load test and a spin loop, so the control sits with the load profile
  // rather than folded away under filters
  $("thinkRow").hidden = !["har", "ltsession"].includes($("mode").value);
  // only a recording carries the clicks a browser test replays
  $("testTypeRow").hidden = !["har", "ltsession"].includes($("mode").value);
  $("chromeRow").hidden = $("testType").value !== "browser";
  $("parallelRow").hidden = !$("embedded").checked;
  // validating builds nothing, so nothing about building applies
  const checking = $("mode").value === "jmx";
  ["optAuth", "optData", "loadBox"].forEach((id) => { $(id).hidden = checking; });
  $("go").textContent = checking ? "Validate .jmx" : "Generate plan";
  $("checkResult").hidden = true;
  if (checking) $("results").hidden = true;
}
$("mode").onchange = () => { syncInputs(); save(); };
$("testType").onchange = () => { syncInputs(); save(); };
// the parallel count only means anything when the resources are fetched
$("embedded").onchange = () => {
  $("parallelRow").hidden = !$("embedded").checked;
  save();
};

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
   author from, so nothing downstream changes. It is read with the signed-in
   TestMu AI account. */
async function sessionToEngine(sid) {
  const { user, key } = AUTH.creds();
  const out = await window.LT.ltSessionHar(user, key, sid, {
    log: (m) => addLog("info", m),
    onProgress: (done, total, seen) =>
      say(`reading capture ${done}/${total} (${seen} requests)`, "info"),
  });
  addLog("info", `keeping ${out.kept} of ${out.total} request(s) from ${out.host}`);
  const others = out.hosts.filter((h) => h.host !== out.host).slice(0, 4)
    .map((h) => `${h.host} (${h.n})`).join(", ");
  if (others) addLog("info", "other hosts seen, left out: " + others);
  addLog("info",
    out.source === "annotations"
      ? "transactions came from the step names the test reported"
      : out.source === "commands"
      ? "the test reported no step names, so transactions came from its WebDriver commands"
      : "no commands were recorded, so transactions came from page navigations");

  const sink = await window.JmxgenEngine.openInput("session.har");
  sink.write(JSON.stringify(out.har));
  const { path } = sink.close();
  if (!out.fullHar) {
    addLog("warn", "this session had no full-har, so the plan is built from network.har: " +
                   "no request or response bodies, so POSTs are sent empty and nothing is correlated");
  }
  return { path, info: out };
}



$("ltLoad").onclick = async () => {
  const { user, key } = AUTH.creds();
  $("ltLoad").disabled = true;
  $("ltHint").textContent = "looking for your recent sessions…";
  try {
    const rows = await window.LT.ltListSessions(user, key, 40);
    if (!rows.length) {
      $("ltHint").textContent = "no sessions on this account yet";
      return;
    }
    $("ltPick").innerHTML = '<option value="">choose a session…</option>' +
      rows.map((r) => {
        const when = (r.when || "").slice(0, 16);
        return `<option value="${esc(r.id)}">${esc(r.name)} — ${esc(r.status || "")} ${esc(when)}</option>`;
      }).join("");
    $("ltHint").textContent = rows.length + " recent session(s). " +
      "Ones run with network.full.har give a complete plan; others give requests without bodies.";
  } catch (e) {
    $("ltHint").textContent = "";
    say(e.message || String(e), "bad");
  } finally {
    $("ltLoad").disabled = false;
  }
};

$("ltPick").onchange = () => {
  if ($("ltPick").value) { $("text").value = $("ltPick").value; save(); }
};

/* ---- will this plan survive being scaled? ------------------------------
   A converted session is nobody's hand-written plan, so these checks run
   here and say what they found. */
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

/* What this is about to cost, before it costs it.
 *
 * A plan carries a sampler per request. Measured: 20,000 requests build a
 * 51 MB plan in about nine seconds, and HyperExecute refuses a .jmx over 50 MB
 * - so the wait produces a file that cannot be used. The size is knowable from
 * the recording before the engine starts, and a question asked first is worth
 * more than a warning printed afterwards. */
async function scaleOkBeforeBuilding() {
  if (!FROM_RECORDING) return true;           // only the recorder knows its size up front
  let n = 0;
  try { n = await CaptureRead.count(); } catch (e) { return true; }
  if (n <= SAMPLER_BUDGET) return true;
  const mb = (n * 2.6 / 1024).toFixed(1);     // ~2.6 KB of plan per request, measured
  /* Said, not asked. A modal in front of the build was the wrong trade: it
     stopped the common case (a long recording someone meant to build) to warn
     about the rare one, and a native confirm() cannot be styled to look like
     the rest of the studio. The number is still worth knowing, so it goes to
     the log, where it does not stand between anyone and their plan. */
  addLog("warn",
    `${n} requests - about ${mb} MB of plan. Past ~${SAMPLER_BUDGET} samplers the ` +
    `tree itself costs memory on every thread, and HyperExecute refuses a .jmx ` +
    `over 50 MB. Traffic filters or fewer transactions will narrow it.`);
  return true;
}

$("go").onclick = async () => {
  const mode = $("mode").value;
  if (!(await scaleOkBeforeBuilding())) return;
  const opts = {
    traffic: $("traffic").value,
    methods: $("methods").value.trim(),
    include: $("include").value.trim(),
    exclude: $("exclude").value.trim(),
    real_think_time: $("realThink").checked,
    randomize_think: $("randomThink").checked,
    keep_cookies: $("keepCookies").checked,
    embedded_resources: $("embedded").checked,
    parallel_downloads: $("parallel").value.trim(),
    no_correlate: $("noCorrelate").checked,
    rules_text: $("rulesText").value.trim(),
    keep_third_party: HOSTS_CHOSEN,
    login_path: $("loginPath").value.trim(),
    login_body: $("loginBody").value.trim(),
    login_token: $("loginToken").value.trim(),
    csv_file: $("csvFile").value.trim(),
    csv_columns: $("csvCols").value.trim(),
    threads: $("threads").value.trim(),
    ramp_up: $("ramp").value.trim(),
    duration: $("dur").value.trim(),
    test_type: $("testTypeRow").hidden ? "api" : $("testType").value,
    chrome_path: $("chromePath").value.trim(),
  };
  const body = { mode: mode, options: opts, text: $("text").value.trim() };

  if (mode === "jmx") return validateJmx();

  let plainHar = false;       // a session read without its bodies
  if (mode === "ltsession") {
    const sid = body.text.trim();
    if (!sid) return say("paste a session id first", "bad");
    $("go").disabled = true;
    say("fetching the session's recording...", "info");
    try {
      const { path, info } = await sessionToEngine(sid);
      plainHar = !info.fullHar;
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
    const nreq = planSteps().length;
    await reportScale(data, nreq);
    addLog("ok", `plan built - ${nreq} request(s), ${data.size_kb} KB, ` +
                 `${(data.correlations || []).length} correlated`);
    for (const w of (data.verify && data.verify.warnings) || []) addLog("warn", w);
    for (const e of (data.verify && data.verify.errors) || []) addLog("error", e);
    render();
    /* A plan the backend will refuse is not ready, whatever else is true. The
       upload limit is per .jmx, so it is said at build time, not at upload. */
    const bytes = new Blob([data.jmx || ""]).size;
    if (bytes > JMX_UPLOAD_LIMIT) {
      const msg = `plan built, but it is ${(bytes / 1048576).toFixed(1)} MB and HyperExecute ` +
                  `takes a .jmx of at most 50 MB - filter the traffic or pick fewer steps`;
      addLog("error", msg);
      say(msg, "err");
    } else if (!plainHar && ((data.report || {}).bodies_missing || (data.report || {}).no_response_bodies)) {
      /* The same failure as a plain network.har, arriving as a file: the HAR
         was saved without bodies. As loud as an error, for the same reason. */
      const r = data.report;
      const what = [
        r.bodies_missing ? `${r.bodies_missing} POST/PUT request(s) were recorded without their body` : "",
        r.no_response_bodies ? "no response carries a body, so nothing could be correlated" : "",
      ].filter(Boolean).join("; ");
      addLog("warn", "this HAR has no bodies: " + what);
      say(`plan built - ${nreq} request(s), but this HAR has no bodies: ${what}. ` +
          `Save the HAR with content, or use a session run with network.full.har: true.`, "err");
    } else if (plainHar) {
      /* As loud as an error: this plan builds and runs, and still cannot log in
         or submit anything, which is the failure people find at load. */
      say(`plan built from network.har only - ${nreq} request(s), but POST bodies are ` +
          `empty and nothing is correlated. Re-run the test with network.full.har: true ` +
          `for a plan that can send data.`, "err");
    } else {
      say("plan ready - " + nreq + " request(s), " +
          data.size_kb + " KB", "ok");
    }
  } catch (e) {
    addLog("error", String(e.message || e));
    say(String(e.message || e), "err");
  } finally {
    $("go").disabled = false;
  }
};

/* ---- Validate .jmx ------------------------------------------------------
   Checks the picked file as it is. No plan is built, so the result is a report
   rather than the Requests table. */
async function validateJmx() {
  const f = ($("file").files || [])[0];
  if (!f) return say("choose a .jmx to validate", "bad");
  $("go").disabled = true;
  $("results").hidden = true;
  $("checkResult").hidden = true;
  STATE = null;
  say(`checking ${f.name}…`, "info");
  addLog("info", `validating ${f.name} (${(f.size / 1048576).toFixed(1)} MB)`);
  try {
    const r = await window.JmxCheck.check(f);
    window.JmxCheck.render($("checkResult"), r);
    r.errors.forEach((e) => addLog("error", e.message));
    (r.parser || []).forEach((p) => addLog("error", p));
    r.warnings.forEach((w) => addLog("warn", w.message));
    if (r.ok) {
      addLog("ok", `${f.name} is valid XML and a JMeter plan`);
      say(r.warnings.length ? `valid, with ${r.warnings.length} warning(s)` : `${f.name} is valid`,
          r.warnings.length ? "warn" : "ok");
    } else {
      say(`${f.name} is not valid - see the report below`, "err");
    }
  } catch (e) {
    addLog("error", String(e.message || e));
    say(String(e.message || e), "err");
  } finally {
    $("go").disabled = false;
  }
}

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
      ${isBrowserTest() ? "" : `<button data-op="assert">Assert 200</button>
      <button data-op="assertText">Assert text…</button>
      <button data-op="extract">Extract…</button>`}
      <button data-op="pause">Pause 1s</button>
      ${isBrowserTest() ? "" : `<button data-op="substitute">Replace value…</button>`}
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

  if (STATE.spec_json && !data.fromHistory) {
    HISTORY.past.push(STATE.spec_json);
    if (HISTORY.past.length > HISTORY.limit) HISTORY.past.shift();
    HISTORY.future.length = 0;
  }
  STATE = Object.assign({}, STATE, data);
  syncHistoryButtons();
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

/* What the .jmx actually carries. In an API test a recorded browser step is a
   click, not a request: it ships in the Playwright script, so it is neither a
   sampler nor something to count as one. A browser test is the reverse - its
   groups are the whole plan. */
const isBrowserTest = () => !!(STATE && (STATE.browser_groups || []).length);
function planSteps() {
  const steps = STATE.steps || [];
  if (isBrowserTest()) {
    const groups = new Set(STATE.browser_groups);
    return steps.filter((s) => groups.has((s.at || [])[0]));
  }
  return steps.filter((s) => s.method !== "webdriver");
}

function render() {
  $("results").hidden = false;
  const v = STATE.verify || {};
  const cards = [
    [isBrowserTest() ? "browser steps" : "requests", planSteps().length],
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
  renderHosts();
  k6Note();
  if (!K6_PROJECTS.length) k6LoadProjects();
  const browser = !!STATE.has_browser_steps;
  $("playwright").hidden = !browser;
  $("dualNote").hidden = !browser;
  if (isBrowserTest()) {
    $("dualNote").textContent =
      "A browser test: each user is a real Chrome running the recorded clicks, " +
      "so HyperExecute runs at most 4 users per engine. For thousands of users, " +
      "build the API test from the same recording.";
  } else if (browser) {
    $("dualNote").textContent =
      "This recording carries browser steps too. The .jmx is what scales to " +
      "thousands of users; to run the clicks in real Chrome, choose Test type: " +
      "Browser and generate again.";
  }
  showTab("steps");
}

function showTab(which) {
  document.querySelectorAll(".tabs button").forEach((b) =>
    b.classList.toggle("on", b.dataset.tab === which));
  const el = $("tabbody");
  if (which === "steps") {
    // The table lists what the .jmx carries: requests in an API test, the
    // recorded clicks in a browser test (planSteps).
    const rows = planSteps().map((s, i) =>
      `<tr class="steprow" data-i="${i}" data-at="${esc(JSON.stringify(s.at || []))}"
           data-find="${esc([s.group, s.method, s.name, s.path].filter(Boolean).join(" ").toLowerCase())}">
       <td>${esc(s.group || "")}</td><td class="mono">${esc(s.method || "")}</td>
       <td class="mono">${esc(s.name || s.path || "")}</td>
       <td>${esc(s.asserts == null ? "" : s.asserts)}</td>
       <td>${esc(s.think_time == null ? "" : s.think_time + " ms")}</td>
       <td class="edit">edit</td></tr>`).join("");
    el.innerHTML = rows
      ? (isBrowserTest()
        ? `<p class="hint tablehint">Each row is one recorded click, run in Chrome.
             Click a row to rename it, add a pause after it, reorder it or remove it.</p>`
        : `<p class="hint tablehint">Click any request to see what it sends, and to
           rename it, assert on it, extract a value, replace a value with a
           variable, reorder it or remove it.</p>`) +
        `<table><thead><tr><th>Group</th><th>Method</th><th>Request</th><th>Checks</th>` +
        `<th>Think</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
      : '<div class="empty">No requests in this plan.</div>';
    el.querySelectorAll(".steprow").forEach((tr) =>
      tr.onclick = () => openInspector(tr));
    if ($("find").value.trim()) applyFind();
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
    if (STATE.replay) return renderReplay(el);
    const v = STATE.verify || {};
    const rows = (v.errors || []).map((e) =>
      `<tr><td><span class="pill bad">error</span></td><td>${esc(e)}</td></tr>`).join("") +
      (v.warnings || []).map((w) =>
      `<tr><td><span class="pill warn">warning</span></td><td>${esc(w)}</td></tr>`).join("");
    el.innerHTML = rows
      ? `<table><thead><tr><th></th><th>What the plan check found</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<div class="empty">The plan check found nothing to report.</div>';
  }
}
document.querySelectorAll(".tabs button").forEach((b) =>
  b.onclick = () => showTab(b.dataset.tab));

/* ---- undo, redo and find ------------------------------------------------ */

function syncHistoryButtons() {
  $("undo").disabled = !HISTORY.past.length;
  $("redo").disabled = !HISTORY.future.length;
}

async function toHistory(from, to, what) {
  const spec = from.pop();
  if (!spec) return;
  to.push(STATE.spec_json);
  say(what + "…", "info");
  try {
    const data = await JmxgenEngine.rebuild(spec, null, []);
    data.fromHistory = true;
    STATE.replay = null;               // the plan changed under it
    applyRebuild(data, what);
    syncHistoryButtons();
  } catch (e) {
    addLog("error", String(e.message || e));
    say(String(e.message || e), "err");
  }
}

$("undo").onclick = () => toHistory(HISTORY.past, HISTORY.future, "undo");
$("redo").onclick = () => toHistory(HISTORY.future, HISTORY.past, "redo");

/* Find filters the table rather than searching the plan: a 600-request plan is
   unreadable otherwise, and the thing you are looking for is a path. */
function applyFind() {
  const q = $("find").value.trim().toLowerCase();
  const rows = document.querySelectorAll("#tabbody tbody tr");
  let shown = 0;
  rows.forEach((tr) => {
    if (tr.classList.contains("inspector")) return;
    // the row shows a short name; the path and its query are what people search
    const hay = (tr.dataset.find || tr.textContent).toLowerCase();
    const hit = !q || hay.includes(q);
    tr.hidden = !hit;
    if (hit) shown++;
  });
  const note = $("findNote");
  if (note) note.textContent = q ? `${shown} of ${rows.length} request(s) match` : "";
}
$("find").oninput = applyFind;

/* ---- replaying the plan once -------------------------------------------
   The pre-flight that used to need JMeter. One user, in order, from this page,
   which holds the host permissions to send the plan's own requests. What it
   finds - a stale value, an extractor that matches nothing - is what a paid
   run would find ten minutes in. */
$("replay").onclick = async () => {
  if (!STATE || !STATE.spec_json) return;
  $("replay").disabled = true;
  STATE.replay = null;
  say("replaying the plan once…", "info");
  addLog("info", "replay: one user, in order");
  try {
    const spec = JSON.parse(STATE.spec_json);
    const out = await window.Replay.run(spec, {
      log: (m) => addLog("info", m),
      onProgress: (n, total, name) => say(`replaying ${n}/${total} - ${name}`, "info"),
    });
    STATE.replay = out;
    const bad = out.samples.filter((s) => !s.ok).length;
    out.samples.forEach((s) => addLog(s.ok ? "ok" : "error",
      `${s.code || "-"} ${s.name}${s.message ? " - " + s.message : ""}`));
    render();
    showTab("checks");     // render() ends on the Requests tab; the result is here
    if (!out.samples.length) {
      say("nothing ran - this plan has no HTTP requests", "err");
    } else if (bad) {
      say(`${bad} of ${out.samples.length} request(s) failed` +
          (out.suggestions.length ? ` - ${out.suggestions.length} value(s) look dynamic, see Checks` : "") +
          (out.skipped ? ` · ${out.skipped} step(s) this replay cannot run` : ""), "err");
    } else {
      say(`every request passed - ${out.samples.length} request(s)` +
          (out.skipped ? ` · ${out.skipped} step(s) skipped` : ""), "ok");
    }
  } catch (e) {
    addLog("error", String(e.message || e));
    say(String(e.message || e), "err");
  } finally {
    $("replay").disabled = false;
  }
};

function renderReplay(el) {
  const r = STATE.replay;
  const rows = r.samples.map((s) =>
    `<tr><td class="mono">${esc(s.name)}</td>
     <td><span class="pill ${s.ok ? "ok" : "bad"}">${esc(s.code || "-")}</span></td>
     <td>${esc(s.message || "")}</td><td class="mono">${s.ms} ms</td></tr>`).join("");
  const sugg = (r.suggestions || []).map((g, i) =>
    `<tr><td><input type="checkbox" data-sugg="${i}" checked /></td>
     <td class="mono">\${${esc(g.var)}}</td>
     <td class="mono">${esc(String(g.value).slice(0, 40))}</td>
     <td>${esc(g.from)} → ${esc(g.into)}</td>
     <td>${esc(g.extract.type)}</td></tr>`).join("");
  el.innerHTML =
    `<table><thead><tr><th>Request</th><th>Code</th><th>What happened</th><th>Time</th></tr></thead>` +
    `<tbody>${rows || '<tr><td colspan="4">nothing ran</td></tr>'}</tbody></table>` +
    (r.skipped ? `<p class="hint">${r.skipped} step(s) are not HTTP, so this replay skipped them rather than counting them as passed.</p>` : "") +
    (sugg ? `<h4>Values that look dynamic</h4>
       <p class="hint tablehint">Each one failed here and was handed out by an earlier
          response in this same replay. Applying adds the extractor and replaces the
          value everywhere it appears.</p>
       <table><thead><tr><th></th><th>Variable</th><th>Value</th><th>From → into</th><th>How</th></tr></thead>
       <tbody>${sugg}</tbody></table>
       <div class="acts"><button id="applySugg">Apply the ticked correlations</button></div>` : "");
  const apply = el.querySelector("#applySugg");
  if (apply) apply.onclick = () => applySuggestions(el);
}

async function applySuggestions(el) {
  const want = [...el.querySelectorAll("input[data-sugg]:checked")]
    .map((b) => STATE.replay.suggestions[Number(b.dataset.sugg)]);
  if (!want.length) return say("tick at least one", "bad");
  const edits = want.map((g) => ({ op: "correlate", at: g.fromAt, var: g.var,
                                   value: g.value, extract: g.extract }));
  say("applying…", "info");
  try {
    const data = await JmxgenEngine.rebuild(STATE.spec_json, null, edits);
    STATE.replay = null;             // the plan changed; the old result is stale
    applyRebuild(data, `${edits.length} correlation(s)`);
    say(`${edits.length} correlation(s) applied - replay again to check`, "ok");
  } catch (e) {
    addLog("error", String(e.message || e));
    say(String(e.message || e), "err");
  }
}

/* ---- which hosts are in the plan ---------------------------------------
   The engine picks the system under test and drops the rest, which is right
   nearly always and wrong the once - a checkout on a payment host, an API on
   its own subdomain. The recording knows every host it saw, so the choice can
   be offered rather than only reported. */
function renderHosts() {
  const hosts = (STATE.report || {}).hosts || [];
  $("hostsWrap").hidden = hosts.length < 2;
  if (hosts.length < 2) return;
  $("hostList").innerHTML = hosts.map((h) =>
    `<label><input type="checkbox" data-host="${esc(h.host)}"${h.kept ? " checked" : ""} />` +
    `<span>${esc(h.host)}</span>` +
    `<span class="n">${h.seen} request(s)${h.kept ? `, <span class="kept">${h.kept} in the plan</span>` : ""}</span></label>`).join("");
  // a long list is scrolled through to find one host; a short one is not
  $("hostFindRow").hidden = hosts.length <= 8;
  filterHosts();
}

/* Hides rows only: a ticked host that is filtered out of view stays ticked. */
function filterHosts() {
  const q = $("hostFind").value.trim().toLowerCase();
  const rows = [...$("hostList").querySelectorAll("label")];
  let shown = 0;
  rows.forEach((l) => {
    const hit = !q || l.querySelector("input").dataset.host.toLowerCase().includes(q);
    l.hidden = !hit;
    if (hit) shown++;
  });
  $("hostFindNote").textContent = q ? `${shown} of ${rows.length} hosts` : `${rows.length} hosts`;
}
$("hostFind").addEventListener("input", filterHosts);

$("hostsApply").onclick = async () => {
  const want = [...$("hostList").querySelectorAll("input:checked")]
    .map((el) => el.dataset.host);
  if (!want.length) return say("tick at least one host", "bad");
  // an include pattern is how the engine already filters; hosts are just a
  // friendlier way to write one
  $("include").value = "^https?://(" + want.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")(/|:|$)";
  $("filters").open = true;
  HOSTS_CHOSEN = true;
  await save();
  await $("go").onclick();
};

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
$("playwright").onclick = () =>
  STATE && saveText(STATE.playwright, stem() + "_browser_test.py",
                    "one browser, functional check");

/* The k6 pair. Two files, because the script carries the journey and the YAML
   carries the job: HyperExecute splits discovered test cases across machines,
   so a script alone would leave every machine but one idle. Both are named
   after the plan, and the note says the arithmetic out loud rather than
   leaving someone to find out that raising concurrency changed nothing. */
/* What the job runs, as the form says rather than as the plan assumed. Blank
   means "whatever the plan already says", so the fields stay empty until
   someone has a reason to disagree with it. */
function k6Settings() {
  const machines = Math.max(1, Number($("k6machines").value) || 1);
  const users = Number($("k6users").value) || (STATE && STATE.load && STATE.load.threads) || 1;
  const failed = $("k6failed").value.trim();
  return {
    machines, users,
    perMachine: Math.max(1, Math.floor(users / machines)),
    ramp: $("k6ramp").value.trim(),
    duration: $("k6duration").value.trim(),
    base: $("k6base").value.trim(),
    // the form asks for a percentage because that is how people say it; k6
    // wants a rate
    maxFailed: failed === "" ? "" : String(Number(failed) / 100),
    maxP95: $("k6p95").value.trim(),
  };
}

function k6Note() {
  if (!STATE || !STATE.k6) return;
  const c = k6Settings();
  const bits = [`${c.users} user(s) over ${c.machines} machine(s): ${c.perMachine} per machine`];
  if (c.users % c.machines) {
    bits.push(`${c.users - c.perMachine * c.machines} left over - raise the users or drop a machine`);
  }
  if (c.ramp) bits.push("ramp " + c.ramp);
  if (c.duration) bits.push("for " + c.duration);
  if (c.base) bits.push("against " + c.base);
  if (c.maxFailed) bits.push(`fails above ${Number(c.maxFailed) * 100}% failed requests`);
  if (c.maxP95) bits.push(`fails above p(95) ${c.maxP95} ms`);
  $("k6note").textContent = bits.join(" · ");
}
["k6users", "k6machines", "k6ramp", "k6duration", "k6base", "k6failed", "k6p95"]
  .forEach((id) => { $(id).oninput = k6Note; });

/* Running k6 on HyperExecute is a different shape from running a .jmx, so it
   stays here rather than going through the run page: a YAML job wants the
   config inline and the script uploaded to a project, where a JMeter job wants
   a plan and a region split. Everything it uses - create, upload, the job link -
   is the same code the run page uses.

   The project list defaults to creating one. A load test fired into a project
   holding somebody's Selenium suite is a mistake worth designing out, so the
   existing ones are filtered to the k6- prefix until asked otherwise. */
const K6_PREFIX = "k6-";
let K6_PROJECTS = [];

async function k6LoadProjects() {
  const sel = $("k6existing");
  try {
    const { user, key } = AUTH.creds();
    K6_PROJECTS = await window.HX.hxListProjects(user, key, () => {}, "custom");
  } catch (e) {
    return;   // the field stays on "create a new one"
  }
  k6FillProjects();
}

function k6FillProjects() {
  const sel = $("k6existing");
  const all = $("k6allprojects").checked;
  const rows = all ? K6_PROJECTS : K6_PROJECTS.filter((p) => p.name.startsWith(K6_PREFIX));
  sel.innerHTML = '<option value="">create a new one</option>' +
    rows.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  $("k6allprojects").parentElement.hidden = K6_PROJECTS.length === rows.length && !all;
}
$("k6allprojects").onchange = k6FillProjects;

$("k6run").onclick = async () => {
  if (!STATE || !STATE.k6) return say("generate a plan first", "bad");
  const btn = $("k6run");
  btn.disabled = true;
  try {
    const { user, key } = AUTH.creds();
    const c = k6Settings();
    const { machines, users, perMachine: per } = c;
    const name = stem() + "_load_test.js";

    let projectId = $("k6existing").value;
    if (!projectId) {
      const wanted = ($("k6project").value.trim() || K6_PREFIX + stem()).slice(0, 60);
      projectId = await window.HX.hxCreateProject(user, key, wanted, "custom", addLog);
    }
    addLog("info", "uploading " + name + "…");
    await window.HX.hxUpload(user, key, projectId,
                             [{ name, content: new Blob([STATE.k6]) }], addLog);

    const shards = Array.from({ length: machines }, (_, i) => String(i + 1));
    const env = [
      ["VUS", per],
      ["RAMP", c.ramp || `${(STATE.load && STATE.load.ramp_up) || 0}s`],
      ["DURATION", c.duration || `${(STATE.load && STATE.load.duration) || 0}s`],
      ["BASE", c.base], ["MAX_FAILED", c.maxFailed], ["MAX_P95", c.maxP95],
    ];
    if (machines > 1) env.push(["SHARD", "$shard"], ["SHARDS", machines]);
    /* k6's own dashboard, written out as a page when the run is long enough
       for it to have something to chart. */
    const cmd = "mkdir -p k6-report && K6_WEB_DASHBOARD=true " +
      "K6_WEB_DASHBOARD_EXPORT=k6-report/index.html k6 run " +
      env.filter(([, v]) => v !== "" && v != null)
         .map(([k, v]) => `-e ${k}=${v}`).join(" ") + ` ${name}`;
    const jobId = await window.HX.hxTriggerYaml(user, key, {
      projectId, machines, shardVar: "shard", shards,
      testSuites: [cmd],
      jobLabel: ["jmeter-studio", "k6"],
    }, addLog);

    const url = window.HX.hxJobUrl(jobId);
    say(`job ${jobId} started - ${users} user(s) over ${machines} machine(s)`, "ok");
    addLog("ok", "job dashboard: " + url);
    $("k6jobLink").innerHTML = `<a href="${esc(url)}" target="_blank" rel="noreferrer">open the job</a>`;
    $("k6jobLink").hidden = false;
  } catch (e) {
    say(e.message || String(e), "bad");
    addLog("err", e.message || String(e));
  } finally {
    btn.disabled = false;
  }
};

$("k6dl").onclick = async () => {
  if (!STATE || !STATE.k6) return say("generate a plan first", "bad");
  const c = k6Settings();
  let yaml = STATE.k6_yaml;
  try {
    // regenerated rather than patched here: the shard list and the machine
    // count are one decision, and the engine already owns it
    yaml = await window.JmxgenEngine.k6Yaml(STATE.spec_json, c);
  } catch (e) {
    return say("could not build the k6 job: " + (e.message || e), "bad");
  }
  saveText(STATE.k6, stem() + "_load_test.js", "");
  saveText(yaml, "hyperexecute.yaml", "the job that runs it");
  addLog("ok", `k6 test and job saved - run it with: k6 run ${stem()}_load_test.js`);
};

$("ship").onclick = async () => {
  // nothing to ship, and saying so beats a button that looks live and does
  // nothing when pressed
  if (!STATE) return say("generate a plan first", "err");
  if (!gateOrExplain(STATE.jmx, "the plan")) return;
  try {
    // the plan the run page uploads, and everything this page is showing, so
    // that Back comes back to the plan rather than to an empty form
    await Pages.putPlan({ jmx: STATE.jmx, name: stem() + ".jmx", load: STATE.load || {} });
    await Pages.putAuthored({ state: STATE, planName: $("planName").value, mode: $("mode").value });
  } catch (e) {
    return say("the plan could not be carried over: " + (e.message || e) +
               " - download the .jmx and attach it on the run page instead", "err");
  }
  // the next step of this page, in this tab and this window. Opening a second
  // page used to strand this one in a window of its own with no way back.
  Pages.goTo("run.html");
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
  spaNote(stats);
  return { path, stats };
}

/* A single-page app records almost nothing a plan can use, and says so only by
 * being small.
 *
 * Clicking through five screens of a React or Docusaurus site produces one page
 * load and then a pile of javascript chunks: the browser never asks the server
 * for the next page, it fetches a bundle and redraws. The capture is right, the
 * plan is right, and the person who just recorded five steps and got one
 * sampler has every reason to think the tool is broken.
 *
 * So when the shape of the recording says single-page app - plenty fetched,
 * almost nothing navigated - it is named, along with the thing actually worth
 * replaying, which is whatever the app calls while it redraws. */
function spaNote(stats) {
  if (typeof stats.documents !== "number") return;
  if (stats.documents > 1 || stats.total < 10) return;
  const api = stats.total - stats.assets - stats.documents;
  const loads = stats.documents === 0
    ? "no page loads at all"
    : "only " + stats.documents + " page load";
  addLog("warn",
    `${stats.total} requests but ${loads} - this ` +
    `looks like a single-page app. Clicking through it does not ask the server ` +
    `for new pages, so there is little for a protocol test to replay. ` +
    (api > 0
      ? `The ${api} API call(s) it made are the part worth testing.`
      : `Record a journey that makes API calls, or build a Browser test to ` +
        `drive the clicks in real Chrome.`));
}

/* The transactions you named while recording, with what each one holds. This
   is how a two-hour session becomes a plan someone would run: tick Login,
   Search and Checkout, leave the forty minutes of reading behind. */
/* What the recording holds, re-read rather than remembered.
 *
 * This line used to be written once, when the page opened, while the recorder
 * banner above it went on counting live. Recording for another minute left two
 * numbers on the same screen disagreeing - "217 captured" over "128 on disk" -
 * with nothing to say that the lower one was simply old. */
let SUMMARY_AT = 0;
async function refreshRecordingSummary() {
  if (!FROM_RECORDING) return;
  SUMMARY_AT = Date.now();
  const n = await CaptureRead.count();
  const txs = await showSegments();
  /* Only invite someone to untick something when there is a list to untick.
     A single transaction renders no rows, so the instruction pointed at empty
     space and read like a control that had failed to load. */
  $("segSummary").textContent = txs.length > 1
    ? `${n} request(s) on disk across ${txs.length} transaction(s). ` +
      `Untick what this plan should leave out.`
    : `${n} request(s) on disk, in one unnamed group. Set a Transaction in ` +
      `the panel while recording to split the next one into named steps.`;
}

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
  return useRecordingOnDisk();
}

/* ---- the recording card -------------------------------------------------
   The popup and this card drive the same recorder in the background, so the
   state shown here is the session's, never this page's idea of it. */
const recSend = (msg) =>
  new Promise((resolve) =>
    chrome.runtime.sendMessage(msg, (r) => resolve(r || { ok: false, error: "no response" })));

function renderRec(st) {
  const live = !!(st && st.recording);
  const paused = !!(st && st.paused);
  const captured = (st && st.count) || 0;
  const waiting = !live && captured > 0 && st && st.unsaved;
  $("recDot").dataset.state = live ? (paused ? "paused" : "live") : waiting ? "done" : "idle";
  $("recState").textContent = live
    ? (paused ? "Paused" : "Recording")
    : waiting ? "Recording stopped" : "Not recording";
  $("recCount").hidden = !(live || waiting);
  $("recCount").textContent = `${captured} request(s) captured`;
  $("recStart").hidden = live || waiting;
  $("recLive").hidden = !live;
  $("recDone").hidden = !waiting;
  $("recPause").textContent = paused ? "Resume" : "Pause";
}

async function recStatus() {
  const r = await recSend({ type: "status" });
  renderRec(r && r.ok ? r.data : null);
  return r && r.ok ? r.data : null;
}

function wireRecCard() {
  $("recGo").onclick = async () => {
    const url = $("recUrl").value.trim();
    if (!url) return say("give a URL to record from", "bad");
    $("recGo").disabled = true;
    const r = await recSend({ type: "startUrl", url });
    $("recGo").disabled = false;
    if (!r.ok) return say(r.error, "bad");
    addLog("ok", "recording " + url + " - browse the journey, then come back and stop");
    say("recording - the panel on that page names transactions", "ok");
    recStatus();
  };
  $("recPause").onclick = async () => {
    const st = await recStatus();
    const r = await recSend({ type: "setPaused", paused: !(st && st.paused) });
    if (!r.ok) return say(r.error, "bad");
    renderRec(r.data);
  };
  $("recStop").onclick = async () => {
    const r = await recSend({ type: "stop" });
    if (!r.ok) return say(r.error, "bad");
    await recStatus();
    buildFromRecording();
  };
  $("recBuild").onclick = () => buildFromRecording();
  $("recDrop").onclick = async () => {
    if (!confirm("Throw this recording away?")) return;
    let r = await recSend({ type: "reset" });
    if (!r.ok) r = await recSend({ type: "reset", force: true });
    await recStatus();
    say(r.ok ? "recording discarded" : r.error, r.ok ? "ok" : "bad");
  };
  // the background tells every open page when the session changes
  chrome.runtime.onMessage.addListener((m) => {
    if (!m || m.type !== "status") return;
    renderRec(m.status);
    // the recorder broadcasts per request; the disk count costs a cursor walk,
    // so it is re-read about once a second, and always once recording stops
    const stopped = !(m.status && m.status.recording);
    if (stopped || Date.now() - SUMMARY_AT > 1000) refreshRecordingSummary();
  });
  recStatus();
}

/* Stop leads straight into authoring: that is what the recording was for. */
async function buildFromRecording() {
  const got = await useRecordingOnDisk();
  if (!got) return say("nothing was captured - record again", "bad");
  say("recording loaded - choose your options, then Generate plan", "ok");
  $("go").scrollIntoView({ behavior: "smooth", block: "center" });
}

/* Adopt whatever the recorder left behind, whether this page was opened by the
   popup with ?from=recording or the recording was started from the card above. */
async function useRecordingOnDisk() {
  const n = await CaptureRead.count();
  if (!n) {
    addLog("warn", "no recording on disk - record again, or pick a HAR file");
    return false;
  }
  FROM_RECORDING = true;
  $("mode").value = "har";
  syncInputs();
  $("segments").hidden = false;
  await refreshRecordingSummary();
  say(`recording loaded - ${n} request(s) on disk`, "ok");
  addLog("ok", `recording found - ${n} request(s)`);
  return true;
}

/* Coming back from the run page. The plan is not rebuilt - it is the one that
   was carried over - so Back costs nothing and loses nothing. */
async function restoreAuthored() {
  let snap = null;
  try { snap = await Pages.readAuthored(); } catch (e) { snap = null; }
  if (!snap || !snap.state) {
    say("the plan from before could not be restored - generate it again", "warn");
    return false;
  }
  STATE = snap.state;
  if (snap.mode) { $("mode").value = snap.mode; syncInputs(); }
  if (snap.planName) $("planName").value = snap.planName;
  render();
  addLog("ok", "back from the run page - showing the plan you built");
  return true;
}

/* ---- boot -------------------------------------------------------------- */

(async () => {
  await load();
  await loadModes();

  /* Back from the run page shows the plan FIRST: before the engine, and before
     the sign-in gate, which does not resolve at all until someone signs in.
     Behind that await, Back was a blank authoring form - the plan was still
     there, nothing on screen said so. */
  const q = new URLSearchParams(location.search);
  const backing = q.get("back") === "1";
  if (backing) await restoreAuthored();

  await AUTH.ready();    // the gate covers the page until someone is signed in
  // Boot the engine up front so the first Generate is not the slow one.
  try {
    await window.JmxgenEngine.boot();
  } catch (e) {
    $("svc").textContent = "the engine failed to start - see the log";
    $("svc").className = "svc down";
    return;
  }
  engineStatus();

  // only now can anything be generated: the engine is up
  wireRecCard();
  if (backing) return;          // the plan is already on screen

  const handed = await takeRecording();
  if (handed && q.get("go") === "1") {
    await $("go").onclick();
    // "Run on HyperExecute" from the popup means: build it, then take me there
    if (STATE && q.get("then") === "hx") $("ship").onclick();
  }
})();

/* Page chrome. The studio can live in its own window (opened from the popup's
   maximise) or in an ordinary tab. In a window these are the real thing:
   minimise and maximise the OS window. In a tab there is nothing to minimise,
   so the closest honest equivalents are used and the titles say so. */
const pg = (id) => document.getElementById(id);
if (pg("pgMin")) {
  window.PageChrome = (function () {
    let own = null;          // the window this page is in, when it is its own
    chrome.windows.getCurrent().then((w) => {
      own = w && w.type === "popup" ? w : null;
      if (!own) {
        pg("pgMin").title = "Back to the previous page";
        pg("pgMax").title = "Full width";
      }
    }).catch(() => {});
    return {
      min: () => own
        ? chrome.windows.update(own.id, { state: "minimized" })
        : (history.length > 1 ? history.back() : window.close()),
      max: (e) => {
        if (own) {
          const to = own.state === "maximized" ? "normal" : "maximized";
          own.state = to;
          return chrome.windows.update(own.id, { state: to });
        }
        const wide = document.querySelector(".page").classList.toggle("wide");
        if (e && e.currentTarget) e.currentTarget.title = wide ? "Normal width" : "Full width";
      },
      close: () => window.close(),
    };
  })();
  pg("pgMin").onclick = () => window.PageChrome.min();
  pg("pgMax").onclick = (e) => window.PageChrome.max(e);
  pg("pgClose").onclick = () => window.PageChrome.close();
}
