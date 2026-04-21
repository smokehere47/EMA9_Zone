# ================= EMA 9 ZONE STRATEGY — CORE DETECTION =================
#
# Detects the EMA 9 Zone setup structure on the current trading day.
#
# ── Strategy rules ────────────────────────────────────────────────────────────
#
#   Condition 1 — Day-Start Candle:
#       First candle of the trading day (09:15 IST). Its high/low are the
#       base reference for the entire session.
#
#   Condition 2 — Reference Initialisation:
#       Day-start high and low anchor all subsequent structure comparisons.
#
#   Condition 3 — Structure Formation (both must form, any order):
#       HH (Highest High) — any candle whose high > EMA9 High at that bar
#       LL (Lowest Low)   — any candle whose low  < EMA9 Low  at that bar
#       Sequence: HH → LL  OR  LL → HH
#
#   Condition 4 — Marking:
#       HH is marked with a green circle (logged as hh_time / hh_val).
#       LL is marked with a red   circle (logged as ll_time / ll_val).
#
# ── Critical Validity Rules ───────────────────────────────────────────────────
#
#   Rule 1 — Sequential integrity:
#       Day-Start → First Extreme (HH or LL) → Second Extreme (LL or HH).
#
#   Rule 2 — No break of marked extremes:
#       After HH is marked, if a new bar's high exceeds hh_val before LL
#       forms → discard old HH, use new bar as HH candidate (restart).
#       Same logic for LL in the LL → HH path.
#
#   Rule 3 — Always use the latest valid structure:
#       Whenever a new extreme breaks the previous one, immediately discard
#       old structure and restart tracking from the new extreme.
#
#   Rule 4 — Continuous monitoring:
#       After the first extreme is found, the second must be actively tracked.
#       ZONE_MAX_CANDLES sets an expiry window (0 = no expiry).
#
#   Rule 5 — Direction neutrality:
#       No bull/bear bias. Direction is determined only after both extremes form.
#
# ── Public API ────────────────────────────────────────────────────────────────
#
#   detect_zone(df, target_date, symbol="")  →  ZoneResult dict | None
#
#   ZoneResult keys:
#       "valid"      : bool   — True once both HH and LL are confirmed
#       "sequence"   : str    — "HH_LL" | "LL_HH"
#       "ds_high"    : float  — day-start candle high
#       "ds_low"     : float  — day-start candle low
#       "ds_time"    : str    — day-start candle datetime string
#       "hh_val"     : float  — confirmed Highest High price
#       "hh_time"    : str    — datetime of HH candle
#       "hh_idx"     : int    — absolute df index of HH candle
#       "ll_val"     : float  — confirmed Lowest Low price
#       "ll_time"    : str    — datetime of LL candle
#       "ll_idx"     : int    — absolute df index of LL candle
#       "expired"    : bool   — True if ZONE_MAX_CANDLES was exceeded
#
# ── Wave output ───────────────────────────────────────────────────────────────
#
#   Each detected (HH, LL) pair is one Wave. detect_zone() returns the LATEST
#   valid (HH + LL) pair per call.  collect_waves() scans the full day and
#   returns every wave found in chronological order, for structured output.
#
# ── In-memory registry ────────────────────────────────────────────────────────
#
#   _zone_registry: symbol → ZoneResult (latest valid wave for the day).
#   Cleared once per trading day via clear_zone_registry().

from __future__ import annotations

import pandas as pd
from datetime import date
from typing import Optional

from config import IST, ZONE_MAX_CANDLES


# ─────────────────────────────────────────────────────────────────────────────
# In-memory zone registry
# ─────────────────────────────────────────────────────────────────────────────

_zone_registry: dict[str, dict] = {}


def get_zone_registry() -> dict[str, dict]:
    """Shallow copy — safe to read while scanner threads run."""
    return dict(_zone_registry)


def get_zone_entry(symbol: str) -> Optional[dict]:
    return _zone_registry.get(symbol)


def clear_zone_registry() -> None:
    _zone_registry.clear()


# ─────────────────────────────────────────────────────────────────────────────
# Internal helpers
# ─────────────────────────────────────────────────────────────────────────────

def _build_result(
    *,
    valid:    bool,
    expired:  bool,
    sequence: Optional[str],
    ds_high:  float,
    ds_low:   float,
    ds_time:  str,
    hh_val:   Optional[float],
    hh_time:  Optional[str],
    hh_idx:   Optional[int],
    ll_val:   Optional[float],
    ll_time:  Optional[str],
    ll_idx:   Optional[int],
) -> dict:
    return {
        "valid":    valid,
        "expired":  expired,
        "sequence": sequence,
        "ds_high":  round(ds_high, 2) if ds_high is not None else None,
        "ds_low":   round(ds_low,  2) if ds_low  is not None else None,
        "ds_time":  ds_time,
        "hh_val":   round(hh_val,  2) if hh_val  is not None else None,
        "hh_time":  hh_time,
        "hh_idx":   hh_idx,
        "ll_val":   round(ll_val,  2) if ll_val  is not None else None,
        "ll_time":  ll_time,
        "ll_idx":   ll_idx,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Core detection — single latest wave
# ─────────────────────────────────────────────────────────────────────────────

def detect_zone(df: pd.DataFrame, target_date: date, symbol: str = "") -> Optional[dict]:
    """
    Scan `df` for the latest valid EMA 9 Zone setup (one HH + one LL pair)
    on `target_date`.

    Returns a ZoneResult dict when a valid pair is found, or None otherwise.
    Also updates _zone_registry[symbol] in-place when valid.
    """
    day_mask = df["datetime"].dt.date == target_date
    day_df   = df[day_mask].reset_index(drop=True)

    if len(day_df) == 0:
        return None

    # Day-start candle (bar 0)
    ds_row  = day_df.iloc[0]
    ds_high = float(ds_row["high"])
    ds_low  = float(ds_row["low"])
    ds_time = ds_row["datetime"].strftime("%Y-%m-%d %H:%M")

    # State machine: scanning → need_ll / need_hh → complete
    state    : str            = "scanning"
    sequence : Optional[str] = None
    hh_val   : Optional[float] = None
    hh_time  : Optional[str]   = None
    hh_idx   : Optional[int]   = None
    ll_val   : Optional[float] = None
    ll_time  : Optional[str]   = None
    ll_idx   : Optional[int]   = None

    for i in range(1, len(day_df)):
        bar = day_df.iloc[i]

        if pd.isna(bar["ema9_high"]) or pd.isna(bar["ema9_low"]):
            continue

        bar_high = float(bar["high"])
        bar_low  = float(bar["low"])
        ema9h    = float(bar["ema9_high"])
        ema9l    = float(bar["ema9_low"])
        bar_time = bar["datetime"].strftime("%Y-%m-%d %H:%M")

        # Expiry check
        if ZONE_MAX_CANDLES > 0 and i > ZONE_MAX_CANDLES:
            result = _build_result(
                valid=False, expired=True, sequence=sequence,
                ds_high=ds_high, ds_low=ds_low, ds_time=ds_time,
                hh_val=hh_val, hh_time=hh_time, hh_idx=hh_idx,
                ll_val=ll_val, ll_time=ll_time, ll_idx=ll_idx,
            )
            if symbol:
                _zone_registry[symbol] = result
            return result

        if state == "scanning":
            hh_cand = bar_high > ema9h
            ll_cand = bar_low  < ema9l

            if hh_cand and ll_cand:
                # Both on same candle — complete immediately (HH_LL)
                hh_val = bar_high; hh_time = bar_time; hh_idx = i
                ll_val = bar_low;  ll_time = bar_time; ll_idx = i
                sequence = "HH_LL"
                state    = "complete"
                break

            if hh_cand:
                hh_val = bar_high; hh_time = bar_time; hh_idx = i
                state   = "need_ll";  sequence = "HH_LL"

            elif ll_cand:
                ll_val = bar_low;  ll_time = bar_time; ll_idx = i
                state   = "need_hh"; sequence = "LL_HH"

        elif state == "need_ll":
            # Rule 2: new higher high → discard old HH, use this one
            if bar_high > hh_val:
                hh_val = bar_high; hh_time = bar_time; hh_idx = i
                continue
            if bar_low < ema9l:
                ll_val = bar_low; ll_time = bar_time; ll_idx = i
                state  = "complete"
                break

        elif state == "need_hh":
            # Rule 2: new lower low → discard old LL, use this one
            if bar_low < ll_val:
                ll_val = bar_low; ll_time = bar_time; ll_idx = i
                continue
            if bar_high > ema9h:
                hh_val = bar_high; hh_time = bar_time; hh_idx = i
                state  = "complete"
                break

    is_valid = (state == "complete")
    result   = _build_result(
        valid=is_valid, expired=False, sequence=sequence,
        ds_high=ds_high, ds_low=ds_low, ds_time=ds_time,
        hh_val=hh_val, hh_time=hh_time, hh_idx=hh_idx,
        ll_val=ll_val, ll_time=ll_time, ll_idx=ll_idx,
    )

    if symbol and is_valid:
        _zone_registry[symbol] = result

    return result if is_valid else None


# ─────────────────────────────────────────────────────────────────────────────
# Wave collector — all sequential waves on a given day
# ─────────────────────────────────────────────────────────────────────────────

def collect_waves(df: pd.DataFrame, target_date: date) -> list[dict]:
    """
    Correct wave detection — continuous zigzag through the whole day.

    Algorithm:
    - Start from bar 1 (skip day-start candle bar 0)
    - Look for first extreme (HH above EMA9 High, or LL below EMA9 Low)
    - Wave 1 sequence (HH_LL or LL_HH) locks the pattern for the entire day
    - After locking:
        * In HH_LL mode: scan for highest HH, then lowest LL, then highest HH, ...
        * In LL_HH mode: scan for lowest LL, then highest HH, then lowest LL, ...
    - Within each leg:
        * Keep updating the extreme (higher HH or lower LL) as long as
          the market keeps pushing in that direction
        * The leg ends ONLY when the market crosses EMA9 in the OTHER direction
        * At that point, record the extreme found, start the next leg
    - Each HH+LL pair (or LL+HH pair) = one complete wave
    """
    day_mask = df["datetime"].dt.date == target_date
    day_df   = df[day_mask].reset_index(drop=True)

    if len(day_df) == 0:
        return []

    ds_row  = day_df.iloc[0]
    ds_high = float(ds_row["high"])
    ds_low  = float(ds_row["low"])
    ds_time = ds_row["datetime"].strftime("%Y-%m-%d %H:%M")

    # ── Phase 1: Determine day sequence from first extreme found ──────────
    day_sequence : str | None = None
    first_extreme_idx : int   = -1

    for i in range(1, len(day_df)):
        bar = day_df.iloc[i]
        if pd.isna(bar["ema9_high"]) or pd.isna(bar["ema9_low"]):
            continue
        if float(bar["high"]) > float(bar["ema9_high"]):
            day_sequence      = "HH_LL"
            first_extreme_idx = i
            break
        if float(bar["low"]) < float(bar["ema9_low"]):
            day_sequence      = "LL_HH"
            first_extreme_idx = i
            break

    if day_sequence is None:
        return []   # no structure found today

    # ── Phase 2: Continuous zigzag scan ───────────────────────────────────
    #
    # We walk through the day bar by bar maintaining a state machine:
    #
    #   "find_hh" → keep updating hh_val while high > ema9_high
    #               switch to "find_ll" the moment a bar's low < ema9_low
    #
    #   "find_ll" → keep updating ll_val while low < ema9_low
    #               switch to "find_hh" the moment a bar's high > ema9_high
    #
    # Each time we switch states, the PREVIOUS leg's extreme is finalised
    # and stored. Pairing two consecutive legs = one wave.

    waves      : list[dict] = []
    wave_number: int        = 1

    # Leg storage — each leg is one half of a wave
    legs: list[dict] = []   # {"type": "HH"|"LL", "val": float, "time": str}

    # Current leg being built
    if day_sequence == "HH_LL":
        leg_type = "HH"
    else:
        leg_type = "LL"

    leg_val  : float | None = None
    leg_time : str | None   = None

    def finalise_leg():
        """Push current leg into legs list and reset."""
        nonlocal leg_val, leg_time
        if leg_val is not None:
            legs.append({"type": leg_type, "val": leg_val, "time": leg_time})
            # Pair every two legs into a wave
            if len(legs) >= 2 and len(legs) % 2 == 0:
                first  = legs[-2]
                second = legs[-1]
                if day_sequence == "HH_LL":
                    hh = first;  ll = second
                else:
                    ll = first;  hh = second
                waves.append({
                    "wave_number": wave_number,
                    "sequence":    day_sequence,
                    "ds_high":     round(ds_high, 2),
                    "ds_low":      round(ds_low,  2),
                    "ds_time":     ds_time,
                    "hh_val":      round(hh["val"], 2),
                    "hh_time":     hh["time"],
                    "ll_val":      round(ll["val"], 2),
                    "ll_time":     ll["time"],
                })
        leg_val  = None
        leg_time = None

    for i in range(first_extreme_idx, len(day_df)):
        bar = day_df.iloc[i]
        if pd.isna(bar["ema9_high"]) or pd.isna(bar["ema9_low"]):
            continue

        bar_high = float(bar["high"])
        bar_low  = float(bar["low"])
        ema9h    = float(bar["ema9_high"])
        ema9l    = float(bar["ema9_low"])
        bar_time = bar["datetime"].strftime("%Y-%m-%d %H:%M")

        if leg_type == "HH":
            if bar_high > ema9h:
                # Still in HH leg — update if higher
                if leg_val is None or bar_high > leg_val:
                    leg_val  = bar_high
                    leg_time = bar_time

            if bar_low < ema9l:
                # Market crossed below EMA9 Low — HH leg is done
                # Finalise HH, start LL leg
                finalise_leg()
                leg_type = "LL"
                wave_number = len(waves) + 1
                # This same bar starts the LL leg
                leg_val  = bar_low
                leg_time = bar_time

        elif leg_type == "LL":
            if bar_low < ema9l:
                # Still in LL leg — update if lower
                if leg_val is None or bar_low < leg_val:
                    leg_val  = bar_low
                    leg_time = bar_time

            if bar_high > ema9h:
                # Market crossed above EMA9 High — LL leg is done
                # Finalise LL, start HH leg
                finalise_leg()
                leg_type = "HH"
                wave_number = len(waves) + 1
                # This same bar starts the HH leg
                leg_val  = bar_high
                leg_time = bar_time

    # End of day — finalise whatever leg is in progress
    # (only forms a wave if we have a complete pair)
    finalise_leg()

    return waves