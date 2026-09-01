# sample — one input per way in

Real inputs against [dummyjson.com](https://dummyjson.com), a public API that
needs no key. Each file feeds one command. Nothing here is a script; use the
file, or paste its contents into the console.

| File | Command | What it shows |
|---|---|---|
| `api.yaml` | `jmxgen from-openapi sample/api.yaml -o plan.jmx` | A contract with a path parameter — `{id}` becomes a variable, not the example value |
| `collection.json` | `jmxgen from-postman sample/collection.json -o plan.jmx` | Folders become Transaction Controllers; `pm.environment.set` becomes a JMeter extractor so `{{token}}` keeps working |
| `requests.txt` | `jmxgen from-curl sample/requests.txt -o plan.jmx` | Three DevTools-style commands, including a POST whose JSON body is sent raw, not URL-encoded |
| `recording.har` | `jmxgen from-har sample/recording.har --mode api -o plan.jmx` | **Correlation.** A real browser session — see below |
| `endpoints.xlsx` | `jmxgen from-excel sample/endpoints.xlsx -o plan.jmx` | The spreadsheet a non-technical colleague can own |
| `urls.txt` | `jmxgen probe sample/urls.txt -o plan.jmx` | No spec, no recording — it fetches the page and finds the assets itself |
| `users.csv` | `--csv sample/users.csv:username,password` | So 50 virtual users aren't all `emilys` |
| `workload.yaml` | `jmxgen build sample/workload.yaml -o plan.jmx` | `closed` vs `arrivals` thread groups side by side |
| `mtls.yaml` | `jmxgen build sample/mtls.yaml -o plan.jmx` | Client certificates. Also writes `system.properties` |

## The one to show first

`recording.har` is a genuine browser session: log in, call a protected endpoint,
search products — 58 requests including images, fonts and Google tag manager.

```
$ jmxgen from-har sample/recording.har --mode api -o plan.jmx

kept 3 of 58 recorded requests across 1 page(s)
  (dropped 42 static, 13 third-party, 0 filtered)
  correlated 1 value(s):
    ${ACCESSTOKEN}   bearer-token   high   from body
                     POST /auth/login -> GET /auth/me
```

Two things happened there. The noise was dropped — 42 assets and 13 tracker
requests that would have distorted the numbers. And the login token was found in
one response and wired into the next request as `${ACCESSTOKEN}`, with the rule
that matched, the confidence, and where it flows from and to.

Replay it recorded verbatim and it fails: the token has expired. That is the
whole problem correlation solves, and this file demonstrates it on real traffic.

Try `--mode web` on the same file to keep the assets instead — one recording,
either an API-level or a browser-level plan.

## Combining them

The pieces compose. A login that runs **once** for every user, with data from a
CSV:

```bash
jmxgen from-curl sample/requests.txt -o plan.jmx \
  --login "POST /auth/login" \
  --login-body '{"username":"${username}","password":"${password}"}' \
  --login-token '$.accessToken' \
  --csv sample/users.csv:username,password
```

The login becomes a setUp Thread Group and the token is published as a JMeter
*property*, not a variable — variables are per-thread, so a token extracted by
user 1 is invisible to users 2 through 500. Getting that wrong is the usual
reason a plan returns a wall of 401s under load but works fine with one user.

## After you have a plan

```bash
jmxgen replay plan.jmx                                  # one user, real target
jmeter -n -t plan.jmx -l r.jtl -e -o report/            # the load test
```

`replay` is the gate. It runs the plan once and reports per-request codes and
any `${VARIABLE}` that never resolved — cheaper than finding out at 500 users.

## Notes

`workload.yaml` and any plan with browser steps need **jmeter-plugins-casutg**
on the runner; `verify` names the jar. On HyperExecute you can upload it with
the plan.

`mtls.yaml` needs a keystore — the header comments in that file have the
`openssl` commands to generate a throwaway set.

Data files are resolved **relative to the .jmx**, so keep `users.csv` next to
the plan when you run it. `verify` warns when a referenced file is missing.
