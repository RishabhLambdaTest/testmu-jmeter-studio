/* Validate .jmx - the checks that do not need a DOM, off the page's thread.
 *
 * A plan can be tens of megabytes, and scanning every character of one on the
 * page would freeze it. This worker gets the file's bytes and answers three
 * questions, each with line and column so the problem can be found:
 *
 *   - does it decode? (the encoding the XML declaration names, UTF-8 if none)
 *   - does it carry characters XML 1.0 cannot? Escaping does not rescue them:
 *     &#31; is as invalid as the raw byte, so both are looked for
 *   - is it well-formed? fast-xml-parser's validator gives a line and column
 *
 * The browser's own XML parser, which is stricter, runs on the page; the two
 * together are the verdict. */

importScripts("vendor/fast-xml-parser/fxvalidator.min.js");

const MAX_LISTED = 5;       // places shown per finding; the count is always exact

/* legal XML 1.0: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF] */
const ILLEGAL = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;
const CHAR_REF = /&#(x[0-9a-fA-F]+|[0-9]+);/g;
/* legal, but nearly always pasted in by accident, and a header name or a value
   carrying one fails in a way nobody can see */
const SUSPECT = /[\u00A0\u200B-\u200D\u2028\u2029\u2060\uFEFF]/g;
const SUSPECT_NAMES = {
  0xA0: "no-break space", 0x200B: "zero-width space", 0x200C: "zero-width non-joiner",
  0x200D: "zero-width joiner", 0x2028: "line separator", 0x2029: "paragraph separator",
  0x2060: "word joiner", 0xFEFF: "byte order mark",
};

const hex = (cp) => "U+" + cp.toString(16).toUpperCase().padStart(4, "0");

function legal(cp) {
  return cp === 0x9 || cp === 0xA || cp === 0xD ||
         (cp >= 0x20 && cp <= 0xD7FF) || (cp >= 0xE000 && cp <= 0xFFFD) ||
         (cp >= 0x10000 && cp <= 0x10FFFF);
}

/* offset -> {line, col}, with the line starts found once */
function locator(text) {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return (offset) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - starts[lo] + 1 };
  };
}

function declaredEncoding(bytes) {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 200));
  const m = /^\s*<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(head);
  return m ? m[1].trim() : null;
}

function decode(bytes, found) {
  const declared = declaredEncoding(bytes);
  let label = (declared || "utf-8").toLowerCase();
  let decoder;
  try {
    decoder = new TextDecoder(label, { fatal: true });
  } catch (e) {
    found.errors.push({ kind: "encoding",
      message: `the XML declaration names encoding "${declared}", which is not a known encoding` });
    label = "utf-8";
    decoder = new TextDecoder(label, { fatal: true });
  }
  try {
    return { text: decoder.decode(bytes), label };
  } catch (e) {
    // fatal decoding does not say where; a lenient pass marks each bad sequence
    const text = new TextDecoder(label).decode(bytes);
    const at = locator(text);
    const where = [];
    let count = 0;
    for (let i = text.indexOf("\uFFFD"); i !== -1; i = text.indexOf("\uFFFD", i + 1)) {
      count++;
      if (where.length < MAX_LISTED) where.push(at(i));
    }
    found.errors.push({ kind: "encoding", count,
      message: `${count} byte sequence(s) are not valid ${label.toUpperCase()}` +
               (declared ? "" : " (no encoding is declared, so UTF-8 applies)"),
      where });
    return { text, label };
  }
}

/* One finding per kind, however many distinct characters: the total, the
   breakdown most-frequent first, and the earliest places in the file. */
function pushGrouped(list, byKey, label, what) {
  if (!byKey.size) return;
  const rows = [...byKey].sort((a, b) => b[1].count - a[1].count);
  const total = rows.reduce((n, [, r]) => n + r.count, 0);
  const where = rows.flatMap(([, r]) => r.where)
    .sort((a, b) => a.line - b.line || a.col - b.col).slice(0, MAX_LISTED);
  const shown = rows.slice(0, 8).map(([k, r]) => `${label(k)} ×${r.count}`).join(", ");
  const rest = rows.length > 8 ? `, and ${rows.length - 8} more kinds` : "";
  list.push({ kind: "character", count: total, where,
    message: `${total.toLocaleString()} ${what}: ${shown}${rest}` });
}

function scan(text, found) {
  const at = locator(text);

  const raw = new Map();       // code point -> {count, where}
  for (const m of text.matchAll(ILLEGAL)) {
    const cp = m[0].codePointAt(0);
    if (cp === 0xFFFD && found.errors.some((e) => e.kind === "encoding")) continue;
    const r = raw.get(cp) || { count: 0, where: [] };
    r.count++;
    if (r.where.length < MAX_LISTED) r.where.push(at(m.index));
    raw.set(cp, r);
  }
  pushGrouped(found.errors, raw, (cp) => hex(cp),
    "character(s) XML 1.0 does not allow");

  const refs = new Map();
  for (const m of text.matchAll(CHAR_REF)) {
    const v = m[1];
    const cp = v[0] === "x" ? parseInt(v.slice(1), 16) : parseInt(v, 10);
    if (legal(cp)) continue;
    const r = refs.get(m[0]) || { count: 0, where: [] };
    r.count++;
    if (r.where.length < MAX_LISTED) r.where.push(at(m.index));
    refs.set(m[0], r);
  }
  pushGrouped(found.errors, refs, (ref) => ref,
    "reference(s) to characters XML 1.0 does not allow - escaping does not make them legal");

  const sus = new Map();
  for (const m of text.matchAll(SUSPECT)) {
    const cp = m[0].codePointAt(0);
    if (cp === 0xFEFF && m.index === 0) continue;       // a leading BOM is fine
    const r = sus.get(cp) || { count: 0, where: [] };
    r.count++;
    if (r.where.length < MAX_LISTED) r.where.push(at(m.index));
    sus.set(cp, r);
  }
  pushGrouped(found.warnings, sus, (cp) => `${hex(cp)} ${SUSPECT_NAMES[cp]}`,
    "invisible character(s) - legal XML, but usually pasted in by accident");

  const v = XMLValidator.validate(text);
  if (v !== true) {
    found.errors.push({ kind: "structure",
      message: `${v.err.msg} (fast-xml-parser: ${v.err.code})`,
      where: [{ line: v.err.line, col: v.err.col }] });
  }
}

self.onmessage = (ev) => {
  const t0 = Date.now();
  const found = { errors: [], warnings: [] };
  try {
    const bytes = new Uint8Array(ev.data.bytes);
    const { text, label } = decode(bytes, found);
    scan(text, found);
    const lines = (text.match(/\n/g) || []).length + 1;
    self.postMessage({ ok: true, found, encoding: label, lines, ms: Date.now() - t0 });
  } catch (e) {
    self.postMessage({ ok: false, error: String((e && e.message) || e) });
  }
};
