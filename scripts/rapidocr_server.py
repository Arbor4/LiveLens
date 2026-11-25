#!/usr/bin/env python3
"""
Standalone lightweight RapidOCR HTTP server for LiveLens.

Endpoints:
  GET  /health -> {"ok": true, "engine": "rapidocr_onnxruntime"}
  POST /ocr    -> {"width": W, "height": H, "lines": [{"box": [[x1,y1],...], "rect": {"x":..,"y":..,"width":..,"height":..}, "text": "...", "score": 0.99}]}

Accepts either:
  - application/json: {"imageBase64": "<base64>"}
  - multipart/form-data: field "image" (or "file")
  - raw image bytes in request body (image/png, image/jpeg, etc.)
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import sys
from email.parser import BytesParser
from email.policy import default as email_default_policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

try:
    import numpy as np
    from PIL import Image
    from rapidocr_onnxruntime import RapidOCR
except ImportError as exc:  # pragma: no cover - runtime dependency check
    print(
        f"[rapidocr_server] Missing dependency: {exc}\n"
        "Install with: pip install -r scripts/requirements-ocr.txt",
        file=sys.stderr,
    )
    sys.exit(1)


class OcrEngineHolder:
    def __init__(self) -> None:
        self.engine = RapidOCR()

    def recognize(self, image_bytes: bytes) -> dict[str, Any]:
        with Image.open(io.BytesIO(image_bytes)) as img:
            rgb = img.convert("RGB")
            width, height = rgb.size
            arr = np.asarray(rgb)

        result, _elapse = self.engine(arr)
        lines: list[dict[str, Any]] = []
        if result:
            for item in result:
                if len(item) < 3:
                    continue
                box, text, score = item[0], str(item[1]).strip(), float(item[2])
                if not text:
                    continue
                xs = [float(pt[0]) for pt in box]
                ys = [float(pt[1]) for pt in box]
                min_x = max(0, int(round(min(xs))))
                min_y = max(0, int(round(min(ys))))
                max_x = min(width, int(round(max(xs))))
                max_y = min(height, int(round(max(ys))))
                rect_w = max(1, max_x - min_x)
                rect_h = max(1, max_y - min_y)
                lines.append(
                    {
                        "box": [[float(pt[0]), float(pt[1])] for pt in box],
                        "rect": {
                            "x": min_x,
                            "y": min_y,
                            "width": rect_w,
                            "height": rect_h,
                        },
                        "text": text,
                        "score": round(score, 4),
                    }
                )

        return {
            "width": width,
            "height": height,
            "lines": lines,
        }


def make_handler(holder: OcrEngineHolder):
    class RapidOcrHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: Any) -> None:
            # Keep logs concise.
            sys.stderr.write(f"[rapidocr_server] {self.address_string()} - {format % args}\n")

        def _send_json(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            if self.path.rstrip("/") == "/health":
                self._send_json(200, {"ok": True, "engine": "rapidocr_onnxruntime"})
                return
            self._send_json(404, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            if self.path.rstrip("/") != "/ocr":
                self._send_json(404, {"error": "not found"})
                return

            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length <= 0:
                self._send_json(400, {"error": "empty request body"})
                return

            raw_body = self.rfile.read(content_length)
            content_type = self.headers.get("Content-Type", "")

            try:
                image_bytes = self._extract_image_bytes(raw_body, content_type)
                payload = holder.recognize(image_bytes)
                self._send_json(200, payload)
            except Exception as exc:
                self._send_json(500, {"error": str(exc)})

        def _extract_image_bytes(self, raw_body: bytes, content_type: str) -> bytes:
            lower_ct = content_type.lower()
            if "application/json" in lower_ct:
                data = json.loads(raw_body.decode("utf-8"))
                b64 = data.get("imageBase64") or data.get("image_base64") or ""
                if not b64:
                    raise ValueError("missing imageBase64 field")
                if "," in b64 and b64.startswith("data:"):
                    b64 = b64.split(",", 1)[1]
                return base64.b64decode(b64)

            if "multipart/form-data" in lower_ct:
                header_bytes = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode(
                    "utf-8"
                )
                msg = BytesParser(policy=email_default_policy).parsebytes(header_bytes + raw_body)
                if msg.is_multipart():
                    for part in msg.iter_parts():
                        name = part.get_param("name", header="content-disposition")
                        if name in ("image", "file", "multipartFile"):
                            payload = part.get_payload(decode=True)
                            if payload:
                                return payload
                raise ValueError("missing image field in multipart form")

            return raw_body

    return RapidOcrHandler


def main() -> None:
    parser = argparse.ArgumentParser(description="LiveLens standalone RapidOCR HTTP server")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=9003, help="Bind port (default: 9003)")
    args = parser.parse_args()

    print(f"[rapidocr_server] Initializing RapidOCR...", flush=True)
    holder = OcrEngineHolder()
    server = ThreadingHTTPServer((args.host, args.port), make_handler(holder))
    print(f"[rapidocr_server] Listening on http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[rapidocr_server] Shutting down...", flush=True)
        server.server_close()


if __name__ == "__main__":
    main()
