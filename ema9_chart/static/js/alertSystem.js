/**
 * watchlist.js — stub (merged into signalRenderer.js)
 * alertSystem.js — alert management
 */

const AlertSystem = (() => {
  let alerts = [];
  let nextId  = 1;

  function init() {
    document.getElementById('addAlertBtn')?.addEventListener('click', _addFromForm);
    _render();
  }

  function _addFromForm() {
    const sym   = document.getElementById('alertSymbol')?.value;
    const cond  = document.getElementById('alertCondition')?.value;
    const price = parseFloat(document.getElementById('alertPrice')?.value);
    if (!sym || !cond) return;
    addAlert({ symbol: sym, condition: cond, price: isNaN(price) ? null : price });
    document.getElementById('alertPrice').value = '';
  }

  function addAlert(cfg) {
    const a = { id: nextId++, ...cfg, triggered: false, createdAt: Date.now() };
    alerts.push(a);
    _render();
    // Update badge
    const badge = document.getElementById('alertBadge');
    if (badge) badge.textContent = alerts.filter(x => !x.triggered).length;
  }

  function removeAlert(id) {
    alerts = alerts.filter(a => a.id !== id);
    _render();
  }

  function checkAlerts(tick) {
    alerts.filter(a => !a.triggered && a.symbol === tick.symbol).forEach(a => {
      let triggered = false;
      if (a.condition === 'cross_above' && a.price && tick.price >= a.price) triggered = true;
      if (a.condition === 'cross_below' && a.price && tick.price <= a.price) triggered = true;
      if (triggered) {
        a.triggered = true;
        SignalRenderer.showToast({
          symbol: a.symbol,
          signal_type: 'ZONE',
          message: `Alert: ${a.condition} ${a.price}`,
          price: tick.price,
          time: Date.now(),
        });
        _render();
      }
    });
  }

  function _render() {
    const el = document.getElementById('alertsList');
    if (!el) return;
    if (!alerts.length) {
      el.innerHTML = '<div style="color:var(--text-dim);font-size:11px;text-align:center;padding:20px">No alerts set</div>';
      return;
    }
    el.innerHTML = alerts.map(a => `
      <div class="alert-row ${a.triggered ? 'opacity-40' : ''}">
        <span class="alert-sym">${a.symbol}</span>
        <span class="alert-cond">${_condLabel(a.condition)}</span>
        <span class="alert-price">${a.price ?? '—'}</span>
        <button class="alert-del" onclick="AlertSystem.removeAlert(${a.id})">✕</button>
      </div>
    `).join('');
  }

  function _condLabel(c) {
    return { cross_above: '↑ Above', cross_below: '↓ Below', ema_touch: '~ EMA touch', zone_enter: '◆ Zone' }[c] || c;
  }

  return { init, addAlert, removeAlert, checkAlerts };
})();