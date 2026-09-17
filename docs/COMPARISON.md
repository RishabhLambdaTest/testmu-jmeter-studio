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
| Ways in | recorder, JMX upload | recorder plus six more: cURL, OpenAPI, Postman, Excel, URL list, a TestMu AI session; an existing JMX is validated |
| Lock-in | the platform is the test | none; the `.jmx` runs anywhere |

## Measured, not claimed

Everything in this section was run on 17 September 2026, not reasoned about.
The method, the inputs and the scoring script are described at the end so the
numbers can be disputed or reproduced.

**What was compared.** BlazeMeter's HAR converter (`converter.blazemeter.com`,
which its own log names `HARJMXConverter`) against JMeter Studio, on the same
input, three times over. This is their free converter, which is what a HAR from
a browser goes through. Their paid Proxy Recorder applies SmartJMX templates
during recording and was not part of these runs; treat the correlation numbers
as being about the converter, not about every BlazeMeter product.

### 1. A HAR with a published answer key

Ten dynamic values, each planted deliberately: a JWT, a CSRF token in a hidden
input, a session cookie, an order id used in a path, an OAuth code in a
`Location` header, a nonce in a JSON body, a token passing from a response
header to a request header, a ViewState URL-encoded in a form body, a cart id
from inside a JSON array, and one value that repeats everywhere but is *not*
dynamic and must be left alone.

A case counts as correlated only when the recorded value no longer appears
literally in any later request, a `${VAR}` stands in its place, an extractor in
the plan defines that variable, and the extractor's expression really finds the
value when run against the recorded response. Claims in the plan are ignored;
the XML is read.

| | JMeter Studio | BlazeMeter converter |
|---|---|---|
| Correlated | **8 of 8** | 0 of 8 |
| Cookie left to the cookie manager | yes | yes |
| Static value wrongly correlated | no | no |

Their one non-literal case is worse than a miss: the OAuth code was both
followed as a redirect *and* replayed as a stale target, so the plan sends an
expired code as well as following the fresh one.

### 2. The same two plans run against a live server

A local shop that issues a fresh CSRF token, session, JWT, nonce, cart id and
order id on every run, and answers 4xx with the reason whenever a stale one
arrives. Both plans were run by real JMeter 5.6.3, twice: once against the app
as recorded, and once against a "drift" build where the login form gained an
attribute and an order status string changed - the kind of release that breaks
brittle extractors.

| | JMeter Studio | BlazeMeter converter |
|---|---|---|
| As recorded | **15 of 15 samples passed** | 1 of 8 passed |
| After the app drifted | **15 of 15 passed** | 1 of 8 passed |
| Failures | none | 6 x 401 stale bearer, 1 x 403 stale CSRF |

### 3. A real TestMu AI session, converted by both

Session `74fa7fd2`, fetched as `network.har`: 157 entries across 19 hosts, and -
this is the important part - **no request or response bodies at all**, because
that is what the session log carries.

| | JMeter Studio | BlazeMeter converter |
|---|---|---|
| Plan size | 83 KB | 844 KB |
| Samplers | 21 | 157 |
| Third-party hosts in the plan | 0 | 45 samplers across 18 other hosts |
| Static assets as samplers | 0 | 99 |
| Transaction controllers | 10 | 0 |
| Assertions | 19 | 0 |
| Thread group | parameterised, scheduled | 1 user, no ramp, no scheduler |
| `User-Agent` hard-coded | 0 | all 157 |
| Server-issued values left hard-coded | 1 | 8 |

**Be honest about this one:** with no bodies in the HAR, neither tool can
correlate anything, and ours extracted nothing either. The difference is what
each does about it. Ours says so, at error level, before you spend a run.
Theirs returns a 157-sampler plan that looks finished and replays eight expired
values.

### 4. Replay, which their converter has no equivalent for

A plan with its correlations deliberately removed was replayed inside the
browser against the live mock: 7 of 8 requests failed. Replay traced each
failed value back through the recording and offered 8 correlations; applying
them took the same plan to 8 of 8 in the browser and **15 of 15 in real
JMeter**.

### How to reproduce

The scripts are in [comparison/](comparison/). The synthetic HAR and its answer key are generated by `make_har.py`; `score.py`
does the scoring described above; `mock_shop.py` is the live server, with a
`drift` argument for the second build. All three are written to be read by
someone checking the claims. BlazeMeter's side went through their public
converter API (`upload` -> `convert` -> `status`). Only the synthetic HAR and the
one session HAR were sent to them.

## What customers actually ask

These are the real evaluation criteria. Everything else is packaging.

| The question | What it really is | Where we stand |
|---|---|---|
| "I have no spec and no script, where do I start?" | authoring from nothing | seven sources: recording, cURL, OpenAPI, Postman, Excel, a URL list, or an automation session that already ran; an existing `.jmx` is validated rather than converted |
| "My login works once, then everything 401s" | token correlation | automatic, and shown: the rule, a confidence, the exact hop |
| "All 500 users log in as the same person" | parameterisation | CSV test data per user, split across engines at run time |
| "My setUp step extracts a token nobody else can see" | properties against variables | the login publishes with `props.put`, read back as `${__P()}` |
| "The report is 4,000 lines of URLs" | transactions | name one while recording; it becomes a Transaction Controller |
| "How do I know a 200 wasn't an error page?" | assertions | Assert 200 and Assert text, added on the request in front of you |
| "Will this behave like real traffic?" | open against closed workload | closed thread groups, and arrival-rate groups |
| "How do I know it works before I spend a run?" | pre-flight | every plan is checked as it is built, and *Validate .jmx* checks an existing one's XML with line and column |
| "Where do the credentials go?" | secrets | nowhere; the studio uses your TestMu AI sign-in and stores no key |
| "Our APIs need client certificates" | mTLS | keystore and JVM properties generated, and validated at build time |
| "Can I check the UI didn't break too?" | protocol and browser | one recording emits a `.jmx` and a Playwright test |
| "Can I take it with me?" | lock-in | it is a `.jmx` |

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
| What you get out | a test inside the platform | `.jmx`, HAR and Playwright, downloaded |

### Authoring

| | BlazeMeter | JMeter Studio |
|---|---|---|
| From a recording | yes | yes |
| From cURL, OpenAPI, Postman, Excel or a URL list | no | yes |
| An existing `.jmx` | upload only | *Validate .jmx* reports encoding, illegal characters and where the XML breaks, by line and column |
| Correlation | none in the HAR converter; templates in the paid Proxy Recorder | built in, with provenance for every value: **8 of 8** planted cases against their 0 of 8 |
| Static validation of the result | — | validity, loadability, missing files, undefined variables, and a heap and CPU lint |
| Single-user pre-flight | debug run, in their cloud | *Replay* runs the plan in the browser, applies its own
extractors and assertions, and proposes the correlations the failures needed |

### Execution

| | BlazeMeter | HyperExecute |
|---|---|---|
| Distributed load, multiple regions | yes | yes |
| Split CSV across engines | yes | yes |
| Override users, ramp and duration at run time | yes | yes; the form overrides the plan |
| Upload plugin jars with the plan | yes | yes |
| Non-JMeter engines | Gatling, Locust and k6 natively | **k6 as well as JMeter**: the same plan is emitted as a k6 script and its HyperExecute job. Gatling and Locust, no |
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

## Against the k6 generators

We now emit k6 as well as JMeter, so the comparison is no longer only with
BlazeMeter. What the other generators produce, read from their own source and
fixtures rather than their marketing:

| | har-to-k6 (Grafana's) | postman-to-k6 | openapi-generator k6 | k6 Studio | Ours |
|---|---|---|---|---|---|
| Load options | `export const options = {}`, empty | only if asked | none | generator option | scenario, ramp, duration, from the plan |
| Thresholds | none | none | none | generator option | **always** |
| Groups | only if the HAR has pages | Postman folders | one per path | yes | one per transaction |
| Checks | only if the HAR carries them | only your own Postman tests | status only | yes | assertions from the plan |
| Think time | recorded gaps, min 500 ms | none | a fixed constant | generator option | recorded, optionally randomised |
| Correlation | **none** | none | none | rules you write, or AI | **automatic, and shown** |
| Report | none | none | none | — | k6's own dashboard, as a job artefact |
| Ways in | a HAR | a collection | a spec | its own recording | **eight** |
| Starts the job | no | no | no | Grafana Cloud | **yes, no CLI or repo** |

Each of those eight was checked by generating a script from it and having k6
itself parse the result:

| Source | Requests | Groups | Checks | Extractors |
|---|---|---|---|---|
| Browser recording (HAR) | 4 | 1 | 4 | 2 |
| TestMu AI session | 21 | 10 | 18 | 1 |
| OpenAPI | 3 | 1 | 3 | 0 |
| Postman | 3 | 2 | 0 | 1 |
| Excel / CSV | 3 | 2 | 4 | 1 |
| cURL | 3 | 1 | 3 | 0 |
| An existing `.jmx` | 6 | 1 | 3 | 0 |
| URL list | crawls live, same pipeline | | | |

A source never needs k6-specific work: they all produce one spec, and the k6
script is a rendering of it, the same way the `.jmx` is. That is also why the
extractor column is not zero for Postman and Excel - correlation happens before
either emitter runs.

**Correlation is the problem everyone punts.** har-to-k6 only emits a variable
when the input HAR already carries a hand-written LI-HAR `variables` block —
nothing is inferred from responses. openapi-generator writes
`TODO_EDIT_THE_GLOBAL_API_KEY_COOKIE` into the script and leaves it to you.
Grafana's own documentation for the HAR converter lists three manual steps
after conversion: *"Configure the load options"*, *"Remove third-party
content"*, and *"Correlate dynamic data"* — noting that *"tokens expire
quickly, and they are one of the most common things that users will correlate
from a recorded session."* All three are things our plan arrives with already
done.

**The exception is k6 Studio**, Grafana's current recorder, and it is worth
being precise about. Its Autocorrelation went GA in August 2026 and is real:
*"an AI-powered feature that automatically creates correlation rules… It
detects dynamic values, such as session tokens, CSRF tokens, and resource
IDs."* Two differences that matter to a buyer. It **requires a Grafana Cloud
account and sends the recording to Grafana Assistant** — the same objection as
uploading to BlazeMeter, in a newer form. And its own docs describe partial
results: *"Partially correlated — Some requests still fail. Add the created
rules, then create remaining correlation rules manually"*, and
*"Autocorrelation complements manual rule creation; it doesn't replace it."*

Ours is deterministic, runs in your browser, sends nothing anywhere, and is
measured: 8 of 8 planted cases, 15 of 15 samples against a server that rejects
stale values. Theirs may well correlate things a rule pack never would. Both
statements can be true, and the honest pitch says so.

### Where the k6 tools are ahead

**k6 Studio records through a system proxy**, so it sees mobile and native
traffic that a Chrome extension cannot. Its rule editor is interactive - write a
rule, see what it matches - where ours is a JSON or YAML pack. And its
autocorrelation will catch shapes no rule pack anticipated.

**postman-to-k6 has higher fidelity on collections.** It bundles a shim that
*runs* your pre-request and test scripts. We pattern-match the common lines -
`to.have.status(...)`, `pm.environment.set("x", pm.response.json().y)`,
`to.include(...)` - into assertions and extractors, which covers an ordinary
collection and quietly ignores anything scripted beyond it.

**openapi-generator covers a spec exhaustively**, every endpoint and every
parameter, where we author the journey you describe rather than the whole
surface.

**Grafana Cloud k6** is the execution and reporting half: dashboards, trends,
run comparison. The same gap as with BlazeMeter, and the same answer -
HyperExecute runs the test, and the trends are not there yet.

**One more, on our side of the line:** k6's dashboard is collected as a job
artefact rather than shown on HyperExecute's Reports tab. That tab combines
reports from frameworks it knows how to parse, and k6 is not among them -
declaring the dashboard as one of those fails the report step outright.

### Running it

The other tools hand you a file. From here, **Run on HyperExecute** creates a
project, uploads the script and starts the job - no CLI, no repo, no binary.
Proven end to end: a session id became a 21-request, 10-transaction k6 script
that ran on their machines, with k6 v2.2.0 installed as a runtime addon, the
dashboard collected, and the job reporting completed rather than skipped.

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
HyperExecute, on a laptop, in Jenkins, and on BlazeMeter too. A customer can leave, which is exactly why they will try it.

## Where BlazeMeter is ahead

Say these before the customer finds them.

*Reporting depth.* Live dashboards, trends, baseline comparison, share links. We
produce the standard JMeter HTML report as a job artifact. For a team whose
weekly ritual is a trend chart, that is a real gap.

*Pass/fail gates as a product feature.* BlazeMeter has thresholds in the UI. We
have JMeter assertions and a CI exit code.

*The surrounding platform.* Mock services, test-data generation, API monitoring,
scheduled runs, APM integrations.

*Multi-engine support.* Gatling and Locust natively. JMeter Studio authors
JMeter and k6 from one plan, and nothing else.

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
with dynamic tokens correlated and shown, and checked before you spend a run. HyperExecute then runs it across as many machines and regions as you
need, and the plan still runs anywhere else you choose to take it.

## Migrating from BlazeMeter

| What you have there | What to do here |
|---|---|
| A JMX exported from BlazeMeter | *Source → Validate .jmx* to check it, then run it from the run page |
| A BlazeMeter recording (HAR) | *Source → Recording (HAR)*; correlation runs on it here |
| Shared CSV test data | drop it in Test data, and HyperExecute splits it across engines |
| Threshold-based pass/fail | JMeter assertions in the plan, plus the CI exit code |
