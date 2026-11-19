"""Vercel Python function: the same parser the app spawns locally, served over HTTP.

The Next.js runtime on Vercel has no Python, so inspect.ts posts pages here.
POST /api/parse  body: [{"url": ..., "html": ...}]  ->  parsed pages (JSON).
A shared secret keeps the endpoint from being used by anyone else.
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import parse_profile  # noqa: E402


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        secret = os.environ.get("PARSER_SECRET", "")
        if secret and self.headers.get("x-parser-secret") != secret:
            return self._send(401, {"error": "unauthorized"})
        try:
            size = int(self.headers.get("content-length") or 0)
            pages = json.loads(self.rfile.read(size) or b"[]")
        except Exception:
            return self._send(400, {"error": "invalid body"})
        out = []
        for page in pages:
            try:
                out.append(parse_profile.parse(page["url"], page["html"]))
            except Exception as exc:  # one bad page must not sink the batch
                out.append({"url": page.get("url"), "kind": "error", "error": str(exc)[:200]})
        self._send(200, out)

    def _send(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
