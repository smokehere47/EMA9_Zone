# ================= INDICATORS — EMA 9 ZONE STRATEGY =================
#
# Calculates the two EMAs required by the EMA 9 Zone Strategy:
#
#   ema9_low   — EMA(9) of candle LOWS
#                Used as the LL threshold: bar.low < ema9_low → LL candidate
#
#   ema9_high  — EMA(9) of candle HIGHS
#                Used as the HH threshold: bar.high > ema9_high → HH candidate
#
# pandas-ta matches the standard EMA formula used by TradingView / Zerodha.
# The TIMEFRAME variable in config.py controls which resolution the raw OHLC
# data is fetched at; indicator logic here is timeframe-agnostic.

import pandas as pd
import pandas_ta as ta

from config import EMA_PERIOD


def calculate_indicators(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["ema9_low"]  = ta.ema(df["low"],  length=EMA_PERIOD)
    df["ema9_high"] = ta.ema(df["high"], length=EMA_PERIOD)
    return df
