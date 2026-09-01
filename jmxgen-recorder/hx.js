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
const HX_UI = "https://hyperexecute.lambdatest.com/hyperexecute";

function hxHeaders(user, key) {
  return {
    accept: "application/json",
    authorization: "Basic " + btoa(`${user}:${key}`),
    "content-type": "application/json",
    origin: HX_UI.replace("/hyperexecute", ""),
  };
}

/* Every failure here has to say what actually happened. HyperExecute answers
   every credential problem with the same "1002 - Invalid Authentication Token",
   so the message has to supply the part it withholds. */
async function hxError(action, response) {
  let body = "";
  try { body = await response.text(); } catch (e) { /* nothing to add */ }
  let reason = body.slice(0, 300);
  try {
    const j = JSON.parse(body);
    reason = (j.error && j.error.message) || j.message || reason;
  } catch (e) { /* not JSON, keep the raw text */ }

  if (response.status === 401 || response.status === 403) {
    return new Error(
      `HyperExecute rejected the credentials (HTTP ${response.status}).\n` +
      `Username must be the LambdaTest username, not the email you sign in with.\n` +
      `Both are on accounts.lambdatest.com/detail/profile.`);
  }
  if (response.status >= 500) {
    return new Error(`${action}: HyperExecute returned HTTP ${response.status} — ` +
                     `a server-side error, worth retrying. ${reason}`);
  }
  return new Error(`${action}: HTTP ${response.status} ${reason}`);
}

async function hxCreateProject(user, key, name, type = "jmeter", log = () => {}) {
  log("info", `creating project "${name}"…`);
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
  log("ok", "project " + id);
  return String(id);
}

async function hxUpload(user, key, projectId, files, log = () => {}) {
  log("info", `uploading ${files.length} file(s)…`);
  const form = new FormData();
  for (const f of files) {
    form.append("files", new Blob([f.content], { type: "application/octet-stream" }), f.name);
    log("info", "  " + f.name);
  }
  // no content-type header: the browser sets the multipart boundary itself
  const r = await fetch(`${HX_BASE}/logistics/v1.0/project/${projectId}/files/upload`, {
    method: "POST",
    // no content-type: the browser sets the multipart boundary itself
    headers: {
      accept: "application/json, text/plain, */*",
      authorization: "Basic " + btoa(`${user}:${key}`),
      origin: "https://hyperexecute.lambdatest.com",
    },
    body: form,
  });
  if (!r.ok) throw await hxError("upload failed", r);
  log("ok", "uploaded");
}

async function hxTrigger(user, key, projectId, cfg, log = () => {}) {
  const entry = {
    region: null, jmx: cfg.jmx, splitcsv: !!cfg.splitcsv,
    args: cfg.args && cfg.args.length ? cfg.args : undefined,
  };
  const jmeter = (cfg.regions || []).map((region) => {
    const e = { ...entry, region };
    if (cfg.duration != null) e.duration = cfg.duration;
    if (cfg.rampup != null) e.rampup = cfg.rampup;
    // "users" is the wire name; "vusers" is silently dropped
    if (cfg.users != null) e.users = cfg.users;
    if (cfg.platform) e.platform = cfg.platform;
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

window.HX = { hxCreateProject, hxUpload, hxTrigger, HX_UI };
