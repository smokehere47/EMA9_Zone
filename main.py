# ================= MAIN — EMA 9 ZONE SCANNER =================
#
# Pure EMA 9 Zone Strategy. No 3C Break logic.
#
# Pipeline (per symbol, per scan cycle):
#
#   fetch → build_df → calculate_indicators → detect_zone → collect_waves
#
# Output format (per symbol with waves found):
#
#   Stock Name: <SYMBOL>
#   Wave 1:
#     Higher High 1 → (Time) (Value)
#     Lower Low   1 → (Time) (Value)
#   Wave 2:
#     Higher High 2 → (Time) (Value)
#     Lower Low   2 → (Time) (Value)
#   ...
#
# Each wave = one Higher High + one Lower Low (any sequence: HH→LL or LL→HH).
# Waves are sequential and non-overlapping across the trading day.
#
# Modes:
#   SINGLE  — backtest a specific date (OVERRIDE_TRADING_DAY in config)
#   RANGE   — backtest a date range   (OVERRIDE_DATE_RANGE in config)
#   LIVE    — real-time scanning      (both overrides = None)

import sys
import time
import asyncio
import threading
import pandas as pd
from datetime import datetime, timedelta, date as _date
from concurrent.futures import ThreadPoolExecutor

from config import (
    IST, TIMEFRAME, FETCH_DAYS, EMA_PERIOD,
    SAVE_SIGNALS_TO_CSV, CSV_OUTPUT_PATH,
    SEND_TELEGRAM, OVERRIDE_TRADING_DAY, OVERRIDE_DATE_RANGE,
    ENABLE_ANALYSIS, ENABLE_OVERNIGHT,
    SAVE_REPORT_XLSX, REPORT_XLSX_DIR,
)
from fyers_client  import get_fyers, check_token_mid_run
from symbol_loader import load_symbols
from time_utils    import get_last_trading_day, get_last_closed_candle_time
from indicators    import calculate_indicators
from ema9_zone     import (
    detect_zone, collect_waves,
    get_zone_entry, get_zone_registry, clear_zone_registry,
)
from telegram_utils import send_startup_message
from sent_signals   import load_sent
from signal_exporter import save_signals
from chart_exporter import export_chart_data

print("\n  EMA 9 ZONE SCANNER STARTED\n")

fyers   = get_fyers()
symbols = load_symbols()

if SEND_TELEGRAM:
    send_startup_message()

shown_today:     dict[str, list] = {}   # symbol → list of wave dicts
shown_today_date = None
last_processed   = None

_df_cache:    dict[str, pd.DataFrame] = {}
_fetch_times: list[float]             = []

_ASYNC_MAX_CONCURRENT = 10
_state_lock = threading.Lock()
_tg_lock    = threading.Lock()


# ─────────────────────────────────────────────────────────────────────────────
# Mode detection
# ─────────────────────────────────────────────────────────────────────────────

if OVERRIDE_DATE_RANGE:
    _range_start = _date.fromisoformat(OVERRIDE_DATE_RANGE[0])
    _range_end   = _date.fromisoformat(OVERRIDE_DATE_RANGE[1])
    RUN_MODE = "RANGE"
elif OVERRIDE_TRADING_DAY:
    RUN_MODE = "SINGLE"
else:
    RUN_MODE = "LIVE"


def _eod_dt(d: _date) -> datetime:
    return IST.localize(datetime.combine(d, datetime.min.time()).replace(
        hour=15, minute=30, second=0, microsecond=0
    ))


def resolve_target_date(now: datetime) -> _date:
    return get_last_trading_day(now)


def backtest_dates() -> list[_date]:
    from time_utils import is_trading_day
    if RUN_MODE == "SINGLE":
        return [_date.fromisoformat(OVERRIDE_TRADING_DAY)]
    dates, cur = [], _range_start
    while cur <= _range_end:
        if is_trading_day(cur):
            dates.append(cur)
        cur += timedelta(days=1)
    return dates


# ─────────────────────────────────────────────────────────────────────────────
# DataFrame builder
# ─────────────────────────────────────────────────────────────────────────────

def build_df(response: dict, last_closed: datetime) -> pd.DataFrame | None:
    candles = response.get("candles", [])
    if not candles:
        return None
    df = pd.DataFrame(candles, columns=["ts", "open", "high", "low", "close", "vol"])
    df["datetime"] = pd.to_datetime(df["ts"], unit="s", utc=True).dt.tz_convert(IST)
    df = df.drop(columns="ts").sort_values("datetime").reset_index(drop=True)
    df = df[df["datetime"] <= last_closed]
    if len(df) < EMA_PERIOD:
        return None
    return calculate_indicators(df)


# ─────────────────────────────────────────────────────────────────────────────
# Output formatter
# ─────────────────────────────────────────────────────────────────────────────

def format_wave_output(symbol: str, waves: list[dict]) -> str:
    """
    Produces the structured wave output:

        Stock Name: NSE:SYMBOL-EQ
        Wave 1:
          Higher High 1 → 2026-04-15 09:21  931.80
          Lower Low   1 → 2026-04-15 09:39  924.30
        Wave 2:
          Higher High 2 → ...
          Lower Low   2 → ...
    """
    lines = [f"Stock Name: {symbol}"]
    for w in waves:
        n   = w["wave_number"]
        seq = w["sequence"]   # "HH_LL" or "LL_HH"

        lines.append(f"Wave {n}:")

        if seq == "HH_LL":
            lines.append(f"  Higher High {n} → {w['hh_time']}  {w['hh_val']:.2f}")
            lines.append(f"  Lower Low   {n} → {w['ll_time']}  {w['ll_val']:.2f}")
        else:   # LL_HH
            lines.append(f"  Lower Low   {n} → {w['ll_time']}  {w['ll_val']:.2f}")
            lines.append(f"  Higher High {n} → {w['hh_time']}  {w['hh_val']:.2f}")

    return "\n".join(lines)


def print_wave_output(symbol: str, waves: list[dict]) -> None:
    print()
    print(format_wave_output(symbol, waves))
    print("─" * 42)


# ─────────────────────────────────────────────────────────────────────────────
# Worker: fetch + detect zones + collect waves
# ─────────────────────────────────────────────────────────────────────────────

def _fetch_and_process(
    symbol:       str,
    last_closed:  datetime,
    target_date:  _date,
    results:      list,       # shared list — append (symbol, waves) tuples
    results_lock: threading.Lock,
) -> str:
    """
    Runs in a thread-pool worker.

    Pipeline:
        fetch → build_df → calculate_indicators → collect_waves

    Returns "ok" | "expired" | "429"
    """
    # ── Fetch ─────────────────────────────────────────────────────────────────
    t0 = time.time()
    try:
        response = fyers.history({
            "symbol":      symbol,
            "resolution":  TIMEFRAME,
            "date_format": "1",
            "range_from":  (last_closed - timedelta(days=FETCH_DAYS)).strftime("%Y-%m-%d"),
            "range_to":    last_closed.strftime("%Y-%m-%d"),
            "cont_flag":   "1",
        })
    except Exception as e:
        print(f"\n  [{symbol}] Request exception: {e}")
        return "ok"

    fetch_secs = round(time.time() - t0, 2)
    with _state_lock:
        _fetch_times.append(fetch_secs)

    # ── Validate response ─────────────────────────────────────────────────────
    if response.get("s") != "ok":
        if check_token_mid_run(response):
            return "expired"
        code = response.get("code", "")
        if str(code) in ("-300", "300"):
            return "ok"
        if str(code) == "429":
            return "429"
        msg = response.get("message", "") or response.get("errmsg", "")
        print(f"\n  [{symbol}] API error | code: {code} | msg: {msg}")
        return "ok"

    # ── Build DataFrame + indicators ──────────────────────────────────────────
    df = build_df(response, last_closed)
    if df is None:
        return "ok"

    with _state_lock:
        _df_cache[symbol] = df

    # ── Collect all waves for the target date ─────────────────────────────────
    waves = collect_waves(df, target_date)
    if not waves:
        return "ok"

    with results_lock:
        results.append((symbol, waves))

    return "ok"


# ─────────────────────────────────────────────────────────────────────────────
# Async orchestrator
# ─────────────────────────────────────────────────────────────────────────────

async def _run_concurrent(
    to_fetch:     list[str],
    last_closed:  datetime,
    target_date:  _date,
    results:      list,
    results_lock: threading.Lock,
    is_range:     bool,
) -> bool:
    loop     = asyncio.get_running_loop()
    executor = ThreadPoolExecutor(max_workers=_ASYNC_MAX_CONCURRENT)

    token_expired   = [False]
    rate_limited_q: list[str] = []
    total           = len(to_fetch)
    done_ctr        = [0]
    done_lock       = asyncio.Lock()
    rl_lock         = asyncio.Lock()
    sem             = asyncio.Semaphore(_ASYNC_MAX_CONCURRENT)

    async def _one(symbol: str):
        async with sem:
            result = await loop.run_in_executor(
                executor, _fetch_and_process,
                symbol, last_closed, target_date, results, results_lock,
            )
        if result == "expired":
            token_expired[0] = True
        elif result == "429":
            async with rl_lock:
                rate_limited_q.append(symbol)

        if not is_range:
            async with done_lock:
                done_ctr[0] += 1
                pct = done_ctr[0] * 100 // total
                bar = "█" * (pct // 5) + "░" * (20 - pct // 5)
                sys.stdout.write(f"\r  [{bar}] {done_ctr[0]}/{total}   ")
                sys.stdout.flush()

    await asyncio.gather(*[_one(s) for s in to_fetch])

    # Retry on 429
    _RETRY_CONCURRENCY = [5, 3, 2, 1]
    _RETRY_WAITS       = [2.0, 4.0, 6.0, 8.0]
    retry_round = 0

    while rate_limited_q and not token_expired[0]:
        retry_count = len(rate_limited_q)
        wait_s      = _RETRY_WAITS[min(retry_round, len(_RETRY_WAITS) - 1)]
        conc        = _RETRY_CONCURRENCY[min(retry_round, len(_RETRY_CONCURRENCY) - 1)]

        if not is_range:
            sys.stdout.write("\r" + " " * 60 + "\r")
            sys.stdout.write(
                f"  {retry_count} symbol(s) rate-limited — "
                f"retry #{retry_round + 1} in {wait_s:.0f}s  [concurrency={conc}]..."
            )
            sys.stdout.flush()

        await asyncio.sleep(wait_s)

        next_q    : list[str] = []
        sem_r      = asyncio.Semaphore(conc)
        retry_done = [0]
        next_lock  = asyncio.Lock()

        async def _retry(symbol: str, _sem=sem_r):
            async with _sem:
                result = await loop.run_in_executor(
                    executor, _fetch_and_process,
                    symbol, last_closed, target_date, results, results_lock,
                )
            if result == "expired":
                token_expired[0] = True
            elif result == "429":
                async with next_lock:
                    next_q.append(symbol)

            if not is_range:
                async with done_lock:
                    retry_done[0] += 1
                    sys.stdout.write(
                        f"\r  Retry #{retry_round + 1}: {retry_done[0]}/{retry_count}   "
                    )
                    sys.stdout.flush()

        await asyncio.gather(*[_retry(s) for s in rate_limited_q])
        rate_limited_q = next_q
        retry_round   += 1

    if not is_range:
        sys.stdout.write("\r" + " " * 60 + "\r")

    executor.shutdown(wait=False)
    return token_expired[0]


# ─────────────────────────────────────────────────────────────────────────────
# scan_all
# ─────────────────────────────────────────────────────────────────────────────

def scan_all(
    symbol_list: list[str],
    last_closed: datetime,
    target_date: _date,
    is_range:    bool = False,
) -> tuple[list, bool]:
    """
    Scans all symbols concurrently.
    Returns (results, token_expired).
    results is a list of (symbol, waves) tuples.
    """
    results      : list          = []
    results_lock : threading.Lock = threading.Lock()

    if not is_range:
        print(f"  Fetching {len(symbol_list)} symbol(s)  "
              f"[concurrency={_ASYNC_MAX_CONCURRENT}, auto-retry on 429]")

    token_expired = asyncio.run(_run_concurrent(
        symbol_list, last_closed, target_date,
        results, results_lock, is_range,
    ))
    return results, token_expired


# ─────────────────────────────────────────────────────────────────────────────
# run_one_day
# ─────────────────────────────────────────────────────────────────────────────

def run_one_day(
    target_date: _date,
    last_closed: datetime,
    is_backtest: bool,
    is_range:    bool = False,
) -> None:
    global shown_today_date

    shown_today.clear()
    _df_cache.clear()
    clear_zone_registry()
    shown_today_date = target_date

    mode_tag = "[BACKTEST]" if is_backtest else "[LIVE]"
    if not is_range:
        print(f"\n  {'=' * 50}")
        print(f"  Target date : {target_date}  {mode_tag}")
        print(f"  Last closed : {last_closed.strftime('%Y-%m-%d %H:%M')}")
        print(f"  Symbols     : {len(symbols)} total  |  Concurrency: {_ASYNC_MAX_CONCURRENT}")
        print(f"  {'=' * 50}")
    else:
        sys.stdout.write(f"\r  Scanning {target_date} ...                          ")
        sys.stdout.flush()

    _fetch_times.clear()
    scan_start = time.time()

    results, token_expired = scan_all(symbols, last_closed, target_date, is_range=is_range)

    if token_expired:
        print("  Token expired — auto-refreshing...")
        try:
            global fyers
            fyers = get_fyers()
            print("  Token refreshed — re-running...")
            results, _ = scan_all(symbols, last_closed, target_date, is_range=is_range)
        except SystemExit as e:
            from telegram_utils import send_alert
            send_alert("<b>Token refresh failed</b>\n" + str(e))
            raise

    scan_secs = time.time() - scan_start

    # Sort results by symbol name for consistent output
    results.sort(key=lambda x: x[0])
    export_chart_data(results, _df_cache, target_date)  # ← add this

    # Store for day tracking
    for symbol, waves in results:
        shown_today[symbol] = waves

    if not is_range:
        if results:
            print(f"\n  EMA 9 Zone Waves — {target_date}")
            print(f"  {'─' * 42}")
            for symbol, waves in results:
                print_wave_output(symbol, waves)
        else:
            print("\n  (no zone setups found)")

        print()
        fc = len(_fetch_times)
        if fc > 0:
            print(f"  Timing breakdown:")
            print(f"    Fetched : {fc}  |  avg {sum(_fetch_times)/fc:.2f}s"
                  f"  |  slowest {max(_fetch_times):.2f}s")
            print(f"    Total   : {scan_secs:.1f}s")

        zone_count = len(get_zone_registry())
        total_waves = sum(len(w) for w in shown_today.values())
        print(f"  Scan complete in {scan_secs:.1f}s")
        print(f"  Symbols with zones : {len(shown_today)}")
        print(f"  Total waves found  : {total_waves}")

    else:
        sys.stdout.write("\r" + " " * 60 + "\r")
        total_waves = sum(len(w) for w in shown_today.values())
        print(f"  [{target_date}]  Symbols: {len(shown_today)}"
              f"  |  Waves: {total_waves}")


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────

if RUN_MODE in ("SINGLE", "RANGE"):
    dates    = backtest_dates()
    is_range = (RUN_MODE == "RANGE")

    print(f"  Mode  : BACKTEST ({RUN_MODE})")
    print(f"  Dates : {[str(d) for d in dates]}")
    print()

    for target_date in dates:
        run_one_day(target_date, _eod_dt(target_date), is_backtest=True, is_range=is_range)

    print(f"\n  {'=' * 50}")
    print(f"  Backtest complete — {len(dates)} day(s) processed.")
    print(f"  {'=' * 50}\n")

else:
    # ── Live mode ─────────────────────────────────────────────────────────────
    last_processed = None

    while True:
        now         = datetime.now(IST)
        last_closed = get_last_closed_candle_time(now)
        target_date = resolve_target_date(now)

        if shown_today_date != target_date:
            print(f"  -- Day rollover: {shown_today_date} → {target_date} --")
            shown_today.clear()
            _df_cache.clear()
            clear_zone_registry()
            shown_today_date = target_date

        tf           = int(TIMEFRAME)
        minute_block = (now.minute // tf) * tf
        current_candle = now.replace(minute=minute_block, second=0, microsecond=0)

        if last_processed == current_candle:
            time.sleep(1)
            continue

        last_processed = current_candle

        print(f"\n  Scanner running...")
        print(f"  Scan time  : {now.strftime('%H:%M:%S')}")
        print(f"  Target date: {target_date} [LIVE]")
        print(f"  Symbols    : {len(symbols)} total")

        run_one_day(target_date, last_closed, is_backtest=False, is_range=False)

        for sec in range(5, 0, -1):
            sys.stdout.write(f"\r  Next scan in {sec}s ")
            sys.stdout.flush()
            time.sleep(1)
        print()
