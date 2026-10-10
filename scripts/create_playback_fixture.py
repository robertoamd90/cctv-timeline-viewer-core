"""Create an isolated synthetic archive for playback benchmarks (no live index access)."""
import argparse
import datetime
import os
from pathlib import Path
import shutil
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, help="New directory for synthetic media and two independent databases")
    parser.add_argument("--duration", type=int, default=45, help="Real duration of each generated file")
    parser.add_argument("--segments", type=int, default=1, help="Consecutive recordings per camera")
    parser.add_argument("--corrupt-segment", type=int, default=-1, help="Zero-based segment to corrupt on camera 1 only")
    args = parser.parse_args()
    if args.duration <= 0 or args.segments <= 0:
        parser.error("duration and segments must be positive")
    root = args.root.resolve()
    root.mkdir(parents=True, exist_ok=False)
    timestamp = datetime.datetime.now(datetime.timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    source = root / timestamp.strftime("CAM_%Y%m%d%H%M%S.mp4")
    subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
                    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=15", "-t", str(args.duration),
                    "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "2000k", "-g", "15",
                    "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(source)], check=True)
    os.environ["CTV_DB"] = str(root / "candidate.db")
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from ctv_server import db
    db.init_db()
    with db.write_db() as conn:
        for camera_id in range(1, 5):
            conn.execute("INSERT INTO cameras(id,name,source_path,timezone,indexing_mode) VALUES(?,?,?,?,?)",
                         (camera_id, f"Test {camera_id}", str(root), "UTC", "full"))
            for segment in range(args.segments):
                start = timestamp + datetime.timedelta(seconds=segment * args.duration)
                media = root / f"cam{camera_id}_{start.strftime('%Y%m%d%H%M%S')}.mp4"
                if camera_id == 1 and segment == args.corrupt_segment:
                    media.write_bytes(b"deliberately invalid synthetic MP4")
                else:
                    os.link(source, media)
                conn.execute("""INSERT INTO recordings(camera_id,path,filename,start_ts,end_ts,duration,
                         codec,resolution,fps,size,availability,partition_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                         (camera_id, str(media), media.name, start.timestamp(), start.timestamp() + args.duration,
                          args.duration, "h264", "1280x720", 15, media.stat().st_size, "available", start.strftime("%Y-%m-%d")))
    db.close_db()
    shutil.copyfile(root / "candidate.db", root / "baseline.db")
    print(root)


if __name__ == "__main__":
    main()
