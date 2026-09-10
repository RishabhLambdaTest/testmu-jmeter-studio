# Against BlazeMeter

Written for anyone evaluating the two, and for anyone pitching ours. It aims to
be accurate rather than flattering, so the gaps are listed with the same care as
the wins. The first question after any demo is what the thing cannot do.

## The short of it

BlazeMeter is a platform you send your test to. Recording, correlation, data,
execution and reporting all live inside one SaaS product, and your session,
including whatever tokens and personal data the recording caught, is uploaded to
it.

Ours is a test you keep. A Chrome extension authors a plain JMeter `.jmx` on your
own machine, from whatever you already have, and HyperExecute runs it on demand.
Nothing in the chain is proprietary. The output is a file JMeter has been able to
run for twenty years, and it runs on your laptop, in your CI, on HyperExecute or,
if you want, on BlazeMeter.

| | BlazeMeter | JMeter Studio + HyperExecute |
|---|---|---|
| Where the recording goes | uploaded to the vendor | stays in your browser |
| What you end up owning | a test inside the platform | a `.jmx` file |
| Install to first plan | account, login, workspace | unzip, Load unpacked, about 5 minutes |
| Ways in | recorder, JMX upload, Taurus | recorder plus six more: cURL, OpenAPI, Postman, Excel, URL list, existing JMX |
| Lock-in | the platform is the test | none; the `.jmx` runs anywhere |

## What customers actually ask

These are the real evaluation criteria. Everything else is packaging.

| The question | What it really is | Where we stand |
|---|---|---|
| "I have no spec and no script, where do I start?" | authoring from nothing | eight sources: recording, cURL, OpenAPI, Postman, Excel, a URL list, an existing `.jmx`, or an automation session that already ran |
| "My login works once, then everything 401s" | token correlation | automatic, and shown: the rule, a confidence, the exact hop |
| "All 500 users log in as the same person" | parameterisation | CSV test data per user, split across engines at run time |
| "My setUp step extracts a token nobody else can see" | properties against variables | the login publishes with `props.put`, read back as `${__P()}` |
| "The report is 4,000 lines of URLs" | transactions | name one while recording; it becomes a Transaction Controller |
| "How do I know a 200 wasn't an error page?" | assertions | Assert 200 and Assert text, added on the request in front of you |
| "Will this behave like real traffic?" | open against closed workload | closed thread groups, and arrival-rate groups |
| "How do I know it works before I spend a run?" | pre-flight | single-user validate: per-request codes, plus any `${VAR}` that never resolved |
| "Where do the credentials go?" | secrets | nowhere; the form talks to LambdaTest, with no server in between |
| "Our APIs need client certificates" | mTLS | keystore and JVM properties generated, and validated at build time |
| "Can I check the UI didn't break too?" | protocol and browser | one recording emits a `.jmx` and a Playwright test |
| "Can I take it with me?" | lock-in | it is a `.jmx`, and it exports Taurus YAML |

## Feature by feature

### Recording

| | BlazeMeter | JMeter Studio |
|---|---|---|
| Chrome recorder, your own profile, SSO and VPN | yes | yes |
| Response bodies captured | yes | yes, through `chrome.debugger`, the only API that can |
| Mobile emulation while recording | yes | yes, metrics and user agent together |
| Annotate while recording | limited | transactions, assertions, extractors, pauses, drops, and requests that never happened |
| An hour-long session | streamed to their cloud as you record | written to disk as you record |
| Survives a browser restart | it is on their server | yes, and it is offered back when you return |
| CORS preflights | filtered | filtered |
| The recording leaves your machine | yes, uploaded | no |
| What you get out | a test inside the platform | `.jmx`, HAR, Taurus YAML and Playwright, downloaded |

### Authoring

| | BlazeMeter | JMeter Studio |
|---|---|---|
| From a recording | yes | yes |
| From cURL, OpenAPI, Postman, Excel or a URL list | no | yes |
| Import and clean an existing `.jmx` | upload only | import to an editable spec and re-emit clean; `optimize` repairs bloated plans |
| Correlation | through the JMeter Correlation Recorder plugin | built in, with provenance for every value |
| Static validation of the result | — | validity, loadability, missing files, undefined variables, and a heap and CPU lint |
| Single-user pre-flight | debug run | replay with per-request codes and unresolved variables |

### Execution

| | BlazeMeter | HyperExecute |
|---|---|---|
| Distributed load, multiple regions | yes | yes |
| Split CSV across engines | yes | yes |
| Override users, ramp and duration at run time | yes | yes; the form overrides the plan |
| Upload plugin jars with the plan | yes | yes |
| Non-JMeter engines (Gatling, Locust, k6) | yes | JMeter is the engine here; Taurus export bridges the rest |
| HTML report artifact | yes | yes, in every trigger by default |

### The platform around it

This is where BlazeMeter is genuinely ahead, and it should be said plainly.

| | BlazeMeter | Ours |
|---|---|---|
| Live dashboard during a run | rich, real-time | the HyperExecute job view, plus the JMeter HTML report as an artifact |
| Trends, baselines, run comparison | yes | job history, but no first-class trend analysis |
| Pass/fail thresholds as a product feature | yes | JMeter assertions |
| APM and observability integrations | yes | no |
| Service virtualisation and mock services | yes | no |
| Generated test data as a service | yes | you bring a CSV |
| Scheduled runs and API monitoring | yes | no |
| Shared workspaces, roles, team run history | yes | HyperExecute projects |

## Where we are stronger

**The recording never leaves the machine.** A load-test recording of a logged-in
session contains session tokens, personal data and internal hostnames. Ours stays
in the browser, and the only network calls are to your target and, if you choose,
to the HyperExecute API with your own key. For a regulated customer this is not a
feature. It is the difference between a purchase and a security review that never
ends.

**Long sessions, without sending anything anywhere.** This is the same problem
solved two ways. BlazeMeter records into their cloud, so the browser is only a
buffer and length is their storage problem. We write to disk in the browser,
sized against the storage the browser grants, which is measured in gigabytes.
Neither has a cap. Ours costs you nothing but disk, and the session survives
both the extension's worker being evicted and Chrome being closed.

What keeps that cheap is being selective about bytes rather than requests. Every
request is stored; for assets that means their URL, method and type, because a
font's content cannot be asserted on, correlated or sent by a sampler. Measured
on a real session of 241 requests, 200 of them images: 241 entries and 41 bodies
on disk. A browser-level plan still authors from that same recording.

**Six ways in that a recorder does not have.** Most teams do not start from a
browser session. They start from a Postman collection somebody maintains, an
OpenAPI spec in the repo, or a curl command pasted into a ticket. A
recorder-only product makes them produce a recording first.

**Correlation you can audit.** Auto-correlation that quietly guesses wrong is
worse than none, because the plan still runs and the numbers mean nothing. Every
correlated value carries the rule that matched it, a confidence, and the hop it
travels, so a reviewer can disagree with it.

**Proof before spend.** Validating at one user catches the broken extractor
before five hundred users find it. A failed load run costs a VU-hour bill and an
afternoon.

**One recording, two artifacts.** The protocol plan scales; the Playwright test
proves the journey still works. Most teams maintain those separately, from two
recordings that drift apart.

**Nothing to install.** No account, no agent, no Python, no JMeter on the laptop.
Unzip, load, author, run. The engine ships inside the extension and runs in
WebAssembly.

**No lock-in, in either direction.** The output is a `.jmx`. It runs on
HyperExecute, on a laptop, in Jenkins, and through the Taurus export on
BlazeMeter too. A customer can leave, which is exactly why they will try it.

## Where BlazeMeter is ahead

Say these before the customer finds them.

*Reporting depth.* Live dashboards, trends, baseline comparison, share links. We
produce the standard JMeter HTML report as a job artifact. For a team whose
weekly ritual is a trend chart, that is a real gap.

*Pass/fail gates as a product feature.* BlazeMeter has thresholds in the UI. We
have JMeter assertions and a CI exit code.

*The surrounding platform.* Mock services, test-data generation, API monitoring,
scheduled runs, APM integrations.

*Multi-engine support.* Gatling, Locust and k6 natively. Taurus export narrows
the gap without closing it.

*A recorder that has met the whole internet.* Theirs has been in the store for
years and has seen every authentication scheme and single-page framework there
is. Ours is tested against real sites and handles what those tests found, but
the tail is long and we are early in it.

None of these sit in the authoring path, which is where the customer's pain
actually is. They start to matter in the second month, and a pitch that pretends
otherwise loses the second meeting.

**The one to close first is trends.** Reporting depth is a large surface, but
the part a load-testing team touches every week is the comparison against last
week. Everything else on this list can wait behind it.

## The pitch, in three sentences

Recording a load test should not mean uploading your logged-in session to a
vendor, and the thing you get back should be a file you own. JMeter Studio
authors a real JMeter plan, from a recording or from the curl command, OpenAPI
spec, Postman collection or spreadsheet you already have, entirely inside Chrome,
with dynamic tokens correlated and shown, and validates it at one user before you
spend a run. HyperExecute then runs it across as many machines and regions as you
need, and the plan still runs anywhere else you choose to take it.

## Migrating from BlazeMeter

| What you have there | What to do here |
|---|---|
| A JMX exported from BlazeMeter | *Source → Existing .jmx*, or `jmxgen import-jmx`; clean it, then run it |
| A Taurus YAML | keep it. The export round-trips, and the `.jmx` is what runs |
| A BlazeMeter recording (HAR) | *Source → Recording (HAR)*; correlation runs on it here |
| Shared CSV test data | drop it in Test data, and HyperExecute splits it across engines |
| Threshold-based pass/fail | JMeter assertions in the plan, plus the CI exit code |
