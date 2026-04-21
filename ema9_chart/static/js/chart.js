/* ═══════════════════════════════════════════════════════════════════════════
   EMA 9 Zone — Chart Controller  v4
   ─────────────────────────────────
   FIXES:
   • Crosshair time: uses Intl.DateTimeFormat with IST — works on all browsers
   • Candles start from first bar (09:15), no clipping
   • EMA9 lines fully visible (lineWidth 2, solid, full opacity)
   • All SVG drawing strokes 2px+
   NEW:
   • TradingView-style layout
   • Left sidebar with watchlists (add/remove/create/delete)
   • Symbol search from full list
   • Timeframe selector (3m/5m/15m stored in localStorage)
   • WebSocket live layer on top of REST backtest data
   • Signal feed for wave alerts
═══════════════════════════════════════════════════════════════════════════ */
'use strict';

// ── IST time utilities ────────────────────────────────────────────────────────
// Using Intl.DateTimeFormat with formatToParts for cross-browser IST display.
// This is the CORRECT fix — toLocaleString('en-IN') fails on some Windows
// browsers. formatToParts is universally supported.

const _istFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit', month: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
const _istTimeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

function _parts(d) {
  const p = {};
  _istFmt.formatToParts(d).forEach(({type, value}) => p[type] = value);
  return p;
}

function tsToIST(unix) {
  const p = _parts(new Date(unix * 1000));
  return `${p.day}/${p.month} ${p.hour}:${p.minute}`;
}

function tsToTime(unix) {
  const p2 = {};
  _istTimeFmt.formatToParts(new Date(unix * 1000)).forEach(({type,value}) => p2[type]=value);
  return `${p2.hour}:${p2.minute}`;
}

function fmt(n) {
  return (n != null && !isNaN(n)) ? Number(n).toFixed(2) : '—';
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const chartContainer  = document.getElementById('chartContainer');
const chartPlaceholder= document.getElementById('chartPlaceholder');
const placeholderText = document.getElementById('placeholderText');
const drawingLayer    = document.getElementById('drawingLayer');
const ohlcStrip       = document.getElementById('ohlcStrip');
const waveDrawer      = document.getElementById('waveDrawer');
const wdClose         = document.getElementById('wdClose');
const wdSym           = document.getElementById('wdSym');
const wdList          = document.getElementById('wdList');
const wrChips         = document.getElementById('wrChips');
const dateBadge       = document.getElementById('dateBadge');
const waveCount       = document.getElementById('waveCount');
const candleCount     = document.getElementById('candleCount');
const symName         = document.getElementById('symName');
const symExch         = document.getElementById('symExch');
const pctTip          = document.getElementById('pctTip');
const sfList          = document.getElementById('sfList');
const toastEl         = document.getElementById('toast');
const dialogBackdrop  = document.getElementById('dialogBackdrop');

// ── State ─────────────────────────────────────────────────────────────────────
let chart = null, candleSeries = null, ema9H = null, ema9L = null;
let allSymbols = [], activeSymbol = '', activeTF = '3';
let _candleMap = {}, _ema9HMap = {}, _ema9LMap = {};
let _allWaves = [], _allMarkers = [], _currentData = null;
let drawings = [], activeTool = 'pointer', pctStart = null, posCtx = null;
let _ws = null, _wsReconnMs = 1500, _wsSub = '';

// ── Toast ─────────────────────────────────────────────────────────────────────
let _toastTimer;
function showToast(msg, ms = 2500) {
  clearTimeout(_toastTimer);
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  _toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

// ════════════════════════════════════════════════════════════════════════════
//  WATCHLIST
// ════════════════════════════════════════════════════════════════════════════
let _watchlists = {};        // {name: [symbol, ...]}
let _activeWL   = 'Default';

async function loadWatchlists() {
  try {
    const r = await fetch('/api/watchlists');
    _watchlists = await r.json();
    if (!Object.keys(_watchlists).length) _watchlists = { Default: [] };
    // seed Default with all symbols if empty
    if (!_watchlists.Default || !_watchlists.Default.length) {
      _watchlists.Default = [...allSymbols];
      await fetch('/api/watchlists/Default/..', {method:'PUT',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({symbols: allSymbols})});
    }
  } catch { _watchlists = { Default: [...allSymbols] }; }
  _activeWL = Object.keys(_watchlists)[0] || 'Default';
  renderWLTabs();
  renderWLBody();
}

function renderWLTabs() {
  const tabs = document.getElementById('wlTabs');
  tabs.innerHTML = '';
  Object.keys(_watchlists).forEach(name => {
    const tab = document.createElement('div');
    tab.className = 'wl-tab' + (name === _activeWL ? ' active' : '');
    tab.innerHTML = `<span>${name}</span>
      <span class="wl-tab-del" data-wl="${name}" title="Delete">✕</span>`;
    tab.addEventListener('click', e => {
      if (e.target.classList.contains('wl-tab-del')) return;
      _activeWL = name;
      renderWLTabs();
      renderWLBody();
    });
    tab.querySelector('.wl-tab-del').addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm(`Delete watchlist "${name}"?`)) return;
      await fetch(`/api/watchlists/${encodeURIComponent(name)}`, {method:'DELETE'});
      delete _watchlists[name];
      _activeWL = Object.keys(_watchlists)[0] || 'Default';
      renderWLTabs(); renderWLBody();
    });
    tabs.appendChild(tab);
  });
}

function renderWLBody() {
  const body = document.getElementById('wlBody');
  const syms = _watchlists[_activeWL] || [];
  if (!syms.length) {
    body.innerHTML = '<div class="wl-empty">Empty — search above to add symbols</div>';
    return;
  }
  body.innerHTML = '';
  syms.forEach(sym => {
    const clean = sym.replace('NSE:','').replace('-EQ','').replace('-INDEX','');
    const row = document.createElement('div');
    row.className = 'wl-item' + (sym === activeSymbol ? ' active' : '');
    row.innerHTML = `
      <span class="wl-item-name">${clean}</span>
      <span class="wl-item-del" title="Remove">✕</span>`;
    row.addEventListener('click', e => {
      if (e.target.classList.contains('wl-item-del')) return;
      selectSymbol(sym);
    });
    row.querySelector('.wl-item-del').addEventListener('click', async e => {
      e.stopPropagation();
      await fetch(`/api/watchlists/${encodeURIComponent(_activeWL)}/remove`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({symbol: sym}),
      });
      _watchlists[_activeWL] = (_watchlists[_activeWL] || []).filter(s => s !== sym);
      renderWLBody();
    });
    body.appendChild(row);
  });
}

async function addToWatchlist(symbol) {
  if (!_watchlists[_activeWL]) _watchlists[_activeWL] = [];
  if (_watchlists[_activeWL].includes(symbol)) {
    showToast(`${symbol.replace('NSE:','').replace('-EQ','')} already in ${_activeWL}`);
    return;
  }
  await fetch(`/api/watchlists/${encodeURIComponent(_activeWL)}/add`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({symbol}),
  });
  _watchlists[_activeWL].push(symbol);
  renderWLBody();
  showToast(`Added to ${_activeWL}`);
}

// New watchlist
document.getElementById('btnAddWatchlist').addEventListener('click', async () => {
  const name = prompt('Watchlist name:');
  if (!name || !name.trim()) return;
  const n = name.trim();
  await fetch('/api/watchlists', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name: n, symbols: []}),
  });
  _watchlists[n] = [];
  _activeWL = n;
  renderWLTabs(); renderWLBody();
});

// ════════════════════════════════════════════════════════════════════════════
//  SEARCH
// ════════════════════════════════════════════════════════════════════════════
const sbSearch  = document.getElementById('sbSearch');
const sbResults = document.getElementById('sbResults');
const sbClear   = document.getElementById('sbSearchClear');

sbSearch.addEventListener('input', () => {
  const q = sbSearch.value.trim().toLowerCase();
  sbClear.style.display = q ? 'block' : 'none';
  if (!q) { sbResults.style.display = 'none'; return; }

  const matches = allSymbols.filter(s => s.toLowerCase().includes(q)).slice(0, 20);
  sbResults.innerHTML = '';
  if (!matches.length) {
    sbResults.innerHTML = '<div class="wl-empty">No symbols found</div>';
    sbResults.style.display = 'block';
    return;
  }
  matches.forEach(sym => {
    const clean = sym.replace('NSE:','').replace('-EQ','').replace('-INDEX','');
    const row = document.createElement('div');
    row.className = 'sb-result-item';
    row.innerHTML = `
      <div><span class="sb-result-name">${clean}</span>
           <span class="sb-result-exch">NSE</span></div>
      <span class="sb-result-add">+ Add</span>`;
    row.addEventListener('click', e => {
      if (e.target.classList.contains('sb-result-add')) {
        addToWatchlist(sym);
      } else {
        selectSymbol(sym);
        sbSearch.value = '';
        sbClear.style.display = 'none';
        sbResults.style.display = 'none';
      }
    });
    sbResults.appendChild(row);
  });
  sbResults.style.display = 'block';
});

sbClear.addEventListener('click', () => {
  sbSearch.value = ''; sbClear.style.display = 'none';
  sbResults.style.display = 'none';
});

document.addEventListener('click', e => {
  if (!e.target.closest('.sb-search-wrap') && !e.target.closest('.sb-results')) {
    sbResults.style.display = 'none';
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  TIMEFRAME
// ════════════════════════════════════════════════════════════════════════════
activeTF = localStorage.getItem('ema9_tf') || '3';
document.querySelectorAll('.tf-btn').forEach(btn => {
  if (btn.dataset.tf === activeTF) btn.classList.add('active');
  else btn.classList.remove('active');
  btn.addEventListener('click', () => {
    activeTF = btn.dataset.tf;
    localStorage.setItem('ema9_tf', activeTF);
    document.querySelectorAll('.tf-btn').forEach(b => b.classList.toggle('active', b.dataset.tf === activeTF));
    if (activeSymbol) loadSymbol(activeSymbol);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  WEBSOCKET
// ════════════════════════════════════════════════════════════════════════════
function _wsConnect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  _ws = new WebSocket(`${proto}//${location.host}/ws`);
  _ws.onopen = () => {
    _wsReconnMs = 1500;
    if (activeSymbol) _wsSend({action:'subscribe', symbol: activeSymbol});
  };
  _ws.onmessage = ev => {
    try { _wsDispatch(JSON.parse(ev.data)); } catch {}
  };
  _ws.onclose = _ws.onerror = () => {
    setTimeout(_wsConnect, _wsReconnMs);
    _wsReconnMs = Math.min(_wsReconnMs * 2, 30000);
  };
}

function _wsSend(o) {
  if (_ws && _ws.readyState === WebSocket.OPEN) _ws.send(JSON.stringify(o));
}

function _wsDispatch(msg) {
  if (msg.type === 'symbols' && msg.symbols?.length) {
    // merge any live symbols not already in list
    msg.symbols.forEach(s => { if (!allSymbols.includes(s)) allSymbols.push(s); });
  }
  if (msg.symbol !== activeSymbol) return;
  if (msg.type === 'tick') _onTick(msg);
  if (msg.type === 'candle_close') _onCandleClose(msg);
}

function _onTick(msg) {
  if (!candleSeries) return;
  const prev = _candleMap[msg.time];
  candleSeries.update({
    time:  msg.time,
    open:  prev?.open  ?? msg.price,
    high:  Math.max(prev?.high ?? msg.price, msg.price),
    low:   Math.min(prev?.low  ?? msg.price, msg.price),
    close: msg.price,
  });
}

function _onCandleClose(msg) {
  if (!candleSeries) return;
  const c = msg.candle;
  _candleMap[c.time] = c;
  if (c.ema9_high != null) _ema9HMap[c.time] = c.ema9_high;
  if (c.ema9_low  != null) _ema9LMap[c.time] = c.ema9_low;
  candleSeries.update(c);
  if (c.ema9_high != null) ema9H.update({time:c.time, value:c.ema9_high});
  if (c.ema9_low  != null) ema9L.update({time:c.time, value:c.ema9_low});
  candleCount.textContent = Object.keys(_candleMap).length;
  if (msg.wave) {
    _allWaves.push(msg.wave);
    waveCount.textContent = _allWaves.length;
    if (msg.markers) {
      _allMarkers.push(...(Array.isArray(msg.markers) ? msg.markers : [msg.markers]));
      _applyMarkers();
    }
    buildWaveRail(_allWaves);
    buildDrawer(activeSymbol, _allWaves);
    _addSignal(msg.wave);
    const w = msg.wave;
    showToast(`★ Wave ${w.wave_number} ${w.sequence}  HH:${fmt(w.hh_val)} LL:${fmt(w.ll_val)}`, 5000);
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  SYMBOL LOAD
// ════════════════════════════════════════════════════════════════════════════
async function loadSymbols() {
  try {
    const r = await fetch('/api/symbols');
    const d = await r.json();
    allSymbols = d.symbols || [];
    await loadWatchlists();
    if (allSymbols.length) selectSymbol(allSymbols[0]);
  } catch {
    placeholderText.textContent = 'Cannot connect to server';
    showToast('✗ Server not reachable', 4000);
  }
}

function selectSymbol(sym) {
  if (sym === activeSymbol) return;
  if (_ws?.readyState === WebSocket.OPEN) {
    if (_wsSub) _wsSend({action:'unsubscribe', symbol:_wsSub});
    _wsSub = sym; _wsSend({action:'subscribe', symbol:sym});
  }
  activeSymbol = sym;
  const clean = sym.replace('NSE:','').replace('-EQ','').replace('-INDEX','');
  symName.textContent = clean;
  symExch.textContent = 'NSE';
  renderWLBody();
  loadSymbol(sym);
}

async function loadSymbol(sym) {
  chartPlaceholder.style.display = 'none';
  ohlcStrip.style.display = 'none';
  _candleMap = {}; _ema9HMap = {}; _ema9LMap = {};
  _allWaves  = []; _allMarkers = [];

  try {
    const r = await fetch(`/api/chart/${encodeURIComponent(sym)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    _currentData = data;

    dateBadge.textContent = data.date || '—';
    waveCount.textContent  = data.waves.length;

    // Build candle + EMA maps — always use multi_day (2-day continuous)
    const days = data.multi_day || [];
    if (days.length) {
      days.forEach(day => {
        (day.candles   || []).forEach(c => _candleMap[c.time] = c);
        (day.ema9_high || []).forEach(p => _ema9HMap[p.time]  = p.value);
        (day.ema9_low  || []).forEach(p => _ema9LMap[p.time]  = p.value);
      });
    } else {
      (data.candles   || []).forEach(c => _candleMap[c.time] = c);
      (data.ema9_high || []).forEach(p => _ema9HMap[p.time]  = p.value);
      (data.ema9_low  || []).forEach(p => _ema9LMap[p.time]  = p.value);
    }

    _allWaves   = data.waves   || [];
    _allMarkers = data.markers || [];

    _initChart();
    _pushAll();
    _applyMarkers();

    buildWaveRail(_allWaves);
    buildDrawer(sym, _allWaves);
    redrawAll();
    showToast(`${sym.replace('NSE:','').replace('-EQ','')} — ${data.waves.length} waves`);

  } catch(e) {
    showToast(`✗ Failed to load ${sym}`, 3000);
    console.error(e);
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  CHART CREATION
// ════════════════════════════════════════════════════════════════════════════
function _initChart() {
  if (chart) { chart.remove(); chart = null; candleSeries = null; ema9H = null; ema9L = null; }

  chart = LightweightCharts.createChart(chartContainer, {
    width:  chartContainer.clientWidth,
    height: chartContainer.clientHeight,

    // ── IST time axis fix ──────────────────────────────────────────────────
    // localization.timeFormatter forces every axis tick to display in IST.
    // Combined with our Intl-based tsToIST() in the crosshair handler,
    // all times show correctly as 09:15–15:27 regardless of machine timezone.
    localization: {
      timeFormatter: unix => {
        const p = {};
        _istTimeFmt.formatToParts(new Date(unix * 1000))
          .forEach(({type, value}) => p[type] = value);
        return `${p.hour}:${p.minute}`;
      },
    },

    layout: {
      background: { type: 'solid', color: '#131722' },
      textColor:  '#787b86',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize:   11,
    },

    grid: {
      vertLines: { color: '#1e222d', style: 0 },
      horzLines: { color: '#1e222d', style: 0 },
    },

    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: '#2a2e39', labelBackgroundColor: '#1e222d', width: 1 },
      horzLine: { color: '#2a2e39', labelBackgroundColor: '#1e222d', width: 1 },
    },

    rightPriceScale: {
      borderColor:  '#2a2e39',
      textColor:    '#787b86',
      scaleMargins: { top: 0.06, bottom: 0.04 },
    },

    timeScale: {
      borderColor:    '#2a2e39',
      timeVisible:    true,
      secondsVisible: false,
      rightOffset:    8,
      barSpacing:     6,        // comfortable default spacing
      fixLeftEdge:    true,     // candles start from left edge
      fixRightEdge:   false,
      lockVisibleTimeRangeOnResize: true,
    },

    handleScroll: { mouseWheel:true, pressedMouseMove:true, horzTouchDrag:true, vertTouchDrag:true },
    handleScale:  { mouseWheel:true, pinch:true,
                    axisPressedMouseMove:{time:true, price:true},
                    axisDoubleClickReset:true },
  });

  // Candlestick
  candleSeries = chart.addCandlestickSeries({
    upColor:          '#26a69a',
    downColor:        '#ef5350',
    borderUpColor:    '#26a69a',
    borderDownColor:  '#ef5350',
    wickUpColor:      '#26a69a',
    wickDownColor:    '#ef5350',
    priceLineVisible: false,
    lastValueVisible: true,
  });

  // EMA9 High — fully visible green line
  ema9H = chart.addLineSeries({
    color:                  '#26a69a',
    lineWidth:              2,
    lineStyle:              LightweightCharts.LineStyle.Solid,
    priceLineVisible:       false,
    lastValueVisible:       true,
    crosshairMarkerVisible: true,
    crosshairMarkerRadius:  4,
    title: 'EMA9 H',
  });

  // EMA9 Low — fully visible red line
  ema9L = chart.addLineSeries({
    color:                  '#ef5350',
    lineWidth:              2,
    lineStyle:              LightweightCharts.LineStyle.Solid,
    priceLineVisible:       false,
    lastValueVisible:       true,
    crosshairMarkerVisible: true,
    crosshairMarkerRadius:  4,
    title: 'EMA9 L',
  });

  // ── Crosshair ─────────────────────────────────────────────────────────────
  chart.subscribeCrosshairMove(param => {
    if (!param.point || !param.seriesData.size) {
      ohlcStrip.style.display = 'none';
      return;
    }
    const cd = param.seriesData.get(candleSeries);
    if (!cd) return;
    ohlcStrip.style.display = 'flex';

    // ── CROSSHAIR TIME FIX ────────────────────────────────────────────────
    // param.time is the raw unix int from the data.
    // We use Intl.DateTimeFormat with IST timezone (defined at top of file).
    // This is reliable on all platforms including Windows browsers.
    document.getElementById('xhTime').textContent  = tsToIST(param.time);
    document.getElementById('xhOpen').textContent  = fmt(cd.open);
    document.getElementById('xhHigh').textContent  = fmt(cd.high);
    document.getElementById('xhLow').textContent   = fmt(cd.low);
    document.getElementById('xhClose').textContent = fmt(cd.close);
    document.getElementById('xhEmaH').textContent  = fmt(_ema9HMap[param.time]);
    document.getElementById('xhEmaL').textContent  = fmt(_ema9LMap[param.time]);

    // % measure tooltip preview
    if (activeTool === 'pct' && pctStart && param.point) {
      const price = candleSeries.coordinateToPrice(param.point.y);
      if (price) {
        const pct  = ((price - pctStart.price) / pctStart.price * 100).toFixed(2);
        const sign = pct >= 0 ? '+' : '';
        pctTip.textContent   = `${sign}${pct}%  (${fmt(pctStart.price)} → ${fmt(price)})`;
        pctTip.style.display = 'block';
        pctTip.style.left    = (param.point.x + 16) + 'px';
        pctTip.style.top     = (param.point.y - 12) + 'px';
      }
    }
  });

  // Chart click → drawing tools
  chart.subscribeClick(param => {
    if (!param.point || !param.time) return;
    const price = candleSeries.coordinateToPrice(param.point.y);
    if (price == null) return;
    _handleClick(param.time, price, param.point);
  });

  // Resize
  new ResizeObserver(() => {
    if (chart) chart.resize(chartContainer.clientWidth, chartContainer.clientHeight);
    redrawAll();
  }).observe(chartContainer);
}

function _pushAll() {
  if (!candleSeries) return;
  const candles = Object.values(_candleMap).sort((a,b) => a.time - b.time);
  candleSeries.setData(candles);
  ema9H.setData(Object.entries(_ema9HMap).map(([t,v])=>({time:+t,value:v})).sort((a,b)=>a.time-b.time));
  ema9L.setData(Object.entries(_ema9LMap).map(([t,v])=>({time:+t,value:v})).sort((a,b)=>a.time-b.time));
  candleCount.textContent = candles.length;
  // Fit so first candle starts at left edge
  chart.timeScale().fitContent();
}

function _applyMarkers() {
  if (!candleSeries) return;
  const sorted = [..._allMarkers].sort((a,b) => a.time-b.time);
  candleSeries.setMarkers(sorted.map(m => ({...m, size: m.size || 1.5})));
}

// ════════════════════════════════════════════════════════════════════════════
//  WAVE RAIL + DRAWER
// ════════════════════════════════════════════════════════════════════════════
function buildWaveRail(waves) {
  wrChips.innerHTML = '';
  if (!waves.length) {
    wrChips.innerHTML = '<span style="color:var(--t3);font-size:10px">No waves yet</span>';
    return;
  }
  [...waves].reverse().forEach(w => {
    const chip = document.createElement('div');
    chip.className = 'wchip';
    const hl = w.sequence === 'HH_LL';
    chip.innerHTML = `
      <span class="wchip-n">W${w.wave_number}</span>
      <span class="wchip-hh">${hl?'HH':'LL'} ${(hl?w.hh_val:w.ll_val).toFixed(2)}</span>
      <span style="color:var(--t3)">→</span>
      <span class="wchip-ll">${hl?'LL':'HH'} ${(hl?w.ll_val:w.hh_val).toFixed(2)}</span>`;
    chip.addEventListener('click', () => {
      if (!chart) return;
      chart.timeScale().setVisibleRange({
        from: Math.min(w.hh_time, w.ll_time) - 180*10,
        to:   Math.max(w.hh_time, w.ll_time) + 180*10,
      });
      document.querySelectorAll('.wchip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      waveDrawer.classList.add('open');
    });
    wrChips.appendChild(chip);
  });
}

function buildDrawer(sym, waves) {
  wdSym.textContent = sym.replace('NSE:','').replace('-EQ','');
  wdList.innerHTML  = '';
  if (!waves.length) {
    wdList.innerHTML = '<div style="padding:14px;color:var(--t3);font-size:11px">No waves.</div>';
    return;
  }
  [...waves].reverse().forEach(w => {
    const card = document.createElement('div');
    card.className = 'wd-card';
    const hl = w.sequence === 'HH_LL';
    card.innerHTML = `
      <div class="wd-card-head">
        <span class="wd-card-num">Wave ${w.wave_number}</span>
        <span class="wd-card-seq">${hl ? 'HIGH → LOW' : 'LOW → HIGH'}</span>
      </div>
      <div class="wd-card-body">
        ${_extHTML(hl?'HH':'LL', hl?w.hh_val:w.ll_val, hl?w.hh_time:w.ll_time)}
        ${_extHTML(hl?'LL':'HH', hl?w.ll_val:w.hh_val, hl?w.ll_time:w.hh_time)}
      </div>`;
    card.addEventListener('click', () => {
      if (!chart) return;
      chart.timeScale().setVisibleRange({
        from: Math.min(w.hh_time, w.ll_time) - 180*10,
        to:   Math.max(w.hh_time, w.ll_time) + 180*10,
      });
    });
    wdList.appendChild(card);
  });
}

function _extHTML(type, val, time) {
  const cls = type === 'HH' ? 'hh' : 'll';
  return `<div class="wd-extreme">
    <div class="wd-dot ${cls}"></div>
    <div class="wd-ext-info">
      <span class="wd-ext-type ${cls}">${type === 'HH' ? 'HIGHER HIGH' : 'LOWER LOW'}</span>
      <span class="wd-ext-time">${tsToTime(time)}</span>
      <span class="wd-ext-val">${Number(val).toFixed(2)}</span>
    </div>
  </div>`;
}

function _addSignal(wave) {
  const row = document.createElement('div');
  row.className = 'sf-row';
  const bull = wave.sequence === 'LL_HH';
  row.innerHTML = `
    <span class="sf-time">${tsToTime(Math.max(wave.hh_time, wave.ll_time))}</span>
    <span class="sf-badge ${bull?'bull':'bear'}">${wave.sequence}</span>
    <span class="sf-detail">W${wave.wave_number} HH:${wave.hh_val.toFixed(2)} LL:${wave.ll_val.toFixed(2)}</span>`;
  sfList.prepend(row);
  while (sfList.children.length > 20) sfList.lastChild.remove();
}

// ════════════════════════════════════════════════════════════════════════════
//  DRAWING TOOLS
// ════════════════════════════════════════════════════════════════════════════
function setTool(tool) {
  activeTool = tool;
  document.querySelectorAll('.tool-btn[data-tool]').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === tool));
  chartContainer.dataset.tool = tool;
  pctStart = null; pctTip.style.display = 'none';
  chartContainer.style.cursor = tool === 'pointer' ? 'default' : 'crosshair';
}

document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => {
    const t = btn.dataset.tool;
    if (t === 'pointer') { setTool('pointer'); return; }
    setTool(t === activeTool ? 'pointer' : t);
  });
});

document.getElementById('btnClear').addEventListener('click', () => {
  drawings = []; redrawAll(); showToast('Drawings cleared');
});

function _handleClick(time, price, point) {
  if (activeTool === 'pointer') return;
  if (activeTool === 'hline') {
    drawings.push({type:'hline', price}); redrawAll();
    showToast(`H-Line @ ${fmt(price)}`); return;
  }
  if (activeTool === 'vline') {
    drawings.push({type:'vline', time}); redrawAll();
    showToast(`V-Line @ ${tsToIST(time)}`); return;
  }
  if (activeTool === 'hray') {
    drawings.push({type:'hray', price, time}); redrawAll();
    showToast(`H-Ray @ ${fmt(price)}`); return;
  }
  if (activeTool === 'pct') {
    if (!pctStart) {
      pctStart = {price, time};
      showToast(`Anchor @ ${fmt(price)} — click endpoint`);
    } else {
      const pct  = ((price - pctStart.price) / pctStart.price * 100).toFixed(2);
      const sign = pct >= 0 ? '+' : '';
      drawings.push({type:'pct', startPrice:pctStart.price, endPrice:price,
                     startTime:pctStart.time, endTime:time, label:`${sign}${pct}%`});
      pctStart = null; pctTip.style.display = 'none';
      redrawAll(); showToast(`Measured: ${sign}${pct}%`);
    }
    return;
  }
  if (['long','short','entry','exit'].includes(activeTool)) {
    posCtx = {type: activeTool, price, time};
    _openDialog(activeTool, price); return;
  }
}

// ── SVG drawing helpers ───────────────────────────────────────────────────────
function redrawAll() {
  if (!chart || !candleSeries) { drawingLayer.innerHTML = ''; return; }
  const r = chartContainer.getBoundingClientRect();
  drawingLayer.setAttribute('width',  r.width);
  drawingLayer.setAttribute('height', r.height);
  drawingLayer.innerHTML = '';
  drawings.forEach((d,i) => {
    try {
      if (d.type==='hline')    _dHLine(d,i);
      if (d.type==='vline')    _dVLine(d,i);
      if (d.type==='hray')     _dHRay(d,i);
      if (d.type==='pct')      _dPct(d,i);
      if (d.type==='position') _dPos(d,i);
    } catch(_) {}
  });
}

function _svg(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs).forEach(([k,v]) => el.setAttribute(k,v));
  return el;
}
const _W = () => parseFloat(drawingLayer.getAttribute('width'));
const _H = () => parseFloat(drawingLayer.getAttribute('height'));
const _py = p => candleSeries.priceToCoordinate(p);
const _tx = t => chart.timeScale().timeToCoordinate(t);

function _delBtn(x, y, idx) {
  const g = _svg('g', {cursor:'pointer'});
  g.innerHTML = `<circle cx="${x}" cy="${y}" r="8" fill="#1e222d" stroke="#363a45" stroke-width="1.5"/>
    <text x="${x}" y="${y+4}" text-anchor="middle" fill="#ef5350" font-size="11" font-family="Inter">✕</text>`;
  g.addEventListener('click', e => { e.stopPropagation(); drawings.splice(idx,1); redrawAll(); });
  drawingLayer.appendChild(g);
}

function _dHLine(d, i) {
  const y = _py(d.price); if (y==null) return;
  const w = _W();
  drawingLayer.append(
    _svg('line', {x1:0, y1:y, x2:w, y2:y, stroke:'#2962ff', 'stroke-width':'2', 'stroke-dasharray':'5 4'}),
    Object.assign(_svg('text', {x:w-10, y:y-5, fill:'#2962ff',
      'font-size':'10','font-family':'JetBrains Mono','text-anchor':'end','font-weight':'600'}),
      {textContent: fmt(d.price)})
  );
  _delBtn(14, y, i);
}

function _dVLine(d, i) {
  const x = _tx(d.time); if (x==null) return;
  const h = _H();
  drawingLayer.append(
    _svg('line', {x1:x, y1:0, x2:x, y2:h, stroke:'#f9a825', 'stroke-width':'2', 'stroke-dasharray':'5 4'}),
    Object.assign(_svg('text', {x:x+5, y:14, fill:'#f9a825',
      'font-size':'10','font-family':'JetBrains Mono','font-weight':'600'}),
      {textContent: tsToTime(d.time)})
  );
  _delBtn(x, 26, i);
}

function _dHRay(d, i) {
  const y = _py(d.price); const x0 = _tx(d.time);
  if (y==null||x0==null) return;
  const w = _W();
  drawingLayer.append(
    _svg('line', {x1:x0, y1:y, x2:w, y2:y, stroke:'#ab47bc', 'stroke-width':'2.5'}),
    _svg('circle', {cx:x0, cy:y, r:4, fill:'#ab47bc'}),
    Object.assign(_svg('text', {x:w-10, y:y-6, fill:'#ab47bc',
      'font-size':'10','font-family':'JetBrains Mono','text-anchor':'end','font-weight':'600'}),
      {textContent: fmt(d.price)})
  );
  _delBtn(x0, y, i);
}

function _dPct(d, i) {
  const y1=_py(d.startPrice), y2=_py(d.endPrice);
  const x1=_tx(d.startTime),  x2=_tx(d.endTime);
  if (y1==null||y2==null||x1==null||x2==null) return;
  const up = d.endPrice >= d.startPrice;
  const clr = up ? '#26a69a' : '#ef5350';
  const fill= up ? 'rgba(38,166,154,0.1)' : 'rgba(239,83,80,0.1)';
  const rx=Math.min(x1,x2), ry=Math.min(y1,y2);
  const rw=Math.abs(x2-x1), rh=Math.abs(y2-y1);
  drawingLayer.append(
    _svg('rect', {x:rx, y:ry, width:rw, height:rh,
      fill, stroke:clr, 'stroke-width':'2', 'stroke-dasharray':'4 3'}),
    Object.assign(_svg('text', {x:rx+rw/2, y:ry+rh/2+5, fill:clr,
      'font-size':'13','font-family':'JetBrains Mono',
      'text-anchor':'middle','font-weight':'700'}),
      {textContent: d.label})
  );
  _delBtn(rx+rw-10, ry+10, i);
}

function _dPos(d, i) {
  const ey=_py(d.entry); const x0=_tx(d.time);
  if (ey==null||x0==null) return;
  const sy=d.stop?_py(d.stop):null, ty=d.target?_py(d.target):null;
  const w=_W(), clr=d.posType==='long'?'#26a69a':'#ef5350';
  drawingLayer.append(
    _svg('line',{x1:x0, y1:ey, x2:w, y2:ey, stroke:clr, 'stroke-width':'2.5', 'stroke-dasharray':'6 4'}),
    Object.assign(_svg('text',{x:w-10, y:ey-6, fill:clr,
      'font-size':'10','font-family':'JetBrains Mono','text-anchor':'end','font-weight':'700'}),
      {textContent:`ENTRY ${fmt(d.entry)}`})
  );
  if (sy!=null) drawingLayer.append(
    _svg('line',{x1:x0,y1:sy,x2:w,y2:sy,stroke:'#ef5350','stroke-width':'2','stroke-dasharray':'4 3'}),
    Object.assign(_svg('text',{x:w-10,y:sy-6,fill:'#ef5350',
      'font-size':'10','font-family':'JetBrains Mono','text-anchor':'end'}),{textContent:`SL ${fmt(d.stop)}`})
  );
  if (ty!=null) drawingLayer.append(
    _svg('line',{x1:x0,y1:ty,x2:w,y2:ty,stroke:'#26a69a','stroke-width':'2','stroke-dasharray':'4 3'}),
    Object.assign(_svg('text',{x:w-10,y:ty-6,fill:'#26a69a',
      'font-size':'10','font-family':'JetBrains Mono','text-anchor':'end'}),{textContent:`TP ${fmt(d.target)}`})
  );
  const dir = d.posType==='long';
  drawingLayer.append(_svg('polygon', {
    points: dir
      ? `${x0},${ey-14} ${x0-8},${ey-2} ${x0+8},${ey-2}`
      : `${x0},${ey+14} ${x0-8},${ey+2} ${x0+8},${ey+2}`,
    fill: clr,
  }));
  if (d.note) drawingLayer.append(
    Object.assign(_svg('text',{x:x0+12,y:ey-12,fill:'#787b86',
      'font-size':'10','font-family':'JetBrains Mono'}), {textContent:d.note})
  );
  _delBtn(x0, ey, i);
}

// ── Position dialog ───────────────────────────────────────────────────────────
function _openDialog(type, price) {
  const labels = {entry:'ENTRY ALERT',exit:'EXIT ALERT',long:'LONG POSITION',short:'SHORT POSITION'};
  document.getElementById('dialogTitle').textContent = labels[type] || type.toUpperCase();
  document.getElementById('pdEntry').value  = price ? price.toFixed(2) : '';
  document.getElementById('pdStop').value   = '';
  document.getElementById('pdTarget').value = '';
  document.getElementById('pdNote').value   = '';
  dialogBackdrop.style.display = 'flex';
}

document.getElementById('dialogClose').addEventListener('click', () => {
  dialogBackdrop.style.display = 'none'; posCtx = null; setTool('pointer');
});
dialogBackdrop.addEventListener('click', e => {
  if (e.target === dialogBackdrop) { dialogBackdrop.style.display = 'none'; posCtx = null; setTool('pointer'); }
});
document.getElementById('pdSubmit').addEventListener('click', () => {
  if (!posCtx) return;
  const ctx = posCtx;
  drawings.push({
    type:'position', posType:ctx.type, time:ctx.time,
    entry:  parseFloat(document.getElementById('pdEntry').value)  || ctx.price,
    stop:   parseFloat(document.getElementById('pdStop').value)   || null,
    target: parseFloat(document.getElementById('pdTarget').value) || null,
    note:   document.getElementById('pdNote').value,
  });
  redrawAll();
  dialogBackdrop.style.display = 'none'; posCtx = null; setTool('pointer');
  showToast('Position added to chart');
});

// ── Events ────────────────────────────────────────────────────────────────────
document.getElementById('btnReset').addEventListener('click', () => {
  if (chart) chart.timeScale().fitContent();
});
wdClose.addEventListener('click', () => waveDrawer.classList.remove('open'));

// Keyboard
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key;
  if (k==='Escape') { waveDrawer.classList.remove('open'); setTool('pointer'); dialogBackdrop.style.display='none'; }
  if (k==='r'||k==='R') { if (chart) chart.timeScale().fitContent(); }
  if (k==='h'||k==='H') setTool('hline');
  if (k==='v'||k==='V') setTool('vline');
  if (k==='y'||k==='Y') setTool('hray');
  if (k==='m'||k==='M') setTool('pct');
  if (k==='l'||k==='L') setTool('long');
  if (k==='s'||k==='S') setTool('short');
  // Arrow keys to navigate watchlist
  if (k==='ArrowDown'||k==='ArrowUp') {
    const wl = _watchlists[_activeWL] || [];
    const idx = wl.indexOf(activeSymbol);
    const next = k==='ArrowDown' ? idx+1 : idx-1;
    if (next >= 0 && next < wl.length) selectSymbol(wl[next]);
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
_wsConnect();
loadSymbols();
