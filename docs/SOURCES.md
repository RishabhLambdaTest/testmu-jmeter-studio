# Every way in — with a sample you can run right now

Seven sources produce the same thing: a valid, ready-to-run JMeter `.jmx` with
assertions, extractors, a load profile and correlated tokens. Pick whichever
matches what you already have. You never need more than one.

Every sample below is in [`sample/`](../sample/) and points at
[dummyjson.com](https://dummyjson.com), a public API that needs no key — so a
new user can try all seven the day they install the extension.

**In the extension:** popup → *Author from something else* → pick the source, or
open the authoring page and use the **Source** dropdown.
**On the CLI:** the command is given for each.

![The Source picker](screenshots/author-source.png)

---

## The shape of the flow

```
  a source you already have
          ↓
  Generate plan          ← the engine runs inside the extension (WebAssembly)
          ↓
  Requests · Correlations · Checks      ← read what it decided, and why
          ↓
  Download .jmx   or   Run on HyperExecute…
```

Three numbers appear on every result: **requests**, **correlated**, **errors**.
A plan with errors is never silently shipped.

---

## 1. cURL — the fastest way to a first plan

**Sample:** `sample/requests.txt` — paste it into the text box
**CLI:** `jmxgen from-curl sample/requests.txt -o plan.jmx` → *3 requests*

In DevTools, right-click any request → **Copy → Copy as cURL**, paste, done.
`-X`, `-H`, `-d`, `-F` and `-u` are all handled, and a POST body is sent raw
rather than URL-encoded — the mistake that turns a working request into a 400
the moment it reaches JMeter.

![A plan built from curl commands](screenshots/author-curl-result.png)

## 2. OpenAPI / Swagger — when there is a contract

**Sample:** upload `sample/api.yaml`, *or* paste a live URL:
`https://petstore3.swagger.io/api/v3/openapi.json`
**CLI:** `jmxgen from-openapi sample/api.yaml -o plan.jmx` → *3 operations*

Path parameters become variables, not frozen values: `/products/{id}` is emitted
as `${id}`, so a CSV of ids drives it later. The live Petstore URL yields 19
requests with no file at all.

## 3. Postman collection — when the team already has one

**Sample:** upload `sample/collection.json`
**CLI:** `jmxgen from-postman sample/collection.json -o plan.jmx` → *3 requests*

Folders become Transaction Controllers, and Postman's own chaining survives the
crossing: `pm.environment.set("token", ...)` is converted into a JMeter JSON
extractor, so the next request's `{{token}}` works as `${token}`. That
conversion is the part people otherwise redo by hand for a day.

## 4. Recording (HAR) — the one to demo

**Sample:** upload `sample/recording.har`, set **Keep: api**
**CLI:** `jmxgen from-har sample/recording.har --mode api -o plan.jmx`

A genuine browser session — log in, call a protected endpoint, search products —
58 requests including images, fonts and Google Tag Manager. What comes out:

```
kept 3 of 58 recorded requests across 1 page(s)
  (dropped 42 static, 13 third-party, 0 filtered)
  correlated 1 value(s):
    ${ACCESSTOKEN}   bearer-token   high   from body
                     POST /auth/login -> GET /auth/me
```

Two things happened there. The noise went: 42 assets and 13 tracker requests
that would have distorted every number in the report. And the login token was
found in one response and wired into the next request — with the rule that
matched it, the confidence, and where it flows from and to, all shown.

Replay that recording verbatim and it fails, because the token has expired.
That is the problem correlation solves, and it is the single largest reason
hand-built JMeter plans return a wall of 401s.

**Keep: web** on the same file keeps the assets instead. One recording, either
an API-level or a browser-level plan.

This is the only source where correlation has anything to work with, because it
is the only one that carries real responses. Which is why the recorder exists —
see [RECORDING.md](RECORDING.md).

![A plan built from a recording](screenshots/author-har-result.png)

## 5. Excel / CSV sheet — when a non-engineer owns the list

**Sample:** upload `sample/endpoints.xlsx`
**CLI:** `jmxgen from-excel sample/endpoints.xlsx -o plan.jmx` → *3 samplers*

The `assert` and `extract` columns become real assertions and extractors, so a
product owner can fill in a sheet and get a load test out of it.
`jmxgen template mine.xlsx` writes the empty sheet to hand them.

## 6. Page URL list (probe) — when there is nothing at all

**Sample:** paste the contents of `sample/urls.txt`, one URL per line
**CLI:** `jmxgen probe sample/urls.txt -o plan.jmx` → *19 samplers from 1 URL*

It fetches the page and reads the HTML for scripts, stylesheets, images and
forms, then drops third-party and tracker hosts. No spec, no recording, no time —
this is the escape hatch.

## 7. Existing .jmx — when you have inherited one

**Sample:** upload `sample/existing-plan.jmx`
**CLI:** `jmxgen import-jmx sample/existing-plan.jmx --spec plan.yaml -o clean.jmx`

The plan comes back as an editable spec, so you can see what is actually in it,
filter it and re-emit it clean. Anything jmxgen does not model is preserved
verbatim rather than dropped. `jmxgen optimize` is the companion for plans that
are bloated or broken.

---

## The supporting files

| File | Where it goes | What it demonstrates |
|---|---|---|
| `sample/users.csv` | **Test data** in the authoring page, or `--csv` | 50 virtual users that are not all `emilys` |
| `sample/workload.yaml` | `jmxgen build` | `closed` vs `arrivals` thread groups — see below |
| `sample/mtls.yaml` | `jmxgen build` | client certificates; also writes `system.properties` |

### Open vs closed workload

A normal JMeter Thread Group is a **closed** model: 500 users each waiting for
their own response. If the system slows down, the load *drops* — which is the
opposite of what an incident looks like. `sample/workload.yaml` shows the other
model:

```yaml
thread_groups:
  - name: Steady arrivals
    model: arrivals        # jpgc casutg ArrivalsThreadGroup
    rate: 120              # 120 new users per minute, whatever the response time
    ramp_up: 60
    hold: 900
```

Arrivals keep arriving when the service degrades, which is how you find the
knee. It needs `jmeter-plugins-casutg` on the runner; `verify` names the jar, and
on HyperExecute you upload it alongside the plan.

### Authentication that survives 500 users

The login that must run **once per user**, with credentials from a CSV:

```bash
jmxgen from-curl sample/requests.txt -o plan.jmx \
  --login "POST /auth/login" \
  --login-body '{"username":"${username}","password":"${password}"}' \
  --login-token '$.accessToken' \
  --csv sample/users.csv:username,password
```

The login becomes a setUp Thread Group and the token is published with
`props.put("AUTH_TOKEN", ...)`, then read back as `Bearer ${__P(AUTH_TOKEN)}` —
a JMeter **property**, not a variable. Variables are per-thread, so a token
extracted by user 1 is invisible to users 2 through 500. Getting that wrong is
the usual reason a plan works perfectly with one user and returns 401s under
load.

In the extension the same thing lives under **Authentication** and **Test data**.

---

## After the plan exists

| Action | What it does | Needs |
|---|---|---|
| **Download .jmx** | the plan itself | nothing |
| **Run on HyperExecute…** | project, upload, trigger, dashboard | LambdaTest credentials |
| **Download Taurus .yml** | the same test as a `bzt` config | `bzt`, if you use it |
| **Download browser test .py** | a Playwright script for the browser steps | Playwright, if you run it |
| **Validate (single user)** | runs it once, reports codes and unresolved `${VARS}` | the local console + JMeter |

`Validate` is the cheap gate. Finding a broken extractor at one user costs
seconds; finding it at 500 users costs a run.
