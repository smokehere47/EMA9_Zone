/**
 * wsManager.js
 * Manages WebSocket connection to backend, replaces all JSON file polling.
 * Dispatches typed events throughout the app.
 */

const WS = (() => {
  let socket = null;
  let reconnectTimer = null;
  let reconnectDelay = 1500;
  let isConnected = false;

  // Message handler registry: type -> [callbacks]
  const handlers = {};

  // ── Connect ──────────────────────────────────────────────
  function connect(url) {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

    // Auto-detect URL if not provided
    const wsUrl = url || _buildWsUrl();
    console.log('[WS] Connecting to', wsUrl);

    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      isConnected = true;
      reconnectDelay = 1500;
      _setConnDot('connected');
      clearTimeout(reconnectTimer);
      console.log('[WS] Connected');
      _dispatch('connected', {});
      // Subscribe to all symbols in watchlist
      const syms = DataStore.getWatchlist().map(w => w.symbol);
      if (syms.length) subscribe(syms);
    };

    socket.onclose = (e) => {
      isConnected = false;
      _setConnDot('disconnected');
      console.warn('[WS] Closed', e.code, e.reason);
      _dispatch('disconnected', {});
      _scheduleReconnect(wsUrl);
    };

    socket.onerror = (e) => {
      console.error('[WS] Error', e);
      _setConnDot('error');
    };

    socket.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        _route(msg);
      } catch (err) {
        console.warn('[WS] Unparse-able message', ev.data);
      }
    };
  }

  // ── Build default URL ─────────────────────────────────────
  function _buildWsUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const host  = location.hostname || 'localhost';
    const port  = location.port || '8080';
    return `${proto}://${host}:${port}/ws`;
  }

  // ── Route incoming message ────────────────────────────────
  function _route(msg) {
    /*  Expected message shapes from backend:
        { type: 'tick',     symbol, price, change, change_pct, volume, time }
        { type: 'candle',   symbol, tf, o, h, l, c, v, time }
        { type: 'signal',   symbol, signal_type, price, ema9, ema21, vwap, zone, time, message }
        { type: 'snapshot', symbol, tf, candles: [...] }
        { type: 'ema',      symbol, tf, ema9, ema21, vwap }
        { type: 'error',    code, message }
    */
    const { type, ...payload } = msg;
    if (!type) return;

    // Update DataStore first
    if (type === 'tick')     DataStore.onTick(payload);
    if (type === 'candle')   DataStore.onCandle(payload);
    if (type === 'signal')   DataStore.onSignal(payload);
    if (type === 'snapshot') DataStore.onSnapshot(payload);
    if (type === 'ema')      DataStore.onEma(payload);

    _dispatch(type, payload);
  }

  // ── Subscribe to symbols ──────────────────────────────────
  function subscribe(symbols, tf) {
    const arr = Array.isArray(symbols) ? symbols : [symbols];
    // Subscribe each symbol (server tracks one active symbol per connection)
    arr.forEach(sym => {
      send({ action: 'subscribe', symbol: sym, tf: tf || AppState.activeTf });
    });
  }

  function unsubscribe(symbols) {
    send({ action: 'unsubscribe', symbols: Array.isArray(symbols) ? symbols : [symbols] });
  }

  function requestSnapshot(symbol, tf) {
    send({ action: 'snapshot', symbol, tf: tf || AppState.activeTf });
  }

  // ── Send ──────────────────────────────────────────────────
  function send(obj) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      console.warn('[WS] send() called but socket not open');
      return;
    }
    socket.send(JSON.stringify(obj));
  }

  // ── Event system ──────────────────────────────────────────
  function on(type, cb) {
    if (!handlers[type]) handlers[type] = [];
    handlers[type].push(cb);
    return () => off(type, cb); // returns cleanup fn
  }

  function off(type, cb) {
    if (!handlers[type]) return;
    handlers[type] = handlers[type].filter(fn => fn !== cb);
  }

  function _dispatch(type, data) {
    (handlers[type] || []).forEach(fn => { try { fn(data); } catch (e) { console.error('[WS handler error]', e); } });
    (handlers['*']   || []).forEach(fn => { try { fn(type, data); } catch (e) { console.error('[WS * handler error]', e); } });
  }

  // ── Reconnect ─────────────────────────────────────────────
  function _scheduleReconnect(url) {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
      console.log('[WS] Reconnecting in', reconnectDelay, 'ms');
      connect(url);
    }, reconnectDelay);
  }

  function _setConnDot(state) {
    const dot = document.getElementById('connDot');
    if (!dot) return;
    dot.className = 'connection-dot';
    if (state === 'connected') dot.classList.add('connected');
    else if (state === 'error') dot.classList.add('error');
    dot.title = state === 'connected' ? 'WebSocket: Connected' : `WebSocket: ${state}`;
  }

  // ── Public API ────────────────────────────────────────────
  return { connect, send, on, off, subscribe, unsubscribe, requestSnapshot, get isConnected() { return isConnected; } };
})();

// Global app state singleton
const AppState = {
  activeSymbol: 'NIFTY50',
  activeTf: '5m',
  symbols: ['NIFTY50', 'BANKNIFTY', 'FINNIFTY'],
  timeframes: ['1m', '3m', '5m', '15m', '30m', '1h', '1d'],
};