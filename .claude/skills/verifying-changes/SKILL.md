---
name: verifying-changes
description: How to verify a change to this extension - driving real Chrome with Playwright, the regression suite, and the release steps. Use whenever a change needs proving rather than inspecting.
---

# Verifying a change

Static inspection has missed every significant bug in this project. Each one
was found by driving the thing: the console dependency, the false-pass
Validate, CORS preflights authored as samplers, the 403, the zero-sampler plan,
the missing think times, the substring substitution that corrupted a password.

**Run it. Then say what you saw.**

## Driving the extension

Playwright with a persistent context, headless off (extensions and service
worker discovery are unreliable headless):

```python
import hashlib
ctx = p.chromium.launch_persistent_context(PROFILE, headless=False,
    args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}",
          "--no-first-run", "--no-default-browser-check",
          "--disable-features=DisableLoadExtensionCommandLineSwitch"])
# an unpacked extension's id is the SHA-256 of its absolute path, mapped
# a-p, so there is no service-worker race to lose
h = hashlib.sha256(EXT.encode()).hexdigest()[:32]
ext = "".join(chr(ord("a") + int(c, 16)) for c in h)
pg = ctx.new_page(); pg.goto(f"chrome-extension://{ext}/author.html")
```

**Do not pass `channel="chrome"`.** Chrome 137+ removed `--load-extension`, and
by 152 it is ignored outright: the browser starts, the extension is simply not
there, and every `chrome-extension://` navigation fails with
`ERR_BLOCKED_BY_CLIENT` and no other clue. Playwright's bundled Chromium still
honours the switch, so omit `channel` entirely. Verified: Chrome 152 loads
nothing, Chromium 148 registers the service worker.

Notes that cost time when forgotten:

- Use a fresh profile directory per run, or saved settings mask the default you
  are testing. A profile whose recording was never built into a plan is how you
  reproduce the recovered-session popup on the next launch.
- `wait_for_selector(".steprow")` after generating; the download button enables
  slightly before the table renders.
- The popup closes itself when it hands over. Expect it, do not fight it.
- Filter `[pid=` noise out of the output.
- Print your own markers and `grep` for them; a traceback at the end will
  otherwise hide everything above it behind `tail`.

There is a local fixture site on port 8799 (`scratchpad/site/serve.py`) with
login, search and checkout buttons for recording tests.

## The regression suite

`jmxgen.py` is shared with the CLI repo. Copy it into the clone and run:

```bash
cp extension/jmxgen.py ~/Downloads/jmxgen-next/jmxgen.py
cd ~/Downloads/jmxgen-next && bash run_tests.sh     # expect 60 passed, 0 failed
```

If a test now asserts the old behaviour, rewrite it to the new contract rather
than deleting it, and add one for whatever the change made possible.

## Releasing

```bash
# bump extension/manifest.json, then
sed -i '' 's/<old>-share/<new>-share/g; ...' README.md docs/SETUP.md
bash extension/package.sh          # writes both zips
git rm -q dist/*<old>*             # one version in dist at a time
rsync -a --delete --exclude README.md --exclude STORE_LISTING.md \
      --exclude package.sh extension/ ~/Downloads/testmu-jmeter-studio/
```

The last line refreshes the folder the user has loaded unpacked, so they only
have to press reload. `package.sh` fails if the manifest names a file missing
from its explicit list.

Check the docs' relative links before committing; several have broken silently
in the past.
