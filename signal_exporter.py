# ================= SIGNAL EXPORTER =================
# Appends new signals to a CSV file; skips already-written ones.

import os
import csv
from config import CSV_OUTPUT_PATH

FIELDNAMES = [
    "symbol", "type", "direction",
    "crossover_time",
    "first_time",  "first_open",  "first_high",  "first_low",  "first_close",
    "signal_time", "signal_open", "signal_high", "signal_low", "signal_close",
    "sl_price", "entry_price", "target_price",
]


def _load_existing_sids() -> set:
    if not os.path.exists(CSV_OUTPUT_PATH):
        return set()
    sids = set()
    try:
        with open(CSV_OUTPUT_PATH, newline="") as f:
            for row in csv.DictReader(f):
                sids.add(f"{row.get('symbol')}_{row.get('signal_time')}_{row.get('type')}")
    except Exception:
        pass
    return sids


def save_signals(signals: list) -> int:
    """Appends new signals to CSV. Returns number of rows written."""
    existing = _load_existing_sids()
    to_write = [
        sig for sig in signals
        if f"{sig['symbol']}_{sig['signal_time']}_{sig['type']}" not in existing
    ]
    if not to_write:
        return 0

    file_exists = os.path.exists(CSV_OUTPUT_PATH)
    with open(CSV_OUTPUT_PATH, "a", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES, extrasaction="ignore")
        if not file_exists:
            writer.writeheader()
        writer.writerows(to_write)

    return len(to_write)