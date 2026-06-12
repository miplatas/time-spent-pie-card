/**
 * time-spent-pie-card.js
 * HACS Lovelace Custom Card — Time Spent Pie Chart
 * Autor: miplatas / FIME-UANL
 * Licencia: MIT
 *
 * Muestra una gráfica de pastel con el tiempo acumulado (en horas)
 * que una persona pasa en diferentes ubicaciones o manejando,
 * usando el historial de Home Assistant.
 */

// ─── Carga dinámica de Chart.js desde CDN si no está disponible ───────────────
function loadChartJs() {
  return new Promise((resolve, reject) => {
    if (window.Chart) return resolve(window.Chart);
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.2/dist/chart.umd.min.js";
    script.onload = () => resolve(window.Chart);
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

// ─── Paleta de colores para los segmentos ─────────────────────────────────────
const SEGMENT_COLORS = [
  "#4FC3F7", // celeste
  "#81C784", // verde
  "#FFB74D", // naranja
  "#F06292", // rosa
  "#CE93D8", // violeta
  "#80DEEA", // cian
  "#FFCC80", // durazno
  "#A5D6A7", // verde claro
  "#EF9A9A", // rojo suave
  "#90CAF9", // azul suave
];

const HOME_COLOR    = "#4FC3F7";
const DRIVING_COLOR = "#FFB74D";
const UNKNOWN_COLOR = "#78909C";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getRangeStart(timeRange) {
  const now = new Date();
  if (timeRange === "daily") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  }
  // weekly: anclar al lunes de la semana actual a las 00:00
  const day = now.getDay(); // 0=domingo … 6=sábado
  const diffToMonday = (day === 0) ? -6 : 1 - day;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMonday, 0, 0, 0);
  return monday;
}

function msToHours(ms) {
  return ms / 3_600_000;
}

// Devuelve el nombre amigable de una zona buscando en hass.states
function getZoneName(hass, stateStr) {
  const zoneEntity = `zone.${stateStr}`;
  if (hass.states[zoneEntity]) {
    return hass.states[zoneEntity].attributes.friendly_name || stateStr;
  }
  if (stateStr === "not_home") return "Fuera";
  return stateStr.charAt(0).toUpperCase() + stateStr.slice(1);
}

// ─── LitElement-like Web Component (sin importar LitElement externamente) ─────
class TimeSpentPieCard extends HTMLElement {
  // ── Ciclo de vida HA ────────────────────────────────────────────────────────
  setConfig(config) {
    if (!config.entity) throw new Error("Se requiere 'entity'.");
    if (!config.time_range || !["daily", "weekly"].includes(config.time_range))
      throw new Error("'time_range' debe ser 'daily' o 'weekly'.");

    this._config = {
      entity: config.entity,
      name: config.name || null,
      time_range: config.time_range,
      speed_threshold: config.speed_threshold ?? 15,
    };
    this._hass = null;
    this._chartInstance = null;
    this._lastFetch = 0;
    this._segments = [];
    this._loading = true;
    this._error = null;

    this._buildSkeleton();
  }

  set hass(hass) {
    this._hass = hass;
    const now = Date.now();
    // Refrescar máximo una vez por minuto
    if (now - this._lastFetch > 60_000) {
      this._lastFetch = now;
      this._fetchAndRender();
    }
  }

  // ── Construcción del DOM ────────────────────────────────────────────────────
  _buildSkeleton() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          box-sizing: border-box;
        }
        ha-card, .card-root {
          display: flex;
          flex-direction: column;
          background: var(--ha-card-background, var(--card-background-color, #fff));
          border-radius: var(--ha-card-border-radius, 12px);
          box-shadow: var(--ha-card-box-shadow, 0 2px 8px rgba(0,0,0,.15));
          padding: 16px;
          gap: 12px;
          min-width: 0;
          overflow: hidden;
        }
        .card-title {
          font-size: 1rem;
          font-weight: 600;
          color: var(--primary-text-color);
          text-align: center;
          margin: 0;
          line-height: 1.3;
        }
        .card-subtitle {
          font-size: 0.75rem;
          color: var(--secondary-text-color);
          text-align: center;
          margin: -8px 0 0;
        }
        .stats-grid {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          justify-content: center;
        }
        .stat-chip {
          display: flex;
          flex-direction: column;
          align-items: center;
          background: var(--secondary-background-color, rgba(0,0,0,.04));
          border-radius: 10px;
          padding: 8px 12px;
          min-width: 72px;
          flex: 1 1 72px;
          max-width: 120px;
        }
        .stat-value {
          font-size: 1.35rem;
          font-weight: 700;
          color: var(--primary-text-color);
          line-height: 1.1;
          white-space: nowrap;
        }
        .stat-label {
          font-size: 0.68rem;
          color: var(--secondary-text-color);
          text-align: center;
          margin-top: 3px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 100%;
        }
        .stat-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          margin-bottom: 4px;
        }
        .chart-wrapper {
          position: relative;
          width: 100%;
          max-width: 220px;
          margin: 0 auto;
          aspect-ratio: 1;
        }
        .chart-wrapper canvas {
          width: 100% !important;
          height: 100% !important;
        }
        .center-label {
          position: absolute;
          inset: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          pointer-events: none;
        }
        .center-total {
          font-size: 1.4rem;
          font-weight: 700;
          color: var(--primary-text-color);
          line-height: 1;
        }
        .center-unit {
          font-size: 0.7rem;
          color: var(--secondary-text-color);
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .loading-msg, .error-msg {
          text-align: center;
          color: var(--secondary-text-color);
          font-size: 0.85rem;
          padding: 20px 0;
        }
        .error-msg { color: var(--error-color, #e53935); }
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
        <div class="error-msg" id="errorMsg" style="display:none"></div>
      </div>`;
  }

  // ── Fetch & procesamiento ───────────────────────────────────────────────────
  async _fetchAndRender() {
    if (!this._hass || !this._config) return;

    const { entity, name, time_range, speed_threshold } = this._config;
    const hass = this._hass;

    // Título
    const entityState = hass.states[entity];
    const title = name || entityState?.attributes?.friendly_name || entity;
    this._setTitle(title, time_range);

    try {
      const rangeStart = getRangeStart(time_range);
      const isoStart   = rangeStart.toISOString();
      const isoEnd     = new Date().toISOString();

      const history = await hass.callApi(
        "GET",
        `history/period/${isoStart}?filter_entity_id=${entity}&end_time=${isoEnd}&minimal_response=true&no_attributes=false`
      );

      const stateList = history?.[0] ?? [];
      const segments  = this._processHistory(stateList, hass, speed_threshold);
      this._segments  = segments;
      await this._renderChart(segments);
      this._renderStats(segments);
      this._hideLoading();
    } catch (err) {
      console.error("[time-spent-pie-card]", err);
      this._showError(`Error al obtener historial: ${err.message}`);
    }
  }

  _setTitle(name, timeRange) {
    const sr = this.shadowRoot;
    sr.getElementById("title").textContent = `${name} (Horas)`;
    sr.getElementById("subtitle").textContent =
      timeRange === "daily" ? "Hoy" : "Esta semana";
  }

  _processHistory(stateList, hass, speedThreshold) {
    const acc = {}; // { label: { hours, color } }

    for (let i = 0; i < stateList.length; i++) {
      const cur  = stateList[i];
      const next = stateList[i + 1];
      if (!next) break; // el último segmento se corta en "ahora" — ver abajo

      const curDate  = new Date(cur.last_changed ?? cur.lu * 1000);
      const nextDate = new Date(next.last_changed ?? next.lu * 1000);
      const deltaH   = msToHours(nextDate - curDate);
      if (deltaH <= 0) continue;

      const speed = cur.a?.speed ?? cur.attributes?.speed ?? 0;
      let label, color;

      if (speed >= speedThreshold) {
        label = "Manejando";
        color = DRIVING_COLOR;
      } else {
        const s = cur.s ?? cur.state ?? "unknown";
        if (s === "home") {
          label = "En casa";
          color = HOME_COLOR;
        } else if (s === "unknown" || s === "unavailable") {
          label = "Desconocido";
          color = UNKNOWN_COLOR;
        } else {
          label = getZoneName(hass, s);
          color = null; // asignar después
        }
      }

      if (!acc[label]) acc[label] = { hours: 0, color };
      acc[label].hours += deltaH;
    }

    // Sumar el último estado hasta "ahora"
    if (stateList.length) {
      const last = stateList[stateList.length - 1];
      const lastDate = new Date(last.last_changed ?? last.lu * 1000);
      const deltaH = msToHours(Date.now() - lastDate);
      if (deltaH > 0) {
        const speed = last.a?.speed ?? last.attributes?.speed ?? 0;
        let label, color;
        if (speed >= speedThreshold) {
          label = "Manejando"; color = DRIVING_COLOR;
        } else {
          const s = last.s ?? last.state ?? "unknown";
          if (s === "home") { label = "En casa"; color = HOME_COLOR; }
          else if (s === "unknown" || s === "unavailable") { label = "Desconocido"; color = UNKNOWN_COLOR; }
          else { label = getZoneName(hass, s); color = null; }
        }
        if (!acc[label]) acc[label] = { hours: 0, color };
        acc[label].hours += deltaH;
      }
    }

    // Asignar colores a zonas sin color fijo
    let colorIdx = 0;
    const usedColors = new Set([HOME_COLOR, DRIVING_COLOR, UNKNOWN_COLOR]);
    const segments = [];
    for (const [label, data] of Object.entries(acc)) {
      if (data.hours < 0.001) continue; // filtrar 0 h
      let c = data.color;
      if (!c) {
        while (usedColors.has(SEGMENT_COLORS[colorIdx % SEGMENT_COLORS.length])) colorIdx++;
        c = SEGMENT_COLORS[colorIdx % SEGMENT_COLORS.length];
        usedColors.add(c);
        colorIdx++;
      }
      segments.push({ label, hours: data.hours, color: c });
    }

    // Ordenar por horas descendente
    segments.sort((a, b) => b.hours - a.hours);
    return segments;
  }

  // ── Renderizado ─────────────────────────────────────────────────────────────
  async _renderChart(segments) {
    const Chart = await loadChartJs();
    const canvas = this.shadowRoot.getElementById("pieCanvas");
    const totalH = segments.reduce((s, x) => s + x.hours, 0);

    this.shadowRoot.getElementById("centerTotal").textContent =
      totalH.toFixed(1);

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
                  const h = ctx.parsed;
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

  _hideLoading() {
    const sr = this.shadowRoot;
    sr.getElementById("loadingMsg").style.display = "none";
    sr.getElementById("errorMsg").style.display   = "none";
  }

  _showError(msg) {
    const sr = this.shadowRoot;
    sr.getElementById("loadingMsg").style.display = "none";
    const errEl = sr.getElementById("errorMsg");
    errEl.style.display = "";
    errEl.textContent   = msg;
  }

  // ── Editor visual básico (requerido por HA para HACS) ───────────────────────
  static getConfigElement() {
    return document.createElement("time-spent-pie-card-editor");
  }

  static getStubConfig() {
    return { entity: "person.usuario1", time_range: "daily", speed_threshold: 15 };
  }

  // ── Tamaño mínimo sugerido ──────────────────────────────────────────────────
  getCardSize() { return 4; }
}

// ─── Editor de configuración (simple) ────────────────────────────────────────
class TimeSpentPieCardEditor extends HTMLElement {
  setConfig(config) { this._config = config; }
  set hass(hass) { this._hass = hass; }

  connectedCallback() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        .form { display:flex; flex-direction:column; gap:12px; padding:8px; }
        label { font-size:.85rem; color:var(--primary-text-color); }
        input, select {
          width:100%; padding:6px 8px; border-radius:6px;
          border:1px solid var(--divider-color,#ccc);
          background:var(--card-background-color,#fff);
          color:var(--primary-text-color); font-size:.9rem;
          box-sizing:border-box;
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
            <option value="daily"  ${this._config?.time_range === "daily"  ? "selected":""}>Diario</option>
            <option value="weekly" ${this._config?.time_range === "weekly" ? "selected":""}>Semanal</option>
          </select>
        </label>
        <label>Umbral de velocidad (km/h)<br>
          <input id="speed_threshold" type="number" value="${this._config?.speed_threshold ?? 15}">
        </label>
      </div>`;

    for (const id of ["entity","name","time_range","speed_threshold"]) {
      this.shadowRoot.getElementById(id).addEventListener("change", () => this._fire());
    }
  }

  _fire() {
    const sr = this.shadowRoot;
    const config = {
      entity:          sr.getElementById("entity").value.trim(),
      time_range:      sr.getElementById("time_range").value,
      speed_threshold: Number(sr.getElementById("speed_threshold").value),
    };
    const name = sr.getElementById("name").value.trim();
    if (name) config.name = name;
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
  }
}

// ─── Registro de elementos ────────────────────────────────────────────────────
customElements.define("time-spent-pie-card", TimeSpentPieCard);
customElements.define("time-spent-pie-card-editor", TimeSpentPieCardEditor);

// ─── Registro en la ventana de HA (tarjeta custom) ───────────────────────────
window.customCards = window.customCards || [];
window.customCards.push({
  type:        "time-spent-pie-card",
  name:        "Time Spent Pie Card",
  description: "Gráfica de pastel con el tiempo acumulado por ubicación o manejo.",
  preview:     true,
  documentationURL: "https://github.com/miplatas/time-spent-pie-card",
});
