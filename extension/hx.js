/* HyperExecute, called straight from the extension.
 *
 * An MV3 extension with host permissions is not subject to CORS, so create /
 * upload / trigger can go direct - there is no reason to route them through a
 * local server. That also means the access key never leaves the machine: it
 * goes from the form to LambdaTest and nowhere else.
 *
 * The wire format is the one the Python client uses, including the two field
 * names that are easy to get wrong:
 *   - the per-region user count is "users", not "vusers". An unknown key is
 *     dropped silently and the job runs with whatever the .jmx says, which
 *     looks like the run ignoring your settings.
 *   - "max_vusers_per_vm" is top-level, not inside the jmeter entry.
 */

const HX_BASE = "https://api-hyperexecute.lambdatest.com";
/* LUMS, which is where an organisation's preferences live. The regions a job
   may run in are one of them. */
const HX_LUMS = "https://auth.hyperexecute.cloud";
const HX_PERF_REGIONS_PREF = "HYPEREXECUTE_PERF_ALLOWED_REGIONS";
/* What reception falls back to when the preference is missing, empty, or
   unreadable. Kept identical to resolveAllowedRegions on the server: getting
   this wrong would show someone a region their job will be refused for. */
const HX_DEFAULT_REGIONS = ["eastus"];
const HX_UI = "https://hyperexecute.lambdatest.com/hyperexecute";
/* The job page, in the form the HyperExecute CLI prints. /jobs/<id> is not a
   job page; task?jobId= is the one that shows the run live. */
const hxJobUrl = (jobId) => `${HX_UI}/task?jobId=${encodeURIComponent(jobId)}`;
const HX_ORIGIN = "https://hyperexecute.lambdatest.com";
const HX_RULE_ID = 8801;
/* Pinned, and checked by running it: "Successfully installed k6 with ver
   v2.2.0" on a linux runner. HyperExecute's docs still say versions up to
   0.52, which is out of date. A wrong version is only found on the machine, at
   install time, not when the job is accepted - so this is a value that has to
   be verified rather than assumed. */
const HX_K6_VERSION = "v2.2.0";

/* Origin and Referer are forbidden header names: fetch() silently drops
   whatever you set, so every call from here otherwise arrives as
   `Origin: chrome-extension://<id>` with no Referer at all. The logistics host,
   which serves create and upload, does not mind. The reception host, which
   serves the trigger and sits behind the dashboard UI, answers that with a 403
   even though the credentials are the ones it accepted a second earlier.

   declarativeNetRequest is the only API in MV3 that can set those two headers,
   so one session rule rewrites them for this host and nothing else. Session
   rules die with the browser, so nothing is left installed. */
async function hxHeaderRule() {
  if (!chrome.declarativeNetRequest) return;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [HX_RULE_ID],
    addRules: [{
      id: HX_RULE_ID,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "origin", operation: "set", value: HX_ORIGIN },
          { header: "referer", operation: "set",
            value: HX_ORIGIN + "/hyperexecute/projects" },
        ],
      },
      condition: {
        urlFilter: "||api-hyperexecute.lambdatest.com",
        resourceTypes: ["xmlhttprequest"],
      },
    }],
  });
}

function hxHeaders(user, key) {
  return {
    accept: "application/json",
    "accept-language": "en-US,en;q=0.9",
    authorization: "Basic " + btoa(`${user}:${key}`),
    "content-type": "application/json",
  };
}

/* Every failure here has to say what actually happened. HyperExecute answers
   every credential problem with the same "1002 - Invalid Authentication Token",
   so the message has to supply the part it withholds. */
let AUTH_PROVEN = false;   // set once a call this host has authenticated succeeds

async function hxError(action, response) {
  let body = "";
  try { body = await response.text(); } catch (e) { /* nothing to add */ }
  let reason = body.slice(0, 300);
  try {
    const j = JSON.parse(body);
    reason = (j.error && j.error.message) || j.message || reason;
  } catch (e) { /* not JSON, keep the raw text */ }

  if (response.status === 401) {
    return new Error(
      `HyperExecute rejected the credentials (HTTP 401). ${reason}\n` +
      `Username must be the LambdaTest username, not the email you sign in with. ` +
      `Both are on accounts.lambdatest.com/detail/profile.`);
  }
  /* A 403 is a different story, and telling it as a credential failure sends
     the reader to the wrong page. If the upload has already gone through, this
     same Authorization header was accepted seconds ago. */
  if (response.status === 403) {
    return new Error(
      `${action}: HTTP 403. ${reason || "the server sent no reason."}\n` +
      (AUTH_PROVEN
        ? `These credentials were accepted moments ago by the upload, so the ` +
          `username and access key are not what is wrong. Check that the ` +
          `project id belongs to this account and is a JMeter project.`
        : `Check the username is the LambdaTest username rather than the ` +
          `sign-in email; both are on accounts.lambdatest.com/detail/profile.`));
  }
  if (response.status >= 500) {
    return new Error(`${action}: HyperExecute returned HTTP ${response.status} — ` +
                     `a server-side error, worth retrying. ${reason}`);
  }
  return new Error(`${action}: HTTP ${response.status} ${reason}`);
}

/* The org's projects, so the run page can offer a list instead of asking
   someone to paste an id. Filtered to jmeter server-side: uploading a plan
   into a Playwright project fails later, at trigger time, for a reason nobody
   would connect back to this choice. */
/* ---- what this account is allowed to run --------------------------------
   Every limit lives in one place: organization.plan_attributes on the account
   service's own /api/user. The dashboard offers everyone everything and lets
   the job be refused on submit, with messages that do not say which limit was
   hit, so the same read happens here and the answer is known before anything
   is spent.

   Returns null when it cannot be established - never zeroes, because "we could
   not ask" must not read as "you may not". A failure is logged and ignored. */

/* What the server falls back to for an account with no performance plan.
   Kept identical to setDefaultPerformanceTestingPlanValues. */
const HX_FREE_PLAN = {
  maxVUsers: 100, vuhMonth: 20, vuhYear: 20,
  jobsMonth: 20, jobsYear: 20, maxDurationMin: 40,
};
/* The same list also appears as a plan attribute. Reception reads the org
   preference; the attribute is read too, as a fallback, so an account that has
   one but not the other is not told it may only use eastus. */
const HX_PERF_REGIONS_ATTR = "HYPEREXECUTE_PERF_REGIONS";

const hxNum = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
/* -1 is the platform's "no limit", and must never be compared against. */
const hxLimit = (v) => { const n = hxNum(v); return n === null || n < 0 ? null : n; };
const hxRegionList = (raw) =>
  (Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [])
    .map((x) => String(x).trim()).filter(Boolean);

async function hxAccountPlan(user, key, log = () => {}) {
  const get = async (url) => {
    const r = await fetch(url, { headers: hxHeaders(user, key), credentials: "omit" });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).pathname}`);
    return r.json();
  };
  try {
    const me = await get(HX_LUMS + "/api/user");
    const org = (me && me.organization) || {};
    const a = org.plan_attributes || {};
    const perf = a.IS_HYPEREXECUTE_PERF_ENABLED === true;
    /* Without a performance plan the server only invents the free ceilings for
       an account with metered HyperExecute minutes. Unmetered (-1) or none at
       all is refused outright, and unlimited minutes being worse than metered
       ones is a real quirk of that check, not a mistake here. */
    const mins = a.MAX_HYPEREXECUTE_MINUTES;
    const freemium = typeof mins === "number" && mins !== -1;
    const refused = !perf && !freemium;

    const plan = perf ? {
      maxVUsers: hxLimit(a.HYPEREXECUTE_PERF_MAX_VUSERS),
      vuhMonth: hxLimit(a.HYPEREXECUTE_PERF_MAX_VUH_MONTH),
      vuhYear: hxLimit(a.HYPEREXECUTE_PERF_MAX_VUH_YEAR),
      jobsMonth: hxLimit(a.HYPEREXECUTE_PERF_MAX_JOBS_MONTH),
      jobsYear: hxLimit(a.HYPEREXECUTE_PERF_MAX_JOBS_YEAR),
      maxDurationMin: hxLimit(a.HYPEREXECUTE_PERF_MAX_JOB_DURATION_MINUTES),
    } : Object.assign({}, HX_FREE_PLAN);

    // the regions: the org preference first, the plan attribute second
    let regions = hxRegionList(a[HX_PERF_REGIONS_ATTR]);
    let source = regions.length ? "plan" : "default";
    try {
      const prefs = await get(HX_LUMS + "/api/org_preferences/" + encodeURIComponent(org.id));
      const pref = hxRegionList(prefs && prefs[HX_PERF_REGIONS_PREF]);
      if (pref.length) { regions = pref; source = "preference"; }
    } catch (e) {
      log("warn", "could not read this organisation's region preference (" + (e.message || e) + ")");
    }
    if (!regions.length) { regions = HX_DEFAULT_REGIONS.slice(); source = "default"; }

    const out = Object.assign({ perf, freemium, refused,
                                planName: org.current_plan_name || org.plan || "",
                                regions: { allowed: regions, source } }, plan);
    if (refused) {
      log("err", "this account has no performance testing plan, so HyperExecute "
        + "will refuse a JMeter load job whatever it asks for");
      return out;
    }
    log("info", (perf ? "performance plan: " : "no performance plan, so the free limits apply: ")
      + `${out.maxVUsers === null ? "unlimited" : out.maxVUsers.toLocaleString()} users, `
      + `${out.maxDurationMin === null ? "unlimited" : out.maxDurationMin + " min"} per job, `
      + `${out.vuhMonth === null ? "unlimited" : out.vuhMonth.toLocaleString()} VUH a month, `
      + `regions: ${regions.join(", ")}`);
    return out;
  } catch (e) {
    log("warn", "could not read what this account is allowed to run ("
      + (e.message || e) + "), so nothing is checked here");
    return null;
  }
}

/* The platform's own sum, so an estimate shown here matches the one the job is
   billed for: half the ramp-up is taken off before the hours are counted, and
   a part hour is a whole one. */
function hxEstimateVuh(users, durationSec, rampSec, ui) {
  const u = Number(users) || 0;
  const d = Number(durationSec) || 0;
  const r = Number(rampSec) || 0;
  if (!u || d <= 0) return null;
  return u * (Math.floor(Math.max(0, d - r / 2) / 3600) + 1) * (ui ? 10 : 1);
}

async function hxListProjects(user, key, log = () => {}, type = "jmeter") {
  await hxHeaderRule();
  const r = await fetch(
    `${HX_BASE}/sentinel/v1.0/projects?per_page=100&type=${encodeURIComponent(type)}`,
    { headers: hxHeaders(user, key) });
  if (!r.ok) throw await hxError("could not list the projects", r);
  const j = await r.json();
  const rows = (j && j.data) || [];
  log("ok", `${rows.length} project(s) found`);
  return rows
    .filter((p) => p && p.id)
    .map((p) => ({ id: String(p.id), name: p.name || p.id, by: p.created_by || "" }));
}

async function hxCreateProject(user, key, name, type = "jmeter", log = () => {}) {
  log("info", `creating project "${name}"…`);
  await hxHeaderRule();
  const r = await fetch(`${HX_BASE}/logistics/v1.0/project`, {
    method: "POST",
    headers: hxHeaders(user, key),
    body: JSON.stringify({ name, jmx: [], type }),
  });
  const body = await r.clone().text();
  let j = {};
  try { j = JSON.parse(body); } catch (e) { /* handled below */ }

  const msg = String((j.error && j.error.message) || j.message || "").toLowerCase();
  if (r.status === 409 || msg.includes("already exists")) {
    throw new Error(
      `A project named "${name}" already exists. Open it on the Projects ` +
      `dashboard and paste its ID into Project ID, or pick a different name.`);
  }
  if (!r.ok) throw await hxError("could not create the project", r);

  const id = j.id || j.projectId || j.projectID ||
             (j.data && (j.data.id || j.data.projectId));
  if (!id) throw new Error("project created but no ID came back: " + body.slice(0, 200));
  AUTH_PROVEN = true;
  log("ok", "project " + id);
  return String(id);
}

/* HyperExecute's upload limits. The backend enforces the last two per request
   (one 200 MB budget shared by every file in it, and 20 files); the 50 MB per
   .jmx is the dashboard's rule, applied here too so a plan the dashboard would
   refuse is not uploaded behind its back. */
const HX_LIMITS = {
  jmxBytes: 50 * 1048576,
  requestBytes: 200 * 1048576,
  requestFiles: 20,
};

/* Files are {name, content}, where content is a Blob/File (sent as its bytes)
   or a string. Returns the problems that would make the upload fail, before
   anything is sent. */
function hxUploadProblems(files) {
  const out = [];
  for (const f of files) {
    const size = hxSize(f.content);
    if (/\.jmx$/i.test(f.name) && size > HX_LIMITS.jmxBytes) {
      out.push(`${f.name} is ${hxMB(size)}; a .jmx can be at most ${hxMB(HX_LIMITS.jmxBytes)}`);
    } else if (size > HX_LIMITS.requestBytes) {
      out.push(`${f.name} is ${hxMB(size)}; one file can be at most ${hxMB(HX_LIMITS.requestBytes)}`);
    }
  }
  return out;
}

const hxSize = (c) => (c instanceof Blob ? c.size : new Blob([c || ""]).size);
const hxMB = (n) => (n / 1048576).toFixed(1) + " MB";

/* Pack the files into requests that each stay within the per-request limits.
   Each request adds to the project's files, so splitting is safe. */
function hxUploadBatches(files) {
  const batches = [];
  let cur = [], bytes = 0;
  for (const f of files) {
    const size = hxSize(f.content);
    if (cur.length && (cur.length >= HX_LIMITS.requestFiles ||
                       bytes + size > HX_LIMITS.requestBytes)) {
      batches.push(cur);
      cur = []; bytes = 0;
    }
    cur.push(f);
    bytes += size;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

async function hxUploadOne(user, key, projectId, files, log) {
  const form = new FormData();
  for (const f of files) {
    const blob = f.content instanceof Blob ? f.content
      : new Blob([f.content], { type: "application/octet-stream" });
    // the part's filename is the path in the project, folders included
    form.append("files", blob, f.name);
    log("info", "  " + f.name + " (" + hxMB(blob.size) + ")");
  }
  await hxHeaderRule();
  const r = await fetch(`${HX_BASE}/logistics/v1.0/project/${projectId}/files/upload`, {
    method: "POST",
    // no content-type: the browser sets the multipart boundary itself
    headers: {
      accept: "application/json, text/plain, */*",
      authorization: "Basic " + btoa(`${user}:${key}`),
    },
    body: form,
  });
  if (r.status === 413) {
    throw new Error("the upload was refused as too large (413): HyperExecute takes at most " +
                    hxMB(HX_LIMITS.requestBytes) + " per request");
  }
  if (r.status === 400) {
    const body = await r.clone().text().catch(() => "");
    if (/too many files/i.test(body)) {
      throw new Error("the upload was refused: more than " + HX_LIMITS.requestFiles +
                      " files in one request");
    }
  }
  if (!r.ok) throw await hxError("the upload failed", r);
}

async function hxUpload(user, key, projectId, files, log = () => {}) {
  const problems = hxUploadProblems(files);
  if (problems.length) {
    problems.forEach((p) => log("error", p));
    throw new Error(problems[0]);
  }
  const batches = hxUploadBatches(files);
  const total = files.reduce((n, f) => n + hxSize(f.content), 0);
  log("info", `uploading ${files.length} file(s), ${hxMB(total)}` +
              (batches.length > 1 ? ` in ${batches.length} requests` : "") + "…");
  for (let i = 0; i < batches.length; i++) {
    if (batches.length > 1) log("info", `request ${i + 1} of ${batches.length}`);
    await hxUploadOne(user, key, projectId, batches[i], log);
  }
  AUTH_PROVEN = true;
  log("ok", "uploaded");
}

async function hxTrigger(user, key, projectId, cfg, log = () => {}) {
  const entry = {
    region: null, jmx: cfg.jmx, splitcsv: !!cfg.splitcsv,
    args: cfg.args && cfg.args.length ? cfg.args : undefined,
  };
  // a region is a name, or {region, users} when the users are split by region
  const jmeter = (cfg.regions || []).map((r) => {
    const one = typeof r === "string" ? { region: r } : r;
    const e = { ...entry, region: one.region };
    if (cfg.duration != null) e.duration = cfg.duration;
    if (cfg.rampup != null) e.rampup = cfg.rampup;
    // "users" is the wire name; "vusers" is silently dropped
    const users = one.users != null ? one.users : cfg.users;
    if (users != null) e.users = users;
    // no "platform": HyperExecute picks the cloud that backs the region, and
    // the job context echoes it back. Sending one only ever contradicts it.
    return e;
  });

  const payload = {
    jmeter,
    jobLabel: cfg.jobLabel ? [cfg.jobLabel] : [],
    concurrency: cfg.concurrency || 1,
  };
  if (cfg.reportDir) {
    payload.uploadArtefacts = [{ name: "report", path: [`${cfg.reportDir}/**/*`] }];
  }
  if (cfg.maxVusersPerVm != null) payload.max_vusers_per_vm = cfg.maxVusersPerVm;
  if (cfg.globalTimeout != null) payload.globalTimeout = cfg.globalTimeout;

  log("info", "triggering: " + JSON.stringify(payload));
  await hxHeaderRule();
  // the trigger sits under /reception, not /logistics
  const r = await fetch(`${HX_BASE}/reception/api/project/${projectId}/trigger-job`, {
    method: "POST",
    headers: hxHeaders(user, key),
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw await hxError("the trigger failed", r);
  const j = await r.json();
  const jobId = j.jobId || j.jobID;
  if (j.status !== "success" || !jobId) {
    throw new Error("the trigger was rejected: " + JSON.stringify(j).slice(0, 240));
  }
  log("ok", "job " + jobId);
  return String(jobId);
}

/* A job described by a config rather than by a plan.

   The JMeter path posts a `jmeter[]` spec to the older project-scoped route and
   HyperExecute builds the job around it. Anything else - k6 here - goes to
   /v1.0/trigger-job with the whole config inline, which is the same thing the
   YAML file says, as JSON.

   Three things about this route, each learned by trying it:

   - `projectID` on its own is not enough. That path resolves the project's Git
     details and answers `unsupported URL format` for a project that has none.
     The config has to be inline, with the project id inside it.
   - With no `sourcePayload`, the platform defaults to "project", and the files
     uploaded to that project become the working directory on the machine. That
     is what carries the script, so nothing has to be committed anywhere.
   - The answer carries `jobID` at the top level, where the older route nests
     `jobId` under `data`. Both spellings are read below. */
async function hxTriggerYaml(user, key, cfg, log = () => {}) {
  const machines = Math.max(1, Number(cfg.machines) || 1);
  const config = {
    version: "0.1",
    projectID: cfg.projectId,
    runson: cfg.runson || "linux",
    concurrency: machines,
    runtime: { addons: [{ name: "k6", version: cfg.k6Version || HX_K6_VERSION }] },
    testSuites: cfg.testSuites,
    jobLabel: cfg.jobLabel || [],
    /* A stage that opened no browser session is reported as skipped whatever
       its command did, and k6 never opens one - so without this the job's
       status would never reflect the run. */
    scenarioCommandStatusOnly: true,
    /* The Reports tab combines reports from the frameworks HyperExecute knows
       how to parse, and k6 is not one of them: naming the dashboard as a
       Playwright report fails the report step outright with "No valid
       Playwright HTML reports found". Until there is a k6 framework, the
       dashboard rides along as an artefact - which works - and the Reports tab
       keeps HyperExecute's own job summary. */
    report: true,
    mergeArtifacts: true,
    uploadArtefacts: cfg.uploadArtefacts || [
      { name: "k6-report", path: ["k6-report/**/*", "k6-summary.json",
                                  "k6-summary.txt", "k6-report.html"] },
    ],
  };
  /* One task per machine, each with its own share of the users. HyperExecute
     hands every task the whole testSuites list, so five entries would run five
     k6 invocations on one machine; a matrix row becomes a task of its own, and
     $shard resolves per task. */
  if (machines > 1 && cfg.shardVar) config.matrix = { [cfg.shardVar]: cfg.shards };

  log("info", "triggering: " + JSON.stringify(config));
  await hxHeaderRule();
  const r = await fetch(`${HX_BASE}/reception/api/v1.0/trigger-job`, {
    method: "POST",
    headers: hxHeaders(user, key),
    body: JSON.stringify({ hyperExecuteConfig: config, triggerSource: "jmeter-studio" }),
  });
  if (!r.ok) throw await hxError("the trigger failed", r);
  const j = await r.json();
  const jobId = j.jobID || j.jobId || (j.data && (j.data.jobID || j.data.jobId));
  if (!jobId) throw new Error("the trigger was rejected: " + JSON.stringify(j).slice(0, 240));
  log("ok", "job " + jobId);
  return String(jobId);
}

window.HX = { hxCreateProject, hxListProjects, hxUpload, hxTrigger, hxTriggerYaml, hxHeaderRule, HX_UI, hxJobUrl,
              HX_LIMITS, hxUploadProblems, hxUploadBatches };
