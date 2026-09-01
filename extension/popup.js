const $ = (id) => document.getElementById(id);

const send = (msg) =>
  new Promise((resolve) =>
    chrome.runtime.sendMessage(msg, (r) => resolve(r || { ok: false, error: "no response" }))
  );

function say(text, bad) {
  const m = $("msg");
  m.textContent = text || "";
  m.className = "msg" + (text ? (bad ? " bad" : " good") : "");
}

function render(s) {
  const on = !!(s && s.recording);
  const unsaved = !!(s && s.unsaved);
  $("dot").className = "dot" + (on ? " on" : "");
  $("count").textContent = s ? s.count : 0;
  $("sub").textContent = on
    ? `recording · ${s.transaction || "Recorded"}`
    : s && s.count
    ? unsaved
      ? "stopped · not saved yet"
      : "stopped · saved"
    : "idle";
  $("export").textContent = unsaved ? "Export HAR *" : "Export HAR";
  $("start").hidden = on;
  $("urlblock").hidden = on;
  $("stop").hidden = !on;
  $("reset").hidden = !(s && s.count);
  $("export").disabled = !(s && s.count);
  refreshButtons();
  if (s && document.activeElement !== $("tx")) $("tx").value = s.transaction || "";
}

$("open").onclick = async () => {
  const url = $("url").value.trim();
  if (!url) return say("enter a URL first", true);
  const r = await send({
    type: "startUrl",
    url,
    transaction: $("tx").value.trim() || undefined,
  });
  say(r.ok ? "recording from the first request" : r.error, !r.ok);
  if (r.ok) render(r.data);
};

$("url").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("open").click();
});

$("start").onclick = async () => {
  const r = await send({ type: "start" });
  say(r.ok ? "recording - browse the app" : r.error, !r.ok);
  render(r.ok ? r.data : null);
};

$("stop").onclick = async () => {
  const r = await send({ type: "stop" });
  say(r.ok ? `stopped at ${r.data.count} requests - now export` : r.error, !r.ok);
  const s = await send({ type: "status" });
  render(s.ok ? s.data : null);
};

$("txset").onclick = async () => {
  const name = $("tx").value.trim();
  if (!name) return;
  const r = await send({ type: "transaction", name });
  say(r.ok ? `transaction → ${name}` : r.error, !r.ok);
};

/* The console is optional and always has been optional here: the plan is built
   by the engine inside the extension. A running console only adds Validate,
   which needs a real JMeter binary, so its absence is a note and not a fault. */
async function checkService() {
  const r = await send({ type: "ping" });
  const el = $("svc");
  const up = !!(r.ok && r.data && r.data.up);
  $("endpoint").value = (r.data && r.data.endpoint) || "http://localhost:8770";
  el.textContent = up
    ? "local console found — single-user Validate is available too"
    : "everything runs in this extension — no install needed";
  el.className = "svc " + (up ? "up" : "note");
  refreshButtons();
}

function refreshButtons() {
  const hasCapture = Number($("count").textContent) > 0;
  $("send").disabled = !hasCapture;
  $("export").disabled = !hasCapture;
}

$("send").onclick = async () => {
  $("send").disabled = true;
  say("generating the plan…");
  const r = await send({ type: "harHandoff", options: {} });
  if (r.ok) {
    say(`${r.data.count} requests handed to the authoring page`, false);
    window.close();
  } else {
    say(r.error, true);
  }
  refreshButtons();
};

/* The recorder only captures a browser journey. Every other source opens the
   extension's own authoring page with that source preselected - it drives the
   console's API but keeps the whole flow inside the extension. */
document.querySelectorAll(".chip").forEach((chip) => {
  chip.onclick = async () => {
    await chrome.tabs.create({
      url: chrome.runtime.getURL("author.html") + "?mode=" + chip.dataset.mode,
      active: true,
    });
    window.close();
  };
});

/* ---- recording options -------------------------------------------------
   Applied live: changing one mid-recording pushes it to every attached tab, so
   you are not forced to throw away a session to fix an emulation setting. */
const REC_TEXT = ["userAgent", "blockedPatterns"];
const REC_BOOL = ["disableCache", "bypassServiceWorker"];

const DEVICE_LABELS = {
  desktop: "Desktop (no emulation)",
  "iphone-14": "iPhone 14",
  "pixel-7": "Pixel 7",
  "ipad-pro": "iPad Pro",
  "galaxy-s22": "Galaxy S22",
};

async function loadRecordingOptions() {
  const d = await send({ type: "devices" });
  const names = (d.ok && d.data) || ["desktop"];
  $("device").innerHTML = names
    .map((n) => `<option value="${n}">${DEVICE_LABELS[n] || n}</option>`).join("");

  const r = await send({ type: "getRecordingOptions" });
  if (!r.ok) return;
  const o = r.data || {};
  $("device").value = o.device || "desktop";
  REC_TEXT.forEach((k) => $(k).value = o[k] || "");
  REC_BOOL.forEach((k) => $(k).checked = !!o[k]);
}

async function saveRecordingOptions() {
  const options = { device: $("device").value };
  REC_TEXT.forEach((k) => options[k] = $(k).value);
  REC_BOOL.forEach((k) => options[k] = $(k).checked);
  const r = await send({ type: "setRecordingOptions", options });
  if (r.ok) say($("device").value === "desktop" ? "options saved"
                                                : "emulating " + DEVICE_LABELS[$("device").value]);
}
["device", ...REC_TEXT, ...REC_BOOL].forEach((k) => {
  const el = $(k);
  el.addEventListener(el.type === "checkbox" || el.tagName === "SELECT"
                      ? "change" : "input", saveRecordingOptions);
});

/* Window controls. A Chrome popup has no real chrome of its own, so these act
   on the things the user actually thinks of as the window: the on-page panel,
   the full authoring page, and the popup itself. */
$("winMin").onclick = async () => {
  await send({ type: "toggleOverlay", visible: false });
  window.close();
};
$("winMax").onclick = async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL("author.html"), active: true });
  window.close();
};
$("winClose").onclick = () => window.close();

$("saveEndpoint").onclick = async () => {
  const r = await send({ type: "setEndpoint", endpoint: $("endpoint").value.trim() });
  say(r.ok ? "saved" : r.error, !r.ok);
  checkService();
};

$("export").onclick = async () => {
  const r = await send({ type: "export" });
  say(r.ok ? `saved ${r.data.count} requests (${Math.round(r.data.bytes / 1024)} KB)`
           : r.error, !r.ok);
};

$("reset").onclick = async () => {
  let r = await send({ type: "reset" });
  if (!r.ok && r.unsaved) {
    const go = confirm(
      `${r.unsaved} captured requests have not been saved.\n\n` +
        `OK = discard them anyway\nCancel = keep the session so you can Export`
    );
    if (!go) return say("kept - click Export HAR to save it", false);
    r = await send({ type: "reset", force: true });
  }
  say(r.ok ? "session discarded" : r.error, !r.ok);
  render(r.ok ? r.data : null);
};

chrome.runtime.onMessage.addListener((m) => {
  if (m && m.type === "status") render(m.status);
});

async function checkTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const ok = /^https?:\/\//i.test((tab && tab.url) || "");
  if (!ok) {
    $("start").disabled = true;
    $("start").textContent = "This tab can't be recorded";
    say("This is a Chrome page. Put the URL in the box above and press Go - " +
        "that opens it in a new tab and records from the very first request.", true);
  } else {
    $("start").disabled = false;
    $("start").textContent = "Start recording this tab";
  }
  return ok;
}

send({ type: "status" }).then((r) => {
  render(r.ok ? r.data : null);
  if (!r.ok || !r.data || !r.data.recording) checkTab();
  checkService();
  loadRecordingOptions();
});

/* Run on HyperExecute opens a real tab, never the popup: the popup closes as soon
   as focus leaves it, and a form holding an access key cannot live somewhere that
   disappears when you switch tabs to copy the key. */
$("hx").onclick = async () => {
  const s = await send({ type: "status" });
  const st = (s && s.data) || {};
  if (st.count) {
    say("building the plan…");
    const r = await send({ type: "harHandoff", options: { open: "hyperexecute" } });
    if (!r.ok) return say(r.error, true);
  } else {
    await send({ type: "openHyperExecute" });
  }
  window.close();
};
