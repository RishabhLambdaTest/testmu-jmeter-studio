# TestMu AI — JMeter Recorder

Record a journey, or bring the cURL command / OpenAPI spec / Postman collection /
spreadsheet you already have, and get a ready-to-run JMeter `.jmx` — with the
dynamic tokens correlated, the noise stripped out, and proof it works before you
put load on anything. Then run it on HyperExecute without leaving the browser.

**Nothing to install.** The engine ships inside the Chrome extension and runs in
WebAssembly; the run is triggered straight against the HyperExecute API, so your
access key never leaves the machine.

---

## Get it running

```
1. unzip dist/testmu-recorder-1.1.0-share.zip
2. chrome://extensions  →  Developer mode  →  Load unpacked  →  pick the folder
3. toolbar icon  →  cURL  →  paste a request  →  Generate plan
4. Run on HyperExecute…  →  credentials  →  Create & trigger
```

About five minutes, start to finish. The stepwise version, with screenshots, is
[docs/SETUP.md](docs/SETUP.md).

![A plan generated inside the extension](docs/screenshots/author-curl-result.png)

---

## The documentation

| | |
|---|---|
| [docs/SETUP.md](docs/SETUP.md) | install → first plan → triggered job, with screenshots, the permission justifications, and rollout by Chrome policy |
| [docs/SOURCES.md](docs/SOURCES.md) | all seven sources, each with a sample in [`sample/`](sample/) you can run today |
| [docs/RECORDING.md](docs/RECORDING.md) | recording and annotating a journey by hand |
| [docs/COMPARISON.md](docs/COMPARISON.md) | against BlazeMeter — including where BlazeMeter is ahead |

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
  for when load must keep arriving as the system degrades.
- **mTLS** — client certificates, with the JVM properties generated and checked
  at build time.

**Four artifacts from one authoring pass** — the `.jmx`, a Taurus YAML, a
Playwright browser test for the journey, and the HAR itself.

---

## Sharing it

```
dist/testmu-recorder-1.1.0-share.zip     6.3 MB   →  people (Load unpacked)
dist/testmu-recorder-1.1.0.zip           6.3 MB   →  Chrome Web Store, unlisted
```

Both are committed, so nobody has to build anything — clone, send the `-share`
zip and [docs/SETUP.md](docs/SETUP.md), done. Rebuild them after a change with
`jmxgen-recorder/package.sh`; the filename carries the manifest version, so an
install can always be traced back to a commit.

For managed Chrome fleets, force-install by policy; for a team, upload the
store-shaped zip as an **unlisted** Chrome Web Store item so updates arrive
automatically. Both are covered in
[jmxgen-recorder/STORE_LISTING.md](jmxgen-recorder/STORE_LISTING.md).

---

## What's in here

| Path | |
|---|---|
| `jmxgen-recorder/` | the extension — load this folder unpacked, or zip it with `package.sh` |
| `dist/` | the two builds, ready to hand out |
| `docs/` | setup, sources, recording, comparison, screenshots |
| `sample/` | one input for every source, plus CSV, workload and mTLS samples |

Two non-web files live in `jmxgen-recorder/`, and both belong to the extension:
`jmxgen.py` is the authoring engine itself — it runs in WebAssembly inside the
browser, not on anyone's machine — and `package.sh` builds the two zips.

There is also a command-line version of the engine, for CI and for capturing
traffic that never touches a Chrome tab (mobile apps, desktop clients, proxied
backends). It is a separate repository —
[RishabhLambdaTest/jmxgen](https://github.com/RishabhLambdaTest/jmxgen) — and
nothing here needs it.
