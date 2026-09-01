# sample — one input for every Source in the dropdown

Real inputs against [dummyjson.com](https://dummyjson.com), a public API needing
no key. Every option in the extension's **Source** dropdown has a sample here.

Open the extension, pick the Source, give it the file or text below, and press
**Generate plan**. [docs/SOURCES.md](../docs/SOURCES.md) walks through what to
look for in each result.

Each entry also names its command-line equivalent. Those belong to the
[jmxgen CLI](https://github.com/RishabhLambdaTest/jmxgen), a separate repository
for CI use - nothing here requires them.

---

## 1. OpenAPI / Swagger

**Extension:** upload `api.yaml` — *or* paste a live spec URL into the text box:

```
https://petstore3.swagger.io/api/v3/openapi.json
```

**CLI:** `jmxgen from-openapi sample/api.yaml -o plan.jmx`

**Look for:** the path parameter. `/products/{id}` becomes `${id}`, a variable —
not frozen at whatever the example showed. The live Petstore URL yields 19
requests with no file at all.

## 2. Postman collection

**Extension:** upload `collection.json`

**CLI:** `jmxgen from-postman sample/collection.json -o plan.jmx`

**Look for:** the folders became Transaction Controllers, and Postman's own
chaining survived — `pm.environment.set("token", ...)` is now a JMeter JSON
extractor, so the next request's `{{token}}` works as `${token}`.

## 3. Recording (HAR) — *the one to demo first*

**Extension:** upload `recording.har`, set **Keep: api**

**CLI:** `jmxgen from-har sample/recording.har --mode api -o plan.jmx`

A genuine browser session: log in, call a protected endpoint, search products —
58 requests including images, fonts and Google Tag Manager.

```
kept 3 of 58 recorded requests across 1 page(s)
  (dropped 42 static, 13 third-party, 0 filtered)
  correlated 1 value(s):
    ${ACCESSTOKEN}   bearer-token   high   from body
                     POST /auth/login -> GET /auth/me
```

**Look for:** two things happened. The noise went — 42 assets and 13 tracker
requests that would have distorted the numbers. And the login token was found in
one response and wired into the next request, with the rule that matched, the
confidence, and where it flows from and to. Replay the recording verbatim and it
fails, because the token has expired; that is the problem correlation solves.

This is the **only** source where correlation has anything to work with, because
it is the only one carrying real responses.

Switch to **Keep: web** on the same file to keep the assets instead — one
recording, either an API-level or a browser-level plan.

## 4. cURL command(s)

**Extension:** paste the contents of `requests.txt` into the text box

**CLI:** `jmxgen from-curl sample/requests.txt -o plan.jmx`

**Look for:** the POST body is sent raw, not URL-encoded. In DevTools you can
right-click any request → *Copy as cURL* and paste it straight in. `-X`, `-H`,
`-d`, `-F` and `-u` are all handled.

## 5. Excel / CSV sheet

**Extension:** upload `endpoints.xlsx`

**CLI:** `jmxgen from-excel sample/endpoints.xlsx -o plan.jmx`

**Look for:** the `assert` and `extract` columns became real assertions and
extractors. Run `jmxgen template mine.xlsx` to get an empty sheet for a
colleague to fill in.

## 6. Page URL list (probe)

**Extension:** paste the contents of `urls.txt` (one URL per line)

**CLI:** `jmxgen probe sample/urls.txt -o plan.jmx`

**Look for:** you gave it one URL and got ~19 requests. It fetched the page and
read the HTML for scripts, stylesheets, images and forms. Use this when there is
no spec, no recording and no time.

## 7. Existing .jmx (import)

**Extension:** upload `existing-plan.jmx`

**CLI:** `jmxgen import-jmx sample/existing-plan.jmx --spec plan.yaml -o clean.jmx`

**Look for:** the plan comes back as an editable spec so you can see what is in
it, filter it, and re-emit it clean. Anything jmxgen does not model is kept
verbatim rather than dropped. Pair it with `jmxgen optimize` for plans that are
bloated or broken.

---

## Supporting files

| File | Used with | Shows |
|---|---|---|
| `users.csv` | **Test data** in the extension, or `--csv` | So 50 virtual users aren't all `emilys` |
| `workload.yaml` | `jmxgen build` | `closed` vs `arrivals` thread groups |
| `mtls.yaml` | `jmxgen build` | Client certificates; also writes `system.properties` |

## Combining them

The pieces compose. A login that runs **once** for every user, with credentials
from a CSV:

```bash
jmxgen from-curl sample/requests.txt -o plan.jmx \
  --login "POST /auth/login" \
  --login-body '{"username":"${username}","password":"${password}"}' \
  --login-token '$.accessToken' \
  --csv sample/users.csv:username,password
```

The login becomes a setUp Thread Group and the token is published with
`props.put("AUTH_TOKEN", ...)`, then read back as `Bearer ${__P(AUTH_TOKEN)}` —
a JMeter *property*, not a variable. Variables are per-thread, so a token
extracted by user 1 is invisible to users 2 through 500. Getting that wrong is
the usual reason a plan returns a wall of 401s under load but works perfectly
with one user.

In the extension the same thing lives under **Authentication** and **Test data**.

## After you have a plan

```bash
jmxgen replay plan.jmx                          # one user, against the real target
jmeter -n -t plan.jmx -l r.jtl -e -o report/    # the load test
```

`replay` is the gate — it runs the plan once and reports per-request codes plus
any `${VARIABLE}` that never resolved. Cheaper than finding out at 500 users.
In the extension this is **Validate (single user)**, which needs the CLI's local console running.

## Notes

Data files resolve **relative to the .jmx**, so keep `users.csv` beside the plan
when you run it. `verify` warns when a referenced file is missing.

`workload.yaml`, and any plan with browser steps, need **jmeter-plugins-casutg**
on the runner — `verify` names the jar. On HyperExecute, upload it with the plan.

`mtls.yaml` needs a keystore; the comments at the top of that file have the
`openssl` commands to generate a throwaway set.
