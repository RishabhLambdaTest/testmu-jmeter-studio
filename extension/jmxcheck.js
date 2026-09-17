/* Validate .jmx - is this file a JMeter plan that will parse?
 *
 * Nothing is converted or rebuilt. Two independent checks run and both have to
 * pass:
 *
 *   - jmxcheck-worker.js: encoding, characters XML 1.0 does not allow (raw or
 *     as &#..; references), invisible pasted characters, and well-formedness
 *     from the open-source fast-xml-parser validator, all with line and column
 *   - the browser's own XML parser (jmxGate, in xmlgate.js), which is strict,
 *     and the JMeter shape: <jmeterTestPlan>, a TestPlan, a thread group and a
 *     sampler
 *
 * The file is read once as bytes for the worker and once as text for the
 * parser; neither copy is kept after the report is drawn. */

function jmxCheckWorker(bytes) {
  return new Promise((resolve, reject) => {
    const w = new Worker("jmxcheck-worker.js");
    w.onmessage = (ev) => { w.terminate(); resolve(ev.data); };
    w.onerror = (ev) => { w.terminate(); reject(new Error(ev.message || "the checker failed to start")); };
    w.postMessage({ bytes }, [bytes]);
  });
}

function jmxShape(text) {
  const count = (re) => (text.match(re) || []).length;
  return {
    threadGroups: count(/<[\w.]*ThreadGroup\b[^>]*testclass=/g),
    samplers: count(/<[\w.]*Sampler(?:Proxy)?\b[^>]*testclass=/g),
    disabled: count(/\benabled="false"/g),
  };
}

async function jmxCheck(file) {
  const t0 = Date.now();
  const bytes = await file.arrayBuffer();
  const worker = await jmxCheckWorker(bytes.slice(0));
  if (!worker.ok) throw new Error(worker.error);
  const found = worker.found;

  const text = await file.text();
  const gate = jmxGate(text, file.name);
  const parser = gate.ok ? null : gate.problems;
  const shape = jmxShape(text);

  return {
    name: file.name, bytes: bytes.byteLength, lines: worker.lines,
    encoding: worker.encoding, ms: Date.now() - t0,
    errors: found.errors, warnings: found.warnings,
    parser,                        // null when the browser's parser accepted it
    shape,
    ok: !found.errors.length && !parser,
  };
}

function jmxCheckRender(el, r) {
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const where = (w) => (w || []).map((p) => `line ${p.line}, col ${p.col}`);
  const item = (x, cls) => {
    const ws = where(x.where);
    const more = x.count && x.count > ws.length ? ` and ${x.count - ws.length} more` : "";
    return `<li class="${cls}"><span class="kind">${esc(x.kind)}</span> ${esc(x.message)}` +
      (ws.length ? `<div class="where">${esc(ws.join(" · "))}${esc(more)}</div>` : "") + `</li>`;
  };
  const mb = (r.bytes / 1048576).toFixed(r.bytes < 1048576 ? 2 : 1);
  const verdict = r.ok
    ? (r.warnings.length ? "Valid XML, with warnings" : "Valid XML")
    : "Not valid";
  const parserLine = r.parser
    ? r.parser.map((p) => item({ kind: "browser parser", message: p }, "bad")).join("")
    : "";

  el.innerHTML = `
    <div class="verdict ${r.ok ? (r.warnings.length ? "warn" : "ok") : "bad"}">
      <strong>${esc(verdict)}</strong>
      <span>${esc(r.name)} · ${mb} MB · ${r.lines.toLocaleString()} lines · ${esc(r.encoding.toUpperCase())}</span>
    </div>
    <table class="checks">
      <tr><td>Well-formed (fast-xml-parser)</td>
          <td>${r.errors.some((e) => e.kind === "structure") ? '<span class="pill bad">no</span>' : '<span class="pill ok">yes</span>'}</td></tr>
      <tr><td>Well-formed and a JMeter plan (browser XML parser)</td>
          <td>${r.parser ? '<span class="pill bad">no</span>' : '<span class="pill ok">yes</span>'}</td></tr>
      <tr><td>Encoding</td>
          <td>${r.errors.some((e) => e.kind === "encoding") ? '<span class="pill bad">invalid</span>' : '<span class="pill ok">valid</span>'}</td></tr>
      <tr><td>Characters XML does not allow</td>
          <td>${r.errors.some((e) => e.kind === "character") ? '<span class="pill bad">found</span>' : '<span class="pill ok">none</span>'}</td></tr>
      <tr><td>Invisible pasted characters</td>
          <td>${r.warnings.length ? '<span class="pill warn">found</span>' : '<span class="pill ok">none</span>'}</td></tr>
      <tr><td>Thread groups · samplers · disabled elements</td>
          <td class="mono">${r.shape.threadGroups} · ${r.shape.samplers} · ${r.shape.disabled}</td></tr>
    </table>
    ${(r.errors.length || r.parser || r.warnings.length) ? `<ul class="findings">
      ${r.errors.map((e) => item(e, "bad")).join("")}${parserLine}
      ${r.warnings.map((w) => item(w, "warn")).join("")}
    </ul>` : ""}
    <p class="hint">Checked in this browser in ${(r.ms / 1000).toFixed(1)} s. Nothing was uploaded or changed.</p>`;
  el.hidden = false;
}

window.JmxCheck = { check: jmxCheck, render: jmxCheckRender };
