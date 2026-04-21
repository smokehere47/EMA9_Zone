# ================= CONFIG — EMA 9 ZONE STRATEGY =================

import pytz

# ── Fyers token files ──────────────────────────────────────────────────────────
CLIENT_ID_FILE     = r"C:/Users/www.abcom.in/9 EMA Low Signal Hourly TF/fyers_client_id.txt"
ACCESS_TOKEN_FILE  = r"C:/Users/www.abcom.in/9 EMA Low Signal Hourly TF/fyers_access_token.txt"
REFRESH_TOKEN_FILE = r"C:/Users/www.abcom.in/9 EMA Low Signal Hourly TF/fyers_refresh_token.txt"

# SHA-256 of app_id:app_secret
FYERS_APP_ID_HASH  = "XXXXXXXXXXXXXXXXX"   # ← replace with your actual hash
FYERS_PIN          = "XXXXXXXXX"           # ← replace with your Fyers PIN

# ── Symbol source ──────────────────────────────────────────────────────────────
# Full production list (213 stocks):
INPUT_EXCEL   = r"C:\Users\www.abcom.in\9 EMA Low Signal Hourly TF\NIFTY.xlsx"
SYMBOL_COLUMN = "symbol"

# ── Development mode: use a small fixed list instead of the Excel file ─────────
# Set DEV_MODE = True  → scan only the 5-6 stocks in DEV_SYMBOLS (fast testing).
# Set DEV_MODE = False → scan all 213 stocks from INPUT_EXCEL (production).
# No other code changes are needed to switch between modes.
DEV_MODE = True

DEV_SYMBOLS = [
    "NSE:ZYDUSLIFE-EQ",
    "NSE:YESBANK-EQ",
    "NSE:RELIANCE-EQ",
    "NSE:INFY-EQ",
    "NSE:HDFCBANK-EQ",
    "NSE:TCS-EQ",
]

# ── Telegram ───────────────────────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN = "your_bot_token_here"
TELEGRAM_CHAT_ID   = "your_chat_id_here"

# ── Timezone ───────────────────────────────────────────────────────────────────
IST = pytz.timezone("Asia/Kolkata")

# ── Candle timeframe (minutes, passed to Fyers API) ───────────────────────────
# Controls ALL data fetching and core EMA 9 Zone logic.
# Valid values: "3", "5", "15"
TIMEFRAME = "3"   # ← Change to "5" or "15" as needed

# ── How many calendar days of OHLC history to fetch per symbol ────────────────
FETCH_DAYS = 5

# ── EMA period ─────────────────────────────────────────────────────────────────
# EMA 9 applied to candle highs (ema9_high) and candle lows (ema9_low).
EMA_PERIOD = 9

# ── Zone setup expiry ─────────────────────────────────────────────────────────
# Max candles (from bar 1) within which BOTH extremes (HH and LL) must form.
# Set to 0 to disable expiry (track the full session).
#
# Suggested values by timeframe:
#   3M  TF: 60  (~3 hours)
#   5M  TF: 36  (~3 hours)
#   15M TF: 12  (~3 hours)
#   0       → no expiry
ZONE_MAX_CANDLES = 0

# ── Run-day targeting ──────────────────────────────────────────────────────────
# Three modes — set only ONE, leave others as None.
#
#   Live mode (default):
#       OVERRIDE_TRADING_DAY  = None
#       OVERRIDE_DATE_RANGE   = None
#
#   Single date backtest:
#       OVERRIDE_TRADING_DAY  = "2026-04-15"
#       OVERRIDE_DATE_RANGE   = None
#
#   Date range backtest:
#       OVERRIDE_TRADING_DAY  = None
#       OVERRIDE_DATE_RANGE   = ("2026-03-20", "2026-03-25")

OVERRIDE_TRADING_DAY  = None #"2026-04-15"
OVERRIDE_DATE_RANGE   = None

# ── CSV Signal Export ──────────────────────────────────────────────────────────
SAVE_SIGNALS_TO_CSV = False
CSV_OUTPUT_PATH     = r"C:\Users\www.abcom.in\EMA9_Zone\todayssignal.csv"

# ── Telegram Alerts ────────────────────────────────────────────────────────────
SEND_TELEGRAM = False

# ── Analysis ──────────────────────────────────────────────────────────────────
ENABLE_ANALYSIS  = False
ENABLE_OVERNIGHT = False

SAVE_REPORT_XLSX = False
REPORT_XLSX_DIR  = r"C:\Users\www.abcom.in\EMA9_Zone\reports"

# ── Paper trading ─────────────────────────────────────────────────────────────
ENABLE_PAPER_TRADING = False
PAPER_CAPITAL        = 100000.0
PAPER_RISK_PCT       = 1.19
PAPER_TARGET_TIER    = 3
PAPER_OUTPUT_CSV     = "paper_trades.csv"
