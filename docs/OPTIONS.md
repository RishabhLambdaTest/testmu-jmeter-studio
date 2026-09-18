# Every option, and what it does

One page for every control in the extension, each with a worked example. The
defaults are chosen to be right most of the time, so treat this as reference
rather than a checklist: you can author a good plan without touching any of it.

- [The authoring page](#the-authoring-page)
  [Source](#source) · [From the recording](#from-the-recording) ·
  [Traffic filters](#traffic-filters) ·
  [Authentication](#authentication) · [Test data](#test-data) ·
  [Load profile](#load-profile) · [What comes out](#what-comes-out)
- [The popup](#the-popup)
  [Starting a recording](#starting-a-recording) · [Transaction](#transaction) ·
  [Recording options](#recording-options) · [While it is recording](#while-it-is-recording) ·
  [Finishing](#finishing)
- [The panel on the page](#the-panel-on-the-page)

## A note on the grey text

Every field's grey text describes the field or names what happens when you
leave it blank. **It is never an example value and never a default you are
about to send.** If a field looks filled in but the text is grey, the field is
empty.

Where blank means something specific:

| Field | Blank means |
|---|---|
| Users, Ramp | 1 |
| Duration (authoring page) | each user loops once and stops |
| Plan file name | `plan.jmx` |
| Methods | every method |
| Include, Exclude | no filtering |
| Max users, Ramp-up, Duration (run page) | whatever the `.jmx` carries, often 1 user |
| Max users per engine | prefilled with 2000; clear it and HyperExecute's own default applies |
| Global timeout, Job label | not sent |
| Existing project id | a project is created from the name |

Everything else is genuinely optional, and the examples that used to sit in
these boxes are in the sections below instead, where they can be explained.

---

# The authoring page

## Source

*Where the requests come from.* Eight of them, covered one by one in
[SOURCES.md](SOURCES.md) with a sample file each. The choice changes which input
appears below it: a file picker, a text box, or both.

## From a TestMu AI session

Shown only when the source is *TestMu AI session*. The whole path is in
[SESSIONS.md](SESSIONS.md); this is what each control does.

| Control | What it does | When to use it |
|---|---|---|
| Session id | the id of an automation session on your account | always, unless you pick one from the list below |
| Load my sessions | lists your 40 most recent sessions with status and time | when you do not have an id to hand |
| …or pick a recent session | fills the id from that list | after loading them |

The account is sent only to `api.lambdatest.com`, to read your own session logs.

A session run with `"network.full.har": true` carries everything a plan needs.
A session without it still converts, from its `network.har`, but that log has no request or response bodies: the plan sends its POSTs empty and correlates nothing. The page says so as loudly as an error. Selenium only for now.

The traffic filters and *Use the think times from the recording* below apply to
a session exactly as they do to a recording.

## From the recording

Shown only when you are authoring from something you recorded. An hour-long
session is authored by choosing the parts of it you want.

### The transaction list

Every transaction you named while recording, with what it holds:

```
Login           2 requests · 2 not assets
Search          1 requests · 1 not assets
Idle polling   12 requests · 12 not assets
```

Untick what this plan should leave out. The recording itself is untouched, so
you can author a different plan from the same session a minute later.

**Example.** A two-hour session where you spent forty minutes reading
documentation with a dashboard open in another tab. Tick Login, Search and
Checkout; leave the polling behind. You get a plan someone would actually run
instead of three thousand samplers.

### Collapse repeated requests into one sampler

On by default.

**Example.** An hour with the app open polls `GET /api/notifications` four
hundred times. Collapsed, that is one sampler. Left alone, it is four hundred
samplers and a `.jmx` measured in megabytes, describing a test nobody meant to
write.

Requests count as repeats when the method, URL and body all match.

### What is dropped whatever you choose

CORS preflights. A browser sends `OPTIONS` before a cross-origin call because
its security model requires it; JMeter has no such model and never sends one.
A preflight sampler would measure a request that does not happen under load,
and double the request count of every cross-origin API. They are recognised by
the `Access-Control-Request-*` header rather than by the method, so an
`OPTIONS` endpoint you actually mean to test is kept.

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

**Example.** The sample recording holds 58 requests. The same file, authored
three ways:

| Keep | Kept | What went |
|---|---|---|
| `api` | 3 | 42 static, 13 third-party |
| `auto` | 4 | 36 static, 18 third-party |
| `web` | 26 | 32 third-party |

`api` gives a plan where every number in the report is about your service.
`web` keeps the assets your own domain served, so the plan measures what a page
load costs, while still refusing to load-test somebody else's CDN. `auto` sits
between: the page itself plus its service calls.

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

### Skip correlation

Off by default. On, dynamic values are left exactly as recorded.

**Example.** You are testing a stateless public API where the "tokens" the
correlator spotted are actually product ids that must stay fixed. Turning it on
stops the plan from replacing them with `${VARIABLES}`.

Most of the time, leaving this off is what makes the plan work at all: replayed
verbatim, a recorded session token has already expired.

### Correlation rules of your own

A rule says: a request field named like *this* carries a server-issued value,
and here is exactly how to pull it back out of the response. Built-in rules
cover ASP.NET ViewState, JSF, Rails, OAuth and the rest; a framework of your own
takes a pack of your own, as JSON or YAML:

```json
[{"name": "my-csrf",
  "fields": ["^csrf$"],
  "extract": {"type": "boundary", "left": "name=\"csrf\" value=\"", "right": "\""},
  "confidence": "high"}]
```

`fields` are regular expressions matched against the request field's name.
`extract` is `boundary` (left/right), `regex` (one capturing group) or `json`
(a JSON path). Your rules are tried before the built-in ones, so a pack can
override a default, and a rule that fires is named in the Correlations tab
instead of "heuristic".

### Keep the recorded cookie values

Off by default: cookies are left to JMeter's cookie manager, which collects
whatever the server sets during the run, as a browser would. On, the plan also
sends the `Cookie` header exactly as recorded, which is what you want when a
value is set outside the journey - a consent flag, a feature toggle, an
A/B bucket. A cookie the server sets again still wins.

### Fetch each page's images, CSS and scripts

Off by default. On, every sampler parses the HTML it receives and fetches the
referenced resources the way a browser does, with *Parallel downloads*
controlling how many at once (6 if blank). The requests do not appear in the
plan: JMeter finds them at run time, and reports them inside the parent
sampler's time.

Use it when you want a page's true weight without a sampler per asset. Leave it
off when you want the plan to say exactly what it sends: it costs memory on the
engine, and a page that pulls 80 assets multiplies your request count by 80.

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

### Use the think times from the recording

**On by default, for recordings.** It appears under Load profile whenever the
source is a recording, because it shapes load rather than filtering traffic.

On, the plan carries the gaps that actually occurred while you browsed, as a
timer after each request. Off, the plan has no timers at all: every user
replays the journey as fast as the server can answer, which is a stress test
rather than a load test. Two users with no pacing generate more traffic than
fifty behaving like people, and it will pin a CPU on a small engine.

**When to turn it off.** You paused for 47 seconds mid-recording to read a
Slack message, and that pause is now in the plan, so 500 users each sit idle
for 47 seconds and throughput collapses. Either re-record cleanly, or turn this
off and pace the test with the load profile instead.

### Randomise the think times

Off by default, and only useful with the think times on. A fixed pause is a
metronome: five hundred users who started together stay together, and hit each
endpoint in the same instant for the whole run. On, each pause becomes a range
of half to one and a half times what was recorded, so the users spread out. The
average pacing is unchanged.

### Replay once

Runs the plan a single time from this page - one user, in order - and reports
what each request answered. It is the pre-flight that used to need JMeter: the
page holds the permissions to send the plan's own requests, follow its own
variables and read what comes back.

The *Checks* tab then shows every request with its code, what failed, and how
long it took. A failure is one of:

| What it says | What it means |
|---|---|
| `HTTP 401`, `HTTP 403` | the server refused it - nearly always a value that was recorded and has since expired |
| `assertion failed: code equals "200"` | it answered, with the wrong code |
| `extractor found nothing: TOKEN` | the extractor matched nothing in this response, so every later request using `${TOKEN}` is wrong |
| `no value for ${TOKEN}` | nothing defined it: its extractor is missing or ran on a failed request |
| `the browser followed this redirect…` | not a failure. The plan does not follow this redirect and JMeter would stop at it; a browser cannot be told not to |

![The Checks tab after a replay, each request with its code](screenshots/author-replay.png)

**Values that look dynamic.** Under the results, every failing request is
searched for values that the *recording* shows an earlier response handing out.
Each becomes a suggestion: the variable, the value, which request it came from
and which one needs it. Tick the ones you want and press **Apply the ticked
correlations** - each adds the extractor to the source request and replaces the
value everywhere it appears. Then replay again.

![The suggestions under the replay results](screenshots/author-replay-suggestions.png)

The results and the suggestions share one scrolling box, so the suggestions sit
below the requests: scroll inside it to reach them.

That is the same conclusion BlazeMeter's correlation wizard reaches by replaying
in JMeter and comparing; this runs in the browser, so there is nothing to
install.

**What it does not do.** It is not a load test and it is not JMeter: JSR223,
JDBC and WebDriver steps are skipped and counted as skipped, never as passed.
A plan that passes here can still fail at load - that is what the run is for.

### Hosts in this recording

Under the results, once a plan exists. A recording touches every host the page
did - the application, its CDN, whatever analytics it loads - and the plan keeps
the busiest one that is not a tracker. The list shows every host with how many
requests it made and how many are in the plan; tick the ones you want and press
**Rebuild with these hosts**.

Use it when the journey spans two hosts of yours: a checkout on a payment
domain, an API on its own subdomain. Ticking a host also stops the third-party
rule dropping it.

## What comes out

*Plan file name* is the filename the `.jmx` is saved and uploaded under. It
matters more than it looks: it is the name the run form offers as the entry
point, so `checkout-load.jmx` is easier to pick out of a project than `plan.jmx`
for the fourth time.

| Button | What you get | Needs | When to use it |
|---|---|---|---|
| Download .jmx | the plan | nothing | always, if you want to keep it or open it in JMeter |
| Replay once | the plan run once, here, with per-request results and correlation suggestions | the target reachable from this browser | before any run that costs money |
| Run on HyperExecute… | project, upload, trigger, dashboard | a TestMu AI sign-in | when the plan is ready to carry load |
| Download browser test .py | the browser steps as a Playwright script | Playwright, if you run it | when the journey's UI matters as well as its load |
| Download k6 test | `<plan>_load_test.js` and `hyperexecute.yaml` | k6, if you run it | when the test should run on k6 rather than JMeter |

Download and *Run on HyperExecute…* both parse the plan first. A plan that no
XML parser will read is refused here, with the line and column, rather than
failing on a runner ten minutes later.

Every plan is also run through the scale checklist as it is built, and the log
says what it found. It covers listeners
that hold results in heap, an unbounded loop with no scheduler, missing
timeouts, disabled elements still parsed into memory, functional mode, a plan
large enough that the tree itself is the cost. Past about three hundred
samplers it says so, because beyond that the plan is a memory cost on every
thread before a single request is sent. It matters most for a converted
session, which nobody hand-reviews.

### k6 job

The same plan, for the other engine. Everything under **k6 job** is blank until
you disagree with the plan: blank means "whatever the plan already says".

| Field | Blank means | What it changes |
|---|---|---|
| Users in total | the plan's thread count | how many virtual users, divided across the machines |
| Machines | one | how many machines the job runs on, as a matrix of shards |
| Ramp over | the plan's ramp | how long to reach that many users, e.g. `2m` |
| Run for | the plan's duration | how long to hold them, e.g. `30m` |
| Send it to | the host in the plan | the base URL, so a plan recorded against production can run against staging |
| Fail above … % failed requests | 1% | a k6 threshold, which is what decides the exit code |
| …or above a p(95) of | no budget | a 95th-percentile budget in milliseconds, as a second threshold |
| Project name | `k6-<plan>` | the HyperExecute project to create |
| …or an existing project | create a new one | an existing **custom** project, listed k6-first |
| Show every custom project | off | lists the org's other custom projects too |

The line underneath reads the settings back as a sentence - *"1000 user(s) over
5 machine(s): 200 per machine · ramp 2m · for 30m · against
https://staging.example.com · fails above 5% failed requests"* - so a wrong
number is visible before the job starts.

**Machines multiply, they do not divide the work twice.** 1000 users over 5
machines is 200 users each, all running the same journey: the load your target
sees is 1000. Users left over after the division are reported in that line
rather than silently dropped.

**Run on HyperExecute…** under those fields creates the project, uploads the
script and starts the job - no CLI, no repo, no YAML file. **Download k6 test**
gives you the same thing as two files to run yourself.

Both thresholds matter more than they look: a k6 check that fails does not
change the exit status, only a threshold does. Without them a job whose every
request failed still finishes green.

### The five numbers

A generated plan leads with five counters, and they are the fastest read of
whether it is worth running.

| Counter | What it is | What a surprising value means |
|---|---|---|
| requests | samplers in the plan | far more than the journey had means the traffic filter kept noise; far fewer means it dropped something you wanted |
| correlated | dynamic values wired from one response into a later request | **zero on a plan with a login is the one to worry about**: nothing was carried, so every request after the login is replaying an expired value |
| size | the `.jmx` on disk | a plan over a few MB is usually recorded assets, and HyperExecute refuses one over 50 MB |
| errors | things that make the plan wrong | never ship one. The log says what and where |
| warnings | things that build and run but will bite | a variable used and never defined is the common one |

### The three tabs

| Tab | What it holds |
|---|---|
| **Requests** | every sampler with its group, method, path and checks. Read it to confirm the plan contains what you meant to test, and click any row to edit it |
| **Correlations** | every dynamic value that was wired between requests, each with the rule that found it, a confidence, and the hop: which response handed it out and which request needed it. This is where you disagree with one. If a login recorded fine but the plan will 401 under load, this tab is empty when it should not be |
| **Checks** | validation results, and after **Replay once**, every request with its code, what failed and how long it took |

**Undo, Redo and find a request** sit above the table. Undo steps back through
the last ten edits and restores the whole plan, not just the field you changed,
because every edit rewrites the spec and rebuilds from it. A replay result is
dropped on undo: it described a plan that no longer exists. *find a request*
filters the table as you type, matching the method, group, name and path. The
detail is in [EDITING.md](EDITING.md).

![The host checklist, with one host in the plan](screenshots/author-hosts.png)

### Editing the plan

Scenario by scenario, this is [EDITING.md](EDITING.md). In short:

It lives in the **Requests** tab, on the result page. Every row is clickable,
and says so on the right:

![The Requests table, with edit on each row](screenshots/author-edit-hint.png)

Click any row and the request opens, with the verbs underneath it:

![A request open in the inspector](screenshots/author-edit-inspector.png)

```
Rename…   Assert 200   Assert text…   Extract…   Pause 1s   Move up   Move down   Delete
```

Above them sits the request itself: the URL, the headers, and the body the
sampler will send. A plan you cannot read is one you cannot edit with any
confidence, so the inspector opens with what is actually going over the wire.

```
Rename…  Assert 200  Assert text…  Extract…  Pause 1s  Replace value…  Move up  Move down  Delete
```

They are the same verbs the recording panel uses, and they do the same things.
Each one edits the spec and rebuilds the plan, so an edited plan is exactly what
the spec says and goes through the same checks as a freshly authored one.

**Replace value…** swaps a literal for a `${VARIABLE}`, everywhere in the plan
rather than only in the request you clicked. A recorded token appears in every
request that used it, and replacing it in one place leaves the others holding a
value that expired when recording stopped.

It matches whole values only. Replacing `emilys` does not touch `emilyspass` —
that substring rewrite would corrupt a password while reporting success. The
message says how many places changed.

Expect a warning afterwards: a variable nothing defines yet is *expected* at
this point, not a mistake. Define it under Test data from a CSV, or with
Extract on an earlier request, and the warning goes.

**An edit that breaks something says so.** Delete a request another one takes a
token from and the message reads *"delete applied, but it broke something:
variable ${ACCESSTOKEN} is used but never defined"*, and the Checks tab opens.
That plan would still build and still run; it would fail at load with a wall of
401s. A warning that only appeared in the log would make this editor a way to
break a plan quietly.

### Advanced — edit the spec

The plan is generated from a spec, and the spec is in a box at the bottom of the
page. Everything the engine can build is reachable there, including the things
the form deliberately does not carry: database steps, GraphQL samplers, JSR223
scripting, the other four timer types, and if/loop/parallel controllers.

Edit it, press **Regenerate from the spec**, and the result goes through the
same validation as anything else. A spec that cannot be read says why rather
than failing silently.

Most people will never open this. It exists so the form does not need a field
for every feature.

The Log panel underneath holds everything the engine did. **copy** puts it on the
clipboard, **clear** empties it, **hide** collapses it.

Everything on this page runs inside the extension.

---

# The run page

Reached with *Run on HyperExecute…*, from either the popup or the authoring
page. [SETUP.md](SETUP.md#5-running-it-on-hyperexecute) walks the five steps it
performs in order; this is what each control is for.

## Account

There are no credential fields, and no access key to find. The page uses the
TestMu AI account the browser is logged in to and stays locked behind **Log in
to TestMu AI** until there is one. That button opens TestMu AI's own login
page, so Google, GitHub, SSO and email-and-password all work exactly as they do
on the dashboard. The tab closes itself once you are in and brings this page
back to the front, so you are not left on the dashboard wondering whether it
worked.

The account in use is named in the button at the top right. Clicking it offers:

| Button | What it does |
|---|---|
| **Log out of TestMu AI** | Opens TestMu AI's logout, which lands on the login page. This is both how you sign out and how you come back as a different account - the studio follows whichever account logs in next |
| **Cancel** | Closes the card and changes nothing |

## Project

A job lives inside a project. Fill in one field or the other, never both.

| Control | What it does | When to use it |
|---|---|---|
| Which project should this run go into? | lists the JMeter projects on your account | every run. Pick one and the id is filled in for you |
| + New project… | reveals a name box; the project is created when you press the button | the first run for a given service |
| New project name / existing project id | the original two fields | only appear when the list could not load |

Creating a name that already exists is an error rather than a silent reuse,
because two projects with the same name is worse than a message.

## Files

| Control | What it does | When to use it |
|---|---|---|
| Name for the recorded plan | the filename the plan is uploaded as | when a project holds several plans |
| Add: Files | attaches a .jmx and anything else the run needs | a CSV of test data, a plugin jar the log named, a `system.properties` for mTLS |
| Add: A folder | uploads a whole folder, each file under its folder path, hidden files left out | a suite kept as a folder: plans, data and jars together |
| Which .jmx should the job run | the entry point | only when more than one `.jmx` is in the list |

Every `.jmx` here is parsed before upload, attached ones included. The line under
the pickers adds up what will be sent, and flags anything over HyperExecute's
limits before the button is pressed:

| Limit | Value |
|---|---|
| one `.jmx` | 50 MB |
| one request | 200 MB and 20 files |

A larger set is sent in several requests, each within the request limit, and
each adds to the project's files. A `.jmx` over 50 MB is refused before anything
is sent; the authoring page warns about one as soon as it is built. Files go up
as their own bytes, so a jar arrives intact.

## Run configuration

These override the plan. Whatever users, ramp-up and duration the `.jmx`
carries, what is set here is what runs; **an empty field means "whatever the
plan says"**, which is not the same as a default.

With *Max users* set, each region runs its share of it, rounded down, the way
the dashboard splits it: 1,000 users at 60% and 40% is 600 and 400. The line
under the regions says when the shares do not add up to 100%, and a region at 0%
has to be given some traffic or removed. With *Max users* empty, every region
runs what the `.jmx` says.

### What this account may run

Under the load fields is a line naming what the signed-in account has bought:
its user ceiling, the longest a single job may be, the VUH it gets a month, and
what the numbers currently in the form would cost against that.

It comes from the account's own plan attributes, the same values the platform
checks with: `HYPEREXECUTE_PERF_MAX_VUSERS`,
`HYPEREXECUTE_PERF_MAX_JOB_DURATION_MINUTES` and `HYPEREXECUTE_PERF_MAX_VUH_MONTH`.
`-1` means no limit and is never enforced. An account with no performance plan
gets the free ceilings instead, which are much lower: **100 users, a 40 minute
job, 20 VUH a month**.

The VUH estimate is the platform's own sum rather than an approximation of it:

```
users x (floor((duration - rampup / 2) / 3600) + 1)
```

Half the ramp-up comes off before the hours are counted, any part of an hour
counts as a whole one, and a browser test multiplies the result by ten. So one
virtual user for exactly an hour is 2 VUH, not 1.

**A run the plan does not cover is not triggered.** The message names the
number and the ceiling, because the platform's own refusal names neither. The
upload button still works, so a plan can be put in place and run later from the
dashboard. Nothing is checked when the limits cannot be read.

### Which regions you may actually use

Six regions are offered, the same six the dashboard lists. **Which of them your
jobs may run in is set per organisation**, and for most accounts that is East US
alone.

The allowance lives in an organisation preference,
`HYPEREXECUTE_PERF_ALLOWED_REGIONS`. When it is absent, empty, or cannot be
read, the server falls back to `eastus` and refuses a job asking for anything
else. The page reads the same preference when it opens and marks the regions
your plan does not cover with **(not in your plan)**, naming them again in the
line under the field if one is chosen.

They stay selectable on purpose. Region checks only run when the organisation
has that validation switched on and the job carries a JMeter block, neither of
which is readable from here, so refusing the choice outright would block jobs
that would in fact be accepted. k6 jobs skip region validation altogether.

If the preference cannot be read at all, every region is offered as before and
the log says why. A failure to ask is not the same as a refusal, and a blip in
the account service must not stop a run.

| Control | What it does | When to use it |
|---|---|---|
| Regions and traffic | one row per region, from the regions the HyperExecute dashboard offers, each with its share of the users. **+ Add region** adds a row at 0% | one region normally; several to test from where your users are |
| Max users (total VU) | total virtual users across the job | whenever you want a number other than the plan's |
| Max users per engine | how many each machine carries | to control engine count: total ÷ this = machines. The line underneath does the arithmetic as you type |
| Ramp-up (s) | seconds to reach full load | a ramp long enough that autoscaling behaves as it would in life |
| Duration (s) | how long to hold | a soak needs minutes; a smoke test needs one |
| Global timeout (min) | hard stop for the whole job | when a hung run would otherwise burn the budget |
| Job label | shows on the dashboard | to find this run again among fifty |
| Split CSV rows across engines | each machine gets its own slice | whenever the data must be unique per user, such as one login per row |

The counts reach JMeter itself, not just the infrastructure: a job sent as
4 users at 2 per engine starts two engines, each logging `threads=2`.

| Button | What it does | When to use it |
|---|---|---|
| Upload only | steps 1 to 3, no job | staging files, or when someone else triggers runs |
| Create & trigger | the whole sequence, then opens the dashboard | the normal path |

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

## While it is recording

Under the counter, the popup shows what the session weighs: requests, elapsed
time, response text on disk, and how much browser storage is left.

```
241 requests · 3s · 2 KB of responses · 10240 MB of browser storage free
```

There is no cap on a recording. It is written to disk as it happens, so the
only ceiling is what the browser grants the extension, which is measured in
gigabytes and shown here. If it ever passes 80% of that grant, this line says
so rather than letting a write fail.

A recording also survives closing Chrome. Reopen it and the popup offers the
session back:

> A recording from 20:32 is on disk: 241 requests. Chrome was closed before it
> was used.

**Build the plan** authors from it as though nothing had happened. **Discard**
deletes it and frees the space. Neither is offered until there is something to
offer, so an empty popup means there is genuinely nothing waiting.

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

Closing the tab while it is still recording asks first, because a session is
work rather than a side effect: **Save HAR, then close** keeps the recording as
a file, **Close without saving** throws it away, and **Keep recording** leaves
everything as it was.
