# Every option, and what it does

One page for every control in the extension, each with a worked example. The
defaults are chosen to be right most of the time, so treat this as reference
rather than a checklist: you can author a good plan without touching any of it.

- [The authoring page](#the-authoring-page)
  [Source](#source) · [Traffic filters](#traffic-filters) ·
  [Authentication](#authentication) · [Test data](#test-data) ·
  [Load profile](#load-profile) · [What comes out](#what-comes-out)
- [The popup](#the-popup)
  [Starting a recording](#starting-a-recording) · [Transaction](#transaction) ·
  [Recording options](#recording-options) · [Finishing](#finishing)
- [The panel on the page](#the-panel-on-the-page)

---

# The authoring page

## Source

*Where the requests come from.* Seven of them, covered one by one in
[SOURCES.md](SOURCES.md) with a sample file each. The choice changes which input
appears below it: a file picker, a text box, or both.

## Traffic filters

These only appear for the two sources that carry more than you asked for: a
recording, and a URL list. A curl command has no noise to remove.

### Keep

What counts as part of the test.

| Value | What it keeps | When to pick it |
|---|---|---|
| `auto` | pages and service calls, no assets | the default, and right for most APIs |
| `api` | service calls only | you are load-testing an API, and the HTML is irrelevant |
| `web` | everything the browser fetched | page load time is the thing you are measuring |

**Example.** The sample recording holds 58 requests: 3 API calls, 42 images,
fonts and stylesheets, and 13 analytics beacons.

- `api` gives you a 3-request plan. Every number in the report is about your
  service.
- `web` gives you all 45 first-party requests, so the plan measures what a real
  page load costs, including the CDN.
- `auto` sits between: the page itself plus its service calls.

The trap `auto` and `api` exist to avoid: with assets included, 500 users mostly
hammer a CDN, average response time collapses to 12 ms, and the report says the
system is healthy when the API underneath is timing out.

### Methods

A comma-separated allow-list. Blank means all.

**Example.** `GET` on a recording of a checkout flow gives you a read-only plan
you can point at production without creating 500 real orders.

### Include (regex)

Keep only URLs matching this pattern.

**Example.** `/api/v2/` on a recording made while the app was mid-migration
keeps the new endpoints and drops the v1 calls the old pages still make.

### Exclude (regex)

Drop URLs matching this pattern, applied after Include.

**Example.** `analytics|beacon|hotjar|intercom` removes the third-party
telemetry that a `web` recording would otherwise load-test on someone else's
behalf. `\.(png|jpe?g|svg|woff2?)$` drops images and fonts while keeping the
rest of a `web` capture.

### Use recorded think times

Off by default, and the default is deliberate.

Off, the plan uses uniform pauses between requests. On, it uses the gaps that
actually occurred while you were recording.

**Example.** You paused for 47 seconds mid-recording to read a Slack message. On,
that 47-second pause is now in the plan, so 500 virtual users each sit idle for
47 seconds and your throughput is a fraction of what you intended. Turn this on
when the recording was a clean, deliberate run and the pacing is meaningful.

### Skip correlation

Off by default. On, dynamic values are left exactly as recorded.

**Example.** You are testing a stateless public API where the "tokens" the
correlator spotted are actually product ids that must stay fixed. Turning it on
stops the plan from replacing them with `${VARIABLES}`.

Most of the time, leaving this off is what makes the plan work at all: replayed
verbatim, a recorded session token has already expired.

## Authentication

Three fields that turn one recorded login into a login that runs once per virtual
user, correctly, under load.

| Field | Example |
|---|---|
| Login request | `POST /auth/login` |
| Body | `{"username":"${username}","password":"${password}"}` |
| Token path | `$.accessToken` |

**What it builds.** The login moves into a setUp Thread Group. The token is
extracted with the JSONPath you gave and published as a JMeter *property* with
`props.put("AUTH_TOKEN", …)`, then read back in every request as
`Bearer ${__P(AUTH_TOKEN)}`.

**Why a property and not a variable.** Variables are per-thread. A token
extracted by user 1 is invisible to users 2 through 500, so a plan built the
obvious way works perfectly in a single-user test and returns a wall of 401s
under load. This is the most common way a JMeter plan fails.

Leave these blank if the recording already carries a login and correlation found
the token. The Correlations tab tells you whether it did.

## Test data

| Field | Example |
|---|---|
| CSV file | `users.csv` |
| Columns | `username,password` |

The columns become `${username}` and `${password}`, and each virtual user reads
its own row.

**Example.** Without this, 500 users log in as `emilys`, the account is locked
out or its cache is warm, and the numbers describe one user's experience
repeated 500 times. With it, they behave like 500 people.

The path is resolved relative to the `.jmx`, so keep the CSV beside the plan.
Upload it with the plan on the run page, and tick *Split CSV rows across engines*
so no two machines replay the same rows.

## Load profile

| Field | Example | Meaning |
|---|---|---|
| Users | `50` | virtual users |
| Ramp (s) | `60` | how long until all of them are running |
| Duration (s) | `600` | how long to hold. Blank means each user loops once and stops |

**Example.** `50 / 60 / 600` starts roughly one new user a second for a minute,
then holds 50 for ten minutes. Ramping matters: 50 users starting at once
produces a thundering herd, and you end up measuring the cold start rather than
the system.

Blank duration is the right choice when you are checking the plan works, not
measuring anything.

These are a starting point. The HyperExecute run form overrides all three, so
what you set here is what a local JMeter run would use.

## What comes out

| Button | What you get | Needs |
|---|---|---|
| Download .jmx | the plan | nothing |
| Validate (single user) | one real run, per-request codes, and any `${VAR}` that never resolved | the local console |
| Run on HyperExecute… | project, upload, trigger, dashboard | LambdaTest credentials |
| Download Taurus .yml | the same test as a `bzt` config | `bzt`, if you use it |
| Download browser test .py | the browser steps as a Playwright script | Playwright, if you run it |

The Log panel underneath holds everything the engine did. **copy** puts it on the
clipboard, **clear** empties it, **hide** collapses it.

*Where jmxgen runs* is the address of the optional local console, and only
Validate uses it. Everything else runs inside the extension.

---

# The popup

## Starting a recording

Two ways in, and the difference decides whether your plan has a login in it.

**Start recording this tab** attaches to the page in front of you. Anything
already loaded is gone: the navigation, the redirect chain, the token exchange.
Use it when you are on the page you want to begin from and the interesting part
is still ahead.

**A URL in the box, then Go** opens that URL in a new tab and attaches before the
first byte. You get request number one.

**Example.** Recording an SSO login. Started from an open tab, the capture begins
after the identity provider has already handed back a token, so the plan cannot
log anyone in. Started with Go, the `302` chain and the token exchange are both
in the recording, and correlation has something to wire up.

## Transaction

A name for the step you are about to perform. Everything captured from now on
lands in a Transaction Controller with that name.

**Example.** Type `Login`, press Set, sign in. Type `Search`, press Set, run a
search. Type `Checkout`, press Set, buy something. The report then reads

```
Login      p95  820 ms
Search     p95  240 ms
Checkout   p95 2140 ms
```

instead of 200 rows of URLs. This is the single highest-value thing you can do
while recording, and it takes three seconds per step.

## Recording options

Applied live: changing one mid-recording pushes it to the attached tab, so you
never throw away a session to fix a setting.

### Emulate

Desktop, iPhone 14, Pixel 7, iPad Pro or Galaxy S22. Sets the device metrics and
the user agent together.

**Example.** Your app serves a lighter API to phones. Recording as desktop
produces a plan that tests endpoints your mobile users never call. Pick
iPhone 14 and you capture the traffic they actually generate.

### User agent

Overrides the string by hand, on top of whatever the device preset set.

**Example.** Your CDN routes on a custom agent, or a bot filter blocks the
default. Paste the exact string you need.

### Block URLs

Patterns that never reach the network while recording.

**Example.** `*doubleclick*, *hotjar*, *intercom*` keeps a chat widget from
loading at all, so the capture is clean at the source rather than filtered
afterwards. Useful when a third-party script is slow enough to distort the think
times you are about to record.

### Disable browser cache

Every asset is fetched rather than served from cache.

**Example.** On the second run through a flow, your browser has everything
cached, so the recording shows three requests where a new visitor makes forty.
Tick this to capture the cold visit.

### Bypass service workers

Requests hit the network instead of being answered by a service worker.

**Example.** A PWA answers half its API calls from a worker cache. Without this,
the recording contains the handful that escaped, and the plan tests almost
nothing.

## Finishing

**Generate test plan** hands the recording to the authoring page and builds it
there, so you can set filters and load profile before downloading.

**Run on HyperExecute…** does the same and continues to the run form.

**Export HAR instead** saves the raw recording, annotations included, as a `.har`
you can keep, share or re-author later.

**Discard session** throws the recording away. It asks first if you have not
saved or built anything.

*Author from something else* takes you straight to the authoring page with a
source preselected, for when there is nothing to record.

---

# The panel on the page

The panel is where you say what a request *means*, at the moment you are looking
at it. Each control applies to the request that was just captured.

| Control | What it writes | Example |
|---|---|---|
| Transaction | a Transaction Controller from here on | same as the popup field, without switching windows |
| Assert 200 | a response assertion | on the login call, so a 500 fails the sample instead of passing quietly |
| Assert text… | "body contains …" | `"orderId"` on the checkout response: catches a 200 that is really an error page |
| Extract… | a JSON extractor into a variable | `$.data.cartId` becomes `${CARTID}` for the next request |
| Pause 2s | a Flow Control Action pause | after a search, where a real user reads results before clicking |
| Rename… | the sampler label | `POST /api/v2/x7` becomes `Add to cart` |
| Skip last | drops that request | the analytics beacon that slipped through |
| + Manual request… | a request you type in | the webhook the browser never sends, but the test needs |
| record browser steps | keeps clicks and typing alongside the traffic | on by default; produces the Playwright test as well as the `.jmx` |

**Finish → build the plan** ends the session and opens the authoring page with
the recording loaded. **Export HAR instead** saves the raw file.

Drag the panel by its title bar, hide it with `–`, and expand it with the square
when a long recording needs the room.
