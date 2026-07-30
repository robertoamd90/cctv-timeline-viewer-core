#!/usr/bin/env python3
import argparse
import json
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Render Home Assistant metadata for a local Supervisor build."
    )
    parser.add_argument("channel", choices=("stable", "beta"))
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[1]
    packaging = root / "packaging" / "homeassistant"
    config = json.loads((packaging / "config.base.json").read_text(encoding="utf-8"))

    if args.channel == "beta":
        config.update(
            name="CCTV Viewer Beta",
            slug="cctv_viewer_beta",
            description="Local preview build of CCTV Viewer",
            panel_title="CCTV Viewer Beta",
        )

    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "config.json").write_text(
        json.dumps(config, indent=2) + "\n",
        encoding="utf-8",
    )

    apparmor = (packaging / "apparmor.txt").read_text(encoding="utf-8")
    if args.channel == "beta":
        apparmor = apparmor.replace(
            "profile cctv_viewer ",
            "profile cctv_viewer_beta ",
            1,
        )
    (args.output / "apparmor.txt").write_text(apparmor, encoding="utf-8")


if __name__ == "__main__":
    main()
