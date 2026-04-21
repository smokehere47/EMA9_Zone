"""
chart_exporter.py
==================
Converts scanner output (OHLCV DataFrame + waves) into chart_data.json
that the Flask server reads.

── How to integrate into your existing main.py ──────────────────────────────

1.  Copy this file into your project root (same folder as main.py).

2.  In main.py, add this import at the top:

        from chart_exporter import export_chart_data

3.  In run_one_day(), after `results.sort(...)`, add:

        export_chart_data(results, _df_cache, target_date)

    That's it.  Every scan automatically writes/updates chart_data.json.

─────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import json
import pytz
from pathlib import Path
from datetime import date as _date, datetime, timezone, timedelta

import pandas as pd

# ── Where to write the JSON ───────────────────────────────────────────────────
_CHART_DIR  = Path(__file__).parent / "ema9_chart" / "data"
_CHART_FILE = _CHART_DIR / "chart_data.json"

IST = pytz.timezone("Asia/Kolkata")

# ── Number of trading days to include in chart ────────────────────────────────
LOOKBACK_DAYS = 2


def _to_unix(dt_val) -> int:
    """Convert a datetime / pandas Timestamp → Unix timestamp (seconds, UTC).

    IMPORTANT: All times are treated as IST (Asia/Kolkata) if they are naive.
    This ensures the chart always displays correct Indian market time (09:15 start).
    """
    if isinstance(dt_val, str):
        dt_val = datetime.strptime(dt_val, "%Y-%m-%d %H:%M")
        dt_val = IST.localize(dt_val)
    elif hasattr(dt_val, "tzinfo") and dt_val.tzinfo is None:
        # Naive datetime — assume IST
        dt_val = IST.localize(dt_val)
    elif hasattr(dt_val, "tzinfo") and dt_val.tzinfo is not None:
        # Already tz-aware — convert to IST to verify, then keep as-is
        dt_val = dt_val.astimezone(IST)
    return int(dt_val.timestamp())


def _df_to_candles(df: pd.DataFrame, target_date: _date) -> list[dict]:
    """Extract OHLCV rows for target_date as Lightweight Charts candle objects."""
    mask = df["datetime"].dt.date == target_date
    day  = df[mask].copy()
    out  = []
    for _, row in day.iterrows():
        out.append({
            "time":   _to_unix(row["datetime"]),
            "open":   round(float(row["open"]),  2),
            "high":   round(float(row["high"]),  2),
            "low":    round(float(row["low"]),   2),
            "close":  round(float(row["close"]), 2),
            "volume": int(row.get("vol", row.get("volume", 0))),
        })
    return out


def _df_to_line(df: pd.DataFrame, target_date: _date, col: str) -> list[dict]:
    """Extract a single indicator column as a Lightweight Charts line series."""
    mask = df["datetime"].dt.date == target_date
    day  = df[mask].copy()
    out  = []
    for _, row in day.iterrows():
        val = row.get(col)
        if val is None or (hasattr(val, "__float__") and pd.isna(val)):
            continue
        out.append({
            "time":  _to_unix(row["datetime"]),
            "value": round(float(val), 2),
        })
    return out


def _get_prev_trading_dates(df: pd.DataFrame, target_date: _date, n: int) -> list[_date]:
    """Get the last n trading dates before (and including) target_date from df."""
    all_dates = sorted(df["datetime"].dt.date.unique())
    dates_up_to = [d for d in all_dates if d <= target_date]
    return dates_up_to[-n:] if len(dates_up_to) >= n else dates_up_to


def _waves_unix(waves: list[dict]) -> list[dict]:
    """Convert wave HH/LL time strings → Unix timestamps."""
    out = []
    for w in waves:
        out.append({
            "wave_number": w["wave_number"],
            "sequence":    w["sequence"],
            "ds_high":     w.get("ds_high"),
            "ds_low":      w.get("ds_low"),
            "ds_time":     w.get("ds_time"),
            "hh_val":      w["hh_val"],
            "hh_time":     _to_unix(w["hh_time"]),
            "ll_val":      w["ll_val"],
            "ll_time":     _to_unix(w["ll_time"]),
        })
    return out


def export_chart_data(
    results:     list,           # [(symbol, waves), ...]  from scan_all
    df_cache:    dict,           # {symbol: DataFrame}      from _df_cache
    target_date: _date,
) -> None:
    """
    Build chart_data.json from scan results.
    Now includes last LOOKBACK_DAYS days of OHLCV data for each symbol.

    Parameters
    ----------
    results     : list of (symbol, waves) tuples produced by scan_all()
    df_cache    : dict mapping symbol → OHLCV + indicator DataFrame
    target_date : the trading date being scanned
    """
    _CHART_DIR.mkdir(parents=True, exist_ok=True)

    existing: dict = {}
    if _CHART_FILE.exists():
        try:
            with open(_CHART_FILE) as f:
                existing = json.load(f)
        except Exception:
            existing = {}

    for symbol, waves in results:
        df = df_cache.get(symbol)
        if df is None:
            continue

        # Primary day data
        candles   = _df_to_candles(df, target_date)
        ema9_high = _df_to_line(df, target_date, "ema9_high")
        ema9_low  = _df_to_line(df, target_date, "ema9_low")
        wave_data = _waves_unix(waves)

        # Multi-day data (last LOOKBACK_DAYS trading days)
        trading_dates = _get_prev_trading_dates(df, target_date, LOOKBACK_DAYS)
        multi_day = []
        for d in trading_dates:
            day_candles = _df_to_candles(df, d)
            if day_candles:
                multi_day.append({
                    "date":      str(d),
                    "candles":   day_candles,
                    "ema9_high": _df_to_line(df, d, "ema9_high"),
                    "ema9_low":  _df_to_line(df, d, "ema9_low"),
                })

        existing[symbol] = {
            "date":      str(target_date),
            "candles":   candles,
            "ema9_high": ema9_high,
            "ema9_low":  ema9_low,
            "waves":     wave_data,
            "multi_day": multi_day,
        }

    with open(_CHART_FILE, "w") as f:
        json.dump(existing, f, indent=2)

    total_waves = sum(len(w) for _, w in results)
    print(f"\n  Chart data exported → {_CHART_FILE}")
    print(f"  Symbols : {len(results)}  |  Total waves : {total_waves}")
    print(f"  Days    : Last {LOOKBACK_DAYS} trading days included")
    print(f"  Run `python ema9_chart/server.py` to open the chart.\n")
