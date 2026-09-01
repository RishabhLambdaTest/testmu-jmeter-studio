# TestMu AI — JMeter Studio (Chrome extension)

The whole product. Record a journey in your **own** Chrome — your profile, your
logins, your VPN — or bring a cURL command, an OpenAPI spec, a Postman
collection, a spreadsheet, a URL list or an existing `.jmx`, and get a
ready-to-run JMeter plan. Then trigger it on HyperExecute from the same window.

No console, no CLI, no Python, no server. `jmxgen.py` runs here in WebAssembly
(Pyodide), and HyperExecute is called directly — an MV3 extension with host
permissions is not subject to CORS, so there is no reason to route anything
through localhost, and the access key never leaves the machine.

**User-facing docs live in [`../docs/`](../docs/):**
[SETUP](../docs/SETUP.md) · [SOURCES](../docs/SOURCES.md) ·
[RECORDING](../docs/RECORDING.md) · [COMPARISON](../docs/COMPARISON.md)

---

## Install (unpacked)

1. `chrome://extensions` → **Developer mode**
2. **Load unpacked** → select this folder (the one containing `manifest.json`)
3. Pin it

Chrome shows a "started debugging this browser" banner while recording — that is
the DevTools protocol attaching, and it is how response bodies get captured.

## Package

```bash
./package.sh
#   ../dist/testmu-jmeter-studio-<v>.zip         files at the root  — Chrome Web Store
#   ../dist/testmu-jmeter-studio-<v>-share.zip   wrapped in a folder — Load unpacked
```

`package.sh` ships an explicit file list and fails if the manifest references
anything not on it, so a release can never be missing a page.

## Distribution

- **Chrome / Edge** — supported. Listing copy, permission justifications and the
  data-use disclosure are in [STORE_LISTING.md](STORE_LISTING.md).
- **Managed profiles** — unpacked extensions are usually blocked by policy;
  force-install with the `ExtensionSettings` policy instead.
- **Firefox** — not supported, and not a matter of effort: Firefox does not
  implement `chrome.debugger`, so response bodies cannot be captured, and
  correlation needs them. Use `jmxgen record` or `jmxgen capture` there.

---

## How the pieces fit

| File | Role |
|---|---|
| `background.js` | the recorder: CDP attach, request/response capture, the HAR, session persistence |
| `locator.js` | ranked, capture-time-verified locators for browser steps |
| `overlay.js` / `overlay.css` | the in-page panel: transactions, assertions, extractors, manual requests |
| `engine.js` | Pyodide host — loads `jmxgen.py` verbatim and exposes `author()` |
| `author.html/.css/.js` | the authoring page: every source, the results, the log |
| `hx.js` | HyperExecute: create project, upload, trigger |
| `run.html/.css/.js` | the run form |
| `popup.html/.css/.js` | recording controls and the way into everything else |
| `brand.css` | the TestMu design tokens every surface pulls from |
| `jmxgen.py` | the engine itself, byte-identical to the CLI's |

`jmxgen.py` is copied in by `package.sh`, never edited here: one engine, one
behaviour, whether it runs in a terminal or in a browser tab.

## Annotations in the HAR

Everything you add while recording travels inside the exported HAR as `_jmxgen`
fields — a custom key the HAR spec permits, so the file stays a valid HAR that
DevTools and other tools still read.

```json
{
  "pageref": "Login",
  "request":  { "method": "POST", "url": "https://shop.test/api/login" },
  "response": { "status": 200, "content": { "text": "{\"data\":{\"token\":\"…\"}}" } },
  "_jmxgen": {
    "name": "Login call",
    "assert": [{ "field": "body", "match": "contains", "pattern": "token" }],
    "extract": [{ "type": "json", "var": "TOKEN", "query": "$.data.token" }],
    "pause_after_ms": 2000
  }
}
```

Plus a plan-level block, when the load profile should travel with the recording:

```json
{ "log": { "_jmxgen": { "name": "Shop journey", "threads": 25, "ramp_up": 60, "duration": 900 } } }
```

## The optional console

One feature needs it: **Validate (single user)**, which runs the plan once
against the real target — that needs a JMeter binary, which a browser does not
have. Start it with `jmxgen console` and the popup says so. Everything else
works without it.
