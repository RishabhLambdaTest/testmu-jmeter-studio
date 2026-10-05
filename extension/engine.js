/* The page's handle on the engine.
 *
 * The engine itself is engine-worker.js, on a worker thread. This file is the
 * part that stays with the page: it starts that worker, forwards its log lines
 * into the extension's log, and exposes the same `JmxgenEngine` the pages have
 * always called, so nothing above it had to change.
 *
 * Why the split exists: Pyodide used to run here, on the page's own thread.
 * Authoring 20,000 requests blocked it for 7.2 seconds out of 9.5 and rendered
 * three frames in that time. Nothing animated, no control answered, and the
 * browser was within its rights to offer to kill the tab. A worker gives that
 * time back to the page, and is what makes a progress line or a cancel button
 * possible at all - on one thread there was nothing left to draw them with.
 */

let worker = null;
let nextId = 1;
const pending = new Map();      // id -> {resolve, reject}
let ready = false;

/* ---- log plumbing -----------------------------------------------------
   Python's stdout and stderr, the engine's own progress lines and any
   exception all arrive as messages and go down the same channel the pages
   already listen on. */
function emit(level, text) {
  chrome.runtime.sendMessage({ type: "engine-log", level, text, at: Date.now() })
    .catch(() => {});   // nobody listening is fine - the log is a convenience
}

function startWorker() {
  if (worker) return worker;
  worker = new Worker(chrome.runtime.getURL("engine-worker.js"));
  worker.onmessage = (ev) => {
    const m = ev.data || {};
    if (m.kind === "log") return emit(m.level, m.text);
    if (m.kind !== "reply") return;
    const waiting = pending.get(m.id);
    if (!waiting) return;
    pending.delete(m.id);
    if (m.ok) waiting.resolve(m.data);
    else waiting.reject(new Error(m.error || "the engine failed"));
  };
  worker.onerror = (e) => {
    const detail = e.message || "the engine worker stopped";
    emit("error", detail);
    // nothing will answer the calls in flight, so fail them rather than hang
    for (const [, w] of pending) w.reject(new Error(detail));
    pending.clear();
    worker = null;
    ready = false;
  };
  // the worker has no chrome.runtime, so the paths it needs come from here
  call("init", [], {
    vendor: chrome.runtime.getURL("vendor/pyodide/"),
    jmxgen: chrome.runtime.getURL("jmxgen.py"),
  });
  return worker;
}

function call(kind, args, extra) {
  startWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage(Object.assign({ kind, id, args: args || [] }, extra || {}));
  });
}

async function boot() {
  await call("boot");
  ready = true;
  return true;
}

/* Writing an input file straight onto the engine's filesystem.
 *
 * The caller pushes chunks and only one entry is in memory at a time; what
 * lands is a file Python opens by name. Writes are posted without waiting -
 * postMessage keeps their order - and only the close is answered, because only
 * the close has something to say. */
async function openInput(name) {
  const { path } = await call("open", [], { name });
  return {
    path,
    write(chunk) { worker.postMessage({ kind: "write", chunk }); },
    close() {
      // the caller expects the path straight away; the bytes follow when the
      // worker has finished writing them
      call("close").catch((e) => emit("error", "closing the input failed: " + e.message));
      return { path };
    },
  };
}

window.JmxgenEngine = {
  boot,
  openInput,
  author: (payload) => call("author", [payload]),
  rebuild: (specJson, changes, edits) => call("rebuild", [specJson, changes, edits]),
  rebuildYaml: (yamlText) => call("rebuildYaml", [yamlText]),
  lint: (xml) => call("lint", [xml]),
  suggestExtractor: (body, headers, value, label) =>
    call("suggestExtractor", [body, headers, value, label]),
  traceValue: (value, label) => call("traceValue", [value, label]),
  k6Yaml: (specJson, settings) => call("k6Yaml", [specJson, settings]),
  isReady: () => ready,
};

/* Anything else in the extension that wants a plan built asks through here,
   because the worker belongs to this page. */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "engine") return;
  (async () => {
    try {
      if (msg.type === "engine-boot") return sendResponse({ ok: true, data: (await boot(), true) });
      if (msg.type === "engine-author")
        return sendResponse({ ok: true, data: await window.JmxgenEngine.author(msg.payload) });
      if (msg.type === "engine-rebuild")
        return sendResponse({ ok: true,
                              data: await window.JmxgenEngine.rebuild(msg.spec, msg.changes, msg.edits) });
      sendResponse({ ok: false, error: "unknown engine call: " + msg.type });
    } catch (e) {
      const detail = String(e && e.message ? e.message : e);
      emit("error", detail);
      sendResponse({ ok: false, error: detail });
    }
  })();
  return true;
});

emit("info", "engine host loaded");
