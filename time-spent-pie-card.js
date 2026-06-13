/**
 * time-spent-pie-card.js  — v3.0
 * HACS Lovelace Custom Card — Time Spent Pie Chart
 * Autor: miplatas / FIME-UANL  |  Licencia: MIT
 *
 * CAMBIOS v3.0:
 *  - Velocidad calculada con Haversine sobre el historial del device_tracker
 *    fuente (GPS nativo de HA), ya que ese tracker no guarda atributo "speed".
 *  - Para cada intervalo [cur → next] del person.*, se busca en el historial
 *    del tracker la secuencia de posiciones GPS dentro de ese intervalo y se
 *    calcula la velocidad máxima alcanzada. Si supera speed_threshold → Manejando.
 *  - extractSpeed() se mantiene como fallback para trackers que sí exponen speed.
 *  - debug: true muestra en tarjeta el sourceId, conteos y muestra de posiciones.
 */

// ─── Chart.js dinámico ────────────────────────────────────────────────────────
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

// ─── Paleta ───────────────────────────────────────────────────────────────────
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

/** Timestamp en ms de un estado del historial (soporta formato completo y minimal) */
function stateTs(s) {
  if (s.last_changed) return new Date(s.last_changed).getTime();
  if (s.lu)           return s.lu * 1000;
  return 0;
}

/**
 * Haversine — distancia en km entre dos puntos lat/lon.
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
 * Velocidad máxima (km/h) registrada en el historial del tracker
 * dentro del intervalo [startMs, endMs].
 * Calcula velocidad entre pares de posiciones consecutivos.
 */
function maxSpeedInInterval(trackerList, startMs, endMs) {
  // Filtrar estados dentro del intervalo + el estado previo al inicio (para
  // tener la posición de arranque del intervalo)
  const relevant = [];
  let prev = null;
  for (const s of trackerList) {
    const t = stateTs(s);
    if (t < startMs) { prev = s; continue; }
    if (t > endMs)   break;
    relevant.push(s);
  }
  if (prev) relevant.unshift(prev);   // añadir posición de contexto

  let maxSpeed = 0;
  for (let i = 0; i < relevant.length - 1; i++) {
    const a   = relevant[i];
    const b   = relevant[i + 1];
    const aAt = a.attributes || a.a || {};
    const bAt = b.attributes || b.a || {};
    const lat1 = aAt.latitude,  lon1 = aAt.longitude;
    const lat2 = bAt.latitude,  lon2 = bAt.longitude;
    if (!lat1 || !lat2) continue;

    const distKm  = haversineKm(lat1, lon1, lat2, lon2);
    const dtHours = msToHours(stateTs(b) - stateTs(a));
    if (dtHours <= 0) continue;

    const speedKmh = distKm / dtHours;
    if (speedKmh > maxSpeed) maxSpeed = speedKmh;
  }
  return maxSpeed;
}

/** Fallback: atributo speed explícito (para trackers que lo exponen) */
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
  if (stateStr === "not_home") return "Fuera";
  return stateStr.charAt(0).toUpperCase() + stateStr.slice(1);
}

// ─── Web Component ────────────────────────────────────────────────────────────
class TimeSpentPieCard extends HTMLElement {

  setConfig(config) {
    if (!config.entity) throw new Error("Se requiere 'entity'.");
    if (!["daily","weekly"].includes(config.time_range))
      throw new Error("'time_range' debe ser 'daily' o 'weekly'.");

    this._config = {
      entity:          config.entity,
      name:            config.name || null,
      time_range:      config.time_range,
      speed_threshold: config.speed_threshold ?? 15,
      debug:           config.debug ?? false,
    };
    this._hass          = null;
    this._chartInstance = null;
    this._lastFetch     = 0;
    this._buildSkeleton();
  }

  set hass(hass) {
    this._hass = hass;
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
        .center-label{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none}
        .center-total{font-size:1.4rem;font-weight:700;color:var(--primary-text-color);line-height:1}
        .center-unit{font-size:.7rem;color:var(--secondary-text-color);text-transform:uppercase;letter-spacing:.05em}
        .loading-msg,.error-msg{text-align:center;color:var(--secondary-text-color);font-size:.85rem;padding:20px 0}
        .error-msg{color:var(--error-color,#e53935)}
        .debug-box{font-size:.62rem;color:var(--secondary-text-color);background:rgba(0,0,0,.08);border-radius:6px;padding:6px 8px;white-space:pre-wrap;word-break:break-all;max-height:160px;overflow-y:auto;display:none;margin:0}
      </style>
      <div class="card-root">
        <p class="card-title"  id="title">Cargando…</p>
        <p class="card-subtitle" id="subtitle"></p>
        <div class="stats-grid" id="stats"></div>
        <div class="chart-wrapper" id="chartWrapper" style="display:none">
          <canvas id="pieCanvas"></canvas>
          <div class="center-label">
            <span class="center-total" id="centerTotal">—</span>
            <span class="center-unit">horas</span>
          </div>
        </div>
        <div class="loading-msg" id="loadingMsg">Consultando historial…</div>
        <div class="error-msg"   id="errorMsg"   style="display:none"></div>
        <pre class="debug-box"   id="debugBox"></pre>
      </div>`;
  }

  // ── Fetch ────────────────────────────────────────────────────────────────────
  async _fetchAndRender() {
    if (!this._hass || !this._config) return;
    const { entity, name, time_range, speed_threshold, debug } = this._config;
    const hass = this._hass;

    const entityState = hass.states[entity];
    const title = name || entityState?.attributes?.friendly_name || entity;
    this.shadowRoot.getElementById("title").textContent    = `${title} (Horas)`;
    this.shadowRoot.getElementById("subtitle").textContent =
      time_range === "daily" ? "Hoy" : "Esta semana";

    try {
      const rangeStart = getRangeStart(time_range);
      const isoStart   = rangeStart.toISOString();
      const isoEnd     = new Date().toISOString();

      // 1. Historial de person.* con atributos completos
      const personHistory = await hass.callApi(
        "GET",
        `history/period/${isoStart}?filter_entity_id=${entity}&end_time=${isoEnd}`
      );
      const personList = personHistory?.[0] ?? [];

      // 2. Historial del device_tracker fuente (GPS nativo)
      //    Intentar todos los trackers listados en device_trackers, priorizar source
      const sourceId = entityState?.attributes?.source ||
                       entityState?.attributes?.source_entity_id || null;

      // También obtener lista completa de trackers
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
          if (tl.length > trackerList.length) trackerList = tl; // usar el más rico
        } catch (_) { /* ignorar si falla */ }
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
          `source: ${sourceId}\ntrackers probados: ${allTrackers.join(", ")}\n` +
          `person states: ${personList.length} | tracker states: ${trackerList.length}\n` +
          `tracker sample:\n${JSON.stringify(sample, null, 2)}`;
      }

      const segments = this._processHistory(
        personList, trackerList, hass, speed_threshold
      );

      await this._renderChart(segments);
      this._renderStats(segments);
      this._hideMessages();
    } catch (err) {
      console.error("[time-spent-pie-card]", err);
      this._showError(`Error: ${err.message}`);
    }
  }

  // ── Procesamiento ────────────────────────────────────────────────────────────
  _processHistory(personList, trackerList, hass, speedThreshold) {
    const acc = {};

    const classify = (stateObj, startMs, endMs) => {
      // Prioridad 1: atributo speed explícito en el estado de person.*
      let speed = extractSpeed(stateObj);

      // Prioridad 2: velocidad máxima calculada por Haversine en el tracker GPS
      if (speed < speedThreshold && trackerList.length > 1) {
        speed = Math.max(speed, maxSpeedInInterval(trackerList, startMs, endMs));
      }

      if (speed >= speedThreshold) return { label: "Manejando", color: DRIVING_COLOR };

      const s = stateObj.s ?? stateObj.state ?? "unknown";
      if (s === "home")                           return { label: "En casa",      color: HOME_COLOR    };
      if (s === "unknown" || s === "unavailable") return { label: "Desconocido",  color: UNKNOWN_COLOR };
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

    // Asignar colores a zonas
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
    if (this._chartInstance) {
      this._chartInstance.data = data;
      this._chartInstance.update("none");
    } else {
      this._chartInstance = new Chart(canvas, {
        type: "doughnut", data,
        options: {
          cutout: "60%",
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
  static getStubConfig()    { return { entity: "person.usuario1", time_range: "daily", speed_threshold: 15 }; }
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
        <label>Entidad (person.*)<br><input id="entity" value="${this._config?.entity??""}"></label>
        <label>Nombre (opcional)<br><input id="name" value="${this._config?.name??""}"></label>
        <label>Rango de tiempo<br>
          <select id="time_range">
            <option value="daily"  ${this._config?.time_range==="daily" ?"selected":""}>Diario</option>
            <option value="weekly" ${this._config?.time_range==="weekly"?"selected":""}>Semanal</option>
          </select>
        </label>
        <label>Umbral velocidad (km/h)<br><input id="speed_threshold" type="number" value="${this._config?.speed_threshold??15}"></label>
        <label style="flex-direction:row;gap:8px;align-items:center">
          <input id="debug" type="checkbox" style="width:auto" ${this._config?.debug?"checked":""}>
          Modo debug
        </label>
      </div>`;
    for (const id of ["entity","name","time_range","speed_threshold","debug"])
      this.shadowRoot.getElementById(id).addEventListener("change", () => this._fire());
  }
  _fire() {
    const sr  = this.shadowRoot;
    const cfg = {
      entity:          sr.getElementById("entity").value.trim(),
      time_range:      sr.getElementById("time_range").value,
      speed_threshold: Number(sr.getElementById("speed_threshold").value),
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
  description: "Gráfica de pastel con tiempo acumulado por ubicación o manejo.",
  preview:     true,
  documentationURL: "https://github.com/miplatas/time-spent-pie-card",
});
