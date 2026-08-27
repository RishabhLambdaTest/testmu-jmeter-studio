#!/usr/bin/env bash
# Build the two zips, which are not the same shape:
#   dist/jmxgen-recorder-<version>.zip        files at the root - Chrome Web Store
#   dist/jmxgen-recorder-<version>-share.zip  wrapped in a folder - Load unpacked
# The store rejects a zip with a wrapper folder; a colleague unzipping the store
# one gets loose files all over their Downloads. Hence both.
set -euo pipefail
cd "$(dirname "$0")"
VERSION=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
STORE="dist/jmxgen-recorder-${VERSION}.zip"
SHARE="dist/jmxgen-recorder-${VERSION}-share.zip"

# only what the extension needs at runtime - no docs, no build output. Listed
# explicitly so a stray file in the folder never rides along into a release.
FILES=(
    manifest.json background.js offscreen.html offscreen.js
    overlay.js overlay.css
    popup.html popup.css popup.js
    run.html run.css run.js
    author.html author.css author.js
    icons
)

# every listed file must exist, or the extension breaks only once someone loads it
for f in "${FILES[@]}"; do
    [ -e "$f" ] || { echo "missing: $f" >&2; exit 1; }
done

# every page and script the manifest names must be in the list
python3 - "${FILES[@]}" <<'PY'
import json, sys
shipped = set(sys.argv[1:])
m = json.load(open("manifest.json"))
need = {m["background"]["service_worker"], m["action"]["default_popup"]}
for cs in m.get("content_scripts", []):
    need |= set(cs.get("js", [])) | set(cs.get("css", []))
for war in m.get("web_accessible_resources", []):
    need |= set(war.get("resources", []))
missing = sorted(need - shipped)
if missing:
    sys.exit("manifest references files package.sh does not ship: " + ", ".join(missing))
PY

mkdir -p dist && rm -f "$STORE" "$SHARE"
zip -q -r "$STORE" "${FILES[@]}" -x "*.DS_Store"

# the share zip needs the folder, so stage it under the name people will see
STAGE=$(mktemp -d)
mkdir -p "$STAGE/jmxgen-recorder"
cp -R "${FILES[@]}" "$STAGE/jmxgen-recorder/"
( cd "$STAGE" && zip -q -r - jmxgen-recorder -x "*.DS_Store" ) > "$SHARE"
rm -rf "$STAGE"

echo "store  $STORE   ($(du -h "$STORE" | cut -f1))"
echo "share  $SHARE   ($(du -h "$SHARE" | cut -f1))"
