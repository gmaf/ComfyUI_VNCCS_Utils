"""Pose Studio render host jobs (render_host/server.mjs).

The render host connects to ComfyUI the way a browser tab does: it long-polls
/vnccs/pose_sync/render_host/poll for the next capture request, renders it in
headless Chromium and uploads the captures to /vnccs/pose_sync/upload_capture.
ComfyUI never calls the host, so the node needs no network client and no
configured address (the security scan forbids both).
"""

import queue
import threading
import time

# A host that has not polled for this long is gone: requests go to the browser tab again.
ALIVE_SECONDS = 60.0
MAX_ERRORS = 64

_jobs = queue.Queue()
_lock = threading.Lock()
_host = {"seen": 0.0, "chromium": None, "webgl": None}
_errors = {}


def seen(info=None):
    """The host polled: it is attached; remember what it reports about its browser."""
    info = info if isinstance(info, dict) else {}
    with _lock:
        _host["seen"] = time.time()
        for key in ("chromium", "webgl"):
            if isinstance(info.get(key), str):
                _host[key] = info[key][:200]


def attached():
    with _lock:
        return time.time() - _host["seen"] < ALIVE_SECONDS


def status():
    """Answer of /vnccs/pose_sync/render_host (same keys as when the host was configured by address)."""
    with _lock:
        ago = time.time() - _host["seen"] if _host["seen"] else None
        alive = ago is not None and ago < ALIVE_SECONDS
        return {"configured": alive, "ok": alive, "chromium": _host["chromium"], "webgl": _host["webgl"],
                "seconds_since_poll": None if ago is None else round(ago, 1)}


def submit(event, detail, pose_data, timeout):
    """Queue a capture request for the host; it expires with the node's wait."""
    _jobs.put({"event": event, "detail": detail, "pose_data": pose_data or "{}",
               "expires": time.time() + float(timeout)})


def next_job(timeout):
    """The next job that has not expired, or None after `timeout` seconds."""
    deadline = time.time() + float(timeout)
    while True:
        left = deadline - time.time()
        if left <= 0:
            return None
        try:
            job = _jobs.get(timeout=left)
        except queue.Empty:
            return None
        if job["expires"] > time.time():
            return {key: job[key] for key in ("event", "detail", "pose_data")}


def report(sync_token, error):
    """The host could not render a job: the waiting node fails with this message."""
    if not sync_token or not error:
        return
    with _lock:
        if len(_errors) >= MAX_ERRORS:
            _errors.pop(next(iter(_errors)))
        _errors[str(sync_token)] = str(error)[:1000]


def take_error(sync_token):
    if not sync_token:
        return None
    with _lock:
        return _errors.pop(str(sync_token), None)
