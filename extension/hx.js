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
const HX_ORIGIN = "https://hyperexecute.lambdatest.com";
const HX_RULE_ID = 8801;

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

async function hxUpload(user, key, projectId, files, log = () => {}) {
  log("info", `uploading ${files.length} file(s)…`);
  const form = new FormData();
  for (const f of files) {
    form.append("files", new Blob([f.content], { type: "application/octet-stream" }), f.name);
    log("info", "  " + f.name);
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
  if (!r.ok) throw await hxError("the upload failed", r);
  AUTH_PROVEN = true;
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

window.HX = { hxCreateProject, hxUpload, hxTrigger, hxHeaderRule, HX_UI };
