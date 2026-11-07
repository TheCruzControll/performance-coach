#!/usr/bin/env python3
"""Serve the status page on 127.0.0.1:8765 and rerun the collector every 60 s."""
import http.server, os, threading, time, traceback

import collector

DIR = os.path.dirname(os.path.abspath(__file__))
PORT = 8765


def loop():
    while True:
        try:
            collector.collect()
        except Exception:  # noqa: BLE001 keep serving the last good status.json
            traceback.print_exc()
        time.sleep(60)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=DIR, **kw)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    threading.Thread(target=loop, daemon=True).start()
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
