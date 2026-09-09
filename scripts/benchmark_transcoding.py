"""Compare progressive encoding with and without input pacing, using synthetic video.

Run from the repository root with Python 3.12 and FFmpeg. Writes only to a
temporary directory and the explicit JSON output; never reads the CCTV index.
"""
import argparse
import json
import os
import resource
import selectors
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ctv_server.streaming import build_transcode_command


def run(source, profile, speed, paced, window):
    command = build_transcode_command(str(source), profile, 2, speed)
    if paced:
        index = command.index("-i")
        command[index:index] = ["-readrate", str(speed * 1.5)]
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    start = time.monotonic()
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    total = 0
    first_fragment = None
    tail = b""
    try:
        while time.monotonic() - start < window:
            if not selector.select(0.05):
                continue
            data = os.read(process.stdout.fileno(), 65536)
            if not data:
                break
            total += len(data)
            if first_fragment is None and b"moof" in tail + data:
                first_fragment = time.monotonic() - start
            tail = data[-3:]
    finally:
        if process.poll() is None:
            process.terminate()
        try:
            process.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
        selector.close()
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    return {"profile": profile["name"], "speed": speed, "paced": paced,
            "first_fragment_seconds": first_fragment, "bytes": total,
            "cpu_seconds": after.ru_utime + after.ru_stime - before.ru_utime - before.ru_stime,
            "elapsed_seconds": time.monotonic() - start}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default="/tmp/ctv-transcoding-benchmark.json")
    parser.add_argument("--window", type=float, default=3)
    parser.add_argument("--repetitions", type=int, default=3)
    args = parser.parse_args()
    results = []
    with tempfile.TemporaryDirectory(prefix="ctv-encoding-bench-") as root:
        source = Path(root) / "synthetic.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
                        "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=15", "-t", "45",
                        "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "2000k", "-g", "15",
                        "-pix_fmt", "yuv420p", str(source)], check=True)
        for profile in [
            {"name": "fast", "scale_percent": 30, "fps": 8, "bitrate_kbps": 450},
            {"name": "balanced", "scale_percent": 50, "fps": 15, "bitrate_kbps": 1200},
        ]:
            for speed in [1, 4, 8, 16]:
                for paced in [False, True]:
                    group = [run(source, profile, speed, paced, args.window) for _ in range(args.repetitions)]
                    results.extend(group)
                    available = [item["first_fragment_seconds"] for item in group if item["first_fragment_seconds"] is not None]
                    print(json.dumps({"profile": profile["name"], "speed": speed, "paced": paced,
                                      "first_fragment_median": statistics.median(available) if available else None,
                                      "cpu_seconds_median": statistics.median(item["cpu_seconds"] for item in group)}), flush=True)
                    Path(args.output).write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
