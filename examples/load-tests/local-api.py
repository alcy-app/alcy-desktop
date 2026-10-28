"""Stateless, loopback-only companion API for substantial.k6.js (standard library only)."""

import argparse
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import socket
from threading import Lock
import time
from urllib.parse import parse_qs, urlsplit


PRODUCTS = [
    {"sku": f"sku-{index:03}", "name": f"Demo product {index}",
     "category": "hardware", "price": round(19.9 * index, 2), "inStock": True}
    for index in range(1, 51)
]
ASSET = b"Alcy local load test asset.\n" * 2500
ASSET = ASSET[:65536]


class LocalAPI(ThreadingHTTPServer):
    request_queue_size = 256

    def __init__(self, address):
        super().__init__(address, Handler)
        self.metrics_lock = Lock()
        self.counts = Counter()
        self.in_flight = 0
        self.peak_in_flight = 0
        self.started_at = time.monotonic()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.connection.settimeout(10)

    def log_message(self, _format, *args):
        # Per-request terminal output would distort the load demonstration.
        pass

    def respond(self, status, value=None):
        binary = isinstance(value, bytes)
        body = value if binary else json.dumps(value, separators=(",", ":")).encode()
        if status == 204:
            body = b""
        self.send_response(status)
        self.send_header("Content-Type", "application/octet-stream" if binary else "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_request(self):
        url = urlsplit(self.path)
        path = url.path
        with self.server.metrics_lock:
            self.server.counts[f"{self.command} {path}"] += 1
            self.server.in_flight += 1
            self.server.peak_in_flight = max(self.server.peak_in_flight, self.server.in_flight)
        try:
            self.route(path, parse_qs(url.query))
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True
        finally:
            with self.server.metrics_lock:
                self.server.in_flight -= 1

    def route(self, path, query):
        payload = None
        if self.command in {"POST", "PUT", "PATCH"}:
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 1048576:
                    self.close_connection = True
                    return self.respond(413, {"error": "Expected a JSON body up to 1 MiB"})
                payload = json.loads(self.rfile.read(size))
                if not isinstance(payload, dict):
                    return self.respond(400, {"error": "Expected a JSON object"})
            except (ValueError, UnicodeDecodeError):
                self.close_connection = True
                return self.respond(400, {"error": "Invalid JSON body"})

        if self.command == "GET" and path == "/health":
            return self.respond(200, {"status": "ok", "mode": "stateless-demo"})
        if self.command == "GET" and path == "/stats":
            with self.server.metrics_lock:
                stats = {"requests": dict(self.server.counts),
                         "totalRequests": sum(self.server.counts.values()),
                         "inFlight": self.server.in_flight,
                         "peakInFlight": self.server.peak_in_flight,
                         "uptimeSeconds": round(time.monotonic() - self.server.started_at, 2)}
            return self.respond(200, stats)
        if self.command == "GET" and path == "/products":
            try:
                limit = max(1, min(50, int(query.get("limit", ["25"])[0])))
            except ValueError:
                return self.respond(400, {"error": "Invalid limit"})
            return self.respond(200, {"items": PRODUCTS[:limit], "total": len(PRODUCTS)})
        if self.command == "GET" and path.startswith("/products/"):
            product = next((item for item in PRODUCTS if item["sku"] == path.rsplit("/", 1)[1]), None)
            return self.respond(200 if product else 404, product or {"error": "Unknown SKU"})
        if self.command == "GET" and path == "/assets/64k":
            return self.respond(200, ASSET)
        if self.command == "GET" and path == "/delay/75":
            time.sleep(0.075)
            return self.respond(200, {"delayMs": 75})
        if self.command == "POST" and path == "/search":
            return self.respond(200, {"query": payload, "items": PRODUCTS[:25], "total": 25})
        if self.command == "POST" and path == "/cart":
            return self.respond(201, {"id": "current", "cart": payload, "persisted": False})
        if self.command in {"PUT", "PATCH"} and path == "/cart/current":
            return self.respond(200, {"id": "current", "cart": payload, "persisted": False})
        if self.command == "POST" and path == "/checkout/preview":
            items = payload.get("items", [])
            try:
                total = sum(item["quantity"] * item["unitPrice"] for item in items)
            except (KeyError, TypeError):
                return self.respond(400, {"error": "Invalid cart items"})
            return self.respond(200, {"currency": "BRL", "total": round(total, 2), "sandbox": True})
        if self.command == "DELETE" and path == "/cart/current":
            return self.respond(204)
        return self.respond(404, {"error": "Unknown demo route", "path": path})

    do_GET = handle_request
    do_POST = handle_request
    do_PUT = handle_request
    do_PATCH = handle_request
    do_DELETE = handle_request


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    with LocalAPI(("127.0.0.1", args.port)) as server:
        print(f"Local demo API: http://127.0.0.1:{server.server_port} (Ctrl+C to stop)", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
