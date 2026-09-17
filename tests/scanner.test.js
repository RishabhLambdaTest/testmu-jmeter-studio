/* Tests for the streaming HAR scanner in extension/lt.js.
 *
 *   node tests/scanner.test.js
 *
 * The function is lifted out of lt.js rather than copied, so these test what
 * the extension actually ships. lt.js is a plain script, not a module: the
 * pages load it with a <script> tag, which is why it is read and evaluated
 * here instead of required.
 */
const fs = require("fs"), path = require("path");
const ltjs = fs.readFileSync(path.join(__dirname, "..", "extension", "lt.js"), "utf8");
const from = ltjs.indexOf("function ltHarEntryScanner");
if (from < 0) throw new Error("ltHarEntryScanner is no longer in lt.js");
const end = ltjs.indexOf("\nasync function ltMemberText", from);
const harEntryScanner = new Function(ltjs.slice(from, end) + "; return ltHarEntryScanner;")();

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log("  ok   " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + " - " + e.message); fail++; }
}
function eq(a, b, what) {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`${what}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}
function scan(text, opts, chunk) {
  const got = [];
  const s = harEntryScanner((e) => got.push(e), opts);
  const n = chunk || text.length;
  for (let i = 0; i < text.length; i += n) s.feed(text.slice(i, i + n));
  return { got, stats: s.stats };
}
const har = (entries) => JSON.stringify({ log: { version: "1.2", pages: [], entries } });

t("reads every entry", () => {
  const e = [{ a: 1 }, { a: 2 }, { a: 3 }];
  eq(scan(har(e)).got, e, "entries");
});
t("survives any chunk size", () => {
  const e = [{ a: 1, b: "x" }, { a: 2, b: "yy" }];
  for (const n of [1, 3, 7, 50]) eq(scan(har(e), {}, n).got, e, "chunk " + n);
});
t("a brace inside a string is not nesting", () => {
  const e = [{ body: '{"not":"real"} } ] }' }, { after: true }];
  eq(scan(har(e), {}, 5).got, e, "braces in strings");
});
t("escapes and quotes survive", () => {
  const e = [{ s: 'he said "hi" \\ backslash\nnewline\ttab' }];
  eq(scan(har(e), {}, 3).got, e, "escapes");
});
t("nested objects and arrays", () => {
  const e = [{ request: { headers: [{ name: "A", value: "1" }] }, response: { content: {} } }];
  eq(scan(har(e), {}, 4).got, e, "nesting");
});
t("trims a long body, keeps the rest of the entry", () => {
  const big = "x".repeat(5000);
  const e = [{ request: { url: "/a" }, response: { content: { mimeType: "text/html", text: big } } }];
  const r = scan(har(e), { maxBodyChars: 100 }, 64);
  const out = r.got[0];
  eq(out.request.url, "/a", "url kept");
  eq(out.response.content.mimeType, "text/html", "mime kept");
  if (out.response.content.text.length > 200) throw new Error("body not trimmed: " + out.response.content.text.length);
  eq(r.stats.trimmedBodies, 1, "counted");
});
t("trims a body containing quotes and escapes", () => {
  const big = '"' .repeat(10) + "a\\b".repeat(2000);
  const e = [{ response: { content: { text: big } } }, { second: true }];
  const r = scan(har(e), { maxBodyChars: 50 }, 17);
  eq(r.got.length, 2, "both entries");
  eq(r.got[1], { second: true }, "entry after a trimmed body");
});
t("a key called text nested elsewhere still trims", () => {
  const e = [{ request: { postData: { text: "y".repeat(3000) } } }];
  const r = scan(har(e), { maxBodyChars: 100 });
  if (r.got[0].request.postData.text.length > 200) throw new Error("postData not trimmed");
});
t("entries not last in the document", () => {
  const text = '{"log":{"entries":[{"a":1}],"pages":[{"id":"p"}],"version":"1.2"}}';
  eq(scan(text).got, [{ a: 1 }], "entries first");
});
t("empty entries array", () => { eq(scan(har([])).got, [], "empty"); });
t("a BOM and leading whitespace", () => {
  eq(scan("﻿  " + har([{ a: 1 }]), {}, 2).got, [{ a: 1 }], "bom");
});
t("truncated input does not throw", () => {
  const text = har([{ a: 1 }, { b: 2 }]).slice(0, 60);
  scan(text, {}, 7);
});
t("unicode outside the BMP", () => {
  const e = [{ s: "emoji \u{1F600} and é" }];
  eq(scan(har(e), {}, 3).got, e, "unicode");
});
t("a trim landing on a backslash still parses", () => {
  // every cut point across an escape-heavy body: the bug that lost 5 of 55
  // entries of the real capture
  const body = 'a\\"b\\\\c\\u00e9d'.repeat(500);
  for (let cap = 40; cap < 80; cap++) {
    const e = [{ response: { content: { text: body } } }, { next: 1 }];
    const r = scan(har(e), { maxBodyChars: cap }, 13);
    eq(r.got.length, 2, "both entries parsed at cap " + cap);
  }
});
t("a trim landing inside a unicode escape still parses", () => {
  const body = "\\u00e9".repeat(400);
  for (let cap = 20; cap < 60; cap++) {
    const r = scan(har([{ response: { content: { text: body } } }]), { maxBodyChars: cap }, 7);
    eq(r.got.length, 1, "parsed at cap " + cap);
  }
});
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
