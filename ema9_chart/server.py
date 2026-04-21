"""
EMA 9 Zone Strategy — Chart Server  (v4)
=========================================
REST + WebSocket server. No fyers_feed dependency.
New: /api/watchlists CRUD endpoints for persistent watchlists.
"""

import json
import threading
import webbrowser
import argparse
import queue
from pathlib import Path
from datetime import datetime
from typing import Dict, Set

import pytz
from flask import Flask, jsonify, render_template, request, abort
from flask_cors import CORS
from flask_sock import Sock

BASE_DIR  = Path(__file__).parent
DATA_DIR  = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)
WL_FILE   = DATA_DIR / "watchlists.json"   # persistent watchlist storage

IST = pytz.timezone("Asia/Kolkata")

app  = Flask(__name__, template_folder="templates", static_folder="static")
CORS(app)
sock = Sock(app)

# ── WebSocket client registry ─────────────────────────────────────────────────
_clients: Dict[str, Set[queue.SimpleQueue]] = {}
_all_q:   Set[queue.SimpleQueue]            = set()
_clock = threading.Lock()

def _add_sub(q, symbol):
    with _clock:
        _all_q.add(q)
        _clients.setdefault(symbol, set()).add(q)

def _drop_sub(q, symbol=""):
    with _clock:
        _all_q.discard(q)
        if symbol and symbol in _clients:
            _clients[symbol].discard(q)
            if not _clients[symbol]:
                del _clients[symbol]

def _drop_all(q):
    with _clock:
        _all_q.discard(q)
        for sym in list(_clients):
            _clients[sym].discard(q)
            if not _clients[sym]:
                del _clients[sym]

def _broadcast(symbol: str, msg: dict):
    raw = json.dumps(msg)
    with _clock:
        targets = set(_clients.get(symbol, set()))
    for q in targets:
        try:
            q.put_nowait(raw)
        except Exception:
            pass

# ── Public push API (for live feed integration) ───────────────────────────────
def push_tick(symbol: str, price: float, volume: int = 0,
              ema9_high: float = None, ema9_low: float = None,
              timestamp: datetime = None) -> None:
    if timestamp is None:
        timestamp = datetime.now(tz=IST)
    elif timestamp.tzinfo is None:
        timestamp = IST.localize(timestamp)
    _broadcast(symbol, {
        "type": "tick", "symbol": symbol,
        "time": int(timestamp.timestamp()),
        "price": round(float(price), 2), "volume": int(volume),
        "ema9_high": round(float(ema9_high), 4) if ema9_high is not None else None,
        "ema9_low":  round(float(ema9_low),  4) if ema9_low  is not None else None,
    })

def push_candle_close(symbol: str, candle: dict, wave: dict = None) -> None:
    msg: dict = {"type": "candle_close", "symbol": symbol, "candle": candle}
    if wave:
        n = wave["wave_number"]
        msg["wave"] = wave
        msg["markers"] = [
            {"time": wave["hh_time"], "position": "aboveBar",
             "color": "#26a69a", "shape": "circle", "text": f"HH{n}", "size": 1.5},
            {"time": wave["ll_time"], "position": "belowBar",
             "color": "#ef5350", "shape": "circle", "text": f"LL{n}", "size": 1.5},
        ]
    _broadcast(symbol, msg)

# ── Data helpers ──────────────────────────────────────────────────────────────
def load_chart_data() -> dict:
    path = DATA_DIR / "chart_data.json"
    if not path.exists():
        return {}
    with open(path) as f:
        return json.load(f)

def unix_to_ist_str(unix_ts: int) -> str:
    return datetime.fromtimestamp(unix_ts, tz=IST).strftime("%Y-%m-%d %H:%M IST")

def get_candle_extremes(candles: list) -> dict:
    if not candles:
        return {}
    start = candles[0]; end = candles[-1]
    highs = [c["high"] for c in candles]; lows = [c["low"] for c in candles]
    dh = max(highs); dl = min(lows)
    dhc = next(c for c in candles if c["high"] == dh)
    dlc = next(c for c in candles if c["low"]  == dl)
    return {
        "start_candle": {"time": start["time"], "time_ist": unix_to_ist_str(start["time"]),
                         "open": start["open"], "high": start["high"],
                         "low": start["low"],   "close": start["close"]},
        "end_candle":   {"time": end["time"],   "time_ist": unix_to_ist_str(end["time"]),
                         "open": end["open"],   "high": end["high"],
                         "low": end["low"],     "close": end["close"]},
        "day_high": {"value": dh, "time": dhc["time"], "time_ist": unix_to_ist_str(dhc["time"])},
        "day_low":  {"value": dl, "time": dlc["time"], "time_ist": unix_to_ist_str(dlc["time"])},
    }

def _build_markers(waves: list) -> list:
    markers = []
    for w in waves:
        n = w["wave_number"]
        markers.append({"time": w["hh_time"], "position": "aboveBar",
                         "color": "#26a69a", "shape": "circle", "text": f"HH{n}", "size": 1.5})
        markers.append({"time": w["ll_time"], "position": "belowBar",
                         "color": "#ef5350", "shape": "circle", "text": f"LL{n}", "size": 1.5})
    return sorted(markers, key=lambda m: m["time"])

# ── Watchlist persistence ─────────────────────────────────────────────────────
def load_watchlists() -> dict:
    if not WL_FILE.exists():
        return {"Default": []}
    try:
        return json.loads(WL_FILE.read_text())
    except Exception:
        return {"Default": []}

def save_watchlists(data: dict):
    WL_FILE.write_text(json.dumps(data, indent=2))

# ── REST routes ───────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/symbols")
def api_symbols():
    data = load_chart_data()
    return jsonify({"symbols": sorted(data.keys()), "count": len(data)})

@app.route("/api/chart/<path:symbol>")
def api_chart(symbol):
    data = load_chart_data()
    if symbol not in data:
        abort(404, description=f"Symbol '{symbol}' not found.")
    entry    = data[symbol]
    candles  = entry.get("candles", [])
    waves    = entry.get("waves",   [])
    extremes = get_candle_extremes(candles)
    if extremes:
        sc = extremes["start_candle"]; ec = extremes["end_candle"]
        dh = extremes["day_high"];     dl = extremes["day_low"]
        print(f"\n  {symbol} ({entry.get('date')})")
        print(f"  START [{sc['time_ist']}] O:{sc['open']} H:{sc['high']} L:{sc['low']} C:{sc['close']}")
        print(f"  END   [{ec['time_ist']}] O:{ec['open']} H:{ec['high']} L:{ec['low']} C:{ec['close']}")
        print(f"  DAY H [{dh['time_ist']}] {dh['value']}  |  DAY L [{dl['time_ist']}] {dl['value']}")
    return jsonify({
        "symbol": symbol, "date": entry.get("date"),
        "candles": candles,
        "ema9_high": entry.get("ema9_high", []),
        "ema9_low":  entry.get("ema9_low",  []),
        "waves": waves, "markers": _build_markers(waves),
        "extremes": extremes, "multi_day": entry.get("multi_day", []),
    })

@app.route("/api/status")
def api_status():
    path = DATA_DIR / "chart_data.json"
    if path.exists():
        stat = path.stat()
        return jsonify({"data_file": str(path),
                        "size_kb": round(stat.st_size / 1024, 1),
                        "modified": stat.st_mtime})
    return jsonify({"data_file": None})

# ── Watchlist CRUD ────────────────────────────────────────────────────────────
@app.route("/api/watchlists", methods=["GET"])
def api_watchlists_get():
    """GET /api/watchlists → {"Default": ["NSE:RELIANCE-EQ", ...], "My List": [...]}"""
    return jsonify(load_watchlists())

@app.route("/api/watchlists", methods=["POST"])
def api_watchlists_post():
    """POST /api/watchlists  body: {"name": "My List", "symbols": [...]}"""
    body = request.get_json(force=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        abort(400, "name required")
    wl = load_watchlists()
    wl[name] = body.get("symbols", [])
    save_watchlists(wl)
    return jsonify({"ok": True, "name": name, "symbols": wl[name]})

@app.route("/api/watchlists/<name>", methods=["PUT"])
def api_watchlist_update(name):
    """PUT /api/watchlists/<name>  body: {"symbols": [...]}"""
    body = request.get_json(force=True) or {}
    wl   = load_watchlists()
    if name not in wl:
        abort(404, f"Watchlist '{name}' not found")
    wl[name] = body.get("symbols", wl[name])
    save_watchlists(wl)
    return jsonify({"ok": True, "name": name, "symbols": wl[name]})

@app.route("/api/watchlists/<name>/add", methods=["POST"])
def api_watchlist_add_symbol(name):
    """POST /api/watchlists/<name>/add  body: {"symbol": "NSE:RELIANCE-EQ"}"""
    body   = request.get_json(force=True) or {}
    symbol = (body.get("symbol") or "").strip()
    if not symbol:
        abort(400, "symbol required")
    wl = load_watchlists()
    if name not in wl:
        wl[name] = []
    if symbol not in wl[name]:
        wl[name].append(symbol)
    save_watchlists(wl)
    return jsonify({"ok": True, "name": name, "symbols": wl[name]})

@app.route("/api/watchlists/<name>/remove", methods=["POST"])
def api_watchlist_remove_symbol(name):
    """POST /api/watchlists/<name>/remove  body: {"symbol": "NSE:RELIANCE-EQ"}"""
    body   = request.get_json(force=True) or {}
    symbol = (body.get("symbol") or "").strip()
    wl = load_watchlists()
    if name in wl and symbol in wl[name]:
        wl[name].remove(symbol)
    save_watchlists(wl)
    return jsonify({"ok": True, "name": name, "symbols": wl.get(name, [])})

@app.route("/api/watchlists/<name>", methods=["DELETE"])
def api_watchlist_delete(name):
    """DELETE /api/watchlists/<name>"""
    wl = load_watchlists()
    wl.pop(name, None)
    save_watchlists(wl)
    return jsonify({"ok": True})

# ── WebSocket ─────────────────────────────────────────────────────────────────
@sock.route("/ws")
def ws_endpoint(ws):
    q: queue.SimpleQueue = queue.SimpleQueue()
    current_sym = ""

    def _sender():
        while True:
            try:
                raw = q.get(timeout=25)
                if raw is None: break
                ws.send(raw)
            except queue.Empty:
                try: ws.send(json.dumps({"type": "ping"}))
                except: break
            except: break

    threading.Thread(target=_sender, daemon=True).start()

    try:
        data = load_chart_data()
        ws.send(json.dumps({"type": "symbols", "symbols": sorted(data.keys())}))

        while True:
            raw = ws.receive(timeout=60)
            if raw is None: break
            try:
                msg = json.loads(raw)
            except: continue

            action = msg.get("action", "")

            if action == "subscribe":
                sym = msg.get("symbol", "").strip()
                if not sym: continue
                if current_sym: _drop_sub(q, current_sym)
                current_sym = sym
                _add_sub(q, sym)
                data = load_chart_data()
                if sym in data:
                    entry   = data[sym]
                    candles = entry.get("candles", [])
                    waves   = entry.get("waves",   [])
                    ws.send(json.dumps({
                        "type": "snapshot", "symbol": sym,
                        "date": entry.get("date"),
                        "candles": candles,
                        "ema9_high": entry.get("ema9_high", []),
                        "ema9_low":  entry.get("ema9_low",  []),
                        "waves": waves, "markers": _build_markers(waves),
                        "multi_day": entry.get("multi_day", []),
                        "extremes": get_candle_extremes(candles),
                    }))
                else:
                    ws.send(json.dumps({
                        "type": "snapshot", "symbol": sym,
                        "candles": [], "ema9_high": [], "ema9_low": [],
                        "waves": [], "markers": [], "multi_day": [], "extremes": {},
                    }))

            elif action == "unsubscribe":
                _drop_sub(q, msg.get("symbol", current_sym))
                current_sym = ""

            elif action == "symbols":
                data = load_chart_data()
                ws.send(json.dumps({"type": "symbols", "symbols": sorted(data.keys())}))

    except: pass
    finally:
        q.put(None)
        _drop_all(q)

# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port",       type=int,  default=5050)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--live",       action="store_true")
    args = parser.parse_args()

    url = f"http://localhost:{args.port}"
    print(f"\n  EMA 9 Zone Chart Server  (v4)")
    print(f"  ──────────────────────────────")
    print(f"  URL       : {url}")
    print(f"  WebSocket : ws://localhost:{args.port}/ws")
    print(f"  Data      : {DATA_DIR / 'chart_data.json'}")
    print(f"  Watchlists: {WL_FILE}")
    print()

    if not args.no_browser:
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()

    app.run(host="0.0.0.0", port=args.port, debug=False)
