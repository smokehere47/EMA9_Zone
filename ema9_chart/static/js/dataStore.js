/**
 * dataStore.js
 * In-memory store for all market data — candles, ticks, signals, EMA values.
 * Single source of truth. No file I/O. All data flows from WebSocket.
 */

const DataStore = (() => {
  // candles[symbol][tf] = [{time, open, high, low, close, volume}, ...]
  const candles = {};
  // ticks[symbol] = {price, change, change_pct, volume, time}
  const ticks = {};
  // signals[symbol] = [{type, price, time, message, ...}, ...]
  const signals = {};
  // ema[symbol][tf] = {ema9, ema21, vwap}
  const emaData = {};
  // watchlist config
  const watchlist = [
    { symbol: 'NSE:NIFTY50-INDEX',   name: 'Nifty 50',    exchange: 'NSE' },
    { symbol: 'NSE:BANKNIFTY-INDEX', name: 'Bank Nifty',  exchange: 'NSE' },
    { symbol: 'NSE:FINNIFTY-INDEX',  name: 'Fin Nifty',   exchange: 'NSE' },
    { symbol: 'BSE:SENSEX-INDEX',    name: 'Sensex',       exchange: 'BSE' },
  ];

  function _ensureSymbol(sym) {
    if (!candles[sym]) candles[sym] = {};
    if (!ticks[sym])   ticks[sym]   = { price: 0, change: 0, change_pct: 0, volume: 0 };
    if (!signals[sym]) signals[sym] = [];
    if (!emaData[sym]) emaData[sym] = {};
  }

  // ── Tick ─────────────────────────────────────────────────
  function onTick(d) {
    _ensureSymbol(d.symbol);
    ticks[d.symbol] = { ...ticks[d.symbol], ...d };
    // Update last candle close price if it exists
    const tf = AppState.activeTf;
    const bars = candles[d.symbol][tf];
    if (bars && bars.length > 0) {
      const last = bars[bars.length - 1];
      last.close = d.price;
      if (d.price > last.high) last.high = d.price;
      if (d.price < last.low)  last.low  = d.price;
    }
  }

  // ── Candle ───────────────────────────────────────────────
  function onCandle(d) {
    _ensureSymbol(d.symbol);
    const tf = d.tf || AppState.activeTf;
    if (!candles[d.symbol][tf]) candles[d.symbol][tf] = [];
    const bars = candles[d.symbol][tf];
    const bar  = { time: d.time, open: d.o, high: d.h, low: d.l, close: d.c, volume: d.v };

    // Update or append
    if (bars.length > 0 && bars[bars.length - 1].time === bar.time) {
      bars[bars.length - 1] = bar;
    } else {
      bars.push(bar);
      if (bars.length > 2000) bars.shift(); // keep 2000 bars max
    }
  }

  // ── Snapshot ─────────────────────────────────────────────
  function onSnapshot(d) {
    _ensureSymbol(d.symbol);
    const tf = d.tf || AppState.activeTf;
    candles[d.symbol][tf] = d.candles.map(c => ({
      time: c.time, open: c.o ?? c.open, high: c.h ?? c.high,
      low: c.l ?? c.low, close: c.c ?? c.close, volume: c.v ?? c.volume
    }));
  }

  // ── Signal ───────────────────────────────────────────────
  function onSignal(d) {
    _ensureSymbol(d.symbol);
    signals[d.symbol].unshift(d);
    if (signals[d.symbol].length > 200) signals[d.symbol].pop();
  }

  // ── EMA data ─────────────────────────────────────────────
  function onEma(d) {
    _ensureSymbol(d.symbol);
    const tf = d.tf || AppState.activeTf;
    emaData[d.symbol][tf] = { ema9: d.ema9, ema21: d.ema21, vwap: d.vwap };
  }

  // ── Getters ───────────────────────────────────────────────
  function getCandles(symbol, tf) {
    return (candles[symbol] && candles[symbol][tf]) ? candles[symbol][tf] : [];
  }

  function getTick(symbol) {
    return ticks[symbol] || { price: 0, change: 0, change_pct: 0 };
  }

  function getSignals(symbol) {
    return signals[symbol] || [];
  }

  function getAllSignals() {
    return Object.entries(signals)
      .flatMap(([sym, sigs]) => sigs.map(s => ({ ...s, symbol: sym })))
      .sort((a, b) => b.time - a.time)
      .slice(0, 100);
  }

  function getEma(symbol, tf) {
    return (emaData[symbol] && emaData[symbol][tf]) ? emaData[symbol][tf] : null;
  }

  function getWatchlist() { return watchlist; }

  function addWatchlistItem(symbol, name, exchange) {
    if (!watchlist.find(w => w.symbol === symbol)) {
      watchlist.push({ symbol, name: name || symbol, exchange: exchange || '' });
    }
  }

  // ── Wave-based trend detection ────────────────────────────────────────────
  function detectTrend(symbol, tf) {
    const bars = getCandles(symbol, tf || AppState.activeTf);
    if (!bars || bars.length < 4) return { trend: 'SIDEWAYS', emoji: '➡️', label: 'Sideways' };

    // Build simplified wave list from candle data using local highs/lows
    // We use the last 20 bars and find swing points
    const slice = bars.slice(-20);
    const waves = [];
    for (let i = 1; i < slice.length - 1; i++) {
      const prev = slice[i - 1], cur = slice[i], next = slice[i + 1];
      if (cur.high > prev.high && cur.high > next.high) {
        waves.push({ type: 'HH', val: cur.high });
      } else if (cur.low < prev.low && cur.low < next.low) {
        waves.push({ type: 'LL', val: cur.low });
      }
    }

    if (waves.length < 3) return { trend: 'SIDEWAYS', emoji: '➡️', label: 'Sideways' };

    // Extract last 3 swing highs and lows
    const highs = waves.filter(w => w.type === 'HH').map(w => w.val).slice(-3);
    const lows  = waves.filter(w => w.type === 'LL').map(w => w.val).slice(-3);

    if (highs.length >= 2 && lows.length >= 2) {
      const higherHighs = highs.every((h, i) => i === 0 || h > highs[i - 1]);
      const higherLows  = lows.every((l, i)  => i === 0 || l > lows[i - 1]);
      const lowerHighs  = highs.every((h, i) => i === 0 || h < highs[i - 1]);
      const lowerLows   = lows.every((l, i)  => i === 0 || l < lows[i - 1]);

      if (higherHighs && higherLows) return { trend: 'UPTREND',   emoji: '🔼', label: 'Uptrend'   };
      if (lowerHighs  && lowerLows)  return { trend: 'DOWNTREND', emoji: '🔽', label: 'Downtrend' };
    }

    return { trend: 'SIDEWAYS', emoji: '➡️', label: 'Sideways' };
  }

  return { onTick, onCandle, onSnapshot, onSignal, onEma, getCandles, getTick, getSignals, getAllSignals, getEma, getWatchlist, addWatchlistItem, detectTrend };
})();