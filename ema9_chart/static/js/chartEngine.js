/**
 * chartEngine.js
 * Manages the main candlestick chart + RSI/volume sub-chart using lightweight-charts.
 * Renders EMA9, EMA21, VWAP lines and signal markers directly from WS data.
 */

const ChartEngine = (() => {
  let mainChart = null;
  let subChart  = null;
  let candleSeries   = null;
  let ema9Series     = null;
  let ema21Series    = null;
  let vwapSeries     = null;
  let volumeSeries   = null;
  let rsiSeries      = null;
  let currentSymbol  = null;
  let currentTf      = null;

  // EMA data buffers (time -> value) for incremental updates
  const ema9Buf  = {};
  const ema21Buf = {};
  const vwapBuf  = {};

  // ── Init ────────────────────────────────────────────────
  function init() {
    const mainEl = document.getElementById('mainChart');
    const subEl  = document.getElementById('subChart');
    if (!mainEl || !subEl) return;

    const commonOpts = {
      layout: {
        background: { type: 'solid', color: '#0d0e11' },
        textColor:  '#8a8f9e',
        fontSize:   11,
        fontFamily: "'JetBrains Mono', monospace",
      },
      grid: {
        vertLines: { color: '#15171c' },
        horzLines: { color: '#15171c' },
      },
      crosshair: {
        mode: 1,
        vertLine: { color: '#363a45', style: 1, labelBackgroundColor: '#1f2128' },
        horzLine: { color: '#363a45', style: 1, labelBackgroundColor: '#1f2128' },
      },
      rightPriceScale: { borderColor: '#1e2028', scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderColor: '#1e2028', timeVisible: true, secondsVisible: false },
      handleScroll:  { mouseWheel: true, pressedMouseMove: true },
      handleScale:   { mouseWheel: true, pinch: true },
    };

    // Main chart
    mainChart = LightweightCharts.createChart(mainEl, {
      ...commonOpts,
      width:  mainEl.clientWidth,
      height: mainEl.clientHeight,
    });

    // Candlestick
    candleSeries = mainChart.addCandlestickSeries({
      upColor:       '#2baf2b',
      downColor:     '#d42e37ec',
      borderUpColor:   '#2baf2b',
      borderDownColor: '#d42e37ec',
      wickUpColor:   '#2baf2b',
      wickDownColor: '#d42e37ec',
    });

    // EMA 9
    ema9Series = mainChart.addLineSeries({
      color: '#f5a623',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
      title: 'EMA9',
    });

    // EMA 21
    ema21Series = mainChart.addLineSeries({
      color: '#4d9de0',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
      title: 'EMA21',
    });

    // VWAP
    vwapSeries = mainChart.addLineSeries({
      color: '#bb86fc',
      lineWidth: 1,
      lineStyle: 2, // dashed
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
      title: 'VWAP',
    });

    // Sub chart (volume + RSI)
    subChart = LightweightCharts.createChart(subEl, {
      ...commonOpts,
      width:  subEl.clientWidth,
      height: subEl.clientHeight,
      rightPriceScale: { scaleMargins: { top: 0.1, bottom: 0.05 }, borderColor: '#1e2028' },
      timeScale: { visible: false },
    });

    volumeSeries = subChart.addHistogramSeries({
      color: '#26a69a',
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    subChart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.7, bottom: 0 } });

    rsiSeries = subChart.addLineSeries({
      color: '#f5a623',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: true,
      title: 'RSI',
      priceScaleId: 'right',
    });

    // Sync crosshairs between main and sub charts
    _syncCrosshairs(mainChart, subChart);

    // Resize observer
    const ro = new ResizeObserver(_onResize);
    ro.observe(mainEl);
    ro.observe(subEl);

    // Crosshair move → update OHLC bar display
    mainChart.subscribeCrosshairMove(_onCrosshairMove);

    _initResizeHandle();
  }

  // ── Load symbol + tf data ────────────────────────────────
  // Called by app.js AFTER DataStore.onSnapshot() has stored candles.
  function loadSymbol(symbol, tf) {
    currentSymbol = symbol;
    currentTf     = tf || AppState.activeTf;
    const bars = DataStore.getCandles(symbol, currentTf);
    if (!bars || bars.length === 0) {
      console.warn('[ChartEngine] loadSymbol: no candles for', symbol, currentTf);
      return;
    }
    _render(bars);
  }

  function _render(bars) {
    if (!candleSeries) return;

    const candles = bars.map(b => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }));
    const volumes = bars.map(b => ({
      time:  b.time,
      value: b.volume || 0,
      color: b.close >= b.open ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)',
    }));

    candleSeries.setData(candles);
    volumeSeries.setData(volumes);

    // Calculate EMAs + VWAP from candle data
    const { ema9, ema21, vwap } = _calcIndicators(bars);
    ema9Series.setData(ema9);
    ema21Series.setData(ema21);
    vwapSeries.setData(vwap);

    // RSI
    const rsi = _calcRSI(bars, 14);
    rsiSeries.setData(rsi);

    // Sync timescale
    subChart.timeScale().setVisibleRange(mainChart.timeScale().getVisibleRange() || {});

    // Update analysis panel
    if (bars.length >= 2) {
      const last = bars[bars.length - 1];
      const prev = bars[bars.length - 2];
      AnalysisPanel.update({
        symbol:   currentSymbol,
        tf:       currentTf,
        price:    last.close,
        change:   last.close - prev.close,
        ema9:     ema9[ema9.length - 1]?.value,
        ema21:    ema21[ema21.length - 1]?.value,
        vwap:     vwap[vwap.length - 1]?.value,
        rsi:      rsi[rsi.length - 1]?.value,
        high:     Math.max(...bars.slice(-50).map(b => b.high)),
        low:      Math.min(...bars.slice(-50).map(b => b.low)),
        volume:   bars.slice(-1)[0].volume,
      });
    }

    mainChart.timeScale().scrollToRealTime();
  }

  // ── Live tick update ─────────────────────────────────────
  function updateTick(sym, candle) {
    if (sym !== currentSymbol || !candleSeries) return;
    candleSeries.update({ time: candle.time, open: candle.open, high: candle.high, low: candle.low, close: candle.close });
    volumeSeries.update({ time: candle.time, value: candle.volume || 0, color: candle.close >= candle.open ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)' });
  }

  // ── Signal markers ───────────────────────────────────────
  function addSignalMarkers(signals) {
    if (!candleSeries) return;
    const markers = signals
      .filter(s => s.symbol === currentSymbol)
      .map(s => ({
        time:     s.time,
        position: s.signal_type === 'LONG' ? 'belowBar' : 'aboveBar',
        color:    s.signal_type === 'LONG' ? '#26a69a' : s.signal_type === 'SHORT' ? '#ef5350' : '#f5a623',
        shape:    s.signal_type === 'LONG' ? 'arrowUp' : s.signal_type === 'SHORT' ? 'arrowDown' : 'circle',
        text:     s.signal_type,
        size:     1.5,
      }))
      .sort((a, b) => a.time - b.time);

    candleSeries.setMarkers(markers);
  }

  function addSingleMarker(signal) {
    if (!candleSeries || signal.symbol !== currentSymbol) return;
    const existing = candleSeries.markers() || [];
    const newMarker = {
      time:     signal.time,
      position: signal.signal_type === 'LONG' ? 'belowBar' : 'aboveBar',
      color:    signal.signal_type === 'LONG' ? '#26a69a' : signal.signal_type === 'SHORT' ? '#ef5350' : '#f5a623',
      shape:    signal.signal_type === 'LONG' ? 'arrowUp' : signal.signal_type === 'SHORT' ? 'arrowDown' : 'circle',
      text:     signal.signal_type,
      size:     1.5,
    };
    const updated = [...existing, newMarker].sort((a, b) => a.time - b.time);
    candleSeries.setMarkers(updated);
  }

  // ── EMA line live update ─────────────────────────────────
  function updateEmaLines(symbol, tf, ema9, ema21, vwap, time) {
    if (symbol !== currentSymbol || tf !== currentTf) return;
    if (ema9  != null) ema9Series.update({ time, value: ema9 });
    if (ema21 != null) ema21Series.update({ time, value: ema21 });
    if (vwap  != null) vwapSeries.update({ time, value: vwap });
  }

  // ── Price line for zones ─────────────────────────────────
  const priceLines = {};
  function setPriceLine(id, price, color, title) {
    if (priceLines[id]) { try { candleSeries.removePriceLine(priceLines[id]); } catch(_) {} }
    priceLines[id] = candleSeries.createPriceLine({ price, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title });
  }
  function removePriceLine(id) {
    if (priceLines[id]) { try { candleSeries.removePriceLine(priceLines[id]); } catch(_) {} delete priceLines[id]; }
  }

  // ── Indicators toggle ────────────────────────────────────
  function toggleIndicator(name, active) {
    const map = { 'EMA 9': ema9Series, 'EMA 21': ema21Series, 'VWAP': vwapSeries };
    const s = map[name];
    if (s) s.applyOptions({ visible: active });
  }

  // ── Calculate indicators from bars ───────────────────────
  function _calcEMA(bars, period, field = 'close') {
    const result = [];
    const k = 2 / (period + 1);
    let ema = null;
    for (const bar of bars) {
      const price = bar[field];
      if (ema === null) { ema = price; }
      else { ema = price * k + ema * (1 - k); }
      result.push({ time: bar.time, value: parseFloat(ema.toFixed(2)) });
    }
    return result;
  }

  function _calcVWAP(bars) {
    // Session VWAP (reset at start of data for simplicity; backend should send proper session VWAP)
    let cumTP = 0, cumVol = 0;
    return bars.map(bar => {
      const tp = (bar.high + bar.low + bar.close) / 3;
      cumTP  += tp * (bar.volume || 1);
      cumVol += (bar.volume || 1);
      return { time: bar.time, value: parseFloat((cumTP / cumVol).toFixed(2)) };
    });
  }

  function _calcRSI(bars, period = 14) {
    if (bars.length < period + 1) return [];
    const result = [];
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const d = bars[i].close - bars[i - 1].close;
      if (d >= 0) gains += d; else losses -= d;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    const rsi0 = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    result.push({ time: bars[period].time, value: parseFloat(rsi0.toFixed(2)) });

    for (let i = period + 1; i < bars.length; i++) {
      const d = bars[i].close - bars[i - 1].close;
      avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
      const rsiVal = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      result.push({ time: bars[i].time, value: parseFloat(rsiVal.toFixed(2)) });
    }
    return result;
  }

  function _calcIndicators(bars) {
    return {
      ema9:  _calcEMA(bars, 9),
      ema21: _calcEMA(bars, 21),
      vwap:  _calcVWAP(bars),
    };
  }

  // ── Crosshair OHLC display ───────────────────────────────
  function _onCrosshairMove(param) {
    if (!param.time) return;
    const bar = param.seriesData?.get(candleSeries);
    if (!bar) return;
    const el = document.getElementById('chartOHLC');
    if (!el) return;
    el.innerHTML = `
      <div class="ohlc-item"><span class="ohlc-label">O</span><span class="ohlc-val">${bar.open?.toFixed(2)}</span></div>
      <div class="ohlc-item"><span class="ohlc-label">H</span><span class="ohlc-val" style="color:#26a69a">${bar.high?.toFixed(2)}</span></div>
      <div class="ohlc-item"><span class="ohlc-label">L</span><span class="ohlc-val" style="color:#ef5350">${bar.low?.toFixed(2)}</span></div>
      <div class="ohlc-item"><span class="ohlc-label">C</span><span class="ohlc-val">${bar.close?.toFixed(2)}</span></div>
    `;
  }

  // ── Sync crosshairs ───────────────────────────────────────
  function _syncCrosshairs(chart1, chart2) {
    let syncing = false;
    chart1.subscribeCrosshairMove(p => {
      if (syncing || !p.time) return;
      syncing = true;
      chart2.setCrosshairPosition(p.point?.y ?? 0, p.time, rsiSeries);
      syncing = false;
    });
    chart1.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (range) chart2.timeScale().setVisibleLogicalRange(range);
    });
    chart2.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (range) chart1.timeScale().setVisibleLogicalRange(range);
    });
  }

  // ── Resize ───────────────────────────────────────────────
  function _onResize(entries) {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      const id = entry.target.id;
      if (id === 'mainChart' && mainChart) mainChart.resize(width, height);
      if (id === 'subChart'  && subChart)  subChart.resize(width, height);
    }
  }

  // ── Resize handle drag ────────────────────────────────────
  function _initResizeHandle() {
    const handle    = document.getElementById('resizeHandle');
    const mainEl    = document.getElementById('mainChart');
    const subEl     = document.getElementById('subChart');
    const panelsEl  = document.querySelector('.chart-panels');
    if (!handle) return;

    let dragging = false, startY = 0, startMain = 0, startSub = 0;

    handle.addEventListener('mousedown', e => {
      dragging = true;
      startY    = e.clientY;
      startMain = mainEl.clientHeight;
      startSub  = subEl.clientHeight;
      document.body.style.cursor = 'ns-resize';
      e.preventDefault();
    });

    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const dy   = e.clientY - startY;
      const newMain = Math.max(120, startMain + dy);
      const newSub  = Math.max(60,  startSub  - dy);
      mainEl.style.height = newMain + 'px';
      mainEl.style.flex   = 'none';
      subEl.style.height  = newSub  + 'px';
      if (mainChart) mainChart.resize(mainEl.clientWidth, newMain);
      if (subChart)  subChart.resize(subEl.clientWidth,  newSub);
    });

    document.addEventListener('mouseup', () => {
      if (dragging) { dragging = false; document.body.style.cursor = ''; }
    });
  }

  // ── Set EMA9 high/low lines from Fyers snapshot ─────────
  // These are EMA(9) of candle highs and lows — the core EMA9 Zone lines.
  let ema9HighSeries = null;
  let ema9LowSeries  = null;

  function setEma9Lines(ema9HighData, ema9LowData) {
    if (!mainChart) return;
    // Remove old series if exists
    if (ema9HighSeries) { try { mainChart.removeSeries(ema9HighSeries); } catch(_) {} ema9HighSeries = null; }
    if (ema9LowSeries)  { try { mainChart.removeSeries(ema9LowSeries);  } catch(_) {} ema9LowSeries  = null; }

    if (ema9HighData && ema9HighData.length) {
      ema9HighSeries = mainChart.addLineSeries({
        color: '#26a69a', lineWidth: 2, lineStyle: 0,
        priceLineVisible: false, lastValueVisible: true,
        crosshairMarkerVisible: true, title: 'EMA9 H',
      });
      ema9HighSeries.setData(ema9HighData.map(p => ({ time: p.time, value: p.value })));
    }
    if (ema9LowData && ema9LowData.length) {
      ema9LowSeries = mainChart.addLineSeries({
        color: '#ef5350', lineWidth: 2, lineStyle: 0,
        priceLineVisible: false, lastValueVisible: true,
        crosshairMarkerVisible: true, title: 'EMA9 L',
      });
      ema9LowSeries.setData(ema9LowData.map(p => ({ time: p.time, value: p.value })));
    }
  }

  // ── Set raw markers (from wave data) ─────────────────────
  function setRawMarkers(markers) {
    if (!candleSeries || !markers || !markers.length) return;
    const sorted = [...markers].sort((a, b) => a.time - b.time);
    candleSeries.setMarkers(sorted);
  }

  return { init, loadSymbol, updateTick, addSignalMarkers, addSingleMarker, updateEmaLines, setEma9Lines, setRawMarkers, setPriceLine, removePriceLine, toggleIndicator };
})();