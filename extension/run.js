/* Run on HyperExecute - a full page, not the popup.
 *
 * A real tab rather than the popup, which closes the moment you click anything
 * outside it. Every field is persisted as you type, so nothing is lost however
 * you leave it. The account is the signed-in TestMu AI one (auth.js), and is
 * never part of what is saved. */

const $ = (id) => document.getElementById(id);
const KEYS = ["project", "projectId", "regions",
              "vusers", "maxVusers", "rampup", "duration", "timeout", "label", "planName"];
const CHECKS = ["splitcsv"];

/* The plan is handed over in session storage rather than by a server session:
   the authoring page built it in-process, so there is no id to look up. */
const HANDOFF = new URLSearchParams(location.search).get("handoff") || null;
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
  renderRegions();
  if (!$("maxVusers").value) $("maxVusers").value = "2000";
  if (WANTED_NAME) $("planName").value = WANTED_NAME;
  // INCLUDE_GEN is decided in takeHandoff(), which runs after this: at this
  // point PLAN is always still null.
}

async function save() {
  const out = {};
  KEYS.forEach((k) => (out[k] = $(k).value.trim()));
  CHECKS.forEach((k) => (out[k] = $(k).checked));
  await chrome.storage.local.set({ hxForm: out });
}

/* This page talks to HyperExecute directly - an extension with host permissions
   is not subject to CORS - so there is nothing in between to mention. */
function showRoute() {
  show($("svc"), "uploads go straight to HyperExecute with your TestMu AI " +
                 "sign-in - nothing passes through another server", "ok");
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
  if (PLAN) {
    list.appendChild(row(planName(), INCLUDE_GEN, (v) => { INCLUDE_GEN = v; renderFiles(); },
                         "from this recording"));
    if (INCLUDE_GEN) names.push(planName());
  }
  EXTRA.forEach((f, i) => {
    list.appendChild(row(f.name, f.on !== false, (v) => { EXTRA[i].on = v; renderFiles(); },
                         mb(f.file.size)));
    if (f.on !== false) names.push(f.name);
  });
  summarise();
  if (!list.childNodes.length) {
    const s = document.createElement("span");
    s.textContent = PLAN ? "nothing selected yet"
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

const mb = (n) => (n / 1048576).toFixed(n < 1048576 ? 2 : 1) + " MB";

/* What will actually be sent, as the upload will send it. */
function outgoing() {
  const files = [];
  if (INCLUDE_GEN && PLAN && PLAN.jmx) files.push({ name: planName(), content: PLAN.jmx });
  for (const f of EXTRA.filter((x) => x.on !== false)) files.push({ name: f.name, content: f.file });
  return files;
}

/* Size, request count and anything over a limit, before the button is pressed. */
function summarise() {
  const el = $("uploadSummary");
  const files = outgoing();
  if (!files.length) { el.textContent = ""; el.className = "hint"; return; }
  const total = files.reduce((n, f) => n + new Blob([f.content]).size, 0);
  const problems = HX.hxUploadProblems(files);
  const batches = HX.hxUploadBatches(files).length;
  el.textContent = problems.length
    ? problems.join(" · ")
    : `${files.length} file(s), ${mb(total)}` +
      (batches > 1 ? ` - sent in ${batches} requests, since HyperExecute takes at most ` +
                     `${HX.HX_LIMITS.requestFiles} files and ${mb(HX.HX_LIMITS.requestBytes)} per request` : "");
  el.className = problems.length ? "hint bad" : "hint";
}

/* Adds picked files, keyed by the path they will have in the project. A file
   picked again replaces the earlier copy rather than appearing twice. */
function addFiles(list, useFolderPath) {
  let skipped = 0;
  for (const f of Array.from(list || [])) {
    const name = useFolderPath ? (f.webkitRelativePath || f.name) : f.name;
    // .DS_Store, .git/... - nothing a run needs, and noise in the project
    if (name.split("/").some((part) => part.startsWith("."))) { skipped++; continue; }
    const at = EXTRA.findIndex((x) => x.name === name);
    const entry = { name, file: f, on: true };
    if (at >= 0) EXTRA[at] = entry; else EXTRA.push(entry);
  }
  if (skipped) addLog("info", `left out ${skipped} hidden file(s)`);
  renderFiles();
}

/* ---- regions -------------------------------------------------------------
   The regions the HyperExecute dashboard offers, named the way it names them.
   Each row takes a share of the total users; with no total set, every region
   runs what the .jmx says, as the dashboard does. Stored in the hidden
   #regions field as JSON, so the form's own persistence keeps it. */
const HX_REGIONS = [
  ["westus", "West US 2 (Moses Lake, Washington)"],
  ["eastus", "East US (Richmond, Virginia)"],
  ["centralindia", "Central India (Pune, Maharashtra)"],
  ["southeastasia", "Southeast Asia (Singapore)"],
  ["brazilsouth", "Brazil South (São Paulo State, Brazil)"],
  ["mexicocentral", "Mexico Central (Querétaro State, Mexico)"],
];

/* Filled once per page load from the org's preferences. null means the answer
   is unknown, which is not the same as "none allowed": every region stays
   offered in that case. */
let HX_ALLOWED = null;

const regionAllowed = (v) => !HX_ALLOWED || HX_ALLOWED.allowed.includes(v);

function regionRows() {
  const raw = $("regions").value.trim();
  let rows = null;
  try { rows = JSON.parse(raw); } catch (e) { /* an older build saved a plain list */ }
  if (!Array.isArray(rows)) {
    const names = raw.replace(/,/g, " ").split(/\s+/).filter(Boolean);
    rows = names.map((region, i) => ({
      region, traffic: i === 0 ? 100 - Math.floor(100 / names.length) * (names.length - 1)
                               : Math.floor(100 / names.length) }));
  }
  rows = rows.filter((r) => r && r.region);
  return rows.length ? rows : [{ region: "eastus", traffic: 100 }];
}

function setRegionRows(rows) {
  $("regions").value = JSON.stringify(rows);
  save();
  renderRegions();
}

function totalUsers() {
  const n = parseInt($("vusers").value.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// the dashboard's split: each region gets floor(share x total)
const regionUsers = (traffic, total) => Math.floor((Number(traffic) || 0) / 100 * total);

function renderRegions() {
  const rows = regionRows();
  const total = totalUsers();
  const box = $("regionRows");
  box.textContent = "";
  rows.forEach((r, i) => {
    const line = document.createElement("div");
    line.className = "regionrow";

    const sel = document.createElement("select");
    sel.setAttribute("aria-label", `Region ${i + 1}`);
    const known = HX_REGIONS.some(([v]) => v === r.region);
    const options = known ? HX_REGIONS : HX_REGIONS.concat([[r.region, r.region]]);
    for (const [value, label] of options) {
      const o = document.createElement("option");
      o.value = value;
      // a region the plan does not cover is still selectable: region checks
      // only run when the org has them switched on, so refusing here would
      // stop jobs that would have been accepted
      o.textContent = regionAllowed(value) ? label : label + "  (not in your plan)";
      // one row per region: a region already used elsewhere is not offered
      o.disabled = value !== r.region && rows.some((x) => x.region === value);
      sel.appendChild(o);
    }
    sel.value = r.region;
    sel.onchange = () => { rows[i].region = sel.value; setRegionRows(rows); };

    const pct = document.createElement("span");
    pct.className = "pct";
    const inp = document.createElement("input");
    inp.type = "number"; inp.min = "0"; inp.max = "100"; inp.step = "1";
    inp.value = r.traffic;
    inp.setAttribute("aria-label", `Share of users for region ${i + 1}, percent`);
    inp.oninput = () => {
      rows[i].traffic = Math.max(0, Math.min(100, parseInt(inp.value, 10) || 0));
      $("regions").value = JSON.stringify(rows);
      save();
      regionSummary(rows);
    };
    pct.appendChild(inp);

    const users = document.createElement("span");
    users.className = "users";
    users.dataset.row = i;

    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "rm";
    rm.textContent = "✕";
    rm.title = "Remove this region";
    rm.setAttribute("aria-label", `Remove region ${i + 1}`);
    rm.hidden = rows.length === 1;
    rm.onclick = () => { rows.splice(i, 1); setRegionRows(rows); };

    line.append(sel, pct, users, rm);
    box.appendChild(line);
  });
  $("addRegion").disabled = rows.length >= HX_REGIONS.length;
  regionSummary(rows);
}

function regionSummary(rows) {
  const total = totalUsers();
  document.querySelectorAll(".regionrow .users").forEach((el) => {
    const r = rows[Number(el.dataset.row)];
    el.textContent = total ? `${regionUsers(r.traffic, total).toLocaleString()} users`
                           : "users from the .jmx";
  });
  const sum = rows.reduce((n, r) => n + (Number(r.traffic) || 0), 0);
  const hint = $("regionHint");
  const barred = rows.map((r) => r.region).filter((v) => !regionAllowed(v));
  if (barred.length) {
    // the server refuses these with a message that never names the region,
    // so name them here, before the trigger is spent
    hint.textContent = `${barred.join(", ")} ${barred.length > 1 ? "are" : "is"} not in `
      + `this account's plan, so the job will be refused. Allowed: `
      + `${HX_ALLOWED.allowed.join(", ")}`
      + (HX_ALLOWED.source === "default"
         ? " (the default, because no region preference is set for this organisation)" : "");
    hint.className = "hint bad";
  } else if (total && sum !== 100) {
    hint.textContent = `the shares add up to ${sum}%, so ` +
      (sum < 100 ? `${100 - sum}% of the users will not start` : `more users start than the total`);
    hint.className = "hint bad";
  } else {
    hint.textContent = total ? "each region runs its share of the total"
                             : "set Max users to split them across regions";
    hint.className = "hint";
  }
}

$("addRegion").onclick = () => {
  const rows = regionRows();
  const unused = HX_REGIONS.filter(([v]) => !rows.some((r) => r.region === v));
  const free = unused.find(([v]) => regionAllowed(v)) || unused[0];
  if (!free) return;
  rows.push({ region: free[0], traffic: 0 });   // the dashboard adds a row at 0%
  setRegionRows(rows);
};
$("vusers").addEventListener("input", () => regionSummary(regionRows()));

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
  if (!PLAN) return;
  const load = PLAN.load || {};
  {
    if (load.threads && !$("vusers").value) $("vusers").value = load.threads;
    if (load.ramp_up && !$("rampup").value) $("rampup").value = load.ramp_up;
    if (load.duration && !$("duration").value) $("duration").value = load.duration;
    vmCalc();
  }
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
  INCLUDE_GEN = !!PLAN;
}

// add to what is already queued rather than replacing it
$("files").onchange = () => { addFiles($("files").files, false); $("files").value = ""; };
$("folder").onchange = () => { addFiles($("folder").files, true); $("folder").value = ""; };
document.querySelectorAll("input[name=uptype]").forEach((r) => r.onchange = () => {
  const folder = document.querySelector("input[name=uptype]:checked").value === "folder";
  $("pickFiles").hidden = folder;
  $("pickFolder").hidden = !folder;
});



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

  const { user, key } = AUTH.creds();
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

    // ---- the files ----
    // picked files go up as their own bytes: a .jar decoded as text is corrupt
    const files = outgoing();
    if (!files.length) throw new Error("nothing to upload - author a plan or add a file");

    /* Parse every .jmx before it is uploaded. A plan that no XML parser will
       read is not worth a runner's ten minutes, and the failure it produces up
       there names an XML offset rather than the cause. */
    const tooBig = HX.hxUploadProblems(files);
    if (tooBig.length) {
      tooBig.forEach((p) => addLog("error", p));
      throw new Error(tooBig[0]);
    }
    for (const f of files) {
      if (!/\.jmx$/i.test(f.name)) continue;
      const text = typeof f.content === "string" ? f.content : await f.content.text();
      const g = jmxGate(text, f.name);
      if (!g.ok) {
        g.problems.forEach((p) => addLog("error", p));
        throw new Error(g.problems[0]);
      }
      addLog("ok", `${f.name} parses as a JMeter plan`);
    }

    const primary = $("primary").value ||
      (files.find((f) => f.name.toLowerCase().endsWith(".jmx")) || {}).name;
    if (!primary) throw new Error("choose which .jmx the job should run");

    const total = num("vusers");
    const regions = regionRows().map((r) => {
      // a region given 0 users would run the .jmx's own count; say so rather than send it
      const users = total ? regionUsers(r.traffic, total) : null;
      return { region: r.region, users: users || null };
    });
    if (trigger && !regions.length) throw new Error("pick at least one region");
    if (total && regions.some((r) => !r.users)) {
      throw new Error("a region has a 0% share - give it some traffic or remove it");
    }

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
      duration: num("duration"), rampup: num("rampup"),
      maxVusersPerVm: num("maxVusers"), globalTimeout: num("timeout"),
      splitcsv: $("splitcsv").checked,
      jobLabel: $("label").value.trim() || null,
      concurrency: 1,
    }, addLog);

    show($("msg"), `${created ? "created" : "using"} project ${projectId} · ` +
                   `uploaded ${files.length} file(s) · job ${jobId}`, "ok");
    const jobUrl = HX.hxJobUrl(jobId);
    link(jobUrl, "open the job");
    addLog("ok", "job dashboard: " + jobUrl);
  } catch (e) {
    addLog("error", String(e.message || e));
    show($("msg"), String(e.message || e), "err");
  } finally {
    $("go").disabled = $("uploadOnly").disabled = false;
  }
}

/* ---- the project list --------------------------------------------------
   Pasting an id is a poor way to choose a project, so the page asks the
   account what it has. Everything here is a convenience: if the call fails,
   is slow, or the account has no projects, the two original fields come back
   and the run proceeds. A listing that cannot load must never be the reason
   somebody cannot start a test. */

const NEW_PROJECT = "__new__";
let PROJECTS = null;

function showManual(why) {
  $("projectPick").hidden = true;
  $("projectManual").hidden = false;
  $("projectHint").textContent = why || "";
}

async function loadProjects() {
  const { user, key } = AUTH.creds();
  $("projectPick").hidden = false;
  $("projectManual").hidden = true;
  $("projectSel").innerHTML = '<option>loading…</option>';
  try {
    PROJECTS = await HX.hxListProjects(user, key, addLog);
  } catch (e) {
    addLog("warn", "could not list projects: " + (e.message || e));
    return showManual("The project list could not be loaded, so name a new " +
                      "project or paste an id instead.");
  }
  const chosen = $("projectId").value.trim();
  $("projectSel").innerHTML =
    PROJECTS.map((p) =>
      `<option value="${p.id}"${p.id === chosen ? " selected" : ""}>` +
      `${p.name.replace(/[<>&]/g, "")}</option>`).join("") +
    `<option value="${NEW_PROJECT}"${PROJECTS.length ? "" : " selected"}>` +
    `+ New project…</option>`;
  $("projectHint").textContent =
    `${PROJECTS.length} JMeter project(s) on this account.`;
  syncProject();
}

/* The select is the visible control; the two original fields stay as the
   values submit() reads, so there is one code path to the API either way. */
function syncProject() {
  const v = $("projectSel").value;
  const creating = v === NEW_PROJECT;
  $("projectManual").hidden = !creating;
  $("projectId").value = creating ? "" : v;
  if (creating) {
    $("projectHint").textContent = "It will be created when you press the button below.";
  } else {
    const p = (PROJECTS || []).find((x) => x.id === v);
    $("projectHint").textContent = p ? `id ${p.id}` : "";
  }
  save();
}
$("projectSel").onchange = syncProject;

$("go").onclick = () => submit(true);
$("uploadOnly").onclick = () => submit(false);

(async () => {
  await load();
  await takeHandoff();          // before anything renders the file list
  KEYS.forEach((k) => $(k).addEventListener("input", save));
  $("planName").addEventListener("input", renderFiles);   // the list shows the name
  CHECKS.forEach((k) => $(k).addEventListener("change", save));
  renderFiles();
  vmCalc();
  await prefillLoad();
  await AUTH.ready();        // the gate covers the page until someone is signed in
  {
    const { user, key } = AUTH.creds();
    HX_ALLOWED = await hxAllowedRegions(user, key, addLog);
    renderRegions();           // relabel now that the plan's regions are known
  }
  await loadProjects();
  if (PLAN) addLog("info", `plan received: ${planName()} (${Math.round(PLAN.jmx.length / 1024)} KB)`);
  showRoute();
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
