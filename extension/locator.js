/* Ranked, verified element locators.
 *
 * Every recorder that generates a single selector eventually generates a wrong
 * one: an id that turns out to be regenerated per render, a CSS path that was
 * unique on the page you recorded and ambiguous on the page you replay. The
 * defence is two-part, and both parts happen here:
 *
 *   1. emit SEVERAL locators per element, ranked most-stable first, so the
 *      runner can fall back when the top one stops matching;
 *   2. verify each candidate against the live DOM at capture time and drop the
 *      ones that already do not resolve to exactly this element.
 *
 * (2) is the part most recorders skip. The DOM is right there while recording,
 * so a locator that is already ambiguous should never reach the script - the
 * alternative is finding out during a replay, which is where this class of bug
 * normally surfaces.
 *
 * Exposed as window.__jmxgenLocator so the content script and the test page can
 * both use it.
 */

(() => {
  if (window.__jmxgenLocator) return;

  /* ---- dynamic value detection ----------------------------------------
     An id is only worth trusting if a human wrote it. Framework-generated
     ones look stable for exactly one page load. */
  const DYNAMIC = [
    /^[0-9]+$/,                         // "12345"
    /[0-9a-f]{8}-[0-9a-f]{4}/i,         // uuid
    /^[0-9a-f]{16,}$/i,                 // long hash
    /^:r[0-9a-z]+:$/i,                  // React useId
    /^(ember|mui|mat|ng|rc|radix)[-_]?[0-9]+/i,
    /^[a-z]+-[0-9]{4,}$/i,              // "input-84213"
    /[0-9]{6,}/,                        // any long digit run
  ];

  const looksDynamic = (value) => {
    if (!value) return true;
    const v = String(value).trim();
    if (!v) return true;
    return DYNAMIC.some((re) => re.test(v));
  };

  /* ---- css escaping ---------------------------------------------------- */
  const cssEscape = (value) =>
    window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&");

  const attr = (node, name) => {
    const v = node.getAttribute && node.getAttribute(name);
    return v && v.trim() ? v.trim() : null;
  };

  /* Visible text, trimmed and collapsed - long text makes a bad locator and a
     worse label, so it is capped. */
  const textOf = (node) => {
    const t = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
    return t && t.length <= 80 ? t : null;
  };

  /* ---- the root a node lives in (document, or its shadow root) ---------- */
  const rootOf = (node) => {
    const r = node.getRootNode ? node.getRootNode() : document;
    return r || document;
  };

  /* ---- candidate generation -------------------------------------------
     Ordered best-first. Each entry is {type, value, label?}. */
  function candidates(node) {
    const out = [];
    const tag = node.tagName ? node.tagName.toLowerCase() : "";

    // 1. explicit test hooks - put there for exactly this purpose
    for (const name of ["data-testid", "data-test-id", "data-test", "data-cy", "data-qa"]) {
      const v = attr(node, name);
      if (v) out.push({ type: "testid", value: v, attr: name });
    }

    // 2. id, but only when it does not look generated
    const id = attr(node, "id");
    if (id && !looksDynamic(id)) out.push({ type: "id", value: id });

    // 3. name - stable on form controls
    const name = attr(node, "name");
    if (name && !looksDynamic(name)) out.push({ type: "name", value: name });

    // 4. accessible name: aria-label, or a label pointing at this control
    const aria = attr(node, "aria-label");
    if (aria) out.push({ type: "css", value: `${tag}[aria-label="${aria}"]`, why: "aria-label" });

    // 5. link text - the natural handle for anchors and buttons
    if (tag === "a" || tag === "button" || attr(node, "role") === "button") {
      const t = textOf(node);
      if (t) out.push({ type: "text", value: t, tag: tag });
    }

    // 6. placeholder is often the only handle on a bare input
    const ph = attr(node, "placeholder");
    if (ph) out.push({ type: "css", value: `${tag}[placeholder="${ph}"]`, why: "placeholder" });

    // 7. a scoped CSS path, from the nearest ancestor that has a stable handle
    const path = cssPath(node);
    if (path) out.push({ type: "css", value: path, why: "path" });

    // 8. last resort
    out.push({ type: "xpath", value: xpath(node), why: "absolute" });
    return out;
  }

  /* A CSS path that stops as soon as it is unique, anchored on the nearest
     ancestor carrying a stable id or test hook so it survives layout changes
     above that point. */
  function cssPath(node) {
    const parts = [];
    let cur = node;
    const root = rootOf(node);

    while (cur && cur.nodeType === 1 && parts.length < 6) {
      const tag = cur.tagName.toLowerCase();
      if (tag === "html" || tag === "body") break;

      const hook = ["data-testid", "data-test", "data-cy"]
        .map((a) => attr(cur, a)).find(Boolean);
      const id = attr(cur, "id");

      if (hook) {
        const a = ["data-testid", "data-test", "data-cy"].find((x) => attr(cur, x));
        parts.unshift(`[${a}="${hook}"]`);
        break;
      }
      if (id && !looksDynamic(id)) {
        parts.unshift(`#${cssEscape(id)}`);
        break;
      }

      // a class is only useful if it is not obviously generated
      const cls = (cur.className && typeof cur.className === "string"
        ? cur.className.split(/\s+/) : [])
        .filter((c) => c && !looksDynamic(c) && c.length < 40 && !/^(ng|css|sc)-/.test(c));

      let part = tag;
      if (cls.length) part += "." + cls.slice(0, 2).map(cssEscape).join(".");

      const parent = cur.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter(
          (c) => c.tagName === cur.tagName);
        if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      }
      parts.unshift(part);

      // stop early if what we have is already unique
      try {
        if (root.querySelectorAll(parts.join(" > ")).length === 1) break;
      } catch (e) { /* keep walking */ }
      cur = cur.parentElement;
    }
    return parts.length ? parts.join(" > ") : null;
  }

  function xpath(node) {
    const parts = [];
    let cur = node;
    while (cur && cur.nodeType === 1) {
      const tag = cur.tagName.toLowerCase();
      if (tag === "html") { parts.unshift("html"); break; }
      const parent = cur.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      const sibs = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
      parts.unshift(sibs.length > 1 ? `${tag}[${sibs.indexOf(cur) + 1}]` : tag);
      cur = parent;
    }
    return "/" + parts.join("/");
  }

  /* ---- verification ----------------------------------------------------
     Re-query each candidate now, while the element is still on screen, and
     keep it only if it resolves to exactly one node and that node is the one
     the user actually acted on. */
  function resolves(cand, node) {
    const root = rootOf(node);
    try {
      if (cand.type === "testid") {
        const found = root.querySelectorAll(`[${cand.attr}="${cand.value}"]`);
        return found.length === 1 && found[0] === node;
      }
      if (cand.type === "id") {
        const found = root.querySelectorAll(`#${cssEscape(cand.value)}`);
        return found.length === 1 && found[0] === node;
      }
      if (cand.type === "name") {
        const found = root.querySelectorAll(`[name="${cand.value}"]`);
        return found.length === 1 && found[0] === node;
      }
      if (cand.type === "css") {
        const found = root.querySelectorAll(cand.value);
        return found.length === 1 && found[0] === node;
      }
      if (cand.type === "text") {
        const all = Array.from(root.querySelectorAll(cand.tag || "*"))
          .filter((n) => textOf(n) === cand.value);
        return all.length === 1 && all[0] === node;
      }
      if (cand.type === "xpath") {
        const r = document.evaluate(cand.value, document, null,
          XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return r.singleNodeValue === node;
      }
    } catch (e) {
      return false;
    }
    return false;
  }

  /* The public call: a ranked, verified locator list for one element. */
  function locate(node) {
    if (!node || node.nodeType !== 1) return [];
    const verified = [];
    const rejected = [];
    for (const cand of candidates(node)) {
      (resolves(cand, node) ? verified : rejected).push(cand);
    }
    // an absolute xpath always "resolves", so it is a guaranteed floor - but a
    // locator list that is ONLY the xpath is a warning worth surfacing
    return { locators: verified, rejected: rejected, weak: verified.every((c) => c.type === "xpath") };
  }

  /* A short human label for the panel and for the step name. */
  function describe(node) {
    const tag = node.tagName ? node.tagName.toLowerCase() : "element";
    const t = textOf(node);
    if (t) return `${tag} "${t.slice(0, 40)}"`;
    for (const a of ["aria-label", "placeholder", "name", "id"]) {
      const v = attr(node, a);
      if (v) return `${tag} [${a}=${v}]`;
    }
    return tag;
  }

  /* Cross shadow boundaries: composedPath gives the real target even when the
     event surfaces retargeted at the host element. */
  function realTarget(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const n of path) {
      if (n && n.nodeType === 1) return n;
    }
    return event.target;
  }

  window.__jmxgenLocator = { locate, describe, realTarget, looksDynamic, candidates, cssPath, xpath };
})();
