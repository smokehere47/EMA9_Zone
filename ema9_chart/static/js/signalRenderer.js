/**
 * signalRenderer.js — Renders signal log + toast notifications
 */
const SignalRenderer = (() => {
  const ICONS = { LONG: '▲', SHORT: '▼', ZONE: '◆', EXIT: '×' };

  function renderLog() {
    const el = document.getElementById('signalLog');
    if (!el) return;
    const sigs = DataStore.getAllSignals().slice(0, 30);
    el.innerHTML = sigs.map(s => `
      <div class="signal-item" onclick="ChartEngine.addSingleMarker(${JSON.stringify(s).replace(/"/g, '&quot;')})">
        <span class="sig-badge ${s.signal_type}">${s.signal_type || '?'}</span>
        <div class="sig-body">
          <div class="sig-sym">${s.symbol}</div>
          <div class="sig-msg">${s.message || _defaultMsg(s)}</div>
        </div>
        <span class="sig-time">${_fmtTime(s.time)}</span>
      </div>
    `).join('');
  }

  function showToast(signal) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const icons = { LONG: '🟢', SHORT: '🔴', ZONE: '🟡', EXIT: '⚪' };
    const toast = document.createElement('div');
    toast.className = `toast ${signal.signal_type || ''}`;
    toast.innerHTML = `
      <span class="toast-icon">${icons[signal.signal_type] || '📊'}</span>
      <div class="toast-body">
        <div class="toast-title">${signal.symbol} — ${signal.signal_type}</div>
        <div class="toast-msg">${signal.message || _defaultMsg(signal)} @ ${signal.price?.toFixed(2) || ''}</div>
      </div>
      <span class="toast-time">${_fmtTime(signal.time)}</span>
    `;
    container.appendChild(toast);
    setTimeout(() => { toast.classList.add('toast-out'); setTimeout(() => toast.remove(), 250); }, 5000);
  }

  function _defaultMsg(s) {
    if (s.signal_type === 'LONG')  return `EMA9 cross above — Zone entry`;
    if (s.signal_type === 'SHORT') return `EMA9 cross below — Zone exit`;
    if (s.signal_type === 'ZONE')  return `Price in EMA zone`;
    return 'Signal';
  }

  function _fmtTime(t) {
    if (!t) return '';
    const d = new Date(typeof t === 'number' && t < 1e12 ? t * 1000 : t);
    return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  }

  return { renderLog, showToast };
})();


/**
 * watchlist.js — Renders symbol watchlist in left sidebar
 */
const WatchlistComponent = (() => {
  function render() {
    const el = document.getElementById('watchlist');
    if (!el) return;
    const items = DataStore.getWatchlist();
    el.innerHTML = items.map(w => {
      const tick = DataStore.getTick(w.symbol);
      const dir  = tick.change >= 0 ? 'up' : 'down';
      const chgStr = (tick.change >= 0 ? '+' : '') + (tick.change_pct?.toFixed(2) || '0.00') + '%';
      return `
        <div class="wl-item ${w.symbol === AppState.activeSymbol ? 'active' : ''}"
             onclick="App.switchSymbol('${w.symbol}')">
          <div class="wl-left">
            <span class="wl-name">${w.symbol}</span>
            <span class="wl-sub">${w.exchange}</span>
          </div>
          <div class="wl-right">
            <span class="wl-price ${dir}">${tick.price > 0 ? tick.price.toFixed(2) : '—'}</span>
            <span class="wl-chg ${dir}">${tick.price > 0 ? chgStr : ''}</span>
          </div>
        </div>
      `;
    }).join('');

    // Also populate symbol tabs
    _renderSymbolTabs(items);
    // Also populate alert symbol dropdown
    const alertSym = document.getElementById('alertSymbol');
    if (alertSym) alertSym.innerHTML = items.map(w => `<option value="${w.symbol}">${w.symbol}</option>`).join('');
  }

  function _renderSymbolTabs(items) {
    const el = document.getElementById('symbolTabs');
    if (!el) return;
    el.innerHTML = items.map(w => {
      const tick = DataStore.getTick(w.symbol);
      const dir  = tick.change >= 0 ? 'up' : 'down';
      return `
        <div class="symbol-tab ${w.symbol === AppState.activeSymbol ? 'active' : ''}"
             onclick="App.switchSymbol('${w.symbol}')">
          ${w.symbol}
          <span class="tab-price">${tick.price > 0 ? tick.price.toFixed(2) : ''}</span>
          <span class="tab-chg ${dir}">${tick.price > 0 ? (tick.change >= 0 ? '▲' : '▼') + Math.abs(tick.change_pct || 0).toFixed(2) + '%' : ''}</span>
        </div>
      `;
    }).join('');
  }

  return { render };
})();


/**
 * analysisPanel.js — EMA structure, zone levels, market stats
 */
const AnalysisPanel = (() => {
  let _last = null;

  function update(data) {
    _last = data;
    _updateHeader(data);
    _updateEmaStructure(data);
    _updateZoneLevels(data);
    _updateMarketStats(data);
    _updateTrendMeter(data);
    _updateFooter(data);
  }

  function _updateHeader(d) {
    const sym = document.getElementById('csSymbol');
    const price = document.getElementById('csPrice');
    const change = document.getElementById('csChange');
    if (sym) sym.textContent = d.symbol;
    if (price) price.textContent = d.price?.toFixed(2) || '—';
    if (change) {
      const pct = d.change_pct ?? (d.price && d.change ? (d.change / (d.price - d.change)) * 100 : 0);
      change.textContent = (d.change >= 0 ? '+' : '') + d.change?.toFixed(2) + ' (' + pct.toFixed(2) + '%)';
      change.className = 'cs-change ' + (d.change >= 0 ? 'up' : 'down');
    }
  }

  function _updateEmaStructure(d) {
    const el = document.getElementById('emaStructure');
    if (!el) return;
    const lines = [
      { name: 'EMA 9',  val: d.ema9,  ref: d.price },
      { name: 'EMA 21', val: d.ema21, ref: d.price },
      { name: 'VWAP',   val: d.vwap,  ref: d.price },
    ];
    el.innerHTML = lines.map(l => {
      if (!l.val) return '';
      const rel   = l.ref > l.val ? 'above' : 'below';
      const dist  = Math.abs(l.ref - l.val).toFixed(2);
      const pct   = ((Math.abs(l.ref - l.val) / l.val) * 100).toFixed(2);
      return `
        <div class="ema-row">
          <span class="ema-name">${l.name}</span>
          <span class="ema-val">${l.val.toFixed(2)}</span>
          <span class="ema-rel ${rel}">${rel === 'above' ? '▲' : '▼'} ${dist} (${pct}%)</span>
        </div>
      `;
    }).join('');
  }

  function _updateZoneLevels(d) {
    const el = document.getElementById('zoneLevels');
    if (!el || !d.price) return;
    const p = d.price;
    // Generate pivot levels (simple pivot point calculation)
    const h = d.high || p * 1.005;
    const l = d.low  || p * 0.995;
    const pivot = (h + l + p) / 3;
    const r1 = 2 * pivot - l;
    const r2 = pivot + (h - l);
    const s1 = 2 * pivot - h;
    const s2 = pivot - (h - l);

    const levels = [
      { name: 'R2', price: r2, type: 'res' },
      { name: 'R1', price: r1, type: 'res' },
      { name: 'PP', price: pivot, type: 'pivot' },
      { name: 'S1', price: s1, type: 'sup' },
      { name: 'S2', price: s2, type: 'sup' },
    ].filter(l => l.price > 0);

    el.innerHTML = levels.map(lv => {
      const dist = (((lv.price - p) / p) * 100).toFixed(2);
      const sign = lv.price > p ? '+' : '';
      return `
        <div class="zone-row" onclick="ChartEngine.setPriceLine('${lv.name}', ${lv.price.toFixed(2)}, '${lv.type === 'res' ? '#ef5350' : lv.type === 'sup' ? '#26a69a' : '#f5a623'}', '${lv.name}')">
          <span class="zone-name ${lv.type}">${lv.name}</span>
          <span class="zone-price">${lv.price.toFixed(2)}</span>
          <span class="zone-dist">${sign}${dist}%</span>
        </div>
      `;
    }).join('');
  }

  function _updateMarketStats(d) {
    const el = document.getElementById('marketStats');
    if (!el) return;
    const stats = [
      { name: 'RSI 14',  val: d.rsi?.toFixed(1) || '—',     color: d.rsi > 70 ? '#ef5350' : d.rsi < 30 ? '#26a69a' : '' },
      { name: 'Volume',  val: _fmtVol(d.volume),              color: '' },
      { name: 'High',    val: d.high?.toFixed(2) || '—',      color: '#26a69a' },
      { name: 'Low',     val: d.low?.toFixed(2) || '—',       color: '#ef5350' },
    ];
    el.innerHTML = stats.map(s => `
      <div class="stat-cell">
        <div class="stat-name">${s.name}</div>
        <div class="stat-val" style="${s.color ? 'color:' + s.color : ''}">${s.val}</div>
      </div>
    `).join('');
  }

  function _updateTrendMeter(d) {
    const fill = document.getElementById('trendFill');
    if (!fill) return;
    // Bias: ema9 > ema21 > vwap = 100% bull; opposite = 0%
    let score = 50;
    if (d.ema9 && d.ema21 && d.price) {
      let signals = 0;
      if (d.price > d.ema9)   signals++;
      if (d.price > d.ema21)  signals++;
      if (d.ema9  > d.ema21)  signals++;
      if (d.price > d.vwap)   signals++;
      score = (signals / 4) * 100;
    }
    fill.style.width = score + '%';
  }

  function _updateFooter(d) {
    const el = document.getElementById('footerStats');
    if (!el || !d) return;
    el.innerHTML = `
      <div class="footer-stat"><span>${d.symbol}</span><span>${AppState.activeTf}</span></div>
      <div class="footer-stat"><span>RSI:</span><span>${d.rsi?.toFixed(1) || '—'}</span></div>
      <div class="footer-stat"><span>EMA9:</span><span>${d.ema9?.toFixed(2) || '—'}</span></div>
      <div class="footer-stat"><span>VWAP:</span><span>${d.vwap?.toFixed(2) || '—'}</span></div>
    `;
  }

  function _fmtVol(v) {
    if (!v) return '—';
    if (v >= 1e7) return (v / 1e7).toFixed(1) + 'Cr';
    if (v >= 1e5) return (v / 1e5).toFixed(1) + 'L';
    return v.toLocaleString('en-IN');
  }

  return { update };
})();