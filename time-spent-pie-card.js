/**
 * time-spent-pie-card.js  — v1.0.4
 * HACS Lovelace Custom Card — Time Spent Pie Chart
 * Author: miplatas / FIME-UANL  |  License: MIT
 *
 * CHANGELOG:
 *  - v1.0.0: Initial release.
 *  - v1.0.1: Fixed speed error bug.
 *  - v1.0.2: Fixed speed error bug.
 *  - v1.0.3: Add hysteresis thresholds (set/reset) for speed detection.
 *  - v1.0.4: Improve speed derivation with anti-jitter GPS filters.
 *
 * CHANGES v1.0.4:
 *  - Speed is calculated with Haversine using source device_tracker history
 *    (native HA GPS), because that tracker does not store a "speed" attribute.
 *  - For each [cur → next] interval from person.*, tracker history is scanned
 *    for GPS positions inside that interval and max speed is computed.
 *    Hysteresis thresholds (set/reset) define when state becomes In transit.
 *  - extractSpeed() is kept as a fallback for trackers exposing speed directly.
 *  - debug: true shows sourceId, counters, and sample positions on the card.
 */

// ─── Dynamic Chart.js ─────────────────────────────────────────────────────────
function loadChartJs() {
  return new Promise((resolve, reject) => {
    if (window.Chart) return resolve(window.Chart);
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.2/dist/chart.umd.min.js";
    s.onload  = () => resolve(window.Chart);
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

// ─── Palette ──────────────────────────────────────────────────────────────────
const SEGMENT_COLORS = [
  "#4FC3F7","#81C784","#FFB74D","#F06292",
  "#CE93D8","#80DEEA","#FFCC80","#A5D6A7",
  "#EF9A9A","#90CAF9",
];
const HOME_COLOR    = "#4FC3F7";
const DRIVING_COLOR = "#FF6B6B";
const UNKNOWN_COLOR = "#78909C";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getRangeStart(timeRange) {
  const now = new Date();
  if (timeRange === "daily")
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const day  = now.getDay();
  const diff = (day === 0) ? -6 : 1 - day;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff, 0, 0, 0);
}

function msToHours(ms) { return ms / 3_600_000; }

/** Timestamp in ms for a history state (supports full and minimal format) */
function stateTs(s) {
  if (s.last_changed) return new Date(s.last_changed).getTime();
  if (s.lu)           return s.lu * 1000;
  return 0;
}

/**
 * Haversine — distance in km between two lat/lon points.
 */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R  = 6371;
  const dL = (lat2 - lat1) * Math.PI / 180;
  const dG = (lon2 - lon1) * Math.PI / 180;
  const a  = Math.sin(dL/2)**2 +
             Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dG/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Maximum speed (km/h) found in tracker history
 * within interval [startMs, endMs].
 * Calculates speed between consecutive position pairs.
 * Applies basic anti-jitter filters so thresholds remain realistic.
 */
function maxSpeedInInterval(trackerList, startMs, endMs) {
  const MIN_DT_SECONDS = 15;      // ignore very short intervals (GPS jitter)
  const MIN_DIST_METERS = 15;     // ignore tiny jumps (position noise)
  const MAX_PLAUSIBLE_KMH = 220;  // filter out unrealistic spikes

  // Filter states inside the interval + the state right before start
  // (to get the interval starting position)
  const relevant = [];
  let prev = null;
  for (const s of trackerList) {
    const t = stateTs(s);
    if (t < startMs) { prev = s; continue; }
    if (t > endMs)   break;
    relevant.push(s);
  }
  if (prev) relevant.unshift(prev);   // add context position

  let maxSpeed = 0;
  for (let i = 0; i < relevant.length - 1; i++) {
    const a   = relevant[i];
    const b   = relevant[i + 1];
    const aAt = a.attributes || a.a || {};
    const bAt = b.attributes || b.a || {};
    const lat1 = Number(aAt.latitude),  lon1 = Number(aAt.longitude);
    const lat2 = Number(bAt.latitude),  lon2 = Number(bAt.longitude);
    if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) continue;

    const distKm  = haversineKm(lat1, lon1, lat2, lon2);
    const dtSeconds = (stateTs(b) - stateTs(a)) / 1000;
    if (dtSeconds < MIN_DT_SECONDS) continue;
    if ((distKm * 1000) < MIN_DIST_METERS) continue;

    const dtHours = dtSeconds / 3600;
    if (dtHours <= 0) continue;

    const speedKmh = distKm / dtHours;
    if (speedKmh > MAX_PLAUSIBLE_KMH) continue;
    if (speedKmh > maxSpeed) maxSpeed = speedKmh;
  }
  return maxSpeed;
}

/** Fallback: explicit speed attribute (for trackers that expose it) */
function extractSpeed(stateObj) {
  const a = stateObj.attributes || stateObj.a || {};
  for (const k of ["speed","Speed","velocity","gps_speed","km_h","mph","speed_kmh","speed_mph"]) {
    const v = a[k];
    if (typeof v === "number" && !isNaN(v)) return v;
    if (typeof v === "string" && v !== "" && !isNaN(Number(v))) return Number(v);
  }
  return 0;
}

function getZoneName(hass, stateStr) {
  const z = `zone.${stateStr}`;
  if (hass.states[z]) return hass.states[z].attributes.friendly_name || stateStr;
  if (stateStr === "not_home") return "Away";
  return stateStr.charAt(0).toUpperCase() + stateStr.slice(1);
}

// ─── Web Component ────────────────────────────────────────────────────────────
class TimeSpentPieCard extends HTMLElement {

  setConfig(config) {
    if (!config.entity) throw new Error("'entity' is required.");
    if (!["daily","weekly"].includes(config.time_range))
      throw new Error("'time_range' must be 'daily' or 'weekly'.");
    if (config.chart_type && !["doughnut", "pie"].includes(config.chart_type))
      throw new Error("'chart_type' must be 'doughnut' or 'pie'.");

    const legacySpeedThreshold = config.speed_threshold ?? 15;
    const speedSetThreshold = config.speed_set_threshold ?? legacySpeedThreshold;
    const speedResetThreshold = config.speed_reset_threshold ?? speedSetThreshold;
    if (!Number.isFinite(speedSetThreshold) || !Number.isFinite(speedResetThreshold))
      throw new Error("'speed_set_threshold' and 'speed_reset_threshold' must be numbers.");
    if (speedResetThreshold > speedSetThreshold)
      throw new Error("'speed_reset_threshold' must be less than or equal to 'speed_set_threshold'.");

    this._config = {
      entity:          config.entity,
      name:            config.name || null,
      time_range:      config.time_range,
      speed_set_threshold: speedSetThreshold,
      speed_reset_threshold: speedResetThreshold,
      chart_type:      config.chart_type || "doughnut",
      debug:           config.debug ?? false,
    };
    this._hass          = null;
    this._chartInstance = null;
    this._lastFetch     = 0;
    this._buildSkeleton();
  }

  set hass(hass) {
    this._hass = hass;
    const entityState = this._config?.entity ? hass?.states?.[this._config.entity] : null;
    if (entityState) this._updateCurrentInfo(entityState, hass);
    const now = Date.now();
    if (now - this._lastFetch > 60_000) {
      this._lastFetch = now;
      this._fetchAndRender();
    }
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────
  _buildSkeleton() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        :host{display:block;box-sizing:border-box}
        .card-root{
          display:flex;flex-direction:column;
          background:var(--ha-card-background,var(--card-background-color,#fff));
          border-radius:var(--ha-card-border-radius,12px);
          box-shadow:var(--ha-card-box-shadow,0 2px 8px rgba(0,0,0,.15));
          padding:16px;gap:12px;min-width:0;overflow:hidden;
        }
        .card-title{font-size:1rem;font-weight:600;color:var(--primary-text-color);text-align:center;margin:0;line-height:1.3}
        .top-info{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:-4px}
        .top-pill{
          display:flex;align-items:center;gap:6px;
          background:var(--secondary-background-color,rgba(0,0,0,.04));
          border-radius:999px;padding:5px 10px;
        }
        .top-key{font-size:.62rem;color:var(--secondary-text-color);text-transform:uppercase;letter-spacing:.04em}
        .top-val{font-size:.78rem;font-weight:600;color:var(--primary-text-color)}
        .card-subtitle{font-size:.75rem;color:var(--secondary-text-color);text-align:center;margin:-8px 0 0}
        .stats-grid{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}
        .stat-chip{
          display:flex;flex-direction:column;align-items:center;
          background:var(--secondary-background-color,rgba(0,0,0,.04));
          border-radius:10px;padding:8px 12px;
          min-width:72px;flex:1 1 72px;max-width:120px;
        }
        .stat-value{font-size:1.35rem;font-weight:700;color:var(--primary-text-color);line-height:1.1;white-space:nowrap}
        .stat-label{font-size:.68rem;color:var(--secondary-text-color);text-align:center;margin-top:3px;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
        .stat-dot{width:8px;height:8px;border-radius:50%;margin-bottom:4px}
        .chart-wrapper{position:relative;width:100%;max-width:220px;margin:0 auto;aspect-ratio:1}
        .chart-wrapper canvas{width:100%!important;height:100%!important}
        .center-label{display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none;margin-top:6px}
        .center-total{font-size:1.4rem;font-weight:700;color:var(--primary-text-color);line-height:1}
        .center-unit{font-size:.7rem;color:var(--secondary-text-color);text-transform:uppercase;letter-spacing:.05em}
        .loading-msg,.error-msg{text-align:center;color:var(--secondary-text-color);font-size:.85rem;padding:20px 0}
        .error-msg{color:var(--error-color,#e53935)}
        .debug-box{font-size:.62rem;color:var(--secondary-text-color);background:rgba(0,0,0,.08);border-radius:6px;padding:6px 8px;white-space:pre-wrap;word-break:break-all;max-height:160px;overflow-y:auto;display:none;margin:0}
      </style>
      <div class="card-root">
        <p class="card-title"  id="title">Loading...</p>
        <div class="top-info">
          <div class="top-pill"><span class="top-key">State</span><span class="top-val" id="currentState">-</span></div>
          <div class="top-pill"><span class="top-key">Speed</span><span class="top-val" id="currentSpeed">-</span></div>
        </div>
        <p class="card-subtitle" id="subtitle"></p>
        <div class="stats-grid" id="stats"></div>
        <div class="chart-wrapper" id="chartWrapper" style="display:none">
          <canvas id="pieCanvas"></canvas>
        </div>
        <div class="center-label">
          <span class="center-total" id="centerTotal">—</span>
          <span class="center-unit">hours</span>
        </div>
        <div class="loading-msg" id="loadingMsg">Fetching history...</div>
        <div class="error-msg"   id="errorMsg"   style="display:none"></div>
        <pre class="debug-box"   id="debugBox"></pre>
      </div>`;
  }

  _getCurrentStateLabel(entityState, hass) {
    const state = entityState?.state;
    if (!state || state === "unknown" || state === "unavailable") return "Unknown";
    if (state === "home") return "Home";
    if (state === "not_home") return "Away";
    return getZoneName(hass, state);
  }

  _getCurrentSpeedLabel(entityState, hass) {
    let speed = extractSpeed(entityState);
    const sourceId = entityState?.attributes?.source ||
                     entityState?.attributes?.source_entity_id || null;
    if (speed <= 0 && sourceId && hass?.states?.[sourceId]) {
      speed = extractSpeed(hass.states[sourceId]);
    }
    if (!Number.isFinite(speed) || speed < 0) return "-";
    return `${speed.toFixed(1)} km/h`;
  }

  _updateCurrentInfo(entityState, hass) {
    const stateEl = this.shadowRoot.getElementById("currentState");
    const speedEl = this.shadowRoot.getElementById("currentSpeed");
    if (!stateEl || !speedEl) return;
    stateEl.textContent = this._getCurrentStateLabel(entityState, hass);
    speedEl.textContent = this._getCurrentSpeedLabel(entityState, hass);
  }

  // ── Fetch ────────────────────────────────────────────────────────────────────
  async _fetchAndRender() {
    if (!this._hass || !this._config) return;
    const { entity, name, time_range, speed_set_threshold, speed_reset_threshold, debug } = this._config;
    const hass = this._hass;

    const entityState = hass.states[entity];
    const title = name || entityState?.attributes?.friendly_name || entity;
    this.shadowRoot.getElementById("title").textContent    = `${title} (Hours)`;
    this.shadowRoot.getElementById("subtitle").textContent =
      time_range === "daily" ? "Today" : "This week";
    this._updateCurrentInfo(entityState, hass);

    try {
      const rangeStart = getRangeStart(time_range);
      const isoStart   = rangeStart.toISOString();
      const isoEnd     = new Date().toISOString();

      // 1. person.* history with full attributes
      const personHistory = await hass.callApi(
        "GET",
        `history/period/${isoStart}?filter_entity_id=${entity}&end_time=${isoEnd}`
      );
      const personList = personHistory?.[0] ?? [];

      // 2. Source device_tracker history (native GPS)
      //    Try all trackers listed in device_trackers, prioritizing source
      const sourceId = entityState?.attributes?.source ||
                       entityState?.attributes?.source_entity_id || null;

      // Also get the full tracker list
      const allTrackers = [
        sourceId,
        ...(entityState?.attributes?.device_trackers || []),
      ].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);  // unique

      let trackerList = [];
      for (const tid of allTrackers) {
        try {
          const th = await hass.callApi(
            "GET",
            `history/period/${isoStart}?filter_entity_id=${tid}&end_time=${isoEnd}`
          );
          const tl = th?.[0] ?? [];
          if (tl.length > trackerList.length) trackerList = tl; // use richest history
        } catch (_) { /* ignore failures */ }
      }

      if (debug) {
        const sample = trackerList.slice(0, 2).map(s => ({
          ts:    new Date(stateTs(s)).toLocaleTimeString(),
          state: s.s ?? s.state,
          lat:   (s.attributes||s.a||{}).latitude,
          lon:   (s.attributes||s.a||{}).longitude,
          speed_attr: extractSpeed(s),
        }));
        const dbBox = this.shadowRoot.getElementById("debugBox");
        dbBox.style.display = "";
        dbBox.textContent =
          `source: ${sourceId}\ntrackers tried: ${allTrackers.join(", ")}\n` +
          `person states: ${personList.length} | tracker states: ${trackerList.length}\n` +
          `tracker sample:\n${JSON.stringify(sample, null, 2)}`;
      }

      const segments = this._processHistory(
        personList, trackerList, hass, speed_set_threshold, speed_reset_threshold
      );

      await this._renderChart(segments);
      this._renderStats(segments);
      this._hideMessages();
    } catch (err) {
      console.error("[time-spent-pie-card]", err);
      this._showError(`Error: ${err.message}`);
    }
  }

  // ── Processing ───────────────────────────────────────────────────────────────
  _processHistory(personList, trackerList, hass, speedSetThreshold, speedResetThreshold) {
    const acc = {};
    let drivingActive = false;

    const classify = (stateObj, startMs, endMs) => {
      // Priority 1: explicit speed attribute on person.* state
      let speed = extractSpeed(stateObj);

      // Priority 2: max Haversine speed from GPS tracker history
      if (speed < speedSetThreshold && trackerList.length > 1) {
        speed = Math.max(speed, maxSpeedInInterval(trackerList, startMs, endMs));
      }

      if (speed >= speedSetThreshold) {
        drivingActive = true;
      } else if (speed <= speedResetThreshold) {
        drivingActive = false;
      }
      if (drivingActive) return { label: "In transit", color: DRIVING_COLOR };

      const s = stateObj.s ?? stateObj.state ?? "unknown";
      if (s === "home")                           return { label: "Home",      color: HOME_COLOR    };
      if (s === "unknown" || s === "unavailable") return { label: "Unknown",  color: UNKNOWN_COLOR };
      return { label: getZoneName(hass, s), color: null };
    };

    for (let i = 0; i < personList.length; i++) {
      const cur    = personList[i];
      const next   = personList[i + 1];
      const startMs = stateTs(cur);
      const endMs   = next ? stateTs(next) : Date.now();
      const deltaH  = msToHours(endMs - startMs);
      if (deltaH <= 0) continue;

      const { label, color } = classify(cur, startMs, endMs);
      if (!acc[label]) acc[label] = { hours: 0, color };
      acc[label].hours += deltaH;
    }

    // Assign colors to custom zones
    let colorIdx = 0;
    const usedColors = new Set([HOME_COLOR, DRIVING_COLOR, UNKNOWN_COLOR]);
    const segments = [];
    for (const [label, data] of Object.entries(acc)) {
      if (data.hours < 0.001) continue;
      let c = data.color;
      if (!c) {
        while (usedColors.has(SEGMENT_COLORS[colorIdx % SEGMENT_COLORS.length])) colorIdx++;
        c = SEGMENT_COLORS[colorIdx % SEGMENT_COLORS.length];
        usedColors.add(c);
        colorIdx++;
      }
      segments.push({ label, hours: data.hours, color: c });
    }
    segments.sort((a, b) => b.hours - a.hours);
    return segments;
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  async _renderChart(segments) {
    const Chart  = await loadChartJs();
    const canvas = this.shadowRoot.getElementById("pieCanvas");
    const chartType = this._config?.chart_type || "doughnut";
    const totalH = segments.reduce((s, x) => s + x.hours, 0);
    this.shadowRoot.getElementById("centerTotal").textContent = totalH.toFixed(1);

    const data = {
      labels:   segments.map(s => s.label),
      datasets: [{
        data:            segments.map(s => +s.hours.toFixed(3)),
        backgroundColor: segments.map(s => s.color),
        borderColor:     "transparent",
        borderWidth:     2,
        hoverOffset:     6,
      }],
    };
    if (this._chartInstance && this._chartType === chartType) {
      this._chartInstance.data = data;
      this._chartInstance.update("none");
    } else {
      if (this._chartInstance) this._chartInstance.destroy();
      this._chartInstance = new Chart(canvas, {
        type: chartType, data,
        options: {
          cutout: chartType === "doughnut" ? "60%" : 0,
          animation: { duration: 500 },
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: {
              label: ctx => {
                const h = ctx.parsed;
                const pct = totalH > 0 ? ((h/totalH)*100).toFixed(1) : 0;
                return ` ${h.toFixed(1)} h  (${pct}%)`;
              },
            }},
          },
        },
      });
      this._chartType = chartType;
    }
    this.shadowRoot.getElementById("chartWrapper").style.display = "";
  }

  _renderStats(segments) {
    const grid = this.shadowRoot.getElementById("stats");
    grid.innerHTML = "";
    for (const { label, hours, color } of segments) {
      const chip = document.createElement("div");
      chip.className = "stat-chip";
      chip.innerHTML = `
        <div class="stat-dot" style="background:${color}"></div>
        <span class="stat-value">${hours.toFixed(1)} h</span>
        <span class="stat-label" title="${label}">${label}</span>`;
      grid.appendChild(chip);
    }
  }

  _hideMessages() {
    this.shadowRoot.getElementById("loadingMsg").style.display = "none";
    this.shadowRoot.getElementById("errorMsg").style.display   = "none";
  }
  _showError(msg) {
    this.shadowRoot.getElementById("loadingMsg").style.display = "none";
    const el = this.shadowRoot.getElementById("errorMsg");
    el.style.display = ""; el.textContent = msg;
  }

  static getConfigElement() { return document.createElement("time-spent-pie-card-editor"); }
  static getStubConfig()    {
    return {
      entity: "person.user1",
      time_range: "daily",
      speed_set_threshold: 15,
      speed_reset_threshold: 10,
      chart_type: "doughnut",
    };
  }
  getCardSize()             { return 4; }
}

// ─── Editor ───────────────────────────────────────────────────────────────────
class TimeSpentPieCardEditor extends HTMLElement {
  setConfig(c) { this._config = c; }
  set hass(h)  { this._hass = h;  }

  connectedCallback() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        .form{display:flex;flex-direction:column;gap:12px;padding:8px}
        label{font-size:.85rem;color:var(--primary-text-color)}
        input,select{width:100%;padding:6px 8px;border-radius:6px;border:1px solid var(--divider-color,#ccc);background:var(--card-background-color,#fff);color:var(--primary-text-color);font-size:.9rem;box-sizing:border-box}
      </style>
      <div class="form">
        <label>Entity (person.*)<br><input id="entity" value="${this._config?.entity??""}"></label>
        <label>Name (optional)<br><input id="name" value="${this._config?.name??""}"></label>
        <label>Time range<br>
          <select id="time_range">
            <option value="daily"  ${this._config?.time_range==="daily" ?"selected":""}>Daily</option>
            <option value="weekly" ${this._config?.time_range==="weekly"?"selected":""}>Weekly</option>
          </select>
        </label>
        <label>Chart type<br>
          <select id="chart_type">
            <option value="doughnut" ${!this._config?.chart_type || this._config?.chart_type==="doughnut" ?"selected":""}>Doughnut</option>
            <option value="pie" ${this._config?.chart_type==="pie"?"selected":""}>Pie</option>
          </select>
        </label>
        <label>Speed set threshold (km/h)<br><input id="speed_set_threshold" type="number" value="${this._config?.speed_set_threshold ?? this._config?.speed_threshold ?? 15}"></label>
        <label>Speed reset threshold (km/h)<br><input id="speed_reset_threshold" type="number" value="${this._config?.speed_reset_threshold ?? this._config?.speed_set_threshold ?? this._config?.speed_threshold ?? 15}"></label>
        <label style="flex-direction:row;gap:8px;align-items:center">
          <input id="debug" type="checkbox" style="width:auto" ${this._config?.debug?"checked":""}>
          Debug mode
        </label>
      </div>`;
    for (const id of ["entity","name","time_range","chart_type","speed_set_threshold","speed_reset_threshold","debug"])
      this.shadowRoot.getElementById(id).addEventListener("change", () => this._fire());
  }
  _fire() {
    const sr  = this.shadowRoot;
    const cfg = {
      entity:          sr.getElementById("entity").value.trim(),
      time_range:      sr.getElementById("time_range").value,
      chart_type:      sr.getElementById("chart_type").value,
      speed_set_threshold: Number(sr.getElementById("speed_set_threshold").value),
      speed_reset_threshold: Number(sr.getElementById("speed_reset_threshold").value),
      debug:           sr.getElementById("debug").checked,
    };
    const n = sr.getElementById("name").value.trim();
    if (n) cfg.name = n;
    this.dispatchEvent(new CustomEvent("config-changed",
      { detail: { config: cfg }, bubbles: true, composed: true }));
  }
}

customElements.define("time-spent-pie-card",        TimeSpentPieCard);
customElements.define("time-spent-pie-card-editor", TimeSpentPieCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type:        "time-spent-pie-card",
  name:        "Time Spent Pie Card",
  description: "Pie chart with accumulated time by location or driving.",
  preview:     true,
  documentationURL: "https://github.com/miplatas/time-spent-pie-card",
});
