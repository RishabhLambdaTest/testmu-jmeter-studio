---
name: jmeter-studio
description: Architecture, conventions and settled design decisions for the TestMu AI JMeter Studio Chrome extension. Read before changing the extension, the engine, or the docs.
---

# JMeter Studio

A Chrome extension that authors JMeter `.jmx` plans from seven sources and
triggers runs on HyperExecute. Everything runs in the browser: the engine is
`jmxgen.py` executed by Pyodide in WebAssembly.

## The shape

```
popup.html / overlay.js   record a journey, annotate it as you browse
author.html               choose a source, generate, inspect, edit
run.html                  create/pick a project, upload, trigger
background.js             CDP capture, the recording session
db.js                     IndexedDB capture store
engine.js                 Pyodide host: author(), rebuild(), rebuildYaml()
jmxgen.py                 the engine, shared with the jmxgen CLI repo
```

k6 Studio arrived at the same three screens independently (recorder, generator,
validator). That is the shape; do not add a fourth.

## The one rule that keeps the rest simple

**The spec is the truth. The `.jmx` is derived from it, always.**

Every edit mutates the spec and rebuilds. Nothing edits XML. This is why an
edited plan is exactly what the spec says, why every rebuild runs the same
validation as a fresh plan, and why the UI can stay small: anything the form
cannot express is reachable through the spec editor rather than a new field.

When tempted to add a control to a form, ask whether the spec editor already
covers it.

## Settled decisions, and why

**The palette is the TestMu AI dashboard's, and `brand.css` is the only place
it lives.** The tokens are lifted from the `--lt-*` design tokens the dashboard
ships (its stylesheets are public assets even though the page needs a login:
`automation.lambdatest.com/builds/*/static/css/*.css`). Three mappings are easy
to get wrong and all three look "nearly right":

- the **canvas is grey** (`#f6f8fa`) and the **cards on it are white**, not the
  reverse
- the primary action is **green** `--lt-bg-primary` `#1f883d`. The orange
  `--lt-bg-brand-primary` `#ed5f00` is the dashboard's "Upgrade Now" upsell
  only — nothing in this extension may use it
- the logo is **monochrome `#121212`**, a bare glyph and not a coloured tile.
  It is the official mark from `testmuai.com/favicon_black.svg`, inlined as
  four paths, with "JMeter Studio" under the wordmark

Links are `#0969da`, radii are a 6px system, and disabled controls take a flat
neutral fill — never `opacity`, which on a light ground turns a filled button
into unreadable pale-on-white. `overlay.css` cannot see these tokens (it is
injected into pages that never load `brand.css`), so it repeats the literals and
has to be changed alongside.

When matching a screenshot of the dashboard, take *values* from its stylesheet
and use the screenshot only to learn *which* token goes where: macOS captures
are P3 read as sRGB, so sampled pixels come back desaturated (that green
samples `#499259`, the orange `#b96530`) and building a palette from them
produces something subtly wrong.


**Browser steps stay out of the `.jmx`.** A WebDriver sampler needs a Chrome
per thread and a chromedriver on the runner, and HyperExecute's user override
applies to every thread group, so one browser user becomes two hundred
browsers. The journey ships as the Playwright script instead. A driver config
must never sit at plan level: `threadStarted` runs for every thread in every
group, so a missing chromedriver takes the protocol samplers down with it.

**Recorded think times are on by default.** Without them each user replays the
journey as fast as the server answers, which pins a CPU with two users and
measures saturation rather than load.

**Placeholders describe the field or name what blank does. They are never
example values.** "azure (optional)" cost a customer real time by reading as a
setting. The examples belong in the docs, where they can be explained.

**Only two fields are genuinely prefilled:** regions (`eastus`) and max users
per engine (`2000`). Say so in the docs rather than implying they are empty.

**An edit that introduces a warning is reported as loudly as an error.**
Deleting a request another one extracts a token from leaves a plan that builds,
runs, and fails at load with 401s. Compare verify output before and after, and
report what is new.

**Deliberately not built:** SAP GUI, Citrix, service virtualisation, team
workspaces, scheduling, cross-run trends. Trends belong in the HyperExecute
dashboard, which already has the job history.

## Traps that have bitten before

- `esc()` must drop characters XML 1.0 cannot carry. Escaping does not rescue
  them: `&#31;` is invalid too. One byte from a protobuf response poisons a
  whole plan.
- Substitution must match whole values. Replacing `emilys` inside `emilyspass`
  produces `${USERNAME}pass` and corrupts a password while reporting success.
- `display: grid` on `.grid2` outranks the default `[hidden]` rule, so setting
  `.hidden` on a grid row silently does nothing.
- An affordance revealed only on hover is one most people never find.
- The recording is one session, cleared when the next begins. It lives in
  IndexedDB (`jmxgen-capture`), not a file. Export HAR is the only portable copy.

## Docs

`README.md` plus `docs/`: SETUP, SOURCES, RECORDING, TRANSACTIONS, EDITING,
OPTIONS, COMPARISON. When behaviour changes, the doc changes in the same
commit. COMPARISON is meant to be honest about where BlazeMeter is ahead.
