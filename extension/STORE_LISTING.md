# Chrome Web Store submission

**Name:** TestMu AI — JMeter Studio
**Category:** Developer Tools
**Visibility:** Unlisted (share the link with customers) or Private to the org

## Short description (132 char max)

Record a journey or bring a cURL, OpenAPI, Postman or HAR source, and get a ready-to-run
JMeter .jmx. No install.

## Detailed description

JMeter Studio captures what your browser actually requests — including response bodies,
redirect chains and OAuth popups — and lets you author test steps while you browse:
name transactions, add assertions, extract values into variables, insert pauses, drop
requests you don't want, and type in requests that never happened.

Finish, and the plan is built right there: noise stripped out, dynamic tokens correlated,
and every decision shown with the rule that made it. You can also author from a cURL
command, an OpenAPI spec, a Postman collection, a spreadsheet, a URL list or an existing
.jmx — no recording required.

Download the .jmx, or trigger it on LambdaTest HyperExecute from the same window.

Nothing is uploaded. The recording, and the plan built from it, stay on your machine.
The engine runs locally in WebAssembly; there is no server in the middle.

## Permission justifications (required at review)

| Permission | Why |
|---|---|
| `debugger` | The DevTools protocol is the only API that exposes **response bodies**, which are required to correlate dynamic tokens. `webRequest` cannot read response bodies. |
| `tabs` | To attach to the tab being recorded and to follow OAuth/SSO popups opened from it. |
| `storage` | Checkpoints the in-progress recording to session storage so an evicted service worker does not lose it. |
| `downloads` | To save the exported HAR file the user asked for. |
| `offscreen` | A service worker cannot create blob URLs; the offscreen document builds the HAR file for download. |
| `host_permissions: <all_urls>` | The user chooses which site to record; the extension cannot know it in advance. Capture only runs on the tab the user explicitly starts. |

## Data use disclosure

- Does **not** collect or transmit user data. All capture and all authoring stay local.
- No analytics and no third-party endpoints. The only outbound calls are to the site
  you are recording and, if you use it, to the HyperExecute API with your own credentials.
- The exported HAR is written to the user's own Downloads folder.

## Assets needed for the listing

- 128×128 icon — `icons/icon128.png` (included)
- 1280×800 or 640×400 screenshot — take one of the panel over a recorded page
- Privacy policy URL — required because the extension requests `debugger`

## Enterprise force-install (skips the store for managed profiles)

`ExtensionSettings` policy, so managed Chrome installs it without Developer mode:

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

macOS: `/Library/Managed Preferences/com.google.Chrome.plist`.
Windows: `HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionSettings`.
