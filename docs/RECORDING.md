# Recording and authoring a journey

This is the path BlazeMeter's Chrome recorder covers, and the one people ask for
first: *don't make me write a test — let me click through the app and get one.*

You record in **your own Chrome** — your profile, your SSO session, your VPN,
your feature flags. Nothing is proxied, nothing is uploaded, and the plan is
built in the browser.

---

## Record

**1. Open the popup** (toolbar icon, or `⌘⇧9` / `Ctrl+Shift+9`).

![The popup, idle](screenshots/popup-idle.png)

**2. Start.** Two ways, and the difference matters:

| | When to use it |
|---|---|
| **Start recording this tab** | you are already on the page you want to start from |
| the URL box → **Go** | you want request **#1** — the very first navigation, the redirect chain, the SSO bounce. It opens the URL in a new tab and attaches before anything is sent. |

Chrome shows a *"started debugging this browser"* banner. That is the DevTools
protocol attaching, and it is the only Chrome API that can read **response
bodies** — which correlation cannot work without.

**3. Browse.** Log in, click, submit, search. A panel appears on the page:

![The recording panel on a page under test](screenshots/panel-recording.png)

**4. Finish → build the plan.** The plan opens in a new tab, already generated.

![The popup while recording](screenshots/popup-recording.png)

---

## Author while you browse

A raw recording cannot know what a step *means*. The panel is where you tell it,
at the moment you are looking at the thing — not an hour later in a JMeter tree.

| Control | What it writes into the plan |
|---|---|
| **Transaction** | every request from here on lands in this Transaction Controller — this is what turns 200 requests into "Login / Search / Checkout" in the report |
| **Assert 200** | a response assertion on the last request |
| **Assert text…** | "body contains …" on the last request — the check that catches a 200 with an error page in it |
| **Extract…** | a JSON extractor: `$.data.token` → `${TOKEN}` |
| **Pause 2s** | a Flow Control Action pause after that request |
| **Rename…** | the sampler label |
| **Skip last** | drops that request from the plan |
| **+ Manual request…** | a request you type in — one that never happened, but has to be in the test |

Drag the panel by its title bar; `–` hides it, and it returns on the next
captured request or from the popup.

Everything you add travels inside the exported HAR as `_jmxgen` fields — a
custom key the HAR spec permits — so the file stays a valid HAR that DevTools
and every other tool still reads.

```json
{
  "pageref": "Login",
  "request":  { "method": "POST", "url": "https://shop.test/api/login" },
  "response": { "status": 200, "content": { "text": "{\"data\":{\"token\":\"…\"}}" } },
  "_jmxgen": {
    "name": "Login call",
    "assert": [{ "field": "body", "match": "contains", "pattern": "token" }],
    "extract": [{ "type": "json", "var": "TOKEN", "query": "$.data.token" }],
    "pause_after_ms": 2000
  }
}
```

---

## Two artifacts from one recording

The **record browser steps** checkbox in the panel is on by default, and its
counter climbs as you click. So a single session produces:

- a **protocol plan** (`.jmx`) — HTTP samplers, no browser, the thing that scales
  to thousands of users on a handful of machines;
- a **browser test** — the same journey as real clicks and typing, which is what
  proves the journey still works when the front end changes.

On the result page: **Download .jmx** and **Download browser test .py**. The
browser test is Playwright, and it uses ranked locators, not recorded XPaths:

```
data-testid  →  id (unless it looks generated)  →  name  →  aria-label
             →  link text  →  placeholder  →  scoped CSS  →  xpath
```

Each candidate is re-queried against the live DOM at capture time, and the first
one that actually resolves — uniquely — is the one written down. A recorder that
emits `/html/body/div[3]/div[2]/form/button` produces a script that breaks on the
next release; this is the difference between a recording you keep and one you
re-record every sprint.

If you want those browser steps inside the `.jmx` itself, they are emitted as
WebDriver samplers, which need `jmeter-plugins-webdriver` on the runner. The log
tells you so, by name, at generation time.

---

## Recording options

Under **Recording options** in the popup, applied live — changing one mid-session
pushes it to the attached tab, so you never throw away a recording to fix a
setting:

| Option | What it does |
|---|---|
| **Device** | iPhone 14, Pixel 7, iPad Pro, Galaxy S22, or desktop — sets the metrics *and* the user agent, so you capture the mobile site |
| **User agent** | override it by hand |
| **Blocked patterns** | drop hosts at capture time — analytics, chat widgets, anything you will never load-test |
| **Disable cache** | every asset is fetched, so the recording reflects a cold visit |
| **Bypass service worker** | requests hit the network instead of being answered from a worker cache |

`⌘⇧8` / `Ctrl+Shift+8` starts and stops recording without opening the popup.

---

## What gets thrown away, and why

A raw browser session is mostly not a load test. From the sample recording:

```
kept 3 of 58 recorded requests across 1 page(s)
  (dropped 42 static, 13 third-party, 0 filtered)
```

- **static** — images, fonts, CSS. A CDN serving a logo 500 times does not tell
  you anything about your API, and it drags the average response time down until
  the report is flattering and useless.
- **third-party** — analytics, tag managers, chat. Load-testing someone else's
  service is at best noise and at worst abuse.
- **filtered** — whatever you excluded yourself.

**Keep: web** keeps the assets, for when the page load *is* the thing you are
measuring. The same recording, either way — the decision is made at generation
time, not at record time, so you are never forced to re-record.

---

## Correlation, in one paragraph

Every recorded response is scanned for values that reappear in a later request:
bearer tokens, CSRF tokens, session ids, order ids. When one matches, the plan
gets an extractor on the first response and a `${VARIABLE}` in the second, and
the **Correlations** tab shows the rule that matched, the confidence, and the
exact hop:

```
${ACCESSTOKEN}   bearer-token   high   from body
                 POST /auth/login -> GET /auth/me
```

This is the difference between a recording and a test. Replay a recording
verbatim and it fails the moment the token expires — which is roughly always.

---

## Recording without the extension

For the cases a Chrome extension cannot reach, the same recorder exists in the
[jmxgen CLI](https://github.com/RishabhLambdaTest/jmxgen) — a separate
repository, needed only for these:

```bash
jmxgen record https://app.example.com -o plan.jmx   # Playwright drives a browser
jmxgen capture --port 8080 -o plan.jmx              # a proxy: mobile apps, Postman,
                                                    # desktop clients, backend traffic
```

Firefox is not supported and it is not a matter of effort: Firefox does not
implement `chrome.debugger`, so response bodies cannot be captured, so
correlation has nothing to work with. Use `jmxgen record` there.
