# jmxgen — author `.jmx` files from a URL, an Excel sheet, a HAR, or a spec

`jmxgen.py` writes a ready-to-use JMeter 5.6.3 test plan from whatever you already have —
a live URL, a filled-in Excel sheet, a browser recording, or a short YAML spec — and
verifies the generated XML before handing it to you.

Same input, any runner: local, HyperExecute / TestMu, BlazeMeter, Jenkins — only the
`platform:` value changes.

Every generated plan follows the rules in [JMX_OPTIMIZATION_README.md](docs/JMX_OPTIMIZATION_README.md)
by default: no result-storing listeners, Simple Data Writer with response data off,
timeouts set, functional mode off, embedded resources off, `loops=-1` only when a
scheduler time-boxes the run.


## Install — no Python needed

```bash
./build_binary.sh          # -> dist/jmxgen-macos/  and  dist/jmxgen-macos.zip
```

Hand someone the `.zip`. They unzip it and run the `jmxgen` inside — nothing else to
install for authoring. (JMeter is still needed to *run* a plan; see Prerequisites.)

```bash
unzip jmxgen-macos.zip
./jmxgen-macos/jmxgen doctor
./jmxgen-macos/jmxgen console      # opens http://localhost:8770
```

The bundle is a folder, not a single file, on purpose: a one-file bundle unpacks itself
into a new temp directory on every run and macOS re-scans every extracted file each
time, which costs ~5s per command. The folder is scanned once and starts in 0.2s.
Bundles are per-platform — build on macOS for macOS, Linux for Linux, Windows for `.exe`.

If the target machine already has Python, `./build_bundle.sh` produces `dist/jmxgen`,
a single 144K file that runs anywhere Python 3.8+ is installed.

## First run

```bash
python3 jmxgen.py doctor
```

Reports what is installed, what each thing unlocks, and the exact command to install
anything missing. Nothing is mandatory except Python — every missing piece only disables
the one feature listed next to it.

```
== jmxgen doctor ==
  . python      3.9.6            everything
  . PyYAML      installed        YAML specs and rule files
  . Playwright  browser ready    `record` - headless / manual browser capture
  . mitmproxy   installed        `capture` - mobile / desktop / Postman / backend traffic
  . JMeter      /opt/homebrew..  `verify --deep` and `replay` - the validation gates
  everything needed is installed
```

## The console

```bash
python3 jmxgen_server.py        # then open http://localhost:8770
```

A web UI over the same code the CLI uses — for people who should not have to learn a CLI
or JMeter:

1. **Source** — OpenAPI, Postman, HAR, cURL, Excel/CSV, a URL list, or an existing `.jmx`
2. **Options** — traffic filter (api/web/auto), methods, include/exclude, login, CSV data,
   load profile
3. **Review** — every request in a table, and every correlation with its rule, confidence
   and provenance. Untick anything you disagree with and press **Apply changes**: a
   rejected correlation puts the recorded literal back and drops its extractor.
4. **Validate** — runs the plan once as a single user against the real target and shows
   which requests failed and which variables did not resolve
5. **Run** — creates the HyperExecute project and uploads the plan

The API is plain JSON if you would rather drive it yourself: `POST /api/author`,
`/api/apply`, `/api/replay`, `/api/ship`, `GET /api/plan/<id>`.

## Every way in

```bash
pip install pyyaml openpyxl        # both optional; JSON/CSV work without them

python3 jmxgen.py template plan.xlsx        # Excel: fill the steps + config sheets
python3 jmxgen.py from-excel plan.xlsx -o plan.jmx

python3 jmxgen.py from-openapi openapi.yaml -o api.jmx --auth 'Bearer ${TOKEN}'
python3 jmxgen.py from-openapi https://api.example.com/openapi.json -o api.jmx

python3 jmxgen.py from-postman collection.json -o pm.jmx

python3 jmxgen.py record pages.txt -o flow.jmx               # headless, walks the list
python3 jmxgen.py record https://app.example.com --manual    # you drive the browser
python3 jmxgen.py probe pages.txt -o plan.jmx --parallel 6   # URL list, no HAR needed
python3 jmxgen.py probe https://shop.example.com/a https://shop.example.com/b -o plan.jmx

python3 jmxgen.py from-har recording.har -o flow.jmx     # auto-correlates tokens
python3 jmxgen.py from-url https://shop.example.com -o shop.jmx --depth 1

pbpaste | python3 jmxgen.py from-curl -o quick.jmx       # paste curl from DevTools

python3 jmxgen.py init plan.yaml && python3 jmxgen.py build plan.yaml   # hand-written

python3 jmxgen.py optimize old.jmx -o slim.jmx --drop-third-party --drop-static
```

Every one of them writes the `.jmx`, then verifies it and lints it before handing it
back. Add `--spec out.yaml` to any `from-*` command to also get the editable spec, so you
tweak and rebuild instead of starting over. Add `--deep` to have real JMeter load the
result as the final gate.

### Record — a real browser captures everything, headless by default

```bash
python3 jmxgen.py record pages.txt -o flow.jmx        # same URL list as probe
python3 jmxgen.py record https://a.example.com https://a.example.com/pricing -o flow.jmx
```

Give it URLs — as arguments, a `.txt`, or a column in a `.csv`/`.xlsx` — and it walks them
in a headless browser, capturing every request each page makes, JavaScript included. No
window, no clicking, nothing to export:

```
recording 8 URL(s) with chromium (headless)
  [1/8] https://www.testmuai.com/
  ...
captured session.har (80.0 MB) [temporary]
kept 24 of 991 captured requests across 8 page(s) (dropped 851 static, 116 third-party, 0 filtered)
  correlated ${SITETOKEN} <- siteToken (3343fd95675841258346a954...)
```

Each URL gets its own browser page, so each becomes one Transaction Controller in the plan.
`--settle MS` (default 1500) controls how long to wait after load so lazy-loaded and XHR
traffic is captured.

**`--manual` when you need to drive.** The browser opens visibly at the first URL and waits
while you log in, click and submit; press Enter in the terminal (or close the window) and
the plan is generated from everything it saw:

```bash
python3 jmxgen.py record https://app.example.com --manual -o flow.jmx
```

Use it for anything behind a login, a multi-step form, or a flow no URL list can express.

One-off setup:

```bash
pip install playwright && python3 -m playwright install chromium   # ~90 MB
```

- `--browser chrome` drives your installed Google Chrome instead of the bundled Chromium
  (also `edge`, `firefox`, `webkit`)
- `--profile ~/.jmxgen-profile` keeps a persistent browser profile, so you log in once and
  reuse the session on later runs — pairs well with headless list mode
- `--har session.har` keeps the capture (otherwise it is written to a temp dir and deleted);
  re-run `from-har` on it later with different filters instead of re-recording
- the usual filters apply: `--include`, `--exclude`, `--keep-static`, `--keep-third-party`,
  `--no-correlate`, `--think-time`

Because it is a real browser running real JavaScript, this is the mode that works on SPAs,
on WAF-protected sites, and anywhere `probe` only sees a challenge page. The recorded
User-Agent is hoisted to one plan-level header (with the `Headless` marker stripped) and
the recorded scheme and port are preserved.

**record vs probe** — same input, different depth:

| | `probe` | `record` |
|---|---|---|
| Fetches | HTML only, one GET per page | full browser, runs JavaScript |
| Sees | resources the page *declares* | everything the page actually *requests*, XHR included |
| Needs | nothing | Playwright + a browser (~90 MB once) |
| Speed | fast | slower — a real page load each |
| Logins / SPAs / WAFs | no | yes (`--manual` for logins) |

### One recording, two plans: `--mode api` / `--mode web`

A browser recording contains both layers of traffic. Which plan you want depends on who
is asking, so pick at generate time — no need to record twice:

```bash
python3 jmxgen.py from-har session.har --mode api  -o api.jmx    # service calls only
python3 jmxgen.py from-har session.har --mode auto -o mixed.jmx  # default: pages + calls
python3 jmxgen.py from-har session.har --mode web  -o web.jmx    # everything the browser fetched
```

Same recording, three answers:

```
api    kept 2 of 4    POST /api/login, POST /api/checkout
auto   kept 3 of 4    GET /, POST /api/login, POST /api/checkout
web    kept 4 of 4    GET /, GET /a.js, POST /api/login, POST /api/checkout
```

`api` mode uses Chrome's own **resource type** for each request — `xhr`, `fetch`,
`document`, `script`, `image`, `font` — which is far more reliable than guessing from file
extensions. The extension records it (as `_resourceType`, the same field DevTools' own HAR
export uses, so HARs from other tools work too). When a HAR has no type information, it
falls back to method, content type and path shape (`/api/`, `/v1/`, `/graphql`).

`--mode` works on both `from-har` and `record`.

### Recording non-browser traffic: `capture`

The extension only sees Chrome. For **mobile apps, desktop clients, Postman runs, or
backend service-to-service calls**, record through a proxy:

```bash
pip install mitmproxy
python3 jmxgen.py capture --port 8080 --har session.har -o api.jmx --mode api
```

```
proxy listening on port 8080
  1. point the device / app / Postman at  <this-machine-ip>:8080
  2. install mitmproxy's CA on it from    http://mitm.it
  3. do the journey, then press ctrl-c here
kept 2 of 2 captured requests
  correlated ${ACCESS_TOKEN}  bearer-token  high  from body  POST /oauth/token -> GET /v2/orders
```

It ships its own mitmproxy addon (`mitm_har.py`) rather than depending on mitmproxy's
built-in HAR export, which only exists in 10.1+ — so it works on any version with the
modern addon API. `--seconds N` stops automatically instead of waiting for ctrl-c.

Everything lands in the same pipeline: filtering, correlation, verification, replay.

### Chrome extension — record in your own browser, author steps by hand

[`jmxgen-recorder/`](jmxgen-recorder/) is an unpacked MV3 extension. Load it once
(`chrome://extensions` → Developer mode → Load unpacked), then record in your everyday
Chrome — real profile, real logins, real VPN — with a floating panel for the things a raw
recording cannot infer: transaction names, assertions, extractors, pauses, renames,
skipped requests, and requests you type in by hand.

Export the HAR, then:

```bash
python3 jmxgen.py from-har jmxgen-session-*.har -o plan.jmx
```

The manual steps travel inside the HAR as `_jmxgen` fields (a custom key the HAR spec
allows), so the file stays a valid HAR and `from-har` still applies its own filtering and
automatic correlation on top. Full details in
[jmxgen-recorder/README.md](jmxgen-recorder/README.md).

Use this instead of `record` when you need your own browser profile; use `record` when you
want it unattended over a URL list.

### Probe — a list of page URLs, nothing else

No HAR, no proxy, no recording session, no clicking. Hand it the pages you care about —
as arguments, a `.txt` file, or a column in a `.csv`/`.xlsx`:

```bash
python3 jmxgen.py probe pages.txt -o plan.jmx --parallel 6
probed 47 page(s), found 812 sub-resource(s) (dropped 1244 third-party/tracker, 0 static)
```

Each page is fetched once and its declared sub-resources are read out of the markup —
`script[src]`, `link[href]`, `img[src]`, `data-src`, `srcset`, `iframe`, `source`, and
`url()` inside inline CSS. You get the familiar page-oriented shape:

```
TransactionController  Page :1 [ Shop Home ]
  HTTPSamplerProxy       Main URL: /
    BoundaryExtractor      Extract CSRF
  ParallelSampler        Assets - page 1        <- capped, LIMIT_MAX_THREAD_NUMBER=true
    HTTPSamplerProxy       Sub URL: /js/app.js
    ...
  HTTPSamplerProxy       Form 1: GET /search    <- uses ${CSRF} from the page above
  TestAction             Pause after page 1
```

The HTML always completes before anything that consumes a token extracted from it, and
only the sub-resources fan out — so `--parallel` never races the correlation.
Third-party and tracker hosts are dropped by default (`--all-domains`, `--keep-trackers`),
`--no-static` drops js/css/images, `--no-assets` keeps only the page requests, and
`--max-assets` caps a heavy page.

**Limit worth knowing:** this fetches HTML, it does not execute JavaScript. It finds every
resource the page *declares*; it will not see requests a script fabricates at runtime
(analytics beacons, XHR the SPA fires after mount). For a server-rendered site that is
the complete picture — and the runtime-generated calls are overwhelmingly the tracker
noise you would filter out anyway. For a JS-heavy SPA, record a HAR and use `from-har`,
or drive the API directly with `from-openapi` / `from-postman`.

### OpenAPI / Swagger

Reads OpenAPI 3.x and Swagger 2, from a file or a live URL, JSON or YAML. One sampler per
operation, grouped into transactions by tag. Resolves `$ref`s and synthesizes request
bodies from schemas (honouring `example`, `default`, `enum`, and `format` — uuid, email,
date-time). Path parameters become `${VARS}` collected at the top of the spec; the
expected 2xx from `responses` becomes the assertion. `--include` / `--exclude` filter by
operation, `--server` overrides the base URL, `--auth` sets the Authorization header.

### Postman

Folders become Transaction Controllers, `{{vars}}` become `${vars}`, and collection- or
request-level auth (bearer / basic / apikey) becomes the right header. Raw, urlencoded,
form-data and GraphQL bodies are all handled. It also mines the test scripts:
`pm.response.to.have.status(200)` becomes a response assertion and
`pm.environment.set("token", jsonData.data.token)` becomes a JSON extractor — so the
chaining survives the conversion.

### HAR (browser recording) — with automatic correlation

```bash
python3 jmxgen.py from-har recording.har -o flow.jmx
kept 4 of 6 recorded requests across 2 page(s) (dropped 2 static, 0 third-party, 0 filtered)
  correlated ${CSRF} <- csrf (a7f3c9d2b8e14a05...)
  correlated ${TOKEN} <- token (eyJhbGciOi9zX3RrbjE3ODQw...)
```

`log.pages` becomes one Transaction Controller per page. Static assets and third-party
/ tracker domains are dropped by default (`--keep-static`, `--keep-third-party` to
override). Then the correlation pass runs: it looks for values a later request sends that
an earlier **response** produced, adds a JSON or boundary extractor at the source, and
rewrites the later requests to use `${VAR}`. That is the step that decides whether a
recorded plan actually works on replay or just fails with stale tokens.

### cURL

Copy "Copy as cURL" out of DevTools and pipe it in. Handles `-X`, `-H`, `-d/--data-raw`,
`-F`, `-u`, and multiple commands in one file.

## Authoring → execution in one command

[`jmx_pipeline.py`](jmx_pipeline.py) chains `jmxgen.py` with
[`hyperexecute_automation.py`](hyperexecute_automation.py): author → verify → create
project → upload → trigger → monitor → download artifacts.

```bash
# record a URL list headlessly, then load-test it on HyperExecute
python3 jmx_pipeline.py record pages.txt \
    --project-name "TestMu Load" --concurrency 5 --duration 300

# author from an OpenAPI spec, passing extra authoring flags through
python3 jmx_pipeline.py from-openapi api.yaml \
    --author "--auth 'Bearer ${TOKEN}' --include /orders" \
    --project-name "Orders API" --regions eastus --concurrency 10

# ship a plan you already have, with its data file
python3 jmx_pipeline.py --jmx testmuai_lean.jmx --data users.csv \
    --project-name "TestMu Load" --duration 600

# author and verify only - stop before the cloud
python3 jmx_pipeline.py probe pages.txt --no-run
```

Any authoring mode works as the first argument (`record`, `probe`, `from-har`,
`from-openapi`, `from-postman`, `from-curl`, `from-excel`, `from-url`, `build`), with
mode-specific flags passed through in `--author "..."`.

Every run flag from `hyperexecute_automation.py` is accepted verbatim — `--regions`,
`--platform`, `--concurrency`, `--duration`, `--rampup`, `--max-vusers-per-vm`,
`--splitcsv`, `--job-label`, `--global-timeout`, `--report-dir`, `--extra-jmeter-args`,
`--no-download` — because the pipeline reuses that script's own parser rather than
duplicating it. Credentials come from `--userName`/`--accessKey` or
`LAMBDATEST_USERNAME`/`LAMBDATEST_ACCESS_KEY`.

The plan is **verified before it is uploaded** (`--deep` makes JMeter itself load it
first), so a broken plan fails locally in seconds instead of after a queue wait. Reuse a
project across runs with `--project-id` — the pipeline prints it when it finishes.

## Prerequisites for running a generated plan

You don't need to know JMeter to *author* with this tool, but running the plan needs a
few things in place. `jmxgen verify` tells you which of these a given plan actually needs.

**To run locally**

| Need | Detail |
|---|---|
| **Java** | JMeter 5.6.3 needs Java 8+; use 11 or 17. `java -version` to check. |
| **Apache JMeter** | 5.6.3 (what the generated files declare). `brew install jmeter` on this machine. |
| **Plugins** *(only if used)* | `bzm - Parallel Controller` for `--parallel` plans, `WebDriver Set` for browser plans. Install via JMeter's **Plugins Manager**. `verify` prints exactly which plugin elements a plan contains. |
| **Data files** | Any CSV referenced by a CSV Data Set must sit next to the `.jmx` (or be given an absolute path). `verify` flags missing ones. |
| **Heap** | Set with the `HEAP` / `JVM_ARGS` environment variable *before* launching — it cannot be set in `user.properties`. See [JMX_OPTIMIZATION_README.md](docs/JMX_OPTIMIZATION_README.md). |
| **Non-GUI mode** | `jmeter -n -t plan.jmx -l results.csv -e -o reports/`. GUI mode is for editing only. |

**To run on HyperExecute / TestMu**: upload the `.jmx` *and* every data file it references,
and make sure the platform image has any plugin the plan needs.
[`jmx_pipeline.py`](jmx_pipeline.py) does the upload for you — pass extra files with
`--data users.csv`.

## How this compares to the BlazeMeter recorder

BlazeMeter's Chrome extension exports a JMX built from the same core elements: a Thread
Group, one **Transaction Controller per recorded step**, the HTTP requests inside it, and
Cookie/Cache Managers "because browsers keep cookies and cache, and they were captured in
the recording", plus a Header Manager carrying things like User-Agent
([record](https://help.blazemeter.com/docs/guide/recorders-chrome-extension-record.html),
[overview](https://help.blazemeter.com/docs/guide/recorders-blazemeter-chrome-extension.html)).

Plans from `jmxgen` contain all of those:

```
TestPlan
  ConfigTestElement    HTTP Request Defaults      <- + connect/response timeouts
  HeaderManager        HTTP Header Manager        <- one User-Agent for the plan
  CookieManager        HTTP Cookie Manager
  CacheManager         HTTP Cache Manager
  ThreadGroup          Recorded Journey
    TransactionController  Page :1 [ … ]          <- one per step / page
      HTTPSamplerProxy       …                    <- with its own HeaderManager
        BoundaryExtractor / JSONPostProcessor     <- correlation
        ResponseAssertion
      TestAction             Pause                <- think time
  ResultCollector      Simple Data Writer         <- streams to disk, no heap
```

Differences worth knowing:

- **Correlation.** BlazeMeter's exported JMX replays the cookie and token values *as
  recorded* — their docs note the script "will use cookie values from the original
  recording". jmxgen instead finds values a later request sends that an earlier response
  produced, plants an extractor, and rewrites the consumers to `${VARS}`. That is what
  stops a plan from failing on a stale token the second time you run it.
- **Noise.** A recorder keeps what it saw. jmxgen drops static assets, third-party/tracker
  hosts, and first-party telemetry paths by default (all overridable).
- **Load-safety.** No result-storing listeners, timeouts filled in, functional mode off,
  `loops=-1` only with a scheduler — the checklist from your own optimization doc.
- **Verification.** Every plan is checked as XML, as a JMeter tree, and (with `--deep`) by
  JMeter itself before you ever upload it.
- **Account.** BlazeMeter's extension requires a BlazeMeter login; this one requires none
  and writes files locally.

## Proxies — when the target can't be whitelisted

Four places a proxy can live. Pick by how portable it needs to be.

**1. In the plan itself** (travels with the `.jmx` to any runner — local, HyperExecute, CI):

```bash
# any generating command
python3 jmxgen.py from-openapi api.yaml -o api.jmx --proxy corp-proxy.internal:3128
python3 jmxgen.py record pages.txt -o flow.jmx --proxy corp-proxy.internal:3128 --proxy-auth svc:s3cr3t

# or inject into a plan you already have
python3 jmxgen.py optimize old.jmx -o out.jmx --proxy corp-proxy.internal:3128
```

That writes `HTTPSampler.proxyHost/proxyPort/proxyScheme/proxyUser/proxyPass` onto **HTTP
Request Defaults** (creating it if the plan has none), so every sampler inherits it. The
same flag also routes jmxgen's own authoring traffic — the pages it probes and the browser
it records with — so it works when the target is only reachable through the proxy.

Don't hardcode the password. Use a JMeter property and pass it at run time:

```bash
python3 jmxgen.py optimize old.jmx -o out.jmx --proxy p.internal:3128 \
        --proxy-auth 'svc:${__P(proxy.pass)}'
jmeter -n -t out.jmx -Jproxy.pass=$PROXY_PASS -l results.csv
```

**2. At run time, no file changes** — best when the proxy differs per environment:

```bash
jmeter -n -t plan.jmx -l results.csv \
       -H corp-proxy.internal -P 3128 -u svc -a "$PROXY_PASS" \
       -N "localhost|127.0.0.1|*.internal"
```

`-N` (non-proxy hosts) exists **only** here — there is no JMX property for it, so if some
hosts must bypass the proxy, this is the layer to use.

**3. JVM level** — needed for JSR223/Groovy code, JDBC drivers, and libraries that don't go
through JMeter's HTTP samplers:

```bash
export JVM_ARGS="-Dhttp.proxyHost=corp-proxy.internal -Dhttp.proxyPort=3128 \
                 -Dhttps.proxyHost=corp-proxy.internal -Dhttps.proxyPort=3128 \
                 -Dhttp.nonProxyHosts=localhost|*.internal"
jmeter -n -t plan.jmx -l results.csv
```

(or the same `-D` lines in `system.properties`). Note these do **not** override a proxy set
on the samplers — plan-level settings win for HTTP requests.

**4. Browser (WebDriver) plans** — the proxy belongs in the Chrome Driver Config, not the
HTTP samplers. `--proxy` sets `WebDriverConfig.proxy_type=MANUAL` with the host/port on both
HTTP and HTTPS.

**On HyperExecute / TestMu specifically:** a forward proxy is usually the wrong tool for
reaching a private endpoint. The platform's tunnel is the supported route — it gives the
runner access to your network without anyone whitelisting the grid's egress IPs. Check the
tunnel option in your HyperExecute YAML; use a proxy only for an outbound corporate proxy
the runner itself must traverse.

## Importing a plan you already have

```bash
python3 jmxgen.py import-jmx existing.jmx --spec existing.spec.yaml -o rebuilt.jmx
```

Reverses a `.jmx` back into an editable spec: thread groups, transactions, samplers,
headers, extractors, assertions and timers become YAML. Anything not modelled is kept
verbatim as a `type: raw` step, so nothing is lost. This is the migration path in — from
BlazeMeter, from a proxy recording, from whatever the customer has today — and it feeds
the console's editing view.

## Repairing an existing plan

```bash
python3 jmxgen.py optimize big.jmx -o slim.jmx \
    --drop-third-party --drop-static --cap-parallel 6 --dedupe-headers
```

Works even on plans that are not valid XML (it sanitizes first). It can:

- replace binary / gzipped request bodies pasted into `Argument.value` and strip illegal
  XML character references — the file becomes standard XML afterwards
- drop third-party and tracker domains (`--keep-domains a.com,b.com` to be explicit)
- drop static assets (js/css/images/fonts)
- delete disabled elements (they still cost heap) and remove heavy listeners
- enable and set the Parallel Controller cap (`--cap-parallel N`) — without
  `LIMIT_MAX_THREAD_NUMBER` the max value is ignored and fan-out is unbounded
- fill in missing connect/response timeouts
- hoist headers common to every sampler into one plan-level Header Manager
- empty controllers left behind are removed, and `--max-samplers` hard-caps the size

Real run against the 36 MB plan in this folder:

```
$ python3 jmxgen.py optimize samples/sp_idp_com_add_connect_and_response.jmx -o idp_clean.jmx \
      --drop-third-party --drop-static --cap-parallel 6 --dedupe-headers --deep
  fixed  197 binary request body(ies), 54531 illegal XML char refs (file is now standard XML)
  dropped 5651 third-party/tracker requests, 753 disabled elements
  kept    domains: idp.com (of 60 seen)
  result  6205 -> 554 samplers, 36.6 MB -> 3.3 MB
  .  JMeter loaded the tree successfully (deep check)
  VALID - ready to run
```

## Validity checking

```bash
python3 jmxgen.py verify plan.jmx          # structure + semantics
python3 jmxgen.py verify plan.jmx --deep   # ...plus: make JMeter itself load the tree
python3 jmxgen.py validate plan.jmx        # heap/CPU performance lint
```

`verify` checks: well-formed XML; the strict element/`hashTree` pairing JMeter requires
(the #1 reason a hand-edited plan fails to open); a TestPlan, at least one thread group
and one sampler exist; thread counts are numeric; scheduler-vs-duration and `loops=-1`
consistency; CSV/data files referenced actually exist; `${VARS}` used but never defined;
and which plugin elements the runner must have installed. It exits non-zero on failure,
so it drops straight into CI.

`--deep` copies the plan with every thread group disabled and has real JMeter
deserialize it — nothing is executed, but you find out for certain whether the runner
can load every element (missing plugins included).

Example on an existing plan in this folder:

```
$ python3 jmxgen.py verify samples/SP_idp_com_Load_supressed.jmx --deep
  X  not well-formed XML: reference to invalid character number: line 9204, column 52
     hint: a control character is embedded in an element value ...
  .  JMeter loaded the tree successfully (deep check)
  LOADS IN JMETER, but not standard-XML valid - no other XML tool will read it
```

## Excel input

`template` writes a workbook with three sheets: **steps**, **config**, and **help**.

**steps** — one row per request, top to bottom:

| column | meaning |
|---|---|
| `transaction` | consecutive rows sharing a value are wrapped in one Transaction Controller |
| `name` | sampler label in the report |
| `method` | GET / POST / PUT / DELETE / PATCH |
| `url` | full URL, or a path like `/api/login` (paths use `base_url` from config) |
| `headers` | `Name: value; Name2: value2` |
| `params` | `a=1; b=2` |
| `body` | raw body — JSON, XML, anything; `${VAR}` works |
| `extract` | `TOKEN=json:$.token; SID=regex:sid=([^;]+); C=boundary:left\|right` |
| `assert` | `code=200; body contains email; body matches ^\{.*\}$` |
| `think_time` | `1000` or `500-1500` (random range), ms |
| `enabled` | `no` / `false` / `0` skips the row |
| `thread_group` | rows sharing a value land in the same Thread Group |

**config** — key/value rows: `name`, `platform`, `base_url` (or `protocol`/`domain`/`port`),
`threads`, `ramp_up`, `duration`, `loops`, `connect_timeout`, `response_timeout`,
`results_file`, `header.<Name>`, `var.<NAME>`, `csv.file`, `csv.variables`.

A plain `.csv` with the same step columns works too — `template out.csv` writes that shape.

## URL input

```bash
python3 jmxgen.py from-url https://shop.example.com --depth 1 --max-pages 8 --spec shop.yaml
```

Fetches the page, then follows same-domain links to `--depth`. For each page it authors a
GET with a 200 assertion, and for each `<form>` a matching POST/GET carrying every field.
Hidden fields (CSRF, VIEWSTATE) become **boundary extractors** on the page GET and are fed
into the submit, so the flow actually works against a real app. Login-ish fields become
`${USERNAME}` / `${PASSWORD}` variables you fill in at the top of the spec. Use
`--no-links` for a single page.

It only reads what a browser would read — no authenticated area is reachable without
credentials, so for logged-in journeys record a HAR and use `from-har`, or list the
steps in Excel.

## Spec reference

```yaml
name: My API Load Test
platform: hyperexecute        # local | hyperexecute | testmu, or a dict to override
variables: {BASE_HOST: api.example.com}
defaults:                     # HTTP Request Defaults
  protocol: https
  domain: ${BASE_HOST}
  connect_timeout: 5000
  response_timeout: 30000
headers: {Content-Type: application/json}
cookies: true                 # or {clear_each_iteration: false}
cache: false
csv:
  - file: users.csv
    variables: [username, password]
results_file: results.csv     # defaults to the platform profile

thread_groups:
  - name: Load
    threads: 50
    ramp_up: 60
    duration: 600             # present => scheduler on, loops become -1 (time-boxed)
    # loops: 1                # use instead of duration for a fixed number of passes
    csv: [...]                # thread-group-scoped CSV / headers / variables also work
    steps:
      - transaction: Login and fetch profile      # groups children into one timed txn
        steps:
          - name: POST /login
            method: POST
            path: /login
            body: {user: "${username}", pass: "${password}"}   # dict => JSON raw body
            headers: {Authorization: "Bearer ${TOKEN}"}
            extract:
              - {type: json,     var: TOKEN, query: $.token}
              - {type: regex,    var: SID,   query: 'sid=([^;]+)'}
              - {type: boundary, var: CSRF,  left: 'name="csrf" value="', right: '"'}
            assert:
              - {field: code, match: equals,   pattern: "200"}
              - {field: body, match: contains, pattern: email}
            think_time: {min: 500, max: 1500}     # or think_time: 1000
```

### Client certificates (mutual TLS)

```yaml
tls:
  keystore: client.p12
  password: changeit           # a literal - see below
  type: PKCS12
  truststore: truststore.jks
  truststore_password: changeit
  alias_variable: CERT_ALIAS   # optional: a different client identity per thread
```

`build` emits a **system.properties** next to the plan, because JMeter reads the
certificate from JVM system properties — the `.jmx` cannot carry them:

```bash
jmxgen build spec.yaml -o plan.jmx
jmeter -n -t plan.jmx -S system.properties -l r.jtl
```

`-S`, not `-p`. `-p` loads *JMeter* properties and the JVM never sees these, so
the handshake fails with a confusing socket error. On HyperExecute, upload
`system.properties` with the plan and add `-S system.properties` to the args.

The password must be a literal: `system.properties` is read by the JVM as plain
`java.util.Properties`, so `${__P(...)}` is never expanded and would be sent
verbatim. jmxgen rejects that at build time rather than letting it fail at run
time. To keep the password out of the file, leave it blank and pass
`-Djavax.net.ssl.keyStorePassword=...` on the command line.

### Workload models — `model:` on a thread group

```yaml
thread_groups:
- {name: Steady,  model: closed, threads: 200, ramp_up: 60, duration: 600}   # default
- {name: Hold,    model: concurrency, threads: 200, ramp_up: 60, duration: 600}
- {name: Orders,  model: arrivals, rate: 50, unit: S, ramp_up: 30, duration: 300,
   max_concurrency: 500}
```

`closed` is a plain JMeter Thread Group: N users, each looping. The rate you get
out depends on how fast the app responds — so when the app slows down, the load
you are applying quietly drops, which hides the problem you were testing for.

`arrivals` states the rate instead: 50 iterations start every second whether or
not the previous ones finished. This is how capacity targets are normally
written ("500 orders per second"), and it is the model that exposes queueing.
`max_concurrency` caps the threads so a struggling target cannot open unbounded
connections.

`concurrency` holds N users concurrently and lets JMeter manage the thread pool.

All three honour `-Jrate=`, `-Jthreads=`, `-Jramp=` and `-Jduration=` at run time.
The last two models need **jmeter-plugins-casutg**; `verify` names the jar, and
on HyperExecute you can upload it alongside the plan.

### Element coverage (Phase 0)

**Assertions** — `assert:` on any sampler:

```yaml
assert:
  - {field: code, match: equals, pattern: "200"}      # response code / body / headers
  - {type: json, query: "$.data.id", pattern: "42"}   # JSON Assertion
  - {type: duration, max_ms: 2000}                    # Duration Assertion
  - {type: size, op: ">", bytes: 100}                 # Size Assertion
```

**Extractors** — `extract:`:

```yaml
extract:
  - {type: json,     var: TOKEN, query: $.data.token}
  - {type: regex,    var: SID,   query: 'sid=([^;]+)'}
  - {type: boundary, var: CSRF,  left: 'value="', right: '"'}
  - {type: css,      var: TITLE, query: "title"}          # HTML
  - {type: xpath2,   var: NAME,  query: "//item/name/text()"}   # XML only
```

`xpath2` needs well-formed XML — on HTML it returns the default. Use `css` for HTML.

**Timers** — `think_time:`:

```yaml
think_time: 1000                                   # constant
think_time: {min: 500, max: 1500}                  # uniform random
think_time: {type: gaussian, constant: 300, range: 100}
think_time: {type: poisson,  constant: 300, range: 100}
think_time: {type: throughput, per_minute: 600}    # paces the whole test
think_time: {type: sync, users: 50}                # rendezvous
```

**Controllers** — step forms with nested `steps:`:

```yaml
- transaction: Checkout      # Transaction Controller
- if: "${__jexl3(${code} == 200)}"
- while: "${__jexl3(${done} != 'yes')}"
- switch: "${PATH}"
- interleave: true
- random: true
- throughput: 50             # only 50% of users run this branch
- runtime: 30                # run this branch for 30s
- loop: 5
- once: true
- pause: 2000                # Flow Control Action
```

**Samplers** — `type:`: `http` (default), `jdbc`, `graphql`, `jsr223`, `webdriver`, `raw`.

```yaml
- type: jdbc
  pool: orders_db
  query: "select id from orders where status = ?"
  arguments: "open"
  argument_types: VARCHAR
  variables: [ORDER_ID]

- type: graphql
  path: /graphql
  operation: GetUser
  query: "query GetUser($id: ID!) { user(id: $id) { name } }"
  variables: {id: "42"}
```

**Plan-level config:**

```yaml
http_auth:                                    # HTTP Authorization Manager
  - {url: "https://api.example.com", username: svc, password: "${PW}", mechanism: BASIC}
jdbc:                                         # JDBC Connection Configuration
  - {name: orders_db, driver: org.postgresql.Driver,
     url: "jdbc:postgresql://db/orders", username: u, password: p, pool_max: 10}
backend_listener:                             # live metrics during the run
  {url: "http://influx:8086/write?db=jmeter", application: checkout-api}
auth:                                         # log in once, share the token
  login: {method: POST, path: /oauth/token, body: {...},
          extract: {type: json, query: $.access_token}}
```

`auth:` emits a **setUp Thread Group** that authenticates once and publishes the token as
a JMeter property; every thread then sends `Authorization: Bearer ${__P(AUTH_TOKEN)}`.
Shorthand: `--login "POST /oauth/token" --login-body '{...}' --login-token '$.access_token'`.

### Parameterization

Replace values a recording captured with CSV columns:

```bash
python3 jmxgen.py from-har session.har -o plan.jmx --suggest-parameters
  bob@example.com    looks like a email  ->  --parameterize 'bob@example.com=email'
  +1 555 0100        looks like a phone  ->  --parameterize '+1 555 0100=phone'

python3 jmxgen.py from-har session.har -o plan.jmx \
    --parameterize 'bob@example.com=email' --csv users.csv:email,phone
```

### Correlation: rules, not guesses

Dynamic values are matched against **rule packs** first, and only fall back to heuristics.
Built-in rules cover ASP.NET (`__VIEWSTATE`, `__EVENTVALIDATION`, `__VIEWSTATEGENERATOR`),
JSF `ViewState`, Rails `authenticity_token`, Django `csrfmiddlewaretoken`, Laravel `_token`,
Spring `_csrf`, SAML (`SAMLResponse`, `RelayState`), OAuth (`code`, `state`, `nonce`),
bearer/JWT tokens and session ids.

Correlation is **header-aware** — values that come back in `Location` or `Set-Cookie`
(the normal path for OAuth codes and session ids) are found and extracted with a
header-scoped regex, not just body content.

Every correlation is reported with its provenance, so it can be reviewed rather than
trusted blindly:

```
  correlated 3 value(s):
    ${VIEWSTATE}             asp.net-viewstate  high      from body     GET /Default.aspx -> POST /Default.aspx
    ${AUTHENTICITY_TOKEN}    rails-csrf         high      from body     GET /login -> POST /session
    ${CODE}                  oauth-code         high      from headers  GET /authorize -> POST /token
```

Anything that matched no rule is flagged `low` confidence and called out. Add your own
rules with `--rules myrules.yaml`, and write the full provenance to JSON with
`--correlation-report report.json`:

```yaml
rules:
  - name: acme-session
    fields: ["^ACME_SESSION$"]
    extract: {type: boundary, left: 'name="ACME_SESSION" value="', right: '"'}
    confidence: high
```

### Replay-validate: prove the plan works before you spend load minutes

A plan can be perfectly valid XML, load cleanly in JMeter, and still fail on its first
request because a correlation did not match. `replay` runs it **once as a single user**
and tells you:

```bash
python3 jmxgen.py replay plan.jmx          # or add --replay to any generating command
```

```
== replay plan.jmx ==
  ran 3 sampler(s) as a single user
  !  GET /v2/orders    sent NOT_FOUND - a correlation did not resolve
  X  GET /v2/orders    401  Test failed: code expected to equal 200
  FAIL - 2 failing sampler(s), 1 with unresolved variables
```

versus a healthy plan:

```
  ran 3 sampler(s) as a single user
  PASS - every request succeeded and every variable resolved
```

It rewrites the plan to 1 thread / 1 loop / no scheduler, records full request headers,
and flags any request that went out carrying `NOT_FOUND` or an unsubstituted `${VAR}` —
naming the sampler and the variables it depends on. Non-zero exit code, so it gates CI.

### Realistic pacing

```bash
python3 jmxgen.py from-har session.har -o plan.jmx --real-think-time
```

Uses the gaps the real user left between requests. Sub-300ms gaps are ignored — those are
parallel resource loads, not a human pausing.

Other step forms:

- `params: {k: v}` instead of `body:` for form/query parameters
- `- if: "${__jexl3(${code} == 200)}"` with nested `steps:` → If Controller
- `- loop: 5` / `- once: true` with nested `steps:` → Loop / Once Only Controller
- `- {type: jsr223, script: "...", language: groovy}` → JSR223 sampler (compile-cache on)
- `- {type: raw, xml: "<...>"}` → paste any JMX element verbatim

## Browser (WebDriver) plans

Set `webdriver:` at the top level and use `type: webdriver` steps. Actions compile to a
Groovy WebDriver Sampler script with explicit waits and proper sample start/end and
failure handling — or supply your own `script:` instead.

```yaml
webdriver: {headless: true}
...
      - type: webdriver
        name: Login
        actions:
          - {do: open, url: "${BASE_URL}"}
          - {do: wait_for, xpath: "//input[@name='username']"}
          - {do: type, xpath: "//input[@name='username']", text: "${USERNAME}"}
          - {do: click, xpath: "//button[@type='submit']"}
          - {do: assert_text, text: Dashboard}
          - {do: sleep, ms: 500}
          - {do: script, code: "WDS.log.info(WDS.browser.getTitle())"}
```

These plans need the **jpgc WebDriver Set** plugin on the runner (already present on
HyperExecute browser images). With `platform: hyperexecute` the chromedriver and Chrome
binary paths are filled in for you; override with
`webdriver: {driver_path: ..., binary_path: ...}`.

## Running

```bash
# local
jmeter -n -t plan.jmx -l results.jtl -e -o reports/

# HyperExecute / TestMu — set heap via env, never in user.properties
HEAP="-Xms1g -Xmx4g" jmeter -n -t plan.jmx -l results.csv
```

## Tests

```bash
./run_tests.sh          # every authoring path -> verify -> JMeter loads the tree
./run_tests.sh --live   # ...plus real runs against local targets
```

Builds its own fixtures, exercises 12 authoring paths, checks correlation rules fire,
think times are derived, round-trip and optimize work, JMeter loads every generated plan,
and — with `--live` — that an auth token actually reaches the request threads and that a
deliberately broken correlation is diagnosed. Exit code is the failure count, so it gates CI.

## Where this sits next to the ecosystem

Existing options, and why they didn't cover the ask on their own:

| Tool | What it does | Gap |
|---|---|---|
| BlazeMeter Chrome recorder | records a browser journey to `.jmx` | browser-only; keeps every tracker; no correlation on export |
| Taurus (`bzt`) | YAML → runs JMeter, can dump the `.jmx` | a runner first; no Excel/OpenAPI/Postman authoring, no repair |
| `swagger-codegen -l jmeter` | OpenAPI → `.jmx` | Java toolchain; no auth/example synthesis, one shape only |
| jmeter-java-dsl | Java code → `.jmx` | you write Java; not for a spreadsheet-driven team |
| JMeter's own HTTP(S) proxy recorder | records through a proxy | manual filtering and correlation afterwards |

`jmxgen` is deliberately one stdlib-first Python file: every input listed above lands in
the same spec model, the same optimization defaults, and the same verify gate — and it can
also repair plans that other generators produced.

Plugin elements a generated or repaired plan may need on the runner (jmxgen tells you
which, in `verify`):

- **Parallel Controller** — `com.blazemeter.jmeter.controller.ParallelSampler`
  (bzm - Parallel Controller, in the Plugins Manager)
- **WebDriver Set** — `com.googlecode.jmeter.plugins.webdriver.*` for browser plans
