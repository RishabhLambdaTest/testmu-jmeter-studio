#!/usr/bin/env bash
# Build a standalone app - no Python needed on the target machine.
#   ./build_binary.sh   ->  dist/jmxgen-macos/jmxgen  (+ dist/jmxgen-macos.zip to share)
#
# This is a one-folder bundle on purpose. A single-file bundle unpacks itself into
# a brand-new temp directory on every run, and macOS re-scans every extracted file
# each time - that costs ~5s per command. A one-folder bundle lives at a stable
# path, is scanned once, and starts in under 0.2s.
set -euo pipefail
cd "$(dirname "$0")"
command -v pyinstaller >/dev/null 2>&1 || python3 -m pip install --quiet pyinstaller
case "$(uname -s)" in
  Darwin) SUFFIX="macos" ;;
  Linux)  SUFFIX="linux" ;;
  *)      SUFFIX="windows" ;;
esac
APP="jmxgen-$SUFFIX"
rm -rf "dist/$APP" "dist/$APP.zip"
mkdir -p .build dist          # the log and the output both need these to exist
python3 -m PyInstaller --noconfirm --clean --onedir \
  --name jmxgen --contents-directory _internal \
  --distpath "dist/.$APP" --workpath .build --specpath .build \
  --add-data "$PWD/jmxgen.py:." \
  --add-data "$PWD/jmxgen_server.py:." \
  --add-data "$PWD/console.html:." \
  --add-data "$PWD/mitm_har.py:." \
  --add-data "$PWD/jmx_pipeline.py:." \
  --add-data "$PWD/hyperexecute_automation.py:." \
  --hidden-import yaml --hidden-import openpyxl --hidden-import requests \
  --exclude-module tkinter --exclude-module PIL --exclude-module numpy \
  "$PWD/jmxgen_main.py" > .build/build.log 2>&1
mv "dist/.$APP/jmxgen" "dist/$APP"
rm -rf "dist/.$APP" .build/jmxgen .build/*.spec 2>/dev/null || true
# ad-hoc sign so macOS does not quarantine-prompt on every nested binary
[ "$SUFFIX" = macos ] && codesign --force --deep -s - "dist/$APP" >/dev/null 2>&1 || true
( cd dist && zip -qry "$APP.zip" "$APP" )
echo "built dist/$APP/jmxgen   ($(du -sh "dist/$APP" | cut -f1))"
echo "share  dist/$APP.zip     ($(du -h "dist/$APP.zip" | cut -f1))"
echo "  run: ./dist/$APP/jmxgen console"
echo "  a bundle is per-platform: build on macOS for macOS, Linux for Linux, Windows for .exe"
