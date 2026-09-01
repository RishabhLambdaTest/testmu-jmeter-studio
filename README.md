# TestMu Recorder — JMeter test plans, authored in the browser

Record a journey, or bring the cURL command / OpenAPI spec / Postman collection /
spreadsheet you already have, and get a ready-to-run JMeter `.jmx` — with the
dynamic tokens correlated, the noise stripped out, and proof it works before you
put load on anything. Then run it on HyperExecute without leaving the browser.

Nothing to install. The engine ships inside the Chrome extension and runs in
WebAssembly; the run is triggered straight against the HyperExecute API, so your
access key never leaves the machine.

---

## Start here

| I want to… | Read |
|---|---|
| **install it and run my first test** | [docs/SETUP.md](docs/SETUP.md) — stepwise, with screenshots |
| **see every way to author a plan, with samples I can run** | [docs/SOURCES.md](docs/SOURCES.md) |
| **record a journey by hand, like BlazeMeter's recorder** | [docs/RECORDING.md](docs/RECORDING.md) |
| **compare it to BlazeMeter, or pitch it** | [docs/COMPARISON.md](docs/COMPARISON.md) |
| **use the CLI, or the full flag reference** | [JMXGEN_README.md](JMXGEN_README.md) |
| **read the numbers a run produces** | [docs/JMETER_METRICS_GUIDE.md](docs/JMETER_METRICS_GUIDE.md) |
| **understand why a plan is built the way it is** | [docs/JMX_OPTIMIZATION_README.md](docs/JMX_OPTIMIZATION_README.md) |

---

## The 60-second version

1. Unzip `dist/testmu-recorder-<version>-share.zip`
2. `chrome://extensions` → **Developer mode** → **Load unpacked** → pick the folder
3. Click the toolbar icon → **cURL** → paste a request → **Generate plan**
4. **Run on HyperExecute…** → credentials → **Create & trigger**

![A plan generated inside the extension](docs/screenshots/author-curl-result.png)

---

## What it covers

**Seven ways in** — a browser recording, cURL, OpenAPI/Swagger, a Postman
collection, an Excel/CSV sheet, a list of page URLs, or an existing `.jmx`.

**The parts people get wrong**, handled:

- **Correlation** — tokens found in one response and wired into the next, with
  the matching rule, a confidence and the exact hop shown, so you can disagree
  with it.
- **Auth under load** — the login runs once per user in a setUp Thread Group and
  publishes a JMeter *property*, not a per-thread variable.
- **Test data** — CSV per user, split across engines on HyperExecute.
- **Transactions and assertions** — added while you record, on the request you
  are looking at.
- **Open and closed workloads** — normal Thread Groups, and arrival-rate groups
  for the case where load must keep arriving as the system degrades.
- **mTLS** — client certificates, with the JVM properties generated and checked
  at build time.
- **Verification** — `verify` for validity, `validate` for the heap/CPU lint,
  and a single-user replay that reports per-request codes and any `${VARIABLE}`
  that never resolved.

**Four artifacts out of one authoring pass** — the `.jmx`, a Taurus YAML, a
Playwright browser test for the journey, and the HAR itself.

---

## Sharing it

One file, committed to this repo so nobody has to build it:

```
dist/testmu-recorder-1.1.0-share.zip     ~6 MB   →  people (Load unpacked)
dist/testmu-recorder-1.1.0.zip           ~6 MB   →  Chrome Web Store, unlisted
```

Send the `-share` one with [docs/SETUP.md](docs/SETUP.md). Rebuild both after any
change to the extension with `jmxgen-recorder/package.sh`, and commit the new
pair — the filename carries the manifest version, so what someone installed is
always identifiable.

For managed Chrome fleets, force-install by policy; for a team, upload the
store-shaped zip as an **unlisted** Chrome Web Store item so updates arrive
automatically. Both are covered in
[jmxgen-recorder/STORE_LISTING.md](jmxgen-recorder/STORE_LISTING.md).

---

## The CLI and the console (optional)

Everything above works with no install. The command line exists for CI, for
scripted authoring, and for the two things a browser cannot do: run JMeter, and
record traffic that is not in a Chrome tab.

```bash
./dist/jmxgen-macos/jmxgen doctor           # what is installed, and what it unlocks
./dist/jmxgen-macos/jmxgen console          # the web console on :8770
./dist/jmxgen-macos/jmxgen from-har s.har -o plan.jmx
./dist/jmxgen-macos/jmxgen replay plan.jmx  # one user, real target — the gate that matters
jmeter -n -t plan.jmx -l results.jtl -e -o report/
```

| Command | What it does |
|---|---|
| `from-openapi` / `from-postman` / `from-curl` | contract or collection → `.jmx` |
| `from-har` | any browser recording → `.jmx`, with correlation |
| `from-excel` | spreadsheet → `.jmx` (`template` writes the sheet to fill in) |
| `probe` | a list of page URLs and nothing else → `.jmx` |
| `record` / `capture` | Playwright-driven recording; proxy capture for mobile, desktop, Postman |
| `import-jmx` / `optimize` | turn a plan back into a spec; repair and slim it |
| `to-taurus` / `to-playwright` | the same test as `bzt` YAML, or as a browser test |
| `verify` / `validate` / `replay` | valid? sane? does it actually run? |
| `ship` | author and run on HyperExecute in one step |

Running a plan needs JMeter and Java (`brew install openjdk@11 jmeter`).
Everything else is optional and each install unlocks exactly one thing —
`doctor` prints the list.

---

## What's in the tree

| Path | |
|---|---|
| `jmxgen-recorder/` | the Chrome extension — this is the product |
| `dist/testmu-recorder-*.zip` | the shareable builds |
| `dist/jmxgen-macos/` | the optional CLI bundle |
| `sample/` | one input for every source, plus CSV, workload and mTLS samples |
| `docs/` | setup, sources, recording, comparison, screenshots |
| `JMXGEN_README.md` | full reference: every flag, the spec format, the correlation rules |
| `jmxgen.py` `jmxgen_server.py` `console.html` | the source the bundle and the extension engine share |
| `run_tests.sh` | the regression suite (`--live` includes network tests) |
