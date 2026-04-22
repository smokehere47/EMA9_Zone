"""
EMA 9 Zone Strategy — Chart Server  (v5)
=========================================
• Fetches candle data DIRECTLY from Fyers API — no chart_data.json dependency.
• Any symbol can be charted on demand from the UI.
• WebSocket sends snapshot with real OHLCV candles + EMA9 high/low lines.
• Symbol search endpoint returns all symbols from symbol_loader.
• Watchlist CRUD persisted to watchlists.json (unchanged).
"""

import sys
import json
import threading
import webbrowser
import argparse
import queue
from pathlib import Path
from datetime import datetime, timedelta
from typing import Dict, Set

import pytz
import pandas as pd
from flask import Flask, jsonify, render_template, request, abort
from flask_cors import CORS
from flask_sock import Sock

# ── Path setup — allow importing from project root ────────────────────────────
ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

from fyers_client  import get_fyers
from symbol_loader import load_symbols
from indicators    import calculate_indicators
from config        import IST, TIMEFRAME, FETCH_DAYS

BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)
WL_FILE  = DATA_DIR / "watchlists.json"

app  = Flask(__name__, template_folder="templates", static_folder="static")
CORS(app)
sock = Sock(app)

# ── Fyers client (lazy-init so server starts even if creds missing) ───────────
_fyers      = None
_fyers_lock = threading.Lock()

def _get_fyers():
    global _fyers
    if _fyers is not None:
        return _fyers
    with _fyers_lock:
        if _fyers is None:
            try:
                _fyers = get_fyers()
            except Exception as e:
                print(f"  [WARN] Fyers auth failed: {e}")
                _fyers = None
    return _fyers

# ── Known symbols list (loaded once, cached) ─────────────────────────────────
_all_symbols: list[str] = []
_symbols_lock = threading.Lock()

def _get_all_symbols() -> list[str]:
    global _all_symbols
    if _all_symbols:
        return _all_symbols
    with _symbols_lock:
        if not _all_symbols:
            try:
                _all_symbols = load_symbols()
            except Exception as e:
                print(f"  [WARN] Symbol list load failed: {e}")
                _all_symbols = []
    return _all_symbols

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

# ── Public push API (called from main.py / live feed) ────────────────────────
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
        "change": 0, "change_pct": 0,
        "ema9": round(float(ema9_high), 4) if ema9_high is not None else None,
        "ema21": round(float(ema9_low),  4) if ema9_low  is not None else None,
    })

def push_candle_close(symbol: str, candle: dict, wave: dict = None) -> None:
    # New-format candle (consumed by trading terminal frontend)
    _broadcast(symbol, {
        "type": "candle", "symbol": symbol,
        "tf": str(TIMEFRAME) + "m",
        "o": candle.get("open"),  "h": candle.get("high"),
        "l": candle.get("low"),   "c": candle.get("close"),
        "v": candle.get("volume", 0), "time": candle.get("time"),
    })
    # Legacy candle_close (backward compat)
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

# ── Core: fetch candles from Fyers and build snapshot ────────────────────────
def _fetch_snapshot(sym: str, tf: str = None) -> dict:
    """
    Fetch OHLCV candles directly from Fyers API for any symbol.
    Returns a snapshot dict the frontend understands.
    tf: timeframe string from frontend e.g. "3m", "5m", "15m"
       Falls back to config TIMEFRAME if not provided.
    """
    fyers = _get_fyers()
    if fyers is None:
        return {"type": "snapshot", "symbol": sym, "tf": tf or "5m",
                "candles": [], "markers": [],
                "error": "Fyers not authenticated"}

    # Map frontend tf string → Fyers resolution integer
    tf_map = {"1m": "1", "3m": "3", "5m": "5", "15m": "15",
              "30m": "30", "1h": "60", "1d": "D"}
    resolution = tf_map.get(tf or "", str(TIMEFRAME))

    now       = datetime.now(IST)
    range_to  = now.strftime("%Y-%m-%d")
    range_from = (now - timedelta(days=FETCH_DAYS)).strftime("%Y-%m-%d")

    print(f"  [Fyers] Fetching {sym}  res={resolution}  {range_from}→{range_to}")

    try:
        resp = fyers.history({
            "symbol":      sym,
            "resolution":  resolution,
            "date_format": "1",
            "range_from":  range_from,
            "range_to":    range_to,
            "cont_flag":   "1",
        })
    except Exception as e:
        print(f"  [Fyers] Exception for {sym}: {e}")
        return {"type": "snapshot", "symbol": sym, "tf": tf or "5m",
                "candles": [], "markers": [], "error": str(e)}

    if resp.get("s") != "ok":
        code = resp.get("code", "")
        msg  = resp.get("message", "") or resp.get("errmsg", "")
        print(f"  [Fyers] API error for {sym}: code={code} msg={msg}")
        return {"type": "snapshot", "symbol": sym, "tf": tf or "5m",
                "candles": [], "markers": [], "error": msg}

    raw_candles = resp.get("candles", [])
    if not raw_candles:
        return {"type": "snapshot", "symbol": sym, "tf": tf or "5m",
                "candles": [], "markers": []}

    # Build DataFrame + calculate EMA9 high/low
    df = pd.DataFrame(raw_candles, columns=["ts", "open", "high", "low", "close", "vol"])
    df["datetime"] = pd.to_datetime(df["ts"], unit="s", utc=True).dt.tz_convert(IST)
    df = df.sort_values("datetime").reset_index(drop=True)
    df = calculate_indicators(df)

    # Convert to frontend candle format {time, o, h, l, c, v}
    candles = [
        {"time": int(row.ts), "o": row.open, "h": row.high,
         "l": row.low, "c": row.close, "v": int(row.vol)}
        for row in df.itertuples()
    ]

    # EMA9 high/low as separate line series data
    ema9_high = [
        {"time": int(row.ts), "value": round(row.ema9_high, 4)}
        for row in df.itertuples()
        if not pd.isna(row.ema9_high)
    ]
    ema9_low = [
        {"time": int(row.ts), "value": round(row.ema9_low, 4)}
        for row in df.itertuples()
        if not pd.isna(row.ema9_low)
    ]

    print(f"  [Fyers] {sym}: {len(candles)} candles returned")

    return {
        "type":      "snapshot",
        "symbol":    sym,
        "tf":        tf or (str(TIMEFRAME) + "m"),
        "candles":   candles,
        "ema9_high": ema9_high,
        "ema9_low":  ema9_low,
        "markers":   [],
    }

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
    """
    Returns all known symbols.
    Optional ?q= param for search/filter.
    """
    q   = (request.args.get("q") or "").upper().strip()
    all_syms = _get_all_symbols()
    if q:
        matched = [s for s in all_syms if q in s.upper()][:50]
    else:
        matched = all_syms
    return jsonify({"symbols": sorted(matched), "count": len(matched)})

@app.route("/api/status")
def api_status():
    fyers = _get_fyers()
    return jsonify({
        "fyers_connected": fyers is not None,
        "symbols_loaded":  len(_get_all_symbols()),
        "ws_clients":      sum(len(v) for v in _clients.values()),
    })

# ── Watchlist CRUD (unchanged) ────────────────────────────────────────────────
@app.route("/api/watchlists", methods=["GET"])
def api_watchlists_get():
    return jsonify(load_watchlists())

@app.route("/api/watchlists", methods=["POST"])
def api_watchlists_post():
    body = request.get_json(force=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        abort(400, "name required")
    wl = load_watchlists()
    wl[name] = body.get("symbols", [])
    save_watchlists(wl)
    return jsonify({"ok": True, "name": name, "symbols": wl[name]})

@app.route("/api/watchlists/<n>", methods=["PUT"])
def api_watchlist_update(name):
    body = request.get_json(force=True) or {}
    wl   = load_watchlists()
    if name not in wl:
        abort(404, f"Watchlist '{name}' not found")
    wl[name] = body.get("symbols", wl[name])
    save_watchlists(wl)
    return jsonify({"ok": True, "name": name, "symbols": wl[name]})

@app.route("/api/watchlists/<n>/add", methods=["POST"])
def api_watchlist_add_symbol(name):
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

@app.route("/api/watchlists/<n>/remove", methods=["POST"])
def api_watchlist_remove_symbol(name):
    body   = request.get_json(force=True) or {}
    symbol = (body.get("symbol") or "").strip()
    wl = load_watchlists()
    if name in wl and symbol in wl[name]:
        wl[name].remove(symbol)
    save_watchlists(wl)
    return jsonify({"ok": True, "name": name, "symbols": wl.get(name, [])})

@app.route("/api/watchlists/<n>", methods=["DELETE"])
def api_watchlist_delete(name):
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
                if raw is None:
                    break
                ws.send(raw)
            except queue.Empty:
                try:
                    ws.send(json.dumps({"type": "ping"}))
                except Exception:
                    break
            except Exception:
                break

    threading.Thread(target=_sender, daemon=True).start()

    try:
        # On connect — send symbol list so frontend can populate search
        syms = _get_all_symbols()
        ws.send(json.dumps({"type": "symbols", "symbols": sorted(syms)}))

        while True:
            raw = ws.receive(timeout=60)
            if raw is None:
                break
            try:
                msg = json.loads(raw)
            except Exception:
                continue

            action = msg.get("action", "")

            # ── subscribe: client wants to follow a symbol ────────────────────
            if action == "subscribe":
                # Accept both single symbol and array
                sym_raw = msg.get("symbol") or (msg.get("symbols") or [""])[0]
                sym = (sym_raw or "").strip()
                if not sym:
                    continue
                # Drop old subscription
                if current_sym and current_sym != sym:
                    _drop_sub(q, current_sym)
                current_sym = sym
                _add_sub(q, sym)
                # Fetch and send snapshot in background so WS isn't blocked
                tf = msg.get("tf", str(TIMEFRAME) + "m")
                def _send_snapshot(s=sym, t=tf):
                    snap = _fetch_snapshot(s, t)
                    q.put_nowait(json.dumps(snap))
                threading.Thread(target=_send_snapshot, daemon=True).start()

            # ── snapshot: explicit candle history request ─────────────────────
            elif action == "snapshot":
                sym = (msg.get("symbol") or current_sym or "").strip()
                tf  = msg.get("tf", str(TIMEFRAME) + "m")
                if sym:
                    def _send_snap(s=sym, t=tf):
                        snap = _fetch_snapshot(s, t)
                        q.put_nowait(json.dumps(snap))
                    threading.Thread(target=_send_snap, daemon=True).start()

            # ── search: frontend symbol search box ────────────────────────────
            elif action == "search":
                query = (msg.get("q") or "").upper().strip()
                all_s = _get_all_symbols()
                results = [s for s in all_s if query in s.upper()][:40] if query else []
                ws.send(json.dumps({"type": "search_results", "q": query, "symbols": results}))

            # ── unsubscribe ───────────────────────────────────────────────────
            elif action == "unsubscribe":
                _drop_sub(q, msg.get("symbol", current_sym))
                current_sym = ""

            # ── symbols: refresh symbol list ──────────────────────────────────
            elif action == "symbols":
                syms = _get_all_symbols()
                ws.send(json.dumps({"type": "symbols", "symbols": sorted(syms)}))

    except Exception as e:
        print(f"  [WS] Connection error: {e}")
    finally:
        q.put(None)
        _drop_all(q)

# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port",       type=int,  default=5050)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    url = f"http://localhost:{args.port}"
    print(f"\n  EMA 9 Zone Chart Server  (v5)")
    print(f"  ──────────────────────────────────────────")
    print(f"  URL       : {url}")
    print(f"  WebSocket : ws://localhost:{args.port}/ws")
    print(f"  Mode      : Direct Fyers fetch (no JSON file)")
    print(f"  Symbols   : loaded from symbol_loader")
    print()

    if not args.no_browser:
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()

    app.run(host="0.0.0.0", port=args.port, debug=False)