/* TestMu AI — JMeter Studio - service worker.
 *
 * Attaches the DevTools protocol to the recorded tab, collects every
 * request/response (bodies included), merges in the steps the user authors by
 * hand, and exports a HAR that jmxgen reads directly. Manual annotations ride
 * along in `_jmxgen` fields, which the HAR spec allows and other tools ignore.
 */

const PROTOCOL = "1.3";
const RECORDABLE = /^https?:\/\//i;

let state = null;      // null when idle

function freshState(tabId, transaction) {
  const tx = transaction || "Recorded";
  return {
    tabId,
    tabIds: [tabId],          // + any popup/new tab opened from it
    startedAt: Date.now(),
    transaction: tx,
    transactions: [tx],
    pending: {},         // requestId -> partial entry
    entries: [],         // finished entries, in order
    actions: [],         // recorded browser steps, in order
    counter: 0,
    exported: false,     // false as soon as anything new is captured
  };
}

/* The checkpoint exists because service workers get evicted mid-recording. It
 * is a fallback, never the source of truth: `state` in memory is. That matters
 * here, because session storage holds ten megabytes and a recording passes it
 * easily - the response bodies correlation needs are the same bodies that fill
 * the quota. So the checkpoint degrades in steps rather than failing, and a
 * failure to write one never interrupts capture.
 */
let persistTimer = null;
let leanCheckpoint = false;    // bodies no longer fit, and the user has been told

function withoutBodies(entry) {
  const r = entry.response;
  if (!r || !r.content || !r.content.text) return entry;
  return { ...entry, response: { ...r, content: { ...r.content, text: "" } } };
}

async function writeCheckpoint() {
  if (!state) {
    await chrome.storage.session.remove("state").catch(() => {});
    return;
  }
  const full = { ...state, pending: {} };
  try {
    await chrome.storage.session.set({ state: full });
    leanCheckpoint = false;
    return;
  } catch (e) {
    // over quota - fall through
  }

  // Second try without response bodies. A restored session still replays the
  // journey; it just cannot correlate values it no longer holds.
  try {
    await chrome.storage.session.set({
      state: { ...full, bodiesDropped: true, entries: full.entries.map(withoutBodies) },
    });
    if (!leanCheckpoint) {
      notify("recording is large - the crash checkpoint has dropped response bodies");
      leanCheckpoint = true;
    }
    return;
  } catch (e) {
    // still over quota
  }

  // Nothing fits. Recording continues in memory, which is where it was always
  // being kept anyway - say so once, so a browser restart is not a surprise.
  await chrome.storage.session.remove("state").catch(() => {});
  if (!leanCheckpoint) {
    notify("recording too large to checkpoint - finish and build before closing Chrome");
    leanCheckpoint = true;
  }
}

/* Debounced. Rewriting the whole session on every captured request is O(n^2)
   work over a long recording, and the checkpoint only has to be recent. */
function persist() {
  if (persistTimer) return Promise.resolve();
  persistTimer = setTimeout(() => {
    persistTimer = null;
    writeCheckpoint();
  }, 1200);
  return Promise.resolve();
}

/* For the moments that must be durable: stopping, exporting, handing over. */
async function persistNow() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  await writeCheckpoint();
}

async function restore() {
  if (state) return state;
  const got = await chrome.storage.session.get("state");
  if (got && got.state) state = got.state;
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

function onEvent(source, method, params) {
  if (!state || !(state.tabIds || [state.tabId]).includes(source.tabId)) return;

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
    // response bodies are what makes automatic correlation possible
    chrome.debugger.sendCommand(
      { tabId: e._tab || state.tabId },
      "Network.getResponseBody",
      { requestId: params.requestId },
      (result) => {
        if (!chrome.runtime.lastError && result && !result.base64Encoded) {
          e.response.content.text = result.body || "";
          e.response.content.size = (result.body || "").length;
        }
        finishEntry(e);
      }
    );
    return;
  }

  if (method === "Network.loadingFailed") {
    const e = state.pending[params.requestId];
    if (!e) return;
    delete state.pending[params.requestId];
    if (!e.response) e.response = emptyResponse();
    finishEntry(e);
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

function finishEntry(e) {
  e.time = 0;
  e.cache = {};
  e.timings = { send: 0, wait: 0, receive: 0 };
  e.pageref = e._tx;
  delete e._tab;
  e._jmxgen = e._jmxgen || {};
  state.entries.push(e);
  state.counter = state.entries.length;
  state.exported = false;      // there is now something unsaved
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
        count: state.entries.length,
        actions: (state.actions || []).length,
        unsaved: state.entries.length > 0 && !state.exported,
        transaction: state.transaction,
        transactions: state.transactions,
        lastUrl: state.entries.length
          ? state.entries[state.entries.length - 1].request.url
          : "",
      }
    : { recording: false, count: 0, actions: 0, transaction: "", transactions: [] };
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
  const payload = { recording: false, count: state.entries.length };
  broadcast();
  return payload;
}

function buildHar() {
  const pages = state.transactions.map((t, i) => ({
    id: t,
    title: t,
    startedDateTime: iso(state.startedAt + i),
    pageTimings: { onContentLoad: -1, onLoad: -1 },
  }));
  const entries = state.entries
    .filter((e) => !(e._jmxgen && e._jmxgen.skip))
    .map((e) => {
      const copy = { ...e };
      delete copy._tx;
      // Chrome knows what each request IS (document / xhr / fetch / script /
      // image / font). Keeping it lets one recording produce either an API-level
      // or a full browser-level plan. _resourceType is what DevTools' own HAR
      // export uses, so other tools understand it too.
      copy._resourceType = (e._type || "").toLowerCase();
      copy._jmxgen = { ...(copy._jmxgen || {}), type: copy._resourceType };
      delete copy._type;
      return copy;
    });
  return {
    log: {
      version: "1.2",
      creator: { name: "testmu-jmeter-studio", version: "1.2.0" },
      browser: { name: "Chrome", version: "" },
      pages,
      entries,
      // the browser steps ride in the HAR's own extension field, so one file
      // still carries the whole session and `from-har` can emit both plans
      _jmxgen: { authoredWith: "testmu-jmeter-studio", recordedAt: iso(state.startedAt),
                 actions: state.actions || [] },
    },
  };
}

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument();
  if (has) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Turn the recorded session into a downloadable HAR file.",
  });
}

async function blobUrlFor(text) {
  // service workers have no DOM, so createObjectURL lives in the offscreen page;
  // a data: URL would cap out well below the size of a real recording
  try {
    await ensureOffscreen();
    const r = await chrome.runtime.sendMessage({ type: "make-blob-url", text });
    if (r && r.ok && r.url) return { url: r.url, blob: true };
  } catch (e) {
    /* fall through */
  }
  return { url: "data:application/octet-stream;base64," + b64(text), blob: false };
}

const DEFAULT_ENDPOINT = "http://localhost:8770";

async function getEndpoint() {
  try {
    const got = await chrome.storage.local.get("endpoint");
    return (got && got.endpoint) || DEFAULT_ENDPOINT;
  } catch (e) {
    return DEFAULT_ENDPOINT;
  }
}

async function pingEndpoint() {
  const base = await getEndpoint();
  try {
    const r = await fetch(base + "/api/ping", {cache: "no-store"});
    return {up: r.ok, endpoint: base};
  } catch (e) {
    return {up: false, endpoint: base};
  }
}

/* Hand the recording to the extension's own authoring page.
 *
 * This used to POST the HAR to a console on localhost. It no longer does:
 * the engine runs inside the extension, so the capture only has to travel
 * from here to author.html. Session storage is the vehicle - it holds the
 * HAR for exactly as long as the browser session, is never written to disk,
 * and is readable only by this extension's own pages.
 */
const handoffs = new Map();   // key -> the HAR, held in the worker, not in storage

async function harHandoff(options) {
  if (!state || !state.entries.length) throw new Error("nothing recorded yet");
  const text = JSON.stringify(buildHar());
  const key = "har-" + Date.now().toString(36);
  // The HAR is the same bytes that overflow session storage, so it stays in
  // the worker and only a marker is stored. If the worker is evicted before
  // the authoring page collects it, the page asks for it again and it is
  // rebuilt from the checkpoint.
  handoffs.set(key, { name: "recording.har", content: b64(text), count: state.entries.length });
  await chrome.storage.session.set({ [key]: { pending: true, count: state.entries.length } })
    .catch(() => {});
  // the capture has left the recorder intact, so it no longer counts as unsaved
  state.exported = true;
  await persistNow();
  broadcast();

  const q = new URLSearchParams({ mode: "har", har: key, go: "1" });
  if (options && options.open === "hyperexecute") q.set("then", "hx");
  await chrome.tabs.create({
    url: chrome.runtime.getURL("author.html") + "?" + q.toString(),
    active: true,
  });
  return { count: state.entries.length };
}

// Run on HyperExecute without a recording - straight to the form, where the user
// can add a .jmx they already have.
async function openHyperExecute() {
  await chrome.tabs.create({url: chrome.runtime.getURL("run.html"), active: true});
  return {opened: true};
}

async function exportHar() {
  if (!state || !state.entries.length) throw new Error("nothing recorded yet");
  const har = buildHar();
  const text = JSON.stringify(har, null, 1);
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
  return { filename, count: har.log.entries.length, bytes: text.length };
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

function lastEntry() {
  if (!state || !state.entries.length) throw new Error("nothing captured yet");
  return state.entries[state.entries.length - 1];
}

function annotate(patch) {
  const e = lastEntry();
  e._jmxgen = { ...(e._jmxgen || {}), ...patch };
  persist();
  return e;
}

function addAssertion(a) {
  const e = lastEntry();
  e._jmxgen = e._jmxgen || {};
  e._jmxgen.assert = (e._jmxgen.assert || []).concat([a]);
  persist();
  return e._jmxgen.assert.length;
}

function addExtractor(ex) {
  const e = lastEntry();
  e._jmxgen = e._jmxgen || {};
  e._jmxgen.extract = (e._jmxgen.extract || []).concat([ex]);
  persist();
  return e._jmxgen.extract.length;
}

function addManualRequest(step) {
  // a request the user types in - authored, never observed
  const url = step.url;
  const entry = {
    startedDateTime: iso(Date.now()),
    time: 0,
    cache: {},
    timings: { send: 0, wait: 0, receive: 0 },
    pageref: state.transaction,
    request: {
      method: (step.method || "GET").toUpperCase(),
      url,
      httpVersion: "HTTP/1.1",
      headers: headerArray(step.headers),
      queryString: queryArray(url),
      cookies: [],
      headersSize: -1,
      bodySize: step.body ? step.body.length : 0,
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
    response: { ...emptyResponse(), status: 200 },
    _jmxgen: { manual: true, name: step.name || undefined },
  };
  state.entries.push(entry);
  state.counter = state.entries.length;
  persist();
  broadcast();
  return state.entries.length;
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
      const n = state.entries.length;
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
        case "takeHandoff": {
          const held = handoffs.get(msg.key);
          if (held) {
            handoffs.delete(msg.key);      // one-shot, so a reload cannot re-author it
            await chrome.storage.session.remove(msg.key).catch(() => {});
            return sendResponse({ ok: true, data: held });
          }
          // the worker restarted: rebuild from whatever the checkpoint holds
          await restore();
          if (!state || !state.entries.length) {
            return sendResponse({ ok: false, error: "the recording is no longer available" });
          }
          await chrome.storage.session.remove(msg.key).catch(() => {});
          return sendResponse({ ok: true, data: {
            name: "recording.har",
            content: b64(JSON.stringify(buildHar())),
            count: state.entries.length,
            rebuilt: true,
          }});
        }
        case "ping":
          return sendResponse({ ok: true, data: await pingEndpoint() });
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
          if (state && state.entries.length && !state.exported && !msg.force) {
            return sendResponse({
              ok: false,
              unsaved: state.entries.length,
              error: `${state.entries.length} captured requests have not been saved`,
            });
          }
          if (state && !state.stopped) await stop();
          state = null;
          await persist();
          broadcast();
          return sendResponse({ ok: true, data: statusPayload() });
        }
        case "closeSession": {
          // stop + discard, optionally exporting first
          if (msg.save) await exportHar();
          if (state && !state.stopped) await stop();
          const n = state ? state.entries.length : 0;
          state = null;
          await persist();
          broadcast();
          return sendResponse({ ok: true, data: { closed: true, count: n } });
        }
        case "transaction":
          return sendResponse({ ok: true, data: setTransaction(msg.name) });
        case "assert":
          return sendResponse({ ok: true, data: addAssertion(msg.assertion) });
        case "extract":
          return sendResponse({ ok: true, data: addExtractor(msg.extractor) });
        case "pause":
          annotate({ pause_after_ms: msg.ms });
          return sendResponse({ ok: true, data: msg.ms });
        case "name":
          annotate({ name: msg.name });
          return sendResponse({ ok: true, data: msg.name });
        case "skip":
          annotate({ skip: true });
          return sendResponse({ ok: true, data: true });
        case "manual":
          return sendResponse({ ok: true, data: addManualRequest(msg.step) });
        case "lastUrl":
          return sendResponse({
            ok: true,
            data: state && state.entries.length ? lastEntry().request.url : "",
          });
        default:
          return sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      return sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true; // async
});
