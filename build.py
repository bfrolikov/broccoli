#!/usr/bin/env python3
"""Generate loadable browser folders from shared sources; --check detects drift."""
import argparse
from pathlib import Path

root = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--check", action="store_true")
args = parser.parse_args()
stale = []
for source in sorted((root / "shared").iterdir()):
    if not source.is_file():
        continue
    for browser in ("firefox", "chrome"):
        destination = root / browser / source.name
        data = source.read_bytes()
        if args.check:
            if not destination.exists() or destination.read_bytes() != data:
                stale.append(str(destination.relative_to(root)))
        else:
            destination.write_bytes(data)
if stale:
    parser.exit(1, "Outdated generated files: " + ", ".join(stale) + "\nRun python3 extension/build.py\n")
