# ================= PAPER TRADING — 3C BREAK EMA SCANNER ======================
#
# Standalone Backtrader-based paper trading simulator.
# Reads trading signals produced by the 3C Break scanner and simulates trades
# using entry price, stop-loss, and target levels already calculated by the
# scanner. No scanner logic is reproduced here.
#
# ── Architecture ──────────────────────────────────────────────────────────────
#   Backtrader's order-matching engine requires multiple bars to process an
#   entry order, then further bars to match the exit — making synthetic
#   2-bar feeds unreliable regardless of price encoding.
#
#   Solution: bypass the order engine. A custom BrokerPlugin subclasses
#   bt.BrokerBase and executes each trade as a direct fill (no order queue,
#   no bar-timing dependencies). The scanner's pre-computed outcome fields
#   (tier_hit, sl_hit, loss_hit, actual_move) determine the exit price.
#   Commission is applied on both entry and exit legs.
#
# ── Exit price derivation ─────────────────────────────────────────────────────
#   sl_hit              → sl_price
#   tier_hit = N        → targets[N]["price"]
#   loss_hit/overnight  → sl_price (worst case; actual EOD close not stored)
#   T0 / flat positive  → entry ± actual_move% (favourable direction)
#   genuine flat        → entry_price (no P&L)
#
# ── Position sizing ───────────────────────────────────────────────────────────
#   Fixed-fractional risk:
#     risk_amount    = current_cash × risk_pct / 100
#     risk_per_share = |entry_price − sl_price|
#     size           = floor(risk_amount / risk_per_share)  ≥ 1
#
# ── Signal input ──────────────────────────────────────────────────────────────
#   Each signal is a dict (same object the scanner already produces).
#   Required fields:
#     symbol, type ("Buy"|"Sell"), signal_time ("YYYY-MM-DD HH:MM"),
#     entry_price, sl_price, targets (list of {label, price, profit_rs})
#   Outcome fields (used for exit price):
#     tier_hit, sl_hit, loss_hit, actual_move, overnight_carried
#
# ── Usage ─────────────────────────────────────────────────────────────────────
#   Option A — JSON file:
#     python paper_trading.py --signals signals.json
#     python paper_trading.py --signals signals.json --capital 100000 --risk-pct 1.19
#     python paper_trading.py --signals signals.json --output-csv results.csv
#     python paper_trading.py --signals signals.json --list-only
#
#   Option B — from scanner (main.py):
#     from paper_trading import run_paper_trading
#     run_paper_trading(list(shown_today.values()), capital=..., risk_pct=...)
# ==============================================================================

from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import datetime
from pathlib import Path


# ─────────────────────────────────────────────────────────────────────────────
# Defaults
# ─────────────────────────────────────────────────────────────────────────────

DEFAULT_CAPITAL  = 100_000.0
DEFAULT_RISK_PCT = 1.19
COMMISSION_PCT   = 0.03        # one-way, applied on both entry and exit legs


# ─────────────────────────────────────────────────────────────────────────────
# Exit price resolver
# ─────────────────────────────────────────────────────────────────────────────

def _resolve_exit(sig: dict) -> tuple[float, str, str]:
    """
    Return (exit_price, exit_via, tier_label) from scanner outcome fields.

    Priority order — explicit, no silent fallthrough to FLAT on losses:
      1. SL hit        → sl_price (always correct)
      2. Tier hit      → target price
      3. Loss EOD      → sl_price (conservative; actual close not stored)
      4. T0 / positive → entry ± actual_move%
      5. Flat          → entry (genuine no-move)

    exit_via   : "SL" | "TARGET" | "LOSS_EOD" | "FLAT"
    tier_label : human-readable string e.g. "T3 (1.40%)"
    """
    bull        = sig["type"] == "Buy"
    entry       = float(sig["entry_price"])
    sl          = float(sig["sl_price"])
    targets     = sig.get("targets", [])
    tier_hit    = sig.get("tier_hit")
    sl_hit      = sig.get("sl_hit",    False)
    loss_hit    = sig.get("loss_hit",  False)
    actual_move = sig.get("actual_move")

    # 1. SL hit
    if sl_hit and tier_hit is None:
        return round(sl, 2), "SL", "SL"

    # 2. Tier hit
    if tier_hit is not None and targets:
        t_idx = max(0, min(int(tier_hit), len(targets) - 1))
        t     = targets[t_idx]
        return round(float(t["price"]), 2), "TARGET", t.get("label", f"T{t_idx}")

    # 3. Loss EOD / overnight carry
    # actual_move is None for EOD losses (scanner zeros max_move_px).
    # sl_price is the correct worst-case exit for a loss between entry and SL.
    if loss_hit or sig.get("overnight_carried"):
        if actual_move is not None and float(actual_move) > 0:
            frac    = float(actual_move) / 100.0
            exit_px = (entry - entry * frac) if bull else (entry + entry * frac)
        else:
            exit_px = sl
        return round(exit_px, 2), "LOSS_EOD", "EOD"

    # 4. T0 / positive EOD
    if actual_move is not None and float(actual_move) > 0:
        frac    = float(actual_move) / 100.0
        exit_px = (entry + entry * frac) if bull else (entry - entry * frac)
        label   = targets[0].get("label", "T0") if targets else "T0"
        return round(exit_px, 2), "TARGET", label

    # 5. Flat
    return round(entry, 2), "FLAT", "FLAT"


# ─────────────────────────────────────────────────────────────────────────────
# Position sizer
# ─────────────────────────────────────────────────────────────────────────────

def _calc_size(cash: float, risk_pct: float, entry: float, sl: float) -> int:
    risk_amount    = cash * risk_pct / 100.0
    risk_per_share = abs(entry - sl)
    if risk_per_share <= 0:
        return 1
    return max(int(risk_amount / risk_per_share), 1)


# ─────────────────────────────────────────────────────────────────────────────
# Core simulator  (pure Python — no Backtrader order engine)
# ─────────────────────────────────────────────────────────────────────────────

def _simulate(
    signals:    list[dict],
    capital:    float,
    risk_pct:   float,
    output_rows: list[dict],
) -> None:
    """
    Simulate all trades sequentially.
    Each trade is executed as a direct fill: no order queue, no bar timing.
    Commission is deducted on both entry and exit legs.
    Position size is recalculated per trade using the *current* cash balance.
    """
    cash          = capital
    trade_count   = 0
    win_count     = 0
    loss_count    = 0
    flat_count    = 0
    total_pnl     = 0.0
    commission_rt = COMMISSION_PCT / 100.0   # one-way rate

    for sig in signals:
        bull        = sig["type"] == "Buy"
        entry       = float(sig["entry_price"])
        sl          = float(sig["sl_price"])
        exit_price, exit_via, tier_label = _resolve_exit(sig)

        size = _calc_size(cash, risk_pct, entry, sl)

        # Commission on entry and exit (both legs)
        entry_commission = entry      * size * commission_rt
        exit_commission  = exit_price * size * commission_rt
        total_commission = entry_commission + exit_commission

        gross_pnl = ((exit_price - entry) if bull else (entry - exit_price)) * size
        net_pnl   = gross_pnl - total_commission

        cash        += net_pnl
        total_pnl   += net_pnl
        trade_count += 1

        if   net_pnl > 0: win_count  += 1
        elif net_pnl < 0: loss_count += 1
        else:             flat_count  += 1

        outcome   = "WIN" if net_pnl > 0 else ("LOSS" if net_pnl < 0 else "FLAT")
        move_pct  = round(
            (exit_price - entry) / entry * 100 * (1 if bull else -1), 2
        )
        # Use abs() with explicit sign so -Rs.500 prints as "-Rs.500" not "Rs.-500"
        pnl_sign  = "+" if net_pnl  >= 0 else "-"
        gros_sign = "+" if gross_pnl >= 0 else "-"
        arrow     = "▲ BUY " if bull else "▼ SELL"

        print(
            f"\n  [{sig.get('signal_time', '?')}]  {arrow}  {sig.get('symbol', '?')}"
            f"\n    Entry      : Rs.{entry:.2f}"
            f"  →  {exit_via} ({tier_label})  @  Rs.{exit_price:.2f}"
            f"\n    Size       : {size} shares"
            f"  |  Move : {'+' if move_pct >= 0 else ''}{move_pct:.2f}%"
            f"\n    Gross P&L  : {gros_sign}Rs.{abs(gross_pnl):.2f}"
            f"  |  Commission : Rs.{total_commission:.2f}"
            f"\n    Net P&L    : {pnl_sign}Rs.{abs(net_pnl):.2f}"
            f"  |  Balance : Rs.{cash:,.2f}"
            f"\n    Result     : {outcome}"
        )

        output_rows.append({
            "signal_time":    sig.get("signal_time",    ""),
            "symbol":         sig.get("symbol",         ""),
            "type":           sig.get("type",           ""),
            "crossover_time": sig.get("crossover_time", ""),
            "entry_price":    entry,
            "exit_price":     exit_price,
            "exit_via":       exit_via,
            "tier_label":     tier_label,
            "sl_price":       sl,
            "size":           size,
            "gross_pnl":      round(gross_pnl, 2),
            "commission":     round(total_commission, 2),
            "net_pnl":        round(net_pnl, 2),
            "move_pct":       move_pct,
            "balance":        round(cash, 2),
            "outcome":        outcome,
        })

    # ── Final summary ─────────────────────────────────────────────────────────
    win_rate   = win_count / trade_count * 100 if trade_count else 0.0
    net_return = total_pnl / capital * 100
    net_sign   = "+" if total_pnl >= 0 else "-"

    print()
    print(f"  {'═' * 54}")
    print(f"  PAPER TRADING SUMMARY")
    print(f"  {'─' * 54}")
    print(f"  Starting capital : Rs.{capital:>14,.2f}")
    print(f"  Final balance    : Rs.{cash:>14,.2f}")
    print(f"  Net P&L          :  {net_sign}Rs.{abs(total_pnl):>13,.2f}"
          f"  ({net_sign}{abs(net_return):.2f}%)")
    print(f"  {'─' * 54}")
    print(f"  Trades total     : {trade_count}")
    print(f"  Wins             : {win_count}")
    print(f"  Losses           : {loss_count}")
    print(f"  Flat             : {flat_count}")
    print(f"  Win rate         : {win_rate:.1f}%")
    print(f"  {'═' * 54}")


# ─────────────────────────────────────────────────────────────────────────────
# Public entry point
# ─────────────────────────────────────────────────────────────────────────────

def run_paper_trading(
    signals:    list[dict],
    capital:    float = DEFAULT_CAPITAL,
    risk_pct:   float = DEFAULT_RISK_PCT,
    output_csv: str | None = None,
    list_only:  bool  = False,
) -> list[dict]:
    """
    Simulate paper trades for a list of scanner signals.

    Parameters
    ----------
    signals    : list of signal dicts from the scanner.
    capital    : starting paper capital in INR.
    risk_pct   : max % of capital risked per trade (e.g. 1.19).
    output_csv : optional path — write per-trade CSV results here.
    list_only  : print signals and exit without simulating.

    Returns
    -------
    list of result row dicts (one per closed trade).
    """
    if not signals:
        print("  No signals to simulate.")
        return []

    valid, skipped = [], 0
    for sig in signals:
        if sig.get("entry_price") is None:          skipped += 1; continue
        if sig.get("sl_price")    is None:          skipped += 1; continue
        if not sig.get("targets"):                  skipped += 1; continue
        if sig.get("type") not in ("Buy", "Sell"):  skipped += 1; continue
        valid.append(sig)

    # Sort chronologically so P&L compounds in signal arrival order, not alphabetically.
    # signal_time is "YYYY-MM-DD HH:MM" — lexicographic sort = chronological sort.
    valid.sort(key=lambda s: s.get("signal_time", ""))

    skip_note = (f"  ({skipped} skipped — missing entry/SL/targets)"
                 if skipped else "")
    print(f"\n  3C BREAK — PAPER TRADING")
    print(f"  {'═' * 54}")
    print(f"  Signals received : {len(signals)}")
    print(f"  Valid for sim    : {len(valid)}{skip_note}")
    print(f"  Capital          : Rs.{capital:,.2f}")
    print(f"  Risk per trade   : {risk_pct:.2f}%")
    print(f"  Commission       : {COMMISSION_PCT:.2f}% per side")
    print(f"  {'═' * 54}")

    if list_only:
        _print_signal_list(valid)
        return []

    if not valid:
        print("  Nothing to simulate.")
        return []

    output_rows: list[dict] = []
    print(f"\n  Running simulation for {len(valid)} signal(s)...")
    _simulate(valid, capital, risk_pct, output_rows)

    if output_csv and output_rows:
        _write_csv(output_rows, output_csv)
        print(f"\n  Results saved → {output_csv}")

    return output_rows


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _print_signal_list(signals: list[dict]) -> None:
    print(f"\n  {'─' * 54}")
    for i, sig in enumerate(signals, 1):
        bull                   = sig["type"] == "Buy"
        arrow                  = "▲" if bull else "▼"
        exit_px, via, lbl      = _resolve_exit(sig)
        targets                = sig.get("targets", [])
        t_str = "  ".join(f"{t['label']}@{t['price']:.2f}" for t in targets)
        print(
            f"  {i:>3}.  {arrow} {sig['type']:<4}  {sig.get('symbol', '?'):<25}"
            f"  Entry: Rs.{sig.get('entry_price', 0):.2f}"
            f"  SL: Rs.{sig.get('sl_price', 0):.2f}"
            f"  Exit: Rs.{exit_px:.2f} via {via} ({lbl})"
        )
        if t_str:
            print(f"         Targets : {t_str}")
    print(f"  {'─' * 54}")


CSV_FIELDNAMES = [
    "signal_time", "symbol", "type", "crossover_time",
    "entry_price", "exit_price", "exit_via", "tier_label",
    "sl_price", "size", "gross_pnl", "commission", "net_pnl",
    "move_pct", "balance", "outcome",
]


def _write_csv(rows: list[dict], path: str) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDNAMES, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def _load_signals_from_file(path: str) -> list[dict]:
    p = Path(path)
    if not p.exists():
        print(f"  ERROR: Signals file not found: {path}")
        sys.exit(1)
    with open(p, encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict):
        data = data.get("signals", [data])
    if not isinstance(data, list):
        print("  ERROR: Signals file must contain a JSON array.")
        sys.exit(1)
    return data


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="paper_trading.py",
        description="3C Break EMA Scanner — paper trading simulator.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--signals",    "-s", required=True,  metavar="FILE",
                   help="JSON file of scanner signals (array).")
    p.add_argument("--capital",    "-c", type=float, default=DEFAULT_CAPITAL,
                   metavar="INR",  help=f"Starting capital (default: {DEFAULT_CAPITAL:,.0f}).")
    p.add_argument("--risk-pct",   "-r", type=float, default=DEFAULT_RISK_PCT,
                   metavar="PCT",  help=f"Max %% capital risked per trade (default: {DEFAULT_RISK_PCT}).")
    p.add_argument("--output-csv", "-o", metavar="FILE", default=None,
                   help="Save trade results to this CSV file.")
    p.add_argument("--list-only",  "-l", action="store_true",
                   help="Print signals without simulating.")
    return p.parse_args()


if __name__ == "__main__":
    args    = _parse_args()
    signals = _load_signals_from_file(args.signals)
    print(f"\n  Loaded {len(signals)} signal(s) from {args.signals}")
    run_paper_trading(
        signals    = signals,
        capital    = args.capital,
        risk_pct   = args.risk_pct,
        output_csv = args.output_csv,
        list_only  = args.list_only,
    )