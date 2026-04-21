# ================= SENT SIGNALS TRACKER =================
# Unchanged from original — copied as-is.

import os
from datetime import date

SENT_FILE = "telegram_sent.txt"
DATE_FILE  = "telegram_sent_date.txt"


def _read_date() -> date | None:
    if not os.path.exists(DATE_FILE):
        return None
    try:
        with open(DATE_FILE, "r") as f:
            return date.fromisoformat(f.read().strip())
    except Exception:
        return None


def _write_date(d: date):
    with open(DATE_FILE, "w") as f:
        f.write(d.isoformat())


def load_sent(trading_day: date) -> set:
    saved_date = _read_date()
    if saved_date != trading_day:
        clear_sent(trading_day)
        return set()
    if not os.path.exists(SENT_FILE):
        return set()
    with open(SENT_FILE, "r") as f:
        return {line.strip() for line in f if line.strip()}


def save_sid(sid: str):
    with open(SENT_FILE, "a") as f:
        f.write(sid + "\n")


def discard_sid(sid: str):
    if not os.path.exists(SENT_FILE):
        return
    with open(SENT_FILE, "r") as f:
        lines = {line.strip() for line in f if line.strip()}
    lines.discard(sid)
    with open(SENT_FILE, "w") as f:
        f.write("\n".join(lines) + ("\n" if lines else ""))


def clear_sent(trading_day: date):
    if os.path.exists(SENT_FILE):
        os.remove(SENT_FILE)
    _write_date(trading_day)