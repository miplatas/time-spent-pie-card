/**
 * time-spent-pie-card.js  — v2.1
 * HACS Lovelace Custom Card — Time Spent Pie Chart
 * Autor: miplatas / FIME-UANL
 * Licencia: MIT
 *
 * CAMBIOS v2.1:
 *  - Eliminado minimal_response en la llamada a history/period para recuperar
 *    atributos completos (speed) del historial de person.*.
 *  - Estrategia de velocidad en dos pasos:
 *      1. Leer speed desde los atributos del historial de person.* (si existen).
 *      2. Si no existen, buscar el device_tracker fuente (source_entity_id o
 *         primary_source) y consultarle SU historial para obtener speed por
 *         interpolación de timestamps.
 *  - Función extractSpeed() que prueba múltiples rutas de atributo:
 *      attributes.speed | attributes.Speed | attributes.velocity |
 *      attributes.gps_speed | attributes.km_h | attributes.mph
 *  - Debug opcional: agregar debug: true en la config YAML para ver en consola
 *    los atributos crudos de cada estado.
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
const DRIVING_COLOR = "#FF6B6B";   // rojo-naranja para mejor distinción visual
const UNKNOWN_COLOR = "#78909C";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getRangeStart(timeRange) {
  const now = new Date();
  if (timeRange === "daily")
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const day = now.getDay();
  const diff = (day === 0) ? -6 : 1 - day;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff, 0, 0, 0);
}

function msToHours(ms) { return ms / 3_600_000; }

/**
 * Extrae la velocidad de un objeto de estado del historial.
 * Prueba múltiples rutas de atributo usadas por distintos trackers.
 */
function extractSpeed(stateObj) {
  // Respuesta completa (sin minimal_response): atributos en .attributes
  const a = stateObj.attributes || stateObj.a || {};
  const candidates = [
    a.speed, a.Speed, a.velocity, a.gps_speed,
    a.km_h, a.mph, a.speed_kmh, a.speed_mph,
  ];
  for (const v of candidates) {
    if (typeof v === "number" && !isNaN(v)) return v;
    if (typeof v === "string" && v !== "" && !isNaN(Number(v))) return Number(v);
  }
  return 0;
}

/**
 * Dado un timestamp (ms), busca en una lista de estados ordenados
 * el estado vigente en ese momento (búsqueda binaria).
 */
function findStateAt(sortedHistory, tsMs) {
  let lo = 0, hi = sortedHistory.length - 1, result = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = new Date(sortedHistory[mid].last_changed ||
                       sortedHistory[mid].lu * 1000).getTime();
    if (t <= tsMs) { result = sortedHistory[mid]; lo = mid + 1; }
    else            { hi = mid - 1; }
  }
  return result;
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
    this._hass         = null;
    this._chartInstance= null;
    this._lastFetch    = 0;
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
        :host { display:block; box-sizing:border-box; }
        .card-root {
          display:flex; flex-direction:column;
          background:var(--ha-card-background,var(--card-background-color,#fff));
          border-radius:var(--ha-card-border-radius,12px);
          box-shadow:var(--ha-card-box-shadow,0 2px 8px rgba(0,0,0,.15));
          padding:16px; gap:12px; min-width:0; overflow:hidden;
        }
        .card-title {
          font-size:1rem; font-weight:600;
          color:var(--primary-text-color);
          text-align:center; margin:0; line-height:1.3;
        }
        .card-subtitle {
          font-size:.75rem; color:var(--secondary-text-color);
          text-align:center; margin:-8px 0 0;
        }
        .stats-grid {
          display:flex; flex-wrap:wrap; gap:8px; justify-content:center;
        }
        .stat-chip {
          display:flex; flex-direction:column; align-items:center;
          background:var(--secondary-background-color,rgba(0,0,0,.04));
          border-radius:10px; padding:8px 12px;
          min-width:72px; flex:1 1 72px; max-width:120px;
        }
        .stat-value {
          font-size:1.35rem; font-weight:700;
          color:var(--primary-text-color); line-height:1.1; white-space:nowrap;
        }
        .stat-label {
          font-size:.68rem; color:var(--secondary-text-color);
          text-align:center; margin-top:3px; text-transform:uppercase;
          letter-spacing:.04em; white-space:nowrap;
          overflow:hidden; text-overflow:ellipsis; max-width:100%;
        }
        .stat-dot {
          width:8px; height:8px; border-radius:50%; margin-bottom:4px;
        }
        .chart-wrapper {
          position:relative; width:100%; max-width:220px;
          margin:0 auto; aspect-ratio:1;
        }
        .chart-wrapper canvas { width:100%!important; height:100%!important; }
        .center-label {
          position:absolute; inset:0; display:flex; flex-direction:column;
          align-items:center; justify-content:center; pointer-events:none;
        }
        .center-total {
          font-size:1.4rem; font-weight:700;
          color:var(--primary-text-color); line-height:1;
        }
        .center-unit {
          font-size:.7rem; color:var(--secondary-text-color);
          text-transform:uppercase; letter-spacing:.05em;
        }
        .loading-msg, .error-msg {
          text-align:center; color:var(--secondary-text-color);
          font-size:.85rem; padding:20px 0;
        }
        .error-msg { color:var(--error-color,#e53935); }
        .debug-box {
          font-size:.65rem; color:var(--secondary-text-color);
          background:rgba(0,0,0,.08); border-radius:6px;
          padding:6px 8px; white-space:pre-wrap; word-break:break-all;
          max-height:120px; overflow-y:auto; display:none;
        }
      </style>
      <div class="card-root">
        <p class="card-title" id="title">Cargando…</p>
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

  // ── Fetch principal ──────────────────────────────────────────────────────────
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

      // ── 1. Historial de person.* CON atributos completos ──────────────────
      //    IMPORTANTE: sin minimal_response para obtener speed si person lo propaga
      const personHistory = await hass.callApi(
        "GET",
        `history/period/${isoStart}?filter_entity_id=${entity}&end_time=${isoEnd}`
      );
      const personList = personHistory?.[0] ?? [];

      // ── 2. Buscar el device_tracker fuente para obtener speed ─────────────
      //    person.* guarda en source_entity_id o principal_source el tracker GPS
      const sourceId = entityState?.attributes?.source ||
                       entityState?.attributes?.source_entity_id ||
                       entityState?.attributes?.primary_source ||
                       null;

      let trackerHistory = [];
      if (sourceId) {
        try {
          const th = await hass.callApi(
            "GET",
            `history/period/${isoStart}?filter_entity_id=${sourceId}&end_time=${isoEnd}`
          );
          trackerHistory = th?.[0] ?? [];
        } catch (_) { /* si falla, seguimos sin velocidad del tracker */ }
      }

      if (debug) {
        const sample = personList.slice(0, 3).map(s => ({
          state: s.s ?? s.state,
          attrs: s.attributes ?? s.a ?? {},
        }));
        const dbBox = this.shadowRoot.getElementById("debugBox");
        dbBox.style.display = "";
        dbBox.textContent =
          `sourceId: ${sourceId}\n` +
          `person states: ${personList.length} | tracker states: ${trackerHistory.length}\n` +
          `Sample (3):\n${JSON.stringify(sample, null, 2)}`;
      }

      const segments = this._processHistory(
        personList, trackerHistory, hass, speed_threshold
      );

      await this._renderChart(segments);
      this._renderStats(segments);
      this._hideMessages();
    } catch (err) {
      console.error("[time-spent-pie-card]", err);
      this._showError(`Error: ${err.message}`);
    }
  }

  // ── Procesamiento del historial ──────────────────────────────────────────────
  _processHistory(personList, trackerList, hass, speedThreshold) {
    const acc = {};

    const classify = (stateObj, tsMs) => {
      // Prioridad 1: speed en los atributos del propio estado de person.*
      let speed = extractSpeed(stateObj);

      // Prioridad 2: buscar en el historial del tracker fuente por timestamp
      if (speed === 0 && trackerList.length > 0) {
        const trackerState = findStateAt(trackerList, tsMs);
        if (trackerState) speed = extractSpeed(trackerState);
      }

      if (speed >= speedThreshold) return { label: "Manejando", color: DRIVING_COLOR };

      const s = stateObj.s ?? stateObj.state ?? "unknown";
      if (s === "home")                          return { label: "En casa",     color: HOME_COLOR    };
      if (s === "unknown" || s === "unavailable") return { label: "Desconocido", color: UNKNOWN_COLOR };
      return { label: getZoneName(hass, s), color: null };
    };

    const addDelta = (stateObj, deltaH, tsMs) => {
      if (deltaH <= 0) return;
      const { label, color } = classify(stateObj, tsMs);
      if (!acc[label]) acc[label] = { hours: 0, color };
      acc[label].hours += deltaH;
    };

    for (let i = 0; i < personList.length; i++) {
      const cur      = personList[i];
      const next     = personList[i + 1];
      const curTs    = new Date(cur.last_changed  ?? cur.lu  * 1000).getTime();
      const nextTs   = next
        ? new Date(next.last_changed ?? next.lu * 1000).getTime()
        : Date.now();
      addDelta(cur, msToHours(nextTs - curTs), curTs);
    }

    // Colores para zonas sin color fijo
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

  // ── Render chart ─────────────────────────────────────────────────────────────
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
        type: "doughnut",
        data,
        options: {
          cutout: "60%",
          animation: { duration: 500 },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: ctx => {
                  const h   = ctx.parsed;
                  const pct = totalH > 0 ? ((h / totalH) * 100).toFixed(1) : 0;
                  return ` ${h.toFixed(1)} h  (${pct}%)`;
                },
              },
            },
          },
        },
      });
    }
    this.shadowRoot.getElementById("chartWrapper").style.display = "";
  }

  // ── Render stats chips ────────────────────────────────────────────────────────
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
    el.style.display = "";
    el.textContent   = msg;
  }

  static getConfigElement() {
    return document.createElement("time-spent-pie-card-editor");
  }
  static getStubConfig() {
    return { entity: "person.usuario1", time_range: "daily", speed_threshold: 15 };
  }
  getCardSize() { return 4; }
}

// ─── Editor ───────────────────────────────────────────────────────────────────
class TimeSpentPieCardEditor extends HTMLElement {
  setConfig(config) { this._config = config; }
  set hass(h)       { this._hass = h; }

  connectedCallback() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        .form{display:flex;flex-direction:column;gap:12px;padding:8px}
        label{font-size:.85rem;color:var(--primary-text-color)}
        input,select{
          width:100%;padding:6px 8px;border-radius:6px;
          border:1px solid var(--divider-color,#ccc);
          background:var(--card-background-color,#fff);
          color:var(--primary-text-color);font-size:.9rem;box-sizing:border-box;
        }
      </style>
      <div class="form">
        <label>Entidad (person.*)<br>
          <input id="entity" value="${this._config?.entity ?? ""}">
        </label>
        <label>Nombre (opcional)<br>
          <input id="name" value="${this._config?.name ?? ""}">
        </label>
        <label>Rango de tiempo<br>
          <select id="time_range">
            <option value="daily"  ${this._config?.time_range==="daily" ?"selected":""}>Diario</option>
            <option value="weekly" ${this._config?.time_range==="weekly"?"selected":""}>Semanal</option>
          </select>
        </label>
        <label>Umbral velocidad (km/h)<br>
          <input id="speed_threshold" type="number" value="${this._config?.speed_threshold ?? 15}">
        </label>
        <label style="flex-direction:row;gap:8px;align-items:center">
          <input id="debug" type="checkbox" style="width:auto" ${this._config?.debug?"checked":""}>
          Modo debug (muestra atributos crudos)
        </label>
      </div>`;
    for (const id of ["entity","name","time_range","speed_threshold","debug"])
      this.shadowRoot.getElementById(id).addEventListener("change", () => this._fire());
  }

  _fire() {
    const sr = this.shadowRoot;
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
