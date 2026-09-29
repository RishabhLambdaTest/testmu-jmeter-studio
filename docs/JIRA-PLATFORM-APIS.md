**Summary:** Public APIs for the internal endpoints JMeter Studio calls

## Context

JMeter Studio is a Chrome extension that builds a JMeter plan or k6 script in
the browser and runs it on HyperExecute. It has no backend — every call goes
from the extension directly to a LambdaTest host using the signed-in user's own
credentials (Basic `username:apiToken`).

The endpoints below are dashboard-internal: not published, not versioned, so a
change to any of them breaks the extension with no warning. We need public
equivalents.

## Unpublished APIs in use

| Endpoint | Used for |
|---|---|
| `GET accounts.lambdatest.com/api/user` (Bearer `accessToken` cookie) | Exchanges the browser login for `username` + `apiToken`, so users sign in with Google/GitHub/SSO instead of pasting an access key |
| `GET auth.hyperexecute.cloud/api/user` | `organization.id` and `plan_attributes` — perf enabled, max VUs, VUH allowance, max jobs, max job duration |
| `GET auth.hyperexecute.cloud/api/org_preferences/{orgID}` | `HYPEREXECUTE_PERF_ALLOWED_REGIONS` — which regions the org may select |
| `GET api-hyperexecute.lambdatest.com/sentinel/v1.0/projects?type=jmeter` | Lists the user's projects to pick from |
| `POST api-hyperexecute.lambdatest.com/logistics/v1.0/project` | Creates a project |
| `POST api-hyperexecute.lambdatest.com/logistics/v1.0/project/{id}/files/upload` | Uploads the `.jmx`, CSV data files and k6 script |
| `POST api-hyperexecute.lambdatest.com/reception/api/project/{id}/trigger-job` | Starts a JMeter load job (users, ramp-up, duration, regions, max VUs per VM) |
| `POST api-hyperexecute.lambdatest.com/reception/api/v1.0/trigger-job` | Starts a k6 job from an inline HyperExecute YAML config |

## Note

`/reception/*` returns `403` unless `Origin` is the dashboard, even with
credentials it accepted on `/logistics` a second earlier. Chrome MV3 cannot set
`Origin`, so the extension rewrites `Origin` and `Referer` for that host with a
`declarativeNetRequest` rule. A public trigger accepting Basic auth from any
origin would remove that.
