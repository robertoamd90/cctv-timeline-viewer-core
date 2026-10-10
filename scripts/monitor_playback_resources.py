"""Sample an explicitly selected synthetic server and its transcoder children.

Optional test-only dependency: psutil. Does not inspect addon data or mutate it.
"""
import argparse
import json
from pathlib import Path
import time
import psutil

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("pid", type=int)
parser.add_argument("output", type=Path)
parser.add_argument("--seconds", type=int, default=600)
parser.add_argument("--browser-pid", type=int, action="append", default=[], help="PID of a soak_playback_browser.cjs process")
args = parser.parse_args()
process = psutil.Process(args.pid)
command = " ".join(process.cmdline())
if "uvicorn" not in command and "scripts/run_playback_ha_fixture.py" not in command:
    parser.error("expected the synthetic uvicorn server PID")
browser_processes = [psutil.Process(pid) for pid in args.browser_pid]
if any("soak_playback_browser.cjs" not in " ".join(browser.cmdline()) for browser in browser_processes):
    parser.error("browser PID must belong to the synthetic soak benchmark")
samples = []
start = time.monotonic()
while time.monotonic() - start < args.seconds:
    children = process.children(recursive=True)
    child_samples = []
    for child in children:
        try:
            child_samples.append({"pid": child.pid, "threads": child.num_threads(),
                                  "rss": child.memory_info().rss})
        except psutil.NoSuchProcess:
            # Short transcoding jobs can exit between enumeration and sampling.
            continue
    browser_samples = []
    for browser in browser_processes:
        try:
            members = [browser, *browser.children(recursive=True)]
        except psutil.NoSuchProcess:
            continue
        for member in members:
            try:
                browser_samples.append({"pid": member.pid, "rss": member.memory_info().rss,
                                        "threads": member.num_threads()})
            except psutil.NoSuchProcess:
                continue
    samples.append({"elapsed": time.monotonic() - start,
                    "threads": process.num_threads(), "rss": process.memory_info().rss,
                    "children": child_samples, "browser_processes": browser_samples})
    args.output.write_text(json.dumps(samples, indent=2))
    time.sleep(1)
