# Platform APIs this extension depends on

JMeter Studio is a Chrome extension that authors a JMeter plan or a k6 script
in the browser and runs it on HyperExecute. It has no backend of its own: every
call below goes straight from the extension to a LambdaTest host, with the
signed-in user's own credentials.

Four of those hosts are dashboard-internal. They work, but nothing about them
is published, versioned or promised, so the extension is one silent change away
from breaking in the field. **This page is the ask to the platform team: a
supported, documented surface for the calls marked "internal" below.**

## What is called today

Auth is Basic `username:apiToken` unless stated otherwise. The pair comes from
the account service, not from anything the user types.

| # | Call | Host | Status | What the extension needs from it |
|---|------|------|--------|----------------------------------|
| 1 | `GET /api/user` (Bearer `accessToken` cookie) | `accounts.lambdatest.com` | internal | `username` + `apiToken`, so the user signs in with Google/GitHub/SSO instead of pasting an access key |
| 2 | `GET /api/user` | `auth.hyperexecute.cloud` | internal | `organization.id`, `organization.plan_attributes` — the perf entitlement, VU/VUH/job/duration ceilings |
| 3 | `GET /api/org_preferences/{orgID}` | `auth.hyperexecute.cloud` | internal | `HYPEREXECUTE_PERF_ALLOWED_REGIONS` — which regions this org may actually pick |
| 4 | `GET /sentinel/v1.0/projects?per_page=100&type=jmeter` | `api-hyperexecute.lambdatest.com` | internal | list the user's projects so they can pick one instead of hunting for an ID |
| 5 | `POST /logistics/v1.0/project` `{name, jmx:[], type}` | `api-hyperexecute.lambdatest.com` | internal | create a project |
| 6 | `POST /logistics/v1.0/project/{id}/files/upload` (multipart) | `api-hyperexecute.lambdatest.com` | internal | upload the `.jmx`, CSVs, k6 script |
| 7 | `POST /reception/api/project/{id}/trigger-job` | `api-hyperexecute.lambdatest.com` | internal | start a JMeter load job (`jmeter[]`, `max_vusers_per_vm`, `globalTimeout`, `concurrency`) |
| 8 | `POST /reception/api/v1.0/trigger-job` `{hyperExecuteConfig, triggerSource}` | `api-hyperexecute.lambdatest.com` | internal | start a k6 job from an inline YAML config |
| 9 | `GET /sessions?limit=N` | `api.lambdatest.com/automation/api/v1` | public host | list recent automation sessions |
| 10 | `GET /sessions/{id}/log/network.har` | `api.lambdatest.com/automation/api/v1` | public host | the traffic a recorded session produced, which becomes the plan |
| 11 | `GET /sessions/{id}/log/full-har` | `api.lambdatest.com/automation/api/v1` | public host | the zipped per-page HARs, used when `network.har` is missing or truncated |
| 12 | `GET /sessions/{id}/log/command` | `api.lambdatest.com/automation/api/v1` | public host | the WebDriver commands, used to name steps after the actions that caused them |

Rows 9–12 sit on the published automation API host and are the ones we are
comfortable with, though `full-har` and `log/command` are thinner in the docs
than `network.har`. Everything else is borrowed.

## The asks, in priority order

**1. A documented plan-and-entitlement endpoint (rows 2 and 3).**
This is the most valuable one and the one with no alternative. The extension
has to know, before it lets anyone press Run: is performance testing enabled,
what is the VU ceiling, the monthly VUH allowance, the maximum job length, and
which regions are selectable. Today that means reading `plan_attributes` off a
LUMS user object and a second call for an org preference, and inferring the
free tier's ceilings from behaviour rather than from anything the API returns.

What we would like: one call, e.g. `GET /v1/entitlements/performance`, that
returns the effective limits for the caller — resolved, not raw attributes —
plus the allowed regions and the current period's usage. Three properties
matter more than the shape:

- it returns the *effective* numbers, including the free-tier defaults, rather
  than leaving the client to reimplement the server's fallback logic
- `-1` for unlimited keeps its meaning, and is documented as such
- the region list is the same list the dashboard's own region picker shows

Two behaviours we reverse-engineered and would want stated in the contract,
because we currently guess: an account with unmetered HyperExecute minutes and
no perf flag is refused (unlimited being worse than metered is surprising), and
a global timeout over the tier's cap is silently clamped rather than rejected.

**2. A public trigger that does not need a spoofed `Origin` (rows 7 and 8).**
`/reception/*` answers `403` when the `Origin` is anything but the dashboard —
with credentials it accepted a second earlier on `/logistics`. In MV3 the only
way to set `Origin` and `Referer` is a `declarativeNetRequest` session rule, so
the extension installs one rule that rewrites both headers for that host alone.
It works, it is scoped, and it is obviously not how a supported integration
should authenticate. A trigger that accepts Basic auth from any origin — or an
allow-list that API clients can be added to — removes the hack entirely.

**3. Documented project create/list/upload (rows 4–6).**
Low risk, high annoyance: three different path prefixes (`sentinel`,
`logistics`, `reception`) for one workflow, and the create response spells the
id four different ways across environments (`id`, `projectId`, `projectID`,
`data.id`) so we read all four. Stable naming and one prefix would do.

**4. A first-class login/token exchange (row 1).**
Reading the `accessToken` cookie and exchanging it at `accounts.lambdatest.com/api/user`
is how we avoid asking users for an access key — a real usability win, and the
same thing the dashboard does. A supported equivalent (a token exchange, or an
OAuth client an extension can register) would let us keep that experience
without depending on a cookie name.

## Two smaller platform items, not APIs

- **k6 has no `frameworkName`.** Naming the k6 HTML dashboard as a Playwright
  report fails the report step outright, so the dashboard currently rides along
  as an artefact and the Reports tab shows only HyperExecute's own summary.
  A `k6` framework would move it to Reports where users look for it.
- **The free tier reports the same 20 VUH for the month and the year.** Either
  the yearly cap is genuinely 20, in which case it is worth stating, or the
  attribute is unset and defaulting to the monthly value.

## Why this matters now

Every internal call above is a dependency the platform team does not know it
has. If any of them changes shape, the failure lands on a customer mid-demo,
and the only signal is a 4xx in an extension log. Publishing rows 1–8 — or
replacing them with fewer, better endpoints — turns that into a versioned
contract on both sides.
