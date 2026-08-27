# jmxgen

Author a ready-to-run JMeter `.jmx` from an OpenAPI spec, a Postman collection, a
spreadsheet, a URL list, or a real browser session — with dynamic tokens wired up
automatically, and proof it works before you put load on anything.

Two ways in: the **app** (console + CLI) and the **Chrome recorder extension**.

---

## 1. Dependencies

**To author a plan — nothing.** The bundle in `dist/` is self-contained: no Python, no
pip, no virtualenv.

**To run a plan** you need JMeter and Java:

```bash
brew install openjdk@11
brew install jmeter
```

**Optional**, each unlocking one feature only:

| Install | Unlocks |
|---|---|
| `pip install playwright && python3 -m playwright install chromium` | `record` — headless / manual browser capture |
| `pip install mitmproxy` | `capture` — Postman, mobile, desktop, backend traffic |
| `export LAMBDATEST_USERNAME=... LAMBDATEST_ACCESS_KEY=...` | `ship` — running on HyperExecute |

Check everything at once:

```bash
./dist/jmxgen-macos/jmxgen doctor
```

It prints what is present, what each thing unlocks, and the command to install anything
missing. If the Chrome extension is your recorder, you do not need Playwright.

---

## 2. Run it locally

```bash
# start the web console — opens your browser automatically
./dist/jmxgen-macos/jmxgen console
```

Then: pick a source → **Generate plan** → review the **Correlations** tab →
**Validate (single user)** → **Download .jmx**. Ctrl-C stops the console.

Same thing on the CLI:

```bash
# author from a contract
./dist/jmxgen-macos/jmxgen from-openapi api.yaml -o plan.jmx

# author from a recording, with correlation
./dist/jmxgen-macos/jmxgen from-har journey.har -o plan.jmx --mode web

# run it once as a single user and diagnose what broke  <- the gate that matters
./dist/jmxgen-macos/jmxgen replay plan.jmx

# run the load test
jmeter -n -t plan.jmx -l results.jtl -e -o report/
```

| Command | What it does |
|---|---|
| `doctor` | What is installed and what it unlocks |
| `console` | Web console on port 8770 |
| `from-openapi` / `from-postman` / `from-curl` | Contract or collection → `.jmx` |
| `from-har` | Any browser recording → `.jmx`, with correlation |
| `from-excel` | Spreadsheet → `.jmx` (`template` writes the sheet to fill in) |
| `probe` | A list of page URLs and nothing else → `.jmx` |
| `verify` | Valid and loadable? `--deep` asks JMeter itself |
| `replay` | Run once as one user and diagnose failures |
| `optimize` | Repair and slim a plan you already have |
| `ship` | Author and run on HyperExecute in one step |

The console releases the port on every exit — Ctrl-C, `kill`, or closing the terminal —
and stops itself after 60 minutes with no requests so a forgotten window never blocks the
next start. `--idle-timeout 0` keeps it up indefinitely; `--idle-timeout 15` is shorter.
If the port is taken anyway, it names the process holding it and the command to stop it.
The extension's endpoint is configurable to match under *Where jmxgen runs* in the popup.

---

## 3. Run the Chrome extension

**Install** — the console must be running first (step 2), because the extension hands its
recording to it.

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select the `jmxgen-recorder/` folder
4. Pin it so the toolbar icon is visible

**Record**

1. Click the extension icon. It should say *jmxgen service found at localhost:8770*.
2. **Type your target URL in the popup and press Go.** Do not use *Start recording this
   tab* for a fresh journey — Go attaches before the first byte, so the page load and the
   auth handshake are captured. Recording an already-open tab misses them.
3. Click through your flow. Use the floating panel on the page to name transactions and
   attach assertions, extractors and pauses as you go.
4. Press **Generate test plan** — the console opens with correlations already computed.

Shortcuts: `⌘⇧9` opens the popup, `⌘⇧8` starts/stops recording.

**If the console is not running**, press **Export HAR instead** and finish on the CLI:

```bash
./dist/jmxgen-macos/jmxgen from-har jmxgen-session-*.har -o plan.jmx
./dist/jmxgen-macos/jmxgen replay plan.jmx
```

**Expect this:** Chrome shows *"jmxgen recorder started debugging this browser"* while
recording. That is the DevTools protocol attaching — the only API that exposes response
bodies, which is what correlation reads. Closing that banner stops the recording.

Firefox is not supported: it does not implement `chrome.debugger`, so response bodies
cannot be captured at all. Use `record` or `capture` there.

---

## Sharing it

Hand someone `dist/jmxgen-macos.zip` (9.2 MB). They need nothing else to author:

```bash
unzip jmxgen-macos.zip
./jmxgen-macos/jmxgen console
```

If macOS blocks it, `xattr -dr com.apple.quarantine jmxgen-macos` clears the download
quarantine once. First launch takes a few seconds while macOS scans the bundle; every run
after that starts in ~0.2s.

Rebuild with `./build_binary.sh`. Bundles are per-platform — build on macOS for macOS,
Linux for Linux, Windows for the `.exe`. If the target machine already has Python 3.8+,
`./build_bundle.sh` produces `dist/jmxgen`, a single 144 KB file that runs anywhere.

---

## What's here

| Path | |
|---|---|
| `dist/jmxgen-macos/` | the built app — run `jmxgen` inside it |
| `jmxgen-recorder/` | the Chrome extension — load this folder unpacked |
| `docs/JMXGEN_GUIDE.html` | illustrated walkthrough with screenshots — open in a browser |
| `docs/GETTING_STARTED.md` | the same, in markdown |
| `JMXGEN_README.md` | full reference: every flag, the spec format, correlation rules |
| `examples/` | a sample spec and a spreadsheet template |
| `samples/` | real customer plans used for testing `optimize` |
| `demo.sh` | end-to-end demo against self-started sample targets |
| `run_tests.sh` | regression suite (`--live` to include network tests) |
| `jmxgen.py` `jmxgen_server.py` `console.html` | the source the bundle is built from |
