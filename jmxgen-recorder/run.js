/* Run on HyperExecute - a full page, not the popup.
 *
 * The popup closes the moment you click anything outside it, so a form holding a
 * typed access key cannot live there: switching tabs to copy the key would throw
 * the whole thing away. This is a real tab, and every field is persisted as you
 * type, so nothing is lost however you leave it. */

const $ = (id) => document.getElementById(id);
const DEFAULT_ENDPOINT = "http://localhost:8770";
const KEYS = ["user", "project", "projectId", "regions", "platform",
              "vusers", "maxVusers", "rampup", "duration", "timeout", "label", "planName", "endpoint"];
const CHECKS = ["remember", "splitcsv"];

let SESSION = new URLSearchParams(location.search).get("session") || null;
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
  if (!SESSION) INCLUDE_GEN = false;
}

async function save() {
  const out = {};
  KEYS.forEach((k) => (out[k] = $(k).value.trim()));
  CHECKS.forEach((k) => (out[k] = $(k).checked));
  if ($("remember").checked) out.key = $("key").value;
  await chrome.storage.local.set({ hxForm: out });
}

const base = () => ($("endpoint").value.trim() || DEFAULT_ENDPOINT).replace(/\/+$/, "");

async function ping() {
  try {
    const r = await fetch(base() + "/api/ping", { cache: "no-store" });
    if (!r.ok) throw new Error();
    show($("svc"), "jmxgen service found at " + base(), "ok");
    return true;
  } catch (e) {
    show($("svc"), "cannot reach jmxgen at " + base() +
      " - start it with: jmxgen console", "err");
    return false;
  }
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
  if (SESSION) {
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
    s.textContent = SESSION ? "nothing selected yet"
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
  if (!SESSION) return;
  try {
    const r = await fetch(base() + "/api/session/" + SESSION, { cache: "no-store" });
    if (!r.ok) return;
    const load = (await r.json()).load || {};
    if (load.threads && !$("vusers").value) $("vusers").value = load.threads;
    if (load.ramp_up && !$("rampup").value) $("rampup").value = load.ramp_up;
    if (load.duration && !$("duration").value) $("duration").value = load.duration;
    vmCalc();
  } catch (e) { /* the form still works without it */ }
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

async function submit(trigger) {
  await save();
  const body = {
    session: SESSION,
    include_generated: INCLUDE_GEN && !!SESSION,
    jmx_name: $("planName").value.trim(),
    files: EXTRA.filter((f) => f.on !== false),
    primary_jmx: $("primary").value,
    username: $("user").value.trim(),
    access_key: $("key").value,
    project_name: $("project").value.trim(),
    project_id: $("projectId").value.trim(),
    regions: $("regions").value.trim(),
    platform: $("platform").value.trim(),
    vusers: $("vusers").value.trim(),
    max_vusers_per_vm: $("maxVusers").value.trim(),
    rampup: $("rampup").value.trim(),
    duration: $("duration").value.trim(),
    global_timeout: $("timeout").value.trim(),
    job_label: $("label").value.trim(),
    splitcsv: $("splitcsv").checked,
    trigger: trigger,
  };
  $("go").disabled = $("uploadOnly").disabled = true;
  show($("msg"), trigger ? "creating project, uploading and triggering…" : "uploading…", "info");
  try {
    const r = await fetch(base() + "/api/ship", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
    let text = (data.created ? "created project " : "using project ") + data.project_id +
               " · uploaded " + (data.uploaded || []).length + " file(s)";
    if (data.job_id) text += " · job " + data.job_id;
    show($("msg"), text, "ok");
    if (data.job_url || data.project_url) {
      const a = document.createElement("a");
      a.href = data.job_url || data.project_url;
      a.target = "_blank";
      a.textContent = data.job_id ? "  open the job" : "  open the project";
      $("msg").appendChild(a);
    }
  } catch (e) {
    show($("msg"), String(e.message || e), "err");
  } finally {
    $("go").disabled = $("uploadOnly").disabled = false;
  }
}

$("go").onclick = () => submit(true);
$("uploadOnly").onclick = () => submit(false);

(async () => {
  await load();
  KEYS.concat(["key"]).forEach((k) => $(k).addEventListener("input", save));
  $("planName").addEventListener("input", renderFiles);   // the list shows the name
  CHECKS.forEach((k) => $(k).addEventListener("change", save));
  renderFiles();
  vmCalc();
  ping();
  prefillLoad();
})();
