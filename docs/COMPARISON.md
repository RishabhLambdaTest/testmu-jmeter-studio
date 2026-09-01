# HyperExecute + TestMu Recorder vs BlazeMeter

For anyone evaluating the two, and for anyone pitching ours. It is written to be
accurate rather than flattering: the gaps are listed with the same detail as the
wins, because the first customer question after a demo is always *"and what
can't it do?"*

---

## The short version

BlazeMeter is a **platform you send your test to**. Recording, correlation,
data, execution and reporting all live inside one SaaS product, and your session —
including whatever tokens and PII the recording captured — is uploaded to it.

Ours is a **test you keep**. A Chrome extension authors a plain JMeter `.jmx` on
your own machine, from whatever you already have, and HyperExecute runs it on
demand. There is no proprietary artifact anywhere in the chain: the output is a
file JMeter has been able to run for twenty years, and it runs equally well on
your laptop, in your CI, on HyperExecute — or, if you want, on BlazeMeter.

| | BlazeMeter | TestMu Recorder + HyperExecute |
|---|---|---|
| Where the recording goes | uploaded to the vendor | stays in your browser |
| What you end up owning | a test inside the platform | a `.jmx` file |
| Install to first plan | account, login, workspace | unzip, *Load unpacked*, ~5 min |
| Ways in | recorder, JMX upload, Taurus | recorder + 6 more (cURL, OpenAPI, Postman, Excel, URL list, existing JMX) |
| Lock-in | the platform is the test | none — the `.jmx` runs anywhere |

---

## What a customer actually asks when they start with JMeter

This list is the real evaluation criteria. Everything else is packaging.

| The question they ask | What it really means | Where we stand |
|---|---|---|
| "I have no spec and no script — where do I even start?" | authoring from nothing | **7 sources.** Recording, cURL, OpenAPI, Postman, Excel, a URL list, an existing `.jmx` |
| "My login works once, then everything 401s" | dynamic token correlation | **automatic**, and *shown*: the rule, the confidence, and the exact request-to-request hop |
| "All 500 users log in as the same person" | parameterisation | CSV test data, per-user, with split-across-engines on HyperExecute |
| "The token is per-thread and my setUp step can't share it" | properties vs variables | login runs in a setUp Thread Group and publishes with `props.put` / `${__P()}` |
| "The report is 4,000 lines of URLs" | transactions | name a transaction while recording; it becomes a Transaction Controller |
| "How do I know a 200 wasn't an error page?" | assertions | Assert 200 / Assert text, added at record time on the request you are looking at |
| "Will this behave like real traffic?" | open vs closed workload | closed Thread Groups **and** arrival-rate groups (jpgc casutg) |
| "How do I know the plan works before I spend a load run?" | pre-flight | `Validate (single user)` runs it once and reports codes plus any `${VAR}` that never resolved |
| "Where do the credentials go?" | secrets | nowhere. The access key goes from the form to LambdaTest; no server in between |
| "Our APIs need client certificates" | mTLS | keystore config + the JVM properties, generated and validated at build time |
| "Can I run it in CI?" | automation | the `.jmx` is a file; `jmxgen ship` and the HyperExecute YAML do the rest |
| "Can I still use the browser to check the UI didn't break?" | protocol *and* browser | one recording emits both a `.jmx` and a Playwright test |
| "Can I take it with me?" | lock-in | it is a `.jmx`. Also exports Taurus YAML |

---

## Feature by feature

### Recording

| | BlazeMeter | Ours |
|---|---|---|
| Chrome recorder | yes | yes |
| Records in your own profile / SSO / VPN | yes | yes |
| Response bodies captured | yes | yes (`chrome.debugger` — the only API that can) |
| Mobile emulation while recording | yes | yes — device metrics **and** user agent |
| Block hosts at capture time | yes | yes |
| Annotate *while* recording | limited | transactions, assertions, extractors, pauses, renames, drops, and **manual requests that never happened** |
| Recording leaves your machine | yes, uploaded | **no** |
| Output | JMX / Taurus YAML, in the platform | `.jmx`, HAR, Taurus YAML, Playwright — all downloaded |

### Authoring

| | BlazeMeter | Ours |
|---|---|---|
| From a recording | yes | yes |
| From cURL / OpenAPI / Postman / Excel / URL list | no | **yes** |
| Import and clean an existing `.jmx` | upload only | import → editable spec → re-emit clean; `optimize` repairs bloated plans |
| Correlation | via the JMeter Correlation Recorder plugin | built in, with provenance shown per value |
| Static validation of the result | — | `verify` (well-formed, loadable, missing files, undefined `${VARS}`) and `validate` (heap/CPU lint) |
| Single-user pre-flight | debug run | `Validate (single user)`, with per-request codes and unresolved variables |

### Execution

| | BlazeMeter | HyperExecute |
|---|---|---|
| Distributed load | yes | yes — VUs spread over engines, `max users per engine` |
| Multi-region | yes | yes |
| Split CSV across engines | yes | yes |
| Override users / ramp / duration at run time | yes | yes — the run form overrides the `.jmx` |
| Upload plugin jars alongside the plan | yes | yes |
| Non-JMeter engines (Gatling, Locust, k6) | yes | JMeter is the engine here; Taurus export bridges the rest |
| HTML report artifact | yes | yes — `-e -o report` is in every trigger by default |

### Reporting and the platform around it

This is where BlazeMeter is genuinely ahead, and it should be said plainly.

| | BlazeMeter | Ours |
|---|---|---|
| Live dashboard during the run | rich, real-time | HyperExecute job view + the JMeter HTML report as an artifact |
| Trends across runs, baselines, comparisons | yes | job history; no first-class trend analysis |
| Pass/fail thresholds as a product feature | yes | JMeter assertions only |
| APM / observability integrations | yes | no |
| Service virtualisation / mock services | yes | no |
| Generated test data as a service | yes | you bring a CSV |
| Scheduled runs and API monitoring | yes | no |
| Shared workspaces, roles, run history for a team | yes | HyperExecute projects |

---

## Where we are genuinely better

**1. The recording never leaves the machine.** A load-test recording of a
logged-in session contains session tokens, personal data and internal hostnames.
Ours stays in the browser; the only network calls are to your target and, if you
choose, to the HyperExecute API with your own key. For regulated customers this
is not a feature, it is the difference between a purchase and a security review
that never ends.

**2. Six ways in that a recorder does not have.** Most teams do not start from a
browser session. They start from a Postman collection someone maintains, an
OpenAPI spec in the repo, or a curl command in a ticket. A recorder-only product
makes them produce a recording first.

**3. Correlation you can audit.** Auto-correlation that silently guesses wrong
is worse than none, because the plan runs and the numbers are meaningless. Every
correlated value shows the rule that matched it, a confidence, and the hop it
travels — so a reviewer can disagree with it.

**4. Proof before spend.** `Validate (single user)` catches the broken extractor
at one user rather than at five hundred. A failed load run costs a VU-hour bill
and an afternoon.

**5. One recording, two artifacts.** The protocol plan scales; the Playwright
browser test proves the journey still works. Most teams maintain those
separately, from two different recordings that drift apart.

**6. Nothing to install.** No account, no agent, no Python, no JMeter on the
laptop. Unzip, load, author, run. The engine ships inside the extension and runs
in WebAssembly.

**7. No lock-in, in both directions.** The output is a `.jmx`. It runs on
HyperExecute, on a laptop, in Jenkins — and the Taurus export means it runs on
BlazeMeter too. A customer can leave, which is exactly why they will try it.

---

## Where BlazeMeter is ahead

Say these before the customer finds them.

1. **Reporting depth.** Live dashboards, trends, baseline comparison, share
   links. We produce the standard JMeter HTML report as a job artifact. For a
   team whose weekly ritual is a trend chart, that is a real gap.
2. **Pass/fail gates as a product feature.** BlazeMeter has thresholds in the UI;
   we have JMeter assertions and a CI exit code.
3. **The surrounding platform.** Mock services, test-data generation, API
   monitoring, scheduled runs, APM integrations.
4. **Multi-engine.** Gatling, Locust, k6 natively. Taurus export narrows this,
   but it is not the same as first-class support.
5. **Maturity of the recorder.** BlazeMeter's has been in the store for years and
   has seen every website. Ours is new; the locator ranking and the noise filters
   are good, but they have not met the whole internet yet.

None of these are in the authoring path, which is where the customer's pain
actually is — but they matter after the first month, and a pitch that pretends
otherwise loses the second meeting.

---

## The pitch, in three sentences

*Recording a load test should not mean uploading your logged-in session to a
vendor, and the thing you get back should be a file you own.* TestMu Recorder
authors a real JMeter plan — from a recording, or from the curl command, OpenAPI
spec, Postman collection or spreadsheet you already have — entirely inside
Chrome, with the dynamic tokens correlated and shown, and validates it at one
user before you spend a run. HyperExecute then runs it across as many machines
and regions as you need, and the plan still runs anywhere else you want to take
it.

---

## Migrating from BlazeMeter

| What you have there | What to do here |
|---|---|
| A JMX exported from BlazeMeter | *Source → Existing .jmx*, or `jmxgen import-jmx` — clean it, then run it |
| A Taurus YAML | keep it; `jmxgen to-taurus` round-trips, and the `.jmx` is what runs |
| A BlazeMeter recording (HAR) | *Source → Recording (HAR)* — correlation runs on it here |
| Shared CSV test data | drop it in **Test data**; HyperExecute splits it across engines |
| Threshold-based pass/fail | JMeter assertions in the plan, plus the CI exit code |
