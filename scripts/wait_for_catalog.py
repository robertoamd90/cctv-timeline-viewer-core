#!/usr/bin/env python3
import argparse
import base64
import json
import os
import time
from urllib.request import Request, urlopen


API_URL = (
    "https://api.github.com/repos/robertoamd90/"
    "cctv-timeline-viewer/contents/release-state.json?ref=main"
)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Wait until the Home Assistant catalog publishes a release."
    )
    parser.add_argument("channel", choices=("stable", "beta"))
    parser.add_argument("version")
    parser.add_argument("--timeout", type=int, default=1200)
    args = parser.parse_args()

    token = os.environ.get("GH_TOKEN", "")
    deadline = time.monotonic() + args.timeout
    while time.monotonic() < deadline:
        request = Request(
            f"{API_URL}&cache={time.time_ns()}",
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {token}",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        try:
            with urlopen(request, timeout=15) as response:
                payload = json.load(response)
            state = json.loads(
                base64.b64decode(payload["content"]).decode("utf-8")
            )
            release = state.get(args.channel, {})
            if (
                release.get("version") == args.version
                and release.get("status") == "published"
            ):
                print(
                    f"{args.channel} {args.version} published as "
                    f"{release.get('image_digest', 'unknown digest')}"
                )
                return
        except Exception as exc:
            print(f"Catalog not ready: {exc}")
        time.sleep(10)

    raise SystemExit(
        f"Timed out waiting for {args.channel} {args.version} in the catalog"
    )


if __name__ == "__main__":
    main()
