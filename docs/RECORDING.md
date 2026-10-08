# Recording a journey

**Recording needs a TestMu AI login**, and so does taking a capture out of the
extension: Export HAR and Generate test plan are refused as well, so a capture
made before signing out cannot be exported afterwards. The check is in the extension's
background worker rather than the popup, because the popup is not the only way
to start one: the on-page panel and `Ctrl+Shift+8` go through the same place. A
signed-out popup says so and offers the login page; the panel and the shortcut
answer *sign in to TestMu AI to record*. Signing in once covers recording,
authoring and running, since all three read the same session.

**The panel does not go away while a recording is running.** Minimise shrinks
it to the dot and the count in the corner, and clicking that opens it again.
Collapsed or open is remembered by the recording rather than the page, so it
stays collapsed as you navigate instead of springing back at every page load.
Only the close button takes it off the page, and that stops the recording.

**The toolbar icon carries the count too**, so a recording is visible even with
the panel collapsed and the popup shut: red while recording, amber while
paused, and green afterwards for a recording that has not been built into a
plan yet.

This is the path people ask for first: don't make me write a test, let me click
through the app and get one.

You record in your own Chrome, with your profile, your SSO session, your VPN and
your feature flags. Nothing is proxied, nothing is uploaded, and the plan is
built in the browser.

## Recording

Two surfaces start a recording, and both drive the same session: the popup, and
the **Record a journey** card at the top of the authoring page. Whichever you
use, the other one shows the same state - the same count, the same pause, the
same recording offered back. Nothing is tied to the window you started in.

Open the popup with the toolbar icon, or `⌘⇧9` / `Ctrl+Shift+9`.

![The popup, idle](screenshots/popup-idle.png)

There are two ways to start, and the difference matters. **Start recording this
tab** attaches to the page in front of you, which is right when you are already
where you want to begin. Typing a URL in the box and pressing **Go** opens it in
a new tab and attaches before anything is sent, so you capture request number
one: the first navigation, the redirect chain, the SSO bounce. Those are exactly
the requests a plan needs and the ones an already-open tab has missed.

Chrome then shows a banner saying the extension started debugging this browser.
That is the DevTools protocol attaching, and it is the only Chrome API that can
read response bodies, which correlation cannot work without.

Now browse. Log in, click, submit, search. A panel appears on the page:

![The recording panel on a page under test](screenshots/panel-recording.png)

When you are done, press **Finish → build the plan**. The plan opens in a new
tab, already generated.

![The popup while recording](screenshots/popup-recording.png)

## Recording from the full page

The popup is small on purpose, and a recording is not the only thing you do with
one. The authoring page carries the same controls, so a long session can be
recorded, built, filtered and run without ever going back to a 360-pixel panel.

Open it with **+** in the popup's title bar, which opens the studio in its own
window, or with *Author from a file or spec…*. At the top:

| Control | What it does |
|---|---|
| Record from a URL | opens that URL in a new tab and attaches before the first byte, the same as **Go** in the popup |
| Pause | stops capturing without ending the session |
| Stop and build | ends the session and generates the plan on the page you are already on |
| Build the plan | offered when a recording is waiting - one you stopped, or one left on disk when Chrome closed |
| Discard | throws the recording away |

The dot and the counter next to the legend say what the session is doing:
grey idle, red recording, amber paused, green stopped with requests waiting.
They follow the background worker, so starting from the popup and stopping from
the page - or the reverse - works and is the normal way to use it.

Everything else on that page still applies to the recording you just took: the
host list, transactions, the load profile, **Test type**, and *Run on
HyperExecute…*.

## The window controls

Every surface - popup, authoring page, run page - carries the same three
buttons in the title bar, in the order Chrome and macOS use left to right:
**close, minimise, maximise**.

| Button | In its own window | In a tab |
|---|---|---|
| × | closes the window | closes the tab |
| − | minimises the window | goes back to the previous page |
| + | maximise, and back to the previous size on a second press | full width, and back |

The page checks which of the two it is in and relabels the buttons, so they
never offer something they cannot do. From the popup, **+** opens the studio in
its own window at 1180×900 - a real window you can move, resize and leave open
beside the app you are testing. If a studio *tab* is already open it is focused
instead, because two authoring surfaces would fight over the same session.

## Annotating as you browse

A raw recording cannot know what a step means. The panel is where you say so, at
the moment you are looking at the thing, rather than an hour later in a JMeter
tree.

| Control | What it writes into the plan |
|---|---|
| Transaction | every request from here on lands in this Transaction Controller, which is what turns 200 requests into Login, Search and Checkout in the report |
| Assert 200 | a response assertion on the last request |
| Assert text… | "body contains …" on the last request, the check that catches a 200 carrying an error page |
| Extract… | a JSON extractor: `$.data.token` becomes `${TOKEN}` |
| Pause 2s | a Flow Control Action pause after that request |
| Rename… | the sampler label |
| Skip last | drops that request from the plan |
| + Manual request… | a request you type in, one that never happened but has to be in the test |

**Pause** in the popup stops recording without ending the session: nothing that
happens meanwhile is captured, and the panel's dot goes grey. It is for the
parts of a journey that should not be in the test - signing in by hand,
dismissing a cookie banner, fixing test data - and for the moment when you want
to look something up mid-recording. Press it again to carry on.

Drag the panel by its title bar. The `–` button hides it, and it comes back on
the next captured request or from the popup.

Everything you add travels inside the exported HAR as `_jmxgen` fields, a custom
key the HAR spec permits, so the file stays a valid HAR that DevTools and other
tools still read.

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

## Two artifacts from one session

The *record browser steps* checkbox in the panel is **on by default**, and its
counter climbs as you click. The setting belongs to the recording, so it
survives navigations and transactions until you change it again.

It used to be off, which put the decision in the wrong place: whether a
recording becomes an API test or a browser test is chosen afterwards, on the
authoring page, but whether it *could* become a browser test was decided here,
before anyone knew which they wanted. Choosing Browser afterwards then failed
and the only way back was to record the whole journey again. The steps cost a
few hundred bytes for a long session, so they are kept unless you say
otherwise. One session gives you two things.

The protocol plan, a `.jmx` of HTTP samplers with no browser involved, is what
scales to thousands of users on a handful of machines. The browser test is the
same journey as real clicks and typing, and it is what proves the journey still
works when the front end changes.

Both are on the result page: **Download .jmx** and **Download browser test .py**.
The browser test is Playwright, and it uses ranked locators rather than recorded
XPaths:

```
data-testid  →  id (unless it looks generated)  →  name  →  aria-label
             →  link text  →  placeholder  →  scoped CSS  →  xpath
```

Each candidate is re-queried against the live DOM at capture time, and the first
that resolves uniquely is the one written down. A recorder that emits
`/html/body/div[3]/div[2]/form/button` produces a script that breaks on the next
release. This is the difference between a recording you keep and one you redo
every sprint.

## API test or browser test

The same recording builds either kind of `.jmx`. Choose under **Test type** on
the authoring page, in Load profile:

| Test type | What the `.jmx` runs | Users per engine |
|---|---|---|
| **API** (default) | the recorded HTTP requests | thousands |
| **Browser** | the recorded clicks and typing, in real headless Chrome, as WebDriver samplers | **4** |

A plan is one or the other, never both. A run-time user count applies to every
thread group, so a plan carrying both would run as many browsers as protocol
users. Tools that offer both keep them apart for the same reason, and converge
on the same handful of browsers per engine.

A browser test needs the clicks, and *record browser steps* is on by default,
so an ordinary recording already carries them. Built from a recording made with
it switched off, it stops and says so.

**Chrome path.** Blank means the runner's own Chrome 141 and its chromedriver,
which is what HyperExecute's Linux runners carry. A chromedriver only drives the
Chrome version it was built for, so a different Chrome also needs its own
driver: set `webdriver.driver_path` in the spec editor.

The Playwright script is still available with either test type.

## Recording options

These sit under *Recording options* in the popup and apply live, so changing one
mid-session pushes it to the attached tab. You never have to throw away a
recording to fix a setting.

| Option | What it does |
|---|---|
| Device | iPhone 14, Pixel 7, iPad Pro, Galaxy S22 or desktop. Sets the metrics and the user agent together, so you capture the mobile site |
| User agent | override it by hand |
| Blocked patterns | drop hosts at capture time: analytics, chat widgets, anything you will never load-test |
| Disable cache | every asset is fetched, so the recording reflects a cold visit |
| Bypass service worker | requests hit the network instead of being answered from a worker cache |

`⌘⇧8` / `Ctrl+Shift+8` starts and stops recording without opening the popup.

[OPTIONS.md](OPTIONS.md) works through each of these with an example, along with
every other control in the extension. [TRANSACTIONS.md](TRANSACTIONS.md) covers
step naming and what the report ends up calling things, with screenshots.

## Recording for an hour

There is no limit on how long you record, and nothing is sampled or dropped
along the way. What makes that work is being selective about *bytes* rather
than about requests.

Every request is stored. For service calls and pages that means the method,
URL, headers, body, status and response text: everything the plan is built
from. For images, fonts, stylesheets and scripts it means a stub, because their
content cannot appear in a `.jmx` — a font's bytes cannot be asserted on,
correlated, or sent by a sampler. Their URL, method and type are kept, which is
all a `web` plan ever needs, so one recording still authors either kind of plan
without keeping a megabyte of CSS.

Measured on a real session of 241 requests, 200 of them images: 241 entries and
41 bodies on disk. The images cost nothing but their addresses.

The recording is written to IndexedDB as it happens, which means:

- it is on disk, not in memory, so an hour-long session costs the browser
  nothing to hold;
- it survives Chrome evicting the extension's worker, which happens routinely
  during quiet stretches;
- it survives closing Chrome altogether, and is offered back when you return.

A realistic hour on an API-heavy application is roughly 3,000 service calls and
70 MB. The browser grants gigabytes, and the popup shows the headroom.

## Single-page apps record almost nothing

Click through five screens of a React, Vue or Docusaurus site and the recording
holds one page load and a pile of javascript. The browser never asked the server
for the next page: it fetched a bundle and redrew. Nothing was lost and nothing
is broken - there simply is no second page request to record, so there is no
second sampler to build.

The authoring log says so when it sees the shape of it, plenty fetched and
almost nothing navigated:

```
16 requests but no page loads at all - this looks like a single-page app.
Clicking through it does not ask the server for new pages, so there is little
for a protocol test to replay. The 12 API call(s) it made are the part worth
testing.
```

That last sentence is the useful one. What an app of this kind actually asks
the server for, while it redraws, is its API, and that is what a protocol test
should carry. If the journey matters as *clicks* rather than as calls, build it
as a browser test instead, where the steps are the point.

## Which sites a recording has been to

The recorder follows a **tab**, not a site. That is deliberate, and it is what
makes an SSO hop or a payment redirect record properly: the journey leaves your
application, comes back, and the whole exchange is captured.

It also means a tab taken somewhere else mid-session is captured too. Open your
mail in the recorded tab and your mail is in the recording.

So the panel lists every site a recording has been through, and says so the
moment a new one appears:

```
recording 2 sites: shop.example.com, accounts.example.com
```

The capture is not stopped - stopping it would break the redirect journeys
worth recording. The point is that it is no longer silent, so a session is never
shared without its author knowing where it has been. Nothing leaves the browser
either way; see **Where the recording lives** in [SETUP.md](SETUP.md).

## What gets thrown away

A raw browser session is mostly not a load test. From the sample recording:

```
kept 3 of 58 recorded requests across 1 page(s)
  (dropped 42 static, 13 third-party, 0 filtered)
```

CORS preflights go first. A browser sends `OPTIONS` before a cross-origin call
because its security model requires it; JMeter has no such model and never
sends one, so a preflight sampler would measure a request that does not happen
and double the request count of every cross-origin API. They are recognised by
the `Access-Control-Request-*` header, so a real `OPTIONS` endpoint you mean to
test is still kept.

Static assets go next: images, fonts, CSS. A CDN serving a logo 500 times tells
you nothing about your API, and it drags the average response time down until the
report is flattering and useless. Third-party requests follow: analytics, tag
managers, chat. Load-testing someone else's service is noise at best. Anything
you excluded yourself is counted as filtered.

**Which hosts stay.** The Studio keeps one site: the busiest domain that is not
a tracker, with every subdomain of it, so `app.example.com`, `api.example.com`
and `auth.example.com` all stay without any ticking. Country and hosting
endings are read as part of the name: the site for `shop.example.co.uk` is
`example.co.uk`, not `co.uk`, and `myapp.herokuapp.com` is its own site. The
**Hosts in this recording** panel on the result page lists every host with its
request count; tick one there when your system also runs on another domain, such
as a login or payment service, and rebuild. A long list gets a filter box.

Deciding which hosts belong in a plan is a choice the better tools all offer in
some form, and a converter that simply keeps every host hands you a plan that
load-tests somebody else's analytics along with your application.

*Keep: web* keeps the assets, for when the page load is the thing you are
measuring. It is the same recording either way, because the decision is made at
generation time rather than at record time, so you are never forced to record
again.

## Correlation

Every recorded response is scanned for values that turn up in a later request:
bearer tokens, CSRF tokens, session ids, order ids. When one matches, the plan
gets an extractor on the first response and a `${VARIABLE}` in the second, and
the Correlations tab shows the rule that matched, the confidence, and the exact
hop.

```
${ACCESSTOKEN}   bearer-token   high   from body
                 POST /auth/login -> GET /auth/me
```

This is what separates a recording from a test. Replay a recording as it stands
and it fails the moment the token expires, which is to say almost immediately.

**Two questions, not one.** The first is what a value looks like: a rule
recognises a ViewState or an OAuth code by name, and failing that a value long
and random enough to be an id rather than a constant. That misses an entire
class of them. A server-issued id that happens to be readable - `cart-9912`,
`ord-1042`, a plain row id - looks exactly like a constant, and on a session
built from those the scan found nothing at all while the plan still reported no
problems. Every virtual user then replayed one recorded id.

So when the first question comes up empty there is a second: **who said it
first**. A client cannot send a value the server has not yet given it, so a
value carried by a response and only afterwards by a request is dynamic by
construction, whatever it looks like.

The ordering is also what keeps constants out, and that matters more than the
catching does. A locale, an api version, a page size is sent by the client from
the first request, before any response could have carried it, so it never
qualifies however often it recurs.

**An extractor also asserts.** A JMeter extractor that finds nothing does not
fail its sampler - it writes its default and the test carries on, and the run
fails several steps later at the first request that used the missing value, with
the report pointing at a healthy service. So every correlation adds an assertion
to the response that should have carried the value. These never fire on a
response that still carries what was recorded, which is why they are on by
default: anything they catch is a real change.

**A cap, and it says so.** At most 60 values are wired in one plan, so a
pathological session cannot produce a plan that is mostly extractors. Anything
past that is reported rather than dropped in silence:

```
60 correlated, 251 more dynamic value(s) were found and NOT wired -
the plan stops at 60. Narrow the recording, or raise the limit.
```

**And when nothing correlates**, that is said too, because on a journey that
signs in or carries a cart it is the single most useful thing to know before
spending a run.

## Recording without the extension

For the cases a Chrome extension cannot reach, the same recorder exists in the
[jmxgen CLI](https://github.com/RishabhLambdaTest/jmxgen), a separate repository
needed only for these:

```bash
jmxgen record https://app.example.com -o plan.jmx   # Playwright drives a browser
jmxgen capture --port 8080 -o plan.jmx              # a proxy: mobile apps, Postman,
                                                    # desktop clients, backend traffic
```

Firefox is not supported, and not for want of effort. It does not implement
`chrome.debugger`, so response bodies cannot be captured, so correlation has
nothing to work with. Use `jmxgen record` there.
