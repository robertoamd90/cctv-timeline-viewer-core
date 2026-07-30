#!/usr/bin/env python3
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re


STABLE_VERSION = re.compile(r"^\d+\.\d+\.\d+$")
BETA_VERSION = re.compile(r"^\d+\.\d+\.\d+-beta\.\d+$")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Create a validated release request for the Home Assistant catalog."
    )
    parser.add_argument("channel", choices=("stable", "beta"))
    parser.add_argument("version")
    parser.add_argument("source_sha")
    parser.add_argument("source_ref")
    parser.add_argument("output", type=Path)
    parser.add_argument("--candidate")
    args = parser.parse_args()

    pattern = BETA_VERSION if args.channel == "beta" else STABLE_VERSION
    if not pattern.fullmatch(args.version):
        parser.error(f"invalid {args.channel} version: {args.version}")
    if args.channel == "stable" and not args.candidate:
        parser.error("stable requests require --candidate")

    request = {
        "schema": 1,
        "channel": args.channel,
        "version": args.version,
        "source_repository": "robertoamd90/cctv-timeline-viewer-core",
        "source_ref": args.source_ref,
        "source_sha": args.source_sha,
        "status": "pending",
        "requested_at": datetime.now(timezone.utc).isoformat(),
    }
    if args.candidate:
        request["candidate"] = args.candidate

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(request, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
