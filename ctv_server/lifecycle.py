"""Cooperative shutdown shared by HTTP, indexing and synchronous subprocesses."""
import subprocess
import threading
import time

stopping = threading.Event()


class ShutdownRequested(RuntimeError):
    pass


def check_running():
    if stopping.is_set():
        raise ShutdownRequested('Application is stopping')


def run_process(args, *, capture_output=True, text=False, check=False, timeout=30):
    """Run a probe/thumbnail, cancelling and reaping it when shutdown begins."""
    check_running()
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=text)
    deadline = time.monotonic() + timeout
    try:
        while True:
            check_running()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(args, timeout)
            try:
                out, err = process.communicate(timeout=min(0.2, remaining))
                break
            except subprocess.TimeoutExpired:
                continue
        if check and process.returncode:
            raise subprocess.CalledProcessError(process.returncode, args, out, err)
        return subprocess.CompletedProcess(args, process.returncode, out, err)
    finally:
        if process.poll() is None:
            process.kill()
        process.communicate()
