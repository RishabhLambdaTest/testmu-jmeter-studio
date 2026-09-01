# Setup — from a zip to a running load test

Everything in this guide happens inside Chrome. There is no CLI to install, no
Python, no JMeter, no local server, no account to create. The plan is built by an
engine that ships inside the extension and runs in WebAssembly, and the run is
triggered straight against the HyperExecute API.

Time from receiving the zip to a job on the dashboard: about five minutes.

This page is meant to be complete. If you find yourself needing to ask someone a
question, that is a gap in this page — say so, and it gets fixed here.

**Contents**

1. [Which zip, and why there are two](#1-which-zip-and-why-there-are-two)
2. [Install it](#2-install-it)
3. [Your first plan, without recording anything](#3-your-first-plan-without-recording-anything)
4. [Recording a journey instead](#4-recording-a-journey-instead)
5. [Running it on HyperExecute](#5-running-it-on-hyperexecute)
6. [Updating, moving and removing it](#6-updating-moving-and-removing-it)
7. [Troubleshooting — every error, and what it means](#7-troubleshooting)
8. [Questions people ask before installing](#8-questions-people-ask-before-installing)
9. [Rolling it out to a team](#9-rolling-it-out-to-a-team)

---

## 1. Which zip, and why there are two

`dist/` holds two files. They contain **exactly the same extension** — the only
difference is whether there is a folder inside the zip.

```
testmu-recorder-1.1.0-share.zip          ←  this is the one you want
  └── testmu-recorder/
        manifest.json
        background.js
        popup.html …

testmu-recorder-1.1.0.zip                ←  only for submitting to the Chrome Web Store
  ├── manifest.json
  ├── background.js
  ├── popup.html …
```

| File | Who it is for | Why that shape |
|---|---|---|
| **`-share.zip`** | **you, and anyone you send it to** | Unzips to one `testmu-recorder` folder, which is exactly what *Load unpacked* asks you to select |
| `.zip` (no suffix) | whoever submits it to the Chrome Web Store | The store requires `manifest.json` at the top level and **rejects** an upload with a wrapper folder around it |

Use the wrong one and it fails in an irritating rather than obvious way: the
store rejects the `-share` build, and a person who unzips the store build gets
twenty loose files spread through their Downloads folder with no folder to
select.

**Rule of thumb: if a human is going to unzip it, send `-share.zip`.**

### Where to get it

Either from the repository —

```bash
git clone https://github.com/RishabhLambdaTest/testmu-recorder.git
open testmu-recorder/dist        # the two zips are here
```

— or from the file itself on GitHub:
`dist/` → `testmu-recorder-1.1.0-share.zip` → **Download raw file** (the button
at the top right; GitHub cannot preview a zip, so there is nothing else on that
page). The `raw.githubusercontent.com` link does **not** work on its own while
the repository is private, which is why a pasted link can look broken.

### Rebuilding them

After any change to the extension:

```bash
jmxgen-recorder/package.sh
#   dist/testmu-recorder-<version>.zip          store shape
#   dist/testmu-recorder-<version>-share.zip    folder shape
```

The version in the filename comes from `manifest.json`, so what someone
installed can always be traced back to a commit. `package.sh` ships an explicit
file list and fails if the manifest references anything not on it, so a release
can never be missing a page.

---

## 2. Install it

### Step 1 — unzip

Unzip somewhere you will not delete or move. Chrome does not copy an unpacked
extension; it loads it from wherever it sits, so moving the folder later
disables it.

```
~/Downloads/testmu-recorder/
```

### Step 2 — open the extensions page

`chrome://extensions` — Chrome, Edge, Brave, Arc, Opera, anything Chromium.
Chrome 116 or newer (the extension is Manifest V3 and uses offscreen documents).

### Step 3 — turn on Developer mode

Top right. Three buttons appear on the left when it is on.

![chrome://extensions with Developer mode on and the extension card loaded](screenshots/setup-load-unpacked.png)

### Step 4 — Load unpacked, and pick the folder

Select the `testmu-recorder` folder **itself** — the one that directly contains
`manifest.json`. Not the zip, not the folder above it.

A card appears with the violet mark, the name **TestMu AI — JMeter Recorder**,
and a version. That is it — it is installed.

### Step 5 — pin it

Click the puzzle-piece icon in the toolbar, then the pin beside the extension.
The violet mark appears in the toolbar; that is how you open it.

Keyboard, if you prefer: `⌘⇧9` (`Ctrl+Shift+9`) opens the popup, `⌘⇧8`
(`Ctrl+Shift+8`) starts and stops recording.

---

## 3. Your first plan, without recording anything

The fastest way to see it work, and it needs nothing but a browser.

Click the toolbar icon:

![The extension popup, idle](screenshots/popup-idle.png)

Under **Author from something else**, click **cURL**. The authoring page opens:

![The authoring page with the source picker](screenshots/author-source.png)

Paste one or more curl commands into the box. Any request will do — in DevTools,
right-click a request → **Copy → Copy as cURL**. Or use the ready-made ones in
[`sample/requests.txt`](../sample/requests.txt), which point at a public API and
need no credentials.

Set **Users**, **Ramp** and **Duration** if you want (they are a starting point;
HyperExecute can override all three at run time), then press **Generate plan**:

![A plan generated from curl commands](screenshots/author-curl-result.png)

You now have a JMeter test plan. **Download .jmx** saves it. The tabs show what
the engine decided:

- **Requests** — every sampler, its group, method, path and checks
- **Correlations** — dynamic values it wired between requests, with the rule that
  matched, a confidence, and the exact hop
- **Checks** — results of a single-user validation run, when you have run one

The **Log** panel at the bottom carries everything the engine did, including any
warning about a JMeter plugin the runner will need. **Copy** puts the whole log
on the clipboard — that is the thing to send if you ever do need help.

Every other source works the same way. Each one has a sample file in
[`sample/`](../sample/) that you can run today, and
[SOURCES.md](SOURCES.md) walks through what to look for in each result.

---

## 4. Recording a journey instead

Full detail is in [RECORDING.md](RECORDING.md); the short version:

1. Open the popup.
2. To capture the very first request — the initial navigation, the redirect
   chain, the SSO bounce — type the URL in the box and press **Go**. To record
   the page already in front of you, press **Start recording this tab** instead.
3. Browse. A panel appears on the page where you name transactions and attach
   assertions, extractors and pauses as you go.
4. **Finish → build the plan.** The plan opens in a new tab, already generated.

Chrome will show a banner saying the extension *started debugging this browser*.
That is expected and it is not a warning: attaching the DevTools protocol is the
only way to read **response bodies**, which is what correlation needs. Dismissing
that banner stops the recording.

---

## 5. Running it on HyperExecute

**Run on HyperExecute…** opens the run page with the plan already attached:

![The HyperExecute run form](screenshots/run-hyperexecute.png)

### What to put in each field

| Field | What it wants |
|---|---|
| **Username** | Your LambdaTest **username** — not the email you sign in with. Both are at `accounts.lambdatest.com/detail/profile` |
| **Access key** | From the same page |
| **Remember on this machine** | Stores both in Chrome's extension storage, on this profile only. Nothing is sent anywhere else |
| **New project name** | Anything. Creating a project that already exists is an error, so… |
| **…or existing project ID** | …paste an ID here instead to add a run to a project you already have. Fill in one or the other, not both |
| **Name for the recorded plan** | The filename the `.jmx` gets on the runner |
| **Add .jmx, .jar, .properties or data files** | Anything else the run needs: a CSV of test data, a plugin jar the log asked for, a `system.properties` |
| **Which .jmx should the job run** | Pick one, when more than one was uploaded |
| **Regions** | `eastus` by default. Comma-separate for a multi-region run |
| **Max users (total VU)** | Total virtual users across the whole job |
| **Max users per engine** | How many each machine carries — total ÷ this = how many machines spin up |
| **Ramp-up / Duration** | Seconds. **These override whatever the `.jmx` says** |
| **Global timeout** | Minutes, optional. A hard stop for the whole job |
| **Job label** | Optional, shows on the dashboard |
| **Split CSV rows across engines** | Each machine gets a distinct slice of the data file, instead of every machine replaying the same rows |

Then **Create & trigger**. The log prints the project id, every uploaded file and
the job id as they happen, and the dashboard opens.

**Upload only** does everything except starting the job — useful when someone
else triggers runs, or when you are staging files for a scheduled run.

### Where your credentials go

From the form to LambdaTest, and nowhere else. The extension calls the
HyperExecute API directly from your browser — there is no server in the middle,
and nothing is proxied through a third party.

---

## 6. Updating, moving and removing it

**A new version.** Unzip the new `-share.zip` over the old folder (replacing its
contents), then press the ↻ **reload** icon on the extension's card in
`chrome://extensions`. Your saved settings survive, because the extension keeps
its identity as long as the folder path does.

**Moving the folder** disables the extension — Chrome loads it from that path.
Remove the card and *Load unpacked* from the new location.

**Re-loading from a different path gives it a new extension ID**, and storage is
per-ID, so remembered credentials and saved form values start empty again. That
is the one cost of moving it.

**Removing it.** *Remove* on the card. That deletes its stored settings too.
Anything you already downloaded — `.jmx` files, HARs — is untouched.

---

## 7. Troubleshooting

Every error the extension can produce, what it actually means, and the fix.

### Installing

| What you see | What it means |
|---|---|
| **"Manifest file is missing or unreadable"** | The folder you selected has no `manifest.json` directly inside it. You picked the parent folder, or the zip is still zipped. Open the folder you chose — you should see `manifest.json`, `background.js`, `popup.html` at the top |
| **"Could not load extension"** after unzipping the wrong file | You unzipped `testmu-recorder-1.1.0.zip` (the store build) and pointed Chrome at your Downloads folder. Use `-share.zip`, or select the exact folder holding `manifest.json` |
| The card is grey / **"This extension may have been corrupted"** | The folder was moved, renamed or deleted. Remove the card and *Load unpacked* again from where it now lives |
| **"Load unpacked" button is missing** | Developer mode is off, or your organisation's Chrome policy blocks unpacked extensions. See [§9](#9-rolling-it-out-to-a-team) for the force-install route |
| The toolbar icon is not visible | It is installed but not pinned. Puzzle-piece icon → pin |

### Recording

| What you see | What it means |
|---|---|
| Chrome banner: **"started debugging this browser"** | Expected. It is the DevTools protocol attaching, which is the only way to capture response bodies. Leave it alone — closing it stops the recording |
| **"This tab can't be recorded"** | You are on a `chrome://` page, the Web Store, or a PDF viewer. Chrome forbids attaching there. Put the URL in the popup's box and press **Go** instead — it opens a normal tab and records from the first request |
| Counter stays at 0 while you click | Something else is already attached to that tab — usually DevTools itself, or another recorder extension. Close DevTools and press Start again |
| The panel is not on the page | It was hidden with `–`. It returns on the next captured request, or from the popup |
| A popup window (SSO, payment) is not captured | It is followed automatically when opened from the recorded tab. If it was opened some other way, record that window separately |
| **"nothing recorded yet"** on Generate | The session has no requests. Either recording never started, or it was reset |
| Recording seems to have vanished after a while | Chrome evicts idle service workers. The session is checkpointed to storage and restored — reopen the popup and check the counter before assuming it is gone |

### Authoring

| What you see | What it means |
|---|---|
| **"the engine failed to start — see the log"** | The WebAssembly engine did not load. Almost always an incomplete unzip: check `jmxgen-recorder/vendor/pyodide/` exists and contains `pyodide.asm.wasm` (~10 MB). Re-unzip and reload the extension |
| **"could not load pyodide.js"** | Same cause — the `vendor/` folder is missing or partial |
| First **Generate plan** takes several seconds | The engine boots on first use (about a second on a modern laptop, longer on a cold profile). Subsequent runs are instant |
| **"the recording was already used"** | The hand-off from recorder to authoring page is one-shot, deliberately, so a page reload cannot silently re-author a capture you have moved on from. Record again, or pick a HAR file |
| **0 correlated** on a non-recording source | Expected. Correlation needs real responses, and only a recording carries them. The Correlations tab says so |
| Warning: **"needs jmeter-plugins-casutg on the runner"** | The plan uses arrival-rate thread groups. Upload that jar with the plan, or install it into JMeter's `lib/ext` |
| Warning: **"needs jmeter-plugins-webdriver on the runner"** | The plan carries browser steps as WebDriver samplers. Same fix, or generate without browser steps |
| **Validate (single user)** is greyed out | Validate runs the plan through real JMeter, which a browser cannot do. It needs the local console from the [jmxgen CLI](https://github.com/RishabhLambdaTest/jmxgen). Everything else works without it |
| Errors count is above 0 | Open the **Checks** tab — the plan is not shipped silently when it has errors |

### Running on HyperExecute

| What you see | What it means |
|---|---|
| **"HyperExecute rejected the credentials (HTTP 401)"** | Almost always the email in the username field. It wants the **username**; both are on `accounts.lambdatest.com/detail/profile`. HyperExecute answers every credential problem with the same `1002 - Invalid Authentication Token`, which is why the message spells out the likely cause |
| **"A project named X already exists"** | Open it on the Projects dashboard, copy its id into **existing project ID**, and leave the name blank. Or pick a different name |
| **"username and access key are both needed"** | One of the two fields is empty |
| **"nothing to upload — author a plan or add a file"** | You reached the run page without a plan. Author one first, or attach a `.jmx` with **Add files** |
| **"choose which .jmx the job should run"** | More than one `.jmx` was uploaded; pick the entry point |
| **"pick at least one region"** | Regions is empty. `eastus` is a safe default |
| **HTTP 5xx from HyperExecute** | A server-side error, worth retrying. The message says so explicitly |
| The dashboard shows **1 user** despite what you set | The user count did not reach the trigger. Check **Max users (total VU)** was actually filled in — an empty field means "whatever the `.jmx` says", which is usually 1 |
| The job runs but the report is empty | The plan ran and failed every request. Validate at one user first — that is exactly the failure it catches cheaply |

### Getting help

The **Log** panel on both the authoring and run pages holds everything: engine
progress, Python's own output, full tracebacks, every HTTP call to HyperExecute
and its response. **Copy** puts it all on the clipboard. That log plus what you
clicked is enough to diagnose anything here.

---

## 8. Questions people ask before installing

**Does my recording or my data go anywhere?**
No. Capture, authoring and the plan all stay in your browser. The only outbound
requests are to the site you are recording and, if you use it, to the
HyperExecute API with your own credentials. There is no analytics, no telemetry
and no third-party endpoint of any kind.

**Why does it need `debugger` permission? That sounds serious.**
It is the only Chrome API that exposes **response bodies**, and correlation —
finding the token in one response and wiring it into the next request — cannot
work without them. `webRequest` cannot read response bodies. It only ever
attaches to a tab you explicitly start recording, and Chrome shows a banner
whenever it is attached.

| Permission | Why |
|---|---|
| `debugger` | Response bodies. Nothing else can read them |
| `tabs` | To attach to the tab you chose, and follow SSO popups it opens |
| `storage` | Checkpoints an in-progress recording so an evicted service worker does not lose it |
| `downloads` | Saving the `.jmx`, HAR or YAML you asked for |
| `offscreen` | A service worker cannot create blob URLs; the offscreen document builds the file to download |
| `<all_urls>` | You choose the site; the extension cannot know it in advance. Capture only runs on a tab you started |

**Does it work offline?** The engine does — it is vendored, not fetched. You
still need the network to reach whatever you are testing, and to trigger a run.

**Will it slow down my browsing?** Only while recording, and only on the tab
being recorded. Nothing runs on other tabs.

**Does it work in Firefox or Safari?** No, and not for want of effort: Firefox
does not implement `chrome.debugger`, so response bodies cannot be captured at
all. Any Chromium browser works.

**Can several people use the same LambdaTest account?** Yes — credentials are
per browser profile and stay there.

**What if I already have JMeter plans?** *Source → Existing .jmx* imports one,
shows you what is in it, and re-emits it clean.

**Do I need JMeter installed?** Not to author, download or run on HyperExecute.
Only to run a plan locally, or to use Validate.

---

## 9. Rolling it out to a team

**A few people.** Send `testmu-recorder-<version>-share.zip` and a link to this
page. That is the whole process.

**Managed Chrome, where policy blocks unpacked extensions.** Force-install it —
no Developer mode, no zip for the user to handle:

```json
{
  "ExtensionSettings": {
    "<EXTENSION_ID>": {
      "installation_mode": "force_installed",
      "update_url": "https://clients2.google.com/service/update2/crx"
    }
  }
}
```

**Chrome Web Store, unlisted.** Upload `testmu-recorder-<version>.zip` — the
store-shaped one — set visibility to **Unlisted**, and share the link. Everyone
then gets updates automatically without touching a folder. Listing copy, the
permission justifications a reviewer will ask for, and the data-use disclosure
are all written up in
[`jmxgen-recorder/STORE_LISTING.md`](../jmxgen-recorder/STORE_LISTING.md).

---

## Optional: the local console

Nothing above needs it, and it is not in this repository. One feature depends on
it: **Validate (single user)** runs the plan once against the real target and
reports per-request status codes and any `${VARIABLE}` that never resolved —
which needs a real JMeter binary, and a browser cannot provide one.

It ships with the [jmxgen CLI](https://github.com/RishabhLambdaTest/jmxgen)
(`jmxgen console`). Start it and the popup says *"local console found —
single-user Validate is available too"* instead of *"everything runs in this
extension"*. That is the only difference it makes.
