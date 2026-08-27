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

  send({ type: "status" }).then((r) => r.ok && render(r.data));
})();
