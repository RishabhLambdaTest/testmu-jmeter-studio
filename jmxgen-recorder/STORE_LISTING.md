# Chrome Web Store submission

**Name:** jmxgen recorder
**Category:** Developer Tools
**Visibility:** Unlisted (share the link with customers) or Private to the org

## Short description (132 char max)

Record a browser journey, author test steps by hand, and export a HAR that becomes a
ready-to-run JMeter test plan.

## Detailed description

jmxgen recorder captures what your browser actually requests — including response bodies,
redirect chains and OAuth popups — and lets you author test steps while you browse:
name transactions, add assertions, extract values into variables, insert pauses, drop
requests you don't want, and type in requests that never happened.

Export a HAR and the jmxgen CLI (or console) turns it into a JMeter .jmx with the noise
removed and dynamic tokens correlated automatically.

Nothing is uploaded. The recording stays on your machine until you export it.

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

- Does **not** collect or transmit user data. All capture stays local.
- No analytics, no remote endpoints, no third-party libraries.
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
