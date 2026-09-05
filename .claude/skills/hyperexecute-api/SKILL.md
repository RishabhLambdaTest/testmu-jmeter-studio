---
name: hyperexecute-api
description: Verified facts about the HyperExecute API as called from the extension - endpoints, the Origin/Referer requirement, wire key names, and how run-time overrides actually reach JMeter. Read before touching hx.js or run.js.
---

# The HyperExecute API, as it actually behaves

Everything here was confirmed against the live API, not read from docs.

## Endpoints

```
POST https://api-hyperexecute.lambdatest.com/logistics/v1.0/project
POST .../logistics/v1.0/project/{id}/files/upload          multipart
POST .../reception/api/project/{id}/trigger-job
GET  .../sentinel/v1.0/projects?per_page=100&type=jmeter   the project list
GET  https://api.hyperexecute.cloud/v2.0/job/{id}          status
GET  .../v2.0/job/{id}/artefacts  and  /v2.0/artefacts/{id}/download?name=JMeter
```

Auth is Basic with the LambdaTest **username** (not the sign-in email) and the
access key. The project list returns `data[]` with `id`, `name`, `type`,
`created_by`, and `metadata.next_cursor` / `total_count`. `type=jmeter` filters
server-side.

## The Origin trap

**HyperExecute rejects a request carrying `Origin: chrome-extension://<id>`
with a 403, and accepts the identical request with the dashboard's origin.**
Confirmed by sending both with curl: same credentials, same payload, 403 versus
200.

`Origin` and `Referer` are forbidden header names, so `fetch()` silently drops
whatever a script sets. `declarativeNetRequest` is the only MV3 API that can
set them, which is why `hx.js` installs a session rule scoped to
`api-hyperexecute.lambdatest.com` before every call. The permission is
`declarativeNetRequestWithHostAccess`.

If a 403 ever reappears: the credentials are not the first suspect. If an
upload has already succeeded, the same Authorization header was accepted
seconds earlier.

## Wire keys that are easy to get wrong

- The per-region user count is **`users`**, not `vusers`. An unknown key is
  dropped silently: `users: 4` at 2 per engine started 2 engines, `vusers: 4`
  started 1.
- **`max_vusers_per_vm`** is top level, not inside the jmeter entry.
- Do not send `platform`. HyperExecute assigns the cloud itself; a triggered
  job comes back with `"_platform": "azure"` in its task context and
  `platform: ""` in its YAML.

## The overrides do reach JMeter

Not just the engine count. A job sent as 1 user logs
`Starting thread group... threads=1` against a plan whose own default is 5; 4
users at 2 per engine gives two engines each logging `threads=2`.

An empty field means "whatever the `.jmx` carries", which is usually 1. It does
not mean a sensible default.

## Reading a failed run

A job can be marked **passed** while running zero samplers: every task exited
zero. The tells are `summary = 0 in 00:00:00`, an empty `<testResults/>`, and
`Error generating the report: NullPointerException`. Pull the JMeter artifact
and read `jmeter.log`; the cause is usually the plan, not the platform.
