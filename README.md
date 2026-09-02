# TestMu AI — JMeter Studio

A Chrome extension that turns what you already have into a ready-to-run JMeter
test plan. Record a journey through your app, or hand it a curl command, an
OpenAPI spec, a Postman collection or a spreadsheet. It correlates the dynamic
tokens, strips out the noise, and lets you prove the plan works before you put
load on anything. HyperExecute runs it when you are ready.

There is nothing to install. The authoring engine ships inside the extension and
runs in WebAssembly, and runs are triggered directly against the HyperExecute
API, so your access key never leaves the machine.

## Get it running

```
1. unzip dist/testmu-jmeter-studio-1.3.4-share.zip
2. chrome://extensions  →  Developer mode  →  Load unpacked  →  pick the folder
3. toolbar icon  →  cURL  →  paste a request  →  Generate plan
4. Run on HyperExecute…  →  credentials  →  Create & trigger
```

Five minutes, start to finish. [docs/SETUP.md](docs/SETUP.md) has the same thing
step by step, with screenshots.

![A plan generated inside the extension](docs/screenshots/author-curl-result.png)

## Documentation

[**Setup**](docs/SETUP.md) covers installation through to a triggered job, plus
troubleshooting for every error the extension can produce and the permission
questions a security review will ask.

[**Sources**](docs/SOURCES.md) walks through all seven ways to author a plan.
Each one has a sample in [`sample/`](sample/) you can run today.

[**Recording**](docs/RECORDING.md) is the guided version of recording a journey
and annotating it as you browse.

[**Options**](docs/OPTIONS.md) explains every control in the extension, with a
worked example for each. Reference rather than reading: the defaults are right
most of the time.

[**Comparison**](docs/COMPARISON.md) sets this against BlazeMeter, including the
places BlazeMeter is ahead.

## What it does

Seven sources feed the same authoring engine: a browser recording, curl commands,
an OpenAPI or Swagger spec, a Postman collection, an Excel or CSV sheet, a list of
page URLs, or a JMeter plan you already have.

It handles the parts that usually go wrong.

*Correlation.* Tokens are found in one response and wired into the next. Each one
is reported with the rule that matched it, a confidence, and the request it
travels between, so you can disagree with the decision.

*Authentication under load.* The login runs once per user in a setUp Thread Group
and publishes a JMeter property rather than a per-thread variable. Getting this
backwards is the usual reason a plan works with one user and returns 401s with
five hundred.

*Test data.* A CSV drives per-user values, and HyperExecute can split the rows
across engines so no two machines replay the same data.

*Transactions and assertions.* Both are added while you record, on the request in
front of you, rather than reconstructed later in a JMeter tree.

*Workload models.* Ordinary thread groups, and arrival-rate groups for the case
where load has to keep arriving as the system slows down.

*Client certificates.* mTLS keystores with the JVM properties generated and
checked while the plan is built, not discovered at run time.

One authoring pass produces four artifacts: the `.jmx`, a Taurus YAML, a
Playwright test covering the browser steps, and the HAR itself.

## Sharing it

```
dist/testmu-jmeter-studio-1.3.4-share.zip     6.3 MB   →  people (Load unpacked)
dist/testmu-jmeter-studio-1.3.4.zip           6.3 MB   →  Chrome Web Store, unlisted
```

Both hold the same extension. The `-share` build wraps it in a `testmu-jmeter-studio/`
folder, which is what *Load unpacked* asks you to select; the store build puts
`manifest.json` at the top level, because the store rejects an upload with a
wrapper folder. If a person is going to unzip it, send the `-share` one.

Both are committed, so nobody has to build anything. Clone, send the zip and a
link to [docs/SETUP.md](docs/SETUP.md), and you are done. After a change to the
extension, `extension/package.sh` rebuilds the pair; the version in the
filename comes from the manifest, so any install can be traced back to a commit.

For managed Chrome fleets, force-install by policy. For a wider team, upload the
store-shaped zip as an unlisted Chrome Web Store item and updates arrive on their
own. Both routes are written up in
[extension/STORE_LISTING.md](extension/STORE_LISTING.md).

## What has been verified

Driven in a real Chrome with the packaged build, not inspected. Kept here so
nobody has to guess what is proven and what is merely written.

| Path | State |
|---|---|
| Record a logged-in journey against a live public API | 8 requests, transactions preserved, the JWT from `POST /auth/login` correlated at high confidence |
| All seven sources, in the extension | pass, 0 errors: OpenAPI file and URL, Postman, HAR, cURL, Excel, URL list, existing `.jmx` |
| The four artifacts | `.jmx` valid, Taurus YAML, Playwright with ranked locators, HAR |
| The XML gate | a real plan passes; truncated, unclosed, non-JMeter, sampler-less, control-character and empty inputs are each refused by name |
| Annotating while recording | assertions, extractors, transactions and drops all reach the plan |
| Validate against real JMeter | pass, failure and nothing-ran each reported distinctly (needs the optional local console) |
| An hour-shaped recording | 40,000 requests written in 1.1 s; survives worker eviction and a browser restart |
| Test data | a `CSVDataSet` referencing the file, split across engines at run time |
| A live HyperExecute run | create, upload and trigger from the extension against the real API; the job completed and the plan's requests reached the target |
| The run-time overrides | a job sent as 1 user starts JMeter with `threads=1`, and 4 users at 2 per engine starts 2 engines |
| Regression suite | 56 of 56, in the [jmxgen CLI](https://github.com/RishabhLambdaTest/jmxgen) repository, which shares this engine |

The HyperExecute path was the last untested one, and testing it found a real
bug. HyperExecute refuses a request carrying `Origin: chrome-extension://…`
while accepting the identical request with the dashboard's own origin, and those
headers are ones a browser will not let a script set. 1.3.3 sets them through
`declarativeNetRequest`. It was confirmed in both directions: the fix triggers a
job, and a build with the rule disabled reproduces the 403 exactly.

## What is in here

| Path | |
|---|---|
| `extension/` | the extension; load this folder unpacked, or zip it with `package.sh` |
| `dist/` | the two builds, ready to hand out |
| `docs/` | setup, sources, recording, comparison, screenshots |
| `sample/` | one input for every source, plus CSV, workload and mTLS samples |

Two files in `extension/` are not web assets, and both belong to the
extension. `jmxgen.py` is the authoring engine, which runs in WebAssembly inside
the browser rather than on anyone's machine. `package.sh` builds the two zips.

A command-line version of the same engine exists for CI, and for capturing
traffic that never touches a Chrome tab: mobile apps, desktop clients, proxied
backends. It lives in [RishabhLambdaTest/jmxgen](https://github.com/RishabhLambdaTest/jmxgen)
and nothing here depends on it.
