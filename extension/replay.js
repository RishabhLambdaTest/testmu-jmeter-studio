/* Replay the plan once, here, and say what a run would do.
 *
 * This is the pre-flight that used to need a JMeter binary. An extension page
 * holds host permissions, so it can send the plan's own requests, follow its
 * own variables, and read what comes back. One user, in order, once.
 *
 * What it is not: a load test, and not JMeter. It does not run JSR223 scripts,
 * JDBC steps or WebDriver steps, and it counts the requests it skipped rather
 * than pretending they passed. What it does catch is the failure that matters
 * before a paid run: a value that was recorded, replayed, and is now stale.
 *
 * The comparison afterwards is the useful half. Every request that failed is
 * searched for values that THIS replay has already seen coming back from an
 * earlier response - which is the definition of a dynamic value - and each one
 * becomes a suggestion: extract it there, use it here.
 */

const RP_MAX_BODY = 2 * 1024 * 1024;     // per response, kept for matching
const RP_MIN_DYNAMIC = 6;                // shorter values match by accident
/* the browser's own headers: a Content-Type is not a dynamic value */
const RP_HDR_SKIP = new Set(["content-type", "accept", "accept-language", "accept-encoding",
  "cache-control", "pragma", "origin", "referer", "user-agent", "connection", "host",
  "x-requested-with", "content-length", "upgrade-insecure-requests"]);

/* ---- the plan, flattened -------------------------------------------------
   Each entry keeps the path to its step in the spec, so a suggestion can be
   applied to the right one later. */
function rpFlatten(spec) {
  const out = [];
  (spec.thread_groups || []).forEach((tg, gi) => {
    if (tg.browser) return;              // the Playwright half, not this one
    const walk = (steps, at) => (steps || []).forEach((st, i) => {
      const here = at.concat([i]);
      if (st.steps) return walk(st.steps, here);
      out.push({ step: st, at: [gi].concat(here) });
    });
    walk(tg.steps, []);
  });
  return out;
}

const rpVarsIn = (s) => [...String(s == null ? "" : s).matchAll(/\$\{([\w.]+)\}/g)].map((m) => m[1]);

function rpSubst(value, vars) {
  if (value == null) return value;
  return String(value).replace(/\$\{([\w.]+)\}/g, (all, name) =>
    (name in vars ? vars[name] : all));
}

/* ---- extractors, as JMeter would apply them ---------------------------- */

function rpJsonPath(doc, expr) {
  const out = [];
  const path = String(expr || "").trim();
  if (path.startsWith("$..")) {
    const key = path.slice(3);
    const rec = (n) => {
      if (Array.isArray(n)) n.forEach(rec);
      else if (n && typeof n === "object") {
        for (const [k, v] of Object.entries(n)) {
          if (k === key) out.push(v);
          rec(v);
        }
      }
    };
    rec(doc);
    return out;
  }
  let cur = [doc];
  for (const m of path.slice(1).matchAll(/\.([^.[]+)|\[(\d+|\*)\]/g)) {
    const [, key, idx] = m;
    const next = [];
    for (const c of cur) {
      if (key && c && typeof c === "object" && key in c) next.push(c[key]);
      else if (idx && Array.isArray(c)) {
        if (idx === "*") next.push(...c);
        else if (c[Number(idx)] !== undefined) next.push(c[Number(idx)]);
      }
    }
    cur = next;
  }
  return cur;
}

function rpExtract(ex, body, headersText) {
  try {
    if (ex.type === "json") {
      const hits = rpJsonPath(JSON.parse(body), ex.query);
      return hits.length ? String(hits[0]) : null;
    }
    if (ex.type === "boundary") {
      const i = body.indexOf(ex.left);
      if (i < 0) return null;
      const from = i + ex.left.length;
      const j = ex.right ? body.indexOf(ex.right, from) : body.length;
      return j < 0 ? null : body.slice(from, j);
    }
    if (ex.type === "regex") {
      const text = String(ex.scope_field) === "true" ? headersText : body;
      // fetch lower-cases response header names; JMeter matches them as sent,
      // so a pattern written from the recording needs the case ignored here
      const m = new RegExp(ex.query, String(ex.scope_field) === "true" ? "i" : "").exec(text);
      return m ? (m[1] !== undefined ? m[1] : m[0]) : null;
    }
  } catch (e) {
    return null;
  }
  return null;
}

/* ---- one request ------------------------------------------------------- */

function rpUrl(step, defaults, vars) {
  const path = rpSubst(step.path || "/", vars);
  if (/^https?:\/\//i.test(path)) return path;
  const proto = step.protocol || defaults.protocol || "https";
  const host = step.domain || defaults.domain || "";
  const port = step.port || defaults.port || "";
  return `${proto}://${host}${port ? ":" + port : ""}${path.startsWith("/") ? "" : "/"}${path}`;
}

async function rpSend(step, spec, vars) {
  const defaults = spec.defaults || {};
  const headers = {};
  for (const [k, v] of Object.entries(spec.headers || {})) headers[k] = rpSubst(v, vars);
  for (const [k, v] of Object.entries(step.headers || {})) headers[k] = rpSubst(v, vars);
  const method = (step.method || "GET").toUpperCase();

  let body;
  if (step.body != null) {
    body = rpSubst(typeof step.body === "string" ? step.body : JSON.stringify(step.body), vars);
  } else if (step.params && Object.keys(step.params).length) {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(step.params)) form.append(k, rpSubst(v, vars));
    if (method === "GET" || method === "HEAD") {
      // JMeter puts a GET's parameters in the query string
      const u = new URL(rpUrl(step, defaults, vars));
      form.forEach((v, k) => u.searchParams.append(k, v));
      return rpFetch(u.toString(), method, headers, undefined);
    }
    body = form.toString();
    if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
  }
  return rpFetch(rpUrl(step, defaults, vars), method, headers, body);
}

async function rpFetch(url, method, headers, body) {
  const t0 = performance.now();
  const r = await fetch(url, {
    method, headers, body,
    // cookies as a browser would, which is what the plan's cookie manager does
    credentials: "include",
    redirect: "follow",
    cache: "no-store",
  });
  let text = "";
  try {
    const buf = await r.arrayBuffer();
    text = new TextDecoder().decode(buf.slice(0, RP_MAX_BODY));
  } catch (e) { /* a body we cannot read is still a result */ }
  const headerLines = [];
  r.headers.forEach((v, k) => headerLines.push(k + ": " + v));
  /* A redirect the browser followed is gone by the time we see the response -
     fetch exposes no Location, and redirect:"manual" returns an opaque result
     with no headers at all. The final URL is what is left of it, and it still
     carries what the hop handed over (?code=..., ?token=...), so it stands in
     for the Location line an extractor was written against. */
  if (r.redirected && r.url) headerLines.push("Location: " + r.url);
  return {
    url, code: r.status, ok: r.ok, body: text, redirected: !!r.redirected,
    headersText: headerLines.join("\n"),
    ms: Math.round(performance.now() - t0),
  };
}

/* ---- the run ----------------------------------------------------------- */

const RP_SKIP = new Set(["jdbc", "jsr223", "groovy", "graphql", "webdriver", "wd", "browser", "raw"]);

async function replayPlan(spec, opts = {}) {
  const log = opts.log || (() => {});
  const vars = Object.assign({}, spec.variables || {});
  const flat = rpFlatten(spec);
  const samples = [];
  const seen = [];                 // every response so far, for the comparison
  let skipped = 0;

  for (let i = 0; i < flat.length; i++) {
    const { step, at } = flat[i];
    if (step.pause != null) continue;
    const kind = (step.type || "http").toLowerCase();
    if (RP_SKIP.has(kind)) { skipped++; continue; }

    const name = step.name || `${step.method || "GET"} ${step.path || "/"}`;
    const unresolved = [];
    for (const field of [step.path, JSON.stringify(step.params || {}), JSON.stringify(step.headers || {}),
                         typeof step.body === "string" ? step.body : JSON.stringify(step.body || "")]) {
      for (const v of rpVarsIn(field)) if (!(v in vars)) unresolved.push(v);
    }

    let res, error = null;
    try {
      res = await rpSend(step, spec, vars);
    } catch (e) {
      error = String((e && e.message) || e);
    }
    if (opts.onProgress) opts.onProgress(i + 1, flat.length, name);

    if (!res) {
      samples.push({ name, at, code: 0, ok: false, ms: 0,
                     message: "the request failed: " + error, unresolved });
      continue;
    }

    // extractors, in order, so a later step can use what this one found
    const extracted = {};
    for (const ex of step.extract || []) {
      const got = rpExtract(ex, res.body, res.headersText);
      if (got == null) {
        extracted[ex.var] = null;
      } else {
        vars[ex.var] = got;
        extracted[ex.var] = got;
      }
    }

    // assertions, as the plan states them
    const failures = [];
    for (const a of step.assert || []) {
      const field = a.field === "code" ? String(res.code) : res.body;
      const pattern = rpSubst(a.pattern, vars);
      const hit = a.match === "equals" ? field === pattern
                : a.match === "matches" ? new RegExp(pattern).test(field)
                : field.includes(pattern);
      if (!hit) failures.push(`${a.field} ${a.match} ${JSON.stringify(pattern)}`);
    }
    const missed = Object.entries(extracted).filter(([, v]) => v === null).map(([k]) => k);
    /* A step the plan does NOT follow redirects on is one a browser follows
       anyway: fetch has no way to stop at the 302, and redirect:"manual" hands
       back an opaque result with no status and no headers. So the hop's own
       result is reported as a note, not as this step's failure - JMeter would
       have stopped at the redirect and moved on to the next sampler. */
    const browserFollowed = step.follow_redirects === false && res.redirected;
    const ok = (res.ok || browserFollowed) && !failures.length && !missed.length && !unresolved.length;

    samples.push({
      name, at, code: res.code, ok, ms: res.ms,
      message: [
        browserFollowed
          ? `the browser followed this redirect (ended HTTP ${res.code}); JMeter stops at it`
          : !res.ok ? `HTTP ${res.code}` : "",
        failures.length ? "assertion failed: " + failures.join(", ") : "",
        missed.length ? "extractor found nothing: " + missed.join(", ") : "",
        unresolved.length ? "no value for ${" + unresolved.join("}, ${") + "}" : "",
      ].filter(Boolean).join(" · "),
      extracted, unresolved,
    });
    seen.push({ at, name, body: res.body, headersText: res.headersText, index: samples.length - 1 });
  }
  const suggestions = await rpSuggest(flat, samples, seen, opts);
  return { samples, suggestions, skipped, vars };
}

/* ---- what the failures have in common ----------------------------------
   A literal in a failing request that an earlier response handed out is a
   dynamic value that was never correlated. Correlation wizards reach the same
   conclusion by comparing a replay with its recording; here the replay itself
   is the evidence. */
function rpLiterals(step) {
  const out = [];
  const add = (label, v) => {
    const s = String(v == null ? "" : v);
    if (s.length >= RP_MIN_DYNAMIC && !s.includes("${")) out.push([label, s]);
  };
  const u = String(step.path || "");
  for (const m of u.matchAll(/[?&]([^=&]+)=([^&#]+)/g)) add(m[1], decodeURIComponent(m[2]));
  /* A path segment is a route far more often than an id: /oauth/authorize is
     not a dynamic value, and replacing it plan-wide breaks every URL that
     shares the word. Only a segment that looks issued - a digit, or a mix of
     cases and separators - is a candidate. */
  const segs = u.split("?")[0].split("/");
  segs.forEach((seg, i) => {
    if (/^[a-z]+$/i.test(seg)) return;
    // /api/orders/904173 -> ORDERS_ID, rather than ${PATH}: the segment before
    // it is what the id belongs to, and the name has to read in the plan
    const owner = [...segs.slice(0, i)].reverse().find((x) => /^[a-z][a-z_-]*$/i.test(x));
    add(owner ? owner.replace(/s$/, "") + "_id" : "path", seg);
  });
  for (const [k, v] of Object.entries(step.params || {})) add(k, v);
  for (const [k, v] of Object.entries(step.headers || {})) {
    if (RP_HDR_SKIP.has(k.toLowerCase())) continue;
    const val = String(v);
    const m = /^(Bearer|Basic|Token|JWT)\s+(\S+)$/i.exec(val);
    add(k, m ? m[2] : val);
  }
  if (typeof step.body === "string") {
    try {
      const walk = (n, key) => {
        if (Array.isArray(n)) n.forEach((x) => walk(x, key));
        else if (n && typeof n === "object") for (const [k, v] of Object.entries(n)) walk(v, k);
        else add(key || "body", n);
      };
      walk(JSON.parse(step.body), null);
    } catch (e) {
      for (const m of step.body.matchAll(/([\w.\-]+)=([^&\s]{6,})/g)) add(m[1], m[2]);
    }
  }
  return out;
}

async function rpSuggest(flat, samples, seen, opts) {
  const out = [];
  const suggest = opts.suggest || (window.JmxgenEngine && window.JmxgenEngine.suggestExtractor);
  const trace = opts.trace || (window.JmxgenEngine && window.JmxgenEngine.traceValue);
  const byName = new Map(flat.map((f) => [f.step.name || "", f]));
  const taken = new Set();

  for (const sample of samples) {
    if (sample.ok) continue;
    const entry = flat.find((f) => String(f.at) === String(sample.at));
    if (!entry) continue;
    for (const [label, value] of rpLiterals(entry.step)) {
      if (taken.has(value)) continue;

      /* Two ways to find where a value comes from, and both are needed.

         In THIS replay: the plan produced it a moment ago, so the source is
         right there. This is the case for a value the plan half-correlates.

         In the RECORDING: the usual case. The replay's own responses carry
         fresh values, so a stale literal appears in none of them - which is
         exactly why the request failed. The recording still has the response
         that handed it out. */
      let from = null, fromAt = null, ex = null;
      const live = seen.filter((sn) => sn.index < samples.indexOf(sample))
        .reverse()
        .find((sn) => sn.body.includes(value) || sn.headersText.includes(value));
      if (live && suggest) {
        try {
          ex = await suggest(live.body, live.headersText, value, label);
        } catch (e) { /* fall through to the recording */ }
        if (ex) { from = live.name; fromAt = live.at; }
      }
      if (!ex && trace) {
        let hit = null;
        try {
          hit = await trace(value, label);
        } catch (e) { /* a value we cannot place is not a suggestion */ }
        if (hit && hit.extract) {
          const target = byName.get(hit.name);
          if (target) { ex = hit.extract; from = hit.name; fromAt = target.at; }
        }
      }
      if (!ex || !fromAt || String(fromAt) === String(sample.at)) continue;

      taken.add(value);
      out.push({
        var: (ex.var || label).toString().replace(/\W+/g, "_").toUpperCase().slice(0, 40),
        value, label, extract: ex,
        from, fromAt, into: sample.name, intoAt: sample.at,
        why: sample.message,
      });
    }
  }
  return out;
}

window.Replay = { run: replayPlan, extract: rpExtract, jsonPath: rpJsonPath };
