# EMA 9 Zone — Interactive Chart Visualizer
## Complete Setup & Usage Guide

---

## FILE STRUCTURE

```
YOUR_PROJECT_ROOT/
│
├── main.py                   ← your existing scanner (unchanged)
├── ema9_zone.py              ← your strategy logic (unchanged)
├── config.py                 ← your config (unchanged)
├── chart_exporter.py         ← NEW — copy here from ema9_chart/
│
└── ema9_chart/               ← NEW — entire chart folder
    ├── server.py             ← Flask web server
    ├── requirements.txt      ← Python dependencies
    ├── data/
    │   └── chart_data.json   ← auto-written by chart_exporter.py
    ├── templates/
    │   └── index.html        ← chart UI page
    └── static/
        ├── css/
        │   └── style.css     ← terminal dark theme
        └── js/
            └── chart.js      ← Lightweight Charts controller
```

---

## STEP 1 — Copy Files Into Your Project

```
YOUR_PROJECT/
├── chart_exporter.py         ← copy from ema9_chart/chart_exporter.py
└── ema9_chart/               ← copy entire folder as-is
```

---

## STEP 2 — Install Python Dependencies

```bash
cd ema9_chart
pip install -r requirements.txt
```

Installs: flask, flask-cors, pytz

---

## STEP 3 — Integrate chart_exporter Into main.py

Open your `main.py` and make **2 small additions**:

### 3a. Add import at the top of main.py

```python
from chart_exporter import export_chart_data
```

### 3b. Add export call inside run_one_day()

Find this block in run_one_day():

```python
    # Sort results by symbol name for consistent output
    results.sort(key=lambda x: x[0])
```

Add ONE line immediately after it:

```python
    results.sort(key=lambda x: x[0])
    export_chart_data(results, _df_cache, target_date)   # ← ADD THIS LINE
```

That's all. Nothing else in main.py changes.

---

## STEP 4 — Run the Scanner

Run your scanner as usual (backtest or live):

```bash
python main.py
```

At the end of the scan you will see:

```
  Chart data exported → /your/path/ema9_chart/data/chart_data.json
  Symbols : 6  |  Total waves : 12
  Run `python ema9_chart/server.py` to open the chart.
```

---

## STEP 5 — Start the Chart Server

Open a **second terminal** (scanner can keep running):

```bash
python ema9_chart/server.py
```

Output:

```
  EMA 9 Zone Chart Server
  ─────────────────────────
  URL     : http://localhost:5050
  Data    : /your/path/ema9_chart/data/chart_data.json

  Open http://localhost:5050 in your browser.
```

The browser opens automatically. If not, go to: http://localhost:5050

---

## CHART FEATURES

| Feature | How |
|---------|-----|
| Switch symbol | Dropdown at top center |
| Zoom in/out | Mouse wheel |
| Pan sideways | Click + drag |
| Zoom price axis | Drag the right price scale |
| Reset zoom | Click ↺ RESET button or press R |
| Jump to wave | Click any wave chip in the top rail |
| Wave detail panel | Click any wave chip → panel slides in |
| Navigate symbols | ← → arrow keys |
| Close wave panel | Press Escape or ✕ button |

---

## CHART ELEMENTS

| Element | Description |
|---------|-------------|
| Green candles | Bullish (close > open) |
| Red candles | Bearish (close < open) |
| Green dashed line | EMA 9 High |
| Red dashed line | EMA 9 Low |
| ● Green circle above bar | Higher High (HH) wave marker |
| ● Red circle below bar | Lower Low (LL) wave marker |
| HH1, LL1, HH2... | Wave number labels on markers |

---

## LIVE MODE USAGE

When running in live mode, chart_data.json updates every scan cycle.
To see fresh data in the browser: simply **refresh the page** or
**reselect the symbol** from the dropdown — it re-fetches live data.

---

## CHANGE PORT

```bash
python ema9_chart/server.py --port 8080
```

---

## TROUBLESHOOTING

**"No data — run scanner first"**
→ chart_data.json is empty. Run main.py first.

**"Cannot connect to server"**
→ Make sure server.py is running in a terminal.

**Symbol shows but no candles**
→ The DataFrame for that symbol wasn't in _df_cache.
  Ensure export_chart_data() is called BEFORE _df_cache.clear().

**Port already in use**
→ `python ema9_chart/server.py --port 8081`
