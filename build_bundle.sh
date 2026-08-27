#!/usr/bin/env bash
# Build a single runnable file: dist/jmxgen — no install, no pip, no folder of scripts.
#
#   ./build_bundle.sh          -> dist/jmxgen   (run it directly: ./dist/jmxgen)
set -euo pipefail
cd "$(dirname "$0")"
BUILD="$(mktemp -d)"; trap 'rm -rf "$BUILD"' EXIT
PKG="$BUILD/app"
mkdir -p "$PKG"

cp jmxgen.py jmxgen_server.py console.html mitm_har.py jmx_pipeline.py "$PKG"/
[ -f hyperexecute_automation.py ] && cp hyperexecute_automation.py "$PKG"/

cat > "$PKG/__main__.py" <<'PY'
"""Single-file jmxgen. Unpacks its modules beside itself on first run, then dispatches."""
import os, sys, tempfile, zipfile

def _unpack():
    # modules load each other by path, so materialise them once in a cache dir
    home = os.path.join(tempfile.gettempdir(), "jmxgen-bundle")
    os.makedirs(home, exist_ok=True)
    src = sys.argv[0]
    if zipfile.is_zipfile(src):
        with zipfile.ZipFile(src) as z:
            for name in z.namelist():
                if name.endswith((".py", ".html")) and name != "__main__.py":
                    target = os.path.join(home, os.path.basename(name))
                    data = z.read(name)
                    # refresh whenever the content differs, so an upgraded bundle
                    # is never shadowed by a stale cache
                    if not os.path.exists(target) or \
                       os.path.getsize(target) != len(data):
                        with open(target, "wb") as fh:
                            fh.write(data)
    return home

home = _unpack()
sys.path.insert(0, home)
import importlib.util
spec = importlib.util.spec_from_file_location("jmxgen", os.path.join(home, "jmxgen.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
sys.exit(mod.main() or 0)
PY

mkdir -p dist
python3 -m zipapp "$PKG" -o dist/jmxgen -p "/usr/bin/env python3" -c
chmod +x dist/jmxgen
echo "built dist/jmxgen  ($(du -h dist/jmxgen | cut -f1))"
echo "  run it:  ./dist/jmxgen doctor"
