/* TestMu AI — JMeter Studio - service worker.
 *
 * Attaches the DevTools protocol to the recorded tab, collects every
 * request/response (bodies included), merges in the steps the user authors by
 * hand, and exports a HAR that jmxgen reads directly. Manual annotations ride
 * along in `_jmxgen` fields, which the HAR spec allows and other tools ignore.
 */

importScripts("db.js");

const PROTOCOL = "1.3";
const RECORDABLE = /^https?:\/\//i;

/* Assets carry no bytes that can change a .jmx. A font's content cannot be
   correlated, asserted on or sent by a sampler - only its URL, method and type
   matter, and those are what a `web` plan needs. So an asset is stored as a
   stub, which is why one recording still authors either kind of plan without
   ever storing a megabyte of CSS. */
const ASSET_TYPES = new Set(["image", "font", "media", "stylesheet", "script",
                             "manifest", "other-static"]);

/* A response bigger than this cannot be pulled back out of Chrome anyway - it
   is over the per-resource buffer we asked for on Network.enable - so the
   request is kept with a note rather than being lost. */
const MAX_BODY = 20 * 1024 * 1024;

/* Streaming endpoints never emit loadingFinished. Without a sweep they sit in
   `pending` for the life of the recording and never reach the store. */
const PENDING_TIMEOUT = 120 * 1000;

let state = null;      // null when idle; never holds captured entries

function freshState(tabId, transaction) {
  const tx = transaction || "Recorded";
  return {
    tabId,
    tabIds: [tabId],          // + any popup/new tab opened from it
    startedAt: Date.now(),
    transaction: tx,
    transactions: [tx],
    pending: {},         // requestId -> partial entry, in memory only
    actions: [],         // recorded browser steps, in order
    seq: 0,              // next entry key; the store is keyed by it
    count: 0,            // captured so far
    bytes: 0,            // response text held on disk, for the popup
    lastSeq: -1,
    lastUrl: "",
    exported: false,     // false as soon as anything new is captured
  };
}

/* A recording is a session, not an append to the last one. */
async function beginCapture() {
  queue = [];
  bodyQueue = [];
  await CaptureStore.clearCapture().catch(() => {});
  // ask the browser not to evict this origin mid-session; an hour of capture
  // is exactly the kind of thing a storage-pressure sweep would take
  CaptureStore.keepOnDisk().catch(() => {});
}

/* The checkpoint is metadata only - counters, the current transaction, the
 * browser steps. The recording itself lives in IndexedDB, so this is a few
 * kilobytes at any session length and can no longer overflow the ten megabytes
 * session storage allows. It is written to both places: session storage for
 * speed, and the database so a browser restart can still find the recording.
 */
let persistTimer = null;

function metaOf() {
  const { pending, ...rest } = state;
  return { ...rest, pending: {} };
}

async function writeCheckpoint() {
  if (!state) {
    await chrome.storage.session.remove("state").catch(() => {});
    await CaptureStore.putMeta({ live: false }).catch(() => {});
    return;
  }
  const meta = metaOf();
  await chrome.storage.session.set({ state: meta }).catch(() => {});
  await CaptureStore.putMeta({ live: true, ...meta }).catch(() => {});
}

function persist() {
  if (persistTimer) return Promise.resolve();
  persistTimer = setTimeout(() => {
    persistTimer = null;
    writeCheckpoint();
  }, 1200);
  return Promise.resolve();
}

async function persistNow() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  await flushEntries();
  await writeCheckpoint();
}

/* ---- the write path ------------------------------------------------------
   Entries queue and go to disk in batches. One transaction per request costs a
   round trip each time, which is what makes a long recording feel heavy;
   batched, capture costs 0.03 ms per request. */
let queue = [];        // entries not yet written
let bodyQueue = [];    // their bodies, stored separately so scans stay cheap
let flushTimer = null;
let flushing = null;

function queueEntry(entry, body) {
  queue.push(entry);
  if (body != null) bodyQueue.push({ seq: entry.seq, text: body });
  if (queue.length >= 25) return flushEntries();
  if (!flushTimer) flushTimer = setTimeout(() => flushEntries(), 250);
  return Promise.resolve();
}

async function flushEntries() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (flushing) await flushing;
  if (!queue.length && !bodyQueue.length) return;
  const entries = queue, bodies = bodyQueue;
  queue = [];
  bodyQueue = [];
  flushing = CaptureStore.putEntries(entries, bodies)
    .catch((e) => {
      // disk is full or the origin was evicted: keep the session usable and
      // say so, rather than failing silently on the next request
      notify("could not write to disk: " + (e && e.message ? e.message : e));
    })
    .finally(() => { flushing = null; });
  await flushing;
}

async function restore() {
  if (state) return state;
  const got = await chrome.storage.session.get("state");
  if (got && got.state) state = got.state;
  // session storage is cleared by a browser restart; the database is not, so a
  // recording survives closing Chrome and can be resumed or authored
  if (!state) {
    const meta = await CaptureStore.getMeta().catch(() => null);
    if (meta && meta.live) {
      const { k, live, ...rest } = meta;
      // the browser was closed mid-session: the debugger is long detached, so
      // this is a finished recording waiting to be used, not a live one
      state = { ...rest, pending: {}, stopped: true, recovered: true };
    }
  }
  if (state && !state.tabIds) state.tabIds = [state.tabId];   // older sessions
  return state;
}

function headerArray(obj) {
  return Object.entries(obj || {}).map(([name, value]) => ({
    name,
    value: String(value),
  }));
}

function queryArray(url) {
  try {
    const u = new URL(url);
    return [...u.searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch (e) {
    return [];
  }
}

function iso(ms) {
  return new Date(ms).toISOString();
}

/* ------------------------------------------------------------------ capture */

/* Chrome keeps the debugger attached across a service-worker restart and wakes
   the worker with the next event, at which point `state` is gone. Restoring
   before the event is handled is what stops the first request after a restart
   from being dropped - and with the recording on disk, nothing before it is
   lost either. */
function onEvent(source, method, params) {
  if (!state) {
    restore().then((st) => {
      if (st && !st.stopped) onEvent(source, method, params);
    });
    return;
  }
  if (!(state.tabIds || [state.tabId]).includes(source.tabId)) return;
  sweepPending();

  if (method === "Network.requestWillBeSent") {
    const r = params.request || {};
    if (!/^https?:/i.test(r.url || "")) return;
    if (params.redirectResponse) {
      // same requestId as the hop being redirected - finish it or it is lost,
      // which would silently drop every step of an SSO / auth redirect chain
      const prev = state.pending[params.requestId];
      if (prev) {
        prev.response = harResponse(params.redirectResponse);
        delete state.pending[params.requestId];
        finishEntry(prev);
      }
    }
    state.pending[params.requestId] = {
      _tab: source.tabId,
      startedDateTime: iso(Date.now()),
      _tx: state.transaction,
      _type: params.type || "",
      request: {
        method: r.method || "GET",
        url: r.url,
        httpVersion: "HTTP/1.1",
        headers: headerArray(r.headers),
        queryString: queryArray(r.url),
        cookies: [],
        headersSize: -1,
        bodySize: r.postData ? r.postData.length : 0,
        ...(r.postData
          ? {
              postData: {
                mimeType:
                  (r.headers &&
                    (r.headers["Content-Type"] || r.headers["content-type"])) ||
                  "application/octet-stream",
                text: r.postData,
              },
            }
          : {}),
      },
    };
    return;
  }

  if (method === "Network.responseReceived") {
    const e = state.pending[params.requestId];
    if (!e) return;
    e.response = harResponse(params.response || {});
    return;
  }

  if (method === "Network.loadingFinished") {
    const e = state.pending[params.requestId];
    if (!e) return;
    delete state.pending[params.requestId];
    if (!e.response) e.response = emptyResponse();

    // An asset's bytes cannot change a .jmx, so they are never fetched: that
    // is most of an hour's traffic never crossing the process boundary.
    if (ASSET_TYPES.has((e._type || "").toLowerCase())) return finishEntry(e, null);

    // Chrome will not return a body past the per-resource buffer we asked for.
    // Keep the request, note why the body is absent.
    if ((params.encodedDataLength || 0) > MAX_BODY) {
      e._jmxgen = { ...(e._jmxgen || {}), bodyOmitted: "larger than 20 MB" };
      return finishEntry(e, null);
    }

    // response bodies are what makes automatic correlation possible
    chrome.debugger.sendCommand(
      { tabId: e._tab || state.tabId },
      "Network.getResponseBody",
      { requestId: params.requestId },
      (result) => {
        let body = null;
        if (chrome.runtime.lastError) {
          // the buffer was recycled, or the tab went away - the request still
          // belongs in the plan, so it is kept with the reason attached
          e._jmxgen = { ...(e._jmxgen || {}), bodyOmitted: chrome.runtime.lastError.message };
        } else if (result && !result.base64Encoded) {
          body = result.body || "";
          e.response.content.size = body.length;
        }
        finishEntry(e, body);
      }
    );
    return;
  }

  if (method === "Network.loadingFailed") {
    const e = state.pending[params.requestId];
    if (!e) return;
    delete state.pending[params.requestId];
    if (!e.response) e.response = emptyResponse();
    finishEntry(e, null);
  }
}

/* Server-sent events, long-poll and anything still streaming never emit
   loadingFinished. Left alone they sit in `pending` for the life of the
   recording and never reach the store, so a plan silently misses them. */
let lastSweep = 0;
function sweepPending() {
  const now = Date.now();
  if (now - lastSweep < 30000) return;
  lastSweep = now;
  for (const [id, e] of Object.entries(state.pending)) {
    const started = Date.parse(e.startedDateTime) || now;
    if (now - started < PENDING_TIMEOUT) continue;
    delete state.pending[id];
    if (!e.response) e.response = emptyResponse();
    e._jmxgen = { ...(e._jmxgen || {}), bodyOmitted: "still streaming when captured" };
    finishEntry(e, null);
  }
}

function harResponse(res) {
  return {
    status: res.status || 0,
    statusText: res.statusText || "",
    httpVersion: "HTTP/1.1",
    headers: headerArray(res.headers),
    cookies: [],
    redirectURL: (res.headers && (res.headers.location || res.headers.Location)) || "",
    headersSize: -1,
    bodySize: -1,
    content: { size: -1, mimeType: res.mimeType || "", text: "" },
  };
}

function emptyResponse() {
  return {
    status: 0,
    statusText: "",
    httpVersion: "HTTP/1.1",
    headers: [],
    cookies: [],
    redirectURL: "",
    headersSize: -1,
    bodySize: -1,
    content: { size: 0, mimeType: "", text: "" },
  };
}

/* What gets stored, and what does not.
 *
 * The engine reads exactly these fields out of a HAR: method, url, headers,
 * postData, status, redirectURL, content.text, content.mimeType,
 * startedDateTime, pageref, _resourceType and _jmxgen. Everything else a HAR
 * carries - queryString, cookies, headersSize, bodySize, cache, timings,
 * httpVersion - is reconstructed on export instead of being stored, because it
 * cannot change the plan and it is several hundred bytes on every request.
 *
 * Assets are reduced further, to a stub: their URL, method, status and type is
 * all a `web` plan ever needs of them. Which is what lets one recording author
 * either kind of plan without keeping a megabyte of stylesheet.
 */
function finishEntry(e, body) {
  const type = (e._type || "").toLowerCase();
  const asset = ASSET_TYPES.has(type);
  const seq = state.seq++;

  const record = asset
    ? {
        seq,
        tx: e._tx,
        startedDateTime: e.startedDateTime,
        type,
        hasBody: false,
        request: { method: e.request.method, url: e.request.url },
        response: { status: (e.response && e.response.status) || 0 },
        ...(e._jmxgen && Object.keys(e._jmxgen).length ? { _jmxgen: e._jmxgen } : {}),
      }
    : {
        seq,
        tx: e._tx,
        startedDateTime: e.startedDateTime,
        type,
        hasBody: body != null,
        request: {
          method: e.request.method,
          url: e.request.url,
          headers: e.request.headers,
          ...(e.request.postData ? { postData: e.request.postData } : {}),
        },
        response: {
          status: (e.response && e.response.status) || 0,
          redirectURL: (e.response && e.response.redirectURL) || "",
          mimeType: (e.response && e.response.content && e.response.content.mimeType) || "",
        },
        ...(e._jmxgen && Object.keys(e._jmxgen).length ? { _jmxgen: e._jmxgen } : {}),
      };

  state.count = (state.count || 0) + 1;
  state.lastSeq = seq;
  state.lastUrl = e.request.url;
  state.bytes = (state.bytes || 0) + (body ? body.length : 0);
  state.exported = false;      // there is now something unsaved
  queueEntry(record, asset ? null : body);
  persist();
  broadcast();
}

function broadcast() {
  chrome.runtime
    .sendMessage({ type: "status", status: statusPayload() })
    .catch(() => {});
  if (state) {
    chrome.tabs
      .sendMessage(state.tabId, { type: "status", status: statusPayload() })
      .catch(() => {});
  }
}

function statusPayload() {
  return state
    ? {
        recording: !state.stopped,
        count: state.count || 0,
        actions: (state.actions || []).length,
        unsaved: (state.count || 0) > 0 && !state.exported,
        transaction: state.transaction,
        transactions: state.transactions,
        lastUrl: state.lastUrl || "",
        // shown live in the popup, so a long recording is visible while it
        // grows rather than at the moment something breaks
        bytes: state.bytes || 0,
        startedAt: state.startedAt,
        recovered: !!state.recovered,
      }
    : { recording: false, count: 0, actions: 0, transaction: "", transactions: [],
        bytes: 0 };
}

/* ------------------------------------------------------- start / stop / export */

async function assertRecordable(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (e) {
    throw new Error("that tab is gone - open the site and try again");
  }
  if (!RECORDABLE.test(tab.url || "")) {
    throw new Error(
      "Chrome pages can't be recorded. Open the site you want to test in a " +
        "normal tab, switch to it, then press Start."
    );
  }
  return tab;
}



/* ---- recording options -------------------------------------------------
   BlazeMeter exposes these on its recorder and they change what the capture is
   worth: emulating a phone gets you the mobile variant of the site, and a warm
   cache means the second run records nothing at all for half the assets. All of
   them are CDP settings applied right after Network.enable, so they cost one
   round trip per tab and nothing at replay time. */

const DEVICES = {
  desktop: null,
  "iphone-14": {
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    width: 390, height: 844, scale: 3, mobile: true, platform: "iPhone",
  },
  "pixel-7": {
    ua: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    width: 412, height: 915, scale: 2.6, mobile: true, platform: "Linux armv8l",
  },
  "ipad-pro": {
    ua: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    width: 1024, height: 1366, scale: 2, mobile: true, platform: "iPad",
  },
  "galaxy-s22": {
    ua: "Mozilla/5.0 (Linux; Android 13; SM-S901B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    width: 360, height: 780, scale: 3, mobile: true, platform: "Linux armv8l",
  },
};

const DEFAULT_OPTIONS = {
  device: "desktop",
  userAgent: "",          // a custom string wins over the device preset
  disableCache: true,     // a warm cache silently drops assets from the capture
  bypassServiceWorker: true,
  blockedPatterns: "",    // newline or comma separated, e.g. *.googletagmanager.com
};

async function recordingOptions() {
  const got = await chrome.storage.local.get("jmxgen.recopts");
  return { ...DEFAULT_OPTIONS, ...(got["jmxgen.recopts"] || {}) };
}

async function setRecordingOptions(patch) {
  const next = { ...(await recordingOptions()), ...(patch || {}) };
  await chrome.storage.local.set({ "jmxgen.recopts": next });
  // a live recording picks the change up on every attached tab
  if (state && !state.stopped) {
    for (const tabId of state.tabIds || []) {
      await applyOptions(tabId, next).catch(() => {});
    }
  }
  return next;
}

const cdp = (tabId, method, params) =>
  chrome.debugger.sendCommand({ tabId }, method, params || {});

async function applyOptions(tabId, opts) {
  const dev = DEVICES[opts.device] || null;
  const ua = (opts.userAgent || "").trim() || (dev && dev.ua) || "";

  // each of these is best-effort: an older Chrome missing one command must not
  // take the whole recording down with it
  if (ua) {
    await cdp(tabId, "Network.setUserAgentOverride",
              { userAgent: ua, platform: (dev && dev.platform) || undefined })
      .catch(() => {});
  }
  if (dev) {
    await cdp(tabId, "Emulation.setDeviceMetricsOverride", {
      width: dev.width, height: dev.height,
      deviceScaleFactor: dev.scale, mobile: dev.mobile,
    }).catch(() => {});
    await cdp(tabId, "Emulation.setTouchEmulationEnabled",
              { enabled: true, maxTouchPoints: 5 }).catch(() => {});
  } else {
    await cdp(tabId, "Emulation.clearDeviceMetricsOverride").catch(() => {});
  }
  await cdp(tabId, "Network.setCacheDisabled",
            { cacheDisabled: !!opts.disableCache }).catch(() => {});
  await cdp(tabId, "Network.setBypassServiceWorker",
            { bypass: !!opts.bypassServiceWorker }).catch(() => {});

  const patterns = String(opts.blockedPatterns || "")
    .split(/[\n,]/).map((p) => p.trim()).filter(Boolean);
  await cdp(tabId, "Network.setBlockedURLs", { urls: patterns }).catch(() => {});
}

/* Every attach point needs the same buffers and the same options, so they all
   go through here rather than three copies drifting apart. */
async function enableCapture(tabId) {
  await cdp(tabId, "Network.enable", {
    maxTotalBufferSize: 100 * 1024 * 1024,
    maxResourceBufferSize: 20 * 1024 * 1024,
  });
  await applyOptions(tabId, await recordingOptions());
}

async function start(tabId) {
  if (state && !state.stopped) throw new Error("already recording this tab");
  if (state && state.stopped) state = null;   // a stopped session starts fresh
  await assertRecordable(tabId);
  await chrome.debugger.attach({ tabId }, PROTOCOL);
  await enableCapture(tabId);
  await beginCapture();
  state = freshState(tabId);
  await persist();
  broadcast();
  return statusPayload();
}

async function startAtUrl(rawUrl, transaction) {
  if (state && !state.stopped) throw new Error("already recording - stop first");
  if (state && state.stopped) state = null;

  let url = (rawUrl || "").trim();
  if (!url) throw new Error("enter a URL first");
  if (!/^[a-z]+:\/\//i.test(url)) url = "https://" + url;
  if (!RECORDABLE.test(url)) throw new Error("only http:// and https:// URLs can be recorded");

  // open a blank tab, attach, and only THEN navigate - otherwise the first
  // request of the page load (and any auth redirect) is already gone
  const tab = await chrome.tabs.create({ url: "about:blank", active: true });
  for (let i = 0; ; i++) {
    try {
      await chrome.debugger.attach({ tabId: tab.id }, PROTOCOL);
      break;
    } catch (e) {
      if (i >= 4) throw e;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  await enableCapture(tab.id);
  await beginCapture();
  state = freshState(tab.id, transaction);
  await persist();
  broadcast();

  await chrome.tabs.update(tab.id, { url });   // capture starts with request #1
  return { ...statusPayload(), url };
}


async function stop() {
  if (!state) return { recording: false, count: 0 };
  for (const tabId of state.tabIds || [state.tabId]) {
    try {
      await chrome.debugger.detach({ tabId });
    } catch (e) {
      /* tab may already be gone */
    }
  }
  state.stopped = true;
  await persistNow();          // the session is finished; make the checkpoint current
  const payload = { recording: false, count: state.count || 0 };
  broadcast();
  return payload;
}

/* The whole recording as one string. Used by Export HAR, where the file has to
   exist in full anyway, and never on the authoring path. */
async function buildHarText(opts) {
  await flushEntries();
  const parts = [];
  const stats = await CaptureRead.stream((chunk) => parts.push(chunk), opts);
  return { text: parts.join(""), stats };
}

/* Hand the recording to the extension's own authoring page.
 *
 * Nothing is copied. The recording is in IndexedDB, the authoring page shares
 * this origin, so the page opens the same database and streams it into the
 * engine itself. What travels is a URL.
 */
async function harHandoff(options) {
  if (!state || !(state.count || 0)) throw new Error("nothing recorded yet");
  await persistNow();          // everything queued is on disk before the page reads it
  // the capture has left the recorder intact, so it no longer counts as unsaved
  state.exported = true;
  broadcast();

  const q = new URLSearchParams({ mode: "har", from: "recording", go: "1" });
  if (options && options.open === "hyperexecute") q.set("then", "hx");
  await chrome.tabs.create({
    url: chrome.runtime.getURL("author.html") + "?" + q.toString(),
    active: true,
  });
  return { count: state.count };
}

// Run on HyperExecute without a recording - straight to the form, where the user
// can add a .jmx they already have.
async function openHyperExecute() {
  await chrome.tabs.create({url: chrome.runtime.getURL("run.html"), active: true});
  return {opened: true};
}

async function exportHar() {
  if (!state || !(state.count || 0)) throw new Error("nothing recorded yet");
  const { text } = await buildHarText();
  const { url, blob } = await blobUrlFor(text);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `jmxgen-session-${stamp}.har`;
  const id = await chrome.downloads.download({ url, filename, saveAs: true });
  if (blob) {
    // release the blob once Chrome has finished writing the file
    const done = (delta) => {
      if (delta.id === id && delta.state && delta.state.current !== "in_progress") {
        chrome.downloads.onChanged.removeListener(done);
        chrome.offscreen.closeDocument().catch(() => {});
      }
    };
    chrome.downloads.onChanged.addListener(done);
  }
  state.exported = true;
  await persist();
  broadcast();
  return { filename, count: state.count, bytes: text.length };
}

function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/* ------------------------------------------------------- manual authoring */

/* Every control in the on-page panel applies to the request that was just
   captured. That record may still be in the write queue, so look there first
   and fall back to one cursor step from the end of the store. */
async function lastEntry() {
  if (!state || !(state.count || 0)) throw new Error("nothing captured yet");
  if (queue.length) return queue[queue.length - 1];
  const rec = await CaptureStore.lastStored();
  if (!rec) throw new Error("nothing captured yet");
  return rec;
}

async function saveEntry(rec) {
  // if it is still queued it will be written with the batch; otherwise it is
  // already on disk and this is an update in place
  if (!queue.includes(rec)) await CaptureStore.putEntries([rec], []);
  persist();
  return rec;
}

async function annotate(patch) {
  const e = await lastEntry();
  e._jmxgen = { ...(e._jmxgen || {}), ...patch };
  await saveEntry(e);
  return e;
}

async function addAssertion(a) {
  const e = await lastEntry();
  e._jmxgen = e._jmxgen || {};
  e._jmxgen.assert = (e._jmxgen.assert || []).concat([a]);
  await saveEntry(e);
  return e._jmxgen.assert.length;
}

async function addExtractor(ex) {
  const e = await lastEntry();
  e._jmxgen = e._jmxgen || {};
  e._jmxgen.extract = (e._jmxgen.extract || []).concat([ex]);
  await saveEntry(e);
  return e._jmxgen.extract.length;
}

async function addManualRequest(step) {
  // a request the user types in - authored, never observed
  const url = step.url;
  const seq = state.seq++;
  const record = {
    seq,
    tx: state.transaction,
    startedDateTime: iso(Date.now()),
    type: "manual",
    hasBody: false,
    request: {
      method: (step.method || "GET").toUpperCase(),
      url,
      headers: headerArray(step.headers),
      ...(step.body
        ? {
            postData: {
              mimeType:
                (step.headers &&
                  (step.headers["Content-Type"] || step.headers["content-type"])) ||
                "application/json",
              text: step.body,
            },
          }
        : {}),
    },
    response: { status: 200, redirectURL: "", mimeType: "" },
    _jmxgen: { manual: true, name: step.name || undefined },
  };
  state.count = (state.count || 0) + 1;
  state.lastSeq = seq;
  state.lastUrl = url;
  await queueEntry(record, null);
  persist();
  broadcast();
  return state.count;
}

function setTransaction(name) {
  state.transaction = name || "Recorded";
  if (!state.transactions.includes(state.transaction)) {
    state.transactions.push(state.transaction);
  }
  persist();
  broadcast();
  return state.transaction;
}

/* ------------------------------------------------------------------ wiring */

chrome.debugger.onEvent.addListener(onEvent);

// keyboard path, so the toolbar icon is never a hard dependency
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-recording") return;
  await restore();
  try {
    if (state && !state.stopped) {
      const n = state.count || 0;
      await stop();
      notify(`stopped - ${n} requests captured, open the popup to export`);
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await start(tab.id);
      notify("recording this tab - reload the page if the panel is missing");
    }
  } catch (e) {
    notify("jmxgen: " + String((e && e.message) || e));
  }
});

function notify(text) {
  if (!state) return;
  chrome.tabs.sendMessage(state.tabId, { type: "toast", text }).catch(() => {});
}

async function attachExtra(tabId) {
  for (let i = 0; ; i++) {
    try {
      await chrome.debugger.attach({ tabId }, PROTOCOL);
      break;
    } catch (e) {
      if (i >= 4) return false;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  await enableCapture(tabId);
  state.tabIds.push(tabId);
  await persist();
  return true;
}

chrome.tabs.onCreated.addListener(async (tab) => {
  await restore();
  if (!state || state.stopped || !tab.id) return;
  // an SSO / OAuth / payment step usually opens in a popup or a new tab; without
  // this its whole exchange is invisible to the recording
  const opener = tab.openerTabId;
  if (opener === undefined || !state.tabIds.includes(opener)) return;
  if (state.tabIds.includes(tab.id)) return;
  if (await attachExtra(tab.id)) {
    notify("also recording the window that just opened");
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await restore();
  if (!state || state.stopped) return;
  if (state.tabIds.includes(tabId) && tabId !== state.tabId) {
    state.tabIds = state.tabIds.filter((t) => t !== tabId);   // popup closed, carry on
    await persist();
    return;
  }
  if (state.tabId === tabId) {
    state.stopped = true;      // keep the entries so they can still be exported
    await persist();
    broadcast();
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (state && source.tabId === state.tabId) broadcast();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "make-blob-url") return;   // handled by offscreen.html
  (async () => {
    await restore();
    try {
      switch (msg.type) {
        case "start": {
          const tabId =
            msg.tabId ||
            (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
          return sendResponse({ ok: true, data: await start(tabId) });
        }
        case "startUrl":
          return sendResponse({
            ok: true,
            data: await startAtUrl(msg.url, msg.transaction),
          });
        case "stop":
          return sendResponse({ ok: true, data: await stop() });
        case "status":
          return sendResponse({ ok: true, data: statusPayload() });
        case "export":
          return sendResponse({ ok: true, data: await exportHar() });
        case "openHyperExecute":
          return sendResponse({ ok: true, data: await openHyperExecute() });
        case "harHandoff":
          return sendResponse({ ok: true, data: await harHandoff(msg.options) });
        case "guiAction": {
          if (!state || state.stopped) return sendResponse({ ok: false, error: "not recording" });
          const a = msg.action || {};
          // a click straight after typing in the same field is the blur, not a
          // separate step the user meant to record
          const prev = state.actions[state.actions.length - 1];
          if (prev && prev.do === a.do && prev.label === a.label &&
              a.at - prev.at < 400) {
            state.actions[state.actions.length - 1] = { ...a, transaction: prev.transaction };
          } else {
            state.actions.push({ ...a, transaction: state.transaction });
          }
          state.exported = false;
          await persist();
          return sendResponse({ ok: true, data: { actions: state.actions.length } });
        }
        case "toggleOverlay": {
          // the popup's minimise acts on the on-page panel, which is the thing
          // the user is actually looking at
          const tabs = state && state.tabIds && state.tabIds.length
            ? state.tabIds
            : [(await chrome.tabs.query({ active: true, currentWindow: true }))[0].id];
          for (const id of tabs) {
            chrome.tabs.sendMessage(id, { type: "panel", visible: !!msg.visible })
              .catch(() => {});
          }
          return sendResponse({ ok: true });
        }
        case "getRecordingOptions":
          return sendResponse({ ok: true, data: await recordingOptions() });
        case "setRecordingOptions":
          return sendResponse({ ok: true, data: await setRecordingOptions(msg.options) });
        case "devices":
          return sendResponse({ ok: true, data: Object.keys(DEVICES) });
        case "setEndpoint":
          await chrome.storage.local.set({endpoint: msg.endpoint || DEFAULT_ENDPOINT});
          return sendResponse({ ok: true, data: msg.endpoint || DEFAULT_ENDPOINT });
        case "reset": {
          if (state && (state.count || 0) && !state.exported && !msg.force) {
            return sendResponse({
              ok: false,
              unsaved: state.count,
              error: `${state.count} captured requests have not been saved`,
            });
          }
          if (state && !state.stopped) await stop();
          state = null;
          queue = [];
          bodyQueue = [];
          await CaptureStore.clearCapture().catch(() => {});
          await persist();
          broadcast();
          return sendResponse({ ok: true, data: statusPayload() });
        }
        case "closeSession": {
          // stop + discard, optionally exporting first
          if (msg.save) await exportHar();
          if (state && !state.stopped) await stop();
          const n = state ? state.count || 0 : 0;
          state = null;
          await persist();
          broadcast();
          return sendResponse({ ok: true, data: { closed: true, count: n } });
        }
        case "transaction":
          return sendResponse({ ok: true, data: setTransaction(msg.name) });
        case "assert":
          return sendResponse({ ok: true, data: await addAssertion(msg.assertion) });
        case "extract":
          return sendResponse({ ok: true, data: await addExtractor(msg.extractor) });
        case "pause":
          await annotate({ pause_after_ms: msg.ms });
          return sendResponse({ ok: true, data: msg.ms });
        case "name":
          await annotate({ name: msg.name });
          return sendResponse({ ok: true, data: msg.name });
        case "skip":
          await annotate({ skip: true });
          return sendResponse({ ok: true, data: true });
        case "manual":
          return sendResponse({ ok: true, data: await addManualRequest(msg.step) });
        case "lastUrl":
          return sendResponse({ ok: true, data: (state && state.lastUrl) || "" });
        default:
          return sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      return sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true; // async
});
