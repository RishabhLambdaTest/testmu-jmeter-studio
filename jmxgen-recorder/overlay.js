/* Floating panel injected into the page so steps can be authored without
 * leaving the flow - the popup closes the moment you click the page. */

(() => {
  if (window.__jmxgenOverlay) return;
  window.__jmxgenOverlay = true;

  let root = null;
  let visible = false;

  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => resolve(r || { ok: false }));
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });

  function el(tag, props = {}, kids = []) {
    const n = document.createElement(tag);
    Object.assign(n, props);
    for (const k of kids) n.appendChild(k);
    return n;
  }

  function build() {
    root = el("div", { id: "jmxgen-overlay" });
    root.innerHTML = `
      <div class="jg-head">
        <span class="jg-dot"></span>
        <span class="jg-title">jmxgen recorder</span>
        <span class="jg-count" id="jg-count">0</span>
        <button class="jg-x" id="jg-hide" title="minimise (keeps recording)">&#8211;</button>
        <button class="jg-x jg-close" id="jg-close" title="stop and close">&#10005;</button>
      </div>
      <div class="jg-confirm" id="jg-confirm" hidden>
        <div class="jg-ctext" id="jg-ctext"></div>
        <button class="jg-b jg-go jg-wide" id="jg-c-save">Save HAR, then close</button>
        <button class="jg-b jg-wide jg-warn" id="jg-c-discard">Close without saving</button>
        <button class="jg-b jg-wide" id="jg-c-cancel">Keep recording</button>
      </div>
      <div class="jg-body">
        <label class="jg-l">Transaction</label>
        <div class="jg-row">
          <input class="jg-in" id="jg-tx" placeholder="Login" />
          <button class="jg-b" id="jg-tx-set">Set</button>
        </div>
        <div class="jg-last" id="jg-last">nothing captured yet</div>
        <div class="jg-grid">
          <button class="jg-b" id="jg-assert-200">Assert 200</button>
          <button class="jg-b" id="jg-assert-text">Assert text…</button>
          <button class="jg-b" id="jg-extract">Extract…</button>
          <button class="jg-b" id="jg-pause">Pause 2s</button>
          <button class="jg-b" id="jg-name">Rename…</button>
          <button class="jg-b jg-warn" id="jg-skip">Skip last</button>
        </div>
        <label class="jg-chk"><input type="checkbox" id="jg-gui" checked />
          record browser steps <span class="jg-count" id="jg-gui-count">0</span></label>
        <button class="jg-b jg-wide" id="jg-manual">+ Manual request…</button>
        <button class="jg-b jg-wide jg-go" id="jg-export">Finish → export HAR</button>
        <div class="jg-hint">then: <code>jmxgen from-har &lt;file&gt; -o plan.jmx</code></div>
      </div>`;
    document.documentElement.appendChild(root);
    wire();
    makeDraggable(root.querySelector(".jg-head"), root);
  }

  function toast(text, bad) {
    const last = root.querySelector("#jg-last");
    last.textContent = text;
    last.className = "jg-last" + (bad ? " jg-bad" : " jg-good");
    setTimeout(() => (last.className = "jg-last"), 2500);
  }

  function wire() {
    const q = (id) => root.querySelector(id);

    q("#jg-hide").onclick = () => setVisible(false);

    q("#jg-close").onclick = async () => {
      const st = await send({ type: "status" });
      const n = (st.ok && st.data && st.data.count) || 0;
      const unsaved = !!(st.ok && st.data && st.data.unsaved);
      if (n && unsaved) {
        q("#jg-ctext").textContent =
          `${n} captured request${n === 1 ? "" : "s"} have not been saved. ` +
          `Save the HAR before closing?`;
        showConfirm(true);
        return;
      }
      await send({ type: "closeSession", save: false });
      teardown();
    };

    q("#jg-c-save").onclick = async () => {
      const r = await send({ type: "closeSession", save: true });
      if (!r.ok) return toast(r.error, true);
      teardown();
    };
    q("#jg-c-discard").onclick = async () => {
      await send({ type: "closeSession", save: false });
      teardown();
    };
    q("#jg-c-cancel").onclick = () => showConfirm(false);

    q("#jg-gui").onchange = (e) => {
      guiOn = e.target.checked;
      toast(guiOn ? "recording browser steps" : "browser steps paused - HTTP still recording");
    };

    q("#jg-tx-set").onclick = async () => {
      const name = q("#jg-tx").value.trim();
      if (!name) return;
      const r = await send({ type: "transaction", name });
      toast(r.ok ? `transaction → ${name}` : r.error, !r.ok);
    };

    q("#jg-assert-200").onclick = async () => {
      const r = await send({
        type: "assert",
        assertion: { field: "code", match: "equals", pattern: "200" },
      });
      toast(r.ok ? "asserted code = 200 on last request" : r.error, !r.ok);
    };

    q("#jg-assert-text").onclick = async () => {
      const text = prompt("Response body must contain:");
      if (!text) return;
      const r = await send({
        type: "assert",
        assertion: { field: "body", match: "contains", pattern: text },
      });
      toast(r.ok ? `asserted body contains "${text}"` : r.error, !r.ok);
    };

    q("#jg-extract").onclick = async () => {
      const varName = prompt("Variable name (e.g. TOKEN):");
      if (!varName) return;
      const path = prompt("JSON path (e.g. $.data.token):", "$.");
      if (!path) return;
      const r = await send({
        type: "extract",
        extractor: { type: "json", var: varName, query: path },
      });
      toast(r.ok ? `extracting \${${varName}}` : r.error, !r.ok);
    };

    q("#jg-pause").onclick = async () => {
      const ms = parseInt(prompt("Pause after this request (ms):", "2000"), 10);
      if (!ms) return;
      const r = await send({ type: "pause", ms });
      toast(r.ok ? `pause ${ms}ms` : r.error, !r.ok);
    };

    q("#jg-name").onclick = async () => {
      const name = prompt("Label for the last request:");
      if (!name) return;
      const r = await send({ type: "name", name });
      toast(r.ok ? `renamed → ${name}` : r.error, !r.ok);
    };

    q("#jg-skip").onclick = async () => {
      const r = await send({ type: "skip" });
      toast(r.ok ? "last request will be dropped" : r.error, !r.ok);
    };

    q("#jg-manual").onclick = async () => {
      const method = (prompt("Method:", "POST") || "").toUpperCase();
      if (!method) return;
      const url = prompt("URL:", location.origin + "/");
      if (!url) return;
      const body = prompt("Body (blank for none):", "");
      const r = await send({
        type: "manual",
        step: { method, url, body: body || "", headers: body ? { "Content-Type": "application/json" } : {} },
      });
      toast(r.ok ? "manual step added" : r.error, !r.ok);
    };

    q("#jg-export").onclick = async () => {
      const r = await send({ type: "export" });
      toast(r.ok ? `exported ${r.data.count} requests` : r.error, !r.ok);
    };
  }

  /* ---- GUI capture ------------------------------------------------------
     Recorded alongside the HTTP traffic, from the same session: the protocol
     plan is what scales to thousands of users, and the browser steps are what
     prove the journey still works. One recording, two artifacts.

     Everything here is deliberately conservative - a recorder that captures
     every mousemove produces a script nobody can read, so only the actions
     that change application state are kept. */

  let guiOn = true;
  const LOC = () => window.__jmxgenLocator;

  const fromOverlay = (event) => {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    return path.some((n) => n && n.id === "jmxgen-overlay");
  };

  async function pushAction(action) {
    if (!guiOn) return;
    const r = await send({ type: "guiAction", action });
    if (r && r.ok) bumpGui(r.data && r.data.actions);
  }

  function bumpGui(n) {
    const el = root && root.querySelector("#jg-gui-count");
    if (el && typeof n === "number") el.textContent = n;
  }

  function record(node, type, extra) {
    const loc = LOC();
    if (!loc || !node || node.nodeType !== 1) return;
    const found = loc.locate(node);
    if (!found.locators.length) return;
    const action = {
      do: type,
      label: loc.describe(node),
      locators: found.locators,
      url: location.href,
      at: Date.now(),
      ...(extra || {}),
    };
    // a locator list that survived verification but is xpath-only will break
    // the moment the page structure shifts - say so now, not at replay
    if (found.weak) {
      action.weak = true;
      toast("recorded " + type + " - only a positional locator was stable", true);
    }
    pushAction(action);
  }

  function onClick(event) {
    if (!guiOn || fromOverlay(event)) return;
    const node = LOC().realTarget(event);
    // a click that lands on a label/icon inside a button belongs to the button
    const target = (node.closest && node.closest("button, a, [role=button], input, select, textarea")) || node;
    record(target, "click");
  }

  /* Typing is one action with a final value, not one per keystroke. `change`
     fires on blur for text inputs, which is exactly the moment the value is
     settled. */
  function onChange(event) {
    if (!guiOn || fromOverlay(event)) return;
    const node = LOC().realTarget(event);
    const tag = (node.tagName || "").toLowerCase();
    if (tag === "select") {
      const opt = node.options && node.options[node.selectedIndex];
      return record(node, "select", { text: opt ? opt.text : node.value });
    }
    if (node.type === "checkbox" || node.type === "radio") {
      return record(node, node.checked ? "check" : "uncheck");
    }
    if (tag === "input" || tag === "textarea") {
      if (node.type === "password") {
        // never bake a password into a script; point at a variable instead
        return record(node, "type", { text: "${PASSWORD}", secret: true });
      }
      return record(node, "type", { text: node.value });
    }
  }

  /* SPA routing does not reload the page, so pushState has to be watched or
     half a modern app's navigation is invisible. */
  let lastUrl = location.href;
  function noteNavigation(how) {
    if (!guiOn) return;
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    pushAction({ do: "navigate", url: location.href, how: how, at: Date.now() });
  }

  function installGuiCapture() {
    // capture phase, so a handler that stops propagation cannot hide the action
    document.addEventListener("click", onClick, true);
    document.addEventListener("change", onChange, true);
    window.addEventListener("popstate", () => noteNavigation("back"));
    for (const m of ["pushState", "replaceState"]) {
      const orig = history[m];
      history[m] = function () {
        const out = orig.apply(this, arguments);
        setTimeout(() => noteNavigation(m), 0);
        return out;
      };
    }
  }

  function makeDraggable(handle, box) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.addEventListener("mousedown", (e) => {
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const r = box.getBoundingClientRect();
      ox = r.left; oy = r.top;
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      box.style.left = ox + e.clientX - sx + "px";
      box.style.top = oy + e.clientY - sy + "px";
      box.style.right = "auto";
    });
    window.addEventListener("mouseup", () => (dragging = false));
  }

  function showConfirm(on) {
    const c = root.querySelector("#jg-confirm");
    const b = root.querySelector(".jg-body");
    if (c) c.hidden = !on;
    if (b) b.style.display = on ? "none" : "block";
  }

  function teardown() {
    if (root) {
      root.remove();
      root = null;
    }
    visible = false;
  }

  function setVisible(on) {
    visible = on;
    if (on && !root) build();
    if (root) root.style.display = on ? "block" : "none";
  }

  function render(status) {
    if (!status || !status.recording) {
      if (root && !root.querySelector("#jg-confirm").hidden) return;  // mid-prompt
      setVisible(false);
      return;
    }
    setVisible(true);
    const c = root.querySelector("#jg-count");
    if (c) c.textContent = String(status.count);
    const tx = root.querySelector("#jg-tx");
    if (tx && document.activeElement !== tx) tx.value = status.transaction || "";
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "status") render(msg.status);
    if (msg.type === "toast") {
      if (!root) build();
      toast(msg.text);
    }
  });

  installGuiCapture();
  send({ type: "status" }).then((r) => {
    if (!r.ok) return;
    render(r.data);
    bumpGui(r.data && r.data.actions);
  });
})();
