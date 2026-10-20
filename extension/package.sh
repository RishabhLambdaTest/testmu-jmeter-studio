#!/usr/bin/env bash
# Build the two zips, which are not the same shape:
#   dist/testmu-jmeter-studio-<version>.zip        files at the root - Chrome Web Store
#   dist/testmu-jmeter-studio-<version>-share.zip  wrapped in a folder - Load unpacked
# The store rejects a zip with a wrapper folder; a colleague unzipping the store
# one gets loose files all over their Downloads. Hence both.
set -euo pipefail
cd "$(dirname "$0")"
VERSION=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")

# Which build this is, not just which version.
#
# A version number is changed by hand, so two zips can carry the same one and
# different code - and two did: a fix landed while the version stayed 1.8.17,
# QA tested one of them, and neither they nor anyone else could say which. The
# commit is stamped into the zip's name so a bug report names a build. Warn
# when the tree is dirty, because then the commit does not describe it either.
BUILD=$(git -C .. rev-parse --short HEAD 2>/dev/null || echo nogit)
if ! git -C .. diff --quiet 2>/dev/null; then
    BUILD="${BUILD}-dirty"
    echo "warning: uncommitted changes - this build is not reproducible from $BUILD" >&2
fi
# Write OUTSIDE the extension folder. A dist/ inside it is loaded as part of
# the extension when you "Load unpacked", which quietly doubles its size.
OUTDIR="../dist"
STORE="$OUTDIR/testmu-jmeter-studio-${VERSION}+${BUILD}.zip"
SHARE="$OUTDIR/testmu-jmeter-studio-${VERSION}+${BUILD}-share.zip"

# only what the extension needs at runtime - no docs, no build output. Listed
# explicitly so a stray file in the folder never rides along into a release.
FILES=(
    manifest.json background.js offscreen.html offscreen.js
    brand.css
    db.js pages.js
    xmlgate.js
    locator.js overlay.js overlay.css
    popup.html popup.css popup.js
    run.html run.css run.js
    author.html author.css author.js
    engine.js engine-worker.js hx.js lt.js auth.js feedback.js jmxcheck.js jmxcheck-worker.js replay.js jmxgen.py vendor
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

mkdir -p "$OUTDIR" && rm -f "$STORE" "$SHARE"
zip -q -r "$STORE" "${FILES[@]}" -x "*.DS_Store"

# the share zip needs the folder, so stage it under the name people will see
STAGE=$(mktemp -d)
mkdir -p "$STAGE/testmu-jmeter-studio"
cp -R "${FILES[@]}" "$STAGE/testmu-jmeter-studio/"
( cd "$STAGE" && zip -q -r - testmu-jmeter-studio -x "*.DS_Store" ) > "$SHARE"
rm -rf "$STAGE"

echo "store  $STORE   ($(du -h "$STORE" | cut -f1))"
echo "share  $SHARE   ($(du -h "$SHARE" | cut -f1))"
