"""
Monthsary Surprise Website - tiny Python server (no installs needed).

Run:   python app.py
Then open: http://localhost:8000

Two shared places you can both add to from the website:
  * Our Album    -> photos        (saved in photos/album/,   list in album.json)
  * Our Moments  -> photos/videos (saved in photos/moments/, list in moments.json)
"""
import http.server
import json
import os
import re
import socketserver
import sys
import threading
import uuid
import webbrowser
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote

PORT = 8000
ROOT = Path(__file__).parent.resolve()

# Optional: set a passcode so only the two of you can add/delete.
# Leave "" for no passcode. (You can also set the ALBUM_PASSCODE env variable.)
ALBUM_PASSCODE = ""
PASSCODE = os.environ.get("ALBUM_PASSCODE", ALBUM_PASSCODE)

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
VIDEO_EXT = {".mp4", ".webm", ".mov", ".m4v"}
MAX_IMAGE = 15 * 1024 * 1024    # 15 MB per photo
MAX_VIDEO = 300 * 1024 * 1024   # 300 MB per video
CHUNK = 1024 * 1024
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
LOCK = threading.Lock()

COLLECTIONS = {
    "album": {
        "db": ROOT / "album.json",
        "dir": ROOT / "photos" / "album",
        "url": "photos/album",
        "key": "photos",
        "video": False,
    },
    "moments": {
        "db": ROOT / "moments.json",
        "dir": ROOT / "photos" / "moments",
        "url": "photos/moments",
        "key": "moments",
        "video": True,
    },
}


# ---------- small helpers ----------
def load_db(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def save_db(path, items):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(items, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def looks_like_image(data: bytes) -> bool:
    return (
        data.startswith(b"\xff\xd8\xff")
        or data.startswith(b"\x89PNG")
        or data.startswith(b"GIF8")
        or (data[:4] == b"RIFF" and data[8:12] == b"WEBP")
    )


def looks_like_video(data: bytes, ext: str) -> bool:
    if ext == ".webm":
        return data.startswith(b"\x1a\x45\xdf\xa3")
    return data[4:8] in (b"ftyp", b"moov", b"mdat", b"free", b"wide", b"skip")


def valid_media(first_chunk: bytes, ext: str) -> bool:
    if ext in IMAGE_EXT:
        return looks_like_image(first_chunk)
    return looks_like_video(first_chunk, ext)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format, *args):  # keep the terminal quiet
        pass

    # ---------- helpers ----------
    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self):
        return not PASSCODE or self.headers.get("X-Passcode", "") == PASSCODE

    def _path(self):
        return self.path.split("?")[0]

    def _route(self):
        """/api/album or /api/moments (optionally followed by /<id>)."""
        parts = [p for p in self._path().split("/") if p]
        if len(parts) >= 2 and parts[0] == "api" and parts[1] in COLLECTIONS:
            return parts[1], (parts[2] if len(parts) > 2 else None)
        return None, None

    def _header(self, name, default="", limit=200):
        return unquote(self.headers.get(name, default))[:limit]

    # ---------- GET (lists + files, with Range support for videos) ----------
    def do_GET(self):
        kind, pid = self._route()
        if kind and not pid:
            cfg = COLLECTIONS[kind]
            return self._json(
                200, {"locked": bool(PASSCODE), cfg["key"]: load_db(cfg["db"])}
            )
        rng = self.headers.get("Range")
        if rng:
            fs = Path(self.translate_path(self._path()))
            if fs.is_file() and self._serve_range(fs, rng):
                return
        super().do_GET()

    def _serve_range(self, fs, rng):
        """Partial content, needed so videos play and seek (iPhone/Safari require it)."""
        m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
        if not m or not (m.group(1) or m.group(2)):
            return False
        size = fs.stat().st_size
        if m.group(1) == "":
            start, end = max(0, size - int(m.group(2))), size - 1
        else:
            start = int(m.group(1))
            end = int(m.group(2)) if m.group(2) else size - 1
        end = min(end, size - 1)
        if start >= size or start > end:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return True
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(str(fs)))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        try:
            with open(fs, "rb") as f:
                f.seek(start)
                left = end - start + 1
                while left > 0:
                    data = f.read(min(CHUNK, left))
                    if not data:
                        break
                    self.wfile.write(data)
                    left -= len(data)
        except OSError:  # browser closed the connection (normal while seeking)
            pass
        return True

    # ---------- POST (upload) ----------
    def do_POST(self):
        kind, pid = self._route()
        if not kind or pid:
            return self._json(404, {"error": "not found"})
        if not self._authorized():
            self.close_connection = True
            return self._json(403, {"error": "wrong passcode"})
        cfg = COLLECTIONS[kind]

        filename = self._header("X-Filename", "photo.jpg")
        ext = Path(filename).suffix.lower()
        allowed = IMAGE_EXT | (VIDEO_EXT if cfg["video"] else set())
        if ext not in allowed:
            self.close_connection = True
            nice = "JPG, PNG, WEBP, GIF, MP4, WEBM or MOV" if cfg["video"] else "JPG, PNG, WEBP or GIF"
            return self._json(400, {"error": "use " + nice})

        is_video = ext in VIDEO_EXT
        limit = MAX_VIDEO if is_video else MAX_IMAGE
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length <= 0 or length > limit:
            self.close_connection = True
            mb = limit // (1024 * 1024)
            return self._json(413, {"error": f"file is too big (max {mb} MB)"})

        fid = uuid.uuid4().hex
        stored = fid + ext
        cfg["dir"].mkdir(parents=True, exist_ok=True)
        dest = cfg["dir"] / stored

        # Stream the upload to disk in chunks so big videos don't fill memory.
        remaining, first = length, True
        try:
            with open(dest, "wb") as f:
                while remaining > 0:
                    chunk = self.rfile.read(min(CHUNK, remaining))
                    if not chunk:
                        raise ValueError("upload was interrupted")
                    if first:
                        first = False
                        if not valid_media(chunk, ext):
                            raise ValueError("that file is not a valid photo or video")
                    f.write(chunk)
                    remaining -= len(chunk)
        except ValueError as e:
            dest.unlink(missing_ok=True)
            self.close_connection = True
            return self._json(400, {"error": str(e)})
        except OSError:  # browser disconnected mid-upload
            dest.unlink(missing_ok=True)
            self.close_connection = True
            return

        entry = {
            "id": fid,
            "file": f"{cfg['url']}/{stored}",
            "type": "video" if is_video else "image",
            "added": datetime.now(timezone.utc).isoformat(),
        }
        if kind == "album":
            entry["caption"] = self._header("X-Caption")
            entry["author"] = self._header("X-Author", limit=40)
        else:
            date = self._header("X-Date", limit=10)
            entry["date"] = date if DATE_RE.match(date) else datetime.now().strftime("%Y-%m-%d")
            entry["caption"] = self._header("X-Caption", limit=300)
            entry["author"] = self._header("X-Author", limit=40)

        with LOCK:
            items = load_db(cfg["db"])
            items.append(entry)
            save_db(cfg["db"], items)
        self._json(201, entry)

    # ---------- DELETE ----------
    def do_DELETE(self):
        kind, pid = self._route()
        if not kind or not pid:
            return self._json(404, {"error": "not found"})
        if not self._authorized():
            return self._json(403, {"error": "wrong passcode"})
        cfg = COLLECTIONS[kind]

        with LOCK:
            items = load_db(cfg["db"])
            match = next((i for i in items if i["id"] == pid), None)
            if not match:
                return self._json(404, {"error": "not found"})
            save_db(cfg["db"], [i for i in items if i["id"] != pid])
        try:
            (ROOT / match["file"]).unlink()
        except OSError:
            pass
        self._json(200, {"ok": True})


if __name__ == "__main__":
    for c in COLLECTIONS.values():
        c["dir"].mkdir(parents=True, exist_ok=True)
    with Server(("", PORT), Handler) as server:
        url = f"http://localhost:{PORT}"
        print(f"Your surprise is running at {url}  (Ctrl+C to stop)")
        if "--no-browser" not in sys.argv:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")