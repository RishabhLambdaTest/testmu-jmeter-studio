#!/usr/bin/env python3
"""Entry point for the standalone binary.

The modules load each other by path, which does not work from inside a frozen
bundle - so materialise them next to each other once, then hand off to jmxgen.
"""
import importlib.util
import os
import sys
import warnings

# urllib3 warns about LibreSSL on stock macOS Python - true, and irrelevant to us
warnings.filterwarnings("ignore", module="urllib3")

# The real modules ship as DATA, so PyInstaller never analyses their imports and
# would leave the stdlib they need out of the bundle. Import them here so the
# freeze picks them up.
import argparse            # noqa: F401
import base64              # noqa: F401
import csv                 # noqa: F401
import datetime            # noqa: F401
import html.parser         # noqa: F401
import http.server         # noqa: F401
import json                # noqa: F401
import re                  # noqa: F401
import select              # noqa: F401
import shlex               # noqa: F401
import socketserver        # noqa: F401
import struct              # noqa: F401
import subprocess          # noqa: F401
import threading           # noqa: F401
import urllib.parse        # noqa: F401
import urllib.request      # noqa: F401
import uuid                # noqa: F401
import webbrowser          # noqa: F401
import xml.etree.ElementTree  # noqa: F401
import xml.sax.saxutils    # noqa: F401
import zipfile             # noqa: F401
import zlib                # noqa: F401
# yaml / openpyxl / requests are deliberately NOT imported here - they are large
# and only some features need them. build_binary.sh bundles them via
# --hidden-import so they stay importable, without paying for them every start.

def app_home():
    """Where the bundled modules live - they load each other by path."""
    if getattr(sys, "frozen", False):
        # a one-folder bundle unpacks once to a stable directory, so the modules
        # are already sitting next to each other and can be used in place
        return getattr(sys, "_MEIPASS", os.path.dirname(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def main():
    home = app_home()
    sys.path.insert(0, home)
    spec = importlib.util.spec_from_file_location("jmxgen", os.path.join(home, "jmxgen.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.main() or 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
