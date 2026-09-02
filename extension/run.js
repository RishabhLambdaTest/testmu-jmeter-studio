/* Run on HyperExecute - a full page, not the popup.
 *
 * The popup closes the moment you click anything outside it, so a form holding a
 * typed access key cannot live there: switching tabs to copy the key would throw
 * the whole thing away. This is a real tab, and every field is persisted as you
 * type, so nothing is lost however you leave it. */

const $ = (id) => document.getElementById(id);
const DEFAULT_ENDPOINT = "http://localhost:8770";
const KEYS = ["user", "project", "projectId", "regions",
              "vusers", "maxVusers", "rampup", "duration", "timeout", "label", "planName", "endpoint"];
const CHECKS = ["remember", "splitcsv"];

/* The plan is handed over in session storage rather than by a server session:
   the authoring page built it in-process, so there is no id to look up. */
const HANDOFF = new URLSearchParams(location.search).get("handoff") || null;
let SESSION = new URLSearchParams(location.search).get("session") || null;
let PLAN = null;          // {jmx, name, load} from the authoring page
// the authoring page passes the name already chosen there, so it is not retyped
const WANTED_NAME = new URLSearchParams(location.search).get("name") || "";
let EXTRA = [];
let INCLUDE_GEN = true;

function show(el, text, kind) {
  el.textContent = text;
  el.className = (el.id === "svc" ? "banner show " : "msg show ") + (kind || "info");
}

async function load() {
  const got = await chrome.storage.local.get("hxForm");
  const saved = (got && got.hxForm) || {};
  KEYS.forEach((k) => { if (saved[k] !== undefined) $(k).value = saved[k]; });
  CHECKS.forEach((k) => { if (saved[k] !== undefined) $(k).checked = saved[k]; });
  if (saved.remember !== false && saved.key) $("key").value = saved.key;
  if (!$("regions").value) $("regions").value = "eastus";
  if (!$("maxVusers").value) $("maxVusers").value = "2000";
  if (!$("endpoint").value) $("endpoint").value = DEFAULT_ENDPOINT;
  if (WANTED_NAME) $("planName").value = WANTED_NAME;
  // INCLUDE_GEN is decided in takeHandoff(), which runs after this: at this
  // point PLAN is always still null.
}

async function save() {
  const out = {};
  KEYS.forEach((k) => (out[k] = $(k).value.trim()));
  CHECKS.forEach((k) => (out[k] = $(k).checked));
  if ($("remember").checked) out.key = $("key").value;
  await chrome.storage.local.set({ hxForm: out });
}

const base = () => ($("endpoint").value.trim() || DEFAULT_ENDPOINT).replace(/\/+$/, "");

/* This page talks to HyperExecute directly - an extension with host permissions
   is not subject to CORS - so a missing local console is not an error here. It
   is only worth mentioning because it changes nothing. */
async function ping() {
  show($("svc"), "uploads go straight to HyperExecute - your access key never " +
                 "leaves this machine", "ok");
  return true;
}

function planName() {
  const n = $("planName").value.trim();
  if (!n) return "plan.jmx";
  return /\.jmx$/i.test(n) ? n : n + ".jmx";
}

function row(label, checked, onToggle, note) {
  const l = document.createElement("label");
  l.className = "fchk";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = checked;
  cb.onchange = () => onToggle(cb.checked);
  const s = document.createElement("span");
  s.textContent = label;
  l.appendChild(cb);
  l.appendChild(s);
  if (note) {
    const e = document.createElement("em");
    e.textContent = note;
    l.appendChild(e);
  }
  return l;
}

// every file gets its own tick box, so dropping one does not mean picking the
// whole set again
function renderFiles() {
  const list = $("fileList");
  list.textContent = "";
  const names = [];
  if (SESSION || PLAN) {
    list.appendChild(row(planName(), INCLUDE_GEN, (v) => { INCLUDE_GEN = v; renderFiles(); },
                         "from this recording"));
    if (INCLUDE_GEN) names.push(planName());
  }
  EXTRA.forEach((f, i) => {
    list.appendChild(row(f.name, f.on !== false, (v) => { EXTRA[i].on = v; renderFiles(); }));
    if (f.on !== false) names.push(f.name);
  });
  if (!list.childNodes.length) {
    const s = document.createElement("span");
    s.textContent = (SESSION || PLAN) ? "nothing selected yet"
                            : "no recording handed over - add a .jmx below";
    s.style.opacity = ".6";
    list.appendChild(s);
  }
  const jmx = names.filter((n) => n.toLowerCase().endsWith(".jmx"));
  const keep = $("primary").value;
  $("primary").textContent = "";
  jmx.forEach((n) => {
    const o = document.createElement("option");
    o.textContent = n;
    $("primary").appendChild(o);
  });
  if (jmx.includes(keep)) $("primary").value = keep;
}

const readFile = (f) =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(",")[1]);
    r.onerror = rej;
    r.readAsDataURL(f);
  });

function vmCalc() {
  // HyperExecute takes no machine count - it divides total VU by the per-engine
  // cap, so show what that works out to rather than leaving it implicit
  const vu = parseInt($("vusers").value.trim(), 10);
  const per = parseInt($("maxVusers").value.trim(), 10) || 2000;
  const el = $("vmCalc");
  if (!vu || vu < 1) { el.textContent = ""; return; }
  const vms = Math.ceil(vu / per);
  el.textContent = vu + " users / " + per + " per engine = " + vms +
                   " engine" + (vms === 1 ? "" : "s");
}
["vusers", "maxVusers"].forEach((k) => $(k).addEventListener("input", vmCalc));

// prefill the load from the plan that was handed over, so what is being
// overridden is visible rather than implied
async function prefillLoad() {
  const load = PLAN ? (PLAN.load || {}) : await loadFromConsole();
  if (!load) return;
  {
    if (load.threads && !$("vusers").value) $("vusers").value = load.threads;
    if (load.ramp_up && !$("rampup").value) $("rampup").value = load.ramp_up;
    if (load.duration && !$("duration").value) $("duration").value = load.duration;
    vmCalc();
  }
}

async function loadFromConsole() {
  if (!SESSION) return null;
  try {
    const r = await fetch(base() + "/api/session/" + SESSION, { cache: "no-store" });
    return r.ok ? (await r.json()).load || {} : null;
  } catch (e) { return null; }   // the form still works without it
}

/* Pick up the plan the authoring page put in session storage. */
async function takeHandoff() {
  if (!HANDOFF) return;
  const got = await chrome.storage.session.get(HANDOFF);
  PLAN = got[HANDOFF] || null;
  if (PLAN) {
    await chrome.storage.session.remove(HANDOFF);   // one-shot
    if (PLAN.name) $("planName").value = PLAN.name;
  }
  // only now is it known whether a plan was handed over at all
  INCLUDE_GEN = !!(SESSION || PLAN);
}

$("files").onchange = async () => {
  // add to what is already queued rather than replacing it
  for (const f of Array.from($("files").files || [])) {
    if (!EXTRA.some((x) => x.name === f.name)) {
      EXTRA.push({ name: f.name, content: await readFile(f), on: true });
    }
  }
  $("files").value = "";
  renderFiles();
};
$("endpoint").onchange = () => { save(); ping(); };


/* Extra files arrive base64 from the file picker; HyperExecute wants the bytes. */
function b64ToText(b64) {
  const bin = atob(b64 || "");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function link(href, text) {
  const a = document.createElement("a");
  a.href = href; a.target = "_blank"; a.textContent = "  " + text;
  $("msg").appendChild(a);
}

/* Same log panel as the authoring page: every call, and every failure, visible
   without opening devtools. */
const LOG = [];
function addLog(level, text) {
  const at = new Date();
  LOG.push({ level, text, at });
  const el = $("log");
  if (!el) return;
  const line = document.createElement("div");
  line.innerHTML = `<span class="t">${at.toTimeString().slice(0, 8)}</span> ` +
    `<span class="${level}">${String(text).replace(/[&<>]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</span>`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
  const c = $("logCount"); if (c) c.textContent = LOG.length;
}
if ($("logCopy")) {
  $("logCopy").onclick = async () => {
    await navigator.clipboard.writeText(
      LOG.map((l) => l.at.toTimeString().slice(0, 8) + "  [" + l.level + "] " + l.text).join("\n"));
    show($("msg"), "log copied", "ok");
  };
  $("logClear").onclick = () => { LOG.length = 0; $("log").innerHTML = ""; $("logCount").textContent = "0"; };
  $("logToggle").onclick = (e) => {
    const hidden = document.querySelector(".logwrap").classList.toggle("collapsed");
    e.currentTarget.textContent = hidden ? "show" : "hide";
  };
}

async function submit(trigger) {
  await save();

  const user = $("user").value.trim();
  const key = $("key").value;
  const num = (id) => {
    const v = $(id).value.trim();
    if (!v) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${id} must be a whole number, got "${v}"`);
    return Math.round(n);
  };

  $("go").disabled = $("uploadOnly").disabled = true;
  show($("msg"), trigger ? "creating project, uploading and triggering…" : "uploading…", "info");
  try {
    if (!user || !key) throw new Error("username and access key are both needed");

    // ---- the files ----
    const files = [];
    if (INCLUDE_GEN && PLAN && PLAN.jmx) files.push({ name: planName(), content: PLAN.jmx });
    for (const f of EXTRA.filter((x) => x.on !== false)) {
      files.push({ name: f.name, content: b64ToText(f.content) });
    }
    if (!files.length) throw new Error("nothing to upload - author a plan or add a file");

    /* Parse every .jmx before it is uploaded. A plan that no XML parser will
       read is not worth a runner's ten minutes, and the failure it produces up
       there names an XML offset rather than the cause. */
    for (const f of files) {
      if (!/\.jmx$/i.test(f.name)) continue;
      const g = jmxGate(f.content, f.name);
      if (!g.ok) {
        g.problems.forEach((p) => addLog("error", p));
        throw new Error(g.problems[0]);
      }
      addLog("ok", `${f.name} parses as a JMeter plan`);
    }

    const primary = $("primary").value ||
      (files.find((f) => f.name.toLowerCase().endsWith(".jmx")) || {}).name;
    if (!primary) throw new Error("choose which .jmx the job should run");

    const regions = $("regions").value.trim().replace(/,/g, " ").split(/\s+/).filter(Boolean);
    if (trigger && !regions.length) throw new Error("pick at least one region");

    // ---- project ----
    let projectId = $("projectId").value.trim();
    let created = false;
    if (!projectId) {
      const name = $("project").value.trim();
      if (!name) throw new Error("give a project name, or an existing project id");
      projectId = await HX.hxCreateProject(user, key, name, "jmeter", addLog);
      created = true;
      $("projectId").value = projectId;      // so a retry reuses it
      await save();
    }

    await HX.hxUpload(user, key, projectId, files, addLog);

    if (!trigger) {
      show($("msg"), `${created ? "created" : "using"} project ${projectId} · ` +
                     `uploaded ${files.length} file(s) · not triggered`, "ok");
      link(`${HX.HX_UI}/projects`, "open the project");
      return;
    }

    // ---- trigger ----
    // -e -o report is always sent: it is what produces the HTML dashboard
    // HyperExecute collects as an artefact
    const jobId = await HX.hxTrigger(user, key, projectId, {
      regions, jmx: primary,
      args: ["-e", "-o", "report"], reportDir: "report",
      duration: num("duration"), rampup: num("rampup"), users: num("vusers"),
      maxVusersPerVm: num("maxVusers"), globalTimeout: num("timeout"),
      splitcsv: $("splitcsv").checked,
      jobLabel: $("label").value.trim() || null,
      concurrency: 1,
    }, addLog);

    show($("msg"), `${created ? "created" : "using"} project ${projectId} · ` +
                   `uploaded ${files.length} file(s) · job ${jobId}`, "ok");
    link(`${HX.HX_UI}/jobs/${jobId}`, "open the job");
  } catch (e) {
    addLog("error", String(e.message || e));
    show($("msg"), String(e.message || e), "err");
  } finally {
    $("go").disabled = $("uploadOnly").disabled = false;
  }
}

$("go").onclick = () => submit(true);
$("uploadOnly").onclick = () => submit(false);

(async () => {
  await load();
  await takeHandoff();          // before anything renders the file list
  KEYS.concat(["key"]).forEach((k) => $(k).addEventListener("input", save));
  $("planName").addEventListener("input", renderFiles);   // the list shows the name
  CHECKS.forEach((k) => $(k).addEventListener("change", save));
  renderFiles();
  vmCalc();
  await prefillLoad();
  if (PLAN) addLog("info", `plan received: ${planName()} (${Math.round(PLAN.jmx.length / 1024)} KB)`);
  ping();
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
