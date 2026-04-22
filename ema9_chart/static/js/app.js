/**
 * app.js  v5
 * Wires all components. Chart data comes exclusively from WebSocket.
 * No JSON file dependency. Any symbol can be searched and charted on demand.
 */

const App = (() => {

  // ── Init ───────────────────────────────────────────────────────────────────
  function init() {
    _buildTimeframePicker();
    ChartEngine.init();
    AlertSystem.init();
    _bindIndicatorToggles();
    _bindTabSwitcher();
    _bindSymbolSearch();

    // Wire WS events BEFORE connecting
    WS.on('connected',       _onConnected);
    WS.on('symbols',         _onSymbolList);
    WS.on('search_results',  _onSearchResults);
    WS.on('snapshot',        _onSnapshot);
    WS.on('candle',          _onCandle);
    WS.on('tick',            _onTick);
    WS.on('signal',          _onSignal);
    WS.on('ema',             _onEma);

    WS.connect();
  }

  // ── WS: connected ─────────────────────────────────────────────────────────
  function _onConnected() {
    // Load watchlist symbols first, then request first symbol chart
    const wl = DataStore.getWatchlist();
    if (wl.length) {
      // Subscribe to all watchlist symbols for tick updates
      WS.subscribe(wl.map(w => w.symbol), AppState.activeTf);
      // Load the active symbol's chart
      _requestChart(AppState.activeSymbol, AppState.activeTf);
    }
    WatchlistComponent.render();
  }

  // ── WS: symbol list from server ───────────────────────────────────────────
  function _onSymbolList(d) {
    if (d.symbols && d.symbols.length) {
      AppState.allSymbols = d.symbols;
    }
  }

  // ── WS: search results ─────────────────────────────────────────────────────
  function _onSearchResults(d) {
    _renderSearchDropdown(d.symbols || []);
  }

  // ── WS: snapshot received → render chart ───────────────────────────────────
  function _onSnapshot(d) {
    // Always render if this is for the currently active symbol
    if (d.symbol !== AppState.activeSymbol) return;

    const tf = d.tf || AppState.activeTf;

    if (!d.candles || d.candles.length === 0) {
      _showChartMessage(`No data for ${d.symbol}${d.error ? ': ' + d.error : ''}`);
      return;
    }

    _hideChartMessage();

    // chartEngine reads from DataStore — data was already stored by wsManager
    ChartEngine.loadSymbol(d.symbol, tf);

    // Overlay EMA9 high/low from Fyers if provided (different from EMA9/21 on close)
    if (d.ema9_high && d.ema9_high.length) {
      ChartEngine.setEma9Lines(d.ema9_high, d.ema9_low || []);
    }

    // Draw wave markers if present
    if (d.markers && d.markers.length) {
      ChartEngine.setRawMarkers(d.markers);
    }

    _updateTrend(d.symbol, tf);

    SignalRenderer.renderLog();
  }

  // ── WS: live candle close ──────────────────────────────────────────────────
  function _onCandle(d) {
    if (d.symbol === AppState.activeSymbol) {
      ChartEngine.updateTick(d.symbol, {
        time: d.time, open: d.o, high: d.h, low: d.l, close: d.c, volume: d.v
      });

      if (d.symbol === AppState.activeSymbol) {
        _updateTrend(d.symbol, AppState.activeTf);
      }
    }
    WatchlistComponent.render();
  }

  // ── WS: live tick ──────────────────────────────────────────────────────────
  function _onTick(d) {
    AlertSystem.checkAlerts(d);
    if (d.symbol === AppState.activeSymbol) {
      const price  = document.getElementById('csPrice');
      const change = document.getElementById('csChange');
      if (price)  price.textContent = (d.price || 0).toFixed(2);
      if (change && d.change != null) {
        const pct = (d.change_pct || 0).toFixed(2);
        change.textContent = (d.change >= 0 ? '+' : '') + d.change.toFixed(2) + ' (' + pct + '%)';
        change.className   = 'cs-change ' + (d.change >= 0 ? 'up' : 'down');
      }
    }
    WatchlistComponent.render();
  }

  // ── WS: signal ─────────────────────────────────────────────────────────────
  function _onSignal(d) {
    SignalRenderer.renderLog();
    SignalRenderer.showToast(d);
    if (d.symbol === AppState.activeSymbol) {
      ChartEngine.addSingleMarker(d);
    }
  }

  // ── WS: EMA update ─────────────────────────────────────────────────────────
  function _onEma(d) {
    if (d.symbol !== AppState.activeSymbol) return;
    const tf  = d.tf || AppState.activeTf;
    const now = d.time || Math.floor(Date.now() / 1000);
    ChartEngine.updateEmaLines(d.symbol, tf, d.ema9, d.ema21, d.vwap, now);
    const bars = DataStore.getCandles(d.symbol, tf);
    const last = bars[bars.length - 1];
    if (last) {
      AnalysisPanel.update({
        symbol: d.symbol, tf,
        price:  last.close,
        change: last.close - (bars[bars.length - 2]?.close || last.close),
        ema9: d.ema9, ema21: d.ema21, vwap: d.vwap,
      });
    }
  }

  // ── Update trend badge ─────────────────────────────────────────────────────
  function _updateTrend(symbol, tf) {
    const badge = document.getElementById('trendBadge');
    if (!badge) return;
    const t = DataStore.detectTrend(symbol, tf);
    badge.textContent = `${t.emoji} ${t.label}`;
    badge.className   = 'trend-badge trend-' + t.trend.toLowerCase();
  }

  // ── Request chart for a symbol ─────────────────────────────────────────────
  function _requestChart(symbol, tf) {
    // Show loading state immediately
    document.getElementById('csSymbol').textContent = symbol;
    document.getElementById('csPrice').textContent  = '…';
    document.getElementById('csChange').textContent = '';
    document.getElementById('chartOHLC').innerHTML  = '';
    _showChartMessage('Loading ' + symbol + '…');

    // Ask server for candle history
    WS.requestSnapshot(symbol, tf);
  }

  // ── Public: switch symbol (called from watchlist clicks, search, tabs) ─────
  function switchSymbol(symbol) {
    if (!symbol) return;
    const prev = AppState.activeSymbol;
    AppState.activeSymbol = symbol;

    // Subscribe to new symbol if not already
    WS.subscribe([symbol], AppState.activeTf);

    // Update watchlist + tabs highlight
    WatchlistComponent.render();
    _updateSymbolTabs();

    // Request candle data
    _requestChart(symbol, AppState.activeTf);
  }

  // ── Public: switch timeframe ───────────────────────────────────────────────
  function switchTf(tf) {
    AppState.activeTf = tf;
    document.querySelectorAll('.tf-btn').forEach(b =>
      b.classList.toggle('active', b.textContent.trim() === tf)
    );
    _requestChart(AppState.activeSymbol, tf);
  }

  // ── Timeframe picker ───────────────────────────────────────────────────────
  function _buildTimeframePicker() {
    const el = document.getElementById('tfGroup');
    if (!el) return;
    el.innerHTML = AppState.timeframes.map(tf =>
      `<button class="tf-btn ${tf === AppState.activeTf ? 'active' : ''}"
               onclick="App.switchTf('${tf}')">${tf}</button>`
    ).join('');
  }

  // ── Symbol search (queries server via WS) ──────────────────────────────────
  let _searchDebounce = null;
  let _searchDropdownEl = null;

  function _bindSymbolSearch() {
    const input = document.getElementById('symbolInput');
    if (!input) return;

    // Create dropdown
    _searchDropdownEl = document.createElement('div');
    _searchDropdownEl.className = 'symbol-search-dropdown';
    _searchDropdownEl.style.cssText = `
      position:absolute; top:100%; left:0; right:0; z-index:9999;
      background:var(--bg-card); border:1px solid var(--border-bright);
      border-radius:0 0 6px 6px; max-height:320px; overflow-y:auto;
      box-shadow:0 8px 24px rgba(0,0,0,0.5); display:none;
    `;
    input.parentElement.style.position = 'relative';
    input.parentElement.appendChild(_searchDropdownEl);

    input.addEventListener('input', () => {
      clearTimeout(_searchDebounce);
      const q = input.value.trim();
      if (!q) { _hideSearchDropdown(); return; }
      _searchDebounce = setTimeout(() => {
        // Search via WebSocket (server searches symbol_loader list)
        WS.send({ action: 'search', q: q.toUpperCase() });
      }, 200);
    });

    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') { _hideSearchDropdown(); input.value = ''; }
      if (e.key === 'Enter') {
        const first = _searchDropdownEl.querySelector('.sym-result');
        if (first) first.click();
      }
    });

    // Close on outside click
    document.addEventListener('click', e => {
      if (!e.target.closest('.symbol-search')) _hideSearchDropdown();
    });
  }

  function _renderSearchDropdown(symbols) {
    if (!_searchDropdownEl) return;
    if (!symbols.length) { _hideSearchDropdown(); return; }

    _searchDropdownEl.innerHTML = symbols.map(sym => {
      const clean = sym.replace('NSE:', '').replace('BSE:', '').replace('-EQ', '').replace('-INDEX', '');
      const exch  = sym.startsWith('BSE:') ? 'BSE' : 'NSE';
      return `
        <div class="sym-result" style="
          padding:9px 14px; cursor:pointer; display:flex;
          justify-content:space-between; align-items:center;
          border-bottom:1px solid var(--border-dim); font-family:var(--font-mono);
          font-size:12px; transition:background 0.1s;
        " onmouseover="this.style.background='var(--bg-hover)'"
           onmouseout="this.style.background=''"
           onclick="App._onSearchSelect('${sym}')">
          <span style="font-weight:600;color:var(--text-primary)">${clean}</span>
          <span style="font-size:10px;color:var(--text-dim)">${exch}</span>
        </div>
      `;
    }).join('');
    _searchDropdownEl.style.display = 'block';
  }

  function _onSearchSelect(symbol) {
    _hideSearchDropdown();
    const input = document.getElementById('symbolInput');
    if (input) input.value = '';
    // Add to watchlist if not present
    DataStore.addWatchlistItem(symbol, symbol.replace('NSE:','').replace('-EQ',''), 'NSE');
    switchSymbol(symbol);
  }

  function _hideSearchDropdown() {
    if (_searchDropdownEl) _searchDropdownEl.style.display = 'none';
  }

  // ── Symbol tabs (top nav pills) ────────────────────────────────────────────
  function _updateSymbolTabs() {
    const el = document.getElementById('symbolTabs');
    if (!el) return;
    const items = DataStore.getWatchlist().slice(0, 8); // show max 8 tabs
    el.innerHTML = items.map(w => {
      const tick = DataStore.getTick(w.symbol);
      const dir  = tick.change >= 0 ? 'up' : 'down';
      return `
        <div class="symbol-tab ${w.symbol === AppState.activeSymbol ? 'active' : ''}"
             onclick="App.switchSymbol('${w.symbol}')">
          ${w.symbol.replace('NSE:','').replace('-EQ','').replace('-INDEX','')}
          <span class="tab-price">${tick.price > 0 ? tick.price.toFixed(2) : ''}</span>
          <span class="tab-chg ${dir}">${tick.price > 0 ? (tick.change >= 0 ? '▲' : '▼') + Math.abs(tick.change_pct || 0).toFixed(2) + '%' : ''}</span>
        </div>
      `;
    }).join('');
  }

  // ── Chart message overlay ──────────────────────────────────────────────────
  function _showChartMessage(msg) {
    let el = document.getElementById('chartMessage');
    if (!el) {
      el = document.createElement('div');
      el.id = 'chartMessage';
      el.style.cssText = `
        position:absolute; inset:0; display:flex; flex-direction:column;
        align-items:center; justify-content:center; z-index:10;
        background:var(--chart-bg); gap:12px; pointer-events:none;
      `;
      document.getElementById('mainChart')?.style && 
        (document.getElementById('mainChart').style.position = 'relative');
      document.getElementById('mainChart')?.appendChild(el);
    }
    el.innerHTML = `
      <div style="width:28px;height:28px;border:2px solid var(--border-mid);
                  border-top-color:var(--accent);border-radius:50%;
                  animation:spin 0.7s linear infinite"></div>
      <div style="font-family:var(--font-mono);font-size:11px;color:var(--text-dim)">${msg}</div>
      <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
    `;
    el.style.display = 'flex';
  }

  function _hideChartMessage() {
    const el = document.getElementById('chartMessage');
    if (el) el.style.display = 'none';
  }

  // ── Indicator toggles ──────────────────────────────────────────────────────
  function _bindIndicatorToggles() {
    document.querySelectorAll('.ind-tag').forEach(tag => {
      tag.addEventListener('click', () => {
        tag.classList.toggle('active');
        ChartEngine.toggleIndicator(
          tag.dataset.ind || tag.textContent.trim(),
          tag.classList.contains('active')
        );
      });
    });
  }

  // ── Tab switcher ───────────────────────────────────────────────────────────
  function _bindTabSwitcher() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.tab;
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-' + id)?.classList.add('active');
      });
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  return { init, switchSymbol, switchTf, _onSearchSelect };
})();

document.addEventListener('DOMContentLoaded', App.init);