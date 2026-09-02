# Setup

Everything in this guide happens inside Chrome. No CLI, no Python, no JMeter, no
local server, no account to create. The plan is built by an engine that ships
inside the extension and runs in WebAssembly, and runs are triggered directly
against the HyperExecute API.

From receiving the zip to a job on the dashboard takes about five minutes.

This page is meant to be complete. If you find yourself needing to ask someone a
question, that is a gap here, so tell us and it gets fixed on this page.

**Contents**

1. [Which zip, and why there are two](#1-which-zip-and-why-there-are-two)
2. [Install it](#2-install-it)
3. [Your first plan](#3-your-first-plan)
4. [Recording a journey instead](#4-recording-a-journey-instead)
5. [Running it on HyperExecute](#5-running-it-on-hyperexecute)
6. [Updating, moving and removing it](#6-updating-moving-and-removing-it)
7. [Troubleshooting](#7-troubleshooting)
8. [Questions people ask before installing](#8-questions-people-ask-before-installing)
9. [Rolling it out to a team](#9-rolling-it-out-to-a-team)

---

## 1. Which zip, and why there are two

`dist/` holds two files. They contain the same extension. The only difference is
whether the files sit inside a folder.

```
testmu-jmeter-studio-1.3.4-share.zip          ←  the one you want
  └── testmu-jmeter-studio/
        manifest.json
        background.js
        popup.html …

testmu-jmeter-studio-1.3.4.zip                ←  only for a Chrome Web Store submission
  ├── manifest.json
  ├── background.js
  ├── popup.html …
```

The `-share` build is for people. It unzips to a single `testmu-jmeter-studio` folder,
which is exactly what *Load unpacked* asks you to select. Send this one.

The other build is for whoever submits the extension to the Chrome Web Store. The
store requires `manifest.json` at the top level of the upload and rejects a zip
with a wrapper folder around it.

Picking the wrong one fails in a confusing way rather than an obvious one. The
store simply rejects the `-share` build. Someone who unzips the store build gets
twenty loose files spread across their Downloads folder, with no folder to point
Chrome at. The rule to remember: if a person is going to unzip it, send
`-share.zip`.

### Where to get it

From the repository:

```bash
git clone https://github.com/RishabhLambdaTest/testmu-jmeter-studio.git
open testmu-jmeter-studio/dist        # both zips are here, prebuilt
```

Or from GitHub in the browser: open `dist/`, click
`testmu-jmeter-studio-1.3.4-share.zip`, then **Download raw file** at the top right.
GitHub cannot preview a zip, so that button is the only thing on the page. Note
that the `raw.githubusercontent.com` address does not work on its own while the
repository is private, which is why pasting that link to a colleague looks broken.

### Rebuilding them

After any change to the extension:

```bash
extension/package.sh
#   dist/testmu-jmeter-studio-<version>.zip          store shape
#   dist/testmu-jmeter-studio-<version>-share.zip    folder shape
```

The version in the filename comes from `manifest.json`, so an install can always
be traced back to a commit. `package.sh` ships an explicit file list and fails if
the manifest names anything missing from it, so a release cannot go out with a
page left behind.

---

## 2. Install it

### Unzip it somewhere permanent

Chrome does not copy an unpacked extension. It loads the files from wherever they
sit, so moving the folder later disables it. Somewhere like this is fine:

```
~/Downloads/testmu-jmeter-studio/
```

### Open the extensions page

Go to `chrome://extensions`. Chrome, Edge, Brave, Arc and Opera all work;
anything Chromium does. Chrome 116 or newer, since the extension is Manifest V3
and uses offscreen documents.

### Turn on Developer mode

The toggle sits at the top right. Three buttons appear on the left once it is on.

![chrome://extensions with Developer mode on and the extension card loaded](screenshots/setup-load-unpacked.png)

### Load unpacked, and pick the folder

Select the `testmu-jmeter-studio` folder itself, the one that directly contains
`manifest.json`. Not the zip, and not the folder above it.

A card appears with the violet mark, the name TestMu AI — JMeter Studio, and a
version number. That is the whole installation.

### Pin it

Click the puzzle-piece icon in the toolbar and pin the extension. The violet mark
appears in the toolbar, and that is how you open it.

There are shortcuts if you prefer them. `⌘⇧9` (`Ctrl+Shift+9`) opens the popup,
and `⌘⇧8` (`Ctrl+Shift+8`) starts and stops recording.

---

## 3. Your first plan

The quickest way to see it work needs nothing but the browser. No recording, no
credentials.

Click the toolbar icon:

![The extension popup, idle](screenshots/popup-idle.png)

Under *Author from something else*, click **cURL**. The authoring page opens:

![The authoring page with the source picker](screenshots/author-source.png)

Paste one or more curl commands into the box. Any request will do. In DevTools,
right-click a request and choose *Copy → Copy as cURL*. If you would rather not
find one, [`sample/requests.txt`](../sample/requests.txt) holds three that point
at a public API and need no credentials.

Fill in Users, Ramp and Duration if you like. They are a starting point, and
HyperExecute can override all three at run time. Then press **Generate plan**:

![A plan generated from curl commands](screenshots/author-curl-result.png)

That is a JMeter test plan. **Download .jmx** saves it.

Three tabs show what the engine decided. *Requests* lists every sampler with its
group, method, path and checks. *Correlations* lists the dynamic values it wired
between requests, each with the rule that matched, a confidence, and the hop it
travels. *Checks* holds the results of a single-user validation run, once you
have done one.

The Log panel underneath carries everything: engine progress, Python's own
output, and any warning about a JMeter plugin the runner will need. Its **copy**
link puts the whole log on the clipboard, which is the thing to send if you ever
do need help.

Every other source works the same way. Each has a sample file in
[`sample/`](../sample/), and [SOURCES.md](SOURCES.md) explains what to look for
in each result. [OPTIONS.md](OPTIONS.md) covers every control on this page, with
an example for each.

---

## 4. Recording a journey instead

[RECORDING.md](RECORDING.md) covers this properly. The short path:

1. Open the popup.
2. To capture the very first request, meaning the initial navigation, the
   redirect chain and any SSO bounce, type the URL in the box and press **Go**.
   To record the page already in front of you, press **Start recording this tab**.
3. Browse the app. A panel appears on the page, where you name transactions and
   attach assertions, extractors and pauses as you go.
4. Press **Finish → build the plan**. The plan opens in a new tab, generated.

Chrome shows a banner saying the extension started debugging this browser. That
is expected rather than a warning. Attaching the DevTools protocol is the only
way to read response bodies, which is what correlation needs. Dismissing the
banner stops the recording.

---

## 5. Running it on HyperExecute

**Run on HyperExecute…** opens the run page with the plan already attached:

![The HyperExecute run form](screenshots/run-hyperexecute.png)

### The five steps, in order

The page runs the same sequence every time, and the Log names each one as it
happens. Knowing the order is what makes a failure readable: whatever step the
log stopped on is the step that failed, and everything above it succeeded.

**1. Credentials.** Username and access key go in the top two fields. The
username is the LambdaTest *username*, not the email you sign in with; both sit
on `accounts.lambdatest.com/detail/profile`. *Remember on this machine* keeps
them in Chrome's extension storage for this profile only.

**2. The project.** A HyperExecute job lives inside a project. Give a name and
one is created, or paste the id of a project you already have. Fill in one or
the other, never both. Creating a name that exists is an error, and the message
tells you to switch to the id. The log prints `project <id>` either way, and the
id is written back into the form so a retry reuses it rather than trying to
create it twice.

**3. The upload.** Every `.jmx` in the list is parsed before anything is sent,
and an upload that would carry a plan no XML parser can read is refused here
rather than failing on a runner ten minutes later. The log says
`plan.jmx parses as a JMeter plan` for each one. Then the files go up: the plan,
plus any CSV, plugin jar or `system.properties` you attached, each named in the
log as it goes. This is also the step that proves your credentials work, since
it is authenticated exactly like the trigger that follows.

**4. The trigger.** The run configuration is turned into one job request, which
the log prints in full before sending it. That line is worth reading — it is the
literal payload, so you can see whether the users, ramp-up and duration you typed
actually made it. `-e -o report` is always included: it is what makes JMeter
write the HTML dashboard that HyperExecute then collects as the **report**
artifact.

**5. The job.** The trigger returns a job id, the log prints it, and a link to
the dashboard appears. From there it is an ordinary HyperExecute job: live
status, logs, and the report artifact when it finishes.

**Upload only** stops after step 3. Useful when someone else triggers runs, or
when you are staging files for a scheduled one.

### What each field wants

| Field | |
|---|---|
| Username | Your LambdaTest username, not the email you sign in with. Both are at `accounts.lambdatest.com/detail/profile` |
| Access key | From the same page |
| Remember on this machine | Stores both in Chrome's extension storage, on this profile only. Nothing is sent anywhere else |
| New project name | Anything. Creating a project that already exists is an error, so… |
| …or existing project ID | …paste an ID here instead to add a run to a project you have. Fill in one or the other, never both |
| Name for the recorded plan | The filename the `.jmx` gets on the runner |
| Add .jmx, .jar, .properties or data files | Anything else the run needs: a CSV of test data, a plugin jar the log asked for, a `system.properties` |
| Which .jmx should the job run | Pick one, when more than one was uploaded |
| Regions | `eastus` by default. Comma-separate them for a multi-region run, and each region gets its own copy of the job |
| Max users (total VU) | Total virtual users across the whole job |
| Max users per engine | How many each machine carries. Total divided by this is how many machines start |
| Ramp-up, Duration | Seconds. Both override whatever the `.jmx` says |
| Global timeout | Minutes, optional. A hard stop for the whole job |
| Job label | Optional, shows on the dashboard |
| Split CSV rows across engines | Each machine gets its own slice of the data file, instead of every machine replaying the same rows |

Press **Create & trigger**.

Anything you leave empty falls through to the plan. An empty *Max users* does
not mean one user; it means whatever the `.jmx` carries, which is often one. If
the dashboard shows a number you did not expect, the printed trigger payload in
the log is where to look.

### Where your credentials go

From the form to LambdaTest, and nowhere else. The extension calls the
HyperExecute API directly from your browser. There is no server in the middle and
nothing is proxied through a third party.

---

## 6. Updating, moving and removing it

**A new version.** Unzip the new `-share.zip` over the old folder, replacing its
contents, then click the reload icon on the extension's card in
`chrome://extensions`. Your saved settings survive, because the extension keeps
its identity as long as the folder path does.

**Moving the folder** disables the extension, since Chrome loads it from that
path. Remove the card and load it again from the new location.

**Loading from a different path gives it a new extension ID.** Storage is per ID,
so remembered credentials and saved form values start out empty again. That is
the one real cost of moving it.

**Removing it.** Use *Remove* on the card, which deletes its stored settings.
Anything you already downloaded, plans and HARs alike, is untouched.

---

## 7. Troubleshooting

Every error the extension can produce, what it actually means, and what to do.

### While installing

| What you see | What it means |
|---|---|
| "Manifest file is missing or unreadable" | The folder you selected has no `manifest.json` directly inside it. You picked the parent folder, or the zip is still zipped. Open the folder you chose: `manifest.json`, `background.js` and `popup.html` should be sitting at the top |
| "Could not load extension" after unzipping | You unzipped the store build and pointed Chrome at your Downloads folder. Use `-share.zip`, or select the exact folder holding `manifest.json` |
| The card is grey, or "This extension may have been corrupted" | The folder was moved, renamed or deleted. Remove the card and load it again from where the files now live |
| No *Load unpacked* button | Developer mode is off, or your organisation's Chrome policy blocks unpacked extensions. Section 9 has the force-install route |
| No toolbar icon | It is installed but not pinned. Puzzle-piece icon, then pin |

### While recording

| What you see | What it means |
|---|---|
| A banner saying the extension started debugging this browser | Expected. It is the DevTools protocol attaching, the only way to capture response bodies. Leave it alone, because closing it stops the recording |
| "This tab can't be recorded" | You are on a `chrome://` page, the Web Store, or a PDF viewer, where Chrome forbids attaching. Put the URL in the popup's box and press **Go**, which opens a normal tab and records from the first request |
| The counter stays at 0 while you click | Something else is already attached to that tab, usually DevTools itself or another recorder. Close it and start again |
| The panel is not on the page | It was hidden with the `–` button. It returns on the next captured request, or from the popup |
| A popup window (SSO, payment) is not captured | Popups opened from the recorded tab are followed automatically. One opened another way needs recording separately |
| "nothing recorded yet" when generating | The session holds no requests. Either recording never started, or it was reset |
| The recording seems to have vanished | It has not. The session is on disk, and survives both Chrome evicting the extension's worker and closing the browser. Reopen the popup: a recording found on disk is offered back |
| "Session storage quota bytes exceeded" | Fixed in 1.3.0, where the recording moved to disk. If you see it, you are on an older build |
| "could not write to disk" | The browser's storage grant is exhausted, which the popup warns about at 80%. Free space, or discard old recordings |

### While authoring

| What you see | What it means |
|---|---|
| "the engine failed to start - see the log" | The WebAssembly engine did not load, almost always because of an incomplete unzip. Check that `extension/vendor/pyodide/` exists and holds `pyodide.asm.wasm`, around 10 MB. Unzip again and reload the extension |
| "could not load pyodide.js" | Same cause: `vendor/` is missing or partial |
| The first Generate takes a few seconds | The engine boots on first use, about a second on a current laptop and longer on a cold profile. Later runs are immediate |
| "the recording was already used" | The handover from recorder to authoring page is deliberately one-shot, so reloading the page cannot silently re-author a capture you have moved on from. Record again, or pick a HAR file |
| 0 correlated, on a source that is not a recording | Expected. Correlation needs real responses, and only a recording carries them. The Correlations tab says as much |
| "needs jmeter-plugins-casutg on the runner" | The plan uses arrival-rate thread groups. Upload that jar with the plan, or install it into JMeter's `lib/ext` |
| "needs jmeter-plugins-webdriver on the runner" | The plan carries browser steps as WebDriver samplers. Same fix, or generate without browser steps |
| **Validate (single user)** is greyed out | Validate runs the plan through real JMeter, which a browser cannot do. It needs the local console from the [jmxgen CLI](https://github.com/RishabhLambdaTest/jmxgen). Everything else works without it |
| The errors count is above zero | Open the Checks tab. A plan with errors is never shipped silently |
| Validate says "nothing ran" | JMeter started and executed no samplers. The message carries JMeter's own reason, and it is usually a data file the plan references that is not sitting beside it. Upload the CSV with the plan, or clear the Test data fields |

### While running on HyperExecute

| What you see | What it means |
|---|---|
| "HyperExecute rejected the credentials (HTTP 401)" | Nearly always the email in the username field. It wants the username; both are on `accounts.lambdatest.com/detail/profile`. HyperExecute answers every credential problem with the same `1002 - Invalid Authentication Token`, which is why the message spells out the likely cause |
| "the trigger failed: HTTP 403" | Not your credentials, whatever an older build's wording said. HyperExecute refuses a request carrying `Origin: chrome-extension://…`, while accepting the identical request with the dashboard's own origin, and `Origin` and `Referer` are two headers a browser will not let a script set. Fixed in 1.3.3, which sets them through `declarativeNetRequest`. Verified both ways against the live API: with the rule the job triggers, and a build with the rule disabled reproduces the 403 exactly. If you are on 1.3.2 or earlier, update |
| A 403 *before* anything uploaded | This one really is the credentials. See the 401 row |
| "A project named X already exists" | Open it on the Projects dashboard, copy its id into *existing project ID*, and leave the name blank. Or choose a different name |
| "username and access key are both needed" | One of the two fields is empty |
| "nothing to upload - author a plan or add a file" | You reached the run page without a plan. Author one, or attach a `.jmx` with *Add files* |
| "choose which .jmx the job should run" | More than one `.jmx` was uploaded, so pick the entry point |
| "pick at least one region" | Regions is empty. `eastus` is a safe default |
| An HTTP 5xx from HyperExecute | A server-side error, worth retrying. The message says so |
| The dashboard shows fewer users than you set | First check you are looking at the right job: a failed trigger creates none, so the newest job on the dashboard may be an older run. If it is the right one, *Max users (total VU)* was empty, which means "whatever the `.jmx` says". When it is filled in, the count reaches JMeter itself: a run sent as 1 user starts the thread group with `threads=1`, overriding the plan's own default |
| The job runs but the report is empty | The plan ran and every request failed. Validate at one user first, since that is the failure it catches cheaply |

### If none of that covers it

The Log panel on the authoring and run pages holds everything: engine progress,
Python output, full tracebacks, and every HTTP call to HyperExecute with its
response. The **copy** link takes the lot. That log, plus what you clicked, is
enough to diagnose anything on this page.

---

## 8. Questions people ask before installing

**Does my recording go anywhere?**
No. Capture, authoring and the finished plan all stay in your browser. The only
outbound requests are to the site you are recording and, if you use it, to the
HyperExecute API with your own credentials. There is no analytics, no telemetry
and no third-party endpoint of any kind.

**Why does it need debugger permission? That sounds serious.**
It is the only Chrome API that exposes response bodies, and correlation cannot
work without them: finding a token in one response and wiring it into the next
request is the entire point. `webRequest` cannot read response bodies. The
extension only ever attaches to a tab you explicitly start recording, and Chrome
shows a banner the whole time it is attached.

| Permission | Why it is there |
|---|---|
| `debugger` | Response bodies. Nothing else can read them |
| `tabs` | To attach to the tab you chose, and follow SSO popups it opens |
| `storage` | Checkpoints an in-progress recording, so an evicted service worker does not lose it |
| `downloads` | Saving the plan, HAR or YAML you asked for |
| `declarativeNetRequestWithHostAccess` | One rule, on `api-hyperexecute.lambdatest.com` alone, setting the `Origin` and `Referer` its trigger endpoint requires. Those two are headers a browser will not let a script set directly. The rule is a session rule, so it disappears when Chrome closes, and it neither blocks nor reads anything |
| `offscreen` | A service worker cannot create blob URLs, so the offscreen document builds the file to download |
| `<all_urls>` | You choose the site, and the extension cannot know it in advance. Capture only runs on a tab you started |

**Does it work offline?** The engine does, since it is vendored rather than
fetched. You still need the network to reach whatever you are testing, and to
trigger a run.

**Will it slow down my browsing?** Only while recording, and only on the tab
being recorded. Nothing runs on other tabs.

**Firefox or Safari?** Neither, and not for want of trying. Firefox does not
implement `chrome.debugger`, so response bodies cannot be captured at all. Any
Chromium browser works.

**Can several people share one LambdaTest account?** Yes. Credentials are stored
per browser profile and stay there.

**What about the JMeter plans we already have?** *Source → Existing .jmx* imports
one, shows you what is in it, and re-emits it clean.

**Do I need JMeter installed?** Not to author a plan, download it, or run it on
HyperExecute. Only to run one locally, or to use Validate.

---

## 9. Rolling it out to a team

For a handful of people, send `testmu-jmeter-studio-<version>-share.zip` and a link to
this page. That is the whole process.

For managed Chrome, where policy blocks unpacked extensions, force-install it
instead. No Developer mode, and no zip for the user to handle:

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

For a wider rollout, upload the store-shaped zip to the Chrome Web Store, set
visibility to Unlisted, and share the link. Everyone then gets updates without
touching a folder. Listing copy, the permission justifications a reviewer will
ask for, and the data-use disclosure are all written up in
[`extension/STORE_LISTING.md`](../extension/STORE_LISTING.md).

---

## Optional: the local console

Nothing above needs it, and it is not in this repository. One feature depends on
it. Validate (single user) runs the plan once against the real target and reports
per-request status codes along with any `${VARIABLE}` that never resolved, which
needs a real JMeter binary that a browser cannot provide.

It ships with the [jmxgen CLI](https://github.com/RishabhLambdaTest/jmxgen) as
`jmxgen console`. Start it and the popup says "local console found, single-user
Validate is available too" instead of "everything runs in this extension". That
is the only difference it makes.
