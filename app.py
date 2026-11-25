"""Serve the Smart Irrigation demo and persist readings/events in SQLite."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from datetime import datetime, timezone
import json
import os
import sqlite3


ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "irrigation.db"


def connect_db():
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def initialise_db():
    with connect_db() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS readings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                recorded_at TEXT NOT NULL,
                simulated_tick INTEGER NOT NULL,
                tray TEXT NOT NULL,
                moisture_percent REAL NOT NULL,
                flow_lpm REAL NOT NULL DEFAULT 0,
                water_total_l REAL NOT NULL DEFAULT 0,
                water_today_l REAL NOT NULL DEFAULT 0,
                status TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS irrigation_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                recorded_at TEXT NOT NULL,
                simulated_tick INTEGER NOT NULL,
                tray TEXT NOT NULL,
                message TEXT NOT NULL
            );
        """)


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class AppHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 100_000:
            raise ValueError("Request body is too large")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        request = urlparse(self.path)
        if request.path == "/api/health":
            return self.send_json({"ok": True, "database": DB_PATH.name})
        if request.path == "/api/history":
            try:
                limit = min(max(int(parse_qs(request.query).get("limit", [100])[0]), 1), 500)
            except ValueError:
                return self.send_json({"error": "limit must be a number"}, 400)
            with connect_db() as db:
                readings = [dict(row) for row in db.execute(
                    "SELECT * FROM readings ORDER BY id DESC LIMIT ?", (limit,)
                )]
                events = [dict(row) for row in db.execute(
                    "SELECT * FROM irrigation_events ORDER BY id DESC LIMIT ?", (limit,)
                )]
            return self.send_json({"readings": readings, "events": events})
        return super().do_GET()

    def do_POST(self):
        request = urlparse(self.path)
        try:
            body = self.read_json()
            if request.path == "/api/readings":
                readings = body.get("readings", [])
                if not isinstance(readings, list) or not readings:
                    raise ValueError("readings must be a non-empty list")
                rows = []
                for reading in readings:
                    rows.append((
                        utc_now(), int(reading["tick"]), str(reading["tray"]),
                        float(reading["moisture"]), float(reading.get("flow", 0)),
                        float(reading.get("total_water", 0)), float(reading.get("today_water", 0)),
                        str(reading.get("status", "Monitoring")),
                    ))
                with connect_db() as db:
                    db.executemany("""
                        INSERT INTO readings (recorded_at, simulated_tick, tray, moisture_percent,
                                              flow_lpm, water_total_l, water_today_l, status)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """, rows)
                return self.send_json({"stored": len(rows)}, 201)
            if request.path == "/api/events":
                event = body.get("event", body)
                row = (utc_now(), int(event["tick"]), str(event["tray"]), str(event["message"]))
                with connect_db() as db:
                    db.execute("INSERT INTO irrigation_events (recorded_at, simulated_tick, tray, message) VALUES (?, ?, ?, ?)", row)
                return self.send_json({"stored": 1}, 201)
            return self.send_json({"error": "Not found"}, 404)
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            return self.send_json({"error": str(error)}, 400)


if __name__ == "__main__":
    os.chdir(ROOT)
    initialise_db()
    address = ("0.0.0.0", 8000)
    print(f"Smart Irrigation is available at http://localhost:{address[1]}")
    print(f"Data is stored in {DB_PATH.name}")
    print("Press Ctrl+C to stop the server.")
    try:
        ThreadingHTTPServer(address, AppHandler).serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
