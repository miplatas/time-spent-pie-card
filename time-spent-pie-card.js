/**
 * time-spent-pie-card.js  — v1.0.14
 * HACS Lovelace Custom Card — Time Spent Pie Chart
 * Author: miplatas / FIME-UANL  |  License: MIT
 *
 * CHANGELOG:
 *  - v1.0.0: Initial release.
 *  - v1.0.1: Fixed speed error bug.
 *  - v1.0.2: Fixed speed error bug.
 *  - v1.0.3: Add hysteresis thresholds (set/reset) for speed detection.
 *  - v1.0.4: Improve speed derivation with anti-jitter GPS filters.
 *  - v1.0.5: Add sustained-movement requirement to reduce false In transit detection.
 *  - v1.0.6: Fix persistent false In transit positives; each interval now evaluated
 *            independently using median speed + minimum distance requirement; remove
 *            shared drivingActive state that caused sticky In transit across intervals;
 *            enforce MAX_DT_SECONDS=300 per GPS pair to suppress stale-ping speed errors.
 *  - v1.0.7: ROOT CAUSE FIX — generic "speed"/"velocity"/"gps_speed" attributes reported
 *            by native GPS device trackers (HA Companion App, OwnTracks, etc.) are in
 *            m/s, per the underlying Android/iOS location APIs. inferSpeedUnit() was
 *            defaulting these (when no unit attribute was present) to km/h, causing
 *            extractSpeed() to under-report real-world speed by ~3.6x (e.g. a real
 *            60 km/h showed as ~16.7 km/h). Now defaults these specific keys to m/s.
 *            Haversine-based position-derived speed (analyzeIntervalMotion) was already
 *            correct and unaffected.
 *  - v1.0.8: Fix the live "State" pill showing "Away" while driving for trackers
 *            (e.g. Life360) that never expose a speed attribute, so extractSpeed()
 *            always returned 0 and the live state never crossed into "In transit".
 *            The card now caches the GPS tracker history fetched once per minute and,
 *            when no usable speed attribute is present, derives a live speed from the
 *            most recent samples (median speed + 200 m moving-distance requirement,
 *            ignored if the tracker hasn't reported in the last 3 minutes).
 *  - v1.0.9: Fix donut history classification to split long `not_home` intervals
 *            into actual moving time (`In transit`) plus remaining `Away` time,
 *            preventing all-day false `In transit` blocks near threshold boundaries
 *            (e.g. 32 vs 33 km/h). Also ensure the visual editor always emits
 *            `type: custom:time-spent-pie-card` in saved config.
 *  - v1.0.10: Update speed set and reset thresholds to 20 and 5 km/h.
 *  - v1.0.11: Add a debug historical state-vs-time graph (fixed to the
 *            selected daily/weekly range) to calibrate Away vs In transit
 *            threshold behavior. Includes colored state bands and timeline
 *            classification based on interval splitting.
 *  - v1.0.12: Added a debug historical state-vs-time graph at the bottom (debug mode), 
 *            Added a dedicated state history bar block below the debug chart.
 *  - v1.0.14: Eliminate(debug mode). 
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

function speedToKmh(value, unit) {
  if (!Number.isFinite(value)) return 0;
  const u = String(unit || "").trim().toLowerCase();

  if (u === "" || u === "km/h" || u === "kmh" || u === "kph") return value;
  if (u === "m/s" || u === "ms" || u === "mps") return value * 3.6;
  if (u === "mph" || u === "mi/h" || u === "mih") return value * 1.609344;
  if (u === "kn" || u === "knot" || u === "knots") return value * 1.852;

  // Unknown unit: preserve current behavior and assume km/h
  return value;
}

function inferSpeedUnit(attrs, key) {
  const candidateUnits = [
    attrs?.[`${key}_unit`],
    attrs?.[`${key}Unit`],
    attrs?.speed_unit,
    attrs?.speedUnit,
    attrs?.speed_uom,
    attrs?.unit_of_measurement,
    attrs?.unit,
  ];

  if (key.includes("mph")) return "mph";
  if (key.includes("kmh") || key.includes("km_h")) return "km/h";
  if (key.includes("mps") || key.includes("m_s") || key.includes("speed_ms")) return "m/s";

  for (const unit of candidateUnits) {
    if (typeof unit === "string" && unit.trim() !== "") return unit;
  }

  // Generic "speed"/"velocity"/"gps_speed" attributes (no explicit unit hint)
  // come almost exclusively from native GPS device trackers (HA Companion App
  // on Android/iOS, OwnTracks, etc.), whose location APIs report speed in m/s.
  // Defaulting these to km/h previously caused a ~3.6x underestimation
  // (e.g. 16.7 m/s real speed showing as 16.7 km/h instead of ~60 km/h).
  if (["speed", "Speed", "velocity", "gps_speed"].includes(key)) return "m/s";

  return "km/h";
}

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
 * Analyse GPS tracker samples that fall strictly within [startMs, endMs].
 * Returns the median speed of qualifying pairs (km/h) and total distance moved
 * above speedThreshold. Using median instead of max avoids GPS spikes.
 *
 * Filters applied per sample pair:
 *  - dt must be between MIN_DT_SECONDS and MAX_DT_SECONDS (avoids stale pings)
 *  - distance must exceed MIN_DIST_METERS        (avoids position noise)
 *  - computed speed must be below MAX_PLAUSIBLE_KMH (avoids satellite jumps)
 */
function analyzeIntervalMotion(trackerList, startMs, endMs, speedThreshold) {
  const MIN_DT_SECONDS     = 10;    // ignore sub-10s pairs (GPS burst noise)
  const MAX_DT_SECONDS     = 300;   // ignore pairs > 5 min apart (stale pings cause huge Δd/Δt errors)
  const MIN_DIST_METERS    = 20;    // ignore tiny position wobble
  const MAX_PLAUSIBLE_KMH  = 180;   // hard cap — no road vehicle goes faster

  // Collect only samples whose timestamp falls within the person-state interval
  const relevant = trackerList.filter(s => {
    const t = stateTs(s);
    return t >= startMs && t <= endMs;
  });

  // Need at least two points to form a pair
  if (relevant.length < 2) {
    return { medianSpeed: 0, movingDistanceKm: 0, movingSeconds: 0, movingWindows: [] };
  }

  const speeds = [];
  let movingDistanceKm = 0;
  let movingSeconds = 0;
  const movingWindows = [];

  for (let i = 0; i < relevant.length - 1; i++) {
    const a   = relevant[i];
    const b   = relevant[i + 1];
    const aAt = a.attributes || a.a || {};
    const bAt = b.attributes || b.a || {};
    const lat1 = Number(aAt.latitude),  lon1 = Number(aAt.longitude);
    const lat2 = Number(bAt.latitude),  lon2 = Number(bAt.longitude);
    if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) continue;

    const distKm    = haversineKm(lat1, lon1, lat2, lon2);
    const dtSeconds = (stateTs(b) - stateTs(a)) / 1000;

    if (dtSeconds < MIN_DT_SECONDS || dtSeconds > MAX_DT_SECONDS) continue;
    if ((distKm * 1000) < MIN_DIST_METERS) continue;

    const speedKmh = distKm / (dtSeconds / 3600);
    if (speedKmh > MAX_PLAUSIBLE_KMH) continue;

    speeds.push(speedKmh);
    if (speedKmh >= speedThreshold) {
      movingDistanceKm += distKm;
      movingSeconds += dtSeconds;
      movingWindows.push({ startMs: stateTs(a), endMs: stateTs(b) });
    }
  }

  if (speeds.length === 0) {
    return { medianSpeed: 0, movingDistanceKm: 0, movingSeconds: 0, movingWindows: [] };
  }

  // Median is far more robust than max against occasional GPS jumps
  speeds.sort((a, b) => a - b);
  const mid = Math.floor(speeds.length / 2);
  const medianSpeed = speeds.length % 2 === 0
    ? (speeds[mid - 1] + speeds[mid]) / 2
    : speeds[mid];

  return { medianSpeed, movingDistanceKm, movingSeconds, movingWindows };
}

/** Fallback: explicit speed attribute (for trackers that expose it) */
function extractSpeed(stateObj) {
  const a = stateObj.attributes || stateObj.a || {};
  for (const k of ["speed","Speed","velocity","gps_speed","km_h","mph","speed_kmh","speed_mph"]) {
    const v = a[k];
    if (typeof v === "number" && !isNaN(v)) {
      return speedToKmh(v, inferSpeedUnit(a, k));
    }
    if (typeof v === "string" && v !== "" && !isNaN(Number(v))) {
      return speedToKmh(Number(v), inferSpeedUnit(a, k));
    }
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

    const legacySpeedThreshold = config.speed_threshold ?? 20;
    const speedSetThreshold = config.speed_set_threshold ?? legacySpeedThreshold;
    const speedResetThreshold = config.speed_reset_threshold ?? Math.min(5, speedSetThreshold);
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
    };
    this._hass          = null;
    this._chartInstance = null;
    this._lastFetch     = 0;
    this._trackerList   = [];
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
      </div>`;
  }

  _getCurrentStateLabel(entityState, hass, currentSpeedKmh) {
    const threshold = this._config?.speed_set_threshold ?? 20;
    if (Number.isFinite(currentSpeedKmh) && currentSpeedKmh >= threshold) return "In transit";

    const state = entityState?.state;
    if (!state || state === "unknown" || state === "unavailable") return "Unknown";
    if (state === "home") return "Home";
    if (state === "not_home") return "Away";
    return getZoneName(hass, state);
  }

  _getCurrentSpeedKmh(entityState, hass) {
    let speed = extractSpeed(entityState);
    const sourceId = entityState?.attributes?.source ||
                     entityState?.attributes?.source_entity_id || null;
    if (speed <= 0 && sourceId && hass?.states?.[sourceId]) {
      speed = extractSpeed(hass.states[sourceId]);
    }

    const speedSetThreshold = this._config?.speed_set_threshold ?? 20;

    // Fallback: many trackers (e.g. Life360) never expose a speed attribute,
    // so the explicit-attribute lookup above always returns 0. Derive a live
    // speed estimate from the most recent cached GPS history samples instead.
    if ((!Number.isFinite(speed) || speed < speedSetThreshold) &&
        Array.isArray(this._trackerList) && this._trackerList.length >= 2) {
      const recent = this._trackerList.slice(-6);
      const lastTs = stateTs(recent[recent.length - 1]);

      // Ignore stale history (tracker hasn't reported in a while -> not moving).
      const STALE_MS = 3 * 60 * 1000;
      if (Date.now() - lastTs <= STALE_MS) {
        const t0 = stateTs(recent[0]);
        const t1 = lastTs;
        const motion = analyzeIntervalMotion(recent, t0 - 1, t1 + 1, speedSetThreshold);
        if (motion.medianSpeed >= speedSetThreshold && motion.movingDistanceKm >= 0.2) {
          speed = motion.medianSpeed;
        }
      }
    }

    return Number.isFinite(speed) && speed >= 0 ? speed : NaN;
  }

  _getCurrentSpeedLabel(currentSpeedKmh) {
    if (!Number.isFinite(currentSpeedKmh) || currentSpeedKmh < 0) return "-";
    return `${currentSpeedKmh.toFixed(1)} km/h`;
  }

  _updateCurrentInfo(entityState, hass) {
    const stateEl = this.shadowRoot.getElementById("currentState");
    const speedEl = this.shadowRoot.getElementById("currentSpeed");
    if (!stateEl || !speedEl) return;
    const speedKmh = this._getCurrentSpeedKmh(entityState, hass);
    stateEl.textContent = this._getCurrentStateLabel(entityState, hass, speedKmh);
    speedEl.textContent = this._getCurrentSpeedLabel(speedKmh);
  }

  // ── Fetch ────────────────────────────────────────────────────────────────────
  async _fetchAndRender() {
    if (!this._hass || !this._config) return;
    const { entity, name, time_range, speed_set_threshold, speed_reset_threshold } = this._config;
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

      // Cache for the live "State"/"Speed" pills, which run on every hass
      // update (not just the once-per-minute history fetch) and need a
      // position-derived speed fallback for trackers without a speed attribute.
      this._trackerList = trackerList;
      this._updateCurrentInfo(entityState, hass);

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

    // Minimum GPS distance that must be covered above the threshold within the
    // interval to count it as In transit (avoids classifying brief/noisy GPS
    // pairs that accidentally exceed the speed threshold).
    const MIN_TRANSIT_DISTANCE_KM = 0.2; // 200 m

    const addHours = (label, color, hours) => {
      if (hours <= 0) return;
      if (!acc[label]) acc[label] = { hours: 0, color };
      acc[label].hours += hours;
    };

    for (let i = 0; i < personList.length; i++) {
      const cur    = personList[i];
      const next   = personList[i + 1];
      const startMs = stateTs(cur);
      const endMs   = next ? stateTs(next) : Date.now();
      const deltaH  = msToHours(endMs - startMs);
      if (deltaH <= 0) continue;

      const s = cur.s ?? cur.state ?? "unknown";

      // Prefer tracker-derived motion to avoid classifying an entire long
      // not_home interval as In transit because of a brief movement burst.
      let motion = null;
      if (trackerList.length >= 2) {
        const m = analyzeIntervalMotion(trackerList, startMs, endMs, speedSetThreshold);
        if (m.medianSpeed >= speedSetThreshold && m.movingDistanceKm >= MIN_TRANSIT_DISTANCE_KM) {
          motion = m;
        }
      }

      if (s === "not_home") {
        // Split not_home time: only moving slices become In transit; remainder stays Away.
        let transitH = 0;
        if (motion) {
          transitH = Math.min(deltaH, msToHours(motion.movingSeconds * 1000));
        }

        // Fallback for setups without tracker history: keep legacy behavior.
        if (!motion) {
          const speed = extractSpeed(cur);
          if (speed >= speedSetThreshold) transitH = deltaH;
        }

        addHours("In transit", DRIVING_COLOR, transitH);
        addHours("Away", null, deltaH - transitH);
        continue;
      }

      if (s === "home") {
        addHours("Home", HOME_COLOR, deltaH);
        continue;
      }

      if (s === "unknown" || s === "unavailable") {
        addHours("Unknown", UNKNOWN_COLOR, deltaH);
        continue;
      }

      addHours(getZoneName(hass, s), null, deltaH);
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
      type: "custom:time-spent-pie-card",
      entity: "person.user1",
      time_range: "daily",
      speed_set_threshold: 20,
      speed_reset_threshold: 5,
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
        <label>Speed set threshold (km/h)<br><input id="speed_set_threshold" type="number" value="${this._config?.speed_set_threshold ?? this._config?.speed_threshold ?? 20}"></label>
        <label>Speed reset threshold (km/h)<br><input id="speed_reset_threshold" type="number" value="${this._config?.speed_reset_threshold ?? this._config?.speed_set_threshold ?? this._config?.speed_threshold ?? 5}"></label>
      </div>`;
    for (const id of ["entity","name","time_range","chart_type","speed_set_threshold","speed_reset_threshold"])
      this.shadowRoot.getElementById(id).addEventListener("change", () => this._fire());
  }
  _fire() {
    const sr  = this.shadowRoot;
    const cfg = {
      type:            this._config?.type || "custom:time-spent-pie-card",
      entity:          sr.getElementById("entity").value.trim(),
      time_range:      sr.getElementById("time_range").value,
      chart_type:      sr.getElementById("chart_type").value,
      speed_set_threshold: Number(sr.getElementById("speed_set_threshold").value),
      speed_reset_threshold: Number(sr.getElementById("speed_reset_threshold").value),
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
