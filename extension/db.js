/* Where a recording actually lives.
 *
 * chrome.storage.session holds ten megabytes and is wiped when the browser
 * restarts, which is fine for a checkpoint and useless for a recording: an
 * hour of real use passes that inside a few minutes. IndexedDB is disk-backed,
 * sized against the browser's storage quota, and survives both service-worker
 * eviction and a restart. Extension pages share the worker's origin, so the
 * authoring page opens this same database instead of being handed a copy of
 * the recording through message passing.
 *
 * Nothing here truncates, samples or summarises. A request that was captured
 * is a request you get back.
 *
 * Loaded by the worker with importScripts and by the pages with a script tag,
 * so it defines globals rather than exporting.
 */

const CAPTURE_DB = "jmxgen-capture";
const CAPTURE_VERSION = 1;

function openCapture() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CAPTURE_DB, CAPTURE_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // seq is assigned by the recorder and is monotonic, so the natural key
      // order is capture order - no sorting, and a cursor reads the journey
      // back in the order it happened
      if (!db.objectStoreNames.contains("entries")) {
        db.createObjectStore("entries", { keyPath: "seq" });
      }
      // Bodies live apart from the records that point at them. Counting the
      // session, listing its transactions or drawing the popup then reads only
      // small rows; a twenty-megabyte response is fetched when the engine
      // actually needs it, and never when it does not.
      if (!db.objectStoreNames.contains("bodies")) {
        db.createObjectStore("bodies", { keyPath: "seq" });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "k" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("write aborted"));
  });
}

/* Many entries, one transaction. Committing per request costs a disk round
   trip each time, which is what makes a long recording feel heavy. */
async function putEntries(list, bodies) {
  if (!list.length && !(bodies && bodies.length)) return;
  const db = await openCapture();
  const tx = db.transaction(["entries", "bodies"], "readwrite");
  const entries = tx.objectStore("entries");
  const bodyStore = tx.objectStore("bodies");
  for (const e of list) entries.put(e);
  for (const b of bodies || []) bodyStore.put(b);
  await txDone(tx);
  db.close();
}

async function countEntries() {
  const db = await openCapture();
  const tx = db.transaction("entries", "readonly");
  const n = await new Promise((resolve, reject) => {
    const r = tx.objectStore("entries").count();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  db.close();
  return n;
}

async function getBody(seq) {
  const db = await openCapture();
  const tx = db.transaction("bodies", "readonly");
  const v = await new Promise((resolve, reject) => {
    const r = tx.objectStore("bodies").get(seq);
    r.onsuccess = () => resolve(r.result ? r.result.text : "");
    r.onerror = () => reject(r.error);
  });
  db.close();
  return v;
}

/* Walks the recording in capture order, handing over one entry at a time and,
   when asked, its body. `withBodies` reads both stores in a single transaction,
   so streaming an hour-long session into the engine is one pass over the disk
   rather than one lookup per request. */
async function eachEntryWithBody(fn) {
  const db = await openCapture();
  const tx = db.transaction(["entries", "bodies"], "readonly");
  const bodies = tx.objectStore("bodies");
  await new Promise((resolve, reject) => {
    const req = tx.objectStore("entries").openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      const entry = cur.value;
      if (entry.hasBody === false) {
        Promise.resolve(fn(entry, "")).then((keep) =>
          keep === false ? resolve() : cur.continue());
        return;
      }
      const b = bodies.get(entry.seq);
      b.onsuccess = () => {
        Promise.resolve(fn(entry, b.result ? b.result.text : "")).then((keep) =>
          keep === false ? resolve() : cur.continue());
      };
      b.onerror = () => reject(b.error);
    };
    req.onerror = () => reject(req.error);
  });
  db.close();
}

/* A cursor, deliberately: reading an hour of capture with getAll() would put
   the whole recording in memory at once, which is the thing this store exists
   to avoid. The caller gets one entry at a time and decides what to keep. */
async function eachEntry(fn) {
  const db = await openCapture();
  const tx = db.transaction("entries", "readonly");
  await new Promise((resolve, reject) => {
    const req = tx.objectStore("entries").openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      const keep = fn(cur.value);
      if (keep === false) return resolve();     // caller stopped early
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
  db.close();
}

async function getEntry(seq) {
  const db = await openCapture();
  const tx = db.transaction("entries", "readonly");
  const v = await new Promise((resolve, reject) => {
    const r = tx.objectStore("entries").get(seq);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
  db.close();
  return v;
}

async function putEntry(entry) {
  await putEntries([entry]);
}

async function deleteEntry(seq) {
  const db = await openCapture();
  const tx = db.transaction(["entries", "bodies"], "readwrite");
  tx.objectStore("entries").delete(seq);
  tx.objectStore("bodies").delete(seq);
  await txDone(tx);
  db.close();
}

/* The last captured request, which is what every annotation in the on-page
   panel applies to. One cursor step from the end, not a scan. */
async function lastStored() {
  const db = await openCapture();
  const tx = db.transaction("entries", "readonly");
  const v = await new Promise((resolve, reject) => {
    const r = tx.objectStore("entries").openCursor(null, "prev");
    r.onsuccess = () => resolve(r.result ? r.result.value : null);
    r.onerror = () => reject(r.error);
  });
  db.close();
  return v;
}

async function clearCapture() {
  const db = await openCapture();
  const tx = db.transaction(["entries", "bodies", "meta"], "readwrite");
  tx.objectStore("entries").clear();
  tx.objectStore("bodies").clear();
  tx.objectStore("meta").clear();
  await txDone(tx);
  db.close();
}

/* Session metadata: counters, the current transaction, the browser steps. Small
   at any recording length, and kept here as well as in session storage so a
   browser restart can still find the recording sitting on disk. */
async function putMeta(meta) {
  const db = await openCapture();
  const tx = db.transaction("meta", "readwrite");
  tx.objectStore("meta").put({ k: "session", ...meta });
  await txDone(tx);
  db.close();
}

async function getMeta() {
  const db = await openCapture();
  const tx = db.transaction("meta", "readonly");
  const v = await new Promise((resolve, reject) => {
    const r = tx.objectStore("meta").get("session");
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
  db.close();
  return v;
}

/* What the browser will actually let us keep. Shown in the popup so a long
   recording is visible while it grows, rather than at the moment it breaks. */
async function captureQuota() {
  try {
    const est = await navigator.storage.estimate();
    return { used: est.usage || 0, quota: est.quota || 0 };
  } catch (e) {
    return { used: 0, quota: 0 };
  }
}

/* Turning a stored record back into a HAR entry.
 *
 * The fields the engine ignores are reconstructed here rather than stored:
 * queryString comes back out of the URL, timings and cache are the zeros a HAR
 * requires, sizes are -1 for "unknown", which is what DevTools itself writes
 * when it does not know. The file that comes out is a valid HAR that DevTools,
 * Charles and BlazeMeter all read.
 */
function harEntryOf(rec, body) {
  const req = rec.request || {};
  const res = rec.response || {};
  const isAsset = rec.hasBody === false && !req.headers;
  return {
    pageref: rec.tx,
    startedDateTime: rec.startedDateTime,
    time: 0,
    cache: {},
    timings: { send: 0, wait: 0, receive: 0 },
    request: {
      method: req.method || "GET",
      url: req.url,
      httpVersion: "HTTP/1.1",
      headers: req.headers || [],
      queryString: queryArray(req.url),
      cookies: [],
      headersSize: -1,
      bodySize: req.postData ? (req.postData.text || "").length : 0,
      ...(req.postData ? { postData: req.postData } : {}),
    },
    response: {
      status: res.status || 0,
      statusText: "",
      httpVersion: "HTTP/1.1",
      headers: [],
      cookies: [],
      redirectURL: res.redirectURL || "",
      headersSize: -1,
      bodySize: body ? body.length : -1,
      content: {
        size: body ? body.length : (isAsset ? -1 : 0),
        mimeType: res.mimeType || "",
        text: body || "",
      },
    },
    // Chrome knows what each request IS (document / xhr / fetch / script /
    // image / font). Keeping it lets one recording produce either an API-level
    // or a full browser-level plan. _resourceType is what DevTools' own HAR
    // export uses, so other tools understand it too.
    _resourceType: rec.type || "",
    _jmxgen: { ...(rec._jmxgen || {}), type: rec.type || "" },
  };
}

function harHeader(meta) {
  const pages = ((meta && meta.transactions) || []).map((t, i) => ({
    id: t,
    title: t,
    startedDateTime: isoTime((meta && meta.startedAt) + i),
    pageTimings: { onContentLoad: -1, onLoad: -1 },
  }));
  return {
    version: "1.2",
    creator: { name: "testmu-jmeter-studio", version: "1.2.0" },
    browser: { name: "Chrome", version: "" },
    pages,
    // the browser steps ride in the HAR's own extension field, so one file
    // still carries the whole session and `from-har` can emit both plans
    _jmxgen: { authoredWith: "testmu-jmeter-studio", recordedAt: isoTime(meta && meta.startedAt),
               actions: (meta && meta.actions) || [] },
  };
}

/* Streams the recording out of the store, one entry at a time, calling `write`
 * with each chunk of HAR text. Nothing larger than a single entry is ever held
 * in memory here - which is the point, because the caller may be writing an
 * hour-long session into a file.
 *
 * `opts.skipAssets` leaves asset stubs out entirely, for the modes where the
 * engine would discard them anyway: an hour of browsing is 40,000 requests of
 * which perhaps 3,000 are service calls, and there is no reason for the other
 * 37,000 to cross into Python to be dropped there.
 */
/* What is in the recording, by transaction. An hour-long session is authored
   by choosing the parts of it you want, so the page needs the list and the
   counts before anything is generated. */
async function transactionCounts() {
  const counts = new Map();
  await eachEntry((rec) => {
    const tx = rec.tx || "Recorded";
    const c = counts.get(tx) || { name: tx, total: 0, api: 0 };
    c.total++;
    if (!(rec.hasBody === false && !(rec.request && rec.request.headers))) c.api++;
    counts.set(tx, c);
  });
  return [...counts.values()];
}

function repeatKey(rec) {
  const req = rec.request || {};
  return (req.method || "GET") + " " + (req.url || "") +
         (req.postData ? "|" + (req.postData.text || "").slice(0, 200) : "");
}

async function streamHar(write, opts) {
  const o = opts || {};
  const head = harHeader(await getMeta());
  const stats = { total: 0, written: 0, assets: 0, skipped: 0, repeats: 0 };
  const only = o.only && o.only.length ? new Set(o.only) : null;
  const seen = o.collapse ? new Map() : null;

  write('{"log":{"version":"1.2","creator":' + JSON.stringify(head.creator) +
        ',"browser":' + JSON.stringify(head.browser) +
        ',"pages":' + JSON.stringify(head.pages) +
        ',"_jmxgen":' + JSON.stringify(head._jmxgen) + ',"entries":[');

  let first = true;
  await eachEntryWithBody((rec, body) => {
    stats.total++;
    if (rec._jmxgen && rec._jmxgen.skip) { stats.skipped++; return; }
    const asset = rec.hasBody === false && !(rec.request && rec.request.headers);
    if (asset) stats.assets++;
    if (asset && o.skipAssets) { stats.skipped++; return; }
    // author the parts of a long session you actually want
    if (only && !only.has(rec.tx || "Recorded")) { stats.skipped++; return; }
    // an hour of polling is four hundred identical GETs; the plan wants one
    // sampler, and the count of how often it ran
    if (seen) {
      const key = repeatKey(rec);
      const first = seen.get(key);
      if (first) {
        first.hits++;
        stats.repeats++;
        stats.skipped++;
        return;
      }
      seen.set(key, { hits: 1 });
    }
    write((first ? "" : ",") + JSON.stringify(harEntryOf(rec, body)));
    first = false;
    stats.written++;
  });

  write("]}}");
  return stats;
}


function isoTime(ms) {
  return new Date(ms || Date.now()).toISOString();
}

function queryArray(url) {
  try {
    const u = new URL(url);
    return [...u.searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch (e) {
    return [];
  }
}

/* Ask the browser not to evict this origin under disk pressure. Without it a
   long recording is a candidate for cleanup at exactly the wrong moment. */
async function keepOnDisk() {
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch (e) {
    return false;
  }
}

const CaptureStore = {
  putEntries, putEntry, getEntry, getBody, deleteEntry, lastStored,
  eachEntry, eachEntryWithBody,
  countEntries, clearCapture, putMeta, getMeta, captureQuota, keepOnDisk,
};

/* The read side, shared by the worker and the authoring page so a recording is
   reconstructed one way only. */
const CaptureRead = { stream: streamHar, count: countEntries, entry: harEntryOf,
                      transactions: transactionCounts };

if (typeof self !== "undefined") {
  self.CaptureStore = CaptureStore;
  self.CaptureRead = CaptureRead;
}
