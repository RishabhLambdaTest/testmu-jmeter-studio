/* TestMu AI automation sessions -> a HAR the engine already understands.
 *
 * A session that ran with network.full.har already recorded its traffic. This
 * pulls that recording, groups it into the test's own named steps, and hands
 * back a plain HAR document. Everything downstream - har_to_spec, correlation,
 * the XML gate - is untouched, because the transaction names ride along as
 * `_jmxgen.transaction` exactly as the recorder writes them.
 *
 * Measured facts this is built around (api.lambdatest.com, 60 sessions):
 *   - only full-har carries request/response bodies; network.har does not, so
 *     a plan built from it can neither POST nor correlate
 *   - failures come back HTTP 200 with a JSON body, so status is not a signal
 *   - roughly 10% of calls return 500, so everything retries
 *   - the archive can be 70 MB holding 324 MB across 47 members, of which we
 *     keep about 2%, so members are fetched one at a time and filtered on the
 *     way in
 *   - the API sends access-control-allow-origin: *, so no DNR rule is needed
 */

const LT_BASE = "https://api.lambdatest.com/automation/api/v1";

/* Hosts that are never the system under test. Converting without this points a
   thousand-user run at other people's production services.

   Matched a label at a time rather than as a substring: "browser-intake-
   datadoghq.com" is theirs, but "my-google-shop.com" is the customer's. So a
   label counts only when it IS the vendor or ENDS WITH "-vendor". */
const LT_VENDORS = new Set([
  "google", "googleapis", "googlevideo", "gstatic", "googletagmanager",
  "google-analytics", "doubleclick", "youtube", "ytimg", "facebook", "fbcdn",
  "tiktok", "adsrvr", "rubiconproject", "flashtalking", "company-target",
  "cookielaw", "onetrust", "tiqcdn", "tealium", "datadoghq", "newrelic",
  "segment", "hotjar", "optimizely", "sentry", "cloudflareinsights",
  "clients2", "clients4", "gvt1", "gvt2", "adnxs", "criteo", "bing",
]);

/* A loopback or private address is never the system under test either: it is
   the test harness, and a run from a cloud VM could not reach it. */
const LT_LOCAL = new RegExp("^(localhost|127\\.|0\\.0\\.0\\.0|10\\.|192\\.168\\.|" +
                            "172\\.(1[6-9]|2[0-9]|3[01])\\.|\\[?::1)", "i");
function ltIsLocal(host) {
  return LT_LOCAL.test(String(host));
}

function ltHeaders(user, key) {
  return { Authorization: "Basic " + btoa(user + ":" + key) };
}

function ltIsThirdParty(host) {
  const labels = String(host).replace(/:\d+$/, "").toLowerCase().split(".");
  return labels.some(function (label) {
    if (LT_VENDORS.has(label)) return true;
    for (const v of LT_VENDORS) if (label.endsWith("-" + v)) return true;
    return false;
  });
}

/* Ranking for the automatic pick: skip vendors and anything loopback, then
   take the busiest host that is left. Everything stays selectable by hand. */
function ltPickHost(ranked) {
  const real = ranked.filter(function (h) {
    return !h.thirdParty && !h.local;
  });
  return (real[0] || ranked.filter(function (h) { return !h.thirdParty; })[0]
                 || ranked[0] || {}).host;
}

/* ---- transport --------------------------------------------------------
   Roughly one call in ten comes back 500, so everything goes through here. */
async function ltFetch(url, headers, range, tries) {
  tries = tries || 3;
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const h = Object.assign({}, headers);
      if (range) h.Range = range;
      const r = await fetch(url, { headers: h });
      if (r.status === 401) throw new Error("the credentials were refused (401)");
      if (r.status === 403) throw new Error("those credentials cannot read this session (403)");
      if (r.ok || r.status === 206) return r;
      last = new Error("HTTP " + r.status + " from the session log API");
    } catch (e) {
      if (/\b(401|403)\b/.test(e.message)) throw e;
      last = e;
    }
    await new Promise(function (ok) { setTimeout(ok, 400 * (i + 1)); });
  }
  throw last || new Error("the request failed");
}

/* A missing capability is reported as HTTP 200 with a JSON body, so the only
   reliable signal is the content itself. Returns the message, or null when
   this really is an archive. */
function ltErrorMessage(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return null;  // "PK"
  try {
    const j = JSON.parse(new TextDecoder().decode(bytes.subarray(0, 4096)));
    return j.message || "the session returned no archive";
  } catch (e) {
    return "the session returned something that is not a HAR archive";
  }
}

/* ---- step 1: is there anything to fetch, and how big is it? ------------
   Two bytes answer both, so a 70 MB download never starts blind. */
async function ltProbe(user, key, sid) {
  const url = LT_BASE + "/sessions/" + sid + "/log/full-har";
  const r = await ltFetch(url, ltHeaders(user, key), "bytes=0-1");
  const bytes = new Uint8Array(await r.arrayBuffer());
  const msg = ltErrorMessage(bytes);
  if (msg) return { ok: false, bytes: 0, message: msg };
  const cr = r.headers.get("Content-Range") || "";
  const total = cr.indexOf("/") >= 0 ? parseInt(cr.split("/").pop(), 10) : 0;
  return { ok: true, bytes: total, ranges: !!cr };
}

/* ---- step 2: the zip, read member by member ---------------------------
   The central directory sits at the end, so the tail is fetched first and each
   member pulled on its own. Peak memory is then about one member rather than
   the whole archive plus its inflated contents. */
async function ltZipIndex(user, key, sid, total) {
  const url = LT_BASE + "/sessions/" + sid + "/log/full-har";
  const tail = Math.min(total, 65557);          // largest possible comment + EOCD
  const r = await ltFetch(url, ltHeaders(user, key),
                          "bytes=" + (total - tail) + "-" + (total - 1));
  const buf = new Uint8Array(await r.arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("the archive is truncated - no end-of-directory record");
  const count = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  const base = total - tail;
  if (cdOffset < base) throw new Error("the archive directory is larger than expected");
  let p = cdOffset - base;
  const members = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const nameLen = dv.getUint16(p + 28, true);
    const extLen = dv.getUint16(p + 30, true);
    const cmtLen = dv.getUint16(p + 32, true);
    members.push({
      method: dv.getUint16(p + 10, true),
      csize: dv.getUint32(p + 20, true),
      usize: dv.getUint32(p + 24, true),
      lho: dv.getUint32(p + 42, true),
      name: new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen)),
    });
    p += 46 + nameLen + extLen + cmtLen;
  }
  // 0-network.har, 1-network.har ... are buffer flushes, so keep them in order
  members.sort(function (a, b) {
    return (parseInt(a.name, 10) || 0) - (parseInt(b.name, 10) || 0);
  });
  return members;
}

async function ltMemberText(user, key, sid, m) {
  const url = LT_BASE + "/sessions/" + sid + "/log/full-har";
  // the local header repeats the name and extra fields, and its extra length
  // can differ from the directory's, so read it rather than assume
  const head = await ltFetch(url, ltHeaders(user, key),
                             "bytes=" + m.lho + "-" + (m.lho + 29));
  const hb = new Uint8Array(await head.arrayBuffer());
  const hv = new DataView(hb.buffer, hb.byteOffset, hb.byteLength);
  const start = m.lho + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
  const r = await ltFetch(url, ltHeaders(user, key),
                          "bytes=" + start + "-" + (start + m.csize - 1));
  const raw = new Uint8Array(await r.arrayBuffer());
  if (m.method === 0) return new TextDecoder().decode(raw);
  return await new Response(
    new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))
  ).text();
}

/* ---- step 3: the test's own steps -------------------------------------
   Every command is a boundary at a known moment. An annotated run (KaneAI)
   labels them itself; a plain Selenium run does not, and its rows still carry
   the WebDriver path, which names the step well enough to group by. The two
   are mixed rather than chosen between, because annotation coverage is
   partial in practice - 4 rows of 8, 5 of 9 - not all or nothing.

   Locators are not available: the requestBody comes back empty on every
   session checked, so a step is "Click an element", never "Click #search". */

/* Setup and teardown are not steps of the journey. */
const LT_SKIP_CMD = /^(timeouts|session$|window|screenshot|log|cookie|source|title|alert)/i;

/* The tail of a WebDriver path, as something a person would recognise. */
function ltNameFromPath(method, path) {
  if (!path) return "";
  if (/\/wd\/hub\/session$/.test(path) || method === "DELETE") return "";
  let tail = String(path).split("/session/")[1] || String(path);
  const parts = tail.split("/").filter(Boolean);
  parts.shift();                                   // the session id itself
  const head = (parts[0] || "").toLowerCase();
  if (!head || LT_SKIP_CMD.test(head)) return "";
  const last = (parts[parts.length - 1] || "").toLowerCase();
  if (head === "url") return "Open";
  if (head === "element" && last === "click") return "Click";
  if (head === "element" && last === "value") return "Type into";
  if (head === "element" && last === "clear") return "Clear";
  if (head === "element" || head === "elements") return "Find";
  if (head === "execute") return "Script";
  if (head === "forward") return "Forward to";
  if (head === "back") return "Back to";
  if (head === "refresh") return "Reload";
  if (head === "frame") return "Frame";
  return head;
}

/* What a request is, in a few words. Sites that route everything through one
   script keep the real target in the query, so a route-style parameter beats
   the path when there is one. */
const LT_ROUTE_KEYS = ["route", "action", "cmd", "op", "do", "page", "module"];
function ltShortTarget(url) {
  try {
    const u = new URL(url);
    for (const k of LT_ROUTE_KEYS) {
      const v = u.searchParams.get(k);
      if (v) return decodeURIComponent(v).slice(0, 44);
    }
    const path = u.pathname.replace(/\/+$/, "");
    return (path || "/").slice(-44);
  } catch (x) {
    return String(url).slice(0, 44);
  }
}

/* Selenium reports nanoseconds, the CDP log milliseconds. Reading one as the
   other moves every boundary by decades, so the unit is detected rather than
   assumed. */
function ltStamp(n) {
  const v = Number(n);
  if (!isFinite(v) || v <= 0) return 0;
  if (v > 1e15) return v / 1e6;      // nanoseconds
  if (v > 1e12) return v;            // milliseconds
  return v * 1000;                   // seconds
}

async function ltSteps(user, key, sid) {
  try {
    const r = await ltFetch(LT_BASE + "/sessions/" + sid + "/log/command",
                            ltHeaders(user, key));
    const j = await r.json();
    const rows = j.data || j || [];
    const steps = [];
    for (const row of rows) {
      const v = row.Value || row.value || {};
      const t = ltStamp(v.requestStartTime || row.timestamp);
      if (!t) continue;
      const ann = (row.annotation || v.heading || "").trim();
      const name = ann ? ltCleanLabel(ann)
                       : ltNameFromPath(v.requestMethod, v.requestPath);
      if (!name) continue;            // setup, teardown, and other non-steps
      steps.push({ t: t, name: name, fromAnnotation: !!ann });
    }
    steps.sort(function (a, b) { return a.t - b.t; });
    /* Two clicks in a row are two steps, but ten identical "Run a script" in a
       row are one: collapse only neighbours that share a derived name. */
    const out = [];
    for (const s of steps) {
      const prev = out[out.length - 1];
      if (prev && !s.fromAnnotation && !prev.fromAnnotation && prev.name === s.name) continue;
      out.push(s);
    }
    return out;
  } catch (e) {
    return [];                        // names are a bonus, never a blocker
  }
}

/* "Read cookie presence -> [{'domain': ...}]" is a step name with its result
   glued on. Keep the name, drop the result, and keep it legal in XML. */
function ltCleanLabel(s) {
  let out = String(s).split(/\s*(?:→|->)\s*/)[0];
  out = out.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (out.length > 70) out = out.slice(0, 67) + "...";
  return out || "Step";
}

/* HAR times are ISO-8601 UTC. Parsing them as local time silently shifts every
   entry out of its window, so the Z is left in place and Date.parse does it. */
function ltEntryTime(e) {
  const t = Date.parse(e.startedDateTime);
  return isFinite(t) ? t : 0;
}

/* Response bodies are the bulk of the archive and only matter for correlation,
   which only applies to text. Dropping the rest is what keeps the tab alive. */
const LT_TEXTUAL = /(json|text|xml|javascript|urlencoded|form-data)/i;
function ltStripBody(e) {
  const c = (e.response && e.response.content) || null;
  if (c && c.text && !LT_TEXTUAL.test(c.mimeType || "")) delete c.text;
  return e;
}

/* An hour of polling is four hundred identical GETs, and the plan wants one
   sampler. The recorder collapses across the whole capture; a session collapses
   within each transaction instead, because the same URL fetched during two
   different steps is two steps, and collapsing globally would empty the second
   one. Same key as the recorder otherwise: method, url and the head of the
   body. */
function ltRepeatKey(e) {
  const r = e.request || {};
  const body = r.postData ? "|" + String(r.postData.text || "").slice(0, 200) : "";
  return (r.method || "GET") + " " + (r.url || "") + body;
}

function ltCollapse(entries) {
  const seen = new Set();
  const out = [];
  let dropped = 0;
  for (const e of entries) {
    const tx = (e._jmxgen && e._jmxgen.transaction) || "";
    const key = tx + "\u0000" + ltRepeatKey(e);
    if (seen.has(key)) { dropped++; continue; }
    seen.add(key);
    out.push(e);
  }
  return { entries: out, dropped: dropped };
}

/* The engine names a sampler after its method and path, which is right until
   a site routes everything through one script. On OpenCart every page is
   index.php and the route lives in the query, so a journey comes out as
   twenty-five rows all reading "GET /index.php" and looks like a bug.

   So where two requests in the same transaction share a path, the query is
   put back into the name. Only there: adding it everywhere would make every
   ordinary name longer for no gain. The engine honours _jmxgen.name. */
function ltNameEntries(entries) {
  const bucket = new Map();
  for (const e of entries) {
    let path = "";
    try { path = new URL(e.request.url).pathname; } catch (x) { path = e.request.url; }
    /* Plan-wide, not per transaction: the requests table is read as one list,
       and splitting the journey into steps means a path now often appears once
       inside each of them while still repeating across the plan. */
    const key = (e.request.method || "GET") + " " + path;
    if (!bucket.has(key)) bucket.set(key, []);
    bucket.get(key).push({ e: e, path: path });
  }
  let renamed = 0;
  for (const rows of bucket.values()) {
    if (rows.length < 2) continue;              // no ambiguity, leave it alone
    for (const r of rows) {
      let q = "";
      try { q = new URL(r.e.request.url).search; } catch (x) { q = ""; }
      if (!q) continue;
      const name = (r.e.request.method || "GET") + " " + r.path + q;
      r.e._jmxgen = Object.assign({}, r.e._jmxgen, { name: name.slice(0, 110) });
      renamed++;
    }
  }
  return renamed;
}

/* Which request a step is really about. A navigation or a form post is the
   action; the rest of the burst is what the page pulled in afterwards. */
function ltPrimary(rows) {
  for (const e of rows) {
    const hs = e.request.headers || [];
    const dest = hs.filter(function (h) { return /^sec-fetch-dest$/i.test(h.name); })[0];
    if (dest && dest.value === "document") return e;
  }
  for (const e of rows) if ((e.request.method || "GET") !== "GET") return e;
  return rows[0];
}

/* Typing "iPhone" into a search box fires one request per keystroke. They are
   real traffic and a recorder keeps them, so these are reported rather than
   dropped - JMeter offers the same choice as "store 1st sampler of each group
   only", and it is an option there, not a default. */
function ltNoteRepeats(entries, log) {
  const groups = new Map();
  for (const e of entries) {
    let path = "";
    try { path = new URL(e.request.url).pathname; } catch (x) { path = e.request.url; }
    const tx = (e._jmxgen && e._jmxgen.transaction) || "";
    const key = tx + "\u0000" + (e.request.method || "GET") + " " + path + " " +
                ltShortTarget(e.request.url);
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  for (const [key, n] of groups) {
    if (n < 4) continue;
    const what = key.split("\u0000")[1];
    log(n + " near-identical requests to " + what.slice(0, 54) +
        " - typing into a field sends one per keystroke. Keep one unless the " +
        "autocomplete is what you are testing.");
  }
}


/* ---- the whole thing --------------------------------------------------- */
async function ltSessionHar(user, key, sid, opts) {
  opts = opts || {};
  const log = opts.log || function () {};
  const probe = await ltProbe(user, key, sid);
  if (!probe.ok) {
    const err = new Error(probe.message);
    err.guidance = "Re-run the test with network.full.har: true in the capabilities.";
    throw err;
  }
  log("archive is " + (probe.bytes / 1048576).toFixed(1) + " MB");
  if (opts.maxBytes && probe.bytes > opts.maxBytes) {
    const e = new Error("this session's archive is " +
      (probe.bytes / 1048576).toFixed(0) + " MB, over the " +
      (opts.maxBytes / 1048576).toFixed(0) + " MB limit");
    e.tooBig = probe.bytes;
    throw e;
  }

  const members = await ltZipIndex(user, key, sid, probe.bytes);
  log(members.length + " capture file(s) in the archive");

  const steps = await ltSteps(user, key, sid);
  const annotated = steps.filter(function (s) { return s.fromAnnotation; }).length;
  const source = !steps.length ? "navigation"
               : annotated ? "annotations" : "commands";
  log(!steps.length
      ? "no commands recorded - grouping by navigation instead"
      : steps.length + " step(s) from the test" +
        (annotated ? " (" + annotated + " named by the test itself)"
                   : " (named from its WebDriver commands)"));

  const entries = [];
  const hosts = new Map();
  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    let text;
    try {
      text = await ltMemberText(user, key, sid, m);
    } catch (e) {
      log("skipped " + m.name + ": " + e.message);
      continue;
    }
    let es;
    try {
      es = (JSON.parse(text).log || {}).entries || [];
    } catch (e) {
      log("skipped " + m.name + ": it is not valid HAR JSON");
      continue;
    }
    text = null;
    for (const e of es) {
      const url = (e.request && e.request.url) || "";
      const host = (url.split("/")[2] || "").toLowerCase();
      if (!host) continue;
      hosts.set(host, (hosts.get(host) || 0) + 1);
      entries.push(ltStripBody(e));
    }
    if (opts.onProgress) opts.onProgress(i + 1, members.length, entries.length);
  }
  log(entries.length + " request(s) captured across " + hosts.size + " host(s)");

  const ranked = Array.from(hosts.entries())
    .sort(function (a, b) { return b[1] - a[1]; })
    .map(function (p) {
      return { host: p[0], n: p[1], thirdParty: ltIsThirdParty(p[0]),
               local: ltIsLocal(p[0]) };
    });
  const host = opts.host || ltPickHost(ranked);
  if (!host) throw new Error("this session recorded no requests");

  const kept = entries.filter(function (e) {
    return (e.request.url.split("/")[2] || "").toLowerCase() === host;
  });
  if (!kept.length) {
    const e = new Error("nothing was recorded from " + host);
    e.hosts = ranked;
    throw e;
  }
  kept.sort(function (a, b) { return ltEntryTime(a) - ltEntryTime(b); });
  log(kept.length + " request(s) from " + host);

  if (steps.length) {
    /* Bucket by which step a request fell into, not by that step's name.
       A journey navigates eight times and every one of those is "Open"; naming
       first and grouping second merges all eight into a single controller,
       which is JMeter's own "do not group samplers" - the mode its manual
       warns makes it impossible to tell which request belongs to which action. */
    const buckets = new Map();
    for (const e of kept) {
      const t = ltEntryTime(e);
      let at = 0;
      for (let i = 0; i < steps.length; i++) if (t >= steps[i].t) at = i;
      if (!buckets.has(at)) buckets.set(at, []);
      buckets.get(at).push(e);
    }

    /* A step is named after the request it caused, the way a recorder names a
       transaction controller after the action it recorded. A name the test
       wrote itself always wins. */
    const used = new Map();
    const order = Array.from(buckets.keys()).sort(function (a, b) { return a - b; });
    for (const at of order) {
      const rows = buckets.get(at);
      const step = steps[at];
      let name;
      if (step && step.fromAnnotation) {
        name = step.name;
      } else {
        const primary = ltPrimary(rows);
        const verb = (step && step.name) || "Step";
        name = (verb + " " + ltShortTarget(primary.request.url)).slice(0, 70);
      }
      const seen = used.get(name) || 0;
      used.set(name, seen + 1);
      const label = seen ? name + " " + (seen + 1) : name;
      for (const e of rows) {
        e._jmxgen = Object.assign({}, e._jmxgen, { transaction: label });
      }
    }
    log("grouped into " + order.length + " transaction(s) from the test's own steps");
    ltNoteRepeats(kept, log);
  } else {
    // no annotations: a top-level navigation on this host starts a new group
    let current = "Step 1";
    let n = 1;
    for (const e of kept) {
      const hs = e.request.headers || [];
      const dest = hs.filter(function (h) { return /^sec-fetch-dest$/i.test(h.name); })[0];
      const mode = hs.filter(function (h) { return /^sec-fetch-mode$/i.test(h.name); })[0];
      if ((dest && dest.value === "document") || (mode && mode.value === "navigate")) {
        let path = "/";
        try { path = new URL(e.request.url).pathname; } catch (x) { /* keep / */ }
        current = ltCleanLabel((n === 1 ? "Open " : "Go to ") + path);
        n++;
      }
      e._jmxgen = Object.assign({}, e._jmxgen, { transaction: current });
    }
    const landed = new Set(kept.map(function (e) {
      return e._jmxgen.transaction;
    })).size;
    log("grouped into " + landed + " navigation step(s)");
  }

  const renamed = ltNameEntries(kept);
  if (renamed) {
    log(renamed + " sampler(s) named with their query, so requests through one " +
        "script can be told apart");
  }

  let finalEntries = kept;
  if (opts.collapse !== false) {
    const c = ltCollapse(kept);
    finalEntries = c.entries;
    if (c.dropped) {
      log(c.dropped + " repeated request(s) collapsed, leaving " +
          finalEntries.length + " sampler(s)");
    }
  }

  return {
    har: {
      log: {
        version: "1.2",
        creator: { name: "jmxgen", version: "1" },
        pages: [],
        entries: finalEntries,
      },
    },
    host: host,
    hosts: ranked,
    total: entries.length,
    kept: finalEntries.length,
    beforeCollapse: kept.length,
    named: steps.length > 0,
    source: source,
    bytes: probe.bytes,
  };
}

async function ltListSessions(user, key, limit) {
  const r = await ltFetch(LT_BASE + "/sessions?limit=" + (limit || 25),
                          ltHeaders(user, key));
  const j = await r.json();
  return (j.data || []).map(function (s) {
    return {
      id: s.session_id, name: s.name || s.session_id, status: s.status_ind,
      build: s.build_name, when: s.create_timestamp,
    };
  });
}

window.LT = {
  ltSessionHar: ltSessionHar,
  ltPickHost: ltPickHost,
  ltIsLocal: ltIsLocal,
  ltProbe: ltProbe,
  ltListSessions: ltListSessions,
  ltIsThirdParty: ltIsThirdParty,
  ltCleanLabel: ltCleanLabel,
};
