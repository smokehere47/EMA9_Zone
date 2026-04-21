# ================= TELEGRAM UTILS =================

import requests
from config import TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID


def tv_link(symbol: str) -> str:
    """
    Builds a TradingView chart URL from a Fyers symbol string.
    e.g.  NSE:PGEL-EQ  →  https://www.tradingview.com/chart/?symbol=NSE:PGEL
    """
    try:
        base = symbol.split(":")[-1]        # PGEL-EQ
        base = base.replace("-EQ", "")      # PGEL
        tv_symbol = f"NSE:{base}"
    except Exception:
        tv_symbol = symbol                  # fallback
    return f"https://www.tradingview.com/chart/?symbol={tv_symbol}"


def send_alert(
    message: str,
    bot_token: str = TELEGRAM_BOT_TOKEN,
    chat_id: str   = TELEGRAM_CHAT_ID,
) -> bool:
    """
    Sends an HTML-formatted message to Telegram.
    Returns True on success, False on any failure.
    """
    url     = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    payload = {
        "chat_id":                  chat_id,
        "text":                     message,
        "parse_mode":               "HTML",
        "disable_web_page_preview": False,
    }
    try:
        r = requests.post(url, data=payload, timeout=10)
        if r.status_code == 200:
            return True
        print(f"❌ Telegram error {r.status_code} → {r.text}")
        return False
    except Exception as e:
        print(f"❌ Telegram exception → {e}")
        return False


def _fmt(val, prefix="₹") -> str:
    """Format a price value or return 'Pending' if None."""
    return f"{prefix}{val:.2f}" if val is not None else "Pending (next candle)"


def format_signal_message(sig: dict) -> str:
    """
    Formats a signal dict into an HTML Telegram message with a TradingView link.
    Includes entry, SL, and target trade levels.
    """
    emoji     = "🟢" if sig["type"] == "Buy" else "🔴"
    direction = "BULLISH" if sig["type"] == "Buy" else "BEARISH"
    link      = tv_link(sig["symbol"])

    entry  = _fmt(sig.get("entry_price"))
    sl     = _fmt(sig.get("sl_price"))
    target = _fmt(sig.get("target_price"))

    return (
        f"{emoji} <b>EMA CROSSOVER SIGNAL — {direction}</b>\n"
        f"━━━━━━━━━━━━━━━━━━━━━\n"
        f"📌 Stock        : <a href='{link}'>{sig['symbol']}</a>\n"
        f"📈 Signal       : {sig['type']}\n"
        f"⏱ Crossover    : {sig['crossover_time']}\n"
        f"🕯 First Candle : {sig['first_candle_type']} @ {sig['first_candle_time']}\n"
        f"🕯 Second Candle: {sig['second_candle_type']} @ {sig['signal_time']}\n"
        f"✅ Confirmed At : {sig['signal_time']}\n"
        f"━━━━━━━━━━━━━━━━━━━━━\n"
        f"🎯 Entry        : {entry}\n"
        f"🛑 Stop Loss    : {sl}\n"
        f"💰 Target (1:1) : {target}"
    )


def send_signal(sig: dict) -> bool:
    """Convenience wrapper — formats and sends a signal dict."""
    return send_alert(format_signal_message(sig))


def send_startup_message() -> bool:
    """Sends a startup ping so you know the scanner is live."""
    msg = (
        "🚀 <b>EMA Scanner STARTED</b>\n"
        "Live data from Fyers · All indicators calculated fresh each run ✅"
    )
    return send_alert(msg)