# jmxgen recorder — Chrome extension

Record a journey in your **own** Chrome — your profile, your logins, your VPN — and
author test steps by hand while you browse. Export a HAR; `jmxgen` turns it into a
JMeter `.jmx`.

## Distribution

- **Chrome / Edge** — supported. `./package.sh` builds `dist/jmxgen-recorder-<version>.zip`
  for the Chrome Web Store or Edge Add-ons. Listing copy, permission justifications and the
  data-use disclosure are in [STORE_LISTING.md](STORE_LISTING.md).
- **Managed profiles** — unpacked extensions are usually blocked by policy. Force-install
  it instead with the `ExtensionSettings` policy (see STORE_LISTING.md).
- **Firefox** — not supported, and not a matter of effort: Firefox does not implement
  `chrome.debugger`, so response bodies cannot be captured, and correlation needs them.
  Use `jmxgen record` (Playwright) or `jmxgen capture` (proxy) there.

## Install (unpacked)

1. `chrome://extensions` → turn on **Developer mode**
2. **Load unpacked** → select this `jmxgen-recorder/` folder
3. Pin the extension so the toolbar icon is visible

No store listing, no signing. Chrome shows a "started debugging this browser" banner
while recording — that is the DevTools protocol attaching, and it's how response
bodies get captured.

## Record

1. Open the page you want to start from
2. Click the extension icon → **Start recording this tab**
3. Browse: log in, click, submit. A floating panel appears on the page.
4. **Finish → export HAR** (or the popup's *Export HAR*)

```bash
python3 jmxgen.py from-har jmxgen-session-*.har -o plan.jmx
```

## Author steps by hand, while recording

The floating panel does the things a raw recording can't know:

| Control | What it writes into the plan |
|---|---|
| **Transaction** | every request from now on lands in this Transaction Controller |
| **Assert 200** | response assertion on the last request |
| **Assert text…** | "body contains …" assertion on the last request |
| **Extract…** | JSON extractor (`$.data.token` → `${TOKEN}`) on the last response |
| **Pause 2s** | Flow Control Action pause after that request |
| **Rename…** | sampler label |
| **Skip last** | drops that request from the plan |
| **+ Manual request…** | a request you type in — never observed, just authored |

Panel drag: grab its title bar. Hide it with `-`; it comes back on the next captured
request or via the popup.

## How the annotations travel

Everything is written into the exported HAR as `_jmxgen` fields — a custom key the HAR
spec permits, so the file stays a valid HAR that DevTools and other tools still read.

```json
{
  "pageref": "Login",
  "request":  { "method": "POST", "url": "https://shop.test/api/login", "...": "..." },
  "response": { "status": 200, "content": { "text": "{\"data\":{\"token\":\"...\"}}" } },
  "_jmxgen": {
    "name": "Login call",
    "assert": [{ "field": "body", "match": "contains", "pattern": "token" }],
    "extract": [{ "type": "json", "var": "TOKEN", "query": "$.data.token" }],
    "pause_after_ms": 2000
  }
}
```

Plus a plan-level block, if you want the load profile to travel with the recording:

```json
{ "log": { "_jmxgen": { "name": "Shop journey", "threads": 25, "ramp_up": 60, "duration": 900 } } }
```

`jmxgen from-har` honours all of it, and still runs its own passes on top: static assets
and tracker domains dropped, and **automatic correlation** — tokens a later request sends
that an earlier response produced become extractors and `${VARS}` without you marking
them. Your manual annotations are merged with, not replaced by, the automatic ones.

## Closing a session

The panel header has two buttons:

- **–** minimise: hides the panel, **keeps recording**
- **✕** close: stops recording and ends the session

If anything captured has not been saved yet, ✕ asks first:

```
23 captured requests have not been saved. Save the HAR before closing?
  [ Save HAR, then close ]
  [ Close without saving ]
  [ Keep recording ]
```

The popup's **Discard session** is guarded the same way, and its status line reads
`stopped · not saved yet` (with `Export HAR *`) until you have saved. Closing the recorded
**tab** does not lose anything either — recording stops, the captured requests stay, and
you can still export them from the popup.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Panel never appears on the page | The content script wasn't there when you hit Start — **reload the page once** after starting. Pages opened before the extension was installed always need one reload. |
| `Cannot attach to this target` | DevTools is open on that tab. Chrome allows one debugger client at a time — close DevTools and Start again. |
| Yellow "started debugging" banner | Expected — that *is* the capture. Clicking **Cancel** on it detaches and stops recording. Leave it up. |
| Counter stays at 0 | You're browsing a different tab than the one you started on, or the page is `chrome://` / the Web Store, where extensions cannot attach. |
| Export does nothing | Look in Chrome's Downloads. Large sessions take a moment to serialize. |
| Anything else | `chrome://extensions` → **jmxgen recorder** → click **service worker** to open its console and read the error. |

After editing any file in this folder, click the **reload** arrow on the extension card
in `chrome://extensions` — Chrome does not pick up changes on its own.

## Notes and limits

- **Bodies**: captured for text responses. Binary/base64 bodies are recorded as headers
  only — the plan still contains the request, just no body to correlate from.
- **One tab**: recording attaches to the tab you started on. Navigations within it are
  fine; a new tab or window is not captured.
- **Service worker eviction**: Chrome may evict the background worker when idle. State is
  checkpointed to session storage after every request, so a restart keeps what was
  captured. If the counter ever looks stuck, stop and export — nothing is lost.
- **Don't leave it recording**: the DevTools attachment has real overhead on heavy pages.
