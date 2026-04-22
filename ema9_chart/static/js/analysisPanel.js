/**
 * analysisPanel.js
 * (AnalysisPanel object is defined in signalRenderer.js — this file is a placeholder)
 * Positions panel rendering
 */

const PositionsPanel = (() => {
  let positions = [];

  function setPositions(pos) {
    positions = pos;
    render();
  }

  function addPosition(p) {
    positions.push({ id: Date.now(), ...p });
    render();
  }

  function render() {
    const el = document.getElementById('positionsList');
    const sumEl = document.getElementById('pnlSummary');
    if (!el) return;

    if (!positions.length) {
      el.innerHTML = '<div style="color:var(--text-dim);font-size:11px;text-align:center;padding:24px">No open positions</div>';
      if (sumEl) sumEl.innerHTML = '';
      return;
    }

    let totalPnl = 0;
    el.innerHTML = positions.map(p => {
      const tick   = DataStore.getTick(p.symbol);
      const ltp    = tick.price || p.entry;
      const pnl    = (ltp - p.entry) * p.qty * (p.side === 'SHORT' ? -1 : 1);
      const pnlPct = ((pnl / (p.entry * p.qty)) * 100).toFixed(2);
      totalPnl += pnl;
      return `
        <div class="position-card">
          <div class="pos-header">
            <span class="pos-sym">${p.symbol}</span>
            <span class="pos-side ${p.side.toLowerCase()}">${p.side}</span>
          </div>
          <div class="pos-details">
            <span class="pos-entry">Entry: <span>${p.entry?.toFixed(2)}</span></span>
            <span class="pos-entry">LTP: <span>${ltp.toFixed(2)}</span></span>
            <span class="pos-entry">Qty: <span>${p.qty}</span></span>
            <span class="pos-entry">Pct: <span style="color:${pnl >= 0 ? 'var(--bull)' : 'var(--bear)'}">${pnl >= 0 ? '+' : ''}${pnlPct}%</span></span>
          </div>
          <div class="pos-pnl ${pnl >= 0 ? 'profit' : 'loss'}">
            ${pnl >= 0 ? '+' : ''}₹${pnl.toFixed(0)}
          </div>
        </div>
      `;
    }).join('');

    if (sumEl) {
      sumEl.innerHTML = `
        <div class="pnl-title">TOTAL P&L</div>
        <div class="pnl-total ${totalPnl >= 0 ? 'profit' : 'loss'}">${totalPnl >= 0 ? '+' : ''}₹${totalPnl.toFixed(0)}</div>
      `;
    }
  }

  return { setPositions, addPosition, render };
})();